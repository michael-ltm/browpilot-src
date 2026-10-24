# Browpilot

Browser MCP for AI agents. Connect Codex, Claude Code and compatible MCP clients to a browser profile you choose.

This repository distributes the Browpilot companion, extension packages, setup instructions and privacy policy. The extension requires the companion on the same computer as your browser.

## Install the companion

Requires Node.js 20 or newer.

```sh
npm install -g https://github.com/michael-ltm/browpilot/releases/download/v0.2.1/john523100-claude-browser-0.2.1.tgz
browpilot install codex
# Or: browpilot install claude
```

Restart your MCP client after registration. If its CLI is unavailable, use `browpilot config codex` or `browpilot config claude` and copy the generated configuration into your client settings. Both `browpilot` and the legacy `claude-browser` command are provided.

## Install and connect the extension

Browpilot 0.2.1 removes unused permissions identified during Chrome review. Version 0.2.1 was resubmitted on September 24, 2026 (UTC) and is pending review with automatic publication after approval. Until the listing is available, run `browpilot extension-path` and load that directory using Developer mode → Load unpacked at `chrome://extensions` or `edge://extensions`.

1. Ask your AI client to call `browser_list_instances`.
2. Choose an exact local instance ID and call `browser_open_instance`.
3. The companion opens a pairing tab in that profile and waits for verified connection.
4. Call `browser_get_tabs`, then inspect pages, capture screenshots, click or type as needed.

For a custom installation, use `browser_register_instance` with its executable, user-data directory and profile directory. Installed, enabled and connected are separate states. Once paired, calls to a selected offline profile can reopen it. Refresh tabs and snapshots after restart; old tab IDs and element references can no longer be trusted. Already-dispatched mutations are never automatically replayed.

`browser_install_extension` opens a configured store page or the browser's extension settings; installation requires confirmation in the browser. The assigned Chrome Store ID `kglhakgapoegbnnbobnmnebmbljehcid` is included in the companion defaults; additional store IDs can be configured in its allowlist. Configuration is retained at `~/.claude-browser/config.json` for upgrade compatibility.

## Grok and other remote clients

The companion supports authenticated Streamable HTTP MCP:

```sh
# Set BROWPILOT_HTTP_TOKEN to a random secret of at least 32 characters.
# Set BROWPILOT_HTTP_ORIGINS to your exact public HTTPS origin when using a proxy.
browpilot serve --port 8788
```

Every request to `http://127.0.0.1:8788/mcp` needs `Authorization: Bearer <your-secret>`. Cloud clients need a separately configured HTTPS tunnel/proxy to that endpoint. Do not expose broker port 8787. Grok availability depends on the client/account; a real Grok cloud connection has not been verified for this release. Each HTTP session owns separate profile selection, references and broker connection.

## Debug another extension

Use `browser_developer`: `launch` a dedicated Chromium profile or `connect` an already-enabled loopback CDP port, then `targets` → `attach` → `contexts` → `evaluate`. Provide the actual target session and execution context. `command` supports breakpoints, script source, Runtime and Network CDP commands; `events` returns a bounded event buffer.

Daily default directories are refused by developer launch. Normal profile startup uses `browser_open_instance`. Loading an unpacked extension by launch flag is browser/version dependent; Chromium or Chrome for Testing is suitable. There is no claim of unrestricted access to every protected browser context.

## Store status

Chrome: version 0.2.1 is pending review after correcting the 0.2.0 permissions rejection. Automatic publication after approval is enabled. Assigned listing: https://chromewebstore.google.com/detail/kglhakgapoegbnnbobnmnebmbljehcid (not available until approval).

Edge: a submission ZIP is available in the release; no Edge store approval or publication is claimed.

See [review setup instructions](TESTING.md) for a direct MCP test without an AI provider account.

## Validation and privacy

Version 0.2.1 passed 337 automated tests, workspace type checks and builds. Real Linux Chromium verified offline installation evidence, cold startup/pairing, MCP tab control, automatic restart and evaluation in a second independent extension worker. Windows/macOS and actual Edge have not received equivalent live testing.

See [Privacy policy](privacy.md). Tool results reach the MCP client and its AI provider; remote access also uses the tunnel/proxy you configure. No built-in analytics or hosted collection service is included.

Report issues in [this repository](https://github.com/michael-ltm/browpilot/issues), without private browsing data. Browpilot is independent of OpenAI, Anthropic, xAI, Google and Microsoft. Distributed under the MIT license.
