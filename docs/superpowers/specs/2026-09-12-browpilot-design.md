# Browpilot product design

Approved in conversation on 2026-09-12: implement browser discovery and on-demand startup, extension installation guidance, generic MCP clients, developer extension debugging, and Browpilot branding/store materials. Approval covers implementation and verification, not publishing an unreviewed release.

## Architecture

Keep extension → local WebSocket Broker → stdio MCP. Add a broker-owned local browser catalog, persisted profile bindings, and a launcher. Inventory identifies a browser executable, user-data directory, and profile directory separately from the extension's runtime UUID. Discover Chrome, Edge and Chromium on Linux/macOS/Windows; explicit custom directories are supported. Installation states are enabled, disabled, installed/unknown, absent, or unknown; connection state is separate. Never infer absence merely from disconnection.

Opening a profile launches its exact executable with argument arrays, user-data-dir and profile-directory. Pair through an extension page carrying a short-lived random nonce that the broker resolves to the launched local profile; persist only a verified binding. Ensure-connected deduplicates concurrent launches, waits with a deadline, and never retries already dispatched mutating commands. Rebuild tabs and snapshots after browser restart. Installation opens the configured store URL or gives unpacked installation guidance, with explicit user confirmation in browser.

Keep the existing configuration directory, storage keys, extension manifest key and legacy npm command compatible. Support an allowlist of Chrome/Edge store IDs rather than weakening Origin validation. Store IDs and listing URLs are release configuration, never invented.

Add authenticated loopback Streamable HTTP MCP for remote clients through a separately configured HTTPS tunnel. Each HTTP session owns an independent MCP context and broker connection. Do not expose the raw broker or provision a public tunnel automatically. Codex and Claude Code use stdio; Grok remote clients use HTTP. Both installations and generated configuration are available from the CLI.

Developer mode uses a dedicated, non-default user-data directory and direct CDP. Tools list targets, attach, select execution contexts, send commands, and collect events including target/session identity. Worker targets do not receive page emulation commands. Keep browser debugging ports on loopback. Browser compatibility is evidenced per tested environment; no claim of unrestricted extension access.

Browpilot uses a navy browser-window mark with a teal navigation arrow. Rename product-facing text and provide reproducible vector/icon assets, packaged extension archives, privacy/permission explanations, and store copy. Preserve functional identifiers for migration. Chrome and Edge publication still needs publisher-provided listing IDs, hosted privacy URL and actual review.

## Acceptance

Fixture tests cover OS discovery, malformed/locked profiles, extension states, path validation, launch failures, nonce expiry, binding persistence, ambiguous matches and concurrent ensure calls. Integration tests cover broker routing/pairing and authenticated HTTP sessions. Existing tests, TypeScript and build must pass. Real-browser smoke tests use an isolated testing profile without closing or changing the user's daily browser. Record any unavailable OS or store verification honestly.
