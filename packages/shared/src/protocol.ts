// packages/shared/src/protocol.ts  — THE FIXED CONTRACT. Use these exact names/types everywhere.

export type Role = 'browser' | 'agent';

export interface JsonRpcRequest<P = unknown> { jsonrpc: '2.0'; id: number | string; method: string; params?: P; }
export interface JsonRpcNotification<P = unknown> { jsonrpc: '2.0'; method: string; params?: P; }
export interface JsonRpcSuccess<R = unknown> { jsonrpc: '2.0'; id: number | string; result: R; }
export interface JsonRpcErrorResponse { jsonrpc: '2.0'; id: number | string | null; error: { code: number; message: string; data?: unknown }; }
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcErrorResponse;

export const ErrorCode = {
  PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603,
  EXTENSION_DISCONNECTED: 1001, TAB_NOT_FOUND: 1002, STALE_REF: 1003, CDP_ERROR: 1004, LEASE_DENIED: 1005, TIMEOUT: 1006, UNAUTHORIZED: 1007, AMBIGUOUS_PROFILE: 1008,
} as const;

// Methods: agent -> extension (routed by broker). Constant values are the wire 'method' strings.
export const Method = {
  EXECUTE_CDP: 'executeCdp', GET_TABS: 'getTabs', NEW_TAB: 'newTab', SWITCH_TAB: 'switchTab',
  CLOSE_TAB: 'closeTab', GET_HISTORY: 'getHistory', ATTACH: 'attach', DETACH: 'detach',
  GET_CONSOLE: 'getConsole', SUBSCRIBE_EVENTS: 'subscribeEvents', GET_EVENTS: 'getEvents', PING: 'ping',
  LIST_PROFILES: 'listProfiles', GET_PROFILE_STATUS: 'getProfileStatus', GET_PROFILE_LOGS: 'getProfileLogs',
} as const;

// Notifications: extension -> agent (routed/buffered by broker)
export const Notif = { ON_CDP_EVENT: 'onCDPEvent', ON_CONSOLE: 'onConsole', ON_STATUS: 'onStatus', ON_PROFILE_CHANGE: 'onProfileChange' } as const;

export interface CdpTarget { tabId?: number; targetId?: string; }
export interface ExecuteCdpParams { target: CdpTarget; method: string; params?: Record<string, unknown>; timeoutMs?: number; browserId?: string; }
export type ExecuteCdpResult = unknown;
export interface AttachParams { tabId: number; browserId?: string; }
export interface DetachParams { tabId: number; browserId?: string; }
export interface TabInfo { id: number; url?: string; title?: string; active?: boolean; windowId?: number; }
export interface GetTabsParams { browserId?: string; }
export interface GetTabsResult { tabs: TabInfo[]; }
export interface NewTabParams { url?: string; browserId?: string; }
export type NewTabResult = TabInfo;
export interface SwitchTabParams { tabId: number; browserId?: string; }
export interface CloseTabParams { tabId: number; browserId?: string; }
export interface GetHistoryParams { query: string; limit?: number; browserId?: string; }
export interface HistoryEntry { url: string; title?: string; lastVisitTime?: number; visitCount?: number; }
export interface GetHistoryResult { entries: HistoryEntry[]; }
export interface ConsoleEntry { tabId: number; level: string; text: string; timestamp: number; args?: unknown[]; url?: string; line?: number; }
export interface GetConsoleParams { tabId?: number; filter?: string; since?: number; browserId?: string; }
export interface GetConsoleResult { entries: ConsoleEntry[]; }
// Generic CDP event capture: subscribe by method prefix (e.g. 'Network.', 'Debugger.'),
// the broker buffers matching forwarded events, then GET_EVENTS reads them.
export interface CdpEvent { tabId?: number; method: string; params: unknown; timestamp: number; }
export interface SubscribeEventsParams { prefixes: string[]; replace?: boolean; browserId?: string; }
export interface SubscribeEventsResult { prefixes: string[]; }
export interface GetEventsParams { tabId?: number; methodPrefix?: string; since?: number; limit?: number; clear?: boolean; browserId?: string; }
export interface GetEventsResult { events: CdpEvent[]; }
export interface OnCdpEventParams { source: CdpTarget; method: string; params: unknown; }
export type OnConsoleParams = ConsoleEntry;
export interface OnStatusParams { state: 'connected' | 'disconnected' | 'reconnecting' | 'waiting'; detail?: string; }

// Auth handshake: FIRST message each client sends after the socket opens.
export interface AgentHello { type: 'hello'; role: 'agent'; token: string; sessionId: string; }
export interface BrowserHello { type: 'hello'; role: 'browser'; extensionId: string; instanceId: string; label: string; }
export type Hello = AgentHello | BrowserHello;

export type ProfileStatus = 'connected' | 'disconnected' | 'reconnecting';
export interface ProfileInfo {
  browserId: string;
  label: string;
  status: ProfileStatus;
  connectedAt: number;
  lastSeen: number;
  lastError?: { message: string; at: number };
  reconnectCount: number;
  tabCount: number;
}
export interface ProfileEvent { at: number; kind: 'connect' | 'disconnect' | 'error' | 'reconnect'; detail?: string; }
export interface ListProfilesResult { profiles: ProfileInfo[]; }
export interface GetProfileStatusParams { browserId?: string; }
export interface GetProfileLogsParams { browserId?: string; limit?: number; }
export interface GetProfileLogsResult { events: ProfileEvent[]; }
export interface AmbiguousProfileData { profiles: ProfileInfo[]; }
export interface OnProfileChangeParams extends ProfileInfo {}

export interface Config { port: number; token: string; extensionId: string; }
export const DEFAULT_PORT = 8787;
export const CONFIG_DIR = '.claude-browser';   // under os.homedir()
export const CONFIG_FILE = 'config.json';
