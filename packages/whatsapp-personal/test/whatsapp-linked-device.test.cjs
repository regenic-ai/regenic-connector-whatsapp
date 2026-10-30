const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { chmod, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { PassThrough } = require("node:stream");
const { describe, it } = require("node:test");
const { SendNotAcceptedError } = require("@regenic/connector-contract");
const { verifyChannelDriverConformance } = require("@regenic/connector-test-utils");
const {
  WHATSAPP_LINKED_DEVICE_ACK_VALUE,
  WHATSAPP_LINKED_DEVICE_CONNECTOR_TYPE,
  createWhatsAppSidecarEnvironment,
  getWhatsAppSidecar,
  stopWhatsAppSidecar,
  whatsappLinkedDeviceDriver,
  whatsappSidecarAssetName,
  WhatsAppSidecarManager,
  WhatsAppSidecarTransportError,
  whatsappWebLiveDriver,
} = require("../dist");

function installation(overrides = {}) {
  return {
    id: "linked-install-1",
    org_id: "local-owner",
    connector_type: WHATSAPP_LINKED_DEVICE_CONNECTOR_TYPE,
    status: "enabled",
    config: { linked_device_mode: "disabled" },
    created_at: "2026-10-29T00:00:00.000Z",
    ...overrides,
  };
}

function fakeHost() {
  return {
    get() {
      return {};
    },
    async plugin() {
      return { ready: async () => undefined, dispose: async () => undefined };
    },
    now() {
      return "2026-10-29T00:00:00.000Z";
    },
    secrets: { read: async () => undefined, write() {} },
  };
}

describe("whatsapp-linked-device opt-in", () => {
  it("defaults to disabled and does not start from metadata or read-only calls", async () => {
    const installed = whatsappLinkedDeviceDriver.install({
      id: "linked-install-1",
      org_id: "local-owner",
      config: {},
      now: "2026-10-29T00:00:00.000Z",
    });
    assert.equal(installed.config.linked_device_mode, "disabled");
    assert.equal(whatsappLinkedDeviceDriver.capabilities(installed).sync, false);
    assert.equal(whatsappLinkedDeviceDriver.installCatalog().fields[0].default, "disabled");
    assert.equal(whatsappLinkedDeviceDriver.presentInstall(installed).detail, "linked.present.detail");
    await whatsappLinkedDeviceDriver.startInstallation(installed, fakeHost());
    assert.equal(await whatsappLinkedDeviceDriver.readPairingCode(installed), undefined);
    await assert.rejects(
      whatsappLinkedDeviceDriver.bindSyncSource(installed, fakeHost(), process.env),
      /disabled until you explicitly opt in/i,
    );
    assert.equal(whatsappWebLiveDriver.connector_type, "whatsapp-web-live");
    assert.equal(whatsappLinkedDeviceDriver.connector_type, "whatsapp-linked-device");
  });

  it("does not start an opted-in installation while its host status is disabled", async () => {
    const disabled = installation({
      status: "disabled",
      config: {
        linked_device_mode: "enabled",
        linked_device_risk_ack: WHATSAPP_LINKED_DEVICE_ACK_VALUE,
      },
    });
    await whatsappLinkedDeviceDriver.startInstallation(disabled, fakeHost());
    assert.equal(getWhatsAppSidecar(disabled.id), undefined);
  });

  it("rejects opt-in without the risk acknowledgement and requires the install confirmation", () => {
    assert.throws(
      () => whatsappLinkedDeviceDriver.install({
        id: "linked-install-1",
        org_id: "local-owner",
        config: { linked_device_mode: "enabled" },
        now: "2026-10-29T00:00:00.000Z",
      }),
      /acknowledge the linked-device protocol and account-ban risk/i,
    );
    const catalog = whatsappLinkedDeviceDriver.installCatalog();
    assert.deepEqual(catalog.install_confirm.when, {
      field: "linked_device_mode",
      value: "enabled",
    });
    assert.equal(catalog.install_confirm.ack, "linked.confirm.ack");
    const enabled = whatsappLinkedDeviceDriver.install({
      id: "linked-install-1",
      org_id: "local-owner",
      config: {
        linked_device_mode: "enabled",
        linked_device_risk_ack: WHATSAPP_LINKED_DEVICE_ACK_VALUE,
      },
      now: "2026-10-29T00:00:00.000Z",
    });
    assert.equal(whatsappLinkedDeviceDriver.capabilities(enabled).sync, true);
  });

  it("does not start if an enabled installation is missing its risk acknowledgement", async () => {
    const unacknowledged = installation({
      config: { linked_device_mode: "enabled" },
    });
    await assert.rejects(
      whatsappLinkedDeviceDriver.startInstallation(unacknowledged, fakeHost()),
      /acknowledge the linked-device protocol and account-ban risk/i,
    );
    assert.equal(getWhatsAppSidecar(unacknowledged.id), undefined);
  });

  it("conforms to the host driver contract while disabled by default", () => {
    verifyChannelDriverConformance({
      driver: whatsappLinkedDeviceDriver,
      enabled: installation(),
      disabled: installation({ status: "disabled" }),
    });
  });

  it("selects only explicitly packaged platform binaries", () => {
    assert.equal(whatsappSidecarAssetName("darwin", "arm64"), "whatsapp-linked-device-darwin-arm64");
    assert.equal(whatsappSidecarAssetName("win32", "x64"), "whatsapp-linked-device-win32-x64.exe");
    assert.throws(() => whatsappSidecarAssetName("freebsd", "x64"), /not packaged/i);
  });

  it("passes only the minimal platform environment to the sidecar", () => {
    const env = createWhatsAppSidecarEnvironment({
      HOME: "/home/test",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      REGENIC_WHATSAPP_SIDECAR_PATH: "/private/sidecar",
      API_TOKEN: "must-not-be-inherited",
      WHATSAPP_KEY: "must-not-be-inherited",
    });
    assert.equal(env.HOME, "/home/test");
    assert.equal(env.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/1000/bus");
    assert.equal(env.REGENIC_WHATSAPP_SIDECAR_PATH, undefined);
    assert.equal(env.API_TOKEN, undefined);
    assert.equal(env.WHATSAPP_KEY, undefined);
  });
});

describe("WhatsApp sidecar manager", () => {
  it("shares one process across concurrent start and status calls, then stops it", async () => {
    const children = [];
    const manager = new WhatsAppSidecarManager({
      installationId: "linked-install-1",
      stateDir: "/private/test",
      binaryPath: "/test/whatsapp-sidecar",
      spawnProcess: (_path, _args) => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    });
    await Promise.all([manager.start(), manager.start(), manager.start()]);
    assert.equal(children.length, 1);
    assert.equal(children[0].commands.includes("chats.select"), false);
    assert.equal((await manager.status()).state, "unlinked");
    await manager.stop(new AbortController().signal);
    assert.equal(children[0].exited, true);
    await assert.rejects(manager.start(), /stopped/);
    await assert.rejects(
      manager.status(),
      (error) => error instanceof WhatsAppSidecarTransportError && !error.mayHaveReachedSidecar,
    );
  });

  it("coalesces concurrent stop calls into one shutdown request", async () => {
    const commands = [];
    const manager = new WhatsAppSidecarManager({
      installationId: "linked-install-1",
      stateDir: "/private/test",
      binaryPath: "/test/whatsapp-sidecar",
      spawnProcess: () => new FakeChild(commands),
    });
    await manager.start();
    await Promise.all([
      manager.stop(new AbortController().signal),
      manager.stop(new AbortController().signal),
    ]);
    assert.equal(commands.filter((command) => command === "shutdown").length, 1);
    await manager.stop(new AbortController().signal);
    assert.equal(commands.filter((command) => command === "shutdown").length, 1);
  });

  it("restarts a crashed child with a bound timer and cancels restart on stop", async () => {
    const children = [];
    const manager = new WhatsAppSidecarManager({
      installationId: "linked-install-1",
      stateDir: "/private/test",
      binaryPath: "/test/whatsapp-sidecar",
      spawnProcess: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    });
    await manager.start();
    children[0].crash();
    await waitFor(() => children.length === 2);
    children[1].crash();
    await manager.stop(new AbortController().signal);
    await delay(350);
    assert.equal(children.length, 2);
  });

  it("does not reconnect a device that WhatsApp marked externally revoked", async () => {
    const commands = [];
    const manager = new WhatsAppSidecarManager({
      installationId: "linked-install-1",
      stateDir: "/private/test",
      binaryPath: "/test/whatsapp-sidecar",
      spawnProcess: () => new FakeChild(commands, "externally_revoked"),
    });
    await manager.start();
    assert.equal(commands.includes("connect"), false);
    assert.equal(manager.getLastState(), "externally_revoked");
    await manager.stop(new AbortController().signal);
  });

  it("starts after explicit opt-in and stops the real child through the installation hook", async () => {
    const directory = await mkdtemp(join(tmpdir(), "regenic-wa-sidecar-test-"));
    const executable = join(directory, "fake-sidecar");
    const launchCounter = join(directory, "launches");
    const originalBinary = process.env.REGENIC_WHATSAPP_SIDECAR_PATH;
    await writeFile(executable, `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(launchCounter)}, "x");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  const result = request.type === "status"
    ? { state: "unlinked" }
    : request.type === "shutdown"
      ? { state: "stopped" }
      : { state: "connecting" };
  process.stdout.write(JSON.stringify({
    protocol: 1, id: request.id, ok: true, result,
  }) + String.fromCharCode(10), () => {
    if (request.type === "shutdown") process.exit(0);
  });
});
`);
    await chmod(executable, 0o700);
    process.env.REGENIC_WHATSAPP_SIDECAR_PATH = executable;
    const id = `lifecycle-${Date.now()}`;
    const optedIn = installation({
      id,
      config: {
        linked_device_mode: "enabled",
        linked_device_risk_ack: WHATSAPP_LINKED_DEVICE_ACK_VALUE,
      },
    });
    try {
      await whatsappLinkedDeviceDriver.startInstallation(optedIn, fakeHost());
      const manager = getWhatsAppSidecar(id);
      assert.ok(manager);
      assert.equal(manager.getLastState(), "unlinked");
      const staleStream = await whatsappLinkedDeviceDriver.resolveThreadStream(optedIn, {
        source: "whatsapp-linked-device",
        target: "15551234567@c.us",
      });
      await whatsappLinkedDeviceDriver.stopInstallation(optedIn, fakeHost(), {
        reason: "disable",
        signal: new AbortController().signal,
      });
      assert.equal(getWhatsAppSidecar(id), undefined);
      await assert.rejects(
        staleStream.connector.poll(null),
        /WhatsApp installation is stopped/,
      );
      await delay(350);
      assert.equal(await readFile(launchCounter, "utf8"), "x");
      await assert.rejects(
        manager.status(),
        (error) => error instanceof WhatsAppSidecarTransportError && !error.mayHaveReachedSidecar,
      );
    } finally {
      if (originalBinary === undefined) {
        delete process.env.REGENIC_WHATSAPP_SIDECAR_PATH;
      } else {
        process.env.REGENIC_WHATSAPP_SIDECAR_PATH = originalBinary;
      }
      await stopWhatsAppSidecar(id, new AbortController().signal);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reconnects an already-linked phone-pairing installation without requesting a new code", async () => {
    const directory = await mkdtemp(join(tmpdir(), "regenic-wa-phone-restart-test-"));
    const executable = join(directory, "fake-sidecar");
    const commandLog = join(directory, "commands");
    const originalBinary = process.env.REGENIC_WHATSAPP_SIDECAR_PATH;
    await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(commandLog)}, request.type + "\\n");
  const result = request.type === "status"
    ? { state: "disconnected" }
    : request.type === "shutdown"
      ? { state: "stopped" }
      : { state: "connecting" };
  process.stdout.write(JSON.stringify({
    protocol: 1, id: request.id, ok: true, result,
  }) + String.fromCharCode(10), () => {
    if (request.type === "shutdown") process.exit(0);
  });
});
`);
    await chmod(executable, 0o700);
    process.env.REGENIC_WHATSAPP_SIDECAR_PATH = executable;
    const id = `phone-restart-${Date.now()}`;
    const optedIn = installation({
      id,
      config: {
        linked_device_mode: "enabled",
        linked_device_risk_ack: WHATSAPP_LINKED_DEVICE_ACK_VALUE,
        pairing_method: "phone",
        pairing_phone_number: "+15551234567",
      },
    });
    try {
      await whatsappLinkedDeviceDriver.startInstallation(optedIn, fakeHost());
      assert.equal(getWhatsAppSidecar(id)?.getLastState(), "disconnected");
      assert.match(await readFile(commandLog, "utf8"), /connect/);
      assert.doesNotMatch(await readFile(commandLog, "utf8"), /pair\.phone/);
    } finally {
      if (originalBinary === undefined) {
        delete process.env.REGENIC_WHATSAPP_SIDECAR_PATH;
      } else {
        process.env.REGENIC_WHATSAPP_SIDECAR_PATH = originalBinary;
      }
      await stopWhatsAppSidecar(id, new AbortController().signal);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not accept an outbound message that the sidecar marks rejected", async () => {
    const directory = await mkdtemp(join(tmpdir(), "regenic-wa-rejected-send-test-"));
    const executable = join(directory, "fake-sidecar");
    const originalBinary = process.env.REGENIC_WHATSAPP_SIDECAR_PATH;
    await writeFile(executable, `#!/usr/bin/env node
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  const result = request.type === "status"
    ? { state: "connected" }
    : request.type === "messages.send"
      ? { id: request.payload.id, state: "rejected" }
      : request.type === "shutdown"
        ? { state: "stopped" }
        : { state: "connecting" };
  process.stdout.write(JSON.stringify({
    protocol: 1, id: request.id, ok: true, result,
  }) + String.fromCharCode(10), () => {
    if (request.type === "shutdown") process.exit(0);
  });
});
`);
    await chmod(executable, 0o700);
    process.env.REGENIC_WHATSAPP_SIDECAR_PATH = executable;
    const id = `rejected-send-${Date.now()}`;
    const optedIn = installation({
      id,
      config: {
        linked_device_mode: "enabled",
        linked_device_risk_ack: WHATSAPP_LINKED_DEVICE_ACK_VALUE,
      },
    });
    const thread = {
      source: "whatsapp-linked-device",
      target: "15551234567@c.us",
    };
    try {
      await whatsappLinkedDeviceDriver.startInstallation(optedIn, fakeHost());
      const egress = await whatsappLinkedDeviceDriver.bindEgress(optedIn, thread);
      await assert.rejects(
        egress.send({
          content: [{ role: "body", media_type: "text/plain", text: "not sent" }],
          idempotency_key: "stable-key",
        }),
        (error) => error instanceof SendNotAcceptedError && error.code === "send_failed",
      );
    } finally {
      if (originalBinary === undefined) {
        delete process.env.REGENIC_WHATSAPP_SIDECAR_PATH;
      } else {
        process.env.REGENIC_WHATSAPP_SIDECAR_PATH = originalBinary;
      }
      await stopWhatsAppSidecar(id, new AbortController().signal);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

class FakeChild extends EventEmitter {
  constructor(commands = [], initialState = "unlinked") {
    super();
    this.commands = commands;
    this.initialState = initialState;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exited = false;
    this.stdin = {
      write: (line, callback) => {
        const request = JSON.parse(line);
        this.commands.push(request.type);
        let result = {};
        if (request.type === "status") {
          result = { state: this.initialState };
        } else if (request.type === "chats.select") {
          result = { selected: request.payload.chat_ids.length };
        } else if (request.type === "connect") {
          result = { state: "connecting" };
        } else if (request.type === "shutdown") {
          result = { state: "stopped" };
        }
        this.stdout.write(`${JSON.stringify({
          protocol: 1,
          id: request.id,
          ok: true,
          result,
        })}\n`);
        callback(null);
        if (request.type === "shutdown") {
          setImmediate(() => this.crash());
        }
      },
      end: () => undefined,
    };
  }

  kill() {
    this.crash();
    return true;
  }

  crash() {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.emit("exit", 0, null);
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit("close", 0, null));
  }
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2_500;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(20);
  }
  assert.fail("condition was not met before the deadline");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
