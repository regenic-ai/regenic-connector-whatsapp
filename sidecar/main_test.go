package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	waE2E "go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

func TestEncryptedDatabaseAndSelectedChatDurability(t *testing.T) {
	stateDir := filepath.Join(t.TempDir(), "private")
	if err := ensurePrivateDir(stateDir); err != nil {
		t.Fatal(err)
	}
	dbPath := filepath.Join(stateDir, "session.db")
	if err := ensurePrivateFile(dbPath); err != nil {
		t.Fatal(err)
	}
	key := strings.Repeat("a", 64)
	db, err := sql.Open("sqlite3", encryptedDSN(dbPath, key))
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		t.Fatalf("SQLCipher could not unlock its database: %v", err)
	}
	if err := secureDatabase(db); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`PRAGMA wal_autocheckpoint=0`); err != nil {
		t.Fatal(err)
	}
	var journalMode string
	if err := db.QueryRow(`PRAGMA journal_mode`).Scan(&journalMode); err != nil || strings.ToLower(journalMode) != "wal" {
		t.Fatalf("journal mode = %q, err=%v; want WAL", journalMode, err)
	}
	var tempStore int
	if err := db.QueryRow(`PRAGMA temp_store`).Scan(&tempStore); err != nil || tempStore != 2 {
		t.Fatalf("temp_store = %d, err=%v; want MEMORY", tempStore, err)
	}
	if err := createAppTables(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	srv := &server{db: db}
	if err := srv.selectChats(context.Background(), []string{"15550001@s.whatsapp.net"}); err != nil {
		t.Fatal(err)
	}
	message := func(id string, chat string, text string) *events.Message {
		return &events.Message{
			Info: types.MessageInfo{
				MessageSource: types.MessageSource{
					Chat:   mustJID(t, chat),
					Sender: mustJID(t, "15550001@s.whatsapp.net"),
				},
				ID:        types.MessageID(id),
				Timestamp: time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC),
			},
			RawMessage: &waE2E.Message{Conversation: stringPointer(text)},
		}
	}
	secretText := "distinctive secret message text"
	if err := srv.storeMessage(context.Background(), message("selected-1", "15550001@s.whatsapp.net", secretText), ""); err != nil {
		t.Fatal(err)
	}
	if err := srv.storeMessage(context.Background(), message("selected-1", "15550001@s.whatsapp.net", secretText), "history-sync"); err != nil {
		t.Fatal(err)
	}
	if err := srv.storeMessage(context.Background(), message("unselected-1", "15550002@s.whatsapp.net", "do not retain"), ""); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM wa_inbox`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("expected one deduplicated selected message, got %d", count)
	}
	var persisted string
	if err := db.QueryRow(`SELECT payload FROM wa_inbox`).Scan(&persisted); err != nil {
		t.Fatal(err)
	}
	var got storedMessage
	if err := json.Unmarshal([]byte(persisted), &got); err != nil {
		t.Fatal(err)
	}
	if got.Text != secretText || got.Cursor == 0 {
		t.Fatalf("message was not durably stored with its cursor: %#v", got)
	}
	firstPage, err := srv.pollMessages(context.Background(), "15550001@s.whatsapp.net", 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if firstPage["cursor"].(int64) != got.Cursor || len(firstPage["messages"].([]storedMessage)) != 1 {
		t.Fatalf("first inbox page = %#v", firstPage)
	}
	if err := srv.selectChats(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := srv.pollMessages(context.Background(), "15550001@s.whatsapp.net", 0, 100); err == nil {
		t.Fatal("poll unexpectedly returned messages from a deselected conversation")
	}
	if err := srv.selectChats(context.Background(), []string{"15550001@s.whatsapp.net"}); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{dbPath, dbPath + "-wal", dbPath + "-shm"} {
		fileBytes, readErr := os.ReadFile(path)
		if errors.Is(readErr, os.ErrNotExist) {
			continue
		}
		if readErr != nil {
			t.Fatal(readErr)
		}
		if strings.Contains(string(fileBytes), secretText) || strings.Contains(string(fileBytes), "do not retain") {
			t.Fatalf("SQLite sidecar %s contains plaintext message content", filepath.Base(path))
		}
		if path != dbPath {
			sidecarInfo, statErr := os.Stat(path)
			if statErr != nil {
				t.Fatal(statErr)
			}
			if sidecarInfo.Mode().Perm() != 0o600 {
				t.Fatalf("SQLite sidecar %s mode = %o, want 600", filepath.Base(path), sidecarInfo.Mode().Perm())
			}
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	dirInfo, err := os.Stat(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if dirInfo.Mode().Perm() != 0o700 {
		t.Fatalf("state directory mode = %o, want 700", dirInfo.Mode().Perm())
	}
	info, err := os.Stat(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("database file mode = %o, want 600", info.Mode().Perm())
	}
	bytes, err := os.ReadFile(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(bytes), secretText) || strings.Contains(string(bytes), "do not retain") {
		t.Fatal("SQLite database contains plaintext message content")
	}
	reopened, err := sql.Open("sqlite3", encryptedDSN(dbPath, key))
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if err := secureDatabase(reopened); err != nil {
		t.Fatal(err)
	}
	replayed, err := (&server{db: reopened}).pollMessages(context.Background(), "15550001@s.whatsapp.net", 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if replayed["cursor"].(int64) != got.Cursor || len(replayed["messages"].([]storedMessage)) != 1 {
		t.Fatalf("replayed inbox page = %#v", replayed)
	}
	emptyPage, err := (&server{db: reopened}).pollMessages(context.Background(), "15550001@s.whatsapp.net", got.Cursor, 100)
	if err != nil {
		t.Fatal(err)
	}
	if emptyPage["cursor"].(int64) != got.Cursor || len(emptyPage["messages"].([]storedMessage)) != 0 {
		t.Fatalf("cursor replay page = %#v", emptyPage)
	}
}

func TestEncryptedDatabaseRejectsWrongKey(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "encrypted.db")
	if err := ensurePrivateFile(dbPath); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite3", encryptedDSN(dbPath, strings.Repeat("b", 64)))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Ping(); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE protected(value TEXT); INSERT INTO protected VALUES('secret')`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	wrongKey, err := sql.Open("sqlite3", encryptedDSN(dbPath, strings.Repeat("c", 64)))
	if err != nil {
		t.Fatal(err)
	}
	defer wrongKey.Close()
	if err := wrongKey.Ping(); err == nil {
		t.Fatal("database unexpectedly opened with a different key")
	}
}

func TestKeyringFailureDoesNotFallBack(t *testing.T) {
	_, err := loadOrCreateKeyWith(failingKeyring{}, "test-install")
	if err == nil || !strings.Contains(err.Error(), "keychain unavailable") {
		t.Fatalf("expected explicit keychain failure, got %v", err)
	}
}

func TestSafeErrorRedactsUnrecognizedSecrets(t *testing.T) {
	err := errors.New("pairing qr secret-qr and authorization token-secret")
	got := safeError(err)
	if got != "sidecar request failed" {
		t.Fatalf("unexpected error message: %q", got)
	}
	if strings.Contains(got, "secret-qr") || strings.Contains(got, "token-secret") {
		t.Fatal("safe error exposed a pairing or authorization secret")
	}
}

func TestSendRequiresExplicitConversationSelection(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "selection.db")
	if err := ensurePrivateFile(dbPath); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite3", encryptedDSN(dbPath, strings.Repeat("d", 64)))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		t.Fatal(err)
	}
	if err := secureDatabase(db); err != nil {
		t.Fatal(err)
	}
	if err := createAppTables(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	srv := &server{db: db}
	_, err = srv.sendMessage(context.Background(), "stable-command", "15550001@s.whatsapp.net", "Hello", "", "")
	if err == nil || !strings.Contains(err.Error(), "explicitly selected") {
		t.Fatalf("expected selection rejection, got %v", err)
	}
	if _, err := srv.pollMessages(context.Background(), "15550001@s.whatsapp.net", 0, 100); err == nil {
		t.Fatal("poll unexpectedly succeeded for an unselected conversation")
	}
	if _, err := srv.resolveQuote(context.Background(), "15550001@s.whatsapp.net", "15550001@s.whatsapp.net:in:message"); err == nil {
		t.Fatal("quote resolution unexpectedly succeeded for an unselected conversation")
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM wa_outbox`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("unselected conversation created %d outbound reservations", count)
	}
}

func TestWindowsDatabaseFileURLPreservesDriveLetterAsPath(t *testing.T) {
	raw := encryptedDSNWithPlatform(`C:\Users\Local\AppData\Regenic\session.db`, strings.Repeat("e", 64), true)
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if u.Path != "/C:/Users/Local/AppData/Regenic/session.db" {
		t.Fatalf("Windows URI path = %q", u.Path)
	}
	if u.Host != "" {
		t.Fatalf("Windows database URL has unexpected host %q", u.Host)
	}
}

func TestExternalRevocationMarkerPersistsAndCanBeExplicitlyCleared(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "revocation.db")
	if err := ensurePrivateFile(dbPath); err != nil {
		t.Fatal(err)
	}
	key := strings.Repeat("f", 64)
	db, err := sql.Open("sqlite3", encryptedDSN(dbPath, key))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		t.Fatal(err)
	}
	if err := secureDatabase(db); err != nil {
		t.Fatal(err)
	}
	if err := createAppTables(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	srv := &server{db: db}
	if err := srv.setRevoked(true); err != nil {
		t.Fatal(err)
	}
	if !srv.isRevoked() {
		t.Fatal("external revocation was not reflected in memory")
	}
	var value int
	if err := db.QueryRow(`SELECT value FROM wa_meta WHERE key='externally_revoked'`).Scan(&value); err != nil {
		t.Fatal(err)
	}
	if value != 1 {
		t.Fatalf("external revocation marker = %d, want 1", value)
	}
	if err := srv.setRevoked(false); err != nil {
		t.Fatal(err)
	}
	if srv.isRevoked() {
		t.Fatal("explicitly cleared revocation remained in memory")
	}
}

func TestPendingOutboundMessagesBecomeUnknownOnRestart(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "outbox.db")
	if err := ensurePrivateFile(dbPath); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite3", encryptedDSN(dbPath, strings.Repeat("g", 64)))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		t.Fatal(err)
	}
	if err := secureDatabase(db); err != nil {
		t.Fatal(err)
	}
	if err := createAppTables(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	for _, state := range []string{"pending", "sending", "sent", "unknown"} {
		if _, err := db.Exec(`INSERT INTO wa_outbox(id, chat_id, state, created_at) VALUES(?, ?, ?, ?)`, state, "15550001@s.whatsapp.net", state, "2026-10-29T00:00:00Z"); err != nil {
			t.Fatal(err)
		}
	}
	if err := recoverPendingOutbox(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	rows, err := db.Query(`SELECT id, state FROM wa_outbox ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	want := map[string]string{
		"pending": "unknown",
		"sending": "unknown",
		"sent":    "sent",
		"unknown": "unknown",
	}
	for rows.Next() {
		var id, state string
		if err := rows.Scan(&id, &state); err != nil {
			t.Fatal(err)
		}
		if state != want[id] {
			t.Fatalf("outbox %q state = %q, want %q", id, state, want[id])
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
}

func TestPreviouslyRejectedOutboundMessageDoesNotBecomeAccepted(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "rejected-outbox.db")
	if err := ensurePrivateFile(dbPath); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite3", encryptedDSN(dbPath, strings.Repeat("h", 64)))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		t.Fatal(err)
	}
	if err := secureDatabase(db); err != nil {
		t.Fatal(err)
	}
	if err := createAppTables(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO wa_outbox(id, chat_id, state, created_at)
		VALUES('stable-command', '15550001@s.whatsapp.net', 'rejected', '2026-10-29T00:00:00Z')
	`); err != nil {
		t.Fatal(err)
	}
	_, err = (&server{db: db}).sendMessage(
		context.Background(),
		"stable-command",
		"15550001@s.whatsapp.net",
		"reply",
		"",
		"",
	)
	if err == nil || !strings.Contains(err.Error(), "rejected before sending") {
		t.Fatalf("expected a non-accepted rejected result, got %v", err)
	}
}

type failingKeyring struct{}

func (failingKeyring) Get(string, string) (string, error) {
	return "", errors.New("keychain unavailable")
}

func (failingKeyring) Set(string, string, string) error {
	return errors.New("keychain unavailable")
}

func mustJID(t *testing.T, value string) types.JID {
	t.Helper()
	jid, err := types.ParseJID(value)
	if err != nil {
		t.Fatal(err)
	}
	return jid
}

func stringPointer(value string) *string {
	return &value
}
