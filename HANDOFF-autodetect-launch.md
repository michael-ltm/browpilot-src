# HANDOFF — 浏览器自动探测 / 检测扩展是否已装 / 受控启动（保住登录态）

> 给下一个会话/接手人。目标：让 claude-browser 不再需要手动 Load/Reload 扩展、手动开浏览器。
> 作者：上个会话（在 `/workspace/code/my/asset` 项目里用 claude-browser 做了大量手工操作后，用户提的需求）。
> 最后更新：2026-09-06（第二个会话：§1–§7 已实现，§5 风险已实测，结论见下）。

---

## ✅ 本轮完成了什么（2026-09-06）

| 计划项（原 §7） | 状态 |
|---|---|
| 1. `detectBrowsers()` + 单测 | ✅ `packages/launcher/src/detect.ts` |
| 2. `readProfiles()` / `isExtensionInstalled()` + 单测 | ✅ `profiles.ts` / `extension-state.ts` |
| 3. `browser_detect` MCP 工具 | ✅ `packages/mcp-server/src/tools/detect.ts` |
| 4. 手测 §5 `--load-extension` 风险 | ✅ **已实测，结论见下（原方案不成立，已换路线）** |
| 5. `install.ts` 串起 detect-first | ✅ `scripts/lib/detect-summary.ts` + `scripts/install.ts` |

新增包 `@claude-browser/launcher`（探测/判断/启动，全部注入 os/fs/exec，跨平台纯逻辑可单测）。
新增 MCP 工具 **`browser_detect`**（只读）和 **`browser_install_extension`**（受控加载）。
测试：仓库 229 → **345 passing**。

## 🔴 §5 风险实测结论（原计划的核心假设**不成立**）

在 **Chrome 151** 上实测（详细证据与全部命令见 `docs/extension-install.md`）：

- **`--load-extension` 已彻底失效**（Chrome/Edge **137** 起移除）。有头、无头都不加载；
  加上旧的逃生开关 `--disable-features=DisableLoadExtensionCommandLineSwitch` 依然无效。
- **`--remote-debugging-port` 对「默认用户数据目录」被拒绝**（Chrome **136** 起）：
  `DevTools remote debugging requires a non-default data directory.`
  → 大多数用户（用默认 profile 目录）**没有任何自动安装路径**。
- ✅ **CDP `Extensions.loadUnpacked` 可用**（需 `--remote-debugging-port` +
  `--enable-unsafe-extension-debugging`），已端到端验证：重启 → 加载 → 扩展连上 broker。
  **但它是一次性的**：浏览器退出后记录从 `Preferences` 里消失，下次还得再加载。
- ❌ 命令行 `chrome chrome://extensions` 打不开扩展页（Chrome 会开成新标签页），
  所以没法「帮用户把页面点开」。

**于是「安装」的最终形态**：

| 情况 | 行为 |
|---|---|
| 已装且启用 | 什么都不做（detect-first 原样保留） |
| 已装但停用 | 提示去扩展页打开 |
| 未装 + 默认用户数据目录 | 只能给出手动三步（开发者模式 → 加载已解压的扩展程序 → dist 路径）；**这一步做一次就永久有效** |
| 未装 + 自定义用户数据目录 / 老版本浏览器 | 可自动：关闭 → 带调试参数重开**真实 profile**（登录态保留）→ CDP 加载 |

## 1. 用户已拍板的决策（都已遵守）

- **保住登录态**：受控重启用真实用户数据目录 + `--profile-directory`，不是干净 profile。
  且刻意不加 `--disable-extensions-except`（会关掉用户其它扩展）。
- **允许重启浏览器**：实现了，但**必须调用方显式传 `allowRestart: true`**，默认不动用户浏览器。
- **探测优先（detect-first）**：已装 → 直接返回，不启动、不加载。
- 目标浏览器：Chrome / Edge / Brave / Chromium 四家的路径表都写了（mac / win / linux）。
- **硬约束**：没有去绕浏览器的安全策略（不伪造 `Preferences` 安装记录）。

## 2. 现在的代码地图

```
packages/launcher/src/
  types.ts           BrowserInstall / BrowserProfile / ExtensionStatus / ManifestLocation
  env.ts             HostEnv：platform + home + vars + fs + exec（全部注入，便于单测）
  pathutil.ts        joinPath(platform, ...) —— 按目标平台而非宿主平台拼路径
  detect.ts          detectBrowsers()：mac/win/linux 候选表、PATH 解析、版本读取
  profiles.ts        readProfiles()：Local State 的 profile.info_cache，退化到扫目录
  extension-state.ts readExtensionStatus()：Secure Preferences → Preferences，三态
  running.ts         listRunningBrowsers()：ps / wmic 解析出正在跑的浏览器 + 其 --user-data-dir
  report.ts          detectAll() / verdictFor()：把上面全部合成 detect-first 判决
  launch.ts          buildLaunchFlags() / manualInstallSteps()（纯函数）
  relaunch.ts        quitProcesses() / waitForDevTools() / loadUnpackedOverCdp()（副作用，注入 ProcessControl）
  install-flow.ts    installExtension()：编排上面这一串
packages/mcp-server/src/tools/detect.ts   browser_detect / browser_install_extension
scripts/lib/detect-summary.ts             安装脚本里的 detect-first 摘要
docs/extension-install.md                 ⭐ 实测证据 + 决策树，改这块之前先读
```

## 3. 关键锚点（仍然有效）

| 事项 | 值 / 来源 |
|---|---|
| **连接器扩展 ID（固定）** | `ocjnpcjkgdfgglcljkaaokfplcfpnmlj` |
| ID 从哪来 | manifest 的固定 `key` → `scripts/lib/extension-id.ts`。运行时用 `readPinnedExtensionId(extensionDist)`；MCP 侧直接用 config 里的 `extensionId`（已通过 `ToolContext.extensionId` 注入）。 |
| 扩展 dist | 开发：`packages/extension/dist`；终端用户包：`resolveExtensionDir()`（已通过 `ToolContext.extensionDir` 注入）。 |
| Broker 配置 | `~/.claude-browser/config.json` = `{ port, token, extensionId }` |
| Profile 连接状态 | `packages/broker/src/profiles.ts` 的 `ProfileRegistry` |

## 4. 用法

```
# Claude Code 会话里：
browser_detect                                  # 只读：列浏览器 + 每个 profile 的扩展状态
browser_install_extension index=1 allowRestart=true   # 未装时受控加载（会先问用户）

# 命令行：
npm run install:browser                         # 装完 MCP 后自动跑一遍 detect-first 摘要
```

## 5. 下一步（如果要继续做）

1. **上架 Chrome 应用商店**——这是唯一能让「默认 profile 用户」也自动安装的正解。
   上架后 `verdictFor()` 里的 `manual-only` 分支可以改成引导商店安装。
2. **Windows 注册表探测**：现在只做了三个安装根目录（Program Files / (x86) / LocalAppData）
   的路径探测，覆盖绝大多数情况；`HKLM\...\App Paths\chrome.exe` 的兜底还没接。
3. **Edge / Brave 的版本闸门**：目前把 136/137 两条线按 Chromium 主版本号一视同仁地用。
   Edge 跟 Chromium 主线同步，理论上一致，但**没有在真机 Edge 上验证过**。
4. **Windows 真机验证**：Windows 分支（`Program Files` / `LOCALAPPDATA` 路径表、
   `Application\<版本号>` 目录读版本、`wmic` 进程解析）目前**只有注入平台的单测**，
   没有真机跑过——手头没有 Windows 主机。mac / Linux 已真机验证（见 §6）。

## 6. 验收标准（对照结果）

- ✅ `browser_detect` 正确列出浏览器、版本、每个 profile 的扩展状态。
  实测本机：正确识别出 `chrome-profile-3` 的 `Profile 1` / `Profile 3` 已加载扩展，其余未装。
- ✅ detect-first：已装时不重启、不加载。
- ⚠️ 受控启动：**只在自定义用户数据目录下成立**（已端到端验证：关闭 → 重启 → CDP 加载 →
  扩展连上 broker，登录态保留）。默认目录下浏览器不允许，退回手动一步——**这是浏览器的限制，不是没做**。

### 真机验证记录

| 平台 | 机器 | 结果 |
|---|---|---|
| **Linux** | 本机，Chrome 151 | ✅ 检测 + 受控启动 + CDP 加载 + 扩展连上 broker，全通 |
| **macOS 15.5** | `macbookair`，Chrome 152 / Brave 151 | ✅ 检测：正确找到 `.app` bundle 路径、6 个 Chrome profile（含中文名「启明」）、4 个已装 2 个未装；**存在 `~/Library/Application Support/Microsoft Edge` 目录但没装 Edge.app → 正确地没把 Edge 报出来**；正在跑的 Chrome（无 `--user-data-dir`）正确归到默认目录。<br>✅ 受控启动：临时 profile + 假扩展，Chrome 152 上 `Extensions.loadUnpacked` 成功返回 id。 |
| **Windows** | —— | ❌ **没跑过**：sshm 里 8 台机器全是 linux/macOS，没有 Windows 主机（`msg-linux` 用户名虽是 administrator，实为 Ubuntu）。 |

> macOS 上「默认用户数据目录不许远程调试」这条闸门**没有在 mac 上实测**（要动用户真实
> profile，代价太大）——它是 Chromium 主线行为，Linux 上实测过，mac 同版本代码库理应一致。
