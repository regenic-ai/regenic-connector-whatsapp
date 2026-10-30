import { defineLocaleTables } from "@regenic/connector-contract";

export const whatsappLocaleTables = defineLocaleTables({
  en: {
    "catalog.title": "WhatsApp Web (default path)",
    "catalog.channelLabel": "WhatsApp",
    "catalog.description":
      "Recommended live path: use the browser extension with a WhatsApp Web session you opened yourself. This path is not risk-free and remains subject to WhatsApp policies. User-selected exports are read-only. The separate linked-device bridge is off by default and has additional unofficial-protocol and account-ban risk.",
    "catalog.credentialHint": "Pairing code · created on install",
    "setup.install.title": "Install this connector",
    "setup.install.body":
      "Regenic creates a pairing code. Copy it after install — you will paste it into the extension.",
    "setup.extension.title": "Load the WhatsApp Web extension",
    "setup.extension.body":
      "Chrome or Edge: Extensions → Developer mode → Load unpacked → packages/web-extension-whatsapp/dist. Build the package first if dist is missing.",
    "setup.pair.title": "Paste the pairing code into the extension",
    "setup.pair.body":
      "Open extension Settings. Local API origin stays on 127.0.0.1. Paste the pairing code from Engine. Leave Installation id blank.",
    "setup.sync.title": "Open WhatsApp Web and sync visible chats",
    "setup.sync.body":
      "Sign in yourself, keep the chat list visible, then click Sync visible chats in the extension popup. Inbox replies open the matching chat before drafting or sending.",
    "import.title": "WhatsApp personal export",
    "import.description":
      "Import Purr WA CSV or WhatsApp Personal Export v1 JSONL that you picked yourself. Read-only: no cookies, no sending.",
    "present.label": "WhatsApp Web",
    "present.detail": "Default local browser extension · not risk-free",
  },
  zh: {
    "catalog.title": "WhatsApp Web（默认路径）",
    "catalog.channelLabel": "WhatsApp",
    "catalog.description":
      "推荐的实时路径：使用你自己打开并登录的 WhatsApp Web 浏览器扩展。此路径也并非零风险，仍受 WhatsApp 平台政策约束。用户主动选择的导出导入只读。独立的关联设备桥接默认关闭，且有额外的非官方协议与账号封禁风险。",
    "catalog.credentialHint": "配对码 · 安装时生成",
    "setup.install.title": "安装这个连接器",
    "setup.install.body":
      "安装后会生成配对码。复制它，下一步贴进浏览器扩展。这不是 WhatsApp 密码。",
    "setup.extension.title": "在浏览器里加载扩展",
    "setup.extension.body":
      "Chrome / Edge：打开扩展页 → 开发者模式 → 加载已解压的扩展程序 → 选 packages/web-extension-whatsapp/dist。若没有 dist 目录，先在仓库根目录运行构建命令。",
    "setup.pair.title": "把配对码贴进扩展设置",
    "setup.pair.body":
      "打开扩展设置。本机 API 地址保持 127.0.0.1。把 Engine 里的配对码贴进去。Installation id 留空即可。",
    "setup.sync.title": "打开 WhatsApp Web 并同步可见会话",
    "setup.sync.body":
      "自己登录 WhatsApp Web，保持左侧会话列表可见，再在扩展弹窗里点「同步可见会话」。Inbox 回复会先打开对应聊天，再填草稿或发送。",
    "import.title": "WhatsApp 个人导出",
    "import.description":
      "导入你自己选的 Purr WA CSV，或 WhatsApp Personal Export v1 JSONL。只读，不碰 Cookie，也不会发消息。",
    "present.label": "WhatsApp Web",
    "present.detail": "默认本机浏览器扩展 · 并非零风险",
  },
});

export const whatsappLinkedDeviceLocaleTables = defineLocaleTables({
  en: {
    "linked.catalog.title": "WhatsApp (Linked Device · opt-in)",
    "linked.catalog.channelLabel": "WhatsApp",
    "linked.catalog.description":
      "Optional local linked-device bridge. The existing WhatsApp Web extension and user-selected export import remain the default paths. This unofficial protocol client may violate WhatsApp terms and can result in account restrictions or bans.",
    "linked.catalog.credentialHint": "Explicit risk acknowledgment · system keychain",
    "linked.field.mode": "Linked-device bridge",
    "linked.option.disabled": "Off (default)",
    "linked.option.enabled": "Enable local linked-device bridge",
    "linked.field.riskAck": "Protocol and account risk",
    "linked.option.riskAck": "I understand and accept the linked-device and account-ban risk",
    "linked.field.pairingMethod": "Linking method",
    "linked.option.qr": "QR code",
    "linked.option.phone": "Phone-number pairing code",
    "linked.field.phoneNumber": "WhatsApp phone number",
    "linked.confirm.warning":
      "This starts an unofficial local WhatsApp linked-device client. Reverse-engineered protocol use may violate WhatsApp terms and can lead to account restrictions or bans. This is not the browser-extension path and Regenic cannot guarantee account safety.",
    "linked.confirm.ack": "I explicitly opt in despite the protocol and account-ban risk",
    "linked.setup.optIn.title": "Explicitly enable the optional bridge",
    "linked.setup.optIn.body":
      "The existing WhatsApp Web extension is the default live path, and user-selected exports are read-only. Neither path is risk-free. The linked-device bridge stays off until you opt in and confirm its additional protocol and account risk.",
    "linked.setup.pair.title": "Link this local device",
    "linked.setup.pair.body":
      "Pairing QR data or a phone pairing code is revealed only through the local Engine pairing view. Treat it like a login credential. Disconnect preserves the linked device; Logout explicitly revokes it and removes the local device session.",
    "linked.setup.chats.title": "Choose conversations",
    "linked.setup.chats.body":
      "No message content is retained until you explicitly select conversations. Only text messages and quoted replies are supported. WhatsApp history sync processes batches WhatsApp actually delivers; it does not promise complete backfill.",
    "linked.present.label": "WhatsApp (Linked Device)",
    "linked.present.detail": "Optional local bridge · explicit risk opt-in",
    "linked.present.revoked": "WhatsApp revoked or replaced this session; re-linking requires an explicit action",
  },
  zh: {
    "linked.catalog.title": "WhatsApp（关联设备 · 自选启用）",
    "linked.catalog.channelLabel": "WhatsApp",
    "linked.catalog.description":
      "可选的本地关联设备桥接器。现有 WhatsApp Web 扩展和用户主动选择的导入仍是默认路径。这个非官方协议客户端可能违反 WhatsApp 条款，并导致账号受限或封禁。",
    "linked.catalog.credentialHint": "明确确认风险 · 系统钥匙串",
    "linked.field.mode": "关联设备桥接",
    "linked.option.disabled": "关闭（默认）",
    "linked.option.enabled": "启用本地关联设备桥接",
    "linked.field.riskAck": "协议与账号风险",
    "linked.option.riskAck": "我理解并接受关联设备协议及账号封禁风险",
    "linked.field.pairingMethod": "关联方式",
    "linked.option.qr": "二维码",
    "linked.option.phone": "手机号配对码",
    "linked.field.phoneNumber": "WhatsApp 手机号",
    "linked.confirm.warning":
      "此操作会启动非官方的本地 WhatsApp 关联设备客户端。使用逆向协议可能违反 WhatsApp 条款，并导致账号受限或封禁。这不是浏览器扩展路径；Regenic 无法保证账号安全。",
    "linked.confirm.ack": "我明确选择启用，并接受协议及账号封禁风险",
    "linked.setup.optIn.title": "明确选择启用可选桥接",
    "linked.setup.optIn.body":
      "现有 WhatsApp Web 扩展是默认实时路径，用户主动选择的导出导入是只读路径。两者都不代表零风险。关联设备桥接默认关闭，只有你主动选择并确认额外协议与账号风险后才会启动。",
    "linked.setup.pair.title": "关联这台本地设备",
    "linked.setup.pair.body":
      "二维码数据或手机号配对码仅通过本机 Engine 配对界面展示。请像登录凭据一样保护它。断开连接会保留设备；显式 Logout 才会撤销关联并删除本机设备会话。",
    "linked.setup.chats.title": "选择要同步的会话",
    "linked.setup.chats.body":
      "你明确选择会话前，不会保留消息内容。首版只支持文本消息和引用回复。历史同步只处理 WhatsApp 实际送达的批次，不承诺完整回填。",
    "linked.present.label": "WhatsApp（关联设备）",
    "linked.present.detail": "可选本地桥接 · 需明确确认风险",
    "linked.present.revoked": "WhatsApp 已撤销或替换此会话；重新关联需要明确操作",
  },
});
