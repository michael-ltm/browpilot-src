# 扩展怎么装进浏览器（实测结论）

> 测试环境：Linux + **Google Chrome 151.0.7922.169**，2026-09-06。
> 结论决定了 `packages/launcher` 的设计，代码注释里引用的就是这份文档。

## 一句话

**现代 Chrome 已经堵死了「把未上架扩展静默装进日常浏览器」的所有命令行路径。**
所以 claude-browser 的策略是 **detect-first**：先看装没装，装了就什么都不做；
没装时能自动的就自动（只在少数情况下可行），不能自动的就给出唯一那一步手动操作。

## 实测：三条路各自的结果

| 路径 | 结果 | 证据 |
|---|---|---|
| `--load-extension=<dir>` | ❌ **无效** | Chrome 151 启动后扩展既不在 `chrome://extensions`，也不在 `Preferences` 的 `extensions.settings` 里。headless 和有头都一样。 |
| `--load-extension` + `--disable-features=DisableLoadExtensionCommandLineSwitch`（旧的逃生开关） | ❌ **无效** | 该 feature 本身已被移除，开关不再有任何作用。 |
| `--load-extension` + `--enable-unsafe-extension-debugging` | ❌ **无效** | 同上，扩展未加载。 |
| CDP `Extensions.loadUnpacked` | ✅ **可用**，但**只活一个会话** | 需要 `--remote-debugging-port` + `--enable-unsafe-extension-debugging`。返回 `{"id":"ocjnpcjkgdfgglcljkaaokfplcfpnmlj"}`，service worker 起来并连上 broker。 |
| `chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」 | ✅ **可用且持久** | 记录写进 profile 的 `Preferences`，重启后仍在。 |

### 两道版本闸门

- **Chrome/Edge 137**：移除 `--load-extension`。低于 137 的版本仍然能用，所以
  `buildLaunchFlags()` 只在 `loadExtensionFlagSupported(version)` 为真时才带这个 flag。
- **Chrome/Edge 136**：**默认用户数据目录**不再允许远程调试。原文报错：

  ```
  DevTools remote debugging requires a non-default data directory.
  Specify this using --user-data-dir.
  ```

  这条最关键：绝大多数人用的就是默认目录（`~/.config/google-chrome`、
  `%LOCALAPPDATA%\Google\Chrome\User Data`、`~/Library/Application Support/Google/Chrome`），
  所以对他们来说 **CDP 这条路也走不通** → 只能手动加载一次。

### 另外两个实测细节

- `google-chrome chrome://extensions` 从命令行打开扩展页 **不生效**（Chrome 会开新标签页），
  所以我们没法「帮用户把页面点开」，只能把 URL 写在提示里。
- CDP 加载的扩展在 `Preferences` 里登记为 `location: 4`（UNPACKED），
  和手动 Load unpacked 一样，但**浏览器退出时这条记录会被删掉**。
  这就是 `InstallOutcome` 里 `ephemeral: true` 的含义。

## 怎么判断「装没装」

按**固定扩展 ID** 在 profile 的偏好文件里查，这是唯一能同时覆盖商店安装 / 手动
Load unpacked / CDP 加载三种来源的判据（ID 由 manifest 的 `key` 固定）。

- 文件：先看 `Secure Preferences`（商店安装走这里，带 MAC 保护），再看 `Preferences`
  （**unpacked 走这里** —— 实测 Chrome 151 上 `Secure Preferences` 里一个扩展都没有）。
- JSON 路径：`extensions.settings["ocjnpcjkgdfgglcljkaaokfplcfpnmlj"]`。
- 启用与否，按这个顺序判断（`isRecordEnabled()`）：
  1. 有 `state`（老版本，M127 之前）：`1` = 启用，其它 = 停用。
  2. 有 `disable_reasons`：空数组 / `0` = 启用，非空 = 停用。
  3. **两个都没有 = 启用**。Chrome 151 给刚加载的 unpacked 扩展写的就是这种记录：
     ```json
     { "location": 4, "path": "/…/extension-dist", "from_webstore": false }
     ```
     如果这里默认判成「停用」，detect-first 会对已经装好的浏览器反复要求重装。
- profile 列表来自 `<userDataDir>/Local State` 的 `profile.info_cache`（顺带拿到用户看到的
  profile 名字），读不到就退化成扫目录找 `Default` / `Profile N`。

## 于是代码里的决策树

`verdictFor()` 的三个出口：

| 情况 | verdict | 行为 |
|---|---|---|
| 任一 profile 里已启用 | `already-installed` | **什么都不做**。不启动、不重启、不加载。 |
| 装了但被停用 | `manual-only` | 让用户去扩展页打开。命令行无法强制启用他人的扩展。 |
| 没装 + 默认用户数据目录 + 版本 ≥ 136 | `manual-only` | 给出「开发者模式 → 加载已解压的扩展程序 → `<dist 路径>`」三步。 |
| 没装 + 自定义用户数据目录（或老版本） | `cdp-load` | 关掉浏览器 → 带 `--remote-debugging-port` + `--enable-unsafe-extension-debugging` 重开**同一个真实 profile**（登录态保留）→ `Extensions.loadUnpacked`。 |

`installExtension()` 只有在调用方显式传了 `allowRestart: true` 时才会关浏览器。

## 保住登录态

受控重启用的是**用户真实的用户数据目录**加 `--profile-directory`，不是一次性的干净
profile。`buildLaunchFlags()` 刻意**不**加 `--disable-extensions-except`——那会把用户
其它扩展全关掉。退出用 SIGTERM（等同菜单里的「退出」，Chromium 会把 cookie / 会话刷盘），
超时才升级到 SIGKILL。

## 还没走的路（以及为什么）

- **企业策略 / `ExtensionInstallForcelist`**：需要写 `/etc/opt/chrome/policies/managed/`
  （或注册表），要 root/管理员，且扩展得有可访问的 update URL。对一个 npm 装的工具不现实。
- **上架 Chrome 应用商店**：能彻底解决问题，是长期正解，但不是代码能做的事。
- **直接改 profile 的 `Preferences` 伪造安装记录**：正是 Chrome 137 那轮收紧要防的行为，
  项目决定不碰（见 HANDOFF 里的硬约束）。
