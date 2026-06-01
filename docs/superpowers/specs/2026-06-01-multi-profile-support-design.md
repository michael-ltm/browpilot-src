# Multi-Profile Support — Design Spec

**Date:** 2026-06-01
**Status:** Approved design, pre-implementation
**Extends:** `claude-browser` (see `2026-05-31-claude-browser-control-design.md`)
**Branch:** `feat/multi-profile`

---

## 1. Motivation

Today the system controls exactly **one** Chrome profile. The broker holds a single browser socket (`broker/src/server.ts`: `let browserSocket: LiveSocket | null`); a second profile's extension — which passes auth because every profile installs the same pinned-id extension and therefore presents the same `Origin` — **overwrites** the first (`browserSocket = ws`), so the two profiles fight over the one slot.

Clarification captured during brainstorming: **multi-tab within one profile already works** — `relay.ts` `attach()` attaches `chrome.debugger` per `tabId`, `executeCdp` targets `{tabId}`, and the broker leases tabs per session. A tab only needs to *exist* (it may be a background tab). So the real gap is **multiple profiles**, not multiple tabs.

**Goal:** let several Chrome profiles each run the extension and connect simultaneously; let Claude Code pick which profile to drive via a **native selector** (no typing) when ambiguous; and surface **per-profile connection status, error logs, and reconnect state** inside Claude Code.

## 2. Goals / Non-goals

**Goals**
- Broker accepts and tracks **multiple** simultaneous browser (profile) connections.
- Each profile is identified by a stable `instanceId` and shown by a human-friendly `label`.
- Tool calls resolve a target profile: explicit → session-remembered → sole-connected → otherwise ambiguous.
- On ambiguity, Claude Code presents a **native picker** (`AskUserQuestion`) listing connected profiles; the choice is **remembered for the session**.
- Per-profile observability tools: status, recent event log (connect/disconnect/error/reconnect).

**Non-goals (this iteration)**
- MCP server-driven elicitation picker (Approach B) — revisit if/when Claude Code's enum elicitation renders natively.
- Cross-profile orchestration in a single tool call (each call targets one profile).
- Auto-labeling from Google account (`chrome.identity`) — popup-naming chosen instead.
- Changing the single-profile happy path's behavior (one profile connected → no prompts).

## 3. Selector mechanism (decided: Approach A)

The MCP layer only **reports** which profiles are connected and signals ambiguity. Claude Code (the agent) renders the **native `AskUserQuestion` card** to let the user select — no typing, only when >1 profile is connected. We cannot *force* the agent, so this behavior is driven by tool descriptions + the `AMBIGUOUS_PROFILE` result shape that explicitly instructs the agent to list-then-ask-then-select-then-retry. (Approach B — MCP elicitation — and Approach C — plain text — were rejected.)

## 4. Profile identity & broker multi-connection

- **Identity:** each extension install persists a random `instanceId` (UUID, generated once, stored in `chrome.storage.local`) plus a user-editable `label` (default `Profile <shortId>`, where `shortId` = first 4 hex chars of `instanceId`). Both travel in `BrowserHello`. The agent-facing `browserId` used throughout the protocol **is** this `instanceId` (the broker never invents a separate id).
- **Broker:** replace the single `browserSocket` with `browsers: Map<instanceId, BrowserConn>` where:
  ```ts
  interface BrowserConn {
    socket: LiveSocket;
    instanceId: string;
    label: string;
    status: 'connected' | 'disconnected' | 'reconnecting';
    connectedAt: number;
    lastSeen: number;
    lastError?: { message: string; at: number };
    reconnectCount: number;
    leasedTabs: Set<number>;
  }
  ```
  Auth is unchanged (Origin must equal `chrome-extension://<pinnedId>`); the **discriminator** is `hello.instanceId`. A reconnect with the same `instanceId` replaces that profile's socket only (and increments `reconnectCount`), never another's.
- **Routing:** an agent request may carry an optional `browserId`. Resolution: `browserId` present → route to that profile (else `EXTENSION_DISCONNECTED` for that profile); absent + exactly one connected → that one; absent + more than one → `AMBIGUOUS_PROFILE` error carrying the candidate list.
- **Per-profile isolation:** a profile disconnecting rejects only **its** pending requests (`EXTENSION_DISCONNECTED`); other profiles are unaffected. Tab leases are namespaced per `instanceId`.

## 5. Protocol changes (`packages/shared`)

- `BrowserHello` gains `instanceId: string` and `label: string`.
- Agent-bound request params gain an optional `browserId?: string` (on `executeCdp`, `getTabs`, `newTab`, `switchTab`, `closeTab`, `getHistory`, `getConsole`, `attach`, `detach`).
- New methods (agent → broker, answered locally by the broker, not routed):
  - `listProfiles` → `{ profiles: ProfileInfo[] }`.
  - `getProfileStatus` (params `{ browserId? }`) → `ProfileInfo` or full list.
  - `getProfileLogs` (params `{ browserId, limit? }`) → `{ events: ProfileEvent[] }`.
  ```ts
  interface ProfileInfo {
    browserId: string; label: string;
    status: 'connected' | 'disconnected' | 'reconnecting';
    connectedAt: number; lastSeen: number;
    lastError?: { message: string; at: number };
    reconnectCount: number; tabCount: number;
  }
  interface ProfileEvent { at: number; kind: 'connect' | 'disconnect' | 'error' | 'reconnect'; detail?: string; }
  ```
- New error code `AMBIGUOUS_PROFILE` (app range, e.g. `1008`); its `error.data` carries `{ profiles: ProfileInfo[] }`.
- Optional notification `onProfileChange` (broker → agents) emitted on connect/disconnect/status change, payload `ProfileInfo`. Included this iteration so `browser_status` can reflect live changes without polling.

## 6. Extension changes (`packages/extension`)

- **Background:** on startup, read-or-generate `instanceId` in `chrome.storage.local` (generate once via `crypto.randomUUID()`); read `label` (default `Profile <shortId>` where `shortId` = first 4 hex chars of `instanceId` — profiles are isolated, so there is no shared counter). Include both in the `BrowserHello` sent by `transport.ts`.
- **Popup:** add a labelled text input ("此 Profile 名称") bound to `chrome.storage.local`; continue to show the existing connection-status dot. Editing the label updates storage; the new label is sent on the next (re)connect (or pushed immediately via a lightweight `relabel` notification — optional, default: applies on next reconnect to keep it simple).

## 7. MCP server changes (`packages/mcp-server`)

- **Session state:** the MCP process (one per Claude session) holds `selectedBrowserId: string | null`.
- **New tools:**
  - `browser_list_profiles` → calls `listProfiles`; returns the `ProfileInfo[]` for the agent to render.
  - `browser_select_profile { browserId? , label? }` → resolves to a `browserId`, stores it in session state, returns confirmation.
  - `browser_status { browserId? }` → `getProfileStatus`.
  - `browser_logs { browserId?, limit? }` → `getProfileLogs` (defaults to the selected profile).
- **Existing tools** gain an optional `profile` arg (accepts `browserId` or `label`). Resolution order inside the tool wrapper: explicit `profile` → `selectedBrowserId` → (broker says exactly one) auto → otherwise return the `AMBIGUOUS_PROFILE` content so the agent disambiguates. The resolved `browserId` is attached to the broker request.
- **Agent guidance (tool descriptions):** `browser_*` tool descriptions and the `AMBIGUOUS_PROFILE` result text instruct: "If multiple profiles are connected and none is selected, call `browser_list_profiles`, ask the user with a native choice (`AskUserQuestion`), then `browser_select_profile`, then retry." This yields native, no-typing, ask-only-when->1, remembered selection.

## 8. Observability in Claude Code

- `browser_status` surfaces, per profile: `status`, `lastError` (+timestamp), `reconnectCount`, `connectedAt`, `lastSeen`, `tabCount`.
- `browser_logs` returns the broker's per-profile **event ring buffer** (bounded, e.g. last 50 events): connect / disconnect / error / reconnect with timestamps and detail.
- The extension already mirrors its own status to `chrome.storage` (popup dot); this feature adds the **broker-side, cross-profile** view that Claude Code can query directly.

## 9. Error handling

- `AMBIGUOUS_PROFILE` is a normal, expected control-flow result, not a failure — its `data.profiles` drives the picker.
- Targeting a `browserId` that is not connected → `EXTENSION_DISCONNECTED` naming that profile; the agent may re-list and re-select.
- A profile's disconnect rejects only its own pending requests; the broker and all other profiles continue. Never hang: existing per-request timeouts apply per profile.

## 10. Testing

- **broker:** two simulated browsers with distinct `instanceId` → both tracked; route by `browserId`; absent+one → auto; absent+two → `AMBIGUOUS_PROFILE` with both; one disconnects → only its pending rejected, the other still routes; per-profile status + event-log contents; `reconnectCount` increments on same-`instanceId` reconnect.
- **extension:** `instanceId` generated once and stable across restarts (mock `chrome.storage`); `label` default + read; `BrowserHello` carries both.
- **mcp:** profile resolution (explicit / remembered / auto / ambiguous) with a fake client; `browser_list_profiles` / `browser_select_profile` / `browser_status` / `browser_logs`; selection remembered across calls in one session.
- **integration (env-gated, as before):** launch two profiles (two `--user-data-dir`s) → `browser_list_profiles` shows 2 → `browser_select_profile` → drive each independently. Gated behind `RUN_BROWSER_TESTS=1`; subject to the same Chrome `--load-extension` limitation documented in the base spec.

## 11. Open decisions (resolved)
- Labeling: **popup-named**, default auto-number, editable. (Not Google-email, not pure auto-number.)
- Ask timing: **only when >1 connected**, remembered per session.
- Picker: **Approach A** (agent-driven `AskUserQuestion`).
- `onProfileChange` live notification: **included** this iteration.
