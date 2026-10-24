# Browpilot 0.2.1 重新提交记录

时间：2026-09-23 23:27 America/Los_Angeles（2026-09-24 06:27 UTC）。使用用户授权的 main profile。

## 拒绝原因与修复

0.2.0 于 9 月 16 日被拒绝：Use of Permissions / Purple Potassium。后台明确指出申请但未使用 `scripting` 权限。

0.2.1 删除了 `scripting` 和全部 host_permissions；其余权限已按实际 API 调用核查。无全站点权限的真实冷启动测试还暴露了配对页恢复问题：原 tabs.reload 会保留阻止页面，改为仅对本扩展带合法 nonce 的 URL 使用 tabs.update 后恢复正常。完整权限审计见 [permissions-audit-0.2.1.md](permissions-audit-0.2.1.md)。

## 验证

- 完整测试：51 个测试文件，337 项通过。
- typecheck、伴随程序构建、商店 ZIP 构建通过。
- 连续两次真实 Chromium 测试通过：扩展握手、独立扩展 worker 调试、冷启动与 nonce 配对、标签页、页面快照、截图、自动重启与持久化绑定。
- ZIP CRC、实际 manifest 与版本已检查；scripting 和 host_permissions 均不在 ZIP 或伴随程序捆绑扩展中。
- GitHub Release API digest 与本地 SHA-256 一致。

## 提交结果

同一扩展 ID：`kglhakgapoegbnnbobnmnebmbljehcid`。Package 页明确显示 0.2.1，权限为 debugger、tabs、history、alarms、storage、identity、identity.email。

已保存审核说明，明确回应 Purple Potassium，并提供新版配套程序测试步骤。点击最终确认后后台显示 **Pending review**，对话框确认 extension was submitted for review。审核通过后自动发布已勾选。尚未获得商店批准。

证据保存在本地 `artifacts/store-submission/chrome-rejection-0.2.0.png`、`chrome-package-0.2.1.png`、`chrome-pending-review-0.2.1.png`、`chrome-status-0.2.1.png`，没有把发布者后台截图公开。

## 发行包

https://github.com/michael-ltm/browpilot/releases/tag/v0.2.1

| 文件 | 大小（字节） | SHA-256 |
| --- | ---: | --- |
| browpilot-chrome-0.2.1.zip | 45860 | `2bdfe8407e1e9696985bd475b1410ea16d921e943d493e1a5172293cb47285d8` |
| browpilot-edge-0.2.1.zip | 45860 | `2bdfe8407e1e9696985bd475b1410ea16d921e943d493e1a5172293cb47285d8` |
| john523100-claude-browser-0.2.1.tgz | 64395 | `8cf94a3855b1ee775b8b6e9652fa3f73f73aef1135eee45b040659ed62dd0152` |

Edge 包已更新，尚未提交微软商店。没有发布到 npm registry。Windows/macOS、实际 Edge 和 Grok 云端端到端验证范围未扩大。
