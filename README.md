# Browpilot

**Browser MCP for AI agents.** Connect Codex, Claude Code and MCP clients to your selected Chrome, Edge or Chromium profile.

<img src="packages/extension/icons/browpilot.svg" width="96" alt="Browpilot logo">

Browpilot combines a browser extension, a local broker and an MCP server. It discovers local browser profiles, reports extension installation separately from connection, opens a selected profile, and waits for verified extension pairing before sending commands. Existing screenshot, DOM, navigation, network and JavaScript debugger tools remain available.

Previously named `claude-browser`. Starting with 0.2.2 every name is Browpilot: npm package `@john523100/browpilot`, command `browpilot`, MCP server name `browpilot` and configuration directory `~/.browpilot`. On first start the companion moves an existing `~/.claude-browser` directory to `~/.browpilot`, and the extension carries its stored settings over to the new storage keys; the development extension ID is unchanged. **Version 0.2.2 is available from the [GitHub release](https://github.com/michael-ltm/browpilot/releases/tag/v0.2.2); it has not been published to the npm registry. Version 0.2.1 is published on the [Chrome Web Store](https://chromewebstore.google.com/detail/kglhakgapoegbnnbobnmnebmbljehcid); 0.2.2 is pending review with automatic publication after approval.**

## Build and connect

Requires Node.js 20 or newer. From this checkout:

```sh
npm ci
npm run build -w @browpilot/shared
npm run build
npm run build:package
node dist-pkg/dist/mcp.js install codex
# Or:
node dist-pkg/dist/mcp.js install claude
```

The installer registers this installed file, so keep its directory in place. Generate configuration instead with `node dist-pkg/dist/mcp.js config codex` or `config claude`; this is useful when the client command is unavailable. The assembled package provides the `browpilot` executable. If an older install registered the MCP server as `claude-browser`, remove that entry (`claude mcp remove claude-browser`, or delete `[mcp_servers.claude-browser]` from `~/.codex/config.toml`).

Load the extension directory printed by `node dist-pkg/dist/mcp.js extension-path` in `chrome://extensions` or `edge://extensions`, using Developer mode → Load unpacked. The companion runs on the same computer as the browser. A cloud-hosted coding agent needs a connection to that computer; installing the extension alone does not provide a remote service.

## Find, install and open profiles

1. Call `browser_list_instances`. Results include an exact local `id`, browser executable, user-data directory, profile name, installation evidence and connection state. Default locations are supported on Linux, macOS and Windows. Add custom paths with `browser_register_instance`.
2. If needed, call `browser_install_extension` with that ID. It opens the configured store page in that profile, or browser extension settings. **Confirm installation in the browser.** No silent installation or browser Preferences modification is performed. With `allowRestart: true` (ask the user first) it instead closes and reopens that real profile, keeping its sign-ins, and loads the unpacked extension over the DevTools protocol where the browser allows it; that load lasts one browser session, and Chrome/Edge 136+ refuse it for their default user-data directory. See [extension installation findings](docs/extension-install.md).
3. Call `browser_open_instance` with the local ID. Browpilot opens a pairing tab, verifies a one-time code, persists the local-profile/runtime-ID binding and selects it for the MCP session.
4. Call `browser_get_tabs`, then use normal `browser_*` tools.

Once paired, an explicit request to a closed profile can launch it automatically. Concurrent requests share one startup attempt. Status/log inspection never opens a browser. A call containing a tab ID from before restart reopens the browser and asks for fresh tabs/snapshots before continuing. Already-dispatched mutations are not automatically repeated.

`browser_detect` is a read-only report of installed Chrome, Edge, Brave and Chromium builds: version, running processes, default or custom user-data directory and per-profile extension state. Its numbered entries can be passed to `browser_install_extension` as `index` (or pick by `family`) for the same controlled relaunch.

`browser_list_profiles` lists runtime connections known to the current broker; `browser_list_instances` includes closed local profiles. Disconnection does not prove the browser process exited. An `unknown` installation state means files could not establish it, not that the extension is absent. Catalog and bindings are stored in `~/.browpilot/browser-profiles.json`.

## Grok and HTTP MCP

Codex and Claude Code use stdio directly. For Grok Remote MCP or custom connectors:

```sh
# Set BROWPILOT_HTTP_TOKEN to a random secret of at least 32 characters.
# Optional: BROWPILOT_HTTP_ORIGINS=https://your-tunnel.example
node dist-pkg/dist/mcp.js serve --port 8788
```

The endpoint is `http://127.0.0.1:8788/mcp`. Every request requires `Authorization: Bearer <your-secret>`. MCP sessions have separate profile selections, references and broker connections. Sessions expire after 30 minutes without requests; at most 100 are retained. Requests are limited to 1 MiB.

Grok cloud services require a reachable HTTPS endpoint. Configure an authenticated tunnel/reverse proxy to this HTTP endpoint and allow its exact public origin with `BROWPILOT_HTTP_ORIGINS`. Do not tunnel port 8787, the private broker. Browpilot does not create or publish a tunnel automatically. The tunnel and chosen AI provider receive requested tool data. Connector availability depends on the Grok client and account.

For xAI API Remote MCP, supply the public `/mcp` URL as `server_url` with the API's supported authorization option. A local xAI tool-calling application can instead consume stdio MCP. See [xAI Remote MCP](https://docs.x.ai/developers/tools/remote-mcp) and [Grok custom MCP tunneling](https://docs.x.ai/grok/connectors/custom-mcp-tunneling).

## Operate and debug other browser extensions

Chrome refuses `chrome.debugger` on other extensions' pages and workers, so the regular tools (`browser_eval`, snapshots, screenshots) stop at `chrome-extension://` URLs. Two tools cover extensions instead.

### `browser_extensions` — through the paired Browpilot extension, no restart

| action | Purpose |
| --- | --- |
| `list` | Installed extensions: id, version, unpacked or store, options page |
| `reload` | Re-read an unpacked extension from disk (the reload button); `id` = Browpilot reloads itself |
| `enable` / `disable` | Toggle an extension |
| `open_options` | Open its options page in a tab |
| `message` | `chrome.runtime.sendMessage(id, message)` and return the reply; works with extensions that listen on `chrome.runtime.onMessageExternal` |

`id` accepts an extension id or a unique part of its name. Needs the `management` permission (added in this version; reload Browpilot once on `chrome://extensions` after updating).

### `browser_developer` — direct CDP, full access to every extension

| action | Purpose |
| --- | --- |
| `launch` | Start a browser with DevTools and `--enable-unsafe-extension-debugging`. `userDataDir` picks the profile (generated when omitted). `takeOver: true` quits a browser that already has that profile open (SIGTERM, session saved), then restarts it with DevTools, `--restore-last-session` and, on Linux, its previous flags; the restarted browser stays running after `close`. `extensionPath` installs an unpacked extension |
| `connect` | Attach to an already-enabled loopback CDP port |
| `extensions` | Every extension's service worker / background page / open pages, grouped by extension id |
| `extension_eval` | Evaluate `expression` inside extension `extensionId` with its own `chrome.*` APIs (storage, runtime, tabs…): in its worker when running, otherwise in its `manifest.json` page (opened in the background and closed afterwards; `chrome.runtime.sendMessage` from there wakes the worker). `where`: `auto` / `worker` / `page` |
| `load_extension` | Install an unpacked extension from `extensionPath` (`Extensions.loadUnpacked`); it persists in the profile like "Load unpacked" |
| `targets` | List pages, extension pages and workers |
| `attach` | Attach a target and return its flat `sessionId` |
| `contexts` | Enable Runtime and list observed execution contexts for a session |
| `evaluate` | Evaluate in an explicit session and `contextId` |
| `command` | Send any CDP method: breakpoints, script source, Network, `Extensions.uninstall`, `Input.*`, `Page.captureScreenshot` |
| `events` | Poll bounded events; pass the last sequence as `since` |
| `close` | Disconnect; terminates only a browser this session launched fresh, never a taken-over one |

Examples:

- Change an extension's settings: `launch {userDataDir, takeOver: true}` → `extension_eval {extensionId, expression: "chrome.storage.local.set({...})"}`.
- Work with an extension page's UI: `command Target.createTarget {url: "chrome-extension://<id>/options.html"}` → `attach` → `command Runtime.evaluate` / `Input.dispatchMouseEvent` / `Page.captureScreenshot` with that `sessionId`.
- Breakpoints: `attach` the `service_worker` → `command Debugger.enable`, `Debugger.setBreakpointByUrl`, `Debugger.getScriptSource`.

A webpage context differs from extension content-script contexts; a worker is another target. Direct CDP preserves target/session identity and avoids automatically applying page emulation to workers. Chrome refuses DevTools on its default user data directory, and developer launches refuse the daily browser directories too: use a separate `--user-data-dir` profile for extension work. Generated developer profiles are retained under `~/.browpilot/developer-profiles` for inspection. Ordinary daily profiles use `browser_open_instance` instead.

## Store preparation

```sh
npm run build
npm run build:store
```

Outputs `artifacts/browpilot-chrome-0.2.2.zip` and `artifacts/browpilot-edge-0.2.2.zip`. Store archives exclude source maps and the development manifest key; unpacked packages retain the pinned key.

The assigned Chrome store ID `kglhakgapoegbnnbobnmnebmbljehcid` and its listing URL are built into the companion defaults. Add any additional actual store IDs to `extensionIds` in `~/.browpilot/config.json`, alongside the existing `extensionId`. Set `storeUrls.edge` after Microsoft assigns the real listing URL; `storeUrls.chrome` can override its default. Restart the companion broker after configuration changes. The allowlist requires browser Origin and hello ID to match exactly; never substitute guessed IDs.

See [submission record](docs/store-submission-0.2.2.md), [store materials](docs/store-listing.md) and [privacy policy](docs/privacy.md). Publication requires publisher accounts, actual listing IDs, a hosted privacy-policy URL and store review. ZIP generation does not imply acceptance.

## Verification

```sh
npm test
npm run typecheck
npm run build
npm run build:package
npm run build:store
```

Tests use temporary profiles and simulated protocol peers; socket tests need loopback permission. Platform candidate fixtures are not Windows/macOS browser smoke tests. The legacy integration harness uses port 8787: do not run it against an active daily broker.

For an isolated real Chromium test, run `node --import tsx scripts/smoke-browser.ts` after building. Set `BROWPILOT_TEST_BROWSER` to override `/usr/bin/chromium`. It verifies cold launch, pairing, MCP tabs, automatic restart and a second extension's worker context using temporary profiles and a random broker port. See [0.2.0 verification evidence and limitations](docs/verification-0.2.0.md).

The extension uses `chrome.debugger`, so browsers can display their debugging indicator. Alarms and heartbeats reconnect suspended service workers; OS sleep, disabled extensions and browser shutdown can still interrupt calls. The Node companion starts browsers, not the extension.

Licensed under [Apache-2.0](LICENSE). [Source and issue tracking](https://github.com/michael-ltm/browpilot-src).
