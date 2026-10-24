# Browpilot 0.2.0 商店提交记录

提交时间：2026-09-14 23:53 左右（America/Los_Angeles），即 2026-09-15 06:53 UTC。使用用户已登录并明确授权的 `main` 浏览器 profile。

## Chrome Web Store

- 名称：Browpilot — Browser MCP for AI Agents
- 版本：0.2.0
- 扩展 ID：`kglhakgapoegbnnbobnmnebmbljehcid`
- 后台实测状态：**Pending review**；状态页明确显示 “This draft is pending review.”
- 审核通过后自动公开发布：已勾选并提交。
- 分发：Public、Free of charge、All regions。
- 图标、1280×800 实际界面截图、440×280 宣传图、英文说明、Developer Tools 分类、主页、支持链接、隐私声明与审核测试说明均已保存。
- Google 提示广泛站点权限可能需要深入审核；这不是拒绝通知，也不能据此保证完成日期。
- 尚未审核通过，因此当前不声称商店已公开可安装。

[开发者后台状态](https://chrome.google.com/webstore/devconsole/7b3b7aff-db79-46c5-bc78-dff52a469130/kglhakgapoegbnnbobnmnebmbljehcid/edit/status)

审核通过后的预期链接：https://chromewebstore.google.com/detail/kglhakgapoegbnnbobnmnebmbljehcid

本地截图证据：`artifacts/store-submission/chrome-pending-review-0.2.0.png` 与 `artifacts/store-submission/chrome-status-0.2.0.png`。这些包含发布者后台信息的图片没有发布到公共仓库。

## 公开发行

[GitHub Release v0.2.0](https://github.com/michael-ltm/browpilot/releases/tag/v0.2.0) 已公开发布，API 确认 `draft: false`。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| browpilot-chrome-0.2.0.zip | 45905 | `9720af0de7362f7c0065c591eb56e1c434ce0ed1e4b415336c949cab8b769225` |
| browpilot-edge-0.2.0.zip | 45905 | `9720af0de7362f7c0065c591eb56e1c434ce0ed1e4b415336c949cab8b769225` |
| john523100-claude-browser-0.2.0.tgz | 64220 | `f39e24ae86c6e947140a5263906619535a7273abefd8deeed57e74e8e88f5aa3` |

本地 `sha256sum` 与 GitHub Release API 的每个资产 `digest` 一致。Chrome 上传包与本地 Chrome ZIP 一致。两个浏览器 ZIP 为相同扩展内容；伴随程序已内置实际 Chrome 商店 ID 和 URL，额外添加 4 项回归检查后，本次完整测试为 51 个文件、337 项通过，typecheck 与伴随程序构建通过。

公开仓库仅用于本次发行资料及安装包。原始 `michael-ltm/claude-browser` 仓库保持 PRIVATE；`michael-ltm/browpilot` 为 PUBLIC，已分别查询确认。未向 npm registry 发布。

- [公开安装文档](https://github.com/michael-ltm/browpilot)
- [隐私政策](https://github.com/michael-ltm/browpilot/blob/main/privacy.md)
- [审核测试说明](https://github.com/michael-ltm/browpilot/blob/main/TESTING.md)

## Edge 与其他验证边界

Microsoft Partner Center 在 `main` profile 打开后显示 Microsoft 登录页，尚未登录或提交 Edge 商店。Edge ZIP 已发布，可在具备开发者账户后继续提交。仍需实际 Edge、Windows/macOS、商店安装版本及 Grok 云端连接的端到端验证；本次提交不代表这些验证已经完成。
