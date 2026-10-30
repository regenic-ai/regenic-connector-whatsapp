import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import {
  CONNECTOR_PROTOCOL,
  ChannelDriverError,
  SendNotAcceptedError,
  INGEST_SCHEMA_VERSION,
  channelRecord,
  type ChannelDriver,
  type ConnectorInstallation,
  type ConnectorStream,
  type ConnectorCursor,
  type ConnectorPollOptions,
  type ConversationThread,
  type DeliveryReceipt,
  type IngestBatch,
  type SyncDirectoryPage,
} from "@regenic/connector-contract";
import { whatsappLinkedDeviceLocaleTables, whatsappLocaleTables } from "./locales";
import {
  getWhatsAppSidecar,
  resolveWhatsAppSidecarPath,
  startWhatsAppSidecar,
  stopWhatsAppSidecar,
  WhatsAppSidecarCommandError,
  WhatsAppSidecarTransportError,
  type WhatsAppLinkedMessage,
} from "./whatsapp-linked-device-process";
import { isWhatsAppChatId, whatsappConversationKind } from "./whatsapp-ids";

export const WHATSAPP_LINKED_DEVICE_CONNECTOR_TYPE = "whatsapp-linked-device";
export const WHATSAPP_LINKED_DEVICE_SOURCE = "whatsapp-linked-device";
export const WHATSAPP_LINKED_DEVICE_OPT_IN_FIELD = "linked_device_mode";
export const WHATSAPP_LINKED_DEVICE_ACK_FIELD = "linked_device_risk_ack";
export const WHATSAPP_LINKED_DEVICE_ACK_VALUE = "accept-private-protocol-risk";
const LINKED_DEVICE_ENABLED = "enabled";
const LINKED_DEVICE_DISABLED = "disabled";
const MAX_SEND_TEXT_CHARS = 4_000;

interface WhatsAppLinkedDeviceInstallConfig extends Record<string, unknown> {
  linked_device_mode?: unknown;
  linked_device_risk_ack?: unknown;
  pairing_method?: unknown;
  pairing_phone_number?: unknown;
}

export const whatsappLinkedDeviceDriver: ChannelDriver = {
  connector_type: WHATSAPP_LINKED_DEVICE_CONNECTOR_TYPE,
  source: WHATSAPP_LINKED_DEVICE_SOURCE,
  connector_protocol: CONNECTOR_PROTOCOL,

  install(input) {
    const config = input.config as WhatsAppLinkedDeviceInstallConfig;
    const mode = config[WHATSAPP_LINKED_DEVICE_OPT_IN_FIELD];
    if (mode !== undefined && mode !== LINKED_DEVICE_ENABLED && mode !== LINKED_DEVICE_DISABLED) {
      throw new ChannelDriverError("invalid_config", "Select whether to enable the WhatsApp linked-device bridge");
    }
    if (mode === LINKED_DEVICE_ENABLED) {
      assertRiskAcknowledged(config);
      if (config.pairing_method === "phone" && !nonEmptyString(config.pairing_phone_number)) {
        throw new ChannelDriverError("invalid_config", "Enter a phone number for phone-code pairing");
      }
    }
    return {
      id: input.id,
      org_id: input.org_id,
      connector_type: WHATSAPP_LINKED_DEVICE_CONNECTOR_TYPE,
      status: "enabled",
      config: {
        ...input.config,
        [WHATSAPP_LINKED_DEVICE_OPT_IN_FIELD]: mode ?? LINKED_DEVICE_DISABLED,
      },
      created_at: input.now,
    };
  },

  matchesThread(installation, thread) {
    return (
      isLinkedDeviceEnabled(installation)
      && installation.status === "enabled"
      && thread.source === WHATSAPP_LINKED_DEVICE_SOURCE
      && isWhatsAppChatId(thread.target)
    );
  },

  ownsThread(installation, thread) {
    return this.matchesThread(installation, thread);
  },

  capabilities(installation) {
    const enabled = isLinkedDeviceEnabled(installation) && installation.status === "enabled";
    return {
      sync: enabled,
      reply: enabled,
      create: false,
      list_title: "conversation",
      pairing_code: enabled,
    };
  },

  async startInstallation(installation) {
    if (!isLinkedDeviceEnabled(installation) || installation.status !== "enabled") {
      return;
    }
    assertRiskAcknowledged(installation.config);
    getLinkedDeviceBinaryPath();
    const manager = await startWhatsAppSidecar(installation.id);
    const state = manager.getLastState();
    if (state !== "unlinked") {
      return;
    }
    const pairingMethod = stringConfig(installation.config, "pairing_method");
    if (pairingMethod === "phone") {
      const phone = stringConfig(installation.config, "pairing_phone_number");
      if (!phone) {
        await stopWhatsAppSidecar(installation.id, new AbortController().signal);
        throw new ChannelDriverError("invalid_config", "Enter a phone number for phone-code pairing");
      }
      try {
        await manager.pairPhone(phone);
      } catch (error) {
        await stopWhatsAppSidecar(installation.id, new AbortController().signal);
        throw wrapSidecarError(error, "WhatsApp phone pairing could not be started");
      }
    }
  },

  async stopInstallation(installation, _host, context) {
    await stopWhatsAppSidecar(installation.id, context.signal);
  },

  async resolveStreams(installation, host, _env, options) {
    assertActiveInstallation(installation);
    const manager = requireStartedManager(installation.id);
    const activeChats = [...new Set(
      (options?.threads ?? [])
        .filter((thread) => thread.source === WHATSAPP_LINKED_DEVICE_SOURCE && isWhatsAppChatId(thread.target))
        .map((thread) => thread.target),
    )];
    if (options?.threads !== undefined) {
      await manager.selectChats(activeChats);
    }
    return activeChats.map((chatId) => linkedDeviceStream(installation, chatId, manager));
  },

  async resolveThreadStream(installation, thread) {
    assertActiveInstallation(installation);
    if (thread.source !== WHATSAPP_LINKED_DEVICE_SOURCE || !isWhatsAppChatId(thread.target)) {
      throw new ChannelDriverError("unsupported_channel", "WhatsApp linked-device requires a WhatsApp JID conversation");
    }
    const manager = requireStartedManager(installation.id);
    await manager.addSelectedChat(thread.target);
    return linkedDeviceStream(installation, thread.target, manager);
  },

  async bindSyncSource(installation) {
    assertActiveInstallation(installation);
    const manager = requireStartedManager(installation.id);
    return {
      async listDirectory(cursor): Promise<SyncDirectoryPage> {
        const chats = await manager.listChats();
        const offset = parseDirectoryCursor(cursor);
        const pageSize = 100;
        const page = chats.slice(offset, offset + pageSize);
        const members = page
          .filter((chat) => isWhatsAppChatId(chat.chat_id))
          .map((chat) => ({
            stream_key: linkedDeviceStreamKey(chat.chat_id),
            thread_id: linkedDeviceThreadId(chat.chat_id),
            label: chat.title || chat.chat_id,
            kind: whatsappConversationKind(chat.chat_id),
          }));
        const nextOffset = offset + page.length;
        const complete = nextOffset >= chats.length;
        return {
          members,
          complete,
          replaces: offset === 0,
          ...(complete ? {} : { next_cursor: String(nextOffset) }),
        };
      },
    };
  },

  async bindEgress(installation, thread) {
    assertActiveInstallation(installation);
    if (thread.source !== WHATSAPP_LINKED_DEVICE_SOURCE || !isWhatsAppChatId(thread.target)) {
      throw new ChannelDriverError("unsupported_channel", "WhatsApp linked-device can only reply to a WhatsApp JID conversation");
    }
    const manager = requireStartedManager(installation.id);
    return {
      source: WHATSAPP_LINKED_DEVICE_SOURCE,
      capabilities: () => ({ reply: true, edit: false, tombstone: false }),
      async send(intent) {
        const text = textOnlyContent(intent.content);
        if (!text || [...text].length > MAX_SEND_TEXT_CHARS) {
          throw new SendNotAcceptedError(
            "invalid_config",
            `WhatsApp text replies must contain 1 to ${MAX_SEND_TEXT_CHARS} characters`,
          );
        }
        const key = intent.idempotency_key?.trim();
        if (!key) {
          throw new SendNotAcceptedError(
            "invalid_config",
            "WhatsApp linked-device requires a stable idempotency key for each send",
          );
        }
        let status: { state: string };
        try {
          status = await manager.status();
        } catch {
          throw new SendNotAcceptedError("send_failed", "WhatsApp linked device status is unavailable");
        }
        if (status.state !== "connected") {
          throw new SendNotAcceptedError("send_failed", "WhatsApp linked device is not connected");
        }
        const id = createHash("sha256").update(`${thread.target}\0${key}`).digest("hex");
        let quote: { quote_id: string; quote_sender: string } | undefined;
        if (intent.target?.external_id) {
          try {
            quote = await manager.resolveQuote(thread.target, intent.target.external_id);
          } catch (error) {
            if (error instanceof WhatsAppSidecarTransportError) {
              throw new SendNotAcceptedError("send_failed", error.message);
            }
            throw new SendNotAcceptedError(
              "unsupported_channel",
              error instanceof Error ? error.message : "WhatsApp quoted message is unavailable",
            );
          }
        }
        try {
          const result = await manager.sendMessage({
            id,
            chatId: thread.target,
            text,
            quoteId: quote?.quote_id,
            quoteSender: quote?.quote_sender,
          });
          if (result.state === "rejected") {
            throw new SendNotAcceptedError("send_failed", "WhatsApp rejected the message before sending");
          }
          return { accepted: true, rpc_id: result.id };
        } catch (error) {
          if (error instanceof WhatsAppSidecarTransportError) {
            if (!error.mayHaveReachedSidecar) {
              throw new SendNotAcceptedError("send_failed", error.message);
            }
            return { accepted: true, rpc_id: id };
          }
          if (error instanceof WhatsAppSidecarCommandError) {
            throw new SendNotAcceptedError("send_failed", error.message);
          }
          throw error;
        }
      },
    };
  },

  outboundId(thread: ConversationThread, receipt: DeliveryReceipt) {
    return `${thread.target}:out:${receipt.rpc_id ?? randomUUID()}`;
  },

  async readPairingCode(installation) {
    if (!isLinkedDeviceEnabled(installation)) {
      return undefined;
    }
    const manager = getWhatsAppSidecar(installation.id);
    if (!manager) {
      return undefined;
    }
    if (manager.getLastState() === "externally_revoked") {
      return undefined;
    }
    const pairingMethod = stringConfig(installation.config, "pairing_method") === "phone"
      ? "phone"
      : "qr";
    return manager.pairingCode(pairingMethod);
  },

  locales() {
    return [...whatsappLocaleTables, ...whatsappLinkedDeviceLocaleTables];
  },

  installCatalog() {
    return {
      title: "linked.catalog.title",
      channel_label: "linked.catalog.channelLabel",
      description: "linked.catalog.description",
      credential_hint: "linked.catalog.credentialHint",
      singleton: true,
      fields: [
        {
          key: WHATSAPP_LINKED_DEVICE_OPT_IN_FIELD,
          label: "linked.field.mode",
          default: LINKED_DEVICE_DISABLED,
          options: [
            { value: LINKED_DEVICE_DISABLED, label: "linked.option.disabled" },
            { value: LINKED_DEVICE_ENABLED, label: "linked.option.enabled" },
          ],
        },
        {
          key: WHATSAPP_LINKED_DEVICE_ACK_FIELD,
          label: "linked.field.riskAck",
          required: true,
          visible_when: { field: WHATSAPP_LINKED_DEVICE_OPT_IN_FIELD, value: LINKED_DEVICE_ENABLED },
          options: [
            { value: WHATSAPP_LINKED_DEVICE_ACK_VALUE, label: "linked.option.riskAck" },
          ],
        },
        {
          key: "pairing_method",
          label: "linked.field.pairingMethod",
          default: "qr",
          visible_when: { field: WHATSAPP_LINKED_DEVICE_OPT_IN_FIELD, value: LINKED_DEVICE_ENABLED },
          options: [
            { value: "qr", label: "linked.option.qr" },
            { value: "phone", label: "linked.option.phone" },
          ],
        },
        {
          key: "pairing_phone_number",
          label: "linked.field.phoneNumber",
          required: true,
          visible_when: { field: "pairing_method", value: "phone" },
        },
      ],
      install_confirm: {
        when: { field: WHATSAPP_LINKED_DEVICE_OPT_IN_FIELD, value: LINKED_DEVICE_ENABLED },
        warning: "linked.confirm.warning",
        ack: "linked.confirm.ack",
      },
      setup_steps: [
        {
          title: "linked.setup.optIn.title",
          body: "linked.setup.optIn.body",
        },
        {
          title: "linked.setup.pair.title",
          body: "linked.setup.pair.body",
        },
        {
          title: "linked.setup.chats.title",
          body: "linked.setup.chats.body",
        },
      ],
    };
  },

  presentInstall(installation) {
    const state = getWhatsAppSidecar(installation.id)?.getLastState();
    return {
      label: "linked.present.label",
      detail: state === "externally_revoked"
        ? "linked.present.revoked"
        : "linked.present.detail",
    };
  },
};

function linkedDeviceStream(
  installation: ConnectorInstallation,
  chatId: string,
  manager: ReturnType<typeof requireStartedManager>,
): ConnectorStream {
  return {
    stream_key: linkedDeviceStreamKey(chatId),
    thread_id: linkedDeviceThreadId(chatId),
    label: chatId,
    connector: {
      source: WHATSAPP_LINKED_DEVICE_SOURCE,
      source_mode: "poll",
      async poll(cursor: ConnectorCursor | null, options?: ConnectorPollOptions) {
        const currentCursor = parseMessageCursor(cursor?.value);
        const page = await manager.pollMessages({
          chatId,
          cursor: currentCursor,
          limit: 100,
          signal: options?.signal,
        });
        const records = page.messages.map((message) => linkedDeviceRecord(message));
        const nextCursor = page.cursor;
        const batch: IngestBatch = {
          schema_version: INGEST_SCHEMA_VERSION,
          connector_id: installation.id,
          org_id: installation.org_id,
          delivery_id: `${WHATSAPP_LINKED_DEVICE_CONNECTOR_TYPE}:${chatId}:${currentCursor}:${nextCursor}`,
          received_at: new Date().toISOString(),
          records,
          next_cursor: String(nextCursor),
        };
        return {
          batch,
          next_cursor: String(nextCursor),
          has_more: records.length === 100,
        };
      },
    },
  };
}

function linkedDeviceRecord(message: WhatsAppLinkedMessage) {
  const outboundId = message.command_id
    ? `${message.chat_id}:out:${message.command_id}`
    : `${message.chat_id}:in:${message.message_id}`;
  const record = channelRecord({
    channel: WHATSAPP_LINKED_DEVICE_SOURCE,
    kind: "user",
    direction: message.from_me ? "outbound" : "inbound",
    external_id: outboundId,
    occurred_at: validTimestamp(message.timestamp),
    actor_id: message.from_me ? "local-owner" : message.sender_id,
    actor_label: message.from_me ? undefined : message.sender_name,
    scope_id: message.chat_id,
    scope_name: message.chat_title || message.chat_id,
    conversation_kind: whatsappConversationKind(message.chat_id),
    type: "message",
    text: message.text,
  });
  record.attrs = {
    ...(message.quote_id ? { whatsapp_quote_id: message.quote_id } : {}),
    ...(message.quote_sender ? { whatsapp_quote_sender: message.quote_sender } : {}),
    ...(message.history_batch ? { history_batch: message.history_batch } : {}),
    platform: "whatsapp-linked-device",
  };
  return record;
}

function assertActiveInstallation(installation: ConnectorInstallation): void {
  if (!isLinkedDeviceEnabled(installation)) {
    throw new ChannelDriverError(
      "unsupported_channel",
      "WhatsApp linked-device is disabled until you explicitly opt in and acknowledge the linking risk",
    );
  }
  if (installation.status !== "enabled") {
    throw new ChannelDriverError("unsupported_channel", "WhatsApp linked-device installation is disabled");
  }
  assertRiskAcknowledged(installation.config);
}

function assertRiskAcknowledged(config: Record<string, unknown>): void {
  if (config[WHATSAPP_LINKED_DEVICE_ACK_FIELD] !== WHATSAPP_LINKED_DEVICE_ACK_VALUE) {
    throw new ChannelDriverError(
      "invalid_config",
      "Explicitly acknowledge the linked-device protocol and account-ban risk before enabling this bridge",
    );
  }
}

function isLinkedDeviceEnabled(installation: ConnectorInstallation): boolean {
  return installation.config[WHATSAPP_LINKED_DEVICE_OPT_IN_FIELD] === LINKED_DEVICE_ENABLED;
}

function requireStartedManager(installationId: string) {
  const manager = getWhatsAppSidecar(installationId);
  if (!manager) {
    throw new ChannelDriverError(
      "sync_failed",
      "WhatsApp linked-device sidecar is not running; it starts only after explicit installation opt-in",
    );
  }
  return manager;
}

function textOnlyContent(content: readonly { role: string; media_type: string; text?: string; bytes?: Uint8Array; external_locator?: string }[]): string {
  if (
    content.length === 0
    || content.some((part) =>
      part.role !== "body"
      || part.media_type !== "text/plain"
      || typeof part.text !== "string"
      || part.bytes !== undefined
      || part.external_locator !== undefined,
    )
  ) {
    throw new SendNotAcceptedError(
      "unsupported_channel",
      "WhatsApp linked-device supports text replies only",
    );
  }
  return content.map((part) => part.text ?? "").join("\n").trim();
}

function validTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp) || !/(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    throw new ChannelDriverError("sync_failed", "WhatsApp returned an invalid message timestamp");
  }
  return new Date(timestamp).toISOString();
}

function parseMessageCursor(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new ChannelDriverError("invalid_config", "WhatsApp cursor is invalid");
  }
  return cursor;
}

function parseDirectoryCursor(value: string | null): number {
  if (value === null) {
    return 0;
  }
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new ChannelDriverError("invalid_config", "WhatsApp directory cursor is invalid");
  }
  return offset;
}

function linkedDeviceStreamKey(chatId: string): string {
  return `whatsapp:${chatId}`;
}

function linkedDeviceThreadId(chatId: string): string {
  return `${WHATSAPP_LINKED_DEVICE_SOURCE}:${chatId}`;
}

function stringConfig(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function wrapSidecarError(error: unknown, fallback: string): ChannelDriverError {
  if (error instanceof ChannelDriverError) {
    return error;
  }
  if (error instanceof WhatsAppSidecarCommandError) {
    return new ChannelDriverError("sync_failed", error.message);
  }
  if (error instanceof WhatsAppSidecarTransportError) {
    return new ChannelDriverError("sync_failed", error.message);
  }
  const message = error instanceof Error ? error.message : fallback;
  return new ChannelDriverError("sync_failed", message || fallback);
}

export function getLinkedDeviceBinaryPath(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const binaryPath = resolveWhatsAppSidecarPath(env);
    if (!existsSync(binaryPath)) {
      throw new Error(
        `WhatsApp linked-device sidecar is missing for ${process.platform}-${process.arch}; build it with pnpm --filter @regenic/whatsapp-personal build:sidecar`,
      );
    }
    const binary = statSync(binaryPath);
    if (!binary.isFile() || (process.platform !== "win32" && (binary.mode & 0o111) === 0)) {
      throw new Error("WhatsApp linked-device sidecar is not an executable file");
    }
    return binaryPath;
  } catch (error) {
    throw new ChannelDriverError(
      "sync_failed",
      error instanceof Error ? error.message : "WhatsApp linked-device sidecar is unavailable",
    );
  }
}
