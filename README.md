# regenic-connector-whatsapp

WhatsApp packages for Regenic, split out of the main `regenic-ai/regenic` repository. They are
no longer bundled with Regenic.

| Package | Path | Purpose |
| --- | --- | --- |
| `@regenic/whatsapp-personal` | `packages/whatsapp-personal` | WhatsApp Personal Export / Purr CSV import and the `whatsappWebLiveDriver` (`connector_type: "whatsapp-web-live"`) |
| `@regenic/web-extension-whatsapp` | `packages/web-extension-whatsapp` | Browser extension that bridges WhatsApp Web to a local Regenic |

## Development

`@regenic/whatsapp-personal` needs a newer `@regenic/connector-contract` than the published
`0.1.0` (it uses `EgressQueueRejectedError` and `SendNotAcceptedError`). Until that version is
published, the root `package.json` overrides it with a sibling checkout of Regenic:

```sh
git clone git@github.com:regenic-ai/regenic.git ../regenic
(cd ../regenic && pnpm install && pnpm --filter "@regenic/connector-contract..." build)

pnpm install
pnpm typecheck
pnpm test
```

`@regenic/connector-contract` is a peer dependency: the host must provide the same instance so
`instanceof` checks on driver errors keep working.

## Using it with Regenic

Regenic's built-in connector host only ships Feishu, DSH and Cursor. To run WhatsApp, add
`@regenic/whatsapp-personal` to your own deployment's connector host and register
`whatsappWebLiveDriver`; build the extension with `pnpm --filter @regenic/web-extension-whatsapp build`
and load `packages/web-extension-whatsapp/dist` as an unpacked extension.
