# Claude Browser Control — Design Spec

**Date:** 2026-05-31
**Status:** Approved design, pre-implementation
**Working name:** `claude-browser` (provisional; tools are prefixed `browser_*`, config lives in `~/.claude-browser/`)

---

## 1. Motivation

The user wants Codex-style browser control driven from **Claude Code** (the terminal agent): screenshot + coordinate actions *and* structured DOM control, against their **real Chrome with their logins**, that is **stable — never needs manual reconnect**.

Two existing options were evaluated and rejected as the primary solution:

- **Third-party `chrome-mcp`** (current setup): drops connection, needs manual reconnect.
- **Official "Claude Code with Chrome" (beta)** — functionally sufficient (native messaging, real Chrome, MCP tools, full hybrid), but per Anthropic's own docs it has the *same* defect: *"The Chrome extension's service worker can go idle during extended sessions, which breaks the connection… select 'Reconnect extension'."* It is closed-source, so the missing stability layer cannot be patched in.

Reverse-engineering OpenAI's Codex extension revealed **why Codex is stable**: its MV3 extension is a thin CDP relay with a bulletproof reconnect discipline — eager reconnect on every service-worker wake, a `chrome.alarms` alarm (~30s) that **survives service-worker death**, and a 30s heartbeat. That discipline is exactly what both alternatives lack.

**This project reimplements that architecture cleanly** (readable, owned source — not OpenAI's minified, signed bundle), adapted to Claude Code, with the stability discipline as the headline feature.

## 2. Goals / Non-goals

**Goals**
- Drive the user's real Chrome (with logins) from Claude Code via MCP tools.
- Full hybrid control: vision/coordinate (screenshot + click/type/scroll) **and** structured DOM (accessibility snapshot with stable refs, selector ops).
- **Zero manual reconnect**, ever — self-healing across service-worker death, MCP-server restarts, and broker crashes.
- Support multiple concurrent Claude Code sessions without tab contention.
- One-command install on macOS.

**Non-goals (v1)**
- Cross-browser parity beyond Chrome (Edge is likely free but untested; Brave/Arc out of scope).
- Replacing the official tool's safety features (site-category blocking, prompt-injection mitigations) — we mirror a simple per-site permission model only as far as needed.
- Windows/Linux install automation (architecture is portable; installer is macOS-first).
- `browser_network`, GIF recording, history, visual tab-group grouping → Phase 2.

## 3. Architecture

Three processes, decoupled so nothing ever needs a manual reconnect. The **broker is the only long-lived anchor**; the MCP server is ephemeral (per Claude session); the extension self-heals.

```
┌─────────────────┐   stdio (MCP)   ┌──────────────────────┐
│   Claude Code   │◄───────────────►│   MCP server         │  spawned per session (ephemeral)
└─────────────────┘                 │  (browser_* tools)   │
                                     └──────────┬───────────┘
                                                │ WS 127.0.0.1 + token  (agent side)
                                                ▼
                                     ┌──────────────────────┐
                                     │   Broker daemon       │  launchd KeepAlive (always on)
                                     │  router + leases +    │
                                     │  console/event buffer │
                                     └──────────┬───────────┘
                                                │ WS 127.0.0.1; auth by pinned
                                                │ chrome-extension:// origin (browser side)
                                                ▼
                                     ┌──────────────────────┐
                                     │  Chrome extension     │  your real Chrome / logins
                                     │  thin CDP relay +     │
                                     │  Codex-grade reconnect│
                                     └──────────┬───────────┘
                                                │ chrome.debugger / CDP
                                                ▼
                                          Browser tabs
```

**Why this kills the reconnect pain:** the broker outlives MCP-server restarts, so new sessions attach in milliseconds; the extension's alarm-based revival outlives service-worker death. The two failure modes that force manual reconnects elsewhere are each independently healed.

**Transport decision:** loopback WebSocket (the extension CSP already permits `ws://127.0.0.1:*`). Native Messaging was rejected because it forces a Chrome-path-coupled manifest install *and would still need this broker*; the WS link is authenticated cleanly (§9). This also sidesteps the official tool's known native-messaging routing bug (extension binding to Claude Desktop instead of Claude Code).

## 4. Components & module layout

```
claude-ext/
  packages/
    shared/        protocol.ts — JSON-RPC method names + shared TS types
    extension/     MV3: transport.ts, relay.ts, helpers.ts, cursor content-script, popup
    broker/        server.ts, router.ts (+leases), buffer.ts, config.ts, launchd plist
    mcp-server/    index.ts, client.ts, cdp.ts, tools/*.ts
  scripts/         install.ts, uninstall.ts
  docs/superpowers/specs/
```

**Extension (browser side)** — clean reimplementation of Codex's thin relay:
- `transport.ts` — WS client + the reconnect discipline (§6).
- `relay.ts` — receives `executeCdp` → `chrome.debugger.sendCommand`; forwards CDP events as `onCDPEvent` notifications. Pure pass-through.
- `helpers.ts` — non-CDP commands needing Chrome APIs: `getTabs`, `newTab`, `switchTab`, `closeTab`, `getHistory`, `attach`/`detach` (chrome.debugger lifecycle), `getInfo`.
- Cursor content-script + favicon badge — optional visual "agent is driving" indicator.
- Popup — shows connection status from `chrome.storage`; never drives reconnection.
- Manifest `key` pins a stable extension ID for the broker allowlist.

**Broker (anchor)** — long-lived via launchd:
- `server.ts` — `127.0.0.1`-only WS listener; authenticates browser vs agent clients (§9).
- `router.ts` — routes agent→extension JSON-RPC, relays responses/events; per-session **tab leasing** (§7).
- `buffer.ts` — ring buffer of console/network CDP events per tab (populated from `onCDPEvent`), so `browser_console` reads from a persistent store.
- `config.ts` — owns `~/.claude-browser/config.json` (`{port, token, extensionId}`).

**MCP server (agent side)** — stdio MCP, spawned per session:
- `index.ts` — registers `browser_*` tools (§5).
- `client.ts` — connects to broker; **if broker down, spawns it detached** and retries with backoff; auto-reconnects; rejects in-flight calls with actionable errors on disconnect.
- `cdp.ts` — builds CDP commands (Input/Page/DOM/Accessibility/Runtime), key-code map, coordinate math.
- `tools/*.ts` — one module per tool group; each translates a tool call into `executeCdp` (raw CDP) or a broker helper call.

**Design choice:** all "smarts" live in the MCP server (readable TS, easy to iterate); the extension stays a dumb, stable relay that rarely changes — exactly Codex's split.

## 5. Tool surface (`browser_*`)

### 5.1 Vision / coordinate (raw CDP)
| Tool | Params | Maps to |
|---|---|---|
| `browser_screenshot` | `{fullPage?, tabId?}` | `Page.captureScreenshot` → image to Claude |
| `browser_click` | `{x,y,button?,count?}` | `Input.dispatchMouseEvent` press+release (+ cursor overlay) |
| `browser_move` | `{x,y}` | `Input.dispatchMouseEvent` move + animated cursor |
| `browser_type` | `{text}` | `Input.insertText` / per-key `dispatchKeyEvent` |
| `browser_press_key` | `{keys}` | `Input.dispatchKeyEvent` w/ key-code map (Enter, Cmd+A…) |
| `browser_scroll` | `{deltaX,deltaY,x?,y?}` | `Input.dispatchMouseEvent` mouseWheel |
| `browser_drag` | `{fromX,fromY,toX,toY}` | press → move → release |

### 5.2 DOM / structured (the differentiator)
| Tool | Params | Maps to |
|---|---|---|
| `browser_snapshot` | `{tabId?}` | `Accessibility.getFullAXTree` (+DOM) → compact element map **with stable `ref`s** |
| `browser_click_ref` | `{ref}` | resolve ref → `DOM.getBoxModel` → click center |
| `browser_fill` | `{ref,value}` | focus + insert text |
| `browser_query` | `{selector,all?}` | `Runtime.evaluate` querySelector(All) |
| `browser_get_text` | `{selector?}` | readable text extraction |
| `browser_eval` | `{expression}` | `Runtime.evaluate` — **permission-gated** |

Pairing a screenshot with a ref'd snapshot is what makes this nicer than coordinate-only (Codex) and DOM-only (chrome-mcp): Claude both *sees* the page and gets *reliable handles*.

### 5.3 Navigation / tabs / debug
- `browser_navigate {url,tabId?}`, `browser_back`, `browser_forward`, `browser_reload` — CDP `Page.*`.
- `browser_wait {selector? | networkIdle? | ms?}` — CDP lifecycle events / poll.
- `browser_get_tabs`, `browser_new_tab {url?}`, `browser_switch_tab {tabId}`, `browser_close_tab {tabId}` — extension helpers.
- `browser_console {filter?, since?}` — reads broker's buffered console events.

### 5.4 Coordinate space
On attach, the extension applies `Emulation.setDeviceMetricsOverride` with `deviceScaleFactor: 1` (Codex pattern) so **screenshot pixels == CSS pixels == input coordinates**. This keeps the vision→click loop consistent across HiDPI displays.

### 5.5 Phasing
- **v1:** all tools in §5.1–5.3.
- **Phase 2:** `browser_network`, `browser_record_gif`, `browser_get_history`, visual tab-group grouping.

## 6. Stability mechanics (core)

**Extension (browser side):**
- Eager connect on every service-worker startup (top-level in SW).
- On disconnect → reject pending requests + `scheduleReconnect`, firing **two** mechanisms: a 5s `setTimeout` retry **and** a `chrome.alarms` alarm (`periodInMinutes: 0.5`). The alarm **survives service-worker death** — Chrome kills the idle worker, the alarm wakes it, init re-runs, connection re-establishes. *This is the fix the official tool lacks.*
- 30s heartbeat `ping`: keeps the worker alive (activity resets MV3 idle timer) **and** detects half-open sockets (no `pong` in 3s → tear down + reconnect, detach stale debugger sessions).
- Status mirrored to `chrome.storage.local`; popup displays it but never drives reconnection.
- Auto-reattach `chrome.debugger` on `onDetach`.

**Broker (anchor):** launchd `KeepAlive=true` + `RunAtLoad=true` — always up, relaunched on crash, started at login. Holds the one warm extension connection + N agent connections. Survives every MCP-server restart. Per-call timeouts; brief queue (≤~10s) then clean error if the extension blips — never hangs.

**MCP server (agent side):** reads config, connects to broker; if broker unreachable, spawns it detached and retries with backoff; reconnects automatically; rejects in-flight tool calls with actionable errors on disconnect so Claude retries instead of hanging.

**Stability contract:** an automated **soak test** idles/kills the service worker and kills+restarts the MCP server repeatedly, asserting browser tools always resume with **zero manual action**. Passing this test is the definition of done for the stability requirement.

## 7. Multi-session tab leasing
The broker tracks which agent session owns which tab (a lease, Codex-borrowed). Each session gets its own tab by default (created on first action or by claiming a user tab); a session acting on a tab it doesn't own gets a clear error. Leases release on session/turn end. Prevents concurrent Claude sessions from fighting over a tab. (Visual tab-group grouping is Phase 2.)

## 8. Wire protocol

JSON-RPC 2.0 over both WS links.

- **Auth handshake:** first message from each client declares role: browser side proven by `Origin: chrome-extension://<pinned-id>`; agent side presents `{token}` from config.
- **Agent → Extension (via broker):** `executeCdp {target, method, params}`, `getTabs`, `newTab`, `switchTab`, `closeTab`, `getHistory`, `attach`, `detach`, `getConsole`, `ping`.
- **Extension → Agent (via broker, notifications):** `onCDPEvent {source, method, params}`, `onConsole`, status changes.
- **Heartbeat:** `ping`/`pong` on both links.
- Responses correlated by `id`; disconnects reject all pending (Codex pattern). Console/network events from `onCDPEvent` are buffered in the broker so `browser_console` reads a persistent store.

## 9. Security / auth
- Broker binds **`127.0.0.1` only**.
- **Browser side authenticated by origin:** WS upgrade handler allowlists only `Origin: chrome-extension://<pinned-id>` (pinned via manifest `key`). Web pages carry http(s) origins → rejected, so no website can pose as the browser side (defends the localhost-WS / DNS-rebinding surface).
- **Agent side authenticated by token:** MCP server presents a token from `~/.claude-browser/config.json` (readable only by the user's processes).
- `browser_eval` and other high-risk tools are permission-gated; an optional per-site allowlist can be added.

## 10. Error handling
Never hang: every cross-process call has a timeout and rejects with an actionable, categorized message (`extension_disconnected` / `tab_not_found` / `stale_ref` / `cdp_error`). Disconnects reject pending requests immediately. MCP tools surface these so Claude can choose to retry, re-snapshot, or surface to the user.

## 11. Install / uninstall
`install` (one command): (1) write + load launchd plist (broker always-on); (2) write `~/.claude-browser/config.json` (port + generated token + pinned extension ID); (3) register the MCP server with Claude Code (`claude mcp add`); (4) print "load unpacked extension from `packages/extension/dist`" instructions. `uninstall`: unload launchd, remove config, remove MCP entry.

## 12. Testing
- **Unit:** broker routing/auth (origin allowlist, token reject), reconnect state machine, JSON-RPC framing, `cdp.ts` key-map + coordinate math.
- **Extension:** reconnect/alarm/heartbeat logic with mocked chrome APIs (vitest + sinon-chrome).
- **MCP server:** each tool → CDP translation; client autospawn/reconnect.
- **Integration:** real Chrome + extension + broker + MCP; scripted scenario (navigate → snapshot → click_ref → type → screenshot, assert).
- **Stability soak (headline):** idle/kill service worker; kill+restart MCP repeatedly; assert auto-heal with zero manual action.

## 13. Known trade-offs
- **Debugger banner:** `chrome.debugger` shows Chrome's "started debugging this browser" bar; not suppressible via extension APIs. Codex lives with it + adds a cursor/favicon indicator. v1 does the same.
- **Plan/feature independence:** unlike the official tool, this does not require an Anthropic paid plan or specific Claude Code version — it's a standalone MCP server.
- **macOS-first installer:** broker/extension/MCP are portable; only the installer is macOS-specific in v1.

## 14. Open questions
- Final project/brand name (provisional `claude-browser`).
- Default broker port (e.g. 8787) and whether to support port override via config.
- Whether `browser_eval` ships enabled-but-gated or disabled by default in v1.
