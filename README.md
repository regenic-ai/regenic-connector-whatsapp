# regenic-connector-whatsapp

WhatsApp packages for Regenic, split out of the main `regenic-ai/regenic` repository. They are
no longer bundled with Regenic.

| Package | Path | Purpose |
| --- | --- | --- |
| `@regenic/whatsapp-personal` | `packages/whatsapp-personal` | Read-only personal exports, the default `whatsapp-web-live` browser path, and the optional opt-in `whatsapp-linked-device` local bridge |
| `@regenic/web-extension-whatsapp` | `packages/web-extension-whatsapp` | Browser extension that bridges WhatsApp Web to a local Regenic |

## Development

The connector uses `@regenic/connector-contract` and its installation lifecycle hooks. For
development against a Regenic checkout, set `REGENIC_ROOT` to that checkout; package scripts
link the contract package from there without writing an absolute-path dependency into the
manifest or lockfile:

```sh
pnpm install
REGENIC_ROOT=/path/to/regenic pnpm --filter @regenic/whatsapp-personal typecheck
REGENIC_ROOT=/path/to/regenic pnpm --filter @regenic/whatsapp-personal test
```

`@regenic/connector-contract` is a peer dependency: the host must provide the same instance so
`instanceof` checks on driver errors keep working.

The existing WhatsApp Web extension remains the default live option; user-selected export
imports remain read-only. Neither browser use nor exports guarantee account safety. The
separate linked-device client uses an unofficial protocol, is disabled by default, and can
lead to account restrictions or bans. It starts only after explicit opt-in and the Engine's
additional risk confirmation. See [linked-device setup and limits](docs/en/WHATSAPP_LINKED_DEVICE.md)
before enabling it. The sidecar's third-party licenses are listed in
[`packages/whatsapp-personal/THIRD_PARTY_NOTICES.md`](packages/whatsapp-personal/THIRD_PARTY_NOTICES.md).

## Using it with Regenic

Regenic's built-in connector host only ships Feishu, DSH and Cursor. Load
`@regenic/whatsapp-personal` as an external plugin (its `package.json` declares the
`regenic.plugin` manifest):

```sh
pnpm install && pnpm build
# either point at the package directly
REGENIC_CHANNEL_PLUGIN=/path/to/regenic-connector-whatsapp/packages/whatsapp-personal
# or link/copy it into the plugin directory (default ~/.regenic/plugins)
ln -s /path/to/regenic-connector-whatsapp/packages/whatsapp-personal ~/.regenic/plugins/whatsapp-personal
```

Then install **WhatsApp Web (default path)** from **Engine**. Build the extension with
`pnpm --filter @regenic/web-extension-whatsapp build` and load
`packages/web-extension-whatsapp/dist` as an unpacked extension; paste the pairing code shown
after install. The opt-in linked-device sidecar must be built separately for each target with
`pnpm --filter @regenic/whatsapp-personal build:sidecar`; it is never downloaded at runtime.
Usage and acceptance docs are under [`docs/`](docs).
