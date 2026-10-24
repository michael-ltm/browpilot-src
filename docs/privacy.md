# Browpilot privacy policy

Effective version: 0.2.1. Browpilot was previously named claude-browser.

Browpilot connects a browser extension to a local companion so an AI client selected by you can operate browser profiles and inspect pages. The companion and extension have no built-in hosted data collection service or analytics.

## Information processed

Depending on invoked tools, Browpilot processes tab titles and URLs, screenshots, page text and DOM/accessibility information, entered values, JavaScript results, console messages, script sources, network requests/responses and WebSocket messages. These may contain personal or confidential information. The legacy browser-history RPC can access browsing history when its permission is granted. Where the browser identity API makes it available, the local part of your Google email supplies a default profile label, which you can replace.

The websites and operations you choose determine the information processed. Requested page content, screenshots, form values and network records may include personal identifiers, health information, financial or payment information, authentication information, personal communications, location information, browsing history, interaction activity and other website content. These categories are handled as part of the requested browser task, not as separate analytics or profiling collections.

The companion reads browser installation paths, profile directories and extension installation metadata. Discovery does not read cookies or login databases, and installation does not modify browser Preferences. Registered profiles and verified instance bindings are persisted locally.

## Storage and transfers

Extension identity, labels, settings and status use browser local extension storage. Companion configuration and catalog are under `.claude-browser` in your home directory. Console and protocol-event buffers are bounded and held in process memory. Dedicated developer profiles are retained under `.claude-browser/developer-profiles` unless you select another directory.

Tool results are sent to the MCP client you connect. That client and its AI provider may process, store or transmit them under their own policies. Remote HTTP MCP uses your configured tunnel/proxy, whose operator can process traffic under its policies. Browpilot has no built-in sale of data, advertising, third-party analytics or model-training collection. These statements do not describe your AI provider's practices.

## Limited use

Browpilot uses requested browser data only to provide its browser inspection, automation and debugging functionality. Transfers to your selected MCP client and configured proxy are for that functionality. Browpilot does not sell this data, use or transfer it for advertising, determine creditworthiness, or operate a service for developer access to your browsing data. Its use and transfer of information follow the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Your choices

Connect only the profiles you intend to expose to your chosen AI client. Disconnect the client, stop the companion, disable/uninstall the extension, or delete local configuration and developer directories after stopping their processes. Browpilot does not retain permanent console/network logs by default; results already delivered to a client remain subject to its retention controls.

## Contact and changes

Project contact: [issue tracker](https://github.com/michael-ltm/browpilot/issues). Do not include private browsing data in public issues. A publisher distributing this build must provide accurate developer contact details and host this policy at a public URL linked from their listing. Changes in data processing must be reflected here and in store disclosures.
