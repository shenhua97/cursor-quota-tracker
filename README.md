# Cursor Quota Tracker

[English](./README.en.md) | 中文

在 Cursor 编辑器状态栏实时监控 AI 用量配额，零配置即可使用。

## 功能特性

- **零配置认证** — 自动从 Cursor 本地数据库提取认证 Token，无需手动粘贴 Cookie
- **状态栏实时展示** — 右下角显示已用/总量（如 `⚡ 91/500`），配额耗尽自动切为按量计费余额（如 `⚠ $50/$120`）
- **富文本悬浮卡片** — 鼠标悬停显示进度条、剩余量、重置倒计时、今日请求、按量计费余额等完整信息
- **用量趋势分析** — 记录每日用量，Spark Line 展示近 7 天趋势，预测"按当前速度可用 X 天"
- **即时预测** — 首次安装即可预测，利用计费周期已过天数计算日均值，无需等待数据积累
- **智能预警** — 可配置阈值（默认 80%），触发背景色闪烁 + 弹窗提醒，同一周期仅提醒一次
- **MAX 模式监测** — 实时检测 MAX 模式、Thinking 模式等高消耗状态，状态栏醒目提示
- **手动刷新** — 点击状态栏弹出快捷菜单，或使用命令面板手动刷新（30 秒冷却保护）
- **离线处理** — 网络不可用时自动暂停轮询、显示离线图标，恢复后自动重试
- **插件内设置面板** — 点击设置弹出交互式 QuickPick 面板，布尔值一键切换，无需跳转 Settings UI
- **中英双语** — 支持中文/英文界面，设置中一键切换
- **跨平台** — 支持 Windows / macOS / Linux

## 安装

下载 `.vsix` 文件后执行：

```bash
cursor --install-extension cursor-quota-tracker-0.1.0.vsix
```

或在 Cursor 中：扩展面板 → `...` → 从 VSIX 安装。

## 使用

安装后自动激活，无需任何配置。插件会自动从 Cursor 本地数据库检测你的认证信息。

如果自动检测失败，状态栏会显示"需要配置 Token"，点击后通过命令面板手动输入：

1. 浏览器打开 [cursor.com](https://cursor.com) 并登录
2. DevTools → Application → Cookies → `cursor.com`
3. 复制 `WorkosCursorSessionToken` 的值
4. 在 Cursor 中执行命令 `Cursor Quota: 手动输入 Token`

## 配置项

点击状态栏 → 设置，即可在插件内交互式修改以下配置：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `cursorQuota.autoDetectToken` | `true` | 自动检测 Token |
| `cursorQuota.refreshInterval` | `300` | 自动刷新间隔（秒），最小 60 |
| `cursorQuota.language` | `"zh"` | 界面语言：`zh` 中文 / `en` English |
| `cursorQuota.statusBarAlignment` | `"right"` | 状态栏位置：`left` 左侧 / `right` 右侧 |
| `cursorQuota.statusBarPriority` | `100` | 状态栏排列优先级，数值越大越靠边 |
| `cursorQuota.warningThreshold` | `80` | 用量预警阈值 (0-100%) |
| `cursorQuota.enableBlinkAlert` | `true` | 低余量时背景色闪烁 |
| `cursorQuota.enablePopupAlert` | `true` | 低余量时弹窗提醒 |

## 命令

| 命令 | 说明 |
|------|------|
| `Cursor Quota: 立即刷新` | 手动刷新用量数据 |
| `Cursor Quota: 打开用量面板` | 打开 Cursor 用量 Dashboard |
| `Cursor Quota: 打开设置` | 打开插件内交互式设置面板 |
| `Cursor Quota: 周用量报告` | 查看近 7 天用量明细 |
| `Cursor Quota: 手动输入 Token` | 手动设置认证 Token |
| `Cursor Quota: 清除 Token` | 清除已存储的 Token |

## 状态栏说明

| 状态 | 显示 | 说明 |
|------|------|------|
| 正常 | `⚡ 91/500` | 已用/总量 |
| MAX 模式 | `🔥 91/500 MAX` | 高消耗模式提醒 |
| 按量计费 | `⚠ $50/$120` | 套餐用完，显示按量计费余额 |
| 离线 | `☁ 91/500` | 网络不可用，显示缓存数据 |
| 需配置 | `🔑 需要配置 Token` | 点击后引导手动输入 |

## 技术架构

- **认证**: 自动从 `state.vscdb` 提取 accessToken，解析 JWT payload 获取 userId 拼装 Cookie，SecretStorage 加密缓存，JWT 过期检测 + 指数退避重试
- **数据源**: `cursor.com/api/usage` + `/api/usage-summary`
- **DB 读取**: sql.js WASM 读取 SQLite，缓存实例 + mtime 检查避免重复加载；macOS/Linux 优先 sqlite3 CLI（WAL 兼容）
- **预测**: 优先使用逐日快照差值；快照不足时回退到 `已用量 / 计费周期已过天数`
- **网络**: 15 秒 AbortController 超时，离线自动暂停 + 窗口聚焦恢复
- **构建**: TypeScript + esbuild

## 开发

```bash
npm install     # 安装依赖
npm run build   # 构建
npm run watch   # 监听模式
npm run lint    # TypeScript 类型检查
npm run package # 打包 .vsix
```

## License

MIT
