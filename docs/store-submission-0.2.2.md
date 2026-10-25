# Browpilot 0.2.2 提交记录

时间：2026-10-24 23:14 America/Los_Angeles（2026-10-25 06:14 UTC）。使用用户登录的 main profile（Chromium Default）。

## 提交前状态

后台显示 0.2.1 已审核通过：**Published - public**，公开页面 https://chromewebstore.google.com/detail/kglhakgapoegbnnbobnmnebmbljehcid 可访问。因此没有需要取消的审核，直接上传 0.2.2。

## 本版内容

- 全部改名为 Browpilot：npm 包 `@john523100/browpilot`、命令 `browpilot`、MCP 名称 `browpilot`、配置目录 `~/.browpilot`。旧 `~/.claude-browser` 与扩展旧存储键首次启动时自动迁移。
- broker 在缺少桌面会话环境变量的进程中启动浏览器时补齐 Wayland/X11/DBus 变量，避免浏览器立即退出。
- 配对页在扩展 worker 冷启动时重试发送，避免 “Receiving end does not exist”。
- 扩展权限与 0.2.1 完全相同：debugger、tabs、history、alarms、storage、identity、identity.email；无 host_permissions，无 scripting。

## 验证

- 442 项自动测试通过，typecheck 与构建通过，真实 Chromium 冒烟测试通过。
- 0.2.2 tgz 全新安装后 `browpilot --version` 输出 0.2.2。

## 提交结果

同一扩展 ID：`kglhakgapoegbnnbobnmnebmbljehcid`。Package 页 Draft 显示 0.2.2，权限与已发布的 0.2.1 一致。

审核说明已更新为 0.2.2（改名、自动迁移、可靠性修复、权限未变），测试步骤指向公开仓库 TESTING.md（已同步为 0.2.2）。点击确认后对话框显示 “Your extension was submitted for review”，状态为 **Pending review**，已勾选审核通过后自动发布。审核结果尚未返回。

证据保存在本地 `artifacts/store-submission/chrome-published-0.2.1.png`、`chrome-package-0.2.2.png`、`chrome-pending-review-0.2.2.png`，未公开发布者后台截图。

## 发行包

https://github.com/michael-ltm/browpilot/releases/tag/v0.2.2

| 文件 | 大小（字节） | SHA-256 |
| --- | ---: | --- |
| browpilot-chrome-0.2.2.zip | 47150 | `9e2feb736389d98e706fe6cacbd232dd25f791f1021eb95f786feaaaa332b3e8` |
| browpilot-edge-0.2.2.zip | 47150 | `9e2feb736389d98e706fe6cacbd232dd25f791f1021eb95f786feaaaa332b3e8` |
| john523100-browpilot-0.2.2.tgz | 73875 | `edf76f3ec3c9d96ef23b8c3fc97b2156ce3b8e243ed5930d81b5d535abea410e` |

Edge 包未提交微软商店。没有发布到 npm registry。
