import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const IPC_PROTOCOL = 1;
const REQUEST_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const RESTART_BASE_MS = 250;
const RESTART_MAX_MS = 30_000;
const RESTART_STABLE_MS = 60_000;

export interface WhatsAppLinkedMessage {
  cursor: number;
  chat_id: string;
  chat_title: string;
  message_id: string;
  command_id?: string;
  sender_id: string;
  sender_name?: string;
  from_me: boolean;
  text: string;
  timestamp: string;
  quote_id?: string;
  quote_sender?: string;
  history_batch?: string;
}

export interface WhatsAppLinkedChat {
  chat_id: string;
  title: string;
}

interface SidecarRequest {
  protocol: number;
  id: string;
  type: string;
  payload?: unknown;
}

interface SidecarResponse {
  protocol: number;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface SidecarEvent {
  protocol: number;
  type: string;
  payload?: unknown;
}

interface RequestWaiter {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

export interface WhatsAppSidecarChild {
  stdin: {
    write(data: string, callback: (error?: Error | null) => void): void;
    end(): void;
  };
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface WhatsAppSidecarManagerOptions {
  installationId: string;
  stateDir: string;
  binaryPath: string;
  spawnProcess?: (
    binaryPath: string,
    args: string[],
  ) => WhatsAppSidecarChild;
}

export class WhatsAppSidecarTransportError extends Error {
  constructor(
    message = "WhatsApp sidecar connection was interrupted",
    readonly mayHaveReachedSidecar = true,
  ) {
    super(message);
    this.name = "WhatsAppSidecarTransportError";
  }
}

export class WhatsAppSidecarCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppSidecarCommandError";
  }
}

export class WhatsAppSidecarManager {
  private child?: WhatsAppSidecarChild;
  private childExited = false;
  private waiters = new Map<string, RequestWaiter>();
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private exitPromise?: Promise<void>;
  private resolveExit?: () => void;
  private restartTimer?: NodeJS.Timeout;
  private stableTimer?: NodeJS.Timeout;
  private restartAttempts = 0;
  private started = false;
  private closing = false;
  private closed = false;
  private latestQr?: string;
  private latestPhoneCode?: string;
  private lastState?: string;
  private readonly eventHandlers = new Set<(type: string, payload: unknown) => void>();
  private readonly spawnProcess: NonNullable<WhatsAppSidecarManagerOptions["spawnProcess"]>;
  private startupDiagnostic?: string;
  private diagnosticBuffer = "";

  constructor(private readonly options: WhatsAppSidecarManagerOptions) {
    this.spawnProcess = options.spawnProcess ?? ((binaryPath, args) =>
      spawn(binaryPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: createWhatsAppSidecarEnvironment(process.env),
        windowsHide: true,
        shell: false,
      }) as ChildProcessWithoutNullStreams);
  }

  onEvent(handler: (type: string, payload: unknown) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  async start(): Promise<void> {
    if (this.closed || this.closing) {
      throw new Error("WhatsApp installation is stopped");
    }
    if (this.started && this.child) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.launchAndConnect().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  async stop(signal: AbortSignal): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.stopPromise) {
      return this.stopPromise;
    }
    this.stopPromise = this.stopChild(signal).finally(() => {
      this.stopPromise = undefined;
    });
    return this.stopPromise;
  }

  private async stopChild(signal: AbortSignal): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closing = true;
    this.latestQr = undefined;
    this.latestPhoneCode = undefined;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = undefined;
    }
    const child = this.child;
    if (!child) {
      this.closed = true;
      return;
    }

    let forced = false;
    const forceStop = () => {
      if (this.childExited) {
        return;
      }
      forced = true;
      child.kill("SIGKILL");
    };
    signal.addEventListener("abort", forceStop, { once: true });
    try {
      if (!signal.aborted && !this.childExited) {
        await this.requestOnChild(child, "shutdown", undefined, STOP_TIMEOUT_MS);
      } else if (signal.aborted && !this.childExited) {
        forceStop();
      }
      if (this.exitPromise) {
        await Promise.race([
          this.exitPromise,
          wait(STOP_TIMEOUT_MS).then(() => {
            if (!forced) {
              forceStop();
            }
            return this.exitPromise;
          }),
        ]);
      }
      if (this.child) {
        throw new Error("WhatsApp sidecar did not stop");
      }
      this.closed = true;
    } catch (error) {
      forceStop();
      if (this.exitPromise) {
        await Promise.race([this.exitPromise, wait(STOP_TIMEOUT_MS)]);
      }
      if (this.child) {
        throw new Error("WhatsApp sidecar could not be stopped");
      }
      this.closed = true;
      if (signal.aborted && error instanceof WhatsAppSidecarTransportError) {
        return;
      }
      if (signal.aborted) {
        return;
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", forceStop);
    }
  }

  async status(): Promise<{ state: string; qr?: string }> {
    const status = await this.request("status") as { state: string; qr?: string };
    this.lastState = status.state;
    return status;
  }

  getLastState(): string | undefined {
    return this.lastState;
  }

  async pairingCode(mode: "qr" | "phone" = "qr"): Promise<string | undefined> {
    const current = mode === "phone" ? this.latestPhoneCode : this.latestQr;
    if (current) {
      return current;
    }
    if (mode === "phone") {
      return undefined;
    }
    return (await this.status()).qr;
  }

  async pairPhone(phone: string): Promise<string> {
    const result = await this.request("pair.phone", { phone }) as { code?: string };
    if (!result.code) {
      throw new WhatsAppSidecarCommandError("WhatsApp phone pairing code is unavailable");
    }
    this.latestPhoneCode = result.code;
    return result.code;
  }

  async listChats(): Promise<WhatsAppLinkedChat[]> {
    return await this.request("chats.list") as WhatsAppLinkedChat[];
  }

  async selectChats(chatIds: readonly string[]): Promise<void> {
    const selected = [...new Set(chatIds)];
    await this.request("chats.select", { chat_ids: selected });
  }

  async addSelectedChat(chatId: string): Promise<void> {
    await this.request("chats.add", { chat_id: chatId });
  }

  async pollMessages(input: {
    chatId: string;
    cursor: number;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<{ messages: WhatsAppLinkedMessage[]; cursor: number }> {
    if (input.signal?.aborted) {
      throw input.signal.reason ?? new Error("Poll was cancelled");
    }
    const result = await this.request("messages.poll", {
      chat_id: input.chatId,
      cursor: input.cursor,
      limit: input.limit ?? 100,
    }) as { messages: WhatsAppLinkedMessage[]; cursor: number };
    if (input.signal?.aborted) {
      throw input.signal.reason ?? new Error("Poll was cancelled");
    }
    return result;
  }

  async sendMessage(input: {
    id: string;
    chatId: string;
    text: string;
    quoteId?: string;
    quoteSender?: string;
  }): Promise<{ id: string; state: string; server_id?: string }> {
    return await this.request("messages.send", {
      id: input.id,
      chat_id: input.chatId,
      text: input.text,
      ...(input.quoteId ? { quote_id: input.quoteId } : {}),
      ...(input.quoteSender ? { quote_sender: input.quoteSender } : {}),
    }) as { id: string; state: string; server_id?: string };
  }

  async resolveQuote(chatId: string, externalId: string): Promise<{ quote_id: string; quote_sender: string }> {
    return await this.request("messages.quote", {
      chat_id: chatId,
      external_id: externalId,
    }) as { quote_id: string; quote_sender: string };
  }

  async disconnectDevice(): Promise<void> {
    await this.request("disconnect");
  }

  async logoutDevice(): Promise<void> {
    await this.request("logout");
  }

  async relinkRevokedDevice(): Promise<void> {
    await this.request("pair.relink");
  }

  private async request(type: string, payload?: unknown): Promise<unknown> {
    if (this.closing || this.closed) {
      throw new WhatsAppSidecarTransportError("WhatsApp installation is stopped", false);
    }
    const child = this.child;
    if (!child || this.childExited) {
      throw new WhatsAppSidecarTransportError("WhatsApp sidecar is not running", false);
    }
    return this.requestOnChild(child, type, payload, REQUEST_TIMEOUT_MS);
  }

  private async requestOnChild(
    child: WhatsAppSidecarChild,
    type: string,
    payload: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const id = randomUUID();
    const req: SidecarRequest = {
      protocol: IPC_PROTOCOL,
      id,
      type,
      ...(payload === undefined ? {} : { payload }),
    };
    return new Promise((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(id);
        rejectRequest(new WhatsAppSidecarTransportError("WhatsApp sidecar request timed out"));
      }, timeoutMs);
      this.waiters.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timeout,
      });
      child.stdin.write(`${JSON.stringify(req)}\n`, (error) => {
        if (error) {
          this.rejectWaiter(id, new WhatsAppSidecarTransportError());
        }
      });
    });
  }

  private async launchAndConnect(): Promise<void> {
    if (this.closing || this.closed) {
      throw new Error("WhatsApp installation is stopped");
    }
    this.startupDiagnostic = undefined;
    this.diagnosticBuffer = "";
    const child = this.spawnProcess(this.options.binaryPath, [
      "--installation-id",
      this.options.installationId,
      "--state-dir",
      this.options.stateDir,
    ]);
    this.child = child;
    this.childExited = false;
    this.exitPromise = new Promise((resolveExit) => {
      this.resolveExit = resolveExit;
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: unknown) => this.captureDiagnostic(chunk));
    child.on("error", () => {
      this.failProcess(child);
    });
    child.on("exit", () => {
      if (this.child === child) {
        this.childExited = true;
      }
    });
    child.on("close", () => this.failProcess(child));

    try {
      const status = await this.requestOnChild(child, "status", undefined, REQUEST_TIMEOUT_MS) as { state?: string };
      this.lastState = status.state;
      if (status.state !== "externally_revoked") {
        await this.requestOnChild(child, "connect", undefined, REQUEST_TIMEOUT_MS);
      }
      this.started = true;
      this.stableTimer = setTimeout(() => {
        this.restartAttempts = 0;
        this.stableTimer = undefined;
      }, RESTART_STABLE_MS);
      this.stableTimer.unref();
    } catch (error) {
      child.kill("SIGKILL");
      if (this.exitPromise) {
        await Promise.race([this.exitPromise, wait(STOP_TIMEOUT_MS)]);
      }
      throw error;
    }
  }

  private handleLine(line: string): void {
    let message: SidecarResponse | SidecarEvent;
    try {
      message = JSON.parse(line) as SidecarResponse | SidecarEvent;
    } catch {
      return;
    }
    if (message.protocol !== IPC_PROTOCOL) {
      return;
    }
    if ("id" in message) {
      const waiter = this.waiters.get(message.id);
      if (!waiter) {
        return;
      }
      this.waiters.delete(message.id);
      clearTimeout(waiter.timeout);
      const response = message as SidecarResponse;
      if (!response.ok) {
        waiter.reject(new WhatsAppSidecarCommandError(response.error ?? "WhatsApp command failed"));
      } else {
        waiter.resolve(response.result);
      }
      return;
    }
    const event = message as SidecarEvent;
    if (event.type === "status" && isObject(event.payload) && typeof event.payload.state === "string") {
      this.lastState = event.payload.state;
    }
    if (event.type === "pairing.qr" && isObject(event.payload) && typeof event.payload.code === "string") {
      this.latestQr = event.payload.code;
      this.latestPhoneCode = undefined;
    } else if (event.type === "pairing.phone_code" && isObject(event.payload) && typeof event.payload.code === "string") {
      this.latestPhoneCode = event.payload.code;
      this.latestQr = undefined;
    } else if (event.type === "pairing.success") {
      this.latestQr = undefined;
      this.latestPhoneCode = undefined;
    } else if (event.type === "pairing.timeout" || event.type === "pairing.error") {
      this.latestQr = undefined;
      this.latestPhoneCode = undefined;
    }
    for (const handler of this.eventHandlers) {
      handler(event.type, event.payload);
    }
  }

  private failProcess(child: WhatsAppSidecarChild): void {
    if (this.child !== child) {
      return;
    }
    this.child = undefined;
    this.childExited = false;
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = undefined;
    }
    this.latestQr = undefined;
    this.latestPhoneCode = undefined;
    this.lastState = "disconnected";
    this.resolveExit?.();
    this.resolveExit = undefined;
    for (const [id] of this.waiters) {
      this.rejectWaiter(
        id,
        new WhatsAppSidecarTransportError(
          this.startupDiagnostic ?? "WhatsApp sidecar connection was interrupted",
        ),
      );
    }
    if (!this.closing && !this.closed && this.started) {
      this.scheduleRestart();
    }
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.closing || this.closed) {
      return;
    }
    const delay = Math.min(
      RESTART_BASE_MS * (2 ** this.restartAttempts),
      RESTART_MAX_MS,
    );
    this.restartAttempts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.launchAndConnect().catch(() => this.scheduleRestart());
    }, delay);
    this.restartTimer.unref();
  }

  private rejectWaiter(id: string, error: Error): void {
    const waiter = this.waiters.get(id);
    if (!waiter) {
      return;
    }
    this.waiters.delete(id);
    clearTimeout(waiter.timeout);
    waiter.reject(error);
  }

  private captureDiagnostic(chunk: unknown): void {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
    this.diagnosticBuffer = `${this.diagnosticBuffer}${text}`.slice(-512);
    const known = [
      "system keychain unavailable; WhatsApp session was not opened",
      "private local state directory unavailable",
      "encrypted session database unavailable",
      "encrypted session database could not be unlocked",
    ];
    this.startupDiagnostic = known.find((diagnostic) => this.diagnosticBuffer.includes(diagnostic));
  }
}

const managers = new Map<string, WhatsAppSidecarManager>();

export async function startWhatsAppSidecar(
  installationId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WhatsAppSidecarManager> {
  let manager = managers.get(installationId);
  if (!manager) {
    manager = new WhatsAppSidecarManager({
      installationId,
      stateDir: resolveWhatsAppStateDirectory(installationId, env),
      binaryPath: resolveWhatsAppSidecarPath(env),
    });
    managers.set(installationId, manager);
  }
  try {
    await manager.start();
    return manager;
  } catch (error) {
    const controller = new AbortController();
    controller.abort();
    await manager.stop(controller.signal);
    if (managers.get(installationId) === manager) {
      managers.delete(installationId);
    }
    throw error;
  }
}

export function getWhatsAppSidecar(installationId: string): WhatsAppSidecarManager | undefined {
  return managers.get(installationId);
}

export async function disconnectWhatsAppLinkedDevice(installationId: string): Promise<void> {
  const manager = managers.get(installationId);
  if (!manager) {
    throw new Error("WhatsApp linked-device sidecar is not running");
  }
  await manager.disconnectDevice();
}

export async function logoutWhatsAppLinkedDevice(installationId: string): Promise<void> {
  const manager = managers.get(installationId);
  if (!manager) {
    throw new Error("WhatsApp linked-device sidecar is not running");
  }
  await manager.logoutDevice();
  await stopWhatsAppSidecar(installationId, new AbortController().signal);
}

export async function relinkRevokedWhatsAppDevice(installationId: string): Promise<void> {
  const manager = managers.get(installationId);
  if (!manager) {
    throw new Error("WhatsApp linked-device sidecar is not running");
  }
  await manager.relinkRevokedDevice();
}

export async function stopWhatsAppSidecar(
  installationId: string,
  signal: AbortSignal,
): Promise<void> {
  const manager = managers.get(installationId);
  if (!manager) {
    return;
  }
  await manager.stop(signal);
  if (managers.get(installationId) === manager) {
    managers.delete(installationId);
  }
}

export function resolveWhatsAppSidecarPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.REGENIC_WHATSAPP_SIDECAR_PATH?.trim();
  if (override) {
    return resolve(override);
  }
  const name = whatsappSidecarAssetName(process.platform, process.arch);
  return resolve(__dirname, "../bin", name);
}

export function whatsappSidecarAssetName(platform: string, architecture: string): string {
  const supported = new Set([
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-arm64",
    "win32-x64",
  ]);
  const key = `${platform}-${architecture}`;
  if (!supported.has(key)) {
    throw new Error(`WhatsApp linked-device sidecar is not packaged for ${key}`);
  }
  return `whatsapp-linked-device-${key}${platform === "win32" ? ".exe" : ""}`;
}

export function createWhatsAppSidecarEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "HOMEDRIVE",
    "HOMEPATH",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "DBUS_SESSION_BUS_ADDRESS",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    if (source[key] !== undefined) {
      env[key] = source[key];
    }
  }
  return env;
}

export function resolveWhatsAppStateDirectory(
  installationId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const root = env.REGENIC_WHATSAPP_DATA_DIR?.trim()
    || defaultConfigDirectory(env);
  const safeId = createHash("sha256").update(installationId).digest("hex").slice(0, 24);
  return join(root, "whatsapp-linked-device", safeId);
}

function defaultConfigDirectory(env: NodeJS.ProcessEnv): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Regenic");
  }
  if (process.platform === "win32") {
    return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "Regenic");
  }
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "regenic");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
