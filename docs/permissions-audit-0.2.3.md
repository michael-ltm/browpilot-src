# Browpilot 0.2.3 permission audit

0.2.3 adds one permission, `management`. All other permissions are unchanged from 0.2.1/0.2.2. There are still no host permissions and no `scripting`.

## New permission

| Permission | Actual use |
| --- | --- |
| management | `background/extensions.ts`, only when the user's MCP client invokes the `browser_extensions` tool: `chrome.management.getAll`/`get` list installed extensions (id, name, version, enabled state, options page), and `chrome.management.setEnabled` enables, disables or reloads (disable + enable) an extension the user names. This supports developers who use Browpilot to build and debug their own extensions: after editing an unpacked extension, the agent reloads it and reads its state. Browpilot never changes other extensions on its own, never uninstalls or installs anything, and cannot disable itself. |

`chrome.runtime.sendMessage(id, message)` to another extension's `onMessageExternal` and `chrome.tabs.create` for its options page need no additional permission.

## Requested permissions

| Permission | Actual use |
| --- | --- |
| debugger | `background/relay.ts`: attach, detach, sendCommand and event forwarding for user-requested page debugging, snapshots, screenshots and input. |
| tabs | `background/helpers.ts`: return URL/title metadata, create/activate/close tabs. `background/pairing.ts`: identify and recover only our nonce-bearing pairing page. |
| history | `background/helpers.ts` / `background/index.ts`: registered GET_HISTORY RPC invokes `chrome.history.search` only when explicitly requested by a compatible client. |
| alarms | `background/transport.ts` / `background/index.ts`: reconnect and keepalive alarms. |
| storage | `background/config.ts`, `transport.ts`, `popup/popup.ts`: local profile identity, labels, settings and connection status. |
| identity, identity.email | `background/config.ts`: `getProfileUserInfo` supplies a default profile label when the user has not set one. |
| management | `background/extensions.ts`: see above. |

Policy: https://developer.chrome.com/docs/webstore/program-policies/permissions

Management API: https://developer.chrome.com/docs/extensions/reference/api/management
