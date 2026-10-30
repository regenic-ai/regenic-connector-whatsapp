# Third-Party Notices

The linked-device sidecar is built from the pinned Go modules listed in the repository's
`sidecar/go.mod` and `sidecar/go.sum`. Those files are the authoritative dependency/version
inventory. Notices for the direct dependencies used by the sidecar:

| Dependency | Pinned version | License / notice |
| --- | --- | --- |
| [`go.mau.fi/whatsmeow`](https://github.com/tulir/whatsmeow) | `v0.0.0-20261028111316-d24d079a3755` (`d24d079a3755f0975d37a1b15fc204758a995c18`) | Mozilla Public License 2.0; see the upstream [`LICENSE`](https://github.com/tulir/whatsmeow/blob/d24d079a3755f0975d37a1b15fc204758a995c18/LICENSE) |
| [`github.com/mutecomm/go-sqlcipher/v4`](https://github.com/mutecomm/go-sqlcipher) | `v4.4.2` | MIT for the Go SQLite driver; its upstream [`LICENSE`](https://github.com/mutecomm/go-sqlcipher/blob/v4.4.2/LICENSE) also contains the SQLCipher BSD-style notice, SQLite blessing, and LibTomCrypt public-domain notice |
| [`github.com/zalando/go-keyring`](https://github.com/zalando/go-keyring) | `v0.2.8` | MIT; see upstream [`LICENSE`](https://github.com/zalando/go-keyring/blob/v0.2.8/LICENSE) |
| [`google.golang.org/protobuf`](https://github.com/protocolbuffers/protobuf-go) | `v1.36.12` | BSD 3-Clause; see upstream [`LICENSE`](https://github.com/protocolbuffers/protobuf-go/blob/v1.36.12/LICENSE) |

Indirect dependencies are also pinned in the repository's `sidecar/go.mod` and
`sidecar/go.sum`; their respective upstream license and notice files apply. Preserve those
files and notices when distributing the sidecar binary.
