# Browpilot store submission materials

Name: **Browpilot — Browser MCP for AI Agents**

Short description: Connect your browser to Codex, Claude Code and MCP clients. Control tabs, inspect pages and reconnect to selected profiles.

## Full description

Let your chosen AI client work with your browser through the Model Context Protocol. Browpilot connects a browser extension to a local companion, with profile selection, screenshots, page inspection, clicks, typing and developer tools.

Discover Chrome, Edge and Chromium profiles with the companion, open a selected profile, and reconnect after interruptions. Advanced users can launch a dedicated profile for extension development and debugging.

Requires the Browpilot local companion and an MCP-capable client. Codex and Claude Code connect locally. Grok remote MCP requires a separately configured authenticated HTTPS connection. Installing this extension alone does not install the companion or create that connection.

Browpilot is independent and is not affiliated with OpenAI, Anthropic, xAI, Google or Microsoft. Browsers may display a debugging indicator while tools are attached. Installing extensions requires confirmation in the browser.

## Permission purposes

| Permission | Current use |
| --- | --- |
| `debugger` | Requested page screenshots, input, DOM inspection, JavaScript, network and debugger commands |
| `tabs` | Enumerate, create, activate and close tabs in the selected profile |
| `history` | Legacy `getHistory` RPC when invoked by a compatible integration; no automatic history collection |
| `alarms` | Wake the service worker and retry the local companion connection |
| `storage` | Local identity, profile labels, settings and status |
| `identity`, `identity.email` | Default profile label from the Google email local part, when available |

Justify each permission against the submitted build. If dropping a legacy capability, remove its permission and implementation together and re-test. Do not claim zero data transfer: requested results reach the user's AI client.

## Publisher steps

1. Run `npm run build:store` and inspect both archives. Their root contains `manifest.json`. Development key and source maps are excluded.
2. Create Chrome Web Store and Microsoft Partner Center listings with the publisher's identity and accurate contact information.
3. Host the actual privacy policy at a public HTTPS URL and enter it in both listings. Match data-use disclosures to actual extension, AI-client and tunnel behavior.
4. Capture screenshots of the submitted extension and profile workflow. Use `packages/extension/icons/icon128.png` as the store icon.
5. Record store-assigned IDs and listing URLs. Add them to the companion allowlist/store configuration, then test store-installed and unpacked builds together.
6. Smoke-test Chrome and Edge on each advertised OS: install, first pair, ordinary-profile restart, simultaneous profiles, disable/uninstall and reconnect.
7. Submit for review. Accounts, public URLs, actual IDs and acceptance are external prerequisites; generating a ZIP does not satisfy them.

## Brand and migration

Colors: navy `#0b1629`, teal `#2dd4bf`, off-white `#d9f5f1`. Icon: browser window and navigation arrow, without AI-vendor marks. Editable source: `packages/extension/icons/browpilot.svg`; PNGs: 16, 32, 48 and 128 pixels. Reproduce with ImageMagick, for example `magick -background none packages/extension/icons/browpilot.svg -resize 128x128 packages/extension/icons/icon128.png`.

Display branding is Browpilot. The npm package remains `@john523100/claude-browser`, exposing both `browpilot` and `claude-browser` commands. Workspace package names and configuration keys remain stable. Check name availability and publisher identity in the target stores before submission.
