# Browpilot 0.2.1 permission audit

Chrome rejected 0.2.0 on September 16, 2026 for `Use of Permissions`, reference `Purple Potassium`: the manifest requested `scripting`, but the extension did not use it. Inspected in the publisher dashboard on September 23 (America/Los_Angeles).

## Changes

- Removed `scripting` from the source manifest, unpacked distribution and store packages. No active source code invokes `chrome.scripting`; the legacy cursor file's injection comment was misleading and has been corrected.
- Removed `host_permissions: ["<all_urls>"]`. Requested page interaction uses the `debugger` API; tab metadata uses `tabs`. There is no cross-origin fetch or content-script injection that needs a host grant.
- The separate `web_accessible_resources.matches` entry exposes only listed extension resources. It is not a host permission or permission to read website data.
- Cold-start recovery navigates our validated nonce-bearing pairing URL using `tabs.update`, rather than reloading a Chromium blocked-document state. Pairing still accepts messages only from our own extension page, validates the nonce and verifies the connection at the broker.

## Remaining requested permissions

| Permission | Actual use |
| --- | --- |
| debugger | `background/relay.ts`: attach, detach, sendCommand and event forwarding for user-requested page debugging, snapshots, screenshots and input. |
| tabs | `background/helpers.ts`: return URL/title metadata, create/activate/close tabs. `background/pairing.ts`: identify and recover only our nonce-bearing pairing page. |
| history | `background/helpers.ts` / `background/index.ts`: registered GET_HISTORY RPC invokes `chrome.history.search` only when explicitly requested by a compatible client. |
| alarms | `background/transport.ts` / `background/index.ts`: reconnect and keepalive alarms. |
| storage | `background/config.ts`, `transport.ts`, `popup/popup.ts`: local profile identity, labels, settings and connection status. |
| identity, identity.email | `background/config.ts`: `getProfileUserInfo` supplies a default profile label when the user has not set one. |

No new permission was added. The reviewer setup guide explains the local companion required to exercise these functions.

Policy: https://developer.chrome.com/docs/webstore/program-policies/permissions

Debugger API: https://developer.chrome.com/docs/extensions/reference/api/debugger
