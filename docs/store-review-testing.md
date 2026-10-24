# Browpilot 0.2.1 review instructions

Browpilot connects a user-selected local Chrome profile to MCP tools. The extension requires a companion running on the same computer. No Browpilot account, paid subscription, or hosted Browpilot service is required. Any AI provider account belongs to the client; reviewers can call tools directly from a stdio MCP client without an AI account.

## Install

1. Install Node.js 20 or newer and the extension package supplied to Chrome Web Store review.
2. Install the released companion:

   ```sh
   npm install -g https://github.com/michael-ltm/browpilot/releases/download/v0.2.1/john523100-claude-browser-0.2.1.tgz
   ```

3. Configure a stdio MCP client to execute `browpilot` with no arguments. The MCP client starts the companion automatically. For supported AI clients, `browpilot install codex` or `browpilot install claude` registers it; restart that client afterwards. `browpilot config codex` and `browpilot config claude` print configuration if automatic registration is unavailable.
4. The store extension ID `kglhakgapoegbnnbobnmnebmbljehcid` is already allowed by the companion. For an unpacked review copy, run `browpilot extension-path` and load the bundled directory using Chrome's Developer mode and Load unpacked. It is the same extension version, with the development ID supported by the companion.

## Exercise the core feature

1. Call `browser_list_instances` with `{}`. Find the browser profile where Browpilot is installed. Installation evidence and connection are reported separately.
2. Call `browser_open_instance` with `{"id":"<exact id returned above>","timeoutMs":60000}`. This opens the selected browser if needed and opens a local pairing tab. Allow that tab to complete pairing. The popup should show the connected companion.
3. Call `browser_get_tabs` with `{}`. The returned list should contain the selected profile's actual open tabs.
4. Open a harmless page such as `https://example.com` in that profile. Use the MCP client's displayed tool schema to call `browser_snapshot` for that page, then take a screenshot or inspect its text. Chrome displays its standard debugger notice while debugging is attached.
5. Close that test profile normally, then repeat a read call from the same selected MCP session. Browpilot can reopen an identified local profile and reconnect. Refresh tab IDs and snapshots after restarting.

For a nonstandard browser installation, `browser_register_instance` accepts its browser type, executable, user-data directory and profile directory. No browser credentials should be sent to us.

## Expected boundaries

- The popup can report disconnected until the local MCP companion starts and pairing completes. This is an expected idle state.
- User confirmation is required to install extensions. Browser-protected pages may reject inspection.
- Companion communication uses local loopback; no cloud service or external account is necessary for these review steps.
- Remote HTTP MCP is optional, requires a bearer secret, and requires the user's own HTTPS proxy for cloud clients. It is not needed to review the extension.
- Debugging another extension uses a separate explicit developer CDP session. Normal web page JavaScript cannot access other extensions' isolated execution contexts.

Support: https://github.com/michael-ltm/browpilot/issues

Privacy: https://github.com/michael-ltm/browpilot/blob/main/privacy.md
