# Browpilot Implementation Plan

> **For agentic workers:** Use subagent-driven-development for bounded tasks and review; execute continuously under the user's existing authorization.

**Goal:** Deliver local browser lifecycle management, generic MCP access, extension development tools and a publishable Browpilot brand.

**Architecture:** Broker owns inventory/launch and pairing. MCP adds client-neutral lifecycle and developer tools and an authenticated HTTP transport. Extension keeps stable identity and supplies a pairing page.

**Tech Stack:** TypeScript, Node >=20, Chrome MV3, existing MCP SDK, ws, zod, Vitest.

**Spec:** docs/superpowers/specs/2026-09-12-browpilot-design.md

## Global Constraints

- Preserve `.claude-browser`, existing storage keys, manifest key and legacy command compatibility.
- Chrome, Edge and Chromium discovery: Linux, macOS, Windows; never write browser Preferences.
- Launch using argument arrays; only selected profiles; persist verified nonce bindings.
- Never replay dispatched mutations; timeout explicitly.
- HTTP binds loopback and requires a bearer token, with independent sessions.
- No store IDs, hosted URLs or cross-platform test results may be invented.

## Tasks

1. [x] Local inventory and launcher: `packages/broker/src/local/`, `packages/shared/src/local.ts`, tests. Export `LocalBrowserManager` with `list`, `register`, `ensure`, `openInstall`, `pair`, `canResolve`. Dependencies provide connected IDs, store configuration and config directory. RED fixture and concurrency/nonce tests, implement, GREEN.
2. [x] Integrate lifecycle RPC and extension pairing: broker server/router, shared Method constants, MCP instance tools, extension pairing entry. RED broker and tool routing tests, implement, GREEN. Do not disturb existing browser routing.
3. [x] Generic CLI and HTTP MCP: CLI command parsing/registration and per-session authenticated HTTP server. RED CLI, unauthorized request and session-isolation tests, implement, GREEN. Document Grok HTTPS tunnel configuration.
4. [x] Developer CDP: dedicated profile launcher, direct target/session transport and MCP target/context/command/event tools. RED simulated CDP tests, implement, GREEN; smoke test isolated Chrome when available.
5. [x] Branding and distribution: deterministic SVG + PNG sizes, popup branding, npm compatibility, store archive builder, README, privacy and permission copy. Validate packaged manifest/files and inspect icon.
6. [x] Review and verification: full tests, tsc, build, archive content; real browser discovery/launch/MCP smoke checks where available; fix findings and record limitations.

## Decisions and progress

- User approved implementation in this session; proceed without another design/plan permission gate.
- Work uses feature branch `feat/browpilot` in the shared workspace; initial Git sandbox restriction resolved with an authorized branch creation.
- Initial sandboxed baseline: 249 passed, 8 socket permission failures and one process-output failure. Rerun with local sockets allowed before treating these as product defects.

- Final automated suite: 51 files / 333 tests passed with local sockets permitted. All workspace type checks and builds passed.
- Independent reviews of local lifecycle, developer CDP, HTTP shutdown and profile-generation guards completed; actionable findings fixed and rechecked.
- Real Chromium 151 on Linux passed extension handshake, offline installation evidence, cold-start nonce pairing, MCP tabs, automatic restart, persisted binding, and evaluation in a second independent extension worker.
- Chromium cold startup initially blocked the pairing entry before extension load. A bounded one-shot recovery of the exact nonce page fixed the real-browser reproduction.
- Built companion package plus Chrome/Edge store ZIPs; verified archive resources, CRC, version and omitted development key/maps.
- Full evidence and unavailable environments are recorded in `docs/verification-0.2.0.md`. Publication remains pending actual publisher credentials, listing IDs/URLs and review.
