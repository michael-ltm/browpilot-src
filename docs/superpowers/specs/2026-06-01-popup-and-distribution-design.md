# Popup Redesign + npm Distribution & Cross-Platform — Design Spec

**Date:** 2026-06-01
**Status:** Approved design, pre-implementation
**Extends:** `claude-browser` (base + multi-profile)
**Branch:** `feat/popup-and-distribution`

---

## 1. Motivation

Two rounds of user feedback, one spec:

- **Area A — Popup/UX.** The current popup (status dot + a bare "此 Profile 名称" input) looks unfinished. Make it presentable, add a GitHub link and short install/usage guidance, and **auto-fill the profile name** instead of requiring the user to type one.
- **Area B — Distribution / cross-platform.** Install today requires `git clone` + `npm run install:browser`, and the broker daemon is launched via **launchd** (macOS-only). Provide a **no-clone, cross-platform** install (Windows included).

## 2. Key constraints (verified)

- A Chrome extension **cannot read the profile display name** ("franco"/"Person 1") — *"the concept of a browser profile is out of scope for WebExtensions APIs."* The only auto-signal is the **signed-in Google account email** via `chrome.identity.getProfileUserInfo()` (requires the `identity.email` permission; empty if not signed in).
- npm cannot install a browser extension into Chrome — the extension is always loaded via "Load unpacked" (from a release zip or the packaged path) until/unless it ships on the Chrome Web Store.

## 3. Decisions (from brainstorming)

- Scope: **both areas in one spec.**
- Profile name: **custom (explicit) → Google email local-part → `Profile <shortId>`.** Add `identity` + `identity.email` permissions.
- Distribution: **publish one npm package; install via `npx`** (no clone). Extension via release zip now; Web Store later.
- Broker: **drop the persistent launchd daemon; rely on MCP-server auto-spawn** → cross-platform.

## 4. Goals / Non-goals

**Goals**
- Redesigned, branded popup: live status, auto profile name (editable), GitHub link, 3-step usage hint.
- Profile name auto-resolves (email → fallback), shared by popup display and the `BrowserHello` label.
- One-command, cross-platform, clone-free install via `npx`.
- Broker works on Windows/macOS/Linux with no OS-specific daemon.
- Auto-publish to npm on `v*` tag (wired; activated when an `NPM_TOKEN` secret exists).

**Non-goals (this iteration)**
- Chrome Web Store submission (documented as a follow-up).
- An optional always-on daemon installer (launchd/Task Scheduler/systemd) — `launchd.ts` is retained but unused by default; a cross-platform daemon installer is a future opt-in.
- A fancy popup framework — plain HTML/CSS/TS, MV3-CSP-safe.

## 5. Area A — Popup + profile name

### A1. Profile-name resolution
A single resolver, used by both the background (hello label) and the popup:

```ts
// extension config.ts
export async function getProfileEmailName(): Promise<string | null> {
  // chrome.identity.getProfileUserInfo -> primary signed-in Google account.
  return new Promise((resolve) => {
    try {
      chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (info) => {
        const email = info?.email ?? '';
        resolve(email ? (email.split('@')[0] || email) : null);
      });
    } catch { resolve(null); }
  });
}

// resolution order: explicit custom label > email local-part > Profile <shortId>
export async function getLabel(instanceId: string): Promise<string> {
  const stored = (await chrome.storage.local.get(LABEL_KEY)) as Record<string, unknown>;
  const custom = typeof stored[LABEL_KEY] === 'string' ? (stored[LABEL_KEY] as string).trim() : '';
  if (custom) return custom;
  const email = await getProfileEmailName();
  if (email) return email;
  return `Profile ${instanceId.slice(0, 4)}`;
}
```
- `background/index.ts` `main()` already `await getLabel(...)` — unchanged call site.
- Manifest `permissions += "identity", "identity.email"`.
- A custom override (typed in the popup) wins; clearing the input removes the custom value and reverts to auto.

### A2. Popup redesign
`popup.html` (styles in a `<style>` block) + `popup.ts` (logic; no inline handlers — MV3 CSP). ~300px wide, light theme. Sections:
- **Header:** extension icon + `claude-browser` + version (read from `chrome.runtime.getManifest().version`).
- **Status pill:** colored dot + text (connected = green / reconnecting = amber / disconnected = red), reusing `statusDisplay()`.
- **Profile:** a text input prefilled with the **resolved** name (`getLabel`); helper text "Auto-detected from your Google account · type to override"; `change` → `applyLabelInput` (empty clears custom → reverts to auto).
- **How to use:** 3 compact steps — `claude mcp add claude-browser -- npx -y claude-browser`, "open a Claude Code session", "ask it to control the browser".
- **Footer:** GitHub link (`https://github.com/michael-ltm/claude-browser`) + "Full guide" → README.

`statusDisplay()` and `applyLabelInput()` keep their signatures (already unit-tested); new pure helpers (`getProfileEmailName`, label resolution) get their own tests. `chromeMock` gains an `identity.getProfileUserInfo` mock.

## 6. Area B — npm distribution + cross-platform

### B1. One publishable package
Publish a single package **`claude-browser`** (scoped `@michael-ltm/claude-browser` if the name is taken) that contains:
- `dist/mcp.js` — the MCP stdio server (the `bin`), with `@claude-browser/shared` bundled.
- `dist/broker.js` — the broker entry, with shared bundled (spawned as a child by the MCP server).
- `extension/` — the built extension `dist` (manifest + bundles + icons), so users can load it unpacked from the installed package.
- `package.json`: `"bin": { "claude-browser": "dist/mcp.js" }`, `"files": ["dist", "extension"]`.

A build/assembly step (tsup multi-entry + a copy of the extension `dist`) produces this layout from the monorepo. The monorepo packages stay as-is for development; the published package is an assembled artifact.

### B2. Install — one cross-platform command, no clone
```
claude mcp add claude-browser -- npx -y claude-browser
```
- Claude Code runs `npx -y claude-browser` (no args) → starts the MCP stdio server.
- The MCP client auto-spawns the broker on first need (`connectWithRetry` → `defaultSpawnBroker`), detached + `unref` (survives the session; shared across sessions).
- `ensureConfig` writes `~/.claude-browser/config.json` (port + token + extensionId) on first run via `os.homedir()` — Windows/macOS/Linux.

### B3. Broker-entry resolution (dev + packaged)
`defaultSpawnBroker` must locate the broker entry in **both** layouts:
- **Dev (monorepo):** `../../broker/dist/index.js` relative to the mcp module.
- **Packaged:** `./broker.js` co-located with `dist/mcp.js`.

Resolve by probing the packaged path first (co-located `broker.js`), then the monorepo path; throw a clear error if neither exists. Spawn options gain **`windowsHide: true`** (no console flash on Windows) alongside `detached: true, stdio: 'ignore'`, then `unref()`.

### B4. CLI surface (the `bin`)
`dist/mcp.js` parses `argv`:
- **no args** → run the MCP stdio server (what Claude Code invokes).
- `extension-path` → print the absolute path of the bundled `extension/` dir (to load unpacked).
- `install` → convenience: run `claude mcp add claude-browser -- npx -y claude-browser` for the user.
- `--version` / `--help`.

### B5. Drop launchd from the default path
`scripts/install.ts` no longer installs a launchd plist. `launchd.ts` and `renderLaunchdPlist` are retained (unused by default) for a future optional always-on installer. The old `npm run install:browser` becomes a thin dev convenience (registers the dev build with `claude mcp add` pointing at the local `dist/mcp.js`); end users use the `npx` command instead.

### B6. Auto-publish to npm
A GitHub Action publishes the assembled `claude-browser` package on `v*` tag:
- Build + assemble the publishable package → `npm publish` (provenance optional).
- Gated on `secrets.NPM_TOKEN`: if absent, the job logs a skip and succeeds (so tag releases still produce the extension zip via the existing release workflow). Activated once the user adds `NPM_TOKEN`.

### B7. Extension distribution
Two no-clone paths: (a) the **release zip** (already automated) → Load unpacked; (b) `npx claude-browser extension-path` → prints the bundled `extension/` path → Load unpacked. Chrome Web Store is a documented follow-up.

## 7. Error handling
- `getProfileUserInfo` failures / not-signed-in → resolver returns `null` → label falls back gracefully (never throws in the popup or background).
- Broker-entry not found → MCP client throws a clear, actionable error naming both probed paths.
- npm publish without `NPM_TOKEN` → graceful skip, not a failure.

## 8. Testing
- **Extension:** label resolution (custom > email > default) with a mocked `chrome.identity.getProfileUserInfo`; popup renders the resolved name, contains the GitHub link + version; `applyLabelInput` sets/clears custom. (`chromeMock` gains `identity`.)
- **mcp-server:** broker-entry resolver picks packaged vs dev path (inject a fake existence check); spawn options include `detached` + `windowsHide`; CLI argv dispatch (`extension-path` prints a path, no-args starts MCP).
- **Packaging:** a script test asserts the assembled package contains `dist/mcp.js`, `dist/broker.js`, `extension/manifest.json`, and a valid `bin`.
- **CI:** add `windows-latest` to the existing CI matrix for the hermetic unit suite (catches Windows-path/spawn regressions). Keep `ubuntu-latest` Node 20.
- Real-Chrome integration/soak unchanged (still env-gated).

## 9. Open decisions (resolved)
- Package name: `claude-browser`, scoped fallback `@michael-ltm/claude-browser`.
- Profile name: email local-part (not full email), custom override wins.
- No always-on daemon by default (auto-spawn); launchd retained but dormant.
- npm publish wired but inert until `NPM_TOKEN` is added.
