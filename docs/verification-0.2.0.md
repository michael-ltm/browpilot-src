# Browpilot 0.2.0 验证记录

以下是 9 月 12 日的历史构建记录；9 月 14 日（美国西岸）提交的安装包、最新校验值与审核状态见 [商店提交记录](store-submission-0.2.0.md)。

验证日期：2026-09-12（美国西岸）。环境：Arch Linux，Node.js 24.20.0，Chromium 151.0.7922.173。

## 已验证

- `npm test`：51 个测试文件，333 项通过。包括本地实例、配对、并发启动、MCP 路由、HTTP 鉴权和会话隔离、重连、CDP 生命周期及原有工具。
- `npm run typecheck`：shared、broker、MCP、extension 全部通过。
- `npm run build`、`npm run build:package`、`npm run build:store`：全部通过。
- 打包后的 CLI 正确输出 `Browpilot 0.2.0`，生成 Codex TOML 和 Claude Code JSON 配置。
- 本机默认目录扫描找到 Chrome 和 Chromium。Chrome 扩展证据为 `unknown`，Chromium 为 `installed`；未将离线或证据不足误报为未安装。

## 真实浏览器链路

运行 `node --import tsx scripts/smoke-browser.ts`。可用 `BROWPILOT_TEST_BROWSER` 指定兼容的 Chromium 可执行文件；需要允许本地监听和启动浏览器。

脚本使用临时配置、临时扩展副本和随机 broker 端口，不复用日常浏览器实例：

1. 真正加载扩展并连接 WebSocket broker。
2. 直接 CDP 找到本扩展 Worker、获取上下文并执行表达式。
3. 加载第二个独立测试扩展，进入其 Worker 上下文并读取测试值 `42`。
4. 关闭浏览器后，从磁盘识别扩展安装证据。
5. 通过 MCP `browser_open_instance` 冷启动指定实例，完成一次性 nonce 配对。
6. 通过 MCP 新建、列出标签页，等待页面加载后验证标题。
7. 再次关闭浏览器，调用 `browser_get_tabs` 自动重开已选择的实例。
8. 重新加载本地目录数据，确认实例与运行时身份绑定已持久化。

以上全部通过。MCP 客户端与服务端使用 SDK 的内存传输；broker WebSocket、浏览器进程、扩展和 CDP 均为真实组件。这不是 Codex、Claude Code 或 Grok 产品端到端实测。

## 交付物

- `dist-pkg/`：可运行的本地伴随程序与保留开发 ID 的扩展。
- `artifacts/john523100-claude-browser-0.2.0.tgz`：伴随程序 npm 安装包，保留旧包名并提供 `browpilot` 命令。
- `artifacts/browpilot-chrome-0.2.0.zip`
- `artifacts/browpilot-edge-0.2.0.zip`

两个商店 ZIP 使用同一 Chromium 扩展内容，分别命名以便提交。各包含 12 个文件；已验证 ZIP CRC、根 manifest、版本及所有引用资源，并确认移除开发 key、source map 和私钥文件。

两个 ZIP 的 SHA-256 均为：

```text
a5ab13af6a9e48253fab465b4475cdebcf0f6cb49792f579c935f37ceac5238f
```

## 尚需外部验证或发布资料

- Windows/macOS、实际 Edge、商店安装版本尚未进行真实浏览器测试；路径与协议 fixture 测试不能代替这些测试。
- Codex/Claude Code 注册命令及配置已验证生成，未修改本机客户端配置。Grok 的公网 HTTPS、账号连接和真实模型调用尚未验证。
- 扩展安装需要在浏览器中确认；当前操作打开配置的商店链接，未配置时打开扩展设置页。
- 商品名可用性、发布者账号、真实商店 ID、公开隐私政策 URL、截图和商店审核仍需完成；没有向 npm 或浏览器商店发布。

上架文案与权限用途见 [store-listing.md](store-listing.md)，隐私政策见 [privacy.md](privacy.md)。
