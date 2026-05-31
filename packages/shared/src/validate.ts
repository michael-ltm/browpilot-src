import type {
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcSuccess,
  JsonRpcErrorResponse,
} from './protocol.js';

/** True for any non-null object (the only shape a JSON-RPC frame can take). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A valid JSON-RPC id is a number or a string. */
function isId(value: unknown): value is number | string {
  return typeof value === 'number' || typeof value === 'string';
}

/** Every frame in this protocol carries jsonrpc: '2.0'. */
function hasJsonRpcVersion(value: Record<string, unknown>): boolean {
  return value['jsonrpc'] === '2.0';
}

/** Request: jsonrpc '2.0' + id (number|string) + string method. */
export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return (
    isObject(value) &&
    hasJsonRpcVersion(value) &&
    isId(value['id']) &&
    typeof value['method'] === 'string'
  );
}

/** Notification: jsonrpc '2.0' + string method + NO id. */
export function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  return (
    isObject(value) &&
    hasJsonRpcVersion(value) &&
    !('id' in value) &&
    typeof value['method'] === 'string'
  );
}

/** Success: jsonrpc '2.0' + id (number|string) + the 'result' key present + no 'error'. */
export function isJsonRpcSuccess(value: unknown): value is JsonRpcSuccess {
  return (
    isObject(value) &&
    hasJsonRpcVersion(value) &&
    isId(value['id']) &&
    'result' in value &&
    !('error' in value)
  );
}

/** Error: jsonrpc '2.0' + id (number|string|null) + well-formed { code:number, message:string } error. */
export function isJsonRpcError(value: unknown): value is JsonRpcErrorResponse {
  if (!isObject(value) || !hasJsonRpcVersion(value)) return false;
  if (!(isId(value['id']) || value['id'] === null)) return false;
  const err = value['error'];
  return (
    isObject(err) &&
    typeof err['code'] === 'number' &&
    typeof err['message'] === 'string'
  );
}

/** True if the value is any member of the JsonRpcMessage union. */
export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return (
    isJsonRpcRequest(value) ||
    isJsonRpcNotification(value) ||
    isJsonRpcSuccess(value) ||
    isJsonRpcError(value)
  );
}
