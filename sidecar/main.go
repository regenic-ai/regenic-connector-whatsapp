package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "github.com/mutecomm/go-sqlcipher/v4"
	"github.com/zalando/go-keyring"
	"go.mau.fi/whatsmeow"
	waE2E "go.mau.fi/whatsmeow/proto/waE2E"
	waHistorySync "go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
)

const protocolVersion = 1
const maxTextChars = 4000

type request struct {
	Protocol int             `json:"protocol"`
	ID       string          `json:"id"`
	Type     string          `json:"type"`
	Payload  json.RawMessage `json:"payload,omitempty"`
}

func (s *server) resolveQuote(ctx context.Context, chatID, externalID string) (map[string]string, error) {
	selected, err := s.chatSelected(ctx, chatID)
	if err != nil {
		return nil, errors.New("WhatsApp conversation selection could not be checked")
	}
	if !selected {
		return nil, errors.New("WhatsApp conversation must be explicitly selected to quote messages")
	}
	prefix := chatID + ":"
	if !strings.HasPrefix(externalID, prefix) {
		return nil, errors.New("quoted message is not from this WhatsApp conversation")
	}
	messageRef := strings.TrimPrefix(externalID, prefix)
	if strings.HasPrefix(messageRef, "out:") {
		commandID := strings.TrimPrefix(messageRef, "out:")
		var nativeID string
		if err := s.db.QueryRowContext(ctx, `
			SELECT channel_id FROM wa_outbox WHERE id=? AND chat_id=? AND channel_id<>''
		`, commandID, chatID).Scan(&nativeID); err != nil {
			return nil, errors.New("quoted WhatsApp message is not available locally")
		}
		if s.client.Store.ID == nil {
			return nil, errors.New("WhatsApp device identity is unavailable")
		}
		return map[string]string{"quote_id": nativeID, "quote_sender": s.client.Store.ID.String()}, nil
	}
	messageID := strings.TrimPrefix(messageRef, "in:")
	var payload string
	if err := s.db.QueryRowContext(ctx, `
		SELECT payload FROM wa_inbox WHERE chat_id=? AND message_id=?
	`, chatID, messageID).Scan(&payload); err != nil {
		return nil, errors.New("quoted WhatsApp message is not available locally")
	}
	var message storedMessage
	if err := json.Unmarshal([]byte(payload), &message); err != nil {
		return nil, errors.New("quoted WhatsApp message is invalid")
	}
	return map[string]string{"quote_id": message.MessageID, "quote_sender": message.SenderID}, nil
}

type response struct {
	Protocol int    `json:"protocol"`
	ID       string `json:"id"`
	OK       bool   `json:"ok"`
	Result   any    `json:"result,omitempty"`
	Error    string `json:"error,omitempty"`
}

type eventEnvelope struct {
	Protocol int    `json:"protocol"`
	Type     string `json:"type"`
	Payload  any    `json:"payload"`
}

type server struct {
	mu        sync.Mutex
	db        *sql.DB
	store     *sqlstore.Container
	client    *whatsmeow.Client
	out       *json.Encoder
	writeMu   sync.Mutex
	connected bool
	revoked   bool
	qr        string
	qrCancel  context.CancelFunc
	qrReady   chan struct{}
}

type storedMessage struct {
	Cursor       int64  `json:"cursor"`
	ChatID       string `json:"chat_id"`
	ChatTitle    string `json:"chat_title"`
	MessageID    string `json:"message_id"`
	CommandID    string `json:"command_id,omitempty"`
	SenderID     string `json:"sender_id"`
	SenderName   string `json:"sender_name,omitempty"`
	FromMe       bool   `json:"from_me"`
	Text         string `json:"text"`
	Timestamp    string `json:"timestamp"`
	QuoteID      string `json:"quote_id,omitempty"`
	QuoteSender  string `json:"quote_sender,omitempty"`
	HistoryBatch string `json:"history_batch,omitempty"`
}

func main() {
	stateDir := flag.String("state-dir", "", "private local state directory")
	installationID := flag.String("installation-id", "", "connector installation identifier")
	flag.Parse()
	if *stateDir == "" || *installationID == "" {
		_, _ = fmt.Fprintln(os.Stderr, "sidecar requires a state directory and installation identifier")
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	srv, err := openServer(ctx, *stateDir, *installationID, os.Stdout)
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, safeError(err))
		os.Exit(1)
	}
	defer srv.close()
	if err := srv.serve(ctx, os.Stdin); err != nil && !errors.Is(err, io.EOF) {
		_, _ = fmt.Fprintln(os.Stderr, safeError(err))
		os.Exit(1)
	}
}

func openServer(ctx context.Context, stateDir, installationID string, output io.Writer) (*server, error) {
	if err := ensurePrivateDir(stateDir); err != nil {
		return nil, fmt.Errorf("private state directory unavailable")
	}
	dbPath := filepath.Join(stateDir, "whatsapp-linked-device.db")
	if err := ensurePrivateFile(dbPath); err != nil {
		return nil, fmt.Errorf("encrypted session database unavailable")
	}
	key, err := loadOrCreateKey(installationID)
	if err != nil {
		return nil, fmt.Errorf("system keychain unavailable; WhatsApp session was not opened")
	}
	db, err := sql.Open("sqlite3", encryptedDSN(dbPath, key))
	if err != nil {
		return nil, fmt.Errorf("encrypted session database could not be opened")
	}
	db.SetMaxOpenConns(1)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("encrypted session database could not be unlocked")
	}
	if err := secureDatabase(db); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("encrypted session database security settings failed")
	}
	container := sqlstore.NewWithDB(db, "sqlite3", waLog.Noop)
	if err := container.Upgrade(ctx); err != nil {
		_ = container.Close()
		return nil, fmt.Errorf("WhatsApp encrypted session schema upgrade failed")
	}
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		_ = container.Close()
		return nil, fmt.Errorf("WhatsApp device session could not be loaded")
	}
	if err := createAppTables(ctx, db); err != nil {
		_ = container.Close()
		return nil, fmt.Errorf("local message queue schema could not be opened")
	}
	if err := recoverPendingOutbox(ctx, db); err != nil {
		_ = container.Close()
		return nil, fmt.Errorf("pending send state could not be recovered")
	}
	srv := &server{
		db:    db,
		store: container,
		out:   json.NewEncoder(output),
	}
	var revoked int
	if err := db.QueryRowContext(ctx, `SELECT value FROM wa_meta WHERE key='externally_revoked'`).Scan(&revoked); err != nil && !errors.Is(err, sql.ErrNoRows) {
		_ = container.Close()
		return nil, errors.New("WhatsApp external revocation state unavailable")
	}
	srv.revoked = revoked != 0
	srv.client = whatsmeow.NewClient(device, waLog.Noop)
	srv.client.AddEventHandler(srv.handleWhatsAppEvent)
	return srv, nil
}

func recoverPendingOutbox(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, `UPDATE wa_outbox SET state='unknown' WHERE state IN ('pending','sending')`)
	return err
}

func (s *server) serve(ctx context.Context, input io.Reader) error {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 2*1024*1024)
	for scanner.Scan() {
		var req request
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			return errors.New("invalid IPC request")
		}
		if req.Protocol != protocolVersion || req.ID == "" {
			return s.respond(req.ID, false, nil, "unsupported IPC protocol")
		}
		if req.Type == "shutdown" {
			if err := s.respond(req.ID, true, map[string]string{"state": "stopped"}, ""); err != nil {
				return err
			}
			return nil
		}
		result, err := s.dispatch(ctx, req.Type, req.Payload)
		if err != nil {
			if writeErr := s.respond(req.ID, false, nil, safeError(err)); writeErr != nil {
				return writeErr
			}
			continue
		}
		if err := s.respond(req.ID, true, result, ""); err != nil {
			return err
		}
		if req.Type == "pair.relink" {
			return io.EOF
		}
	}
	return scanner.Err()
}

func (s *server) dispatch(ctx context.Context, command string, payload json.RawMessage) (any, error) {
	switch command {
	case "status":
		return s.status(ctx)
	case "connect":
		return s.connect(ctx)
	case "pair.phone":
		var input struct {
			Phone string `json:"phone"`
		}
		if err := json.Unmarshal(payload, &input); err != nil || strings.TrimSpace(input.Phone) == "" {
			return nil, errors.New("phone number is required")
		}
		return s.pairPhone(ctx, input.Phone)
	case "chats.list":
		return s.listChats(ctx)
	case "chats.select":
		var input struct {
			ChatIDs []string `json:"chat_ids"`
		}
		if err := json.Unmarshal(payload, &input); err != nil || len(input.ChatIDs) > 500 {
			return nil, errors.New("invalid conversation selection")
		}
		return map[string]any{"selected": len(input.ChatIDs)}, s.selectChats(ctx, input.ChatIDs)
	case "chats.add":
		var input struct {
			ChatID string `json:"chat_id"`
		}
		if err := json.Unmarshal(payload, &input); err != nil || !validChatID(input.ChatID) {
			return nil, errors.New("invalid WhatsApp chat selection")
		}
		if _, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO wa_selected_chats(chat_id) VALUES(?)`, input.ChatID); err != nil {
			return nil, errors.New("WhatsApp chat selection could not be persisted")
		}
		return map[string]string{"chat_id": input.ChatID}, nil
	case "messages.poll":
		var input struct {
			ChatID string `json:"chat_id"`
			Cursor int64  `json:"cursor"`
			Limit  int    `json:"limit"`
		}
		if err := json.Unmarshal(payload, &input); err != nil || !validChatID(input.ChatID) {
			return nil, errors.New("valid chat id is required")
		}
		if input.Limit <= 0 || input.Limit > 500 {
			input.Limit = 100
		}
		return s.pollMessages(ctx, input.ChatID, input.Cursor, input.Limit)
	case "messages.quote":
		var input struct {
			ChatID     string `json:"chat_id"`
			ExternalID string `json:"external_id"`
		}
		if err := json.Unmarshal(payload, &input); err != nil || !validChatID(input.ChatID) {
			return nil, errors.New("invalid quote target")
		}
		return s.resolveQuote(ctx, input.ChatID, input.ExternalID)
	case "messages.send":
		var input struct {
			ID        string `json:"id"`
			ChatID    string `json:"chat_id"`
			Text      string `json:"text"`
			QuoteID   string `json:"quote_id,omitempty"`
			QuoteUser string `json:"quote_sender,omitempty"`
		}
		if err := json.Unmarshal(payload, &input); err != nil {
			return nil, errors.New("invalid send request")
		}
		return s.sendMessage(ctx, input.ID, input.ChatID, input.Text, input.QuoteID, input.QuoteUser)
	case "disconnect":
		s.client.Disconnect()
		s.cancelPairing()
		s.setConnected(false)
		return map[string]string{"state": "disconnected"}, nil
	case "logout":
		if err := s.client.Logout(ctx); err != nil {
			return nil, errors.New("WhatsApp device logout failed")
		}
		s.cancelPairing()
		if err := s.client.Store.Delete(ctx); err != nil {
			return nil, errors.New("local WhatsApp device session could not be removed")
		}
		s.setConnected(false)
		return map[string]string{"state": "logged_out"}, nil
	case "pair.relink":
		if !s.isRevoked() {
			return nil, errors.New("explicit relink is only available after WhatsApp revoked this device")
		}
		s.client.Disconnect()
		if err := s.client.Store.Delete(ctx); err != nil {
			return nil, errors.New("revoked local WhatsApp device session could not be removed")
		}
		if err := s.setRevoked(false); err != nil {
			return nil, errors.New("revoked WhatsApp session marker could not be cleared")
		}
		return map[string]string{"state": "relinking"}, nil
	default:
		return nil, errors.New("unsupported IPC command")
	}
}

func (s *server) status(ctx context.Context) (map[string]any, error) {
	devices, err := s.store.GetAllDevices(ctx)
	if err != nil {
		return nil, errors.New("device state unavailable")
	}
	state := "unlinked"
	if s.isRevoked() {
		state = "externally_revoked"
	} else if len(devices) > 0 && devices[0].ID != nil {
		state = "disconnected"
		if s.client.IsConnected() {
			state = "connected"
		}
	}
	s.mu.Lock()
	qr := s.qr
	s.mu.Unlock()
	return map[string]any{"state": state, "qr": qr}, nil
}

func (s *server) connect(ctx context.Context) (map[string]string, error) {
	if s.isRevoked() {
		return nil, errors.New("WhatsApp device was revoked externally; explicit re-link is required")
	}
	s.mu.Lock()
	if s.client.IsConnected() {
		s.mu.Unlock()
		return map[string]string{"state": "connected"}, nil
	}
	s.mu.Unlock()
	if s.client.Store.ID == nil {
		qrCtx, cancel := context.WithCancel(ctx)
		qrChannel, err := s.client.GetQRChannel(qrCtx)
		if err != nil {
			cancel()
			return nil, errors.New("WhatsApp QR pairing could not be started")
		}
		s.mu.Lock()
		if s.qrCancel != nil {
			s.qrCancel()
		}
		s.qrCancel = cancel
		s.qr = ""
		s.qrReady = make(chan struct{})
		s.mu.Unlock()
		go s.forwardQR(qrCtx, qrChannel, s.qrReady)
	}
	if err := s.client.ConnectContext(ctx); err != nil {
		s.mu.Lock()
		if s.qrCancel != nil {
			s.qrCancel()
			s.qrCancel = nil
		}
		s.qr = ""
		s.qrReady = nil
		s.mu.Unlock()
		return nil, errors.New("WhatsApp connection could not be started")
	}
	return map[string]string{"state": "connecting"}, nil
}

func (s *server) forwardQR(ctx context.Context, qrChannel <-chan whatsmeow.QRChannelItem, ready chan struct{}) {
	readyOnce := sync.Once{}
	for {
		select {
		case <-ctx.Done():
			return
		case item, ok := <-qrChannel:
			if !ok {
				return
			}
			switch item.Event {
			case whatsmeow.QRChannelEventCode:
				readyOnce.Do(func() { close(ready) })
				s.mu.Lock()
				s.qr = item.Code
				s.mu.Unlock()
				s.emit("pairing.qr", map[string]any{"code": item.Code, "timeout_seconds": item.Timeout})
			case "success":
				s.mu.Lock()
				s.qr = ""
				s.qrReady = nil
				s.mu.Unlock()
				s.emit("pairing.success", map[string]string{"state": "linked"})
			case "timeout":
				s.mu.Lock()
				s.qr = ""
				s.qrReady = nil
				s.mu.Unlock()
				s.emit("pairing.timeout", map[string]string{"state": "timed_out"})
				return
			case "error":
				s.mu.Lock()
				s.qr = ""
				s.qrReady = nil
				s.mu.Unlock()
				s.emit("pairing.error", map[string]string{"message": "WhatsApp pairing failed"})
				return
			}
		}
	}
}

func (s *server) pairPhone(ctx context.Context, phone string) (map[string]string, error) {
	if s.client.Store.ID != nil {
		return nil, errors.New("device is already linked; disconnect before pairing another device")
	}
	s.mu.Lock()
	ready := s.qrReady
	s.mu.Unlock()
	if ready == nil {
		if _, err := s.connect(ctx); err != nil {
			return nil, err
		}
		s.mu.Lock()
		ready = s.qrReady
		s.mu.Unlock()
	}
	if ready == nil {
		return nil, errors.New("WhatsApp pairing connection unavailable")
	}
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-deadline.C:
		return nil, errors.New("WhatsApp pairing connection timed out")
	case <-ready:
	}
	code, err := s.client.PairPhone(ctx, phone, true, whatsmeow.PairClientElectron, "Regenic (Desktop)")
	if err != nil {
		return nil, errors.New("WhatsApp phone pairing code could not be created")
	}
	s.emit("pairing.phone_code", map[string]string{"code": code})
	return map[string]string{"code": code, "state": "awaiting_phone_confirmation"}, nil
}

func (s *server) handleWhatsAppEvent(raw any) {
	switch evt := raw.(type) {
	case *events.Connected:
		s.setConnected(true)
		s.emit("status", map[string]string{"state": "connected"})
	case *events.Disconnected:
		s.setConnected(false)
		s.emit("status", map[string]string{"state": "disconnected"})
	case *events.LoggedOut:
		if err := s.setRevoked(true); err != nil {
			s.emit("error", map[string]string{"message": "external revocation state could not be persisted"})
		}
		s.setConnected(false)
		s.emit("status", map[string]string{"state": "externally_revoked"})
	case *events.StreamReplaced:
		if err := s.setRevoked(true); err != nil {
			s.emit("error", map[string]string{"message": "external revocation state could not be persisted"})
		}
		s.setConnected(false)
		s.emit("status", map[string]string{"state": "externally_revoked"})
	case *events.Message:
		if err := s.storeMessage(context.Background(), evt, ""); err != nil {
			s.emit("error", map[string]string{"message": "inbound message could not be durably stored"})
		}
	case *events.HistorySync:
		s.storeHistorySync(evt.Data)
	}
}

func (s *server) storeHistorySync(batch *waHistorySync.HistorySync) {
	if batch == nil {
		return
	}
	for _, conversation := range batch.GetConversations() {
		chatID := conversation.GetID()
		if !validChatID(chatID) {
			continue
		}
		chatJID, err := types.ParseJID(chatID)
		if err != nil {
			continue
		}
		title := conversation.GetName()
		if title == "" {
			title = chatID
		}
		if _, err := s.db.ExecContext(context.Background(), `
			INSERT INTO wa_chats(chat_id, title, last_seen_at) VALUES(?, ?, ?)
			ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title
		`, chatID, title, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			s.emit("error", map[string]string{"message": "conversation directory could not be durably stored"})
			return
		}
		selected, err := s.chatSelected(context.Background(), chatID)
		if err != nil {
			s.emit("error", map[string]string{"message": "conversation selection could not be read"})
			return
		}
		if !selected {
			continue
		}
		for _, historyMessage := range conversation.GetMessages() {
			webMessage := historyMessage.GetMessage()
			if webMessage == nil {
				continue
			}
			parsed, err := s.client.ParseWebMessage(chatJID, webMessage)
			if err != nil || parsed == nil {
				continue
			}
			if err := s.storeMessage(context.Background(), parsed, "history-sync"); err != nil {
				s.emit("error", map[string]string{"message": "history batch could not be durably stored"})
				return
			}
		}
	}
	s.emit("history.batch", map[string]string{"state": "stored"})
}

func (s *server) storeMessage(ctx context.Context, evt *events.Message, batch string) error {
	if s.isRevoked() {
		return nil
	}
	info := evt.Info
	evt.UnwrapRaw()
	text := messageText(evt.Message)
	if text == "" || len([]rune(text)) > maxTextChars || info.ID == "" || info.Chat.IsEmpty() {
		return nil
	}
	chatID := info.Chat.String()
	senderID := info.Sender.String()
	if info.IsFromMe {
		senderID = "local-owner"
	}
	quoteID, quoteSender := messageQuote(evt.Message)
	title := chatID
	if info.Chat.Server != types.GroupServer && info.PushName != "" {
		title = info.PushName
	}
	msg := storedMessage{
		ChatID:       chatID,
		ChatTitle:    title,
		MessageID:    string(info.ID),
		SenderID:     senderID,
		SenderName:   info.PushName,
		FromMe:       info.IsFromMe,
		Text:         text,
		Timestamp:    info.Timestamp.UTC().Format(time.RFC3339Nano),
		QuoteID:      quoteID,
		QuoteSender:  quoteSender,
		HistoryBatch: batch,
	}
	if info.IsFromMe {
		_ = s.db.QueryRowContext(ctx, `SELECT id FROM wa_outbox WHERE channel_id=?`, string(info.ID)).Scan(&msg.CommandID)
	}
	encoded, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `
		INSERT INTO wa_chats(chat_id, title, last_seen_at)
		VALUES(?, ?, ?)
		ON CONFLICT(chat_id) DO UPDATE SET last_seen_at=excluded.last_seen_at
	`, chatID, title, msg.Timestamp)
	if err != nil {
		return err
	}
	var selected int
	if err := tx.QueryRowContext(ctx, `SELECT 1 FROM wa_selected_chats WHERE chat_id=?`, chatID).Scan(&selected); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return tx.Commit()
		}
		return err
	}
	result, err := tx.ExecContext(ctx, `
		INSERT OR IGNORE INTO wa_inbox(chat_id, message_id, payload, received_at)
		VALUES(?, ?, ?, ?)
	`, chatID, msg.MessageID, string(encoded), msg.Timestamp)
	if err != nil {
		return err
	}
	if rows, _ := result.RowsAffected(); rows == 1 {
		msg.Cursor, err = result.LastInsertId()
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE wa_inbox SET payload=? WHERE cursor=?`, mustJSON(msg), msg.Cursor)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *server) listChats(ctx context.Context) ([]map[string]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT chat_id, title FROM wa_chats ORDER BY last_seen_at DESC, chat_id`)
	if err != nil {
		return nil, errors.New("WhatsApp conversation directory unavailable")
	}
	defer rows.Close()
	chats := make([]map[string]string, 0)
	for rows.Next() {
		var id, title string
		if err := rows.Scan(&id, &title); err != nil {
			return nil, errors.New("WhatsApp conversation directory unavailable")
		}
		chats = append(chats, map[string]string{"chat_id": id, "title": title})
	}
	return chats, rows.Err()
}

func (s *server) selectChats(ctx context.Context, chatIDs []string) error {
	selected := make(map[string]struct{}, len(chatIDs))
	for _, chatID := range chatIDs {
		if !validChatID(chatID) {
			return errors.New("invalid WhatsApp chat selection")
		}
		selected[chatID] = struct{}{}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM wa_selected_chats`); err != nil {
		return err
	}
	for chatID := range selected {
		if _, err := tx.ExecContext(ctx, `INSERT INTO wa_selected_chats(chat_id) VALUES(?)`, chatID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *server) chatSelected(ctx context.Context, chatID string) (bool, error) {
	var selected int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM wa_selected_chats WHERE chat_id=?`, chatID).Scan(&selected)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (s *server) pollMessages(ctx context.Context, chatID string, cursor int64, limit int) (map[string]any, error) {
	if !validChatID(chatID) || cursor < 0 {
		return nil, errors.New("invalid WhatsApp inbox cursor")
	}
	selected, err := s.chatSelected(ctx, chatID)
	if err != nil {
		return nil, errors.New("WhatsApp conversation selection could not be checked")
	}
	if !selected {
		return nil, errors.New("WhatsApp conversation is not selected for sync")
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT cursor, payload FROM wa_inbox WHERE chat_id=? AND cursor>? ORDER BY cursor LIMIT ?
	`, chatID, cursor, limit)
	if err != nil {
		return nil, errors.New("WhatsApp inbox could not be read")
	}
	defer rows.Close()
	messages := make([]storedMessage, 0)
	next := cursor
	for rows.Next() {
		var msg storedMessage
		var payload string
		if err := rows.Scan(&msg.Cursor, &payload); err != nil {
			return nil, errors.New("WhatsApp inbox could not be read")
		}
		if err := json.Unmarshal([]byte(payload), &msg); err != nil {
			return nil, errors.New("WhatsApp inbox record is invalid")
		}
		next = msg.Cursor
		messages = append(messages, msg)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("WhatsApp inbox could not be read")
	}
	return map[string]any{"messages": messages, "cursor": next}, nil
}

func (s *server) sendMessage(ctx context.Context, id, chatID, text, quoteID, quoteSender string) (map[string]any, error) {
	if id == "" || !validChatID(chatID) || strings.TrimSpace(text) == "" || len([]rune(text)) > maxTextChars {
		return nil, errors.New("invalid text send request")
	}
	var priorState, priorServerID string
	err := s.db.QueryRowContext(ctx, `SELECT state, server_id FROM wa_outbox WHERE id=?`, id).Scan(&priorState, &priorServerID)
	if err == nil {
		if priorState == "rejected" {
			return nil, errors.New("WhatsApp message was rejected before sending")
		}
		return map[string]any{"id": id, "state": priorState, "server_id": priorServerID}, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, errors.New("outbound queue unavailable")
	}
	selected, err := s.chatSelected(ctx, chatID)
	if err != nil {
		return nil, errors.New("WhatsApp chat selection could not be checked")
	}
	if !selected {
		return nil, errors.New("WhatsApp conversation must be explicitly selected before sending")
	}
	if s.isRevoked() {
		return nil, errors.New("WhatsApp device was revoked externally; explicit re-link is required")
	}
	if !s.client.IsConnected() {
		return nil, errors.New("WhatsApp device is not connected")
	}
	target, err := types.ParseJID(chatID)
	if err != nil {
		return nil, errors.New("invalid WhatsApp chat id")
	}
	channelMessageID := string(s.client.GenerateMessageID())
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO wa_outbox(id, chat_id, channel_id, state, created_at)
		VALUES(?, ?, ?, 'pending', ?)
	`, id, chatID, channelMessageID, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		return nil, errors.New("outbound message could not be reserved")
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE wa_outbox SET state='sending' WHERE id=?`, id); err != nil {
		return nil, errors.New("outbound message state could not be persisted")
	}
	message := &waE2E.Message{Conversation: proto.String(text)}
	if quoteID != "" {
		contextInfo := &waE2E.ContextInfo{StanzaID: proto.String(quoteID)}
		if quoteSender != "" {
			jid, parseErr := types.ParseJID(quoteSender)
			if parseErr != nil {
				_, _ = s.db.ExecContext(ctx, `UPDATE wa_outbox SET state='rejected' WHERE id=?`, id)
				return nil, errors.New("invalid WhatsApp quote sender")
			}
			contextInfo.Participant = proto.String(jid.String())
		}
		message.ExtendedTextMessage = &waE2E.ExtendedTextMessage{
			Text:        proto.String(text),
			ContextInfo: contextInfo,
		}
		message.Conversation = nil
	}
	result, err := s.client.SendMessage(ctx, target, message, whatsmeow.SendRequestExtra{ID: types.MessageID(channelMessageID)})
	if err != nil {
		_, _ = s.db.ExecContext(ctx, `UPDATE wa_outbox SET state='unknown' WHERE id=?`, id)
		return map[string]any{"id": id, "state": "unknown"}, nil
	}
	_, err = s.db.ExecContext(ctx, `UPDATE wa_outbox SET state='sent', server_id=? WHERE id=?`, string(result.ID), id)
	if err != nil {
		return map[string]any{"id": id, "state": "unknown"}, nil
	}
	return map[string]any{"id": id, "state": "sent", "server_id": string(result.ID)}, nil
}

func (s *server) close() {
	s.cancelPairing()
	if s.client != nil {
		s.client.Disconnect()
	}
	if s.store != nil {
		_ = s.store.Close()
	}
}

func (s *server) cancelPairing() {
	s.mu.Lock()
	if s.qrCancel != nil {
		s.qrCancel()
		s.qrCancel = nil
	}
	s.qr = ""
	s.qrReady = nil
	s.mu.Unlock()
}

func (s *server) respond(id string, ok bool, result any, err string) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.out.Encode(response{
		Protocol: protocolVersion,
		ID:       id,
		OK:       ok,
		Result:   result,
		Error:    err,
	})
}

func (s *server) emit(eventType string, payload any) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_ = s.out.Encode(eventEnvelope{Protocol: protocolVersion, Type: eventType, Payload: payload})
}

func (s *server) setConnected(connected bool) {
	s.mu.Lock()
	s.connected = connected
	s.mu.Unlock()
}

func (s *server) isRevoked() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.revoked
}

func (s *server) setRevoked(revoked bool) error {
	value := 0
	if revoked {
		value = 1
		s.mu.Lock()
		s.revoked = true
		s.mu.Unlock()
	}
	if _, err := s.db.Exec(`INSERT INTO wa_meta(key, value) VALUES('externally_revoked', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, value); err != nil {
		return err
	}
	if !revoked {
		s.mu.Lock()
		s.revoked = false
		s.mu.Unlock()
	}
	return nil
}

func createAppTables(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS wa_chats (
			chat_id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			last_seen_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS wa_inbox (
			cursor INTEGER PRIMARY KEY AUTOINCREMENT,
			chat_id TEXT NOT NULL,
			message_id TEXT NOT NULL,
			payload TEXT NOT NULL,
			received_at TEXT NOT NULL,
			UNIQUE(chat_id, message_id)
		);
		CREATE INDEX IF NOT EXISTS wa_inbox_chat_cursor ON wa_inbox(chat_id, cursor);
		CREATE TABLE IF NOT EXISTS wa_outbox (
			id TEXT PRIMARY KEY,
			chat_id TEXT NOT NULL,
			channel_id TEXT NOT NULL DEFAULT '',
			state TEXT NOT NULL,
			server_id TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS wa_selected_chats (
			chat_id TEXT PRIMARY KEY
		);
		CREATE TABLE IF NOT EXISTS wa_meta (
			key TEXT PRIMARY KEY,
			value INTEGER NOT NULL
		);
	`)
	return err
}

func secureDatabase(db *sql.DB) error {
	var version string
	if err := db.QueryRow(`PRAGMA cipher_version`).Scan(&version); err != nil || version == "" {
		return errors.New("SQLCipher is unavailable")
	}
	for _, pragma := range []string{
		`PRAGMA journal_mode=WAL`,
		`PRAGMA secure_delete=ON`,
		`PRAGMA temp_store=MEMORY`,
		`PRAGMA foreign_keys=ON`,
	} {
		if _, err := db.Exec(pragma); err != nil {
			return err
		}
	}
	return nil
}

func encryptedDSN(dbPath, keyHex string) string {
	return encryptedDSNWithPlatform(dbPath, keyHex, runtime.GOOS == "windows")
}

func encryptedDSNWithPlatform(dbPath, keyHex string, windows bool) string {
	u := url.URL{Scheme: "file", Path: databaseFileURLPath(dbPath, windows)}
	query := u.Query()
	query.Set("_pragma_key", "x'"+keyHex+"'")
	query.Set("_pragma_cipher_page_size", "4096")
	query.Set("_foreign_keys", "on")
	u.RawQuery = query.Encode()
	return u.String()
}

func databaseFileURLPath(dbPath string, windows bool) string {
	if windows {
		dbPath = strings.ReplaceAll(dbPath, `\`, `/`)
	}
	path := filepath.ToSlash(dbPath)
	if windows && len(path) >= 3 && path[1] == ':' && path[2] == '/' {
		path = "/" + path
	}
	return path
}

func loadOrCreateKey(installationID string) (string, error) {
	return loadOrCreateKeyWith(keyringBackend{}, installationID)
}

type keyringStore interface {
	Get(string, string) (string, error)
	Set(string, string, string) error
}

type keyringBackend struct{}

func (keyringBackend) Get(service, account string) (string, error) {
	return keyring.Get(service, account)
}

func (keyringBackend) Set(service, account, value string) error {
	return keyring.Set(service, account, value)
}

func loadOrCreateKeyWith(backend keyringStore, installationID string) (string, error) {
	account := "whatsapp-linked-device:" + installationID
	key, err := backend.Get("RegenIC WhatsApp Linked Device", account)
	if err == nil {
		if len(key) != 64 {
			return "", errors.New("stored SQLCipher key has invalid length")
		}
		if _, err := hex.DecodeString(key); err != nil {
			return "", errors.New("stored SQLCipher key is invalid")
		}
		return key, nil
	}
	if !errors.Is(err, keyring.ErrNotFound) {
		return "", err
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	key = hex.EncodeToString(raw)
	for i := range raw {
		raw[i] = 0
	}
	if err := backend.Set("RegenIC WhatsApp Linked Device", account, key); err != nil {
		return "", err
	}
	return key, nil
}

func ensurePrivateDir(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("state path is not a real directory")
	}
	return os.Chmod(path, 0o700)
}

func ensurePrivateFile(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		file, createErr := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
		if createErr != nil {
			return createErr
		}
		return file.Close()
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("database path is not a regular file")
	}
	return os.Chmod(path, 0o600)
}

func validChatID(chatID string) bool {
	if len(chatID) > 255 || strings.TrimSpace(chatID) != chatID {
		return false
	}
	jid, err := types.ParseJID(chatID)
	if err != nil {
		return false
	}
	return jid.Server == types.DefaultUserServer || jid.Server == types.GroupServer || jid.Server == types.HiddenUserServer
}

func messageText(message *waE2E.Message) string {
	if message == nil {
		return ""
	}
	text := message.GetConversation()
	if text == "" {
		text = message.GetExtendedTextMessage().GetText()
	}
	return strings.TrimSpace(text)
}

func messageQuote(message *waE2E.Message) (string, string) {
	if message == nil {
		return "", ""
	}
	contextInfo := message.GetExtendedTextMessage().GetContextInfo()
	if contextInfo == nil || contextInfo.GetStanzaID() == "" {
		return "", ""
	}
	return contextInfo.GetStanzaID(), contextInfo.GetParticipant()
}

func mustJSON(value any) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func safeError(err error) string {
	if err == nil {
		return "sidecar request failed"
	}
	switch err.Error() {
	case "system keychain unavailable; WhatsApp session was not opened":
		return "system keychain unavailable; WhatsApp session was not opened"
	case "private state directory unavailable":
		return "private local state directory unavailable"
	case "encrypted session database unavailable":
		return "encrypted session database unavailable"
	case "encrypted session database could not be unlocked":
		return "encrypted session database could not be unlocked"
	case "WhatsApp conversation must be explicitly selected before sending":
		return "WhatsApp conversation must be explicitly selected before sending"
	case "WhatsApp conversation is not selected for sync":
		return "WhatsApp conversation is not selected for sync"
	case "WhatsApp conversation must be explicitly selected to quote messages":
		return "WhatsApp conversation must be explicitly selected to quote messages"
	case "quoted message is not from this WhatsApp conversation":
		return "quoted message is not from this WhatsApp conversation"
	case "quoted WhatsApp message is not available locally":
		return "quoted WhatsApp message is not available locally"
	case "WhatsApp device is not connected":
		return "WhatsApp device is not connected"
	case "WhatsApp device was revoked externally; explicit re-link is required":
		return "WhatsApp device was revoked externally; explicit re-link is required"
	case "phone number is required":
		return "phone number is required"
	case "WhatsApp message was rejected before sending":
		return "WhatsApp message was rejected before sending"
	default:
		return "sidecar request failed"
	}
}
