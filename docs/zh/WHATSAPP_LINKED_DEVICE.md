# WhatsApp 关联设备（本地、明确选择启用）

- **默认推荐：** `whatsapp-web-live` 浏览器扩展
- **可选驱动：** `whatsapp-linked-device`
- **状态：** 本地 MVP；未使用真实账号测试
- **相关：** [WhatsApp Web Live](WHATSAPP_WEB_LIVE_CONNECTOR.md) · [个人导出与导入](WHATSAPP_PERSONAL.md)

## 风险与授权

浏览器扩展仍是默认实时路径，用户主动选择的导出导入仍是只读路径。两者都不保证账号
安全，也都可能受 WhatsApp 平台政策影响。关联设备驱动是独立的非官方客户端，使用
WhatsApp 逆向实现的关联设备协议；这可能违反 WhatsApp 条款，并导致账号受限或封禁。
Regenic 无法保证账号安全。

关联设备安装卡默认是**关闭**状态。查看目录、探测、读取安装元数据都不会启动、配对、
枚举会话或采集消息。启用时必须选择关联设备并确认协议及账号风险，Engine 还会显示
二次安装确认。只有用户在本机 Engine 配对界面完成后续操作，账号才会关联。二维码和
手机号配对码按登录凭据保护，不写入日志、连接器消息或 telemetry。

## 本地服务与平台构建

Node 驱动为每个明确启用的安装管理一个 Go sidecar 进程，只通过版本化 stdin/stdout
IPC 通信；sidecar 不监听网络端口，也不会在运行时下载二进制文件。禁用、删除、重新
配置、clear、shutdown 或父进程退出时会停止本地进程。停止**不会**注销 WhatsApp
设备，也不会擦除会话。

为当前机器构建 sidecar：

```sh
pnpm --filter @regenic/whatsapp-personal build:sidecar
```

构建需要 `sidecar/go.mod` 声明的 Go toolchain 和 CGO。支持的包名为
`darwin-arm64`、`darwin-x64`、`linux-arm64`、`linux-x64`、`win32-arm64` 和
`win32-x64`。交叉构建 SQLCipher 需要通过 `CC` 指定目标平台 C 编译器；仅有其他
平台的编译器并不够。缺少 sidecar 或不可执行时会明确报错，不会静默下载。当前验证
环境是 macOS arm64；其他平台只是构建目标，不代表已验证其运行。
打包时的 `prepack` 生命周期会先构建本机二进制。交叉打包需设置
`REGENIC_WHATSAPP_SIDECAR_PLATFORM` 和 `REGENIC_WHATSAPP_SIDECAR_ARCH`（例如
`linux` 与 `x64`），并配置匹配的 `CC`。

加密数据库保存在当前用户的 Regenic 本地应用数据目录下（也可用
`REGENIC_WHATSAPP_DATA_DIR` 指定）。SQLCipher 加密设备会话及已选会话的消息数据库，
包括 WAL；密钥只保存在操作系统钥匙串。数据目录和数据库限制为当前用户访问。钥匙串
不可用或数据库无法解锁时会明确失败，不使用环境变量或明文回退。

## 配对、断开与撤销

可通过本机 Engine 的二维码界面配对，或在安装卡选择手机号配对并填写号码。用户必须
在 WhatsApp 中确认新关联设备。连接器不会替用户扫描二维码。

| 操作 | 效果 |
| --- | --- |
| 禁用/停止安装 | 停止本地采集和 sidecar；保留远端关联设备和本机加密状态 |
| `disconnectWhatsAppLinkedDevice(installationId)` | 断开连接并保留本机设备会话，以便稍后重新连接 |
| `logoutWhatsAppLinkedDevice(installationId)` | 请求远端注销关联、删除本机 WhatsApp 设备会话并停止 sidecar；不会删除加密消息缓存或其数据库密钥 |
| 手机/WhatsApp 撤销或替换设备 | 显示外部撤销/替换状态，不会静默重新认证 |
| `relinkRevokedWhatsAppDevice(installationId)` | 明确清除已撤销的本机会话并启动新配对流程；不会假称配对已经成功 |

这三个 package helper 已导出，供本机宿主集成使用，并要求已启用的 sidecar 正在运行；
它们不是远程 API。WhatsApp 已撤销设备后，必须显式调用重新关联 helper 并由用户再次
确认配对。

## 会话与消息范围

桥接器不会自动选择全部会话。宿主明确选择的会话会被持久化为允许列表；未选会话的
消息内容不会写入本地 inbox。未选会话也不能通过连接器发送。

历史同步只处理 WhatsApp 实际送达的批次，不承诺完整回填。历史批次送达时尚未选择的
会话消息会丢弃，之后再选择不保证能重新收到这些消息。

MVP 映射稳定 WhatsApp JID 与消息 ID、方向、发送者、文本、时间戳和引用消息。WhatsApp
引用不会伪装成 Slack thread。仅实现文本和文本引用回复；媒体、reaction、编辑、删除
及建群尚未实现。

外发消息会先持久化预留，再发起网络发送。如果发送结果不确定，outbox 会记录为
`unknown` 且不会自动重试。这可避免静默重复发送，但不保证 exactly-once。

## 验证与第三方代码

测试使用本地 fixture 和假的 sidecar 进程。开发验证没有使用真实 WhatsApp 账号或凭据，
没有扫码、读取或发送消息。Sidecar 将 `go.mau.fi/whatsmeow` 固定到
`sidecar/go.mod` 中的 canonical upstream revision；没有复制 AGPL 许可的 mautrix
bridge 代码。重新分发 sidecar 前请阅读
[`THIRD_PARTY_NOTICES.md`](../../packages/whatsapp-personal/THIRD_PARTY_NOTICES.md)。
