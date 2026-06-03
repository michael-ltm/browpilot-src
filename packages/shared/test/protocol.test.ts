import { describe, it, expect } from 'vitest';
import {
  Method,
  Notif,
  ErrorCode,
  DEFAULT_PORT,
  CONFIG_DIR,
  CONFIG_FILE,
  isJsonRpcMessage,
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcSuccess,
  isJsonRpcError,
  type JsonRpcRequest,
  type ExecuteCdpParams,
} from '../src/index.js';

describe('Method constant wire values', () => {
  it('maps every method name to its exact wire string', () => {
    expect(Method).toEqual({
      EXECUTE_CDP: 'executeCdp',
      GET_TABS: 'getTabs',
      NEW_TAB: 'newTab',
      SWITCH_TAB: 'switchTab',
      CLOSE_TAB: 'closeTab',
      GET_HISTORY: 'getHistory',
      ATTACH: 'attach',
      DETACH: 'detach',
      GET_CONSOLE: 'getConsole',
      SUBSCRIBE_EVENTS: 'subscribeEvents',
      GET_EVENTS: 'getEvents',
      PING: 'ping',
      LIST_PROFILES: 'listProfiles',
      GET_PROFILE_STATUS: 'getProfileStatus',
      GET_PROFILE_LOGS: 'getProfileLogs',
    });
  });
});

describe('Notif constant wire values', () => {
  it('maps every notification name to its exact wire string', () => {
    expect(Notif).toEqual({
      ON_CDP_EVENT: 'onCDPEvent',
      ON_CONSOLE: 'onConsole',
      ON_STATUS: 'onStatus',
      ON_PROFILE_CHANGE: 'onProfileChange',
    });
  });
});

describe('ErrorCode constant values', () => {
  it('uses the JSON-RPC reserved range for protocol errors', () => {
    expect(ErrorCode.PARSE).toBe(-32700);
    expect(ErrorCode.INVALID_REQUEST).toBe(-32600);
    expect(ErrorCode.METHOD_NOT_FOUND).toBe(-32601);
    expect(ErrorCode.INVALID_PARAMS).toBe(-32602);
    expect(ErrorCode.INTERNAL).toBe(-32603);
  });

  it('uses the 1001+ range for application errors', () => {
    expect(ErrorCode.EXTENSION_DISCONNECTED).toBe(1001);
    expect(ErrorCode.TAB_NOT_FOUND).toBe(1002);
    expect(ErrorCode.STALE_REF).toBe(1003);
    expect(ErrorCode.CDP_ERROR).toBe(1004);
    expect(ErrorCode.LEASE_DENIED).toBe(1005);
    expect(ErrorCode.TIMEOUT).toBe(1006);
    expect(ErrorCode.UNAUTHORIZED).toBe(1007);
    expect(ErrorCode.AMBIGUOUS_PROFILE).toBe(1008);
  });
});

describe('config constants', () => {
  it('pins the default port and config location', () => {
    expect(DEFAULT_PORT).toBe(8787);
    expect(CONFIG_DIR).toBe('.claude-browser');
    expect(CONFIG_FILE).toBe('config.json');
  });
});

describe('isJsonRpcRequest', () => {
  it('accepts a well-formed request with params', () => {
    const params: ExecuteCdpParams = {
      target: { tabId: 7 },
      method: 'Page.navigate',
      params: { url: 'https://example.com' },
    };
    const req: JsonRpcRequest<ExecuteCdpParams> = {
      jsonrpc: '2.0',
      id: 1,
      method: Method.EXECUTE_CDP,
      params,
    };
    expect(isJsonRpcRequest(req)).toBe(true);
    expect(isJsonRpcMessage(req)).toBe(true);
  });

  it('accepts a string id and omitted params', () => {
    expect(isJsonRpcRequest({ jsonrpc: '2.0', id: 'abc', method: 'ping' })).toBe(true);
  });

  it('rejects a notification (no id)', () => {
    expect(isJsonRpcRequest({ jsonrpc: '2.0', method: 'onCDPEvent' })).toBe(false);
  });

  it('rejects a success response (has result, no method)', () => {
    expect(isJsonRpcRequest({ jsonrpc: '2.0', id: 1, result: {} })).toBe(false);
  });

  it('rejects wrong jsonrpc version', () => {
    expect(isJsonRpcRequest({ jsonrpc: '1.0', id: 1, method: 'ping' })).toBe(false);
  });

  it('rejects non-object inputs', () => {
    expect(isJsonRpcRequest(null)).toBe(false);
    expect(isJsonRpcRequest(undefined)).toBe(false);
    expect(isJsonRpcRequest('ping')).toBe(false);
    expect(isJsonRpcRequest(42)).toBe(false);
  });
});

describe('isJsonRpcNotification', () => {
  it('accepts a method without an id', () => {
    expect(isJsonRpcNotification({ jsonrpc: '2.0', method: Notif.ON_STATUS, params: { state: 'connected' } })).toBe(true);
  });

  it('rejects a request (has id)', () => {
    expect(isJsonRpcNotification({ jsonrpc: '2.0', id: 1, method: 'ping' })).toBe(false);
  });
});

describe('isJsonRpcSuccess', () => {
  it('accepts a result with an id', () => {
    expect(isJsonRpcSuccess({ jsonrpc: '2.0', id: 1, result: { tabs: [] } })).toBe(true);
  });

  it('accepts a null/undefined result value as long as the key is present', () => {
    expect(isJsonRpcSuccess({ jsonrpc: '2.0', id: 2, result: null })).toBe(true);
  });

  it('rejects an error response', () => {
    expect(isJsonRpcSuccess({ jsonrpc: '2.0', id: 1, error: { code: 1001, message: 'x' } })).toBe(false);
  });

  it('rejects a request', () => {
    expect(isJsonRpcSuccess({ jsonrpc: '2.0', id: 1, method: 'ping' })).toBe(false);
  });
});

describe('isJsonRpcError', () => {
  it('accepts a well-formed error with numeric id', () => {
    expect(isJsonRpcError({ jsonrpc: '2.0', id: 1, error: { code: ErrorCode.TAB_NOT_FOUND, message: 'no tab' } })).toBe(true);
  });

  it('accepts a null id (parse error before id known)', () => {
    expect(isJsonRpcError({ jsonrpc: '2.0', id: null, error: { code: ErrorCode.PARSE, message: 'bad json' } })).toBe(true);
  });

  it('rejects an error whose error.code is not a number', () => {
    expect(isJsonRpcError({ jsonrpc: '2.0', id: 1, error: { code: 'oops', message: 'x' } })).toBe(false);
  });

  it('rejects an error missing the message', () => {
    expect(isJsonRpcError({ jsonrpc: '2.0', id: 1, error: { code: 1001 } })).toBe(false);
  });
});

describe('isJsonRpcMessage', () => {
  it('accepts every variant of the union', () => {
    expect(isJsonRpcMessage({ jsonrpc: '2.0', id: 1, method: 'ping' })).toBe(true);
    expect(isJsonRpcMessage({ jsonrpc: '2.0', method: 'onCDPEvent', params: {} })).toBe(true);
    expect(isJsonRpcMessage({ jsonrpc: '2.0', id: 1, result: 'ok' })).toBe(true);
    expect(isJsonRpcMessage({ jsonrpc: '2.0', id: 1, error: { code: 1004, message: 'cdp' } })).toBe(true);
  });

  it('rejects junk and malformed frames', () => {
    expect(isJsonRpcMessage({})).toBe(false);
    expect(isJsonRpcMessage({ jsonrpc: '2.0' })).toBe(false);
    expect(isJsonRpcMessage({ jsonrpc: '2.0', id: 1 })).toBe(false);
    expect(isJsonRpcMessage(null)).toBe(false);
  });
});

describe('multi-profile contract', () => {
  it('adds profile methods, notif, and error code', () => {
    expect(Method.LIST_PROFILES).toBe('listProfiles');
    expect(Method.GET_PROFILE_STATUS).toBe('getProfileStatus');
    expect(Method.GET_PROFILE_LOGS).toBe('getProfileLogs');
    expect(Notif.ON_PROFILE_CHANGE).toBe('onProfileChange');
    expect(ErrorCode.AMBIGUOUS_PROFILE).toBe(1008);
  });
});
