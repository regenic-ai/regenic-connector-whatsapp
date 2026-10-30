# WhatsApp Linked Device (Local, Explicit Opt-In)

- **Default recommendation:** `whatsapp-web-live` browser extension
- **Optional driver:** `whatsapp-linked-device`
- **Status:** local MVP; no real-account testing
- **Related:** [WhatsApp Web Live](WHATSAPP_WEB_LIVE_CONNECTOR.md) · [Personal export/import](WHATSAPP_PERSONAL.md)

## Risk and consent

The browser extension remains the default live path and user-selected exports remain read-only.
Neither path is risk-free or a guarantee against account restrictions. The linked-device driver
is a separate, unofficial client using WhatsApp's reverse-engineered linked-device protocol.
That protocol use may violate WhatsApp's terms and can lead to account restrictions or bans;
Regenic cannot guarantee account safety.

The linked-device install card defaults to **Off**. It does not start, pair, enumerate chats, or
collect messages from catalog/probe/metadata calls. Enabling it requires both selecting the
linked-device option and acknowledging the protocol/account risk; Engine also displays an
installation confirmation. No account is linked until the user completes pairing in the local
Engine pairing view. QR and phone pairing codes are treated as credentials and are not written
to logs, connector messages, or telemetry.

## Local service and platform build

The Node driver owns one Go sidecar process per opted-in installation. It communicates only
over versioned stdin/stdout IPC; the sidecar does not open a listening port and does not
download binaries at runtime. Disable, delete, reconfigure, clear, shutdown, or process exit
stops the local process. A stop does **not** log out the WhatsApp device or erase its session.

Build the sidecar for the current machine:

```sh
pnpm --filter @regenic/whatsapp-personal build:sidecar
```

The build requires the Go toolchain declared in `sidecar/go.mod` and CGO. Supported package
names are `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`, and
`win32-x64`. Cross-compiling SQLCipher requires a C compiler configured for the target through
`CC`; a compiler for another target is not sufficient. A missing or non-executable sidecar
causes a clear install/runtime error rather than an implicit download. The current checked
environment is macOS arm64; other platforms are build targets, not verified runtime claims.
The package `prepack` lifecycle builds the native binary before creating a package. For a
cross-target package, set `REGENIC_WHATSAPP_SIDECAR_PLATFORM` and
`REGENIC_WHATSAPP_SIDECAR_ARCH` (for example `linux` and `x64`) plus a matching `CC`.

The encrypted database lives under the user's local Regenic application data directory (or
`REGENIC_WHATSAPP_DATA_DIR`). SQLCipher encrypts the session and selected-message database,
including its WAL; the SQLCipher key is held only in the operating system keychain. The state
directory and database are restricted to the current user. If the keychain is unavailable or
the database cannot be unlocked, startup fails explicitly: there is no environment-variable or
plaintext fallback.

## Pairing, disconnect, and revoke

Pair with the local Engine's QR view, or select phone-code pairing and enter the phone number
in the install card. The user must confirm the new linked device in WhatsApp. The connector
does not scan a code on the user's behalf.

These are different operations:

| Action | Effect |
| --- | --- |
| Disable/stop the installation | Stops local collection and the sidecar; keeps the remote linked device and encrypted local state |
| `disconnectWhatsAppLinkedDevice(installationId)` | Disconnects while retaining the local device session for a later connection |
| `logoutWhatsAppLinkedDevice(installationId)` | Requests remote unlink, removes the local WhatsApp device session, and stops the sidecar; it does not delete the encrypted message cache or its database key |
| Phone/WhatsApp revokes or replaces the device | Reports an externally revoked/replaced state and does not silently re-authenticate |
| `relinkRevokedWhatsAppDevice(installationId)` | Explicitly clears the revoked local session and starts a fresh pairing flow; it does not claim that pairing succeeded |

The three package helpers are exported for a local host integration and require the opted-in
sidecar to be running. They are not remote APIs. If WhatsApp has already revoked the device,
relinking requires that explicit helper and a fresh user-confirmed pairing.

## Conversation and message scope

The bridge never selects every conversation automatically. The host-selected threads are
persisted as the allowlist; messages outside that selection are not written to the local
inbox. Outbound sends are also rejected for conversations that were not selected.

History sync processes only batches WhatsApp actually delivers. It does not promise a complete
history backfill. Messages in a conversation that was not selected when a history batch
arrived are discarded and may not be replayed after later selection.

The MVP maps stable WhatsApp JIDs and message IDs, direction, sender, text, timestamps, and
quoted-message references. A WhatsApp quote is not represented as a Slack thread. Only text
and quoted text replies are supported; media, reactions, edits, deletes, and group creation
are not implemented.

Outgoing messages are durably reserved before network send. If the send result is uncertain,
the outbox records `unknown` and does not automatically retry. This avoids silently duplicating
a message but is not an exactly-once delivery guarantee.

## Validation and third-party code

Tests use local fixtures and a fake sidecar process. No real WhatsApp account, credential, QR
scan, message read, or send was used for development validation. The sidecar pins
`go.mau.fi/whatsmeow` to the canonical upstream revision in `sidecar/go.mod`; it does not copy
code from the AGPL-licensed mautrix bridge. Review the
[`THIRD_PARTY_NOTICES.md`](../../packages/whatsapp-personal/THIRD_PARTY_NOTICES.md)
before redistributing the sidecar.
