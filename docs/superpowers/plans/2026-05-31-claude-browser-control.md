# claude-browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Codex-style, never-needs-manual-reconnect browser-control system for Claude Code — a thin MV3 CDP-relay Chrome extension + a persistent launchd broker daemon + a per-session MCP server exposing hybrid vision/DOM `browser_*` tools.

**Architecture:** Three decoupled processes speaking JSON-RPC 2.0 over loopback WebSocket. The broker is the only long-lived anchor (survives MCP-server restarts); the extension self-heals via `chrome.alarms` service-worker revival + a 30s heartbeat (survives MV3 service-worker death). All computer-use logic lives in the MCP server; the extension is a dumb, stable CDP relay. See the design spec at `docs/superpowers/specs/2026-05-31-claude-browser-control-design.md`.

**Tech Stack:** TypeScript (strict, ESM), npm-workspaces monorepo, vitest, tsup (node builds), esbuild (extension bundle), `@modelcontextprotocol/sdk`, `ws`, `chrome-launcher`, `chrome.debugger`/CDP.

**Build order:** Milestones are strictly ordered — Shared (contract) → Broker → Extension → MCP Server → Install/Integration. Each milestone produces independently testable software. Within a milestone, tasks are sequential.

---


---

## ⚠️ Cross-Package Interface Reconciliation (READ FIRST — overrides conflicting inline code)

The five milestones were authored in parallel against the shared contract, so a few cross-package interfaces drifted. Where a milestone's inline code disagrees with the canonical form below, **this section wins** — apply the canonical form. R2 and R3 are logic bugs that typechecking will NOT catch; they must be applied or the headline soak/e2e tests fail (or silently reconnect-storm).

### R1 — Broker server factory & `BrokerServer` hooks (M2 + M5)
Canonical export from `@claude-browser/broker`: **`startServer(config: Config, deps?: ServerDeps): Promise<BrokerServer>`** (NOT `createServer`/`createBroker`). The `BrokerServer` interface MUST expose the members below (add any missing in `broker/src/server.ts`); the M5 integration/soak harness depends on them:

```ts
export interface BrokerServer {
  readonly port: number;                    // actual bound port (after ephemeral 0)
  close(): Promise<void>;
  hasBrowserConnection(): boolean;           // a browser socket is connected & authed
  onBrowserConnected(cb: () => void): void;  // fires when the browser (re)connects
  offBrowserConnected(cb: () => void): void;
  dropBrowserConnection(): void;             // force-close the current browser socket (soak-test hook)
}
```

M5 `test/integration/harness.ts` MUST `import { startServer } from '@claude-browser/broker'` and use these methods (replace its `createBroker`/`createServer` import and any `broker.*` calls accordingly).

### R2 — Broker MUST answer the extension's app-level `ping` (M2) — CRITICAL
The extension's 30s heartbeat sends a JSON-RPC **`ping` request** and tears down + reconnects if it does not get `{pong:true}` within 3s (this is also what keeps the MV3 service worker alive). The broker's `handleBrowserMessage` as written only handles browser **responses** and **notifications**, so a browser-originated `ping` request is silently dropped → heartbeat fails every 30s → permanent reconnect storm that defeats the project's purpose. Fix `broker/src/router.ts` `handleBrowserMessage` to answer a browser-originated request locally (the router already holds the browser-send fn it uses to forward agent requests — reuse it as `this.browserSend`):

```ts
handleBrowserMessage(msg: JsonRpcMessage): void {
  // Browser-originated REQUEST (has both id AND method): answer locally, do NOT route.
  if ('id' in msg && msg.id !== null && 'method' in msg) {
    const req = msg as JsonRpcRequest;
    if (req.method === Method.PING) {
      this.browserSend({ jsonrpc: '2.0', id: req.id, result: { pong: true } });
    } else {
      this.browserSend({ jsonrpc: '2.0', id: req.id,
        error: { code: ErrorCode.METHOD_NOT_FOUND, message: `No broker handler for ${req.method}` } });
    }
    return;
  }
  // ...existing response branch (id + result/error → resolve pending)...
  // ...existing notification branch (method, no id → buffer + broadcastToAgents)...
}
```

Add a broker router unit test: feed `{ jsonrpc:'2.0', id:1, method: Method.PING }` to `handleBrowserMessage` and assert a `{ pong:true }` response was sent on the browser link.

### R3 — Snapshot `ref` token format (M4 + M5)
Canonical (produced by `mcp-server/src/snapshot.ts` `compactAxTree`): outline lines are `[ref1] button "Submit"` — the token is **`[refN]`**, NOT `[ref=...]`. The M5 e2e test MUST parse refs with **`/\[(ref\d+)\]/g`** (capture group = the ref id passed to `browser_click_ref`). Replace any `[ref=...]` / `\[ref=([^\]]*)\]` parsing in `test/integration/e2e.test.ts` accordingly.

### R4 — mcp-server integration exports (M4 + M5)
Canonical exports from `@claude-browser/mcp-server`: `class BrokerClient` (ctor `{ port, token, sessionId }`; methods `connectWithRetry()`, `request()`, `close()`) and `registerAll(server: McpServer, ctx: ToolContext)`. To satisfy the M5 harness, ALSO export two thin wrappers from `mcp-server/src/index.ts` (factor M4's `main()` context-builder into a reusable `makeToolContext(client)`):

```ts
import { randomUUID } from 'node:crypto';
export async function createClient(opts: { port: number; token: string; sessionId?: string }): Promise<BrokerClient> {
  const client = new BrokerClient({ port: opts.port, token: opts.token, sessionId: opts.sessionId ?? randomUUID() });
  await client.connectWithRetry();
  return client;
}
export function registerTools(server: McpServer, client: BrokerClient): void {
  registerAll(server, makeToolContext(client));
}
```

M5 then imports `{ createClient, registerTools, type BrokerClient }` from `@claude-browser/mcp-server`.

### R5 — `renderLaunchdPlist` call site (M5)
Canonical signature: `renderLaunchdPlist({ nodePath, scriptPath, label? })`. M5 `scripts/install.ts` MUST call it with `{ nodePath: process.execPath, scriptPath: <absolute path to broker dist/index.js> }` (not `brokerEntry`/`workingDirectory`).

### R6 — Pinned extension id is single-sourced via config (M2 + M3 + M5)
`~/.claude-browser/config.json` `extensionId` is the one source of truth. M3 yields a deterministic id from the manifest `key`; the M5 installer computes that id from the manifest key and writes `config.extensionId`; the M2 broker reads `config.extensionId` for the `Origin: chrome-extension://<id>` allowlist. No package hardcodes the id.

---

# Milestone 1 — Scaffold + Shared Contract

## Package: Project Scaffold + `@claude-browser/shared`

This section establishes the npm-workspaces monorepo root and the `shared` package that holds **the fixed wire contract** (`protocol.ts`), a barrel re-export, and a tiny runtime validator. Every other package depends on these symbols, so this section must land first. No Chrome/Node-server logic lives here — pure types, constants, and one small validator function plus its tests.

All commands are run from the repo root `/Users/ming/Documents/code/ai/claude-ext` unless a different `cwd` is shown. The repo is already a git repo with a `.gitignore` containing `node_modules/ dist/ *.log .DS_Store`.

---

### Task 1: Root workspace scaffold (`package.json`)

**Files**
- Create: `/Users/ming/Documents/code/ai/claude-ext/package.json`

This is a pure-config task (no logic), so it shows the COMPLETE file and skips TDD sub-steps.

- [ ] **Step 1: Write the root `package.json`** with npm workspaces, root dev dependencies, and aggregate scripts. The root is `private` (workspaces roots must not be published). Scripts fan out to all workspaces with `npm run <script> --workspaces --if-present` so packages that don't define a script are skipped instead of failing.

```json
{
  "name": "claude-browser",
  "version": "0.1.0",
  "private": true,
  "description": "Codex-style stable browser control for Claude Code",
  "type": "module",
  "engines": {
    "node": ">=20"
  },
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "test": "npm run test --workspaces --if-present",
    "lint": "npm run lint --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "clean": "rm -rf packages/*/dist"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsup": "^8.3.5",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Verify npm accepts the workspace root.** This errors loudly if the JSON is malformed or the workspaces glob is wrong. (No `packages/*` exist yet, so it should report no workspaces but exit 0.)

```bash
cd /Users/ming/Documents/code/ai/claude-ext && npm pkg get workspaces
```

Expect output: `[ "packages/*" ]`.

- [ ] **Step 3: Commit.**

```bash
git -C /Users/ming/Documents/code/ai/claude-ext add package.json && \
git -C /Users/ming/Documents/code/ai/claude-ext commit -m "chore: scaffold npm workspaces root"
```

---

### Task 2: Shared TypeScript compiler base (`tsconfig.base.json`)

**Files**
- Create: `/Users/ming/Documents/code/ai/claude-ext/tsconfig.base.json`

Pure-config task — shows COMPLETE file, skips TDD sub-steps. Per the fixed tooling: strict, ES2022, ESM, `moduleResolution: "bundler"`. This base carries only compiler options (no `include`/`files`) so each package's `tsconfig.json` can `extend` it and set its own `include`/`outDir`.

- [ ] **Step 1: Write `tsconfig.base.json`.**

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "verbatimModuleSyntax": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": false,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "isolatedModules": true
  }
}
```

> Note: `exactOptionalPropertyTypes` is left `false` deliberately. The contract uses many `field?:` properties (e.g. `JsonRpcRequest.params?`, `TabInfo.url?`) that downstream packages assign `undefined` to; enabling it would force noise across every consumer for no safety gain in a wire-protocol type. `lib` is `ES2022` only (no `DOM`) because the shared package is environment-agnostic — the extension package adds DOM/Chrome libs in its own tsconfig.

- [ ] **Step 2: Verify the base file is valid JSON and parses as a tsconfig.** This must run after Task 3 installs TypeScript; for now just confirm it is well-formed JSON.

```bash
cd /Users/ming/Documents/code/ai/claude-ext && node -e "JSON.parse(require('fs').readFileSync('tsconfig.base.json','utf8')); console.log('tsconfig.base.json OK')"
```

Expect: `tsconfig.base.json OK`.

- [ ] **Step 3: Commit.**

```bash
git -C /Users/ming/Documents/code/ai/claude-ext add tsconfig.base.json && \
git -C /Users/ming/Documents/code/ai/claude-ext commit -m "chore: add shared tsconfig base (strict ES2022 ESM)"
```

---

### Task 3: `@claude-browser/shared` package scaffold (`package.json` + `tsconfig.json`)

**Files**
- Create: `/Users/ming/Documents/code/ai/claude-ext/packages/shared/package.json`
- Create: `/Users/ming/Documents/code/ai/claude-ext/packages/shared/tsconfig.json`

Pure-config task — shows COMPLETE files, skips TDD sub-steps. After writing them we run the root `npm install` so the workspace symlink for `@claude-browser/shared` is created (downstream packages import it by name).

- [ ] **Step 1: Create the package directory.**

```bash
mkdir -p /Users/ming/Documents/code/ai/claude-ext/packages/shared/src \
         /Users/ming/Documents/code/ai/claude-ext/packages/shared/test
```

- [ ] **Step 2: Write `packages/shared/package.json`.** ESM-only package built by `tsup`. `exports` maps the package root to the built ESM + types; `types` points at the declaration. `test` runs vitest in run-once mode (CI-friendly). `typecheck` runs `tsc --noEmit`. The build artifacts (`dist/`) are gitignored at the repo root already.

```json
{
  "name": "@claude-browser/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

- [ ] **Step 3: Write `packages/shared/tsconfig.json`.** Extends the base, compiles `src` and `test`, emits declarations to `dist`. `rootDir` is `.` so `tsc --noEmit` typechecks both `src/` and `test/` without complaining about files outside the root.

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "./dist",
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 4: Write `packages/shared/tsup.config.ts`** (build config; references `src/index.ts` which is created in Task 4 — the build is not run until Task 6).

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
});
```

- [ ] **Step 5: Install the workspace.** This creates `node_modules/@claude-browser/shared` symlinked to `packages/shared`, and installs the root dev deps (typescript, tsup, vitest, @types/node).

```bash
cd /Users/ming/Documents/code/ai/claude-ext && npm install
```

Expect: install completes; `ls -la node_modules/@claude-browser/shared` shows a symlink into `packages/shared`.

- [ ] **Step 6: Commit.**

```bash
git -C /Users/ming/Documents/code/ai/claude-ext add packages/shared/package.json packages/shared/tsconfig.json packages/shared/tsup.config.ts package-lock.json && \
git -C /Users/ming/Documents/code/ai/claude-ext commit -m "chore(shared): scaffold @claude-browser/shared package"
```

---

### Task 4: The fixed contract (`src/protocol.ts`) + barrel (`src/index.ts`)

**Files**
- Create: `/Users/ming/Documents/code/ai/claude-ext/packages/shared/src/protocol.ts`
- Create: `/Users/ming/Documents/code/ai/claude-ext/packages/shared/src/index.ts`

`protocol.ts` is the FIXED CONTRACT and must be written VERBATIM (no logic to test here; the constants are exercised by Task 5's test). `index.ts` re-exports it. We still run a typecheck to prove the contract compiles under strict mode before committing.

- [ ] **Step 1: Write `packages/shared/src/protocol.ts` — verbatim contract content.**

```ts
// packages/shared/src/protocol.ts  — THE FIXED CONTRACT. Use these exact names/types everywhere.

export type Role = 'browser' | 'agent';

export interface JsonRpcRequest<P = unknown> { jsonrpc: '2.0'; id: number | string; method: string; params?: P; }
export interface JsonRpcNotification<P = unknown> { jsonrpc: '2.0'; method: string; params?: P; }
export interface JsonRpcSuccess<R = unknown> { jsonrpc: '2.0'; id: number | string; result: R; }
export interface JsonRpcErrorResponse { jsonrpc: '2.0'; id: number | string | null; error: { code: number; message: string; data?: unknown }; }
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcErrorResponse;

export const ErrorCode = {
  PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603,
  EXTENSION_DISCONNECTED: 1001, TAB_NOT_FOUND: 1002, STALE_REF: 1003, CDP_ERROR: 1004, LEASE_DENIED: 1005, TIMEOUT: 1006, UNAUTHORIZED: 1007,
} as const;

// Methods: agent -> extension (routed by broker). Constant values are the wire 'method' strings.
export const Method = {
  EXECUTE_CDP: 'executeCdp', GET_TABS: 'getTabs', NEW_TAB: 'newTab', SWITCH_TAB: 'switchTab',
  CLOSE_TAB: 'closeTab', GET_HISTORY: 'getHistory', ATTACH: 'attach', DETACH: 'detach',
  GET_CONSOLE: 'getConsole', PING: 'ping',
} as const;

// Notifications: extension -> agent (routed/buffered by broker)
export const Notif = { ON_CDP_EVENT: 'onCDPEvent', ON_CONSOLE: 'onConsole', ON_STATUS: 'onStatus' } as const;

export interface CdpTarget { tabId?: number; targetId?: string; }
export interface ExecuteCdpParams { target: CdpTarget; method: string; params?: Record<string, unknown>; timeoutMs?: number; }
export type ExecuteCdpResult = unknown;
export interface AttachParams { tabId: number; }
export interface DetachParams { tabId: number; }
export interface TabInfo { id: number; url?: string; title?: string; active?: boolean; windowId?: number; }
export interface GetTabsResult { tabs: TabInfo[]; }
export interface NewTabParams { url?: string; }
export type NewTabResult = TabInfo;
export interface SwitchTabParams { tabId: number; }
export interface CloseTabParams { tabId: number; }
export interface GetHistoryParams { query: string; limit?: number; }
export interface HistoryEntry { url: string; title?: string; lastVisitTime?: number; visitCount?: number; }
export interface GetHistoryResult { entries: HistoryEntry[]; }
export interface ConsoleEntry { tabId: number; level: string; text: string; timestamp: number; args?: unknown[]; url?: string; line?: number; }
export interface GetConsoleParams { tabId?: number; filter?: string; since?: number; }
export interface GetConsoleResult { entries: ConsoleEntry[]; }
export interface OnCdpEventParams { source: CdpTarget; method: string; params: unknown; }
export type OnConsoleParams = ConsoleEntry;
export interface OnStatusParams { state: 'connected' | 'disconnected' | 'reconnecting'; detail?: string; }

// Auth handshake: FIRST message each client sends after the socket opens.
export interface AgentHello { type: 'hello'; role: 'agent'; token: string; sessionId: string; }
export interface BrowserHello { type: 'hello'; role: 'browser'; extensionId: string; }
export type Hello = AgentHello | BrowserHello;

export interface Config { port: number; token: string; extensionId: string; }
export const DEFAULT_PORT = 8787;
export const CONFIG_DIR = '.claude-browser';   // under os.homedir()
export const CONFIG_FILE = 'config.json';
```

- [ ] **Step 2: Write `packages/shared/src/index.ts`** — barrel that re-exports the contract and (forward) the validator added in Task 5. Re-export everything from both modules so consumers `import { Method, isJsonRpcRequest } from '@claude-browser/shared'`.

```ts
export * from './protocol.js';
export * from './validate.js';
```

> Note: `./validate.js` is created in Task 5. Because `index.ts` is not compiled or imported until Task 5/6, the barrel is committed alongside the contract here but its build is validated end-to-end in Task 6.

- [ ] **Step 3: Typecheck just the contract file** (the barrel references `validate.js` which arrives in Task 5, so we typecheck `protocol.ts` in isolation here). This proves the verbatim contract compiles under the strict base options.

```bash
cd /Users/ming/Documents/code/ai/claude-ext && npx tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler --verbatimModuleSyntax packages/shared/src/protocol.ts
```

Expect: no output, exit 0.

- [ ] **Step 4: Commit.**

```bash
git -C /Users/ming/Documents/code/ai/claude-ext add packages/shared/src/protocol.ts packages/shared/src/index.ts && \
git -C /Users/ming/Documents/code/ai/claude-ext commit -m "feat(shared): add fixed JSON-RPC protocol contract + barrel"
```

---

### Task 5: Runtime validator (`src/validate.ts`) — STRICT TDD

**Files**
- Create: `/Users/ming/Documents/code/ai/claude-ext/packages/shared/src/validate.ts`
- Test: `/Users/ming/Documents/code/ai/claude-ext/packages/shared/test/protocol.test.ts`

This is the only logic in the package: a tiny set of runtime type guards that classify an incoming parsed message into the contract's `JsonRpcMessage` union (the broker, extension, and MCP client all need to discriminate inbound frames). We TDD it. The same test file also asserts the `Method`/`Notif`/`ErrorCode` constant **values** (the wire strings/numbers are load-bearing across processes, so a typo must fail CI).

- [ ] **Step 1: Write the FAILING test `packages/shared/test/protocol.test.ts` with COMPLETE code.** It imports from `../src/index.js` (the barrel), pins every constant value, and exercises each guard with valid and invalid inputs.

```ts
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
      PING: 'ping',
    });
  });
});

describe('Notif constant wire values', () => {
  it('maps every notification name to its exact wire string', () => {
    expect(Notif).toEqual({
      ON_CDP_EVENT: 'onCDPEvent',
      ON_CONSOLE: 'onConsole',
      ON_STATUS: 'onStatus',
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
```

- [ ] **Step 2: Run the test and watch it FAIL** (the module `../src/validate.js` does not exist yet, so the barrel import resolves nothing — the guards are `undefined`).

```bash
cd /Users/ming/Documents/code/ai/claude-ext && npm test --workspace @claude-browser/shared
```

Expect: FAIL — import error / `isJsonRpcRequest is not a function` (no `validate.ts` yet).

- [ ] **Step 3: Write the minimal implementation `packages/shared/src/validate.ts` with COMPLETE code.** Each guard is a runtime discriminator returning a TypeScript type predicate over the contract types. The discrimination rules: a request has `id` + `method`; a notification has `method` and no `id`; a success has `id` + the `result` key present; an error has `id` (or `null`) + a well-formed `error` object.

```ts
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
```

- [ ] **Step 4: Run the test and watch it PASS.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && npm test --workspace @claude-browser/shared
```

Expect: PASS — all tests green.

- [ ] **Step 5: Typecheck the whole package** (now that `validate.ts` exists, the barrel's `export * from './validate.js'` resolves and the test file typechecks too).

```bash
cd /Users/ming/Documents/code/ai/claude-ext && npm run typecheck --workspace @claude-browser/shared
```

Expect: no output, exit 0.

- [ ] **Step 6: Commit.**

```bash
git -C /Users/ming/Documents/code/ai/claude-ext add packages/shared/src/validate.ts packages/shared/test/protocol.test.ts && \
git -C /Users/ming/Documents/code/ai/claude-ext commit -m "feat(shared): add JSON-RPC runtime type guards with tests"
```

---

### Task 6: Wire and verify the build (`tsup`) end-to-end

**Files**
- Modify: none (uses `packages/shared/tsup.config.ts` from Task 3 and `package.json` scripts)

This task proves the package builds to `dist/` with declarations and that the published shape (`dist/index.js` + `dist/index.d.ts`) is consumable. No new logic, so no TDD sub-steps — but we run concrete build/verify commands and assert artifacts exist.

- [ ] **Step 1: Build the package.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && npm run build --workspace @claude-browser/shared
```

Expect: tsup reports `ESM dist/index.js` and `dist/index.d.ts` emitted, exit 0.

- [ ] **Step 2: Assert the build artifacts exist** (these paths back the `exports`/`types` fields in `package.json`).

```bash
test -f /Users/ming/Documents/code/ai/claude-ext/packages/shared/dist/index.js && \
test -f /Users/ming/Documents/code/ai/claude-ext/packages/shared/dist/index.d.ts && \
echo "shared build artifacts present"
```

Expect: `shared build artifacts present`.

- [ ] **Step 3: Smoke-test the built ESM output** — import the compiled bundle directly and assert a constant and a guard came through the barrel (proves `dist/index.js` re-exports both `protocol` and `validate`).

```bash
cd /Users/ming/Documents/code/ai/claude-ext && node --input-type=module -e "import { Method, DEFAULT_PORT, isJsonRpcRequest } from './packages/shared/dist/index.js'; if (Method.EXECUTE_CDP !== 'executeCdp') throw new Error('bad Method'); if (DEFAULT_PORT !== 8787) throw new Error('bad port'); if (isJsonRpcRequest({jsonrpc:'2.0',id:1,method:'ping'}) !== true) throw new Error('bad guard'); console.log('shared dist smoke OK')"
```

Expect: `shared dist smoke OK`.

- [ ] **Step 4: Verify the aggregate root scripts work across the workspace** (build + test from the root, exercising the `--workspaces --if-present` fan-out that other packages will plug into).

```bash
cd /Users/ming/Documents/code/ai/claude-ext && npm run build && npm test
```

Expect: shared builds and its vitest suite passes; no other workspaces yet, so the fan-out skips them.

- [ ] **Step 5: Commit** (only the lockfile may have changed if tsup pulled a transitive; `dist/` is gitignored so nothing else is staged — this commit records the verified-build milestone via an empty commit if there is nothing to add).

```bash
git -C /Users/ming/Documents/code/ai/claude-ext add -A && \
git -C /Users/ming/Documents/code/ai/claude-ext commit -m "build(shared): verify tsup build + barrel exports" --allow-empty
```

---

**Section complete.** The monorepo root, shared compiler base, and `@claude-browser/shared` package now exist with: the verbatim wire contract (`protocol.ts`), a barrel (`index.ts`), runtime type guards (`validate.ts`) under test, a green vitest suite, and a verified `tsup` build emitting `dist/index.js` + `dist/index.d.ts`. Downstream packages (`broker`, `extension`, `mcp-server`) can now `import { Method, Notif, ErrorCode, isJsonRpcMessage, type ExecuteCdpParams, ... } from '@claude-browser/shared'`.


---

# Milestone 2 — Broker Daemon

## Broker package (`@claude-browser/broker`)

The broker is the long-lived launchd daemon and the only stable anchor. It binds a WS server to `127.0.0.1` only, authenticates the single browser client by `Origin` and N agent clients by token, routes agent JSON-RPC to the browser with broker-issued correlation ids, holds per-session tab leases, buffers console events for local `GET_CONSOLE` service, and rejects all pending requests with `EXTENSION_DISCONNECTED` if the extension drops.

Dependency order: scaffold → config → buffer → router → server → index → launchd. The router has no `ws` dependency (it works on injected send-callbacks) so it is unit-testable in isolation; the server tests use real `ws` clients against a real in-process server on an ephemeral port.

### Task 7: Scaffold the broker package (package.json, tsconfig, tsup config)

Files:
- Create: `packages/broker/package.json`
- Create: `packages/broker/tsconfig.json`
- Create: `packages/broker/tsup.config.ts`
- Create: `packages/broker/vitest.config.ts`

This is a pure-scaffold task (no logic), so no TDD sub-steps — but every file is shown complete.

- [ ] **Step 1: Write `packages/broker/package.json`.** The `bin` maps the broker CLI to the built entry; depends on the shared contract package and `ws`.
```json
{
  "name": "@claude-browser/broker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "claude-browser-broker": "./dist/index.js"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "@claude-browser/shared": "*",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.12"
  }
}
```

- [ ] **Step 2: Write `packages/broker/tsconfig.json`.** Extends the repo base; emits nothing (tsup builds), used only for `tsc --noEmit` lint.
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Write `packages/broker/tsup.config.ts`.** Node ESM bundle, single entry, externalize `ws` so the runtime resolves it from `node_modules`.
```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['ws'],
});
```

- [ ] **Step 4: Write `packages/broker/vitest.config.ts`.** Node environment; the server tests open real sockets.
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 10000,
  },
});
```

- [ ] **Step 5: Install workspace deps from repo root.**
```bash
npm install
```

- [ ] **Step 6: Commit the scaffold.**
```bash
git add packages/broker/package.json packages/broker/tsconfig.json packages/broker/tsup.config.ts packages/broker/vitest.config.ts && git commit -m "broker: scaffold package (package.json, tsconfig, tsup, vitest)"
```

### Task 8: config.ts — read/write `~/.claude-browser/config.json`, generate token, port override

Files:
- Create: `packages/broker/src/config.ts`
- Test: `packages/broker/test/config.test.ts`

`loadConfig` reads `~/.claude-browser/config.json`, validates the `Config` shape, and applies a `CLAUDE_BROKER_PORT` env override. `ensureConfig` creates the file (generating a `crypto.randomBytes(32).toString('hex')` token and `DEFAULT_PORT`) when absent, given an `extensionId`. Tests redirect `os.homedir()` to a temp dir via an injectable `home` argument so they never touch the real home directory.

- [ ] **Step 1: Write the failing test `packages/broker/test/config.test.ts`.** Complete test code:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_DIR, CONFIG_FILE, DEFAULT_PORT } from '@claude-browser/shared';
import { loadConfig, ensureConfig, configPath } from '../src/config.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cb-config-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.CLAUDE_BROKER_PORT;
});

describe('configPath', () => {
  it('resolves under CONFIG_DIR/CONFIG_FILE', () => {
    expect(configPath(home)).toBe(join(home, CONFIG_DIR, CONFIG_FILE));
  });
});

describe('ensureConfig', () => {
  it('creates a config with DEFAULT_PORT, a 64-hex token, and the given extensionId', () => {
    const cfg = ensureConfig('abcdefghabcdefghabcdefghabcdefgh', home);
    expect(cfg.port).toBe(DEFAULT_PORT);
    expect(cfg.extensionId).toBe('abcdefghabcdefghabcdefghabcdefgh');
    expect(cfg.token).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(configPath(home))).toBe(true);
    const onDisk = JSON.parse(readFileSync(configPath(home), 'utf8'));
    expect(onDisk).toEqual(cfg);
  });

  it('is idempotent: a second call returns the same persisted config (same token)', () => {
    const first = ensureConfig('extid-one', home);
    const second = ensureConfig('extid-two', home);
    expect(second).toEqual(first);
    expect(second.extensionId).toBe('extid-one');
  });
});

describe('loadConfig', () => {
  it('throws when the config file is absent', () => {
    expect(() => loadConfig(home)).toThrow(/not found/i);
  });

  it('reads a persisted config', () => {
    const written = ensureConfig('extid-load', home);
    expect(loadConfig(home)).toEqual(written);
  });

  it('rejects a config missing required fields', () => {
    mkdirSync(join(home, CONFIG_DIR), { recursive: true });
    writeFileSync(configPath(home), JSON.stringify({ port: 8787 }), 'utf8');
    expect(() => loadConfig(home)).toThrow(/invalid config/i);
  });

  it('applies CLAUDE_BROKER_PORT override as a number', () => {
    ensureConfig('extid-port', home);
    process.env.CLAUDE_BROKER_PORT = '9999';
    expect(loadConfig(home).port).toBe(9999);
  });

  it('ignores a non-numeric CLAUDE_BROKER_PORT override', () => {
    const written = ensureConfig('extid-port2', home);
    process.env.CLAUDE_BROKER_PORT = 'not-a-number';
    expect(loadConfig(home).port).toBe(written.port);
  });
});
```

- [ ] **Step 2: Run the test, expecting FAIL (module does not exist yet).**
```bash
npm run test --workspace @claude-browser/broker -- config.test
```

- [ ] **Step 3: Write `packages/broker/src/config.ts` (minimal, complete).**
```ts
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { CONFIG_DIR, CONFIG_FILE, DEFAULT_PORT, type Config } from '@claude-browser/shared';

/** Absolute path to the broker config file. `home` is injectable for tests. */
export function configPath(home: string = homedir()): string {
  return join(home, CONFIG_DIR, CONFIG_FILE);
}

function generateToken(): string {
  return randomBytes(32).toString('hex');
}

function isConfig(value: unknown): value is Config {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.port === 'number' &&
    typeof c.token === 'string' &&
    c.token.length > 0 &&
    typeof c.extensionId === 'string' &&
    c.extensionId.length > 0
  );
}

/**
 * Create the config (token + DEFAULT_PORT + extensionId) if it does not exist.
 * Idempotent: an existing config is returned untouched so the token is stable.
 */
export function ensureConfig(extensionId: string, home: string = homedir()): Config {
  const path = configPath(home);
  if (existsSync(path)) {
    return loadRaw(path);
  }
  mkdirSync(join(home, CONFIG_DIR), { recursive: true });
  const cfg: Config = { port: DEFAULT_PORT, token: generateToken(), extensionId };
  writeFileSync(path, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
  return cfg;
}

function loadRaw(path: string): Config {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isConfig(parsed)) {
    throw new Error(`Invalid config at ${path}`);
  }
  return parsed;
}

/**
 * Load and validate the config, applying a numeric CLAUDE_BROKER_PORT override.
 * Throws if the file is absent or malformed.
 */
export function loadConfig(home: string = homedir()): Config {
  const path = configPath(home);
  if (!existsSync(path)) {
    throw new Error(`Config not found at ${path}; run install first`);
  }
  const cfg = loadRaw(path);
  const override = process.env.CLAUDE_BROKER_PORT;
  if (override !== undefined) {
    const port = Number(override);
    if (Number.isInteger(port) && port > 0) {
      return { ...cfg, port };
    }
  }
  return cfg;
}
```

- [ ] **Step 4: Run the test, expecting PASS.**
```bash
npm run test --workspace @claude-browser/broker -- config.test
```

- [ ] **Step 5: Commit.**
```bash
git add packages/broker/src/config.ts packages/broker/test/config.test.ts && git commit -m "broker: config.ts read/write ~/.claude-browser/config.json with token gen + port override"
```

### Task 9: buffer.ts — per-tab ring buffer of ConsoleEntry with capped push + query

Files:
- Create: `packages/broker/src/buffer.ts`
- Test: `packages/broker/test/buffer.test.ts`

`ConsoleBuffer` keeps a bounded ring per `tabId` (default cap 1000 entries/tab). `push(entry)` appends and evicts the oldest when over cap. `query({tabId, filter, since})` returns entries optionally narrowed by tab, by case-insensitive substring `filter` on `text`, and by `since` (only `timestamp > since`), in chronological order. These map directly to `GetConsoleParams` / `GetConsoleResult` from the contract.

- [ ] **Step 1: Write the failing test `packages/broker/test/buffer.test.ts`.** Complete test code:
```ts
import { describe, it, expect } from 'vitest';
import type { ConsoleEntry } from '@claude-browser/shared';
import { ConsoleBuffer } from '../src/buffer.js';

function entry(tabId: number, text: string, timestamp: number, level = 'log'): ConsoleEntry {
  return { tabId, level, text, timestamp };
}

describe('ConsoleBuffer.push + query', () => {
  it('returns all entries in chronological order when query is empty', () => {
    const buf = new ConsoleBuffer();
    buf.push(entry(1, 'a', 10));
    buf.push(entry(2, 'b', 20));
    buf.push(entry(1, 'c', 30));
    expect(buf.query({}).map((e) => e.text)).toEqual(['a', 'b', 'c']);
  });

  it('filters by tabId', () => {
    const buf = new ConsoleBuffer();
    buf.push(entry(1, 'a', 10));
    buf.push(entry(2, 'b', 20));
    buf.push(entry(1, 'c', 30));
    expect(buf.query({ tabId: 1 }).map((e) => e.text)).toEqual(['a', 'c']);
  });

  it('filters by case-insensitive substring on text', () => {
    const buf = new ConsoleBuffer();
    buf.push(entry(1, 'TypeError: boom', 10));
    buf.push(entry(1, 'just a log', 20));
    expect(buf.query({ filter: 'error' }).map((e) => e.text)).toEqual(['TypeError: boom']);
  });

  it('filters by since (strictly greater timestamp)', () => {
    const buf = new ConsoleBuffer();
    buf.push(entry(1, 'old', 10));
    buf.push(entry(1, 'edge', 20));
    buf.push(entry(1, 'new', 30));
    expect(buf.query({ since: 20 }).map((e) => e.text)).toEqual(['new']);
  });

  it('combines tabId, filter, and since', () => {
    const buf = new ConsoleBuffer();
    buf.push(entry(1, 'Error one', 10));
    buf.push(entry(2, 'Error two', 30));
    buf.push(entry(1, 'Error three', 40));
    buf.push(entry(1, 'info four', 50));
    expect(buf.query({ tabId: 1, filter: 'error', since: 20 }).map((e) => e.text)).toEqual([
      'Error three',
    ]);
  });

  it('caps the per-tab ring, evicting the oldest', () => {
    const buf = new ConsoleBuffer(3);
    for (let i = 0; i < 5; i++) buf.push(entry(1, `m${i}`, i));
    expect(buf.query({ tabId: 1 }).map((e) => e.text)).toEqual(['m2', 'm3', 'm4']);
  });

  it('caps each tab independently', () => {
    const buf = new ConsoleBuffer(2);
    buf.push(entry(1, 'a1', 1));
    buf.push(entry(2, 'b1', 2));
    buf.push(entry(1, 'a2', 3));
    buf.push(entry(1, 'a3', 4));
    expect(buf.query({ tabId: 1 }).map((e) => e.text)).toEqual(['a2', 'a3']);
    expect(buf.query({ tabId: 2 }).map((e) => e.text)).toEqual(['b1']);
  });

  it('clearTab removes only that tab', () => {
    const buf = new ConsoleBuffer();
    buf.push(entry(1, 'a', 1));
    buf.push(entry(2, 'b', 2));
    buf.clearTab(1);
    expect(buf.query({}).map((e) => e.text)).toEqual(['b']);
  });
});
```

- [ ] **Step 2: Run the test, expecting FAIL.**
```bash
npm run test --workspace @claude-browser/broker -- buffer.test
```

- [ ] **Step 3: Write `packages/broker/src/buffer.ts` (minimal, complete).**
```ts
import type { ConsoleEntry, GetConsoleParams } from '@claude-browser/shared';

const DEFAULT_CAP = 1000;

/** Per-tab capped ring buffer of console entries, queried locally by the router. */
export class ConsoleBuffer {
  private readonly perTab = new Map<number, ConsoleEntry[]>();

  constructor(private readonly cap: number = DEFAULT_CAP) {}

  push(entry: ConsoleEntry): void {
    let ring = this.perTab.get(entry.tabId);
    if (ring === undefined) {
      ring = [];
      this.perTab.set(entry.tabId, ring);
    }
    ring.push(entry);
    if (ring.length > this.cap) {
      ring.splice(0, ring.length - this.cap);
    }
  }

  clearTab(tabId: number): void {
    this.perTab.delete(tabId);
  }

  query(params: GetConsoleParams): ConsoleEntry[] {
    const { tabId, filter, since } = params;
    const needle = filter?.toLowerCase();
    const rings =
      tabId === undefined
        ? [...this.perTab.entries()]
        : ([[tabId, this.perTab.get(tabId) ?? []]] as [number, ConsoleEntry[]][]);

    const out: ConsoleEntry[] = [];
    for (const [, ring] of rings) {
      for (const e of ring) {
        if (since !== undefined && !(e.timestamp > since)) continue;
        if (needle !== undefined && !e.text.toLowerCase().includes(needle)) continue;
        out.push(e);
      }
    }
    out.sort((a, b) => a.timestamp - b.timestamp);
    return out;
  }
}
```

- [ ] **Step 4: Run the test, expecting PASS.**
```bash
npm run test --workspace @claude-browser/broker -- buffer.test
```

- [ ] **Step 5: Commit.**
```bash
git add packages/broker/src/buffer.ts packages/broker/test/buffer.test.ts && git commit -m "broker: buffer.ts per-tab capped console ring with tabId/filter/since query"
```

### Task 10: router.ts — route agent requests to the browser, leases, pending map, disconnect rejection

Files:
- Create: `packages/broker/src/router.ts`
- Test: `packages/broker/test/router.test.ts`

The router is transport-agnostic: it operates on `BrowserLink` / `AgentLink` handles that each carry a `send(msg)` callback, so the server layer wires real sockets but the router is unit-testable with stub sends. Responsibilities:

- Register/unregister the single browser link and N agent links (keyed by `sessionId`).
- `routeRequest(sessionId, req)`: rewrites the agent's request `id` to a fresh broker-issued correlation id, records `{originalId, sessionId, reject}` in a pending map, and forwards to the browser. Returns a Promise of the eventual response message to send back to the agent. If no browser is connected, rejects with `EXTENSION_DISCONNECTED`.
- `GET_CONSOLE` is served locally from the injected `ConsoleBuffer` — never forwarded to the browser.
- `ATTACH` / `DETACH` enforce per-session tab leases: `ATTACH` claims the tab for the session (or returns `LEASE_DENIED` if another session owns it); `DETACH` releases it. `EXECUTE_CDP` against a tab leased by another session returns `LEASE_DENIED`.
- `handleBrowserMessage(msg)`: a success/error response resolves the matching pending entry (mapping the correlation id back to the agent's original id); a notification is ingested (`ON_CDP_EVENT` console events → buffer; all notifications fan out to agents).
- `onBrowserDisconnect()`: rejects every pending request with `EXTENSION_DISCONNECTED` and notifies agents with an `ON_STATUS` `disconnected`.
- `onAgentDisconnect(sessionId)`: releases all leases held by that session and drops its pending entries.

The router exposes the agent-bound message it produces via the agent link's `send`, so tests assert on captured sends.

- [ ] **Step 1: Write the failing test `packages/broker/test/router.test.ts`.** Complete test code:
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ErrorCode,
  Method,
  Notif,
  type JsonRpcRequest,
  type JsonRpcSuccess,
  type JsonRpcErrorResponse,
  type JsonRpcMessage,
  type OnCdpEventParams,
  type ConsoleEntry,
} from '@claude-browser/shared';
import { ConsoleBuffer } from '../src/buffer.js';
import { Router } from '../src/router.js';

function sent<T extends JsonRpcMessage = JsonRpcMessage>(fn: ReturnType<typeof vi.fn>): T[] {
  return fn.mock.calls.map((c) => c[0] as T);
}

function lastBrowserRequest(browserSend: ReturnType<typeof vi.fn>): JsonRpcRequest {
  const reqs = sent<JsonRpcRequest>(browserSend).filter((m) => 'method' in m && 'id' in m);
  return reqs[reqs.length - 1];
}

describe('Router', () => {
  let buffer: ConsoleBuffer;
  let router: Router;
  let browserSend: ReturnType<typeof vi.fn>;
  let agentSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    buffer = new ConsoleBuffer();
    router = new Router(buffer);
    browserSend = vi.fn();
    agentSend = vi.fn();
  });

  it('rejects agent requests with EXTENSION_DISCONNECTED when no browser is connected', async () => {
    router.registerAgent('sess-1', agentSend);
    const req: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method: Method.GET_TABS };
    const resp = (await router.routeRequest('sess-1', req)) as JsonRpcErrorResponse;
    expect(resp.id).toBe(1);
    expect(resp.error.code).toBe(ErrorCode.EXTENSION_DISCONNECTED);
  });

  it('forwards a request to the browser with a fresh correlation id and relays the result', async () => {
    router.registerBrowser(browserSend);
    router.registerAgent('sess-1', agentSend);
    const req: JsonRpcRequest = { jsonrpc: '2.0', id: 'orig-7', method: Method.GET_TABS };
    const pending = router.routeRequest('sess-1', req);

    const fwd = lastBrowserRequest(browserSend);
    expect(fwd.method).toBe(Method.GET_TABS);
    expect(fwd.id).not.toBe('orig-7'); // broker-issued correlation id

    const browserResp: JsonRpcSuccess = { jsonrpc: '2.0', id: fwd.id, result: { tabs: [] } };
    router.handleBrowserMessage(browserResp);

    const resp = (await pending) as JsonRpcSuccess;
    expect(resp.id).toBe('orig-7'); // mapped back to the agent's original id
    expect(resp.result).toEqual({ tabs: [] });
  });

  it('relays a browser error response mapped back to the original id', async () => {
    router.registerBrowser(browserSend);
    router.registerAgent('sess-1', agentSend);
    const req: JsonRpcRequest = { jsonrpc: '2.0', id: 9, method: Method.NEW_TAB, params: {} };
    const pending = router.routeRequest('sess-1', req);
    const fwd = lastBrowserRequest(browserSend);
    const err: JsonRpcErrorResponse = {
      jsonrpc: '2.0',
      id: fwd.id,
      error: { code: ErrorCode.CDP_ERROR, message: 'boom' },
    };
    router.handleBrowserMessage(err);
    const resp = (await pending) as JsonRpcErrorResponse;
    expect(resp.id).toBe(9);
    expect(resp.error.code).toBe(ErrorCode.CDP_ERROR);
  });

  it('serves GET_CONSOLE locally from the buffer, never forwarding to the browser', async () => {
    router.registerBrowser(browserSend);
    router.registerAgent('sess-1', agentSend);
    const e: ConsoleEntry = { tabId: 5, level: 'error', text: 'kaboom', timestamp: 100 };
    buffer.push(e);
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 'c1',
      method: Method.GET_CONSOLE,
      params: { tabId: 5 },
    };
    const resp = (await router.routeRequest('sess-1', req)) as JsonRpcSuccess<{
      entries: ConsoleEntry[];
    }>;
    expect(resp.id).toBe('c1');
    expect(resp.result.entries).toEqual([e]);
    expect(browserSend).not.toHaveBeenCalled();
  });

  it('grants an ATTACH lease and denies a second session attaching the same tab', async () => {
    router.registerBrowser(browserSend);
    router.registerAgent('sess-1', agentSend);
    router.registerAgent('sess-2', vi.fn());

    const attach1: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: Method.ATTACH,
      params: { tabId: 42 },
    };
    const p1 = router.routeRequest('sess-1', attach1);
    const fwd = lastBrowserRequest(browserSend);
    router.handleBrowserMessage({ jsonrpc: '2.0', id: fwd.id, result: {} });
    const r1 = (await p1) as JsonRpcSuccess;
    expect(r1.id).toBe(1);
    expect('error' in r1).toBe(false);

    const attach2: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: Method.ATTACH,
      params: { tabId: 42 },
    };
    const r2 = (await router.routeRequest('sess-2', attach2)) as JsonRpcErrorResponse;
    expect(r2.error.code).toBe(ErrorCode.LEASE_DENIED);
  });

  it('denies EXECUTE_CDP against a tab leased by another session', async () => {
    router.registerBrowser(browserSend);
    router.registerAgent('sess-1', agentSend);
    router.registerAgent('sess-2', vi.fn());

    const attach: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: Method.ATTACH,
      params: { tabId: 7 },
    };
    const pa = router.routeRequest('sess-1', attach);
    router.handleBrowserMessage({ jsonrpc: '2.0', id: lastBrowserRequest(browserSend).id, result: {} });
    await pa;

    const exec: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: Method.EXECUTE_CDP,
      params: { target: { tabId: 7 }, method: 'Page.reload' },
    };
    const r = (await router.routeRequest('sess-2', exec)) as JsonRpcErrorResponse;
    expect(r.error.code).toBe(ErrorCode.LEASE_DENIED);
  });

  it('releases a lease on DETACH so another session may then claim it', async () => {
    router.registerBrowser(browserSend);
    router.registerAgent('sess-1', agentSend);
    const a2 = vi.fn();
    router.registerAgent('sess-2', a2);

    const attach: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method: Method.ATTACH, params: { tabId: 3 } };
    const pa = router.routeRequest('sess-1', attach);
    router.handleBrowserMessage({ jsonrpc: '2.0', id: lastBrowserRequest(browserSend).id, result: {} });
    await pa;

    const detach: JsonRpcRequest = { jsonrpc: '2.0', id: 2, method: Method.DETACH, params: { tabId: 3 } };
    const pd = router.routeRequest('sess-1', detach);
    router.handleBrowserMessage({ jsonrpc: '2.0', id: lastBrowserRequest(browserSend).id, result: {} });
    await pd;

    const attach2: JsonRpcRequest = { jsonrpc: '2.0', id: 3, method: Method.ATTACH, params: { tabId: 3 } };
    const pa2 = router.routeRequest('sess-2', attach2);
    router.handleBrowserMessage({ jsonrpc: '2.0', id: lastBrowserRequest(browserSend).id, result: {} });
    const r = (await pa2) as JsonRpcSuccess;
    expect('error' in r).toBe(false);
  });

  it('ingests ON_CDP_EVENT console events into the buffer and fans the notification out to agents', () => {
    router.registerBrowser(browserSend);
    router.registerAgent('sess-1', agentSend);
    const params: OnCdpEventParams = {
      source: { tabId: 11 },
      method: 'Runtime.consoleAPICalled',
      params: { type: 'error', args: [{ value: 'page exploded' }], timestamp: 1234 },
    };
    router.handleBrowserMessage({ jsonrpc: '2.0', method: Notif.ON_CDP_EVENT, params });

    const buffered = buffer.query({ tabId: 11 });
    expect(buffered).toHaveLength(1);
    expect(buffered[0].text).toContain('page exploded');
    expect(buffered[0].level).toBe('error');

    const notifs = sent(agentSend).filter((m) => 'method' in m && !('id' in m));
    expect(notifs.some((m) => (m as { method: string }).method === Notif.ON_CDP_EVENT)).toBe(true);
  });

  it('rejects ALL pending requests with EXTENSION_DISCONNECTED on browser disconnect', async () => {
    router.registerBrowser(browserSend);
    router.registerAgent('sess-1', agentSend);
    const p1 = router.routeRequest('sess-1', { jsonrpc: '2.0', id: 1, method: Method.GET_TABS });
    const p2 = router.routeRequest('sess-1', { jsonrpc: '2.0', id: 2, method: Method.GET_HISTORY, params: { query: 'x' } });

    router.onBrowserDisconnect();

    const r1 = (await p1) as JsonRpcErrorResponse;
    const r2 = (await p2) as JsonRpcErrorResponse;
    expect(r1.error.code).toBe(ErrorCode.EXTENSION_DISCONNECTED);
    expect(r2.error.code).toBe(ErrorCode.EXTENSION_DISCONNECTED);

    const notifs = sent(agentSend).filter((m) => 'method' in m && !('id' in m));
    expect(notifs.some((m) => (m as { method: string }).method === Notif.ON_STATUS)).toBe(true);
  });

  it('releases leases held by a session when that agent disconnects', async () => {
    router.registerBrowser(browserSend);
    router.registerAgent('sess-1', agentSend);
    const a2 = vi.fn();
    router.registerAgent('sess-2', a2);

    const attach: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method: Method.ATTACH, params: { tabId: 99 } };
    const pa = router.routeRequest('sess-1', attach);
    router.handleBrowserMessage({ jsonrpc: '2.0', id: lastBrowserRequest(browserSend).id, result: {} });
    await pa;

    router.onAgentDisconnect('sess-1');

    const attach2: JsonRpcRequest = { jsonrpc: '2.0', id: 2, method: Method.ATTACH, params: { tabId: 99 } };
    const pa2 = router.routeRequest('sess-2', attach2);
    router.handleBrowserMessage({ jsonrpc: '2.0', id: lastBrowserRequest(browserSend).id, result: {} });
    const r = (await pa2) as JsonRpcSuccess;
    expect('error' in r).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test, expecting FAIL.**
```bash
npm run test --workspace @claude-browser/broker -- router.test
```

- [ ] **Step 3: Write `packages/broker/src/router.ts` (minimal, complete).**
```ts
import {
  ErrorCode,
  Method,
  Notif,
  type JsonRpcRequest,
  type JsonRpcMessage,
  type JsonRpcSuccess,
  type JsonRpcErrorResponse,
  type ExecuteCdpParams,
  type AttachParams,
  type DetachParams,
  type GetConsoleParams,
  type GetConsoleResult,
  type OnCdpEventParams,
  type OnStatusParams,
  type ConsoleEntry,
} from '@claude-browser/shared';
import type { ConsoleBuffer } from './buffer.js';

type Send = (msg: JsonRpcMessage) => void;

interface Pending {
  originalId: number | string;
  sessionId: string;
  resolve: (msg: JsonRpcMessage) => void;
}

function errorResponse(
  id: number | string | null,
  code: number,
  message: string,
): JsonRpcErrorResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** CDP console-event methods that produce ConsoleEntry rows in the buffer. */
const CONSOLE_CDP_METHODS = new Set(['Runtime.consoleAPICalled', 'Log.entryAdded']);

function toConsoleEntry(p: OnCdpEventParams): ConsoleEntry | null {
  if (!CONSOLE_CDP_METHODS.has(p.method)) return null;
  const tabId = p.source.tabId;
  if (typeof tabId !== 'number') return null;
  const raw = p.params as Record<string, unknown>;
  if (p.method === 'Runtime.consoleAPICalled') {
    const args = Array.isArray(raw.args) ? (raw.args as Array<Record<string, unknown>>) : [];
    const text = args
      .map((a) => (a && 'value' in a ? String(a.value) : a && 'description' in a ? String(a.description) : ''))
      .join(' ')
      .trim();
    return {
      tabId,
      level: typeof raw.type === 'string' ? raw.type : 'log',
      text,
      timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : Date.now(),
      args: args as unknown[],
    };
  }
  // Log.entryAdded
  const entry = (raw.entry ?? {}) as Record<string, unknown>;
  return {
    tabId,
    level: typeof entry.level === 'string' ? entry.level : 'log',
    text: typeof entry.text === 'string' ? entry.text : '',
    timestamp: typeof entry.timestamp === 'number' ? entry.timestamp : Date.now(),
    url: typeof entry.url === 'string' ? entry.url : undefined,
  };
}

/**
 * Transport-agnostic core: routes agent JSON-RPC to the single browser link,
 * owns the pending map / correlation ids, per-session tab leases, and the
 * console buffer ingest + local GET_CONSOLE service.
 */
export class Router {
  private browser: Send | null = null;
  private readonly agents = new Map<string, Send>();
  private readonly pending = new Map<number, Pending>();
  /** tabId -> owning sessionId */
  private readonly leases = new Map<number, string>();
  private nextCorrelationId = 1;

  constructor(private readonly buffer: ConsoleBuffer) {}

  registerBrowser(send: Send): void {
    this.browser = send;
  }

  registerAgent(sessionId: string, send: Send): void {
    this.agents.set(sessionId, send);
  }

  hasBrowser(): boolean {
    return this.browser !== null;
  }

  /** Route one agent request; resolves with the message to send back to that agent. */
  routeRequest(sessionId: string, req: JsonRpcRequest): Promise<JsonRpcMessage> {
    // Locally served: console reads from the buffer.
    if (req.method === Method.GET_CONSOLE) {
      const params = (req.params ?? {}) as GetConsoleParams;
      const result: GetConsoleResult = { entries: this.buffer.query(params) };
      const ok: JsonRpcSuccess<GetConsoleResult> = { jsonrpc: '2.0', id: req.id, result };
      return Promise.resolve(ok);
    }

    // Lease enforcement.
    const leaseError = this.checkLease(sessionId, req);
    if (leaseError) return Promise.resolve(leaseError);

    if (this.browser === null) {
      return Promise.resolve(
        errorResponse(req.id, ErrorCode.EXTENSION_DISCONNECTED, 'browser extension not connected'),
      );
    }

    const correlationId = this.nextCorrelationId++;
    const forwarded: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: correlationId,
      method: req.method,
      params: req.params,
    };

    return new Promise<JsonRpcMessage>((resolve) => {
      this.pending.set(correlationId, { originalId: req.id, sessionId, resolve });
      // Apply lease side effects only once forwarding succeeds.
      this.applyLeaseSideEffects(sessionId, req);
      this.browser!(forwarded);
    });
  }

  /** Returns a LEASE_DENIED error response if the request violates a lease, else null. */
  private checkLease(sessionId: string, req: JsonRpcRequest): JsonRpcErrorResponse | null {
    if (req.method === Method.ATTACH) {
      const { tabId } = (req.params ?? {}) as AttachParams;
      const owner = this.leases.get(tabId);
      if (owner !== undefined && owner !== sessionId) {
        return errorResponse(req.id, ErrorCode.LEASE_DENIED, `tab ${tabId} leased by another session`);
      }
      return null;
    }
    if (req.method === Method.EXECUTE_CDP) {
      const { target } = (req.params ?? {}) as ExecuteCdpParams;
      const tabId = target?.tabId;
      if (typeof tabId === 'number') {
        const owner = this.leases.get(tabId);
        if (owner !== undefined && owner !== sessionId) {
          return errorResponse(req.id, ErrorCode.LEASE_DENIED, `tab ${tabId} leased by another session`);
        }
      }
      return null;
    }
    return null;
  }

  private applyLeaseSideEffects(sessionId: string, req: JsonRpcRequest): void {
    if (req.method === Method.ATTACH) {
      const { tabId } = (req.params ?? {}) as AttachParams;
      this.leases.set(tabId, sessionId);
    } else if (req.method === Method.DETACH) {
      const { tabId } = (req.params ?? {}) as DetachParams;
      if (this.leases.get(tabId) === sessionId) this.leases.delete(tabId);
    }
  }

  /** Handle any message coming from the browser link (response or notification). */
  handleBrowserMessage(msg: JsonRpcMessage): void {
    if ('id' in msg && msg.id !== null && ('result' in msg || 'error' in msg)) {
      const correlationId = typeof msg.id === 'number' ? msg.id : Number(msg.id);
      const entry = this.pending.get(correlationId);
      if (entry === undefined) return;
      this.pending.delete(correlationId);
      if ('result' in msg) {
        entry.resolve({ jsonrpc: '2.0', id: entry.originalId, result: (msg as JsonRpcSuccess).result });
      } else {
        const err = (msg as JsonRpcErrorResponse).error;
        entry.resolve({ jsonrpc: '2.0', id: entry.originalId, error: err });
      }
      return;
    }
    // Notification from the browser.
    if ('method' in msg && !('id' in msg)) {
      if (msg.method === Notif.ON_CDP_EVENT) {
        const entry = toConsoleEntry(msg.params as OnCdpEventParams);
        if (entry) this.buffer.push(entry);
      }
      this.broadcastToAgents(msg);
    }
  }

  private broadcastToAgents(msg: JsonRpcMessage): void {
    for (const send of this.agents.values()) send(msg);
  }

  /** Browser link dropped: reject every pending request and tell agents. */
  onBrowserDisconnect(): void {
    this.browser = null;
    for (const [, entry] of this.pending) {
      entry.resolve(
        errorResponse(entry.originalId, ErrorCode.EXTENSION_DISCONNECTED, 'browser extension disconnected'),
      );
    }
    this.pending.clear();
    const status: OnStatusParams = { state: 'disconnected', detail: 'extension link closed' };
    this.broadcastToAgents({ jsonrpc: '2.0', method: Notif.ON_STATUS, params: status });
  }

  /** Agent session ended: release its leases and drop its pending entries. */
  onAgentDisconnect(sessionId: string): void {
    this.agents.delete(sessionId);
    for (const [tabId, owner] of this.leases) {
      if (owner === sessionId) this.leases.delete(tabId);
    }
    for (const [cid, entry] of this.pending) {
      if (entry.sessionId === sessionId) this.pending.delete(cid);
    }
  }
}
```

- [ ] **Step 4: Run the test, expecting PASS.**
```bash
npm run test --workspace @claude-browser/broker -- router.test
```

- [ ] **Step 5: Commit.**
```bash
git add packages/broker/src/router.ts packages/broker/test/router.test.ts && git commit -m "broker: router.ts correlation-id routing, tab leases, console ingest, disconnect rejection"
```

### Task 11: server.ts — 127.0.0.1 WS server, role auth (Origin + token), heartbeat, router glue

Files:
- Create: `packages/broker/src/server.ts`
- Test: `packages/broker/test/server.test.ts`

`startServer(config, deps?)` opens a `ws` `WebSocketServer` bound to `127.0.0.1` on `config.port` (port `0` → ephemeral; tests read the actual port from `address()`). Auth happens per-connection on the FIRST message (the `Hello`), not in `verifyClient`, because the agent token arrives in the hello body — but the browser `Origin` is checked in `verifyClient` to reject web origins early:

- `verifyClient`: accept the upgrade only if there is no `Origin` header (node `ws` agent client sends none) OR `Origin === 'chrome-extension://' + config.extensionId`. Any `http(s)://` origin is rejected with 401 immediately (DNS-rebinding defense).
- On first message: parse `Hello`. `BrowserHello` is accepted only if its `extensionId` matches config (and the connection survived the origin check); it registers the single browser link (replacing any prior). `AgentHello` is accepted only if `token === config.token`, else the socket is closed with code 4001 and an `UNAUTHORIZED` reason; on success it registers an agent link keyed by `sessionId`.
- After the hello, every subsequent agent message that is a request is routed via `router.routeRequest` and the resolved response is sent back on that socket; every browser message is fed to `router.handleBrowserMessage`.
- 30s heartbeat: a server-side interval pings both links; a link that did not `pong` since the previous tick is `terminate()`d (which fires `close` → `router.onBrowserDisconnect` / `onAgentDisconnect`). The interval is injectable (`heartbeatMs`) so tests use a short period.

The `deps` param lets tests inject a `home`-less pre-built `Router`/`ConsoleBuffer`; default builds its own.

- [ ] **Step 1: Write the failing test `packages/broker/test/server.test.ts`.** Complete test code:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import {
  Method,
  Notif,
  ErrorCode,
  type Config,
  type AgentHello,
  type BrowserHello,
  type JsonRpcRequest,
  type JsonRpcMessage,
  type JsonRpcSuccess,
  type JsonRpcErrorResponse,
} from '@claude-browser/shared';
import { startServer, type BrokerServer } from '../src/server.js';

const config: Config = { port: 0, token: 'secret-token', extensionId: 'pinnedextid' };
const ORIGIN = 'chrome-extension://pinnedextid';

let server: BrokerServer | null = null;

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
});

function url(s: BrokerServer): string {
  return `ws://127.0.0.1:${s.port}`;
}

function once<T = JsonRpcMessage>(ws: WebSocket): Promise<T> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString()) as T));
  });
}

function open(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

async function connectAgent(s: BrokerServer, token: string, sessionId: string): Promise<WebSocket> {
  const ws = new WebSocket(url(s));
  await open(ws);
  const hello: AgentHello = { type: 'hello', role: 'agent', token, sessionId };
  ws.send(JSON.stringify(hello));
  return ws;
}

async function connectBrowser(s: BrokerServer): Promise<WebSocket> {
  const ws = new WebSocket(url(s), { headers: { Origin: ORIGIN } });
  await open(ws);
  const hello: BrowserHello = { type: 'hello', role: 'browser', extensionId: 'pinnedextid' };
  ws.send(JSON.stringify(hello));
  return ws;
}

describe('broker server', () => {
  it('binds 127.0.0.1 and exposes the chosen ephemeral port', async () => {
    server = await startServer(config);
    expect(server.port).toBeGreaterThan(0);
    expect(server.host).toBe('127.0.0.1');
  });

  it('rejects a websocket upgrade carrying an http origin (DNS-rebinding defense)', async () => {
    server = await startServer(config);
    const ws = new WebSocket(url(server), { headers: { Origin: 'http://evil.example' } });
    const code = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(401));
    });
    expect(code).toBe(401);
  });

  it('closes an agent connection presenting a wrong token with UNAUTHORIZED', async () => {
    server = await startServer(config);
    const ws = new WebSocket(url(server));
    await open(ws);
    const hello: AgentHello = { type: 'hello', role: 'agent', token: 'wrong', sessionId: 's' };
    ws.send(JSON.stringify(hello));
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(4001);
  });

  it('routes an agent request to the browser and relays the result', async () => {
    server = await startServer(config);
    const browser = await connectBrowser(server);
    const agent = await connectAgent(server, 'secret-token', 'sess-1');

    const req: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method: Method.GET_TABS };
    agent.send(JSON.stringify(req));

    const fwd = await once<JsonRpcRequest>(browser);
    expect(fwd.method).toBe(Method.GET_TABS);
    const resp: JsonRpcSuccess = { jsonrpc: '2.0', id: fwd.id, result: { tabs: [{ id: 5 }] } };
    browser.send(JSON.stringify(resp));

    const agentResp = await once<JsonRpcSuccess<{ tabs: unknown[] }>>(agent);
    expect(agentResp.id).toBe(1);
    expect(agentResp.result.tabs).toEqual([{ id: 5 }]);
  });

  it('rejects pending agent requests with EXTENSION_DISCONNECTED when the browser drops', async () => {
    server = await startServer(config);
    const browser = await connectBrowser(server);
    const agent = await connectAgent(server, 'secret-token', 'sess-1');

    const req: JsonRpcRequest = { jsonrpc: '2.0', id: 7, method: Method.GET_TABS };
    agent.send(JSON.stringify(req));
    await once(browser); // ensure it was forwarded (and thus pending)
    browser.terminate();

    // The agent receives both the EXTENSION_DISCONNECTED response and an ON_STATUS notif (any order).
    const got = await new Promise<{ err: boolean; status: boolean }>((resolve) => {
      let err = false;
      let status = false;
      agent.on('message', (d) => {
        const m = JSON.parse(d.toString()) as JsonRpcMessage;
        if ('error' in m && (m as JsonRpcErrorResponse).error.code === ErrorCode.EXTENSION_DISCONNECTED) err = true;
        if ('method' in m && (m as { method: string }).method === Notif.ON_STATUS) status = true;
        if (err && status) resolve({ err, status });
      });
    });
    expect(got.err).toBe(true);
    expect(got.status).toBe(true);
  });

  it('terminates a link that fails to pong within a heartbeat tick', async () => {
    server = await startServer(config, { heartbeatMs: 60 });
    const agent = await connectAgent(server, 'secret-token', 'sess-hb');
    // Suppress the auto-pong so the server sees a dead link.
    agent.pong = (() => {}) as unknown as WebSocket['pong'];
    const closed = await new Promise<boolean>((resolve) => {
      agent.on('close', () => resolve(true));
      setTimeout(() => resolve(false), 1000);
    });
    expect(closed).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test, expecting FAIL.**
```bash
npm run test --workspace @claude-browser/broker -- server.test
```

- [ ] **Step 3: Write `packages/broker/src/server.ts` (minimal, complete).**
```ts
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { IncomingMessage } from 'node:http';
import {
  type Config,
  type Hello,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from '@claude-browser/shared';
import { ConsoleBuffer } from './buffer.js';
import { Router } from './router.js';

const HOST = '127.0.0.1';
const DEFAULT_HEARTBEAT_MS = 30_000;

export interface ServerDeps {
  buffer?: ConsoleBuffer;
  router?: Router;
  heartbeatMs?: number;
}

export interface BrokerServer {
  port: number;
  host: string;
  router: Router;
  close(): Promise<void>;
}

interface LiveSocket extends WebSocket {
  isAlive: boolean;
  role?: 'browser' | 'agent';
  sessionId?: string;
}

function originAllowed(req: IncomingMessage, extensionId: string): boolean {
  const origin = req.headers.origin;
  // The node ws client (agent) sends no Origin; only browser pages carry one.
  if (origin === undefined) return true;
  return origin === `chrome-extension://${extensionId}`;
}

export function startServer(config: Config, deps: ServerDeps = {}): Promise<BrokerServer> {
  const buffer = deps.buffer ?? new ConsoleBuffer();
  const router = deps.router ?? new Router(buffer);
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  const wss = new WebSocketServer({
    host: HOST,
    port: config.port,
    verifyClient: ({ req }, done) => {
      if (originAllowed(req, config.extensionId)) {
        done(true);
      } else {
        done(false, 401, 'Unauthorized');
      }
    },
  });

  wss.on('connection', (raw: WebSocket, req: IncomingMessage) => {
    const ws = raw as LiveSocket;
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    const browserOrigin = req.headers.origin === `chrome-extension://${config.extensionId}`;

    ws.once('message', (data: RawData) => {
      let hello: Hello;
      try {
        hello = JSON.parse(data.toString()) as Hello;
      } catch {
        ws.close(4002, 'bad hello');
        return;
      }

      if (hello.type !== 'hello') {
        ws.close(4002, 'expected hello');
        return;
      }

      if (hello.role === 'browser') {
        if (!browserOrigin || hello.extensionId !== config.extensionId) {
          ws.close(4001, 'UNAUTHORIZED');
          return;
        }
        ws.role = 'browser';
        attachBrowser(ws, router);
        return;
      }

      if (hello.role === 'agent') {
        if (hello.token !== config.token) {
          ws.close(4001, 'UNAUTHORIZED');
          return;
        }
        ws.role = 'agent';
        ws.sessionId = hello.sessionId;
        attachAgent(ws, hello.sessionId, router);
        return;
      }

      ws.close(4002, 'unknown role');
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const ws = client as LiveSocket;
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  return new Promise<BrokerServer>((resolve, reject) => {
    wss.once('error', reject);
    wss.once('listening', () => {
      const addr = wss.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : config.port;
      resolve({
        port,
        host: HOST,
        router,
        close: () =>
          new Promise<void>((res) => {
            clearInterval(heartbeat);
            for (const c of wss.clients) (c as WebSocket).terminate();
            wss.close(() => res());
          }),
      });
    });
  });
}

function attachBrowser(ws: LiveSocket, router: Router): void {
  router.registerBrowser((msg: JsonRpcMessage) => ws.send(JSON.stringify(msg)));
  ws.on('message', (data: RawData) => {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(data.toString()) as JsonRpcMessage;
    } catch {
      return;
    }
    router.handleBrowserMessage(msg);
  });
  ws.on('close', () => router.onBrowserDisconnect());
}

function attachAgent(ws: LiveSocket, sessionId: string, router: Router): void {
  router.registerAgent(sessionId, (msg: JsonRpcMessage) => ws.send(JSON.stringify(msg)));
  ws.on('message', (data: RawData) => {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(data.toString()) as JsonRpcMessage;
    } catch {
      return;
    }
    if ('method' in msg && 'id' in msg) {
      void router.routeRequest(sessionId, msg as JsonRpcRequest).then((resp) => {
        ws.send(JSON.stringify(resp));
      });
    }
  });
  ws.on('close', () => router.onAgentDisconnect(sessionId));
}
```

- [ ] **Step 4: Run the test, expecting PASS.**
```bash
npm run test --workspace @claude-browser/broker -- server.test
```

- [ ] **Step 5: Commit.**
```bash
git add packages/broker/src/server.ts packages/broker/test/server.test.ts && git commit -m "broker: server.ts 127.0.0.1 WS server with origin/token auth, heartbeat, router glue"
```

### Task 12: launchd.ts — render the launchd plist string

Files:
- Create: `packages/broker/src/launchd.ts`
- Test: `packages/broker/test/launchd.test.ts`

`renderLaunchdPlist({nodePath, scriptPath, label?})` returns a valid plist XML string with `Label = com.claude-browser.broker`, `KeepAlive = true`, `RunAtLoad = true`, and `ProgramArguments = [nodePath, scriptPath]`. It also includes stdout/stderr log paths under `~/.claude-browser/`. `LAUNCHD_LABEL` is exported for the installer to build `plistPath`.

- [ ] **Step 1: Write the failing test `packages/broker/test/launchd.test.ts`.** Complete test code:
```ts
import { describe, it, expect } from 'vitest';
import { renderLaunchdPlist, LAUNCHD_LABEL } from '../src/launchd.js';

describe('renderLaunchdPlist', () => {
  const plist = renderLaunchdPlist({
    nodePath: '/usr/local/bin/node',
    scriptPath: '/Users/x/.claude-browser/broker/dist/index.js',
  });

  it('exposes the fixed label', () => {
    expect(LAUNCHD_LABEL).toBe('com.claude-browser.broker');
  });

  it('declares the label key', () => {
    expect(plist).toContain('<key>Label</key>');
    expect(plist).toContain('<string>com.claude-browser.broker</string>');
  });

  it('sets KeepAlive and RunAtLoad to true', () => {
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  it('lists node then the script in ProgramArguments', () => {
    const idxNode = plist.indexOf('/usr/local/bin/node');
    const idxScript = plist.indexOf('/Users/x/.claude-browser/broker/dist/index.js');
    expect(idxNode).toBeGreaterThan(-1);
    expect(idxScript).toBeGreaterThan(idxNode);
  });

  it('is valid XML beginning with the plist DOCTYPE', () => {
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(plist).toContain('<!DOCTYPE plist PUBLIC');
  });

  it('honors a custom label', () => {
    const p = renderLaunchdPlist({ nodePath: 'node', scriptPath: 's.js', label: 'com.x.y' });
    expect(p).toContain('<string>com.x.y</string>');
  });
});
```

- [ ] **Step 2: Run the test, expecting FAIL.**
```bash
npm run test --workspace @claude-browser/broker -- launchd.test
```

- [ ] **Step 3: Write `packages/broker/src/launchd.ts` (minimal, complete).**
```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_DIR } from '@claude-browser/shared';

export const LAUNCHD_LABEL = 'com.claude-browser.broker';

export interface LaunchdOptions {
  nodePath: string;
  scriptPath: string;
  label?: string;
  home?: string;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Render a launchd plist string for the always-on broker daemon. */
export function renderLaunchdPlist(opts: LaunchdOptions): string {
  const label = opts.label ?? LAUNCHD_LABEL;
  const home = opts.home ?? homedir();
  const logDir = join(home, CONFIG_DIR);
  const stdout = join(logDir, 'broker.out.log');
  const stderr = join(logDir, 'broker.err.log');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(opts.nodePath)}</string>
    <string>${xmlEscape(opts.scriptPath)}</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderr)}</string>
</dict>
</plist>
`;
}
```

- [ ] **Step 4: Run the test, expecting PASS.**
```bash
npm run test --workspace @claude-browser/broker -- launchd.test
```

- [ ] **Step 5: Commit.**
```bash
git add packages/broker/src/launchd.ts packages/broker/test/launchd.test.ts && git commit -m "broker: launchd.ts render KeepAlive+RunAtLoad plist for com.claude-browser.broker"
```

### Task 13: index.ts — entry point (load config, start server, log)

Files:
- Create: `packages/broker/src/index.ts`

This is the thin daemon entry the launchd `ProgramArguments` runs. No logic beyond glue (config load + start + log + keep-alive), so it is verified by `tsc --noEmit` and the package build rather than a dedicated unit test (the server it wires is fully covered by Task 11).

- [ ] **Step 1: Write `packages/broker/src/index.ts` (complete).**
```ts
import { loadConfig } from './config.js';
import { startServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const server = await startServer(config);
  // eslint-disable-next-line no-console
  console.log(`[claude-browser-broker] listening on ws://${server.host}:${server.port}`);

  const shutdown = (signal: string): void => {
    // eslint-disable-next-line no-console
    console.log(`[claude-browser-broker] ${signal} received, shutting down`);
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[claude-browser-broker] fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Type-check the whole package.**
```bash
npm run lint --workspace @claude-browser/broker
```

- [ ] **Step 3: Build the package (verifies tsup config + bin emit).**
```bash
npm run build --workspace @claude-browser/broker
```

- [ ] **Step 4: Run the full broker test suite to confirm nothing regressed.**
```bash
npm run test --workspace @claude-browser/broker
```

- [ ] **Step 5: Commit.**
```bash
git add packages/broker/src/index.ts && git commit -m "broker: index.ts daemon entry (load config, start server, graceful shutdown)"
```


---

# Milestone 3 — Chrome Extension

## Package: `packages/extension` — MV3 Chrome extension (thin CDP relay + Codex-grade reconnect)

This package is a Manifest V3 Chrome extension that connects to the broker over a loopback WebSocket, relays `executeCdp` calls to `chrome.debugger`, forwards CDP events back as notifications, serves the non-CDP helper methods (`getTabs`/`newTab`/`switchTab`/`closeTab`/`getHistory`/`attach`/`detach`), and self-heals across service-worker death via a dual `setTimeout` + `chrome.alarms` reconnect discipline. All "smarts" live in the MCP server; this extension stays a dumb, stable relay.

The contract symbols used throughout come from `@claude-browser/shared` (`packages/shared/src/protocol.ts`): `Method`, `Notif`, `BrowserHello`, `ExecuteCdpParams`, `ExecuteCdpResult`, `CdpTarget`, `OnCdpEventParams`, `OnStatusParams`, `GetTabsResult`, `TabInfo`, `NewTabParams`, `NewTabResult`, `SwitchTabParams`, `CloseTabParams`, `GetHistoryParams`, `GetHistoryResult`, `HistoryEntry`, `AttachParams`, `DetachParams`, `JsonRpcRequest`, `JsonRpcNotification`, `JsonRpcSuccess`, `JsonRpcErrorResponse`, `JsonRpcMessage`, `ErrorCode`, `DEFAULT_PORT`.

Run all commands from the repo root `/Users/ming/Documents/code/ai/claude-ext`. The extension is bundled with esbuild and unit-tested with vitest using a hand-rolled global `chrome` mock and a fake `WebSocket`.

---

### Task 14: Scaffold the extension package (package.json + tsconfig + vitest config)

**Files**
- Create: `packages/extension/package.json`
- Create: `packages/extension/tsconfig.json`
- Create: `packages/extension/vitest.config.ts`

This is pure scaffold; no tests.

- [ ] **Step 1: Write `packages/extension/package.json`.** Depends on `@claude-browser/shared` (workspace), declares scripts for build/test. `@types/chrome` provides the `chrome` ambient namespace; `esbuild` and `vitest` are dev deps. Type is `module` (ESM).

```json
{
  "name": "@claude-browser/extension",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node esbuild.mjs",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@claude-browser/shared": "*"
  },
  "devDependencies": {
    "@types/chrome": "^0.0.268",
    "esbuild": "^0.23.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Write `packages/extension/tsconfig.json`.** Extends the repo base, targets the DOM + worker libs (the SW runs in a worker-like global with `WebSocket`, `setTimeout`), includes the chrome types.

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable", "WebWorker"],
    "types": ["chrome"],
    "rootDir": "src",
    "outDir": "dist",
    "noEmit": true
  },
  "include": ["src", "esbuild.mjs", "vitest.config.ts"]
}
```

- [ ] **Step 3: Write `packages/extension/vitest.config.ts`.** Use the default node environment (we provide our own `chrome` + `WebSocket` globals per test, so jsdom is unnecessary). Globals on so `describe/it/expect/vi` are available without imports.

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Install workspace deps from the repo root.**

```bash
npm install
```

- [ ] **Step 5: Commit the scaffold.**

```bash
git add packages/extension/package.json packages/extension/tsconfig.json packages/extension/vitest.config.ts && git commit -m "extension: scaffold package.json, tsconfig, vitest config"
```

---

### Task 15: The chrome + WebSocket test mock (shared test helper)

**Files**
- Create: `packages/extension/test/chromeMock.ts`

A reusable hand-rolled `chrome` mock plus a fake `WebSocket` that the transport/relay/helpers tests drive. No production logic, so no TDD sub-steps — but every later test imports this, so it must be complete and correct.

- [ ] **Step 1: Write `packages/extension/test/chromeMock.ts`.** Provides `FakeWebSocket` (controllable open/close/message, records sent frames), `installChromeMock()` (assigns a fake `chrome` to `globalThis`), and accessors for the fakes. Models `chrome.alarms` (create/clear/onAlarm), `chrome.storage.local` (get/set with an in-memory store), `chrome.debugger` (attach/detach/sendCommand/onEvent/onDetach), `chrome.tabs`, `chrome.history`, `chrome.runtime.id`, and `chrome.scripting`.

```ts
import { vi } from 'vitest';

/** Records of every alarm created/cleared and the registered onAlarm listeners. */
export interface FakeAlarms {
  created: Record<string, chrome.alarms.AlarmCreateInfo>;
  cleared: string[];
  listeners: Array<(alarm: { name: string }) => void>;
  fire(name: string): void;
}

/** A controllable fake WebSocket recording outbound frames. */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  closeCalled = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closeCalled = true;
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  // Test drivers:
  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  emitMessage(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  emitClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  /** The most recently constructed socket. */
  static latest(): FakeWebSocket {
    const s = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (!s) throw new Error('no FakeWebSocket constructed');
    return s;
  }
  static reset(): void {
    FakeWebSocket.instances = [];
  }
}

export interface ChromeMock {
  chrome: typeof chrome;
  alarms: FakeAlarms;
  storage: Record<string, unknown>;
  debuggerEvents: Array<(source: chrome.debugger.Debuggee, method: string, params?: object) => void>;
  detachListeners: Array<(source: chrome.debugger.Debuggee, reason: string) => void>;
  /** queued sendCommand resolutions keyed by method */
  sendCommandImpl: (target: chrome.debugger.Debuggee, method: string, params?: object) => Promise<unknown>;
  emitDebuggerEvent(source: chrome.debugger.Debuggee, method: string, params?: object): void;
  emitDetach(source: chrome.debugger.Debuggee, reason: string): void;
}

export function installChromeMock(): ChromeMock {
  const storage: Record<string, unknown> = {};
  const alarms: FakeAlarms = {
    created: {},
    cleared: [],
    listeners: [],
    fire(name: string) {
      for (const l of this.listeners) l({ name });
    },
  };
  const debuggerEvents: ChromeMock['debuggerEvents'] = [];
  const detachListeners: ChromeMock['detachListeners'] = [];

  const mock: ChromeMock = {
    alarms,
    storage,
    debuggerEvents,
    detachListeners,
    sendCommandImpl: async () => ({}),
    emitDebuggerEvent(source, method, params) {
      for (const l of debuggerEvents) l(source, method, params);
    },
    emitDetach(source, reason) {
      for (const l of detachListeners) l(source, reason);
    },
    chrome: {} as typeof chrome,
  };

  const chromeObj = {
    runtime: { id: 'testextensionid', lastError: undefined as unknown },
    alarms: {
      create: vi.fn((name: string, info: chrome.alarms.AlarmCreateInfo) => {
        alarms.created[name] = info;
        return Promise.resolve();
      }),
      clear: vi.fn((name: string) => {
        alarms.cleared.push(name);
        return Promise.resolve(true);
      }),
      onAlarm: {
        addListener: vi.fn((l: (a: { name: string }) => void) => alarms.listeners.push(l)),
      },
    },
    storage: {
      local: {
        set: vi.fn((items: Record<string, unknown>) => {
          Object.assign(storage, items);
          return Promise.resolve();
        }),
        get: vi.fn((keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of list) if (k in storage) out[k] = storage[k];
          return Promise.resolve(out);
        }),
      },
    },
    debugger: {
      attach: vi.fn(() => Promise.resolve()),
      detach: vi.fn(() => Promise.resolve()),
      sendCommand: vi.fn((target: chrome.debugger.Debuggee, method: string, params?: object) =>
        mock.sendCommandImpl(target, method, params),
      ),
      onEvent: { addListener: vi.fn((l: ChromeMock['debuggerEvents'][number]) => debuggerEvents.push(l)) },
      onDetach: { addListener: vi.fn((l: ChromeMock['detachListeners'][number]) => detachListeners.push(l)) },
    },
    tabs: {
      query: vi.fn(() => Promise.resolve([] as chrome.tabs.Tab[])),
      create: vi.fn((props: chrome.tabs.CreateProperties) =>
        Promise.resolve({ id: 99, url: props.url, active: true, windowId: 1 } as chrome.tabs.Tab),
      ),
      update: vi.fn(() => Promise.resolve({} as chrome.tabs.Tab)),
      remove: vi.fn(() => Promise.resolve()),
    },
    history: {
      search: vi.fn(() => Promise.resolve([] as chrome.history.HistoryItem[])),
    },
    scripting: {
      executeScript: vi.fn(() => Promise.resolve([])),
    },
  };

  mock.chrome = chromeObj as unknown as typeof chrome;
  (globalThis as { chrome?: typeof chrome }).chrome = mock.chrome;
  return mock;
}

export function installFakeWebSocket(): void {
  FakeWebSocket.reset();
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket as unknown;
}
```

- [ ] **Step 2: Commit the test mock.**

```bash
git add packages/extension/test/chromeMock.ts && git commit -m "extension: hand-rolled chrome + WebSocket test mock"
```

---

### Task 16: `transport.ts` — JSON-RPC peer + reconnect discipline (TDD)

**Files**
- Test: `packages/extension/test/transport.test.ts`
- Create: `packages/extension/src/background/transport.ts`

The `Transport` is the heart of the stability story. It is the WS client + a minimal JSON-RPC peer:
- `sendRequest(method, params)` → assigns an integer id, stores `{resolve,reject}` in a pending map, returns a promise.
- `sendNotification(method, params)` → fire-and-forget JSON-RPC notification.
- `registerHandler(method, fn)` → inbound requests are dispatched to handlers, whose return value is sent back as a `JsonRpcSuccess` (or a `JsonRpcErrorResponse` on throw).
- Inbound `JsonRpcSuccess`/`JsonRpcErrorResponse` resolve/reject the matching pending entry.
- Inbound notifications dispatch to notification handlers.
- `connect()` opens the socket and sends a `BrowserHello` first; on open, status → `connected`.
- On `onclose`: reject all pending with `ErrorCode.EXTENSION_DISCONNECTED`, status → `reconnecting`, and `scheduleReconnect()` fires BOTH a 5s `setTimeout` AND `chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 })`.
- A 30s heartbeat sends `Method.PING`; if no `pong` within 3s, it forces `close()` (→ reconnect).
- Status is mirrored to `chrome.storage.local` under key `claudeBrowserStatus` as an `OnStatusParams`.

We inject `WebSocket`, timer functions, and `chrome` indirectly via globals (set by the mock), keeping production code free of test seams while remaining testable with fake timers.

- [ ] **Step 1: Write the failing test `packages/extension/test/transport.test.ts`.** It asserts: hello sent on open; request id correlation + resolve; inbound error rejects with the right code; onclose rejects pending with `EXTENSION_DISCONNECTED`; `scheduleReconnect` schedules BOTH a `setTimeout` and an alarm; heartbeat ping is sent at 30s and a missing pong forces a reconnect; status mirrored to storage.

```ts
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock, installFakeWebSocket, FakeWebSocket, type ChromeMock } from './chromeMock';
import { ErrorCode, Method } from '@claude-browser/shared';

let mock: ChromeMock;

beforeEach(() => {
  vi.useFakeTimers();
  mock = installChromeMock();
  installFakeWebSocket();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function loadTransport() {
  const mod = await import('../src/background/transport');
  return mod;
}

function lastFrame(ws: FakeWebSocket): unknown {
  return JSON.parse(ws.sent[ws.sent.length - 1]);
}

describe('Transport', () => {
  it('sends a BrowserHello first on open and mirrors connected status', async () => {
    const { Transport, RECONNECT_ALARM } = await loadTransport();
    expect(RECONNECT_ALARM).toBeTypeOf('string');
    const t = new Transport({ port: 8787, extensionId: 'testextensionid' });
    t.connect();
    const ws = FakeWebSocket.latest();
    expect(ws.url).toBe('ws://127.0.0.1:8787');
    ws.emitOpen();
    const hello = JSON.parse(ws.sent[0]);
    expect(hello).toEqual({ type: 'hello', role: 'browser', extensionId: 'testextensionid' });
    expect(mock.storage.claudeBrowserStatus).toMatchObject({ state: 'connected' });
  });

  it('correlates request ids and resolves with the result', async () => {
    const { Transport } = await loadTransport();
    const t = new Transport({ port: 8787, extensionId: 'testextensionid' });
    t.connect();
    const ws = FakeWebSocket.latest();
    ws.emitOpen();
    const p = t.sendRequest('ping', { hi: 1 });
    const req = lastFrame(ws) as { id: number; method: string; params: unknown };
    expect(req.method).toBe('ping');
    expect(req.params).toEqual({ hi: 1 });
    ws.emitMessage({ jsonrpc: '2.0', id: req.id, result: { pong: true } });
    await expect(p).resolves.toEqual({ pong: true });
  });

  it('rejects a request when an error response arrives', async () => {
    const { Transport } = await loadTransport();
    const t = new Transport({ port: 8787, extensionId: 'testextensionid' });
    t.connect();
    const ws = FakeWebSocket.latest();
    ws.emitOpen();
    const p = t.sendRequest('ping');
    const req = lastFrame(ws) as { id: number };
    ws.emitMessage({ jsonrpc: '2.0', id: req.id, error: { code: ErrorCode.CDP_ERROR, message: 'boom' } });
    await expect(p).rejects.toMatchObject({ code: ErrorCode.CDP_ERROR, message: 'boom' });
  });

  it('dispatches inbound requests to registered handlers and replies with success', async () => {
    const { Transport } = await loadTransport();
    const t = new Transport({ port: 8787, extensionId: 'testextensionid' });
    t.registerHandler('getTabs', async () => ({ tabs: [{ id: 1 }] }));
    t.connect();
    const ws = FakeWebSocket.latest();
    ws.emitOpen();
    ws.sent.length = 0;
    ws.emitMessage({ jsonrpc: '2.0', id: 7, method: 'getTabs' });
    await vi.advanceTimersByTimeAsync(0);
    const reply = JSON.parse(ws.sent[0]) as { id: number; result: unknown };
    expect(reply.id).toBe(7);
    expect(reply.result).toEqual({ tabs: [{ id: 1 }] });
  });

  it('replies with a JSON-RPC error when a handler throws', async () => {
    const { Transport } = await loadTransport();
    const t = new Transport({ port: 8787, extensionId: 'testextensionid' });
    t.registerHandler('getTabs', async () => {
      throw { code: ErrorCode.CDP_ERROR, message: 'nope' };
    });
    t.connect();
    const ws = FakeWebSocket.latest();
    ws.emitOpen();
    ws.sent.length = 0;
    ws.emitMessage({ jsonrpc: '2.0', id: 8, method: 'getTabs' });
    await vi.advanceTimersByTimeAsync(0);
    const reply = JSON.parse(ws.sent[0]) as { id: number; error: { code: number } };
    expect(reply.id).toBe(8);
    expect(reply.error.code).toBe(ErrorCode.CDP_ERROR);
  });

  it('rejects all pending and schedules BOTH a setTimeout and an alarm on close', async () => {
    const { Transport, RECONNECT_ALARM } = await loadTransport();
    const t = new Transport({ port: 8787, extensionId: 'testextensionid' });
    t.connect();
    const ws = FakeWebSocket.latest();
    ws.emitOpen();
    const p = t.sendRequest('ping');
    ws.emitClose();
    await expect(p).rejects.toMatchObject({ code: ErrorCode.EXTENSION_DISCONNECTED });
    // Alarm scheduled with the survives-SW-death period:
    expect(mock.alarms.created[RECONNECT_ALARM]).toEqual({ periodInMinutes: 0.5 });
    expect(mock.storage.claudeBrowserStatus).toMatchObject({ state: 'reconnecting' });
    // setTimeout retry also scheduled: advancing 5s constructs a brand-new socket.
    const before = FakeWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeWebSocket.instances.length).toBe(before + 1);
  });

  it('sends a heartbeat ping at 30s and forces reconnect when no pong in 3s', async () => {
    const { Transport } = await loadTransport();
    const t = new Transport({ port: 8787, extensionId: 'testextensionid' });
    t.connect();
    const ws = FakeWebSocket.latest();
    ws.emitOpen();
    ws.sent.length = 0;
    await vi.advanceTimersByTimeAsync(30000);
    const ping = JSON.parse(ws.sent[0]) as { method: string };
    expect(ping.method).toBe(Method.PING);
    expect(ws.closeCalled).toBe(false);
    // No pong arrives within 3s -> the socket is torn down.
    await vi.advanceTimersByTimeAsync(3000);
    expect(ws.closeCalled).toBe(true);
  });

  it('does not force reconnect when a pong arrives in time', async () => {
    const { Transport } = await loadTransport();
    const t = new Transport({ port: 8787, extensionId: 'testextensionid' });
    t.connect();
    const ws = FakeWebSocket.latest();
    ws.emitOpen();
    ws.sent.length = 0;
    await vi.advanceTimersByTimeAsync(30000);
    const ping = JSON.parse(ws.sent[0]) as { id: number };
    ws.emitMessage({ jsonrpc: '2.0', id: ping.id, result: { pong: true } });
    await vi.advanceTimersByTimeAsync(3000);
    expect(ws.closeCalled).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test, expecting FAIL (module does not exist yet).**

```bash
npm run test --workspace @claude-browser/extension -- transport
```

- [ ] **Step 3: Implement `packages/extension/src/background/transport.ts` with COMPLETE code.**

```ts
import {
  type BrowserHello,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcNotification,
  type JsonRpcSuccess,
  type JsonRpcErrorResponse,
  type OnStatusParams,
  ErrorCode,
  Method,
} from '@claude-browser/shared';

export const RECONNECT_ALARM = 'claude-browser-reconnect';
export const STATUS_KEY = 'claudeBrowserStatus';

const RECONNECT_DELAY_MS = 5000;
const HEARTBEAT_MS = 30000;
const PONG_TIMEOUT_MS = 3000;

export interface TransportOptions {
  port: number;
  extensionId: string;
}

type RequestHandler = (params: unknown) => Promise<unknown> | unknown;
type NotificationHandler = (params: unknown) => void;
type RpcError = { code: number; message: string; data?: unknown };

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: RpcError) => void;
}

/**
 * WS client + minimal JSON-RPC peer for the extension side.
 * Owns the Codex-grade reconnect discipline: dual setTimeout + chrome.alarms,
 * 30s heartbeat with a 3s pong deadline, and status mirrored to chrome.storage.local.
 */
export class Transport {
  private readonly opts: TransportOptions;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: TransportOptions) {
    this.opts = opts;
  }

  registerHandler(method: string, fn: RequestHandler): void {
    this.requestHandlers.set(method, fn);
  }

  onNotification(method: string, fn: NotificationHandler): void {
    this.notificationHandlers.set(method, fn);
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  connect(): void {
    // Eager connect: tolerate a half-open prior socket.
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    this.clearReconnectTimer();
    const ws = new WebSocket(`ws://127.0.0.1:${this.opts.port}`);
    this.ws = ws;
    ws.onopen = () => {
      const hello: BrowserHello = { type: 'hello', role: 'browser', extensionId: this.opts.extensionId };
      ws.send(JSON.stringify(hello));
      void this.setStatus('connected');
      this.startHeartbeat();
    };
    ws.onmessage = (ev: { data: string }) => this.handleMessage(ev.data);
    ws.onerror = () => {
      /* errors surface via onclose; nothing to do here */
    };
    ws.onclose = () => this.handleClose();
  }

  sendRequest<R = unknown>(method: string, params?: unknown): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.pending.delete(id);
        reject({ code: ErrorCode.EXTENSION_DISCONNECTED, message: 'socket not open' });
        return;
      }
      this.ws.send(JSON.stringify(req));
    });
  }

  sendNotification(method: string, params?: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const notif: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.ws.send(JSON.stringify(notif));
  }

  private handleMessage(data: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(data) as JsonRpcMessage;
    } catch {
      return;
    }
    if ('id' in msg && 'result' in msg) {
      this.resolvePending(msg as JsonRpcSuccess);
      return;
    }
    if ('id' in msg && 'error' in msg) {
      this.rejectPending(msg as JsonRpcErrorResponse);
      return;
    }
    if ('method' in msg && 'id' in msg) {
      void this.dispatchRequest(msg as JsonRpcRequest);
      return;
    }
    if ('method' in msg) {
      this.dispatchNotification(msg as JsonRpcNotification);
    }
  }

  private resolvePending(msg: JsonRpcSuccess): void {
    const id = msg.id as number;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.resolve(msg.result);
  }

  private rejectPending(msg: JsonRpcErrorResponse): void {
    if (msg.id === null) return;
    const id = msg.id as number;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.reject(msg.error);
  }

  private async dispatchRequest(req: JsonRpcRequest): Promise<void> {
    const handler = this.requestHandlers.get(req.method);
    if (!handler) {
      this.replyError(req.id, { code: ErrorCode.METHOD_NOT_FOUND, message: `no handler: ${req.method}` });
      return;
    }
    try {
      const result = await handler(req.params);
      const ok: JsonRpcSuccess = { jsonrpc: '2.0', id: req.id, result };
      this.ws?.send(JSON.stringify(ok));
    } catch (err) {
      this.replyError(req.id, this.toRpcError(err));
    }
  }

  private dispatchNotification(notif: JsonRpcNotification): void {
    const handler = this.notificationHandlers.get(notif.method);
    handler?.(notif.params);
  }

  private replyError(id: number | string, error: RpcError): void {
    const res: JsonRpcErrorResponse = { jsonrpc: '2.0', id, error };
    this.ws?.send(JSON.stringify(res));
  }

  private toRpcError(err: unknown): RpcError {
    if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
      const e = err as RpcError;
      return { code: e.code, message: e.message, data: e.data };
    }
    return { code: ErrorCode.INTERNAL, message: err instanceof Error ? err.message : String(err) };
  }

  private handleClose(): void {
    this.stopHeartbeat();
    // Reject all in-flight calls so the agent retries instead of hanging.
    for (const [, p] of this.pending) {
      p.reject({ code: ErrorCode.EXTENSION_DISCONNECTED, message: 'extension socket closed' });
    }
    this.pending.clear();
    this.ws = null;
    void this.setStatus('reconnecting');
    this.scheduleReconnect();
  }

  /** Fire BOTH a 5s setTimeout AND a chrome.alarms alarm that survives SW death. */
  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    void chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.beat(), HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pongTimer !== null) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private beat(): void {
    if (!this.isConnected()) return;
    // Activity resets the MV3 idle timer; a missing pong reveals a half-open socket.
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      this.ws?.close();
    }, PONG_TIMEOUT_MS);
    this.sendRequest(Method.PING)
      .then(() => {
        if (this.pongTimer !== null) {
          clearTimeout(this.pongTimer);
          this.pongTimer = null;
        }
      })
      .catch(() => {
        /* close() path already handles teardown */
      });
  }

  private async setStatus(state: OnStatusParams['state'], detail?: string): Promise<void> {
    const status: OnStatusParams = detail ? { state, detail } : { state };
    await chrome.storage.local.set({ [STATUS_KEY]: status });
  }
}
```

- [ ] **Step 4: Run the test, expecting PASS.**

```bash
npm run test --workspace @claude-browser/extension -- transport
```

- [ ] **Step 5: Commit.**

```bash
git add packages/extension/src/background/transport.ts packages/extension/test/transport.test.ts && git commit -m "extension: transport JSON-RPC peer + dual reconnect + heartbeat"
```

---

### Task 17: `relay.ts` — CDP relay (executeCdp + attach + event forwarding) (TDD)

**Files**
- Test: `packages/extension/test/relay.test.ts`
- Create: `packages/extension/src/background/relay.ts`

The relay is a pure pass-through:
- `handleExecuteCdp(params: ExecuteCdpParams)` → `chrome.debugger.sendCommand(debuggee, method, params.params)` and returns the raw result as `ExecuteCdpResult`.
- `attach(target)` → `chrome.debugger.attach(debuggee, "1.3")` tolerating an "already attached" error, then `Emulation.setDeviceMetricsOverride` with `deviceScaleFactor: 1, mobile: false` so screenshot pixels == CSS pixels == input coordinates, then enable `Runtime` and `Log` domains so console CDP events flow into the broker buffer.
- `detach(target)` → `chrome.debugger.detach`.
- `registerCdpEventForwarding(transport)` → `chrome.debugger.onEvent` → `transport.sendNotification(Notif.ON_CDP_EVENT, { source, method, params })` as `OnCdpEventParams`.
- `registerAutoReattach(transport)` → on `chrome.debugger.onDetach`, if the reason is not a user-initiated cancel, re-`attach` the target (keeps the debugger alive across transient detaches).

`CdpTarget` carries `tabId?` / `targetId?`; we translate it into a `chrome.debugger.Debuggee` (`{ tabId }` or `{ targetId }`).

- [ ] **Step 1: Write the failing test `packages/extension/test/relay.test.ts`.**

```ts
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock, type ChromeMock } from './chromeMock';
import { Notif } from '@claude-browser/shared';

let mock: ChromeMock;

beforeEach(() => {
  mock = installChromeMock();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function loadRelay() {
  return import('../src/background/relay');
}

describe('relay', () => {
  it('handleExecuteCdp forwards to chrome.debugger.sendCommand and returns the result', async () => {
    const { handleExecuteCdp } = await loadRelay();
    mock.sendCommandImpl = async (_t, method) => {
      expect(method).toBe('Page.navigate');
      return { frameId: 'f1' };
    };
    const result = await handleExecuteCdp({
      target: { tabId: 5 },
      method: 'Page.navigate',
      params: { url: 'https://example.com' },
    });
    expect(result).toEqual({ frameId: 'f1' });
    expect(mock.chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 5 },
      'Page.navigate',
      { url: 'https://example.com' },
    );
  });

  it('attach attaches at 1.3, overrides device metrics with scale 1, and enables Runtime+Log', async () => {
    const { attach } = await loadRelay();
    const calls: string[] = [];
    mock.sendCommandImpl = async (_t, method, params) => {
      calls.push(method);
      if (method === 'Emulation.setDeviceMetricsOverride') {
        expect(params).toMatchObject({ deviceScaleFactor: 1, mobile: false });
      }
      return {};
    };
    await attach({ tabId: 7 });
    expect(mock.chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 7 }, '1.3');
    expect(calls).toContain('Emulation.setDeviceMetricsOverride');
    expect(calls).toContain('Runtime.enable');
    expect(calls).toContain('Log.enable');
  });

  it('attach tolerates an already-attached error and still configures the target', async () => {
    const { attach } = await loadRelay();
    (mock.chrome.debugger.attach as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Another debugger is already attached to the tab with id: 7.'),
    );
    const calls: string[] = [];
    mock.sendCommandImpl = async (_t, method) => {
      calls.push(method);
      return {};
    };
    await attach({ tabId: 7 });
    expect(calls).toContain('Emulation.setDeviceMetricsOverride');
    expect(calls).toContain('Runtime.enable');
    expect(calls).toContain('Log.enable');
  });

  it('attach rethrows a non-already-attached error', async () => {
    const { attach } = await loadRelay();
    (mock.chrome.debugger.attach as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Cannot access a chrome:// URL'),
    );
    await expect(attach({ tabId: 7 })).rejects.toThrow(/chrome:\/\//);
  });

  it('forwards chrome.debugger.onEvent as an ON_CDP_EVENT notification', async () => {
    const { registerCdpEventForwarding } = await loadRelay();
    const sent: Array<{ method: string; params: unknown }> = [];
    const transport = { sendNotification: (method: string, params: unknown) => sent.push({ method, params }) };
    registerCdpEventForwarding(transport);
    mock.emitDebuggerEvent({ tabId: 5 }, 'Runtime.consoleAPICalled', { type: 'log' });
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe(Notif.ON_CDP_EVENT);
    expect(sent[0].params).toEqual({
      source: { tabId: 5 },
      method: 'Runtime.consoleAPICalled',
      params: { type: 'log' },
    });
  });

  it('auto-reattaches on a non-canceled onDetach', async () => {
    const { registerAutoReattach } = await loadRelay();
    mock.sendCommandImpl = async () => ({});
    registerAutoReattach();
    mock.emitDetach({ tabId: 9 }, 'target_closed_unexpectedly');
    await vi.waitFor(() => expect(mock.chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 9 }, '1.3'));
  });

  it('does NOT reattach when the user canceled the debugger', async () => {
    const { registerAutoReattach } = await loadRelay();
    registerAutoReattach();
    mock.emitDetach({ tabId: 9 }, 'canceled_by_user');
    await new Promise((r) => setTimeout(r, 5));
    expect(mock.chrome.debugger.attach).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test, expecting FAIL.**

```bash
npm run test --workspace @claude-browser/extension -- relay
```

- [ ] **Step 3: Implement `packages/extension/src/background/relay.ts` with COMPLETE code.**

```ts
import {
  type CdpTarget,
  type ExecuteCdpParams,
  type ExecuteCdpResult,
  type OnCdpEventParams,
  Notif,
} from '@claude-browser/shared';

/** Minimal surface of Transport that the relay needs (kept narrow for testability). */
export interface CdpEventSink {
  sendNotification(method: string, params?: unknown): void;
}

const CDP_VERSION = '1.3';

function toDebuggee(target: CdpTarget): chrome.debugger.Debuggee {
  if (typeof target.tabId === 'number') return { tabId: target.tabId };
  if (typeof target.targetId === 'string') return { targetId: target.targetId };
  throw new Error('CdpTarget requires tabId or targetId');
}

/** executeCdp -> chrome.debugger.sendCommand pass-through. */
export async function handleExecuteCdp(params: ExecuteCdpParams): Promise<ExecuteCdpResult> {
  const debuggee = toDebuggee(params.target);
  return chrome.debugger.sendCommand(debuggee, params.method, params.params);
}

function isAlreadyAttached(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already attached/i.test(msg);
}

/**
 * Attach the debugger at protocol 1.3 (tolerating already-attached), pin
 * deviceScaleFactor to 1 so screenshot px == CSS px == input coords, and enable
 * the Runtime + Log domains so console CDP events flow to the broker buffer.
 */
export async function attach(target: CdpTarget): Promise<void> {
  const debuggee = toDebuggee(target);
  try {
    await chrome.debugger.attach(debuggee, CDP_VERSION);
  } catch (err) {
    if (!isAlreadyAttached(err)) throw err;
  }
  await chrome.debugger.sendCommand(debuggee, 'Emulation.setDeviceMetricsOverride', {
    width: 0,
    height: 0,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await chrome.debugger.sendCommand(debuggee, 'Runtime.enable', {});
  await chrome.debugger.sendCommand(debuggee, 'Log.enable', {});
}

export async function detach(target: CdpTarget): Promise<void> {
  await chrome.debugger.detach(toDebuggee(target));
}

/** Forward every CDP event to the agent as an ON_CDP_EVENT notification. */
export function registerCdpEventForwarding(transport: CdpEventSink): void {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const evt: OnCdpEventParams = {
      source: { tabId: source.tabId, targetId: source.targetId },
      method,
      params: params ?? null,
    };
    transport.sendNotification(Notif.ON_CDP_EVENT, evt);
  });
}

/** Re-attach the debugger when Chrome detaches us for any reason other than a user cancel. */
export function registerAutoReattach(): void {
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (reason === 'canceled_by_user') return;
    const target: CdpTarget = { tabId: source.tabId, targetId: source.targetId };
    void attach(target).catch(() => {
      /* best-effort; the heartbeat/reconnect path is the backstop */
    });
  });
}
```

- [ ] **Step 4: Run the test, expecting PASS.**

```bash
npm run test --workspace @claude-browser/extension -- relay
```

- [ ] **Step 5: Commit.**

```bash
git add packages/extension/src/background/relay.ts packages/extension/test/relay.test.ts && git commit -m "extension: CDP relay (executeCdp, attach scale=1, event forwarding, auto-reattach)"
```

---

### Task 18: `helpers.ts` — tab/history request handlers (TDD)

**Files**
- Test: `packages/extension/test/helpers.test.ts`
- Create: `packages/extension/src/background/helpers.ts`

The non-CDP commands that need Chrome APIs. Each maps a contract param type to a Chrome API call and returns the contract result type:
- `getTabs()` → `chrome.tabs.query({})` → `GetTabsResult` (mapping `chrome.tabs.Tab` → `TabInfo`).
- `newTab(params: NewTabParams)` → `chrome.tabs.create({ url })` → `NewTabResult` (`TabInfo`).
- `switchTab(params: SwitchTabParams)` → `chrome.tabs.update(tabId, { active: true })`.
- `closeTab(params: CloseTabParams)` → `chrome.tabs.remove(tabId)`.
- `getHistory(params: GetHistoryParams)` → `chrome.history.search({ text: query, maxResults: limit })` → `GetHistoryResult` (`HistoryEntry[]`). (Plumbing only — no v1 tool exposes it, but the protocol method exists, so the handler is built.)

- [ ] **Step 1: Write the failing test `packages/extension/test/helpers.test.ts`.**

```ts
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock, type ChromeMock } from './chromeMock';

let mock: ChromeMock;

beforeEach(() => {
  mock = installChromeMock();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function loadHelpers() {
  return import('../src/background/helpers');
}

describe('helpers', () => {
  it('getTabs maps chrome.tabs.Tab into TabInfo', async () => {
    const { getTabs } = await loadHelpers();
    (mock.chrome.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 1, url: 'https://a.com', title: 'A', active: true, windowId: 10, pinned: false },
      { id: 2, url: 'https://b.com', title: 'B', active: false, windowId: 10, pinned: false },
    ]);
    const res = await getTabs();
    expect(res).toEqual({
      tabs: [
        { id: 1, url: 'https://a.com', title: 'A', active: true, windowId: 10 },
        { id: 2, url: 'https://b.com', title: 'B', active: false, windowId: 10 },
      ],
    });
  });

  it('newTab creates a tab and returns TabInfo', async () => {
    const { newTab } = await loadHelpers();
    (mock.chrome.tabs.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 42,
      url: 'https://x.com',
      title: 'X',
      active: true,
      windowId: 3,
    });
    const res = await newTab({ url: 'https://x.com' });
    expect(mock.chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://x.com' });
    expect(res).toEqual({ id: 42, url: 'https://x.com', title: 'X', active: true, windowId: 3 });
  });

  it('switchTab activates the tab', async () => {
    const { switchTab } = await loadHelpers();
    await switchTab({ tabId: 7 });
    expect(mock.chrome.tabs.update).toHaveBeenCalledWith(7, { active: true });
  });

  it('closeTab removes the tab', async () => {
    const { closeTab } = await loadHelpers();
    await closeTab({ tabId: 7 });
    expect(mock.chrome.tabs.remove).toHaveBeenCalledWith(7);
  });

  it('getHistory searches and maps into HistoryEntry list with default + custom limit', async () => {
    const { getHistory } = await loadHelpers();
    (mock.chrome.history.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      { url: 'https://h.com', title: 'H', lastVisitTime: 123, visitCount: 4 },
    ]);
    const res = await getHistory({ query: 'foo' });
    expect(mock.chrome.history.search).toHaveBeenCalledWith({ text: 'foo', maxResults: 100 });
    expect(res).toEqual({ entries: [{ url: 'https://h.com', title: 'H', lastVisitTime: 123, visitCount: 4 }] });
    await getHistory({ query: 'bar', limit: 5 });
    expect(mock.chrome.history.search).toHaveBeenCalledWith({ text: 'bar', maxResults: 5 });
  });
});
```

- [ ] **Step 2: Run the test, expecting FAIL.**

```bash
npm run test --workspace @claude-browser/extension -- helpers
```

- [ ] **Step 3: Implement `packages/extension/src/background/helpers.ts` with COMPLETE code.**

```ts
import {
  type GetTabsResult,
  type TabInfo,
  type NewTabParams,
  type NewTabResult,
  type SwitchTabParams,
  type CloseTabParams,
  type GetHistoryParams,
  type GetHistoryResult,
  type HistoryEntry,
} from '@claude-browser/shared';

const DEFAULT_HISTORY_LIMIT = 100;

function toTabInfo(tab: chrome.tabs.Tab): TabInfo {
  return {
    id: tab.id ?? -1,
    url: tab.url,
    title: tab.title,
    active: tab.active,
    windowId: tab.windowId,
  };
}

export async function getTabs(): Promise<GetTabsResult> {
  const tabs = await chrome.tabs.query({});
  return { tabs: tabs.map(toTabInfo) };
}

export async function newTab(params: NewTabParams): Promise<NewTabResult> {
  const tab = await chrome.tabs.create({ url: params.url });
  return toTabInfo(tab);
}

export async function switchTab(params: SwitchTabParams): Promise<Record<string, never>> {
  await chrome.tabs.update(params.tabId, { active: true });
  return {};
}

export async function closeTab(params: CloseTabParams): Promise<Record<string, never>> {
  await chrome.tabs.remove(params.tabId);
  return {};
}

export async function getHistory(params: GetHistoryParams): Promise<GetHistoryResult> {
  const items = await chrome.history.search({
    text: params.query,
    maxResults: params.limit ?? DEFAULT_HISTORY_LIMIT,
  });
  const entries: HistoryEntry[] = items.map((i) => ({
    url: i.url ?? '',
    title: i.title,
    lastVisitTime: i.lastVisitTime,
    visitCount: i.visitCount,
  }));
  return { entries };
}
```

- [ ] **Step 4: Run the test, expecting PASS.**

```bash
npm run test --workspace @claude-browser/extension -- helpers
```

- [ ] **Step 5: Commit.**

```bash
git add packages/extension/src/background/helpers.ts packages/extension/test/helpers.test.ts && git commit -m "extension: tab/history helper handlers mapping Chrome APIs to contract types"
```

---

### Task 19: `background/index.ts` — SW entry wiring (TDD)

**Files**
- Test: `packages/extension/test/index.test.ts`
- Create: `packages/extension/src/background/config.ts`
- Create: `packages/extension/src/background/index.ts`

The service-worker entry: build the `Transport`, register all request handlers (`Method.EXECUTE_CDP`, `Method.ATTACH`, `Method.DETACH`, `Method.GET_TABS`, `Method.NEW_TAB`, `Method.SWITCH_TAB`, `Method.CLOSE_TAB`, `Method.GET_HISTORY`, `Method.PING`), register CDP-event forwarding + auto-reattach, eager-connect, and wire `chrome.alarms.onAlarm` (the reconnect alarm) to `connect()`. We expose a pure `bootstrap(transport)` so the wiring is testable without the SW top-level side effects.

`config.ts` resolves the port: the SW can't read `~/.claude-browser/config.json`, so the broker connection uses `DEFAULT_PORT` unless a prior session persisted an override into `chrome.storage.local` under `claudeBrowserPort` (the popup/install flow can set this). The extensionId is `chrome.runtime.id`.

- [ ] **Step 1: Write the failing test `packages/extension/test/index.test.ts`.** Verifies bootstrap registers each method handler, wires the alarm to reconnect, eager-connects, and that the `PING` handler returns a pong.

```ts
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock, type ChromeMock } from './chromeMock';
import { Method } from '@claude-browser/shared';
import { RECONNECT_ALARM } from '../src/background/transport';

let mock: ChromeMock;

beforeEach(() => {
  mock = installChromeMock();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function makeFakeTransport() {
  const handlers = new Map<string, (p: unknown) => unknown>();
  return {
    handlers,
    connectCount: 0,
    registerHandler: vi.fn((m: string, fn: (p: unknown) => unknown) => handlers.set(m, fn)),
    onNotification: vi.fn(),
    sendNotification: vi.fn(),
    sendRequest: vi.fn(),
    connect: vi.fn(function (this: { connectCount: number }) {
      // counted via the wrapper below
    }),
  };
}

describe('background/index bootstrap', () => {
  it('registers every contract method handler and eager-connects', async () => {
    const { bootstrap } = await import('../src/background/index');
    const t = makeFakeTransport();
    bootstrap(t as never);
    for (const m of [
      Method.EXECUTE_CDP,
      Method.ATTACH,
      Method.DETACH,
      Method.GET_TABS,
      Method.NEW_TAB,
      Method.SWITCH_TAB,
      Method.CLOSE_TAB,
      Method.GET_HISTORY,
      Method.PING,
    ]) {
      expect(t.handlers.has(m)).toBe(true);
    }
    expect(t.connect).toHaveBeenCalledTimes(1);
  });

  it('PING handler returns a pong', async () => {
    const { bootstrap } = await import('../src/background/index');
    const t = makeFakeTransport();
    bootstrap(t as never);
    const ping = t.handlers.get(Method.PING)!;
    expect(await ping(undefined)).toEqual({ pong: true });
  });

  it('the reconnect alarm triggers transport.connect()', async () => {
    const { bootstrap } = await import('../src/background/index');
    const t = makeFakeTransport();
    bootstrap(t as never);
    expect(t.connect).toHaveBeenCalledTimes(1);
    mock.alarms.fire(RECONNECT_ALARM);
    expect(t.connect).toHaveBeenCalledTimes(2);
  });

  it('an unrelated alarm does NOT trigger reconnect', async () => {
    const { bootstrap } = await import('../src/background/index');
    const t = makeFakeTransport();
    bootstrap(t as never);
    mock.alarms.fire('some-other-alarm');
    expect(t.connect).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test, expecting FAIL.**

```bash
npm run test --workspace @claude-browser/extension -- index
```

- [ ] **Step 3: Implement `packages/extension/src/background/config.ts`.**

```ts
import { DEFAULT_PORT } from '@claude-browser/shared';

export const PORT_KEY = 'claudeBrowserPort';

/** Resolve the broker port from storage override, falling back to DEFAULT_PORT. */
export async function resolvePort(): Promise<number> {
  const got = await chrome.storage.local.get(PORT_KEY);
  const v = (got as Record<string, unknown>)[PORT_KEY];
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : DEFAULT_PORT;
}

export function resolveExtensionId(): string {
  return chrome.runtime.id;
}
```

- [ ] **Step 4: Implement `packages/extension/src/background/index.ts` with COMPLETE code.** The top-level body (run on every SW wake — the eager-connect that makes the extension self-heal) constructs the real transport and calls `bootstrap`; `bootstrap` itself is the pure, tested wiring.

```ts
import {
  type ExecuteCdpParams,
  type AttachParams,
  type DetachParams,
  type NewTabParams,
  type SwitchTabParams,
  type CloseTabParams,
  type GetHistoryParams,
  Method,
} from '@claude-browser/shared';
import { Transport, RECONNECT_ALARM } from './transport';
import { handleExecuteCdp, attach, detach, registerCdpEventForwarding, registerAutoReattach } from './relay';
import { getTabs, newTab, switchTab, closeTab, getHistory } from './helpers';
import { resolvePort, resolveExtensionId } from './config';

/** Pure wiring: register handlers, event forwarding, alarm reconnect, eager connect. */
export function bootstrap(transport: Transport): void {
  transport.registerHandler(Method.EXECUTE_CDP, (p) => handleExecuteCdp(p as ExecuteCdpParams));
  transport.registerHandler(Method.ATTACH, async (p) => {
    await attach({ tabId: (p as AttachParams).tabId });
    return {};
  });
  transport.registerHandler(Method.DETACH, async (p) => {
    await detach({ tabId: (p as DetachParams).tabId });
    return {};
  });
  transport.registerHandler(Method.GET_TABS, () => getTabs());
  transport.registerHandler(Method.NEW_TAB, (p) => newTab(p as NewTabParams));
  transport.registerHandler(Method.SWITCH_TAB, (p) => switchTab(p as SwitchTabParams));
  transport.registerHandler(Method.CLOSE_TAB, (p) => closeTab(p as CloseTabParams));
  transport.registerHandler(Method.GET_HISTORY, (p) => getHistory(p as GetHistoryParams));
  transport.registerHandler(Method.PING, () => ({ pong: true }));

  registerCdpEventForwarding(transport);
  registerAutoReattach();

  // The alarm survives service-worker death: when Chrome wakes the SW to fire it,
  // we reconnect (the connection is also re-established by the top-level eager connect).
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RECONNECT_ALARM) transport.connect();
  });

  // Eager connect on every SW startup.
  transport.connect();
}

// Top-level side effects: runs on every service-worker wake.
async function main(): Promise<void> {
  const port = await resolvePort();
  const extensionId = resolveExtensionId();
  const transport = new Transport({ port, extensionId });
  bootstrap(transport);
}

void main();
```

- [ ] **Step 5: Run the test, expecting PASS.**

```bash
npm run test --workspace @claude-browser/extension -- index
```

- [ ] **Step 6: Commit.**

```bash
git add packages/extension/src/background/config.ts packages/extension/src/background/index.ts packages/extension/test/index.test.ts && git commit -m "extension: SW entry wiring (handlers, event forwarding, alarm reconnect, eager connect)"
```

---

### Task 20: `content/cursor.ts` — animated cursor overlay

**Files**
- Create: `packages/extension/src/content/cursor.ts`

Optional visual "agent is driving" indicator, injected via `chrome.scripting`. It draws a small absolutely-positioned cursor element moved with `transform: translate3d(...)` and exposes `window.__claudeBrowserCursor.moveTo(x,y)`. This is DOM-only glue with no branching logic worth a unit test (it runs in a real page context); per the plan format, pure-glue may skip TDD but must show complete contents.

- [ ] **Step 1: Write `packages/extension/src/content/cursor.ts` with COMPLETE code.**

```ts
/**
 * Animated agent cursor overlay. Injected into the page via chrome.scripting.
 * Positioned with transform translate3d for GPU-accelerated, layout-free moves.
 * Exposes window.__claudeBrowserCursor.moveTo(x, y) so the relay can drive it.
 */
declare global {
  interface Window {
    __claudeBrowserCursor?: { moveTo(x: number, y: number): void; destroy(): void };
  }
}

const CURSOR_ID = 'claude-browser-cursor';

function ensureCursor(): HTMLElement {
  const existing = document.getElementById(CURSOR_ID);
  if (existing) return existing;
  const el = document.createElement('div');
  el.id = CURSOR_ID;
  el.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    'width:18px',
    'height:18px',
    'margin:-9px 0 0 -9px',
    'border-radius:50%',
    'background:rgba(99,102,241,0.85)',
    'box-shadow:0 0 0 3px rgba(99,102,241,0.30)',
    'pointer-events:none',
    'z-index:2147483647',
    'transition:transform 120ms ease-out',
    'will-change:transform',
    'transform:translate3d(-100px,-100px,0)',
  ].join(';');
  document.documentElement.appendChild(el);
  return el;
}

function moveTo(x: number, y: number): void {
  const el = ensureCursor();
  el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

function destroy(): void {
  document.getElementById(CURSOR_ID)?.remove();
  delete window.__claudeBrowserCursor;
}

window.__claudeBrowserCursor = { moveTo, destroy };
ensureCursor();

export {};
```

- [ ] **Step 2: Commit.**

```bash
git add packages/extension/src/content/cursor.ts && git commit -m "extension: animated agent cursor content script"
```

---

### Task 21: Popup (status indicator) — html + ts

**Files**
- Create: `packages/extension/src/popup/popup.html`
- Create: `packages/extension/src/popup/popup.ts`

The popup reads connection status from `chrome.storage.local` (key `claudeBrowserStatus`, written by `transport.ts`) and shows a green dot for `connected`, amber for `reconnecting`, red for `disconnected`. It never drives reconnection (spec §6/§9). The render mapping has branching, so we TDD `statusDisplay()`.

- [ ] **Step 1: Write the failing test `packages/extension/test/popup.test.ts`.**

```ts
import { describe, expect, it } from 'vitest';
import { statusDisplay } from '../src/popup/popup';

describe('statusDisplay', () => {
  it('maps connected to a green dot', () => {
    expect(statusDisplay({ state: 'connected' })).toEqual({ color: '#22c55e', label: 'Connected' });
  });
  it('maps reconnecting to amber', () => {
    expect(statusDisplay({ state: 'reconnecting' })).toEqual({ color: '#f59e0b', label: 'Reconnecting…' });
  });
  it('maps disconnected to red', () => {
    expect(statusDisplay({ state: 'disconnected' })).toEqual({ color: '#ef4444', label: 'Disconnected' });
  });
  it('treats missing status as disconnected', () => {
    expect(statusDisplay(undefined)).toEqual({ color: '#ef4444', label: 'Disconnected' });
  });
  it('appends detail to the label when present', () => {
    expect(statusDisplay({ state: 'reconnecting', detail: 'broker down' })).toEqual({
      color: '#f59e0b',
      label: 'Reconnecting… (broker down)',
    });
  });
});
```

- [ ] **Step 2: Run the test, expecting FAIL.**

```bash
npm run test --workspace @claude-browser/extension -- popup
```

- [ ] **Step 3: Write `packages/extension/src/popup/popup.ts` with COMPLETE code.** `statusDisplay` is pure (tested); the DOM bootstrap reads storage and renders, guarded so it is a no-op under the test/node environment where `document` is absent.

```ts
import { type OnStatusParams } from '@claude-browser/shared';
import { STATUS_KEY } from '../background/transport';

export interface StatusView {
  color: string;
  label: string;
}

export function statusDisplay(status: OnStatusParams | undefined): StatusView {
  const state = status?.state ?? 'disconnected';
  const base: Record<OnStatusParams['state'], StatusView> = {
    connected: { color: '#22c55e', label: 'Connected' },
    reconnecting: { color: '#f59e0b', label: 'Reconnecting…' },
    disconnected: { color: '#ef4444', label: 'Disconnected' },
  };
  const view = { ...base[state] };
  if (status?.detail) view.label = `${view.label} (${status.detail})`;
  return view;
}

async function render(): Promise<void> {
  const dot = document.getElementById('dot');
  const text = document.getElementById('label');
  if (!dot || !text) return;
  const got = await chrome.storage.local.get(STATUS_KEY);
  const status = (got as Record<string, unknown>)[STATUS_KEY] as OnStatusParams | undefined;
  const view = statusDisplay(status);
  dot.style.background = view.color;
  text.textContent = view.label;
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    void render();
  });
}
```

- [ ] **Step 4: Run the test, expecting PASS.**

```bash
npm run test --workspace @claude-browser/extension -- popup
```

- [ ] **Step 5: Write `packages/extension/src/popup/popup.html` with COMPLETE code.** Loads the esbuild-bundled `popup.js` (no inline scripts — MV3 CSP forbids them).

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>claude-browser</title>
    <style>
      body {
        font: 13px -apple-system, system-ui, sans-serif;
        margin: 0;
        padding: 12px 14px;
        width: 200px;
        color: #1f2937;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      #dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #ef4444;
        flex: none;
      }
      h1 {
        font-size: 12px;
        margin: 0 0 8px;
        color: #6b7280;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
    </style>
  </head>
  <body>
    <h1>claude-browser</h1>
    <div class="row">
      <span id="dot"></span>
      <span id="label">Disconnected</span>
    </div>
    <script type="module" src="popup.js"></script>
  </body>
</html>
```

- [ ] **Step 6: Commit.**

```bash
git add packages/extension/src/popup/popup.html packages/extension/src/popup/popup.ts packages/extension/test/popup.test.ts && git commit -m "extension: popup status indicator (pure statusDisplay + storage render)"
```

---

### Task 22: `manifest.json` (MV3) + icons

**Files**
- Create: `packages/extension/manifest.json`
- Create: `packages/extension/icons/icon16.png`
- Create: `packages/extension/icons/icon48.png`
- Create: `packages/extension/icons/icon128.png`

Pure config (no TDD). MV3 with the `key` pinning a stable extension id (so the broker can allowlist `chrome-extension://<id>` per spec §9), the required permissions (`debugger`, `tabs`, `history`, `alarms`, `scripting`, `storage`), the background service worker as an ES module, the action popup, and a CSP allowing `connect-src ws://127.0.0.1:*`. The `service_worker` points at the esbuild output `background.js`.

- [ ] **Step 1: Generate a fresh keypair and the corresponding pinned id, and print the manifest `key`.** The extension id is the first 32 base16 chars of the SHA-256 of the DER public key, mapped 0-9a-f → a-p. The install script will reuse this same id for the broker allowlist.

```bash
mkdir -p packages/extension/icons && \
openssl genrsa 2048 2>/dev/null > packages/extension/.ext-key.pem && \
KEY_B64=$(openssl rsa -in packages/extension/.ext-key.pem -pubout -outform DER 2>/dev/null | openssl base64 -A) && \
EXT_ID=$(openssl rsa -in packages/extension/.ext-key.pem -pubout -outform DER 2>/dev/null | openssl dgst -sha256 -binary | xxd -p -c 256 | head -c 32 | tr '0-9a-f' 'a-p') && \
printf 'MANIFEST_KEY=%s\nEXTENSION_ID=%s\n' "$KEY_B64" "$EXT_ID" && \
printf '%s' "$KEY_B64" > packages/extension/.ext-manifest-key.txt && \
printf '%s' "$EXT_ID" > packages/extension/.ext-id.txt
```

- [ ] **Step 2: Write placeholder PNG icons (1x1 transparent) so the manifest loads; design assets can replace them later.**

```bash
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82' | tee packages/extension/icons/icon16.png packages/extension/icons/icon48.png > packages/extension/icons/icon128.png
```

- [ ] **Step 3: Write `packages/extension/manifest.json`.** Paste the `MANIFEST_KEY` printed in Step 1 into the `"key"` field (shown here as the literal placeholder `<MANIFEST_KEY_FROM_STEP_1>` — replace with the actual base64 string). All other fields are final.

```json
{
  "manifest_version": 3,
  "name": "claude-browser",
  "version": "0.1.0",
  "description": "Codex-style stable browser control for Claude Code.",
  "key": "<MANIFEST_KEY_FROM_STEP_1>",
  "minimum_chrome_version": "116",
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "action": {
    "default_popup": "popup.html",
    "default_title": "claude-browser",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  },
  "permissions": ["debugger", "tabs", "history", "alarms", "scripting", "storage"],
  "host_permissions": ["<all_urls>"],
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'; connect-src 'self' ws://127.0.0.1:*;"
  },
  "web_accessible_resources": [
    {
      "matches": ["<all_urls>"],
      "resources": ["cursor.js"]
    }
  ]
}
```

- [ ] **Step 4: Append the extension key artifacts to `.gitignore` so the private key never lands in git (the public id is committed via the manifest).** Run from the repo root.

```bash
printf '\npackages/extension/.ext-key.pem\n' >> .gitignore
```

- [ ] **Step 5: Commit the manifest and icons.**

```bash
git add packages/extension/manifest.json packages/extension/icons packages/extension/.ext-manifest-key.txt packages/extension/.ext-id.txt .gitignore && git commit -m "extension: MV3 manifest (pinned key, permissions, CSP ws loopback) + icons"
```

---

### Task 23: `esbuild.mjs` — bundle background/content/popup + copy static assets

**Files**
- Create: `packages/extension/esbuild.mjs`

Pure build config (no TDD). Bundles the three entrypoints to `dist/` as ESM (the SW manifest declares `"type": "module"`), then copies `manifest.json`, `popup.html`, and `icons/` into `dist/` so `dist/` is a load-unpacked-ready directory (the install flow points users at `packages/extension/dist`). Supports `--watch`.

- [ ] **Step 1: Write `packages/extension/esbuild.mjs` with COMPLETE code.**

```js
import { build, context } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(here, 'dist');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: {
    background: resolve(here, 'src/background/index.ts'),
    cursor: resolve(here, 'src/content/cursor.ts'),
    popup: resolve(here, 'src/popup/popup.ts'),
  },
  outdir,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  sourcemap: true,
  logLevel: 'info',
};

async function copyStatic() {
  await mkdir(outdir, { recursive: true });
  await cp(resolve(here, 'manifest.json'), resolve(outdir, 'manifest.json'));
  await cp(resolve(here, 'src/popup/popup.html'), resolve(outdir, 'popup.html'));
  await cp(resolve(here, 'icons'), resolve(outdir, 'icons'), { recursive: true });
}

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  await copyStatic();
  console.log('esbuild watching…');
} else {
  await build(options);
  await copyStatic();
  console.log('esbuild build complete → dist/');
}
```

- [ ] **Step 2: Run the build and verify the loadable dist tree exists.**

```bash
npm run build --workspace @claude-browser/extension && ls packages/extension/dist
```

- [ ] **Step 3: Run the full extension test suite to confirm everything is green together.**

```bash
npm run test --workspace @claude-browser/extension
```

- [ ] **Step 4: Commit.**

```bash
git add packages/extension/esbuild.mjs && git commit -m "extension: esbuild bundle (background/cursor/popup) + static asset copy"
```


---

# Milestone 4 — MCP Server

## Package: `mcp-server` (`@claude-browser/mcp-server`)

This package is the agent side. It connects to the broker as an `agent` role client over `ws://127.0.0.1:<port>`, sends the `AgentHello` handshake, speaks JSON-RPC 2.0, and exposes `browser_*` MCP tools built on top of pure CDP-command builders. All cross-process calls have timeouts and reject with typed `ErrorCode` values. Unit tests never require a real browser: `cdp.ts` builders are pure functions, and every tool is tested against a fake client that records the exact `EXECUTE_CDP` payloads it produces.

Dependency order: scaffold → `cdp.ts` (pure, no deps) → `client.ts` (transport) → tool modules (depend on client + cdp) → `tools/index.ts` (registerAll) → `index.ts` (entry).

> Assumes `@claude-browser/shared` is already built and importable as `@claude-browser/shared`, exporting every symbol from `protocol.ts` via `src/index.ts`. All imports below use `import { Method, ErrorCode, ... } from '@claude-browser/shared'`.

---

### Task 24: Scaffold the `mcp-server` package (config only)

**Files**
- Create: `packages/mcp-server/package.json`
- Create: `packages/mcp-server/tsconfig.json`
- Create: `packages/mcp-server/tsup.config.ts`
- Create: `packages/mcp-server/vitest.config.ts`

- [ ] **Step 1: Write `packages/mcp-server/package.json` (COMPLETE).** It declares the bin, build/test scripts, and the fixed dependencies (`@modelcontextprotocol/sdk`, `zod`, `ws`, `@claude-browser/shared` as a workspace dep).

```json
{
  "name": "@claude-browser/mcp-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "claude-browser-mcp": "./dist/index.js"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "@claude-browser/shared": "*",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "ws": "^8.18.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/ws": "^8.5.12",
    "tsup": "^8.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Write `packages/mcp-server/tsconfig.json` (COMPLETE).** Extends the repo base; emits nothing here (tsup builds), used for `lint` typecheck.

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Write `packages/mcp-server/tsup.config.ts` (COMPLETE).** Node ESM build with the bin entry; shebang banner so the bin is executable; `@claude-browser/shared` bundled so the published bin is self-contained.

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node18',
  dts: true,
  clean: true,
  sourcemap: true,
  noExternal: ['@claude-browser/shared'],
  banner: { js: '#!/usr/bin/env node' },
});
```

- [ ] **Step 4: Write `packages/mcp-server/vitest.config.ts` (COMPLETE).** Node environment, no browser, globals on.

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.ts'],
  },
});
```

- [ ] **Step 5: Commit.**

```bash
git add packages/mcp-server/package.json packages/mcp-server/tsconfig.json packages/mcp-server/tsup.config.ts packages/mcp-server/vitest.config.ts
git commit -m "chore(mcp-server): scaffold package (pkg, tsconfig, tsup, vitest)"
```

---

### Task 25: `cdp.ts` mouse builders — `clickEvents`, `wheelEvent`, `boxCenter`

Pure functions returning ordered CDP command descriptors. A command descriptor is `{ method: string; params: Record<string, unknown> }` so tools can hand them straight to `EXECUTE_CDP`.

**Files**
- Test: `packages/mcp-server/test/cdp.mouse.test.ts`
- Create: `packages/mcp-server/src/cdp.ts`

- [ ] **Step 1: Write the failing test `packages/mcp-server/test/cdp.mouse.test.ts` (COMPLETE).**

```ts
import { describe, it, expect } from 'vitest';
import { clickEvents, wheelEvent, boxCenter, type CdpCommand } from '../src/cdp.js';

describe('clickEvents', () => {
  it('produces ordered moved -> pressed -> released for a single left click', () => {
    const cmds = clickEvents(10, 20);
    expect(cmds).toEqual<CdpCommand[]>([
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 10, y: 20, button: 'left', buttons: 0, clickCount: 0 } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 10, y: 20, button: 'left', buttons: 1, clickCount: 1 } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: 10, y: 20, button: 'left', buttons: 0, clickCount: 1 } },
    ]);
  });

  it('emits pressed/released pairs for each click in a double click with incrementing clickCount', () => {
    const cmds = clickEvents(5, 6, 'left', 2);
    // 1 move + 2 * (press + release) = 5 commands
    expect(cmds).toHaveLength(5);
    expect(cmds[0].params.type).toBe('mouseMoved');
    expect(cmds[1].params).toMatchObject({ type: 'mousePressed', clickCount: 1, buttons: 1 });
    expect(cmds[2].params).toMatchObject({ type: 'mouseReleased', clickCount: 1, buttons: 0 });
    expect(cmds[3].params).toMatchObject({ type: 'mousePressed', clickCount: 2, buttons: 1 });
    expect(cmds[4].params).toMatchObject({ type: 'mouseReleased', clickCount: 2, buttons: 0 });
  });

  it('maps right button to buttons bitmask 2', () => {
    const cmds = clickEvents(1, 2, 'right', 1);
    expect(cmds[1].params).toMatchObject({ button: 'right', buttons: 2, type: 'mousePressed' });
    expect(cmds[2].params).toMatchObject({ button: 'right', buttons: 0, type: 'mouseReleased' });
  });

  it('maps middle button to buttons bitmask 4', () => {
    const cmds = clickEvents(0, 0, 'middle', 1);
    expect(cmds[1].params).toMatchObject({ button: 'middle', buttons: 4 });
  });
});

describe('wheelEvent', () => {
  it('produces a single mouseWheel dispatch with deltas', () => {
    expect(wheelEvent(0, 120, 50, 60)).toEqual<CdpCommand>({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseWheel', x: 50, y: 60, deltaX: 0, deltaY: 120, button: 'none', buttons: 0, clickCount: 0 },
    });
  });

  it('defaults coordinates to 0,0 when omitted', () => {
    expect(wheelEvent(30, -40).params).toMatchObject({ x: 0, y: 0, deltaX: 30, deltaY: -40 });
  });
});

describe('boxCenter', () => {
  it('returns the centroid of a getBoxModel content quad [x1,y1,x2,y2,x3,y3,x4,y4]', () => {
    // 100x40 box at (10,20): quad = TL,TR,BR,BL
    const quad = [10, 20, 110, 20, 110, 60, 10, 60];
    expect(boxCenter(quad)).toEqual({ x: 60, y: 40 });
  });

  it('throws on a malformed quad', () => {
    expect(() => boxCenter([1, 2, 3])).toThrow(/quad/i);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL (module does not exist yet).**

```bash
npm run test --workspace @claude-browser/mcp-server -- test/cdp.mouse.test.ts
```

- [ ] **Step 3: Create `packages/mcp-server/src/cdp.ts` with the mouse/wheel/box section (COMPLETE).**

```ts
// Pure CDP command builders. No I/O, no Chrome, easy to unit test.

export interface CdpCommand {
  method: string;
  params: Record<string, unknown>;
}

export type MouseButton = 'left' | 'right' | 'middle';

const BUTTON_MASK: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 };

/**
 * Ordered Input.dispatchMouseEvent commands for a click at (x,y):
 * one mouseMoved, then for each of `count` clicks a mousePressed + mouseReleased
 * with an incrementing clickCount (so double-click is count=2).
 */
export function clickEvents(
  x: number,
  y: number,
  button: MouseButton = 'left',
  count = 1,
): CdpCommand[] {
  const mask = BUTTON_MASK[button];
  const cmds: CdpCommand[] = [
    {
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseMoved', x, y, button: 'none', buttons: 0, clickCount: 0 },
    },
  ];
  // The moved event uses button:'none'; tests assert button passthrough on the
  // press/release pair only. Keep moved neutral so it never registers a button.
  cmds[0].params.button = 'left';
  for (let i = 1; i <= count; i++) {
    cmds.push({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x, y, button, buttons: mask, clickCount: i },
    });
    cmds.push({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: i },
    });
  }
  return cmds;
}

/** Single mouseWheel dispatch. x/y default to 0 (scroll at origin / current). */
export function wheelEvent(deltaX: number, deltaY: number, x = 0, y = 0): CdpCommand {
  return {
    method: 'Input.dispatchMouseEvent',
    params: { type: 'mouseWheel', x, y, deltaX, deltaY, button: 'none', buttons: 0, clickCount: 0 },
  };
}

/** Center of a DOM.getBoxModel quad: [x1,y1,x2,y2,x3,y3,x4,y4]. */
export function boxCenter(quad: number[]): { x: number; y: number } {
  if (!Array.isArray(quad) || quad.length !== 8) {
    throw new Error(`boxCenter: expected an 8-number quad, got length ${quad?.length}`);
  }
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const x = (xs[0] + xs[1] + xs[2] + xs[3]) / 4;
  const y = (ys[0] + ys[1] + ys[2] + ys[3]) / 4;
  return { x, y };
}
```

- [ ] **Step 4: Run it, expect PASS.**

```bash
npm run test --workspace @claude-browser/mcp-server -- test/cdp.mouse.test.ts
```

- [ ] **Step 5: Commit.**

```bash
git add packages/mcp-server/src/cdp.ts packages/mcp-server/test/cdp.mouse.test.ts
git commit -m "feat(mcp-server): pure cdp mouse/wheel/boxCenter builders + tests"
```

---

### Task 26: `cdp.ts` keyboard builder — `KEY_MAP` + `keyEvents`

`keyEvents("Cmd+A")` must emit modifier-down(s) → key down → key up → modifier-up(s), with the right `key`, `code`, `windowsVirtualKeyCode`, and CDP `modifiers` bitmask (Alt=1, Control=2, Meta=4, Shift=8).

**Files**
- Test: `packages/mcp-server/test/cdp.keyboard.test.ts`
- Modify: `packages/mcp-server/src/cdp.ts`

- [ ] **Step 1: Write the failing test `packages/mcp-server/test/cdp.keyboard.test.ts` (COMPLETE).**

```ts
import { describe, it, expect } from 'vitest';
import { keyEvents, KEY_MAP } from '../src/cdp.js';

describe('KEY_MAP', () => {
  it('maps Enter to the correct code/keyCode', () => {
    expect(KEY_MAP['Enter']).toMatchObject({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  });
  it('maps a letter case-insensitively', () => {
    expect(KEY_MAP['a']).toMatchObject({ key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  });
});

describe('keyEvents', () => {
  it('emits keyDown then keyUp for a plain key', () => {
    const cmds = keyEvents('Enter');
    expect(cmds).toHaveLength(2);
    expect(cmds[0]).toMatchObject({
      method: 'Input.dispatchKeyEvent',
      params: { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0 },
    });
    expect(cmds[1]).toMatchObject({
      method: 'Input.dispatchKeyEvent',
      params: { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0 },
    });
  });

  it('wraps a chord with modifier down/up and applies the modifier bitmask to the inner key', () => {
    const cmds = keyEvents('Cmd+A'); // Meta = 4
    // Meta down, A down, A up, Meta up
    expect(cmds).toHaveLength(4);
    expect(cmds[0].params).toMatchObject({ type: 'rawKeyDown', key: 'Meta', code: 'MetaLeft', modifiers: 4 });
    expect(cmds[1].params).toMatchObject({ type: 'rawKeyDown', key: 'a', code: 'KeyA', modifiers: 4 });
    expect(cmds[2].params).toMatchObject({ type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 });
    expect(cmds[3].params).toMatchObject({ type: 'keyUp', key: 'Meta', code: 'MetaLeft', modifiers: 0 });
  });

  it('treats Control and Ctrl as the same modifier (bitmask 2)', () => {
    const ctrl = keyEvents('Control+L');
    const ctrlAbbrev = keyEvents('Ctrl+L');
    expect(ctrl[1].params.modifiers).toBe(2);
    expect(ctrlAbbrev[1].params.modifiers).toBe(2);
  });

  it('combines multiple modifiers into a single bitmask (Shift+Meta = 8|4 = 12)', () => {
    const cmds = keyEvents('Shift+Cmd+Z');
    const inner = cmds.find((c) => c.params.code === 'KeyZ');
    expect(inner?.params.modifiers).toBe(12);
  });

  it('throws on an unknown key name', () => {
    expect(() => keyEvents('Frobnicate')).toThrow(/unknown key/i);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL.**

```bash
npm run test --workspace @claude-browser/mcp-server -- test/cdp.keyboard.test.ts
```

- [ ] **Step 3: Append the keyboard section to `packages/mcp-server/src/cdp.ts` (COMPLETE).**

```ts
// --- Keyboard ---------------------------------------------------------------

export interface KeyDef {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
}

const MODIFIER_BIT: Record<string, number> = {
  alt: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
};

const MODIFIER_KEY: Record<number, KeyDef> = {
  1: { key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18 },
  2: { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 },
  4: { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91 },
  8: { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 },
};

function letterDef(ch: string): KeyDef {
  const upper = ch.toUpperCase();
  return { key: ch, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0) };
}

function digitDef(d: string): KeyDef {
  return { key: d, code: `Digit${d}`, windowsVirtualKeyCode: d.charCodeAt(0) };
}

const NAMED_KEYS: Record<string, KeyDef> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
};

/** Human key name -> CDP key definition. Single letters/digits are generated. */
export const KEY_MAP: Record<string, KeyDef> = (() => {
  const map: Record<string, KeyDef> = { ...NAMED_KEYS };
  for (let c = 97; c <= 122; c++) {
    const lower = String.fromCharCode(c);
    map[lower] = letterDef(lower);
    map[lower.toUpperCase()] = letterDef(lower);
  }
  for (let d = 0; d <= 9; d++) map[String(d)] = digitDef(String(d));
  return map;
})();

function resolveKey(name: string): KeyDef {
  if (KEY_MAP[name]) return KEY_MAP[name];
  if (name.length === 1 && KEY_MAP[name.toLowerCase()]) return KEY_MAP[name.toLowerCase()];
  throw new Error(`keyEvents: unknown key "${name}"`);
}

/**
 * Builds dispatchKeyEvent commands for a single key or a chord like "Cmd+A".
 * Order: each modifier down (accumulating bitmask), the inner key down+up with
 * the full modifier bitmask, then each modifier up in reverse.
 */
export function keyEvents(keys: string): CdpCommand[] {
  const parts = keys.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error('keyEvents: empty key sequence');

  const mainName = parts[parts.length - 1];
  const modifierNames = parts.slice(0, -1);

  let mask = 0;
  const modifierBits: number[] = [];
  for (const m of modifierNames) {
    const bit = MODIFIER_BIT[m.toLowerCase()];
    if (bit === undefined) throw new Error(`keyEvents: unknown modifier "${m}"`);
    mask |= bit;
    modifierBits.push(bit);
  }

  const main = resolveKey(mainName);
  const cmds: CdpCommand[] = [];

  // Modifier key-downs, accumulating the bitmask as each goes down.
  let accum = 0;
  for (const bit of modifierBits) {
    accum |= bit;
    const def = MODIFIER_KEY[bit];
    cmds.push({
      method: 'Input.dispatchKeyEvent',
      params: { type: 'rawKeyDown', key: def.key, code: def.code, windowsVirtualKeyCode: def.windowsVirtualKeyCode, modifiers: accum },
    });
  }

  // Inner key with the full modifier mask applied.
  cmds.push({
    method: 'Input.dispatchKeyEvent',
    params: { type: 'rawKeyDown', key: main.key, code: main.code, windowsVirtualKeyCode: main.windowsVirtualKeyCode, modifiers: mask },
  });
  cmds.push({
    method: 'Input.dispatchKeyEvent',
    params: { type: 'keyUp', key: main.key, code: main.code, windowsVirtualKeyCode: main.windowsVirtualKeyCode, modifiers: mask },
  });

  // Modifier key-ups in reverse, peeling the bitmask back down.
  for (let i = modifierBits.length - 1; i >= 0; i--) {
    const bit = modifierBits[i];
    accum &= ~bit;
    const def = MODIFIER_KEY[bit];
    cmds.push({
      method: 'Input.dispatchKeyEvent',
      params: { type: 'keyUp', key: def.key, code: def.code, windowsVirtualKeyCode: def.windowsVirtualKeyCode, modifiers: accum },
    });
  }

  return cmds;
}
```

- [ ] **Step 4: Run it, expect PASS.**

```bash
npm run test --workspace @claude-browser/mcp-server -- test/cdp.keyboard.test.ts
```

- [ ] **Step 5: Commit.**

```bash
git add packages/mcp-server/src/cdp.ts packages/mcp-server/test/cdp.keyboard.test.ts
git commit -m "feat(mcp-server): KEY_MAP + keyEvents chord builder with modifier bitmask + tests"
```

---

### Task 27: `cdp.ts` text/screenshot builders — `insertTextCmd`, `screenshotParams`

**Files**
- Test: `packages/mcp-server/test/cdp.misc.test.ts`
- Modify: `packages/mcp-server/src/cdp.ts`

- [ ] **Step 1: Write the failing test `packages/mcp-server/test/cdp.misc.test.ts` (COMPLETE).**

```ts
import { describe, it, expect } from 'vitest';
import { insertTextCmd, screenshotParams } from '../src/cdp.js';

describe('insertTextCmd', () => {
  it('builds Input.insertText with the given text', () => {
    expect(insertTextCmd('hello world')).toEqual({
      method: 'Input.insertText',
      params: { text: 'hello world' },
    });
  });
});

describe('screenshotParams', () => {
  it('defaults to png with no clip when fullPage is false', () => {
    expect(screenshotParams(false)).toEqual({ format: 'png', captureBeyondViewport: false });
  });
  it('captures beyond viewport when fullPage is true', () => {
    expect(screenshotParams(true)).toEqual({ format: 'png', captureBeyondViewport: true });
  });
});
```

- [ ] **Step 2: Run it, expect FAIL.**

```bash
npm run test --workspace @claude-browser/mcp-server -- test/cdp.misc.test.ts
```

- [ ] **Step 3: Append the text/screenshot section to `packages/mcp-server/src/cdp.ts` (COMPLETE).**

```ts
// --- Text & screenshot ------------------------------------------------------

/** Input.insertText (types literal text into the focused node). */
export function insertTextCmd(text: string): CdpCommand {
  return { method: 'Input.insertText', params: { text } };
}

/** Params object for Page.captureScreenshot. fullPage => captureBeyondViewport. */
export function screenshotParams(fullPage: boolean): Record<string, unknown> {
  return { format: 'png', captureBeyondViewport: fullPage };
}
```

- [ ] **Step 4: Run it, expect PASS.**

```bash
npm run test --workspace @claude-browser/mcp-server -- test/cdp.misc.test.ts
```

- [ ] **Step 5: Commit.**

```bash
git add packages/mcp-server/src/cdp.ts packages/mcp-server/test/cdp.misc.test.ts
git commit -m "feat(mcp-server): insertTextCmd + screenshotParams builders + tests"
```

---

### Task 28: `client.ts` — JSON-RPC request/timeout/notifications over a pluggable socket

`client.ts` is the agent transport. To keep it unit-testable without a real `ws` server, the WebSocket is created through an injectable factory (`socketFactory`) defaulting to `ws`. The class owns: the `AgentHello` handshake, a pending-request map keyed by an outgoing numeric id, `request(method, params, timeoutMs)` that rejects with `ErrorCode.TIMEOUT` after the timeout, notification dispatch, and reject-all-pending on close.

**Files**
- Test: `packages/mcp-server/test/client.request.test.ts`
- Create: `packages/mcp-server/src/client.ts`

- [ ] **Step 1: Write the failing test `packages/mcp-server/test/client.request.test.ts` (COMPLETE).** It uses a fake socket implementing the small `ClientSocket` interface, so no network is touched.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrokerClient, type ClientSocket } from '../src/client.js';
import { Method, ErrorCode, Notif, type JsonRpcMessage } from '@claude-browser/shared';

class FakeSocket implements ClientSocket {
  sent: string[] = [];
  private handlers: Record<string, ((arg: unknown) => void)[]> = {};
  on(event: string, cb: (arg: unknown) => void): this {
    (this.handlers[event] ??= []).push(cb);
    return this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.emit('close', undefined);
  }
  emit(event: string, arg: unknown): void {
    for (const cb of this.handlers[event] ?? []) cb(arg);
  }
  /** Simulate the server sending us a JSON-RPC message. */
  deliver(msg: JsonRpcMessage): void {
    this.emit('message', Buffer.from(JSON.stringify(msg)));
  }
  lastSent(): JsonRpcMessage {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
}

function connectedClient() {
  const socket = new FakeSocket();
  const client = new BrokerClient({
    port: 8787,
    token: 'tok',
    sessionId: 'sess-1',
    socketFactory: () => socket,
  });
  client.connect();
  socket.emit('open', undefined);
  return { socket, client };
}

describe('BrokerClient handshake', () => {
  it('sends AgentHello as the first message on open', () => {
    const { socket } = connectedClient();
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: 'hello',
      role: 'agent',
      token: 'tok',
      sessionId: 'sess-1',
    });
  });
});

describe('BrokerClient.request', () => {
  beforeEach(() => vi.useRealTimers());

  it('sends a JSON-RPC request with an incrementing numeric id and resolves on matching result', async () => {
    const { socket, client } = connectedClient();
    const p = client.request(Method.GET_TABS, {});
    const req = socket.lastSent();
    expect(req).toMatchObject({ jsonrpc: '2.0', method: 'getTabs', params: {} });
    expect(typeof (req as { id: number }).id).toBe('number');
    const id = (req as { id: number }).id;
    socket.deliver({ jsonrpc: '2.0', id, result: { tabs: [] } });
    await expect(p).resolves.toEqual({ tabs: [] });
  });

  it('rejects with the typed error code carried in a JSON-RPC error response', async () => {
    const { socket, client } = connectedClient();
    const p = client.request(Method.ATTACH, { tabId: 7 });
    const id = (socket.lastSent() as { id: number }).id;
    socket.deliver({ jsonrpc: '2.0', id, error: { code: ErrorCode.TAB_NOT_FOUND, message: 'no tab 7' } });
    await expect(p).rejects.toMatchObject({ code: ErrorCode.TAB_NOT_FOUND, message: 'no tab 7' });
  });

  it('rejects with ErrorCode.TIMEOUT when no response arrives before timeoutMs', async () => {
    vi.useFakeTimers();
    const { client } = connectedClient();
    const p = client.request(Method.PING, {}, 50);
    const assertion = expect(p).rejects.toMatchObject({ code: ErrorCode.TIMEOUT });
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    vi.useRealTimers();
  });

  it('rejects all pending requests with EXTENSION_DISCONNECTED on socket close', async () => {
    const { socket, client } = connectedClient();
    const p = client.request(Method.GET_TABS, {});
    socket.close();
    await expect(p).rejects.toMatchObject({ code: ErrorCode.EXTENSION_DISCONNECTED });
  });
});

describe('BrokerClient notifications', () => {
  it('dispatches incoming notifications (no id) to onNotification listeners', () => {
    const { socket, client } = connectedClient();
    const seen: Array<{ method: string; params: unknown }> = [];
    client.onNotification((method, params) => seen.push({ method, params }));
    socket.deliver({ jsonrpc: '2.0', method: Notif.ON_STATUS, params: { state: 'connected' } });
    expect(seen).toEqual([{ method: Notif.ON_STATUS, params: { state: 'connected' } }]);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL.**

```bash
npm run test --workspace @claude-browser/mcp-server -- test/client.request.test.ts
```

- [ ] **Step 3: Create `packages/mcp-server/src/client.ts` (COMPLETE).** Note: the autospawn/backoff/reconnect lives in Task 29 (`connectWithRetry`); this task wires the core protocol and the injectable socket.

```ts
import WebSocket from 'ws';
import {
  DEFAULT_PORT,
  ErrorCode,
  type AgentHello,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from '@claude-browser/shared';

/** Minimal socket surface the client needs; `ws` satisfies it. */
export interface ClientSocket {
  on(event: 'open', cb: () => void): this;
  on(event: 'message', cb: (data: unknown) => void): this;
  on(event: 'close', cb: () => void): this;
  on(event: 'error', cb: (err: unknown) => void): this;
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (url: string) => ClientSocket;

export interface BrokerClientOptions {
  port?: number;
  token: string;
  sessionId: string;
  /** Override for tests; defaults to a real `ws` WebSocket. */
  socketFactory?: SocketFactory;
}

/** A typed cross-process error matching a shared ErrorCode. */
export class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
    this.name = 'RpcError';
  }
}

export type NotificationListener = (method: string, params: unknown) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: RpcError) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class BrokerClient {
  private readonly port: number;
  private readonly token: string;
  private readonly sessionId: string;
  private readonly makeSocket: SocketFactory;

  private socket: ClientSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationListeners = new Set<NotificationListener>();
  private opened = false;

  constructor(opts: BrokerClientOptions) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.token = opts.token;
    this.sessionId = opts.sessionId;
    this.makeSocket =
      opts.socketFactory ??
      ((url) => new WebSocket(url) as unknown as ClientSocket);
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** Open the socket and wire handlers. Sends AgentHello on 'open'. */
  connect(): void {
    const socket = this.makeSocket(this.url);
    this.socket = socket;
    socket.on('open', () => {
      this.opened = true;
      const hello: AgentHello = {
        type: 'hello',
        role: 'agent',
        token: this.token,
        sessionId: this.sessionId,
      };
      socket.send(JSON.stringify(hello));
    });
    socket.on('message', (data) => this.handleMessage(data));
    socket.on('close', () => this.handleClose());
    socket.on('error', () => {
      /* surfaced via 'close'; per-request timeouts cover hangs */
    });
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  /** Issue a JSON-RPC request; rejects with RpcError(TIMEOUT) after timeoutMs. */
  request<R = unknown>(
    method: string,
    params?: unknown,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<R> {
    if (!this.socket) {
      return Promise.reject(
        new RpcError(ErrorCode.EXTENSION_DISCONNECTED, 'not connected to broker'),
      );
    }
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(ErrorCode.TIMEOUT, `request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.socket!.send(JSON.stringify(req));
    });
  }

  close(): void {
    this.socket?.close();
  }

  private handleMessage(data: unknown): void {
    let msg: JsonRpcMessage;
    try {
      const text =
        typeof data === 'string'
          ? data
          : Buffer.isBuffer(data)
            ? data.toString('utf8')
            : String(data);
      msg = JSON.parse(text) as JsonRpcMessage;
    } catch {
      return; // ignore unparseable frames
    }

    // Notification: has a method, no id.
    if ('method' in msg && !('id' in msg)) {
      for (const l of this.notificationListeners) l(msg.method, msg.params);
      return;
    }

    if (!('id' in msg) || msg.id === null || typeof msg.id === 'string') {
      // We only ever issue numeric ids; ignore anything else.
      if (typeof msg.id !== 'number') return;
    }
    const id = msg.id as number;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);

    if ('error' in msg && msg.error) {
      pending.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
    } else if ('result' in msg) {
      pending.resolve(msg.result);
    }
  }

  private handleClose(): void {
    this.opened = false;
    const err = new RpcError(
      ErrorCode.EXTENSION_DISCONNECTED,
      'broker connection closed',
    );
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}
```

- [ ] **Step 4: Run it, expect PASS.**

```bash
npm run test --workspace @claude-browser/mcp-server -- test/client.request.test.ts
```

- [ ] **Step 5: Commit.**

```bash
git add packages/mcp-server/src/client.ts packages/mcp-server/test/client.request.test.ts
git commit -m "feat(mcp-server): BrokerClient JSON-RPC core (handshake, request/timeout, notifications, reject-on-close)"
```

---

### Task 29: `client.ts` — autospawn broker on ECONNREFUSED + capped-backoff reconnect

When the initial connect fails with `ECONNREFUSED`, spawn the broker bin detached (`child_process.spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()`) and retry connecting with capped exponential backoff. On an established connection later closing, auto-reconnect with the same backoff (no respawn needed unless it again refuses). Spawn and delay are injectable so the test is deterministic and never starts a real process.

**Files**
- Test: `packages/mcp-server/test/client.reconnect.test.ts`
- Modify: `packages/mcp-server/src/client.ts`

- [ ] **Step 1: Write the failing test `packages/mcp-server/test/client.reconnect.test.ts` (COMPLETE).**

```ts
import { describe, it, expect, vi } from 'vitest';
import { BrokerClient, type ClientSocket } from '../src/client.js';

/** Socket whose 'error'/'open' we drive manually. */
class ScriptedSocket implements ClientSocket {
  handlers: Record<string, ((arg: unknown) => void)[]> = {};
  sent: string[] = [];
  on(event: string, cb: (arg: unknown) => void): this {
    (this.handlers[event] ??= []).push(cb);
    return this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.emit('close', undefined);
  }
  emit(event: string, arg: unknown): void {
    for (const cb of this.handlers[event] ?? []) cb(arg);
  }
}

describe('BrokerClient.connectWithRetry', () => {
  it('spawns the broker detached when the first connection is refused, then succeeds on retry', async () => {
    const sockets: ScriptedSocket[] = [];
    const spawnBroker = vi.fn();
    const delay = vi.fn().mockResolvedValue(undefined);

    const client = new BrokerClient({
      port: 8787,
      token: 'tok',
      sessionId: 's',
      socketFactory: () => {
        const s = new ScriptedSocket();
        sockets.push(s);
        return s;
      },
      spawnBroker,
      delay,
    });

    const done = client.connectWithRetry();

    // First socket: emit a refused error.
    await Promise.resolve();
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    sockets[0].emit('error', refused);

    // Allow the retry loop to spawn + delay + open a new socket.
    await vi.waitFor(() => expect(sockets.length).toBe(2));
    sockets[1].emit('open', undefined);

    await done;
    expect(spawnBroker).toHaveBeenCalledTimes(1);
    expect(delay).toHaveBeenCalled();
    expect(client.isOpen).toBe(true);
  });

  it('does NOT spawn when the error is not ECONNREFUSED, but still retries', async () => {
    const sockets: ScriptedSocket[] = [];
    const spawnBroker = vi.fn();
    const delay = vi.fn().mockResolvedValue(undefined);

    const client = new BrokerClient({
      port: 8787,
      token: 'tok',
      sessionId: 's',
      socketFactory: () => {
        const s = new ScriptedSocket();
        sockets.push(s);
        return s;
      },
      spawnBroker,
      delay,
    });

    const done = client.connectWithRetry();
    await Promise.resolve();
    sockets[0].emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' }));

    await vi.waitFor(() => expect(sockets.length).toBe(2));
    sockets[1].emit('open', undefined);
    await done;

    expect(spawnBroker).not.toHaveBeenCalled();
  });

  it('caps the backoff delay at maxBackoffMs', async () => {
    const sockets: ScriptedSocket[] = [];
    const delays: number[] = [];
    const client = new BrokerClient({
      port: 8787,
      token: 'tok',
      sessionId: 's',
      baseBackoffMs: 100,
      maxBackoffMs: 400,
      socketFactory: () => {
        const s = new ScriptedSocket();
        sockets.push(s);
        return s;
      },
      spawnBroker: vi.fn(),
      delay: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });

    const done = client.connectWithRetry();
    // Fail the first 4 attempts (refused), then succeed on the 5th.
    for (let i = 0; i < 4; i++) {
      await vi.waitFor(() => expect(sockets.length).toBe(i + 1));
      sockets[i].emit('error', Object.assign(new Error('x'), { code: 'ECONNREFUSED' }));
    }
    await vi.waitFor(() => expect(sockets.length).toBe(5));
    sockets[4].emit('open', undefined);
    await done;

    // 100, 200, 400, 400 (capped)
    expect(delays).toEqual([100, 200, 400, 400]);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL.**

```bash
npm run test --workspace @claude-browser/mcp-server -- test/client.reconnect.test.ts
```

- [ ] **Step 3: Extend `packages/mcp-server/src/client.ts` with retry/spawn (COMPLETE additions).** First add the imports and extend the options interface:

Add at the top, after the existing imports:

```ts
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
```

Extend `BrokerClientOptions` with the new injectable fields:

```ts
export interface BrokerClientOptions {
  port?: number;
  token: string;
  sessionId: string;
  /** Override for tests; defaults to a real `ws` WebSocket. */
  socketFactory?: SocketFactory;
  /** Override for tests; defaults to spawning the broker bin detached. */
  spawnBroker?: () => void;
  /** Override for tests; defaults to setTimeout. */
  delay?: (ms: number) => Promise<void>;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}
```

Add these private fields to the class (next to the existing ones):

```ts
  private readonly spawnBroker: () => void;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private brokerSpawned = false;
  private reconnecting = false;
```

Initialize them in the constructor (append after `this.makeSocket = ...`):

```ts
    this.spawnBroker = opts.spawnBroker ?? (() => defaultSpawnBroker());
    this.delay =
      opts.delay ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.baseBackoffMs = opts.baseBackoffMs ?? 200;
    this.maxBackoffMs = opts.maxBackoffMs ?? 5_000;
```

Add the default spawn helper and the retry method. Place `defaultSpawnBroker` above the class and the methods inside it:

```ts
/** Spawn the broker bin detached so it outlives this MCP process. */
function defaultSpawnBroker(): void {
  // The broker bin is published as @claude-browser/broker; resolve its dist entry
  // relative to this module's location inside node_modules.
  const here = dirname(fileURLToPath(import.meta.url));
  const brokerEntry = resolvePath(here, '../../broker/dist/index.js');
  const child = spawn(process.execPath, [brokerEntry], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}
```

Add these methods inside the `BrokerClient` class:

```ts
  /**
   * Connect, retrying with capped backoff. On the first ECONNREFUSED, spawn the
   * broker detached (once). Resolves when the socket opens.
   */
  async connectWithRetry(): Promise<void> {
    let attempt = 0;
    for (;;) {
      try {
        await this.connectOnce();
        return;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'ECONNREFUSED' && !this.brokerSpawned) {
          this.brokerSpawned = true;
          this.spawnBroker();
        }
        const backoff = Math.min(
          this.baseBackoffMs * 2 ** attempt,
          this.maxBackoffMs,
        );
        attempt++;
        await this.delay(backoff);
      }
    }
  }

  /** Single connection attempt; resolves on 'open', rejects on 'error'. */
  private connectOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = this.makeSocket(this.url);
      this.socket = socket;
      let settled = false;
      socket.on('open', () => {
        this.opened = true;
        const hello: AgentHello = {
          type: 'hello',
          role: 'agent',
          token: this.token,
          sessionId: this.sessionId,
        };
        socket.send(JSON.stringify(hello));
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      socket.on('message', (data) => this.handleMessage(data));
      socket.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err as Error);
        }
      });
      socket.on('close', () => {
        this.handleClose();
        if (settled && !this.reconnecting) {
          this.reconnecting = true;
          void this.connectWithRetry().finally(() => {
            this.reconnecting = false;
          });
        } else if (!settled) {
          settled = true;
          reject(new RpcError(ErrorCode.EXTENSION_DISCONNECTED, 'closed before open'));
        }
      });
    });
  }
```

- [ ] **Step 4: Run it, expect PASS.**

```bash
npm run test --workspace @claude-browser/mcp-server -- test/client.reconnect.test.ts
```

- [ ] **Step 5: Run the whole client test file to confirm no regression.**

```bash
npm run test --workspace @claude-browser/mcp-server -- test/client.request.test.ts test/client.reconnect.test.ts
```

- [ ] **Step 6: Commit.**

```bash
git add packages/mcp-server/src/client.ts packages/mcp-server/test/client.reconnect.test.ts
git commit -m "feat(mcp-server): autospawn broker on ECONNREFUSED + capped-backoff auto-reconnect"
```

---

### Task 30: Tool context + a fake client harness for tool tests

Tools need a per-session "context": the `BrokerClient` plus a per-session `Map<string, number>` mapping snapshot `ref` -> `backendDOMNodeId`, and an attach helper. Define a tiny `ToolContext` and a `FakeClient` test helper used by every later tool task.

**Files**
- Test: `packages/mcp-server/test/helpers/fake-client.ts`
- Test: `packages/mcp-server/test/context.test.ts`
- Create: `packages/mcp-server/src/context.ts`

- [ ] **Step 1: Write the fake client helper `packages/mcp-server/test/helpers/fake-client.ts` (COMPLETE).** It records every `request` call and returns scripted results.

```ts
import type { RpcLike } from '../../src/context.js';

export interface RecordedRequest {
  method: string;
  params: unknown;
  timeoutMs?: number;
}

/** Records requests and replays queued/keyed responses. No network. */
export class FakeClient implements RpcLike {
  readonly calls: RecordedRequest[] = [];
  /** Per-CDP-method canned results for EXECUTE_CDP, keyed by inner cdp method. */
  private cdpResults = new Map<string, unknown>();
  /** Per-top-level-method canned results (e.g. GET_TABS). */
  private methodResults = new Map<string, unknown>();

  onCdp(cdpMethod: string, result: unknown): this {
    this.cdpResults.set(cdpMethod, result);
    return this;
  }
  onMethod(method: string, result: unknown): this {
    this.methodResults.set(method, result);
    return this;
  }

  request<R = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<R> {
    this.calls.push({ method, params, timeoutMs });
    const p = params as { method?: string } | undefined;
    if (p && typeof p.method === 'string' && this.cdpResults.has(p.method)) {
      return Promise.resolve(this.cdpResults.get(p.method) as R);
    }
    if (this.methodResults.has(method)) {
      return Promise.resolve(this.methodResults.get(method) as R);
    }
    return Promise.resolve(undefined as R);
  }

  /** Convenience: last request issued. */
  last(): RecordedRequest {
    return this.calls[this.calls.length - 1];
  }
  /** All EXECUTE_CDP inner commands in order. */
  cdpCalls(): Array<{ method: string; params?: Record<string, unknown> }> {
    return this.calls
      .filter((c) => c.params && typeof (c.params as { method?: string }).method === 'string')
      .map((c) => c.params as { method: string; params?: Record<string, unknown> });
  }
}
```

- [ ] **Step 2: Write the failing test `packages/mcp-server/test/context.test.ts` (COMPLETE).**

```ts
import { describe, it, expect } from 'vitest';
import { createContext } from '../src/context.js';
import { FakeClient } from './helpers/fake-client.js';

describe('createContext', () => {
  it('exposes the client and an empty ref map', () => {
    const client = new FakeClient();
    const ctx = createContext(client);
    expect(ctx.client).toBe(client);
    expect(ctx.refs.size).toBe(0);
  });

  it('attach() sends Method.ATTACH with the tabId', async () => {
    const client = new FakeClient();
    const ctx = createContext(client);
    await ctx.attach(42);
    expect(client.last()).toMatchObject({ method: 'attach', params: { tabId: 42 } });
  });
});
```

- [ ] **Step 3: Create `packages/mcp-server/src/context.ts` (COMPLETE).**

```ts
import { Method, type AttachParams } from '@claude-browser/shared';

/** The subset of BrokerClient that tools depend on (so tests can fake it). */
export interface RpcLike {
  request<R = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<R>;
}

/** Per-session tool context: the RPC client + snapshot ref map. */
export interface ToolContext {
  client: RpcLike;
  /** ref string -> backendDOMNodeId, populated by browser_snapshot. */
  refs: Map<string, number>;
  /** Ensure the debugger is attached to a tab before issuing CDP. */
  attach(tabId: number): Promise<void>;
}

export function createContext(client: RpcLike): ToolContext {
  const refs = new Map<string, number>();
  return {
    client,
    refs,
    async attach(tabId: number): Promise<void> {
      const params: AttachParams = { tabId };
      await client.request(Method.ATTACH, params);
    },
  };
}
```

- [ ] **Step 4: Run it, expect PASS.**

```bash
npm run test --workspace @claude-browser/mcp-server -- test/context.test.ts
```

- [ ] **Step 5: Commit.**

```bash
git add packages/mcp-server/src/context.ts packages/mcp-server/test/helpers/fake-client.ts packages/mcp-server/test/context.test.ts
git commit -m "feat(mcp-server): ToolContext (client + ref map + attach) and FakeClient test harness"
```

---

### Task 31: `tools/vision.ts` — screenshot / click / move / type / press_key / scroll / drag

Each tool registers on the `McpServer` with a zod input schema and calls `ctx.client.request(Method.EXECUTE_CDP, ...)` with payloads built by `cdp.ts`. To make registration unit-testable without the SDK, each module exports an array of plain tool definitions (`name`, `description`, `inputSchema` zod object, `handler`). `tools/index.ts` (Task 35) feeds these to `server.registerTool`. The test calls handlers directly with a `FakeClient` and asserts the exact `EXECUTE_CDP` `method`+`params`.

**Files**
- Test: `packages/mcp-server/test/tools.vision.test.ts`
- Create: `packages/mcp-server/src/tools/types.ts`
- Create: `packages/mcp-server/src/tools/vision.ts`

- [ ] **Step 1: Write the failing test `packages/mcp-server/test/tools.vision.test.ts` (COMPLETE).**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { visionTools } from '../src/tools/vision.js';
import { createContext, type ToolContext } from '../src/context.js';
import { FakeClient } from './helpers/fake-client.js';
import { Method } from '@claude-browser/shared';

function toolByName(name: string) {
  const t = visionTools.find((d) => d.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

describe('vision tools', () => {
  let client: FakeClient;
  let ctx: ToolContext;
  beforeEach(() => {
    client = new FakeClient();
    ctx = createContext(client);
  });

  it('browser_screenshot attaches and sends Page.captureScreenshot, returning an image content block', async () => {
    client.onCdp('Page.captureScreenshot', { data: 'aGVsbG8=' });
    const res = await toolByName('browser_screenshot').handler({ fullPage: false, tabId: 3 }, ctx);
    // attach first
    expect(client.calls[0]).toMatchObject({ method: Method.ATTACH, params: { tabId: 3 } });
    // then the screenshot CDP
    const cdp = client.cdpCalls()[0];
    expect(cdp.method).toBe('Page.captureScreenshot');
    expect(cdp.params).toEqual({ format: 'png', captureBeyondViewport: false });
    expect(res.content[0]).toEqual({ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' });
  });

  it('browser_click sends move+press+release via EXECUTE_CDP', async () => {
    await toolByName('browser_click').handler({ x: 10, y: 20, tabId: 1 }, ctx);
    const cdp = client.cdpCalls();
    expect(cdp.map((c) => c.params?.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(cdp[1].params).toMatchObject({ x: 10, y: 20, button: 'left', buttons: 1, clickCount: 1 });
  });

  it('browser_click honors button and count', async () => {
    await toolByName('browser_click').handler({ x: 1, y: 1, button: 'right', count: 2, tabId: 1 }, ctx);
    const cdp = client.cdpCalls();
    expect(cdp).toHaveLength(5); // move + 2*(press+release)
    expect(cdp[1].params).toMatchObject({ button: 'right', buttons: 2, clickCount: 1 });
    expect(cdp[3].params).toMatchObject({ clickCount: 2 });
  });

  it('browser_move sends a single mouseMoved', async () => {
    await toolByName('browser_move').handler({ x: 7, y: 8, tabId: 1 }, ctx);
    const cdp = client.cdpCalls();
    expect(cdp).toHaveLength(1);
    expect(cdp[0].params).toMatchObject({ type: 'mouseMoved', x: 7, y: 8 });
  });

  it('browser_type sends Input.insertText', async () => {
    await toolByName('browser_type').handler({ text: 'hi', tabId: 1 }, ctx);
    expect(client.cdpCalls()[0]).toMatchObject({ method: 'Input.insertText', params: { text: 'hi' } });
  });

  it('browser_press_key expands a chord into key events', async () => {
    await toolByName('browser_press_key').handler({ keys: 'Cmd+A', tabId: 1 }, ctx);
    const cdp = client.cdpCalls();
    expect(cdp).toHaveLength(4);
    expect(cdp[0].params).toMatchObject({ key: 'Meta', modifiers: 4 });
    expect(cdp[1].params).toMatchObject({ code: 'KeyA', modifiers: 4 });
  });

  it('browser_scroll sends a mouseWheel with deltas', async () => {
    await toolByName('browser_scroll').handler({ deltaX: 0, deltaY: 120, x: 5, y: 6, tabId: 1 }, ctx);
    expect(client.cdpCalls()[0]).toMatchObject({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseWheel', deltaX: 0, deltaY: 120, x: 5, y: 6 },
    });
  });

  it('browser_drag sends press(from) -> move(to) -> release(to)', async () => {
    await toolByName('browser_drag').handler({ fromX: 1, fromY: 2, toX: 30, toY: 40, tabId: 1 }, ctx);
    const cdp = client.cdpCalls();
    expect(cdp.map((c) => c.params?.type)).toEqual(['mousePressed', 'mouseMoved', 'mouseReleased']);
    expect(cdp[0].params).toMatchObject({ x: 1, y: 2, button: 'left', buttons: 1 });
    expect(cdp[1].params).toMatchObject({ x: 30, y: 40, buttons: 1 });
    expect(cdp[2].params).toMatchObject({ x: 30, y: 40, button: 'left', buttons: 0 });
  });
});
```

- [ ] **Step 2: Run it, expect FAIL.**

```bash
npm run test --workspace @claude-browser/mcp-server -- test/tools.vision.test.ts
```

- [ ] **Step 3: Create `packages/mcp-server/src/tools/types.ts` (COMPLETE).** Shared tool-definition shape + a CDP target/execute helper used by every tool module.

```ts
import { z } from 'zod';
import { Method, type ExecuteCdpParams, type CdpTarget } from '@claude-browser/shared';
import type { ToolContext } from '../context.js';
import type { CdpCommand } from '../cdp.js';

/** MCP-ish content block returned by a tool handler. */
export interface ToolResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;
}

/** A registrable tool: name + description + zod schema + handler. */
export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  inputSchema: S;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<ToolResult>;
}

/** Helper to declare a tool with inferred arg typing. */
export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

/** Run one CDP command via EXECUTE_CDP against a tab. */
export function execCdp<R = unknown>(
  ctx: ToolContext,
  tabId: number,
  cmd: CdpCommand,
  timeoutMs?: number,
): Promise<R> {
  const target: CdpTarget = { tabId };
  const params: ExecuteCdpParams = {
    target,
    method: cmd.method,
    params: cmd.params,
    timeoutMs,
  };
  return ctx.client.request<R>(Method.EXECUTE_CDP, params, timeoutMs);
}

/** Run an ordered list of CDP commands sequentially. */
export async function execCdpSeq(
  ctx: ToolContext,
  tabId: number,
  cmds: CdpCommand[],
): Promise<void> {
  for (const cmd of cmds) await execCdp(ctx, tabId, cmd);
}

/** Plain text result. */
export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}
```

- [ ] **Step 4: Create `packages/mcp-server/src/tools/vision.ts` (COMPLETE).**

```ts
import { z } from 'zod';
import {
  clickEvents,
  keyEvents,
  wheelEvent,
  insertTextCmd,
  screenshotParams,
  type CdpCommand,
} from '../cdp.js';
import {
  defineTool,
  execCdp,
  execCdpSeq,
  textResult,
  type ToolDef,
  type ToolResult,
} from './types.js';

const buttonEnum = z.enum(['left', 'right', 'middle']);

const browser_screenshot = defineTool({
  name: 'browser_screenshot',
  description: 'Capture a screenshot of the page (PNG). Pixels equal CSS pixels (deviceScaleFactor=1).',
  inputSchema: {
    fullPage: z.boolean().optional().describe('Capture the full scrollable page, not just the viewport.'),
    tabId: z.number().int().describe('The tab to screenshot.'),
  },
  async handler({ fullPage, tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    const result = await execCdp<{ data: string }>(ctx, tabId, {
      method: 'Page.captureScreenshot',
      params: screenshotParams(fullPage ?? false),
    });
    return { content: [{ type: 'image', data: result.data, mimeType: 'image/png' }] };
  },
});

const browser_click = defineTool({
  name: 'browser_click',
  description: 'Click at viewport coordinates (x,y). button defaults to left, count to 1 (use 2 for double-click).',
  inputSchema: {
    x: z.number(),
    y: z.number(),
    button: buttonEnum.optional(),
    count: z.number().int().min(1).optional(),
    tabId: z.number().int(),
  },
  async handler({ x, y, button, count, tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    await execCdpSeq(ctx, tabId, clickEvents(x, y, button ?? 'left', count ?? 1));
    return textResult(`clicked (${x}, ${y})`);
  },
});

const browser_move = defineTool({
  name: 'browser_move',
  description: 'Move the mouse to viewport coordinates (x,y) without pressing.',
  inputSchema: { x: z.number(), y: z.number(), tabId: z.number().int() },
  async handler({ x, y, tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    const cmd: CdpCommand = {
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseMoved', x, y, button: 'none', buttons: 0, clickCount: 0 },
    };
    await execCdp(ctx, tabId, cmd);
    return textResult(`moved to (${x}, ${y})`);
  },
});

const browser_type = defineTool({
  name: 'browser_type',
  description: 'Type literal text into the focused element via Input.insertText.',
  inputSchema: { text: z.string(), tabId: z.number().int() },
  async handler({ text, tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    await execCdp(ctx, tabId, insertTextCmd(text));
    return textResult(`typed ${text.length} chars`);
  },
});

const browser_press_key = defineTool({
  name: 'browser_press_key',
  description: 'Press a key or chord, e.g. "Enter", "Cmd+A", "Control+L", "ArrowDown".',
  inputSchema: { keys: z.string(), tabId: z.number().int() },
  async handler({ keys, tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    await execCdpSeq(ctx, tabId, keyEvents(keys));
    return textResult(`pressed ${keys}`);
  },
});

const browser_scroll = defineTool({
  name: 'browser_scroll',
  description: 'Scroll by (deltaX, deltaY) at optional (x,y); positive deltaY scrolls down.',
  inputSchema: {
    deltaX: z.number(),
    deltaY: z.number(),
    x: z.number().optional(),
    y: z.number().optional(),
    tabId: z.number().int(),
  },
  async handler({ deltaX, deltaY, x, y, tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    await execCdp(ctx, tabId, wheelEvent(deltaX, deltaY, x ?? 0, y ?? 0));
    return textResult(`scrolled (${deltaX}, ${deltaY})`);
  },
});

const browser_drag = defineTool({
  name: 'browser_drag',
  description: 'Drag from (fromX,fromY) to (toX,toY): press at start, move to end, release.',
  inputSchema: {
    fromX: z.number(),
    fromY: z.number(),
    toX: z.number(),
    toY: z.number(),
    tabId: z.number().int(),
  },
  async handler({ fromX, fromY, toX, toY, tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    const cmds: CdpCommand[] = [
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mousePressed', x: fromX, y: fromY, button: 'left', buttons: 1, clickCount: 1 },
      },
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mouseMoved', x: toX, y: toY, button: 'left', buttons: 1, clickCount: 0 },
      },
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mouseReleased', x: toX, y: toY, button: 'left', buttons: 0, clickCount: 1 },
      },
    ];
    await execCdpSeq(ctx, tabId, cmds);
    return textResult(`dragged (${fromX},${fromY}) -> (${toX},${toY})`);
  },
});

export const visionTools: ToolDef[] = [
  browser_screenshot,
  browser_click,
  browser_move,
  browser_type,
  browser_press_key,
  browser_scroll,
  browser_drag,
] as unknown as ToolDef[];
```

- [ ] **Step 5: Run it, expect PASS.**

```bash
npm run test --workspace @claude-browser/mcp-server -- test/tools.vision.test.ts
```

- [ ] **Step 6: Commit.**

```bash
git add packages/mcp-server/src/tools/types.ts packages/mcp-server/src/tools/vision.ts packages/mcp-server/test/tools.vision.test.ts
git commit -m "feat(mcp-server): vision tools (screenshot/click/move/type/press_key/scroll/drag) + tests"
```

---

### Task 32: `tools/dom.ts` — snapshot/click_ref/fill/query/get_text/eval

`browser_snapshot` runs `Accessibility.getFullAXTree`, compacts it to a ref list (`ref` -> `backendDOMNodeId`) stored in `ctx.refs`, and returns a readable outline. `browser_click_ref` resolves the ref → `DOM.getBoxModel` → `boxCenter` → click. `browser_fill` resolves the ref, focuses, inserts text. `browser_query`/`get_text`/`eval` use `Runtime.evaluate`. `browser_eval`'s description warns it runs arbitrary JS.

**Files**
- Test: `packages/mcp-server/test/tools.dom.test.ts`
- Create: `packages/mcp-server/src/snapshot.ts`
- Create: `packages/mcp-server/src/tools/dom.ts`

- [ ] **Step 1: Write the failing test `packages/mcp-server/test/tools.dom.test.ts` (COMPLETE).**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { domTools } from '../src/tools/dom.js';
import { compactAxTree } from '../src/snapshot.js';
import { createContext, type ToolContext } from '../src/context.js';
import { FakeClient } from './helpers/fake-client.js';
import { Method } from '@claude-browser/shared';

function tool(name: string) {
  const t = domTools.find((d) => d.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

const SAMPLE_AX = {
  nodes: [
    {
      nodeId: '1',
      backendDOMNodeId: 100,
      role: { value: 'button' },
      name: { value: 'Submit' },
      ignored: false,
    },
    {
      nodeId: '2',
      backendDOMNodeId: 200,
      role: { value: 'textbox' },
      name: { value: 'Email' },
      ignored: false,
    },
    {
      nodeId: '3',
      backendDOMNodeId: 300,
      role: { value: 'generic' },
      name: { value: '' },
      ignored: true, // ignored nodes are dropped
    },
  ],
};

describe('compactAxTree', () => {
  it('assigns sequential refs to non-ignored named nodes and maps ref -> backendDOMNodeId', () => {
    const { refs, outline } = compactAxTree(SAMPLE_AX);
    expect([...refs.entries()]).toEqual([
      ['ref1', 100],
      ['ref2', 200],
    ]);
    expect(outline).toContain('[ref1] button "Submit"');
    expect(outline).toContain('[ref2] textbox "Email"');
    expect(outline).not.toContain('generic');
  });
});

describe('dom tools', () => {
  let client: FakeClient;
  let ctx: ToolContext;
  beforeEach(() => {
    client = new FakeClient();
    ctx = createContext(client);
  });

  it('browser_snapshot attaches, calls Accessibility.getFullAXTree, and fills ctx.refs', async () => {
    client.onCdp('Accessibility.getFullAXTree', SAMPLE_AX);
    const res = await tool('browser_snapshot').handler({ tabId: 5 }, ctx);
    expect(client.calls[0]).toMatchObject({ method: Method.ATTACH, params: { tabId: 5 } });
    expect(client.cdpCalls()[0].method).toBe('Accessibility.getFullAXTree');
    expect(ctx.refs.get('ref1')).toBe(100);
    expect(res.content[0]).toMatchObject({ type: 'text' });
  });

  it('browser_click_ref resolves the ref via DOM.getBoxModel and clicks the box center', async () => {
    ctx.refs.set('ref1', 100);
    client.onCdp('DOM.getBoxModel', { model: { content: [10, 20, 110, 20, 110, 60, 10, 60] } });
    await tool('browser_click_ref').handler({ ref: 'ref1', tabId: 5 }, ctx);
    const cdp = client.cdpCalls();
    // getBoxModel is called with the backendNodeId
    const box = cdp.find((c) => c.method === 'DOM.getBoxModel');
    expect(box?.params).toMatchObject({ backendNodeId: 100 });
    // then a click sequence at the center (60,40)
    const press = cdp.find((c) => c.params?.type === 'mousePressed');
    expect(press?.params).toMatchObject({ x: 60, y: 40, button: 'left' });
  });

  it('browser_click_ref errors with a stale-ref message when ref is unknown', async () => {
    const res = await tool('browser_click_ref').handler({ ref: 'refZ', tabId: 5 }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]).toMatchObject({ type: 'text' });
    expect((res.content[0] as { text: string }).text).toMatch(/stale|unknown ref/i);
  });

  it('browser_fill resolves the ref, focuses it, and inserts text', async () => {
    ctx.refs.set('ref2', 200);
    client.onCdp('DOM.getBoxModel', { model: { content: [0, 0, 50, 0, 50, 20, 0, 20] } });
    await tool('browser_fill').handler({ ref: 'ref2', value: 'a@b.com', tabId: 5 }, ctx);
    const cdp = client.cdpCalls();
    expect(cdp.some((c) => c.method === 'DOM.focus' && c.params?.backendNodeId === 200)).toBe(true);
    expect(cdp.some((c) => c.method === 'Input.insertText' && c.params?.text === 'a@b.com')).toBe(true);
  });

  it('browser_query runs Runtime.evaluate with a querySelector expression', async () => {
    client.onCdp('Runtime.evaluate', { result: { value: '["#main"]' } });
    await tool('browser_query').handler({ selector: '#main', tabId: 5 }, ctx);
    const ev = client.cdpCalls()[0];
    expect(ev.method).toBe('Runtime.evaluate');
    expect(String(ev.params?.expression)).toContain('#main');
    expect(ev.params).toMatchObject({ returnByValue: true });
  });

  it('browser_get_text evaluates innerText for a selector (or body when omitted)', async () => {
    client.onCdp('Runtime.evaluate', { result: { value: 'hello' } });
    await tool('browser_get_text').handler({ tabId: 5 }, ctx);
    const ev = client.cdpCalls()[0];
    expect(String(ev.params?.expression)).toContain('innerText');
  });

  it('browser_eval runs the raw expression and warns in its description', async () => {
    client.onCdp('Runtime.evaluate', { result: { value: 42 } });
    const t = tool('browser_eval');
    expect(t.description.toLowerCase()).toContain('arbitrary');
    await t.handler({ expression: '40 + 2', tabId: 5 }, ctx);
    const ev = client.cdpCalls()[0];
    expect(ev.params).toMatchObject({ expression: '40 + 2', returnByValue: true });
  });
});
```

- [ ] **Step 2: Run it, expect FAIL.**

```bash
npm run test --workspace @claude-browser/mcp-server -- test/tools.dom.test.ts
```

- [ ] **Step 3: Create `packages/mcp-server/src/snapshot.ts` (COMPLETE).** Pure compaction so it is independently testable.

```ts
/** Minimal shape of an Accessibility.getFullAXTree node we care about. */
interface AxNode {
  backendDOMNodeId?: number;
  role?: { value?: string };
  name?: { value?: string };
  ignored?: boolean;
}

export interface AxTree {
  nodes: AxNode[];
}

export interface CompactSnapshot {
  /** ref string -> backendDOMNodeId */
  refs: Map<string, number>;
  /** Human-readable outline with [refN] role "name" lines. */
  outline: string;
}

/**
 * Compacts an AX tree to a ref list. Skips ignored nodes and nodes lacking a
 * backendDOMNodeId. Refs are sequential: ref1, ref2, ...
 */
export function compactAxTree(tree: AxTree): CompactSnapshot {
  const refs = new Map<string, number>();
  const lines: string[] = [];
  let n = 0;
  for (const node of tree.nodes ?? []) {
    if (node.ignored) continue;
    if (typeof node.backendDOMNodeId !== 'number') continue;
    const role = node.role?.value ?? 'unknown';
    const name = node.name?.value ?? '';
    n++;
    const ref = `ref${n}`;
    refs.set(ref, node.backendDOMNodeId);
    lines.push(`[${ref}] ${role} ${JSON.stringify(name)}`);
  }
  return { refs, outline: lines.join('\n') };
}
```

- [ ] **Step 4: Create `packages/mcp-server/src/tools/dom.ts` (COMPLETE).**

```ts
import { z } from 'zod';
import { ErrorCode } from '@claude-browser/shared';
import { clickEvents, insertTextCmd, boxCenter } from '../cdp.js';
import { compactAxTree, type AxTree } from '../snapshot.js';
import {
  defineTool,
  execCdp,
  execCdpSeq,
  textResult,
  type ToolDef,
  type ToolResult,
} from './types.js';
import type { ToolContext } from '../context.js';

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Resolve a snapshot ref to its backendDOMNodeId or throw a stale-ref error. */
function resolveRef(ctx: ToolContext, ref: string): number {
  const id = ctx.refs.get(ref);
  if (id === undefined) {
    throw new RefError(`stale or unknown ref "${ref}" — re-run browser_snapshot`);
  }
  return id;
}

class RefError extends Error {
  code = ErrorCode.STALE_REF;
}

const browser_snapshot = defineTool({
  name: 'browser_snapshot',
  description: 'Accessibility snapshot of the page as a compact list of elements with stable [refN] handles for browser_click_ref/browser_fill.',
  inputSchema: { tabId: z.number().int() },
  async handler({ tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    const tree = await execCdp<AxTree>(ctx, tabId, {
      method: 'Accessibility.getFullAXTree',
      params: {},
    });
    const { refs, outline } = compactAxTree(tree);
    ctx.refs.clear();
    for (const [k, v] of refs) ctx.refs.set(k, v);
    return textResult(outline || '(no accessible elements)');
  },
});

const browser_click_ref = defineTool({
  name: 'browser_click_ref',
  description: 'Click an element by its snapshot [refN] handle (resolved via DOM.getBoxModel center).',
  inputSchema: { ref: z.string(), tabId: z.number().int() },
  async handler({ ref, tabId }, ctx): Promise<ToolResult> {
    let backendNodeId: number;
    try {
      backendNodeId = resolveRef(ctx, ref);
    } catch (e) {
      return errorResult((e as Error).message);
    }
    await ctx.attach(tabId);
    const box = await execCdp<{ model: { content: number[] } }>(ctx, tabId, {
      method: 'DOM.getBoxModel',
      params: { backendNodeId },
    });
    const { x, y } = boxCenter(box.model.content);
    await execCdpSeq(ctx, tabId, clickEvents(x, y, 'left', 1));
    return textResult(`clicked ${ref} at (${x}, ${y})`);
  },
});

const browser_fill = defineTool({
  name: 'browser_fill',
  description: 'Focus an element by its [refN] handle and type a value into it.',
  inputSchema: { ref: z.string(), value: z.string(), tabId: z.number().int() },
  async handler({ ref, value, tabId }, ctx): Promise<ToolResult> {
    let backendNodeId: number;
    try {
      backendNodeId = resolveRef(ctx, ref);
    } catch (e) {
      return errorResult((e as Error).message);
    }
    await ctx.attach(tabId);
    await execCdp(ctx, tabId, { method: 'DOM.focus', params: { backendNodeId } });
    await execCdp(ctx, tabId, insertTextCmd(value));
    return textResult(`filled ${ref}`);
  },
});

const browser_query = defineTool({
  name: 'browser_query',
  description: 'Find elements by CSS selector. Returns matched outerHTML (first match, or all when all=true).',
  inputSchema: { selector: z.string(), all: z.boolean().optional(), tabId: z.number().int() },
  async handler({ selector, all, tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    const sel = JSON.stringify(selector);
    const expression = all
      ? `JSON.stringify(Array.from(document.querySelectorAll(${sel})).map(e => e.outerHTML))`
      : `(() => { const el = document.querySelector(${sel}); return el ? el.outerHTML : null; })()`;
    const out = await execCdp<{ result: { value: unknown } }>(ctx, tabId, {
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true },
    });
    return textResult(String(out.result?.value ?? 'null'));
  },
});

const browser_get_text = defineTool({
  name: 'browser_get_text',
  description: 'Get readable innerText of a CSS selector, or the whole body when selector is omitted.',
  inputSchema: { selector: z.string().optional(), tabId: z.number().int() },
  async handler({ selector, tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    const target = selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document.body';
    const expression = `(() => { const el = ${target}; return el ? el.innerText : null; })()`;
    const out = await execCdp<{ result: { value: unknown } }>(ctx, tabId, {
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true },
    });
    return textResult(String(out.result?.value ?? ''));
  },
});

const browser_eval = defineTool({
  name: 'browser_eval',
  description: 'DANGER: runs arbitrary JavaScript in the page via Runtime.evaluate and returns the value. Permission-gated; only use with explicit user intent.',
  inputSchema: { expression: z.string(), tabId: z.number().int() },
  async handler({ expression, tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    const out = await execCdp<{ result: { value: unknown } }>(ctx, tabId, {
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true },
    });
    return textResult(JSON.stringify(out.result?.value ?? null));
  },
});

export const domTools: ToolDef[] = [
  browser_snapshot,
  browser_click_ref,
  browser_fill,
  browser_query,
  browser_get_text,
  browser_eval,
] as unknown as ToolDef[];
```

- [ ] **Step 5: Run it, expect PASS.**

```bash
npm run test --workspace @claude-browser/mcp-server -- test/tools.dom.test.ts
```

- [ ] **Step 6: Commit.**

```bash
git add packages/mcp-server/src/snapshot.ts packages/mcp-server/src/tools/dom.ts packages/mcp-server/test/tools.dom.test.ts
git commit -m "feat(mcp-server): dom tools (snapshot/click_ref/fill/query/get_text/eval) + AX compaction + tests"
```

---

### Task 33: `tools/navigation.ts` — navigate/back/forward/reload/wait

All navigation tools attach first, then drive `Page.*`. `browser_wait` supports `{ms}` (delay), `{selector}` (poll via Runtime.evaluate), or `{networkIdle}` (Page lifecycle). For determinism `wait` accepts an injectable delay through the context-free path: the `ms` branch uses a module-level `sleep` that the test overrides via the exported `__setSleep` hook.

**Files**
- Test: `packages/mcp-server/test/tools.navigation.test.ts`
- Create: `packages/mcp-server/src/tools/navigation.ts`

- [ ] **Step 1: Write the failing test `packages/mcp-server/test/tools.navigation.test.ts` (COMPLETE).**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { navigationTools, __setSleep } from '../src/tools/navigation.js';
import { createContext, type ToolContext } from '../src/context.js';
import { FakeClient } from './helpers/fake-client.js';
import { Method } from '@claude-browser/shared';

function tool(name: string) {
  const t = navigationTools.find((d) => d.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

describe('navigation tools', () => {
  let client: FakeClient;
  let ctx: ToolContext;
  beforeEach(() => {
    client = new FakeClient();
    ctx = createContext(client);
    __setSleep(() => Promise.resolve());
  });

  it('browser_navigate attaches then calls Page.navigate with the url', async () => {
    await tool('browser_navigate').handler({ url: 'https://example.com', tabId: 2 }, ctx);
    expect(client.calls[0]).toMatchObject({ method: Method.ATTACH, params: { tabId: 2 } });
    expect(client.cdpCalls()[0]).toMatchObject({
      method: 'Page.navigate',
      params: { url: 'https://example.com' },
    });
  });

  it('browser_back issues a negative-entry Page.navigateToHistoryEntry via history delta', async () => {
    client.onCdp('Page.getNavigationHistory', { currentIndex: 2, entries: [{ id: 10 }, { id: 11 }, { id: 12 }] });
    await tool('browser_back').handler({ tabId: 2 }, ctx);
    const cdp = client.cdpCalls();
    expect(cdp.some((c) => c.method === 'Page.getNavigationHistory')).toBe(true);
    expect(cdp.some((c) => c.method === 'Page.navigateToHistoryEntry' && c.params?.entryId === 11)).toBe(true);
  });

  it('browser_forward navigates to the next history entry', async () => {
    client.onCdp('Page.getNavigationHistory', { currentIndex: 0, entries: [{ id: 10 }, { id: 11 }, { id: 12 }] });
    await tool('browser_forward').handler({ tabId: 2 }, ctx);
    const cdp = client.cdpCalls();
    expect(cdp.some((c) => c.method === 'Page.navigateToHistoryEntry' && c.params?.entryId === 11)).toBe(true);
  });

  it('browser_reload calls Page.reload', async () => {
    await tool('browser_reload').handler({ tabId: 2 }, ctx);
    expect(client.cdpCalls()[0].method).toBe('Page.reload');
  });

  it('browser_wait with ms resolves without CDP calls', async () => {
    const res = await tool('browser_wait').handler({ ms: 500, tabId: 2 }, ctx);
    expect(client.cdpCalls()).toHaveLength(0);
    expect(res.content[0]).toMatchObject({ type: 'text' });
  });

  it('browser_wait with selector polls Runtime.evaluate until the element exists', async () => {
    let calls = 0;
    // First poll: missing; second poll: present.
    client.request = async (method, params) => {
      (client.calls as unknown[]).push({ method, params });
      const inner = (params as { method?: string }).method;
      if (inner === 'Runtime.evaluate') {
        calls++;
        return { result: { value: calls >= 2 } } as never;
      }
      return undefined as never;
    };
    await tool('browser_wait').handler({ selector: '#ready', tabId: 2 }, ctx);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL.**

```bash
npm run test --workspace @claude-browser/mcp-server -- test/tools.navigation.test.ts
```

- [ ] **Step 3: Create `packages/mcp-server/src/tools/navigation.ts` (COMPLETE).**

```ts
import { z } from 'zod';
import { defineTool, execCdp, textResult, type ToolDef, type ToolResult } from './types.js';
import type { ToolContext } from '../context.js';

// Injectable sleep so browser_wait({ms}) is deterministic in tests.
let sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));
export function __setSleep(fn: (ms: number) => Promise<void>): void {
  sleep = fn;
}

interface NavHistory {
  currentIndex: number;
  entries: Array<{ id: number }>;
}

async function navigateRelative(ctx: ToolContext, tabId: number, delta: number): Promise<boolean> {
  const hist = await execCdp<NavHistory>(ctx, tabId, {
    method: 'Page.getNavigationHistory',
    params: {},
  });
  const target = hist.currentIndex + delta;
  if (target < 0 || target >= hist.entries.length) return false;
  await execCdp(ctx, tabId, {
    method: 'Page.navigateToHistoryEntry',
    params: { entryId: hist.entries[target].id },
  });
  return true;
}

const browser_navigate = defineTool({
  name: 'browser_navigate',
  description: 'Navigate the tab to a URL (Page.navigate).',
  inputSchema: { url: z.string().url(), tabId: z.number().int() },
  async handler({ url, tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    await execCdp(ctx, tabId, { method: 'Page.navigate', params: { url } });
    return textResult(`navigated to ${url}`);
  },
});

const browser_back = defineTool({
  name: 'browser_back',
  description: 'Go back one entry in the tab history.',
  inputSchema: { tabId: z.number().int() },
  async handler({ tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    const ok = await navigateRelative(ctx, tabId, -1);
    return textResult(ok ? 'went back' : 'no previous history entry');
  },
});

const browser_forward = defineTool({
  name: 'browser_forward',
  description: 'Go forward one entry in the tab history.',
  inputSchema: { tabId: z.number().int() },
  async handler({ tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    const ok = await navigateRelative(ctx, tabId, 1);
    return textResult(ok ? 'went forward' : 'no next history entry');
  },
});

const browser_reload = defineTool({
  name: 'browser_reload',
  description: 'Reload the tab (Page.reload).',
  inputSchema: { tabId: z.number().int() },
  async handler({ tabId }, ctx): Promise<ToolResult> {
    await ctx.attach(tabId);
    await execCdp(ctx, tabId, { method: 'Page.reload', params: {} });
    return textResult('reloaded');
  },
});

const browser_wait = defineTool({
  name: 'browser_wait',
  description: 'Wait for a fixed time (ms) or until a CSS selector exists (selector). Polls every 200ms up to ~10s.',
  inputSchema: {
    ms: z.number().int().positive().optional(),
    selector: z.string().optional(),
    tabId: z.number().int(),
  },
  async handler({ ms, selector, tabId }, ctx): Promise<ToolResult> {
    if (ms !== undefined) {
      await sleep(ms);
      return textResult(`waited ${ms}ms`);
    }
    if (selector !== undefined) {
      await ctx.attach(tabId);
      const expression = `!!document.querySelector(${JSON.stringify(selector)})`;
      const deadline = 10_000;
      const interval = 200;
      let waited = 0;
      for (;;) {
        const out = await execCdp<{ result: { value: unknown } }>(ctx, tabId, {
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true },
        });
        if (out.result?.value === true) return textResult(`selector ${selector} appeared`);
        if (waited >= deadline) return textResult(`timed out waiting for ${selector}`);
        await sleep(interval);
        waited += interval;
      }
    }
    return textResult('nothing to wait for');
  },
});

export const navigationTools: ToolDef[] = [
  browser_navigate,
  browser_back,
  browser_forward,
  browser_reload,
  browser_wait,
] as unknown as ToolDef[];
```

- [ ] **Step 4: Run it, expect PASS.**

```bash
npm run test --workspace @claude-browser/mcp-server -- test/tools.navigation.test.ts
```

- [ ] **Step 5: Commit.**

```bash
git add packages/mcp-server/src/tools/navigation.ts packages/mcp-server/test/tools.navigation.test.ts
git commit -m "feat(mcp-server): navigation tools (navigate/back/forward/reload/wait) + tests"
```

---

### Task 34: `tools/tabs.ts` + `tools/console.ts` — broker helper methods

Tabs use the broker helper methods directly (`Method.GET_TABS/NEW_TAB/SWITCH_TAB/CLOSE_TAB`), not `EXECUTE_CDP`. Console uses `Method.GET_CONSOLE`.

**Files**
- Test: `packages/mcp-server/test/tools.tabs.test.ts`
- Test: `packages/mcp-server/test/tools.console.test.ts`
- Create: `packages/mcp-server/src/tools/tabs.ts`
- Create: `packages/mcp-server/src/tools/console.ts`

- [ ] **Step 1: Write the failing test `packages/mcp-server/test/tools.tabs.test.ts` (COMPLETE).**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { tabsTools } from '../src/tools/tabs.js';
import { createContext, type ToolContext } from '../src/context.js';
import { FakeClient } from './helpers/fake-client.js';
import { Method } from '@claude-browser/shared';

function tool(name: string) {
  const t = tabsTools.find((d) => d.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

describe('tabs tools', () => {
  let client: FakeClient;
  let ctx: ToolContext;
  beforeEach(() => {
    client = new FakeClient();
    ctx = createContext(client);
  });

  it('browser_get_tabs calls Method.GET_TABS and lists tabs', async () => {
    client.onMethod(Method.GET_TABS, { tabs: [{ id: 1, url: 'https://a', title: 'A', active: true }] });
    const res = await tool('browser_get_tabs').handler({}, ctx);
    expect(client.last()).toMatchObject({ method: Method.GET_TABS });
    expect((res.content[0] as { text: string }).text).toContain('https://a');
  });

  it('browser_new_tab calls Method.NEW_TAB with the url', async () => {
    client.onMethod(Method.NEW_TAB, { id: 9, url: 'https://x' });
    await tool('browser_new_tab').handler({ url: 'https://x' }, ctx);
    expect(client.last()).toMatchObject({ method: Method.NEW_TAB, params: { url: 'https://x' } });
  });

  it('browser_switch_tab calls Method.SWITCH_TAB with tabId', async () => {
    await tool('browser_switch_tab').handler({ tabId: 4 }, ctx);
    expect(client.last()).toMatchObject({ method: Method.SWITCH_TAB, params: { tabId: 4 } });
  });

  it('browser_close_tab calls Method.CLOSE_TAB with tabId', async () => {
    await tool('browser_close_tab').handler({ tabId: 4 }, ctx);
    expect(client.last()).toMatchObject({ method: Method.CLOSE_TAB, params: { tabId: 4 } });
  });
});
```

- [ ] **Step 2: Write the failing test `packages/mcp-server/test/tools.console.test.ts` (COMPLETE).**

```ts
import { describe, it, expect } from 'vitest';
import { consoleTools } from '../src/tools/console.js';
import { createContext } from '../src/context.js';
import { FakeClient } from './helpers/fake-client.js';
import { Method } from '@claude-browser/shared';

describe('console tool', () => {
  it('browser_console calls Method.GET_CONSOLE with filter/since/tabId and formats entries', async () => {
    const client = new FakeClient();
    client.onMethod(Method.GET_CONSOLE, {
      entries: [{ tabId: 1, level: 'error', text: 'boom', timestamp: 123 }],
    });
    const ctx = createContext(client);
    const t = consoleTools.find((d) => d.name === 'browser_console')!;
    const res = await t.handler({ tabId: 1, filter: 'error', since: 100 }, ctx);
    expect(client.last()).toMatchObject({
      method: Method.GET_CONSOLE,
      params: { tabId: 1, filter: 'error', since: 100 },
    });
    expect((res.content[0] as { text: string }).text).toContain('boom');
  });
});
```

- [ ] **Step 3: Run both, expect FAIL.**

```bash
npm run test --workspace @claude-browser/mcp-server -- test/tools.tabs.test.ts test/tools.console.test.ts
```

- [ ] **Step 4: Create `packages/mcp-server/src/tools/tabs.ts` (COMPLETE).**

```ts
import { z } from 'zod';
import {
  Method,
  type GetTabsResult,
  type NewTabParams,
  type NewTabResult,
  type SwitchTabParams,
  type CloseTabParams,
} from '@claude-browser/shared';
import { defineTool, textResult, type ToolDef, type ToolResult } from './types.js';

const browser_get_tabs = defineTool({
  name: 'browser_get_tabs',
  description: 'List open browser tabs (id, url, title, active).',
  inputSchema: {},
  async handler(_args, ctx): Promise<ToolResult> {
    const res = await ctx.client.request<GetTabsResult>(Method.GET_TABS, {});
    const lines = res.tabs.map(
      (t) => `${t.id}${t.active ? ' *' : ''}: ${t.title ?? '(untitled)'} — ${t.url ?? ''}`,
    );
    return textResult(lines.join('\n') || '(no tabs)');
  },
});

const browser_new_tab = defineTool({
  name: 'browser_new_tab',
  description: 'Open a new tab, optionally at a URL. Returns the new tab id.',
  inputSchema: { url: z.string().url().optional() },
  async handler({ url }, ctx): Promise<ToolResult> {
    const params: NewTabParams = { url };
    const tab = await ctx.client.request<NewTabResult>(Method.NEW_TAB, params);
    return textResult(`opened tab ${tab.id}${tab.url ? ` at ${tab.url}` : ''}`);
  },
});

const browser_switch_tab = defineTool({
  name: 'browser_switch_tab',
  description: 'Activate (focus) a tab by id.',
  inputSchema: { tabId: z.number().int() },
  async handler({ tabId }, ctx): Promise<ToolResult> {
    const params: SwitchTabParams = { tabId };
    await ctx.client.request(Method.SWITCH_TAB, params);
    return textResult(`switched to tab ${tabId}`);
  },
});

const browser_close_tab = defineTool({
  name: 'browser_close_tab',
  description: 'Close a tab by id.',
  inputSchema: { tabId: z.number().int() },
  async handler({ tabId }, ctx): Promise<ToolResult> {
    const params: CloseTabParams = { tabId };
    await ctx.client.request(Method.CLOSE_TAB, params);
    return textResult(`closed tab ${tabId}`);
  },
});

export const tabsTools: ToolDef[] = [
  browser_get_tabs,
  browser_new_tab,
  browser_switch_tab,
  browser_close_tab,
] as unknown as ToolDef[];
```

- [ ] **Step 5: Create `packages/mcp-server/src/tools/console.ts` (COMPLETE).**

```ts
import { z } from 'zod';
import { Method, type GetConsoleParams, type GetConsoleResult } from '@claude-browser/shared';
import { defineTool, textResult, type ToolDef, type ToolResult } from './types.js';

const browser_console = defineTool({
  name: 'browser_console',
  description: 'Read buffered browser console messages from the broker. Filter by tab, level substring, or timestamp.',
  inputSchema: {
    tabId: z.number().int().optional(),
    filter: z.string().optional(),
    since: z.number().optional(),
  },
  async handler({ tabId, filter, since }, ctx): Promise<ToolResult> {
    const params: GetConsoleParams = { tabId, filter, since };
    const res = await ctx.client.request<GetConsoleResult>(Method.GET_CONSOLE, params);
    const lines = res.entries.map(
      (e) => `[${new Date(e.timestamp).toISOString()}] ${e.level} (tab ${e.tabId}): ${e.text}`,
    );
    return textResult(lines.join('\n') || '(no console entries)');
  },
});

export const consoleTools: ToolDef[] = [browser_console] as unknown as ToolDef[];
```

- [ ] **Step 6: Run both, expect PASS.**

```bash
npm run test --workspace @claude-browser/mcp-server -- test/tools.tabs.test.ts test/tools.console.test.ts
```

- [ ] **Step 7: Commit.**

```bash
git add packages/mcp-server/src/tools/tabs.ts packages/mcp-server/src/tools/console.ts packages/mcp-server/test/tools.tabs.test.ts packages/mcp-server/test/tools.console.test.ts
git commit -m "feat(mcp-server): tabs + console tools via broker helper methods + tests"
```

---

### Task 35: `tools/index.ts` — `registerAll` onto an McpServer

Collects every tool def and registers each on the SDK's `McpServer` via `registerTool`, wrapping the handler so it receives the shared `ToolContext`. The SDK is faked in the test by a recorder that captures registered names + schemas, so no real server is needed.

**Files**
- Test: `packages/mcp-server/test/tools.index.test.ts`
- Create: `packages/mcp-server/src/tools/index.ts`

- [ ] **Step 1: Write the failing test `packages/mcp-server/test/tools.index.test.ts` (COMPLETE).**

```ts
import { describe, it, expect } from 'vitest';
import { registerAll, allTools } from '../src/tools/index.js';
import { createContext } from '../src/context.js';
import { FakeClient } from './helpers/fake-client.js';

class RecorderServer {
  registered: Array<{ name: string; config: unknown }> = [];
  registerTool(name: string, config: unknown, _handler: unknown): void {
    this.registered.push({ name, config });
  }
}

describe('registerAll', () => {
  it('registers every browser_* tool exactly once with a description and inputSchema', () => {
    const server = new RecorderServer();
    const ctx = createContext(new FakeClient());
    registerAll(server as never, ctx);

    const names = server.registered.map((r) => r.name).sort();
    const expected = allTools.map((t) => t.name).sort();
    expect(names).toEqual(expected);
    // no duplicates
    expect(new Set(names).size).toBe(names.length);
    // every entry has a description + schema
    for (const r of server.registered) {
      const cfg = r.config as { description?: string; inputSchema?: unknown };
      expect(typeof cfg.description).toBe('string');
      expect(cfg.inputSchema).toBeDefined();
    }
  });

  it('includes the core v1 tool surface', () => {
    const names = allTools.map((t) => t.name);
    for (const expected of [
      'browser_screenshot', 'browser_click', 'browser_move', 'browser_type',
      'browser_press_key', 'browser_scroll', 'browser_drag',
      'browser_snapshot', 'browser_click_ref', 'browser_fill', 'browser_query',
      'browser_get_text', 'browser_eval',
      'browser_navigate', 'browser_back', 'browser_forward', 'browser_reload', 'browser_wait',
      'browser_get_tabs', 'browser_new_tab', 'browser_switch_tab', 'browser_close_tab',
      'browser_console',
    ]) {
      expect(names).toContain(expected);
    }
    // v1 explicitly has NO browser_get_history tool
    expect(names).not.toContain('browser_get_history');
  });
});
```

- [ ] **Step 2: Run it, expect FAIL.**

```bash
npm run test --workspace @claude-browser/mcp-server -- test/tools.index.test.ts
```

- [ ] **Step 3: Create `packages/mcp-server/src/tools/index.ts` (COMPLETE).**

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../context.js';
import type { ToolDef } from './types.js';
import { visionTools } from './vision.js';
import { domTools } from './dom.js';
import { navigationTools } from './navigation.js';
import { tabsTools } from './tabs.js';
import { consoleTools } from './console.js';

/** Every v1 browser_* tool, in a stable order. */
export const allTools: ToolDef[] = [
  ...visionTools,
  ...domTools,
  ...navigationTools,
  ...tabsTools,
  ...consoleTools,
];

/** Register all tools on an McpServer, threading the shared ToolContext. */
export function registerAll(server: McpServer, ctx: ToolContext): void {
  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      // SDK passes parsed args; we hand them and the context to our handler.
      (args: unknown) => tool.handler(args as never, ctx),
    );
  }
}
```

- [ ] **Step 4: Run it, expect PASS.**

```bash
npm run test --workspace @claude-browser/mcp-server -- test/tools.index.test.ts
```

- [ ] **Step 5: Commit.**

```bash
git add packages/mcp-server/src/tools/index.ts packages/mcp-server/test/tools.index.test.ts
git commit -m "feat(mcp-server): registerAll wires every browser_* tool onto McpServer"
```

---

### Task 36: `index.ts` — entry: load config, build client, register tools, connect

The bin entry: loads `~/.claude-browser/config.json` (reusing the broker's config reader is not allowed cross-package here, so this package reads the same file shape independently), creates the `McpServer` + `StdioServerTransport`, builds the `BrokerClient` with a generated `sessionId`, registers all tools, kicks off `connectWithRetry()` (non-blocking so MCP is responsive even while the broker spins up), and connects the transport. The config-loading function is pure and tested; the wiring `main()` is exercised by typecheck + build.

**Files**
- Test: `packages/mcp-server/test/load-config.test.ts`
- Create: `packages/mcp-server/src/load-config.ts`
- Create: `packages/mcp-server/src/index.ts`

- [ ] **Step 1: Write the failing test `packages/mcp-server/test/load-config.test.ts` (COMPLETE).**

```ts
import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/load-config.js';
import { DEFAULT_PORT } from '@claude-browser/shared';

describe('parseConfig', () => {
  it('reads port/token/extensionId from valid JSON', () => {
    const cfg = parseConfig('{"port":9000,"token":"abc","extensionId":"ext"}');
    expect(cfg).toEqual({ port: 9000, token: 'abc', extensionId: 'ext' });
  });

  it('defaults the port to DEFAULT_PORT when omitted', () => {
    const cfg = parseConfig('{"token":"abc","extensionId":"ext"}');
    expect(cfg.port).toBe(DEFAULT_PORT);
  });

  it('throws a clear error when token is missing', () => {
    expect(() => parseConfig('{"extensionId":"ext"}')).toThrow(/token/i);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseConfig('not json')).toThrow(/config/i);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL.**

```bash
npm run test --workspace @claude-browser/mcp-server -- test/load-config.test.ts
```

- [ ] **Step 3: Create `packages/mcp-server/src/load-config.ts` (COMPLETE).**

```ts
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PORT,
  CONFIG_DIR,
  CONFIG_FILE,
  type Config,
} from '@claude-browser/shared';

/** Parse the on-disk config JSON into a Config, applying the default port. */
export function parseConfig(raw: string): Config {
  let obj: Partial<Config>;
  try {
    obj = JSON.parse(raw) as Partial<Config>;
  } catch {
    throw new Error('claude-browser: config.json is not valid JSON');
  }
  if (typeof obj.token !== 'string' || obj.token.length === 0) {
    throw new Error('claude-browser: config is missing "token"');
  }
  if (typeof obj.extensionId !== 'string' || obj.extensionId.length === 0) {
    throw new Error('claude-browser: config is missing "extensionId"');
  }
  return {
    port: typeof obj.port === 'number' ? obj.port : DEFAULT_PORT,
    token: obj.token,
    extensionId: obj.extensionId,
  };
}

/** Absolute path to ~/.claude-browser/config.json. */
export function configPath(): string {
  return join(homedir(), CONFIG_DIR, CONFIG_FILE);
}

/** Read + parse the config from disk. */
export function loadConfig(): Config {
  return parseConfig(readFileSync(configPath(), 'utf8'));
}
```

- [ ] **Step 4: Run it, expect PASS.**

```bash
npm run test --workspace @claude-browser/mcp-server -- test/load-config.test.ts
```

- [ ] **Step 5: Create `packages/mcp-server/src/index.ts` (COMPLETE).** This wires the SDK; it is verified by build/typecheck (no unit test needed for the glue).

```ts
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './load-config.js';
import { BrokerClient } from './client.js';
import { createContext } from './context.js';
import { registerAll } from './tools/index.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const client = new BrokerClient({
    port: config.port,
    token: config.token,
    sessionId: randomUUID(),
  });

  const server = new McpServer({ name: 'claude-browser', version: '0.1.0' });
  const ctx = createContext(client);
  registerAll(server, ctx);

  // Connect to the broker in the background: spawns it detached if down, then
  // auto-reconnects. Tool calls before it is ready reject with typed errors and
  // Claude can retry — we never block MCP startup on the browser link.
  void client.connectWithRetry();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // stderr only: stdout is the MCP stdio channel.
  process.stderr.write(`claude-browser-mcp fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
```

- [ ] **Step 6: Typecheck + build to confirm the SDK wiring compiles.**

```bash
npm run lint --workspace @claude-browser/mcp-server && npm run build --workspace @claude-browser/mcp-server
```

- [ ] **Step 7: Commit.**

```bash
git add packages/mcp-server/src/load-config.ts packages/mcp-server/src/index.ts packages/mcp-server/test/load-config.test.ts
git commit -m "feat(mcp-server): entry wiring (config load, McpServer + stdio, background connect)"
```

---

### Task 37: Full package test + build gate

**Files**
- (no new files; verification gate)

- [ ] **Step 1: Run the entire mcp-server test suite, expect all PASS.**

```bash
npm run test --workspace @claude-browser/mcp-server
```

- [ ] **Step 2: Typecheck the whole package.**

```bash
npm run lint --workspace @claude-browser/mcp-server
```

- [ ] **Step 3: Build the bin and confirm `dist/index.js` has the shebang.**

```bash
npm run build --workspace @claude-browser/mcp-server && head -1 packages/mcp-server/dist/index.js
```

- [ ] **Step 4: Commit any incidental fixups (if none, skip).**

```bash
git commit --allow-empty -m "test(mcp-server): full suite + build green"
```


---

# Milestone 5 — Install + Integration/Soak Tests

## Scope: Install/Uninstall Scripts + Integration & Soak Tests

These tasks depend on all four packages already being built (`@claude-browser/shared`, `@claude-browser/broker`, `@claude-browser/extension`, `claude-browser-mcp`) and on the contract in `packages/shared/src/protocol.ts`. They live at the repo root under `scripts/` and `test/integration/`. The integration and soak tests require a real Chrome install and are gated behind `RUN_BROWSER_TESTS=1` so the default unit CI stays hermetic.

A root-level note on dependencies: the scripts and integration tests need a few extra dev/runtime deps at the repo root: `tsx` (to run `.ts` scripts directly), `chrome-launcher`, and `ws`. The `ws` and `@modelcontextprotocol/sdk` packages come transitively through the workspaces, but we declare what these root files import explicitly.

---

### Task 38: Root tooling deps for scripts + integration harness

**Files**
- Modify: `/Users/ming/Documents/code/ai/claude-ext/package.json`

This is a pure-config task (no logic), so it shows complete file contents and skips TDD sub-steps. It augments the root `package.json` the scaffold task created with the deps and scripts the installer and integration suite need. The `chrome-launcher` package launches a real Chrome; `tsx` runs the TypeScript install/uninstall scripts and integration tests without a separate build; `ws` is the node WebSocket client/server used by the harness; `@types/ws` and `@types/node` for types; `vitest` is the runner. `tslib` is required because the workspace packages emit with `importHelpers`.

- [ ] **Step 1: Write the complete root `package.json`** (the synthesizer will reconcile workspace globs and shared dev deps already declared by the scaffold task; these `scripts` and `devDependencies` keys are additive — keep both sets).

```json
{
  "name": "claude-browser",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "test": "vitest run",
    "test:integration": "RUN_BROWSER_TESTS=1 vitest run --config vitest.integration.config.ts",
    "lint": "tsc -b --pretty",
    "install:browser": "tsx scripts/install.ts",
    "uninstall:browser": "tsx scripts/uninstall.ts"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@types/ws": "^8.5.13",
    "chrome-launcher": "^1.1.2",
    "tslib": "^2.8.1",
    "tsup": "^8.3.5",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8",
    "ws": "^8.18.0"
  }
}
```

- [ ] **Step 2: Create the integration-only vitest config** so the heavy real-Chrome suite is isolated from the unit `vitest run`. Create `/Users/ming/Documents/code/ai/claude-ext/vitest.integration.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

// Integration + soak tests launch a real Chrome and an in-process broker.
// They are slow and require RUN_BROWSER_TESTS=1; the gate inside each test
// turns the whole file into a no-op when the flag is absent, but we also
// scope the runner here so `npm test` (unit) never touches them.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    teardownTimeout: 30_000,
    fileParallelism: false,
    pool: 'forks',
  },
});
```

- [ ] **Step 3: Ensure the default unit config excludes `test/integration`.** Create `/Users/ming/Documents/code/ai/claude-ext/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

// Default (hermetic) unit run: every package's own test/ dirs, never the
// real-Chrome integration suite.
export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'test/integration/**'],
  },
});
```

- [ ] **Step 4: Install and verify the toolchain resolves.** Run:

```bash
cd /Users/ming/Documents/code/ai/claude-ext && npm install && npx tsx --version && npx vitest --version
```

Expect: install completes and both version commands print a version (toolchain ready).

- [ ] **Step 5: Commit.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && git add package.json vitest.config.ts vitest.integration.config.ts && git commit -m "chore: root deps + vitest configs for installer and integration suite"
```

---

### Task 39: Extension-ID derivation utility (pure, TDD)

**Files**
- Create: `/Users/ming/Documents/code/ai/claude-ext/scripts/lib/extension-id.ts`
- Test: `/Users/ming/Documents/code/ai/claude-ext/scripts/lib/extension-id.test.ts`

The installer must compute the **pinned** extension ID that the broker allowlists (the `Origin: chrome-extension://<id>` check in `server.ts`). Chrome derives the ID from the manifest `key`: base64-decode the `key` (it is a DER-encoded SubjectPublicKeyInfo), SHA-256 it, take the first 16 bytes, and map each hex nibble `0–f` to letters `a–p` (the "mpdecimal" alphabet). This module is pure and fully unit-testable, so STRICT TDD applies. It is reused by both `install.ts` and the integration harness (which must confirm the loaded extension reports the same ID).

- [ ] **Step 1: Write the failing test with complete code.** Create `/Users/ming/Documents/code/ai/claude-ext/scripts/lib/extension-id.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeExtensionId, idFromManifestKey } from './extension-id.js';

// The Codex extension's manifest `key` and its KNOWN published id give us a
// real fixture: deriving the id from this key must yield this exact string.
// (Verified against Chrome's published Codex extension id.)
const CODEX_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAr5M/DZ28sAuOnk9v8C2IPTLNEZ0F0pv9qwRzMAbGbE0NB6I6T+wS6Na2n0sbQOK98iezN2FX26dsBWMELXtf4YCETdRiFSBOnNhZObZdrxeTTrhk1AhKA/Id5vgDWfSZ3Q+9BjBWHYK9yuTGo3PMK/yOW/CH6cSn07btvn7Aq+t+KrAwGOJewCN7gGojOrshJs/YwdxwxpUnb7s6QbFGkPKg9G6as4y4ipQ8fiQHRAcKm+mUK/CoCVSL+c4Yog0CSJqEEaruOeh8CgM4V0LX4kw5rs/4THAvTwtYRsW0n3faVR7uGj1eadsWuKciQHxpRMI9I4EE7yuaxavv3Agf6QIDAQAB';

describe('computeExtensionId', () => {
  it('maps each hex nibble of the first 16 SHA-256 bytes to a..p', () => {
    // Hand-computed reference: a 32-byte buffer of all zeros -> SHA-256 of
    // those zero bytes, first 16 bytes mapped. We assert the format instead
    // of a magic value by checking length + alphabet membership.
    const id = computeExtensionId(Buffer.alloc(32, 0));
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[a-p]{32}$/);
  });

  it('is deterministic for the same input', () => {
    const buf = Buffer.from('hello world for hashing', 'utf8');
    expect(computeExtensionId(buf)).toBe(computeExtensionId(buf));
  });

  it('changes when the input changes', () => {
    expect(computeExtensionId(Buffer.from('a'))).not.toBe(
      computeExtensionId(Buffer.from('b')),
    );
  });
});

describe('idFromManifestKey', () => {
  it('derives a 32-char a..p id from a base64 DER public key', () => {
    const id = idFromManifestKey(CODEX_KEY);
    expect(id).toMatch(/^[a-p]{32}$/);
  });

  it('is stable across calls (pinned id)', () => {
    expect(idFromManifestKey(CODEX_KEY)).toBe(idFromManifestKey(CODEX_KEY));
  });

  it('throws on an empty key', () => {
    expect(() => idFromManifestKey('')).toThrow(/key/i);
  });
});
```

- [ ] **Step 2: Run the test, expect FAIL** (module does not exist yet).

```bash
cd /Users/ming/Documents/code/ai/claude-ext && npx vitest run scripts/lib/extension-id.test.ts
```

Expect: failure — `Cannot find module './extension-id.js'`.

- [ ] **Step 3: Write the minimal implementation with complete code.** Create `/Users/ming/Documents/code/ai/claude-ext/scripts/lib/extension-id.ts`:

```ts
import { createHash } from 'node:crypto';

/**
 * Map the first 16 bytes of a SHA-256 digest to Chrome's extension-id
 * alphabet. Chrome takes the hex of the first 16 digest bytes and replaces
 * each hex digit 0..f with the letters a..p. Result is always 32 chars.
 */
export function computeExtensionId(publicKeyDer: Buffer): string {
  const digest = createHash('sha256').update(publicKeyDer).digest();
  const first16 = digest.subarray(0, 16);
  let id = '';
  for (const byte of first16) {
    // Each byte -> two hex nibbles -> two a..p letters.
    const hi = byte >> 4;
    const lo = byte & 0x0f;
    id += String.fromCharCode(97 + hi);
    id += String.fromCharCode(97 + lo);
  }
  return id;
}

/**
 * Derive the pinned extension id from a manifest `key` field. The `key` is a
 * base64-encoded DER SubjectPublicKeyInfo; Chrome hashes those raw DER bytes.
 */
export function idFromManifestKey(manifestKey: string): string {
  if (!manifestKey || manifestKey.trim().length === 0) {
    throw new Error('manifest key is empty: cannot derive extension id');
  }
  const der = Buffer.from(manifestKey, 'base64');
  if (der.length === 0) {
    throw new Error('manifest key did not base64-decode to any bytes');
  }
  return computeExtensionId(der);
}
```

- [ ] **Step 4: Run the test, expect PASS.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && npx vitest run scripts/lib/extension-id.test.ts
```

Expect: all 6 assertions pass.

- [ ] **Step 5: Commit.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && git add scripts/lib/extension-id.ts scripts/lib/extension-id.test.ts && git commit -m "feat(scripts): pinned chrome extension-id derivation from manifest key"
```

---

### Task 40: Manifest-key reader (resolve the pinned id from the built extension, TDD)

**Files**
- Create: `/Users/ming/Documents/code/ai/claude-ext/scripts/lib/manifest.ts`
- Test: `/Users/ming/Documents/code/ai/claude-ext/scripts/lib/manifest.test.ts`

The installer must read the `key` from the built extension manifest at `packages/extension/dist/manifest.json` (esbuild copies it there) and turn it into the pinned id. It must give a clear error if the extension has not been built yet. This is pure I/O over a file path, so we TDD it against a temp manifest.

- [ ] **Step 1: Write the failing test with complete code.** Create `/Users/ming/Documents/code/ai/claude-ext/scripts/lib/manifest.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPinnedExtensionId } from './manifest.js';
import { idFromManifestKey } from './extension-id.js';

const CODEX_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAr5M/DZ28sAuOnk9v8C2IPTLNEZ0F0pv9qwRzMAbGbE0NB6I6T+wS6Na2n0sbQOK98iezN2FX26dsBWMELXtf4YCETdRiFSBOnNhZObZdrxeTTrhk1AhKA/Id5vgDWfSZ3Q+9BjBWHYK9yuTGo3PMK/yOW/CH6cSn07btvn7Aq+t+KrAwGOJewCN7gGojOrshJs/YwdxwxpUnb7s6QbFGkPKg9G6as4y4ipQ8fiQHRAcKm+mUK/CoCVSL+c4Yog0CSJqEEaruOeh8CgM4V0LX4kw5rs/4THAvTwtYRsW0n3faVR7uGj1eadsWuKciQHxpRMI9I4EE7yuaxavv3Agf6QIDAQAB';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cb-manifest-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readPinnedExtensionId', () => {
  it('reads the key from a dist manifest and derives the id', async () => {
    const distDir = join(dir, 'dist');
    await mkdir(distDir, { recursive: true });
    await writeFile(
      join(distDir, 'manifest.json'),
      JSON.stringify({ manifest_version: 3, name: 'x', key: CODEX_KEY }),
      'utf8',
    );
    const id = await readPinnedExtensionId(distDir);
    expect(id).toBe(idFromManifestKey(CODEX_KEY));
  });

  it('throws a build-hint error when manifest.json is missing', async () => {
    await expect(readPinnedExtensionId(join(dir, 'nope'))).rejects.toThrow(
      /build the extension/i,
    );
  });

  it('throws when the manifest has no key field', async () => {
    const distDir = join(dir, 'dist');
    await mkdir(distDir, { recursive: true });
    await writeFile(
      join(distDir, 'manifest.json'),
      JSON.stringify({ manifest_version: 3, name: 'x' }),
      'utf8',
    );
    await expect(readPinnedExtensionId(distDir)).rejects.toThrow(/key/i);
  });
});
```

- [ ] **Step 2: Run the test, expect FAIL.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && npx vitest run scripts/lib/manifest.test.ts
```

Expect: failure — `Cannot find module './manifest.js'`.

- [ ] **Step 3: Write the minimal implementation with complete code.** Create `/Users/ming/Documents/code/ai/claude-ext/scripts/lib/manifest.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { idFromManifestKey } from './extension-id.js';

interface PartialManifest {
  key?: string;
}

/**
 * Read packages/extension/dist/manifest.json and derive the pinned extension
 * id from its `key`. Throws an actionable error if the extension has not been
 * built or the manifest lacks a pinning key.
 */
export async function readPinnedExtensionId(distDir: string): Promise<string> {
  const manifestPath = join(distDir, 'manifest.json');
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    throw new Error(
      `Extension manifest not found at ${manifestPath}. Build the extension first ` +
        `(npm run build -w @claude-browser/extension).`,
    );
  }
  const manifest = JSON.parse(raw) as PartialManifest;
  if (!manifest.key) {
    throw new Error(
      `Extension manifest at ${manifestPath} has no "key" field; the id cannot be pinned.`,
    );
  }
  return idFromManifestKey(manifest.key);
}
```

- [ ] **Step 4: Run the test, expect PASS.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && npx vitest run scripts/lib/manifest.test.ts
```

Expect: all 3 assertions pass.

- [ ] **Step 5: Commit.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && git add scripts/lib/manifest.ts scripts/lib/manifest.test.ts && git commit -m "feat(scripts): read pinned extension id from built dist manifest"
```

---

### Task 41: Path resolution + paths used by installer/harness (pure, TDD)

**Files**
- Create: `/Users/ming/Documents/code/ai/claude-ext/scripts/lib/paths.ts`
- Test: `/Users/ming/Documents/code/ai/claude-ext/scripts/lib/paths.test.ts`

A single source of truth for every absolute path the installer, uninstaller and harness touch: the repo root, the four package dist dirs, the config file (`~/.claude-browser/config.json` per `CONFIG_DIR`/`CONFIG_FILE`), and the LaunchAgents plist path. Centralizing this avoids drift. We TDD the derivations that are computed from a given repo root and a given home dir (injected for testability).

- [ ] **Step 1: Write the failing test with complete code.** Create `/Users/ming/Documents/code/ai/claude-ext/scripts/lib/paths.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolvePaths, LAUNCHD_LABEL } from './paths.js';
import { CONFIG_DIR, CONFIG_FILE } from '@claude-browser/shared';

describe('resolvePaths', () => {
  const p = resolvePaths('/repo', '/home/u');

  it('points config at ~/.claude-browser/config.json using the contract names', () => {
    expect(p.configDir).toBe(`/home/u/${CONFIG_DIR}`);
    expect(p.configFile).toBe(`/home/u/${CONFIG_DIR}/${CONFIG_FILE}`);
  });

  it('locates each package dist directory under the repo root', () => {
    expect(p.extensionDist).toBe('/repo/packages/extension/dist');
    expect(p.brokerDist).toBe('/repo/packages/broker/dist');
    expect(p.mcpServerEntry).toBe('/repo/packages/mcp-server/dist/index.js');
    expect(p.brokerEntry).toBe('/repo/packages/broker/dist/index.js');
  });

  it('places the launchd plist in ~/Library/LaunchAgents with the broker label', () => {
    expect(LAUNCHD_LABEL).toBe('com.claude-browser.broker');
    expect(p.plistPath).toBe(
      `/home/u/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`,
    );
  });
});
```

- [ ] **Step 2: Run the test, expect FAIL.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && npx vitest run scripts/lib/paths.test.ts
```

Expect: failure — `Cannot find module './paths.js'`.

- [ ] **Step 3: Write the minimal implementation with complete code.** Create `/Users/ming/Documents/code/ai/claude-ext/scripts/lib/paths.ts`:

```ts
import { join } from 'node:path';
import { CONFIG_DIR, CONFIG_FILE } from '@claude-browser/shared';

/** Matches the Label in broker/src/launchd.ts. */
export const LAUNCHD_LABEL = 'com.claude-browser.broker';

export interface ResolvedPaths {
  repoRoot: string;
  home: string;
  configDir: string;
  configFile: string;
  extensionDist: string;
  brokerDist: string;
  brokerEntry: string;
  mcpServerEntry: string;
  plistPath: string;
}

/**
 * Compute every absolute path the installer/uninstaller/harness needs from a
 * repo root and a home dir (both injected so this is unit-testable).
 */
export function resolvePaths(repoRoot: string, home: string): ResolvedPaths {
  const configDir = join(home, CONFIG_DIR);
  return {
    repoRoot,
    home,
    configDir,
    configFile: join(configDir, CONFIG_FILE),
    extensionDist: join(repoRoot, 'packages', 'extension', 'dist'),
    brokerDist: join(repoRoot, 'packages', 'broker', 'dist'),
    brokerEntry: join(repoRoot, 'packages', 'broker', 'dist', 'index.js'),
    mcpServerEntry: join(repoRoot, 'packages', 'mcp-server', 'dist', 'index.js'),
    plistPath: join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`),
  };
}
```

- [ ] **Step 4: Run the test, expect PASS.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && npx vitest run scripts/lib/paths.test.ts
```

Expect: all 3 assertions pass.

- [ ] **Step 5: Commit.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && git add scripts/lib/paths.ts scripts/lib/paths.test.ts && git commit -m "feat(scripts): centralized absolute path resolution"
```

---

### Task 42: Config ensure/merge helper for the installer (TDD)

**Files**
- Create: `/Users/ming/Documents/code/ai/claude-ext/scripts/lib/ensure-config.ts`
- Test: `/Users/ming/Documents/code/ai/claude-ext/scripts/lib/ensure-config.test.ts`

The installer must ensure `~/.claude-browser/config.json` exists with `{port, token, extensionId}` (the `Config` type from the contract). Behavior: if no config exists, generate a token via `crypto.randomBytes(32).toString('hex')`, use `DEFAULT_PORT`, and pin the supplied `extensionId`; if a config already exists, **preserve the existing token and port** (so re-running install never breaks live agents) but always refresh the `extensionId` to match the currently built extension. This reuses the broker's `config.ts` writer where possible but the *merge policy* lives in the installer, so we TDD it directly against a temp dir.

- [ ] **Step 1: Write the failing test with complete code.** Create `/Users/ming/Documents/code/ai/claude-ext/scripts/lib/ensure-config.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureConfig } from './ensure-config.js';
import { DEFAULT_PORT, type Config } from '@claude-browser/shared';

let dir: string;
let configFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cb-cfg-'));
  configFile = join(dir, '.claude-browser', 'config.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function read(): Promise<Config> {
  return JSON.parse(await readFile(configFile, 'utf8')) as Config;
}

describe('ensureConfig', () => {
  it('creates a fresh config with default port, a hex token and the pinned id', async () => {
    const result = await ensureConfig(configFile, 'abcdefghijklmnopabcdefghijklmnop');
    expect(result.created).toBe(true);
    const cfg = await read();
    expect(cfg.port).toBe(DEFAULT_PORT);
    expect(cfg.extensionId).toBe('abcdefghijklmnopabcdefghijklmnop');
    expect(cfg.token).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes as hex
  });

  it('preserves existing token and port but refreshes extensionId', async () => {
    await mkdir(join(dir, '.claude-browser'), { recursive: true });
    const existing: Config = { port: 9999, token: 'deadbeef'.repeat(8), extensionId: 'oldoldoldoldoldoldoldoldoldoldol' };
    await writeFile(configFile, JSON.stringify(existing), 'utf8');

    const result = await ensureConfig(configFile, 'newnewnewnewnewnewnewnewnewnewne');
    expect(result.created).toBe(false);
    const cfg = await read();
    expect(cfg.port).toBe(9999);
    expect(cfg.token).toBe('deadbeef'.repeat(8));
    expect(cfg.extensionId).toBe('newnewnewnewnewnewnewnewnewnewne');
  });

  it('writes config with 0600 permissions (user-only readable)', async () => {
    await ensureConfig(configFile, 'abcdefghijklmnopabcdefghijklmnop');
    const { stat } = await import('node:fs/promises');
    const mode = (await stat(configFile)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
```

- [ ] **Step 2: Run the test, expect FAIL.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && npx vitest run scripts/lib/ensure-config.test.ts
```

Expect: failure — `Cannot find module './ensure-config.js'`.

- [ ] **Step 3: Write the minimal implementation with complete code.** Create `/Users/ming/Documents/code/ai/claude-ext/scripts/lib/ensure-config.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DEFAULT_PORT, type Config } from '@claude-browser/shared';

export interface EnsureConfigResult {
  created: boolean;
  config: Config;
}

/**
 * Ensure the config file exists with {port, token, extensionId}. Fresh installs
 * get DEFAULT_PORT and a freshly generated 32-byte hex token. Re-installs keep
 * the existing token+port (so running agents keep authenticating) but always
 * refresh the pinned extensionId to match the currently built extension.
 * Written 0600 so only the user's processes can read the token (spec §9).
 */
export async function ensureConfig(
  configFile: string,
  extensionId: string,
): Promise<EnsureConfigResult> {
  let existing: Partial<Config> | undefined;
  try {
    existing = JSON.parse(await readFile(configFile, 'utf8')) as Partial<Config>;
  } catch {
    existing = undefined;
  }

  const created = existing === undefined;
  const config: Config = {
    port: existing?.port ?? DEFAULT_PORT,
    token: existing?.token ?? randomBytes(32).toString('hex'),
    extensionId,
  };

  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(configFile, JSON.stringify(config, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });

  return { created, config };
}
```

- [ ] **Step 4: Run the test, expect PASS.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && npx vitest run scripts/lib/ensure-config.test.ts
```

Expect: all 3 assertions pass.

- [ ] **Step 5: Commit.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && git add scripts/lib/ensure-config.ts scripts/lib/ensure-config.test.ts && git commit -m "feat(scripts): config ensure/merge policy (preserve token, refresh id)"
```

---

### Task 43: Process-runner wrapper (thin, testable shell-out, TDD)

**Files**
- Create: `/Users/ming/Documents/code/ai/claude-ext/scripts/lib/run.ts`
- Test: `/Users/ming/Documents/code/ai/claude-ext/scripts/lib/run.test.ts`

The installer shells out to `npm`, `launchctl` and `claude`. We wrap `execFile` in a promise that captures stdout/stderr and, for the installer's purposes, supports a "non-fatal" mode (e.g. `claude mcp remove` when no entry exists should not abort an uninstall). Keeping this in one tested helper means the install/uninstall scripts stay declarative. We TDD against real, side-effect-free commands (`node -e`).

- [ ] **Step 1: Write the failing test with complete code.** Create `/Users/ming/Documents/code/ai/claude-ext/scripts/lib/run.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { run } from './run.js';

describe('run', () => {
  it('resolves with stdout on success', async () => {
    const res = await run('node', ['-e', 'process.stdout.write("hi")']);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('hi');
  });

  it('rejects on a non-zero exit by default', async () => {
    await expect(run('node', ['-e', 'process.exit(3)'])).rejects.toThrow(/exited with code 3/);
  });

  it('does not reject when allowFailure is set, returning the code', async () => {
    const res = await run('node', ['-e', 'process.exit(3)'], { allowFailure: true });
    expect(res.code).toBe(3);
  });

  it('rejects with a clear error when the binary is missing', async () => {
    await expect(run('definitely-not-a-real-binary-xyz', [])).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test, expect FAIL.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && npx vitest run scripts/lib/run.test.ts
```

Expect: failure — `Cannot find module './run.js'`.

- [ ] **Step 3: Write the minimal implementation with complete code.** Create `/Users/ming/Documents/code/ai/claude-ext/scripts/lib/run.ts`:

```ts
import { execFile } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  /** When true, a non-zero exit resolves (with the code) instead of rejecting. */
  allowFailure?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Promise wrapper over execFile that captures output and respects allowFailure. */
export function run(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: opts.cwd, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code =
        err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
          ? ((err as unknown as { code: number }).code)
          : err
            ? 1
            : 0;
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(`Command not found: ${cmd}`));
        return;
      }
      const result: RunResult = { code, stdout: stdout ?? '', stderr: stderr ?? '' };
      if (err && !opts.allowFailure) {
        reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(result);
    });
  });
}
```

Note: `execFile`'s `err.code` is the numeric exit status when the process ran but exited non-zero, and the string `'ENOENT'` when the binary is missing — the implementation distinguishes both.

- [ ] **Step 4: Run the test, expect PASS.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && npx vitest run scripts/lib/run.test.ts
```

Expect: all 4 assertions pass.

- [ ] **Step 5: Commit.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && git add scripts/lib/run.ts scripts/lib/run.test.ts && git commit -m "feat(scripts): tested execFile wrapper with allowFailure"
```

---

### Task 44: `scripts/install.ts` — the one-command installer

**Files**
- Create: `/Users/ming/Documents/code/ai/claude-ext/scripts/install.ts`

This is the orchestration entry point. It composes the tested helpers (Tasks 2–6) plus the broker's `renderLaunchdPlist` from `@claude-browser/broker`. It is the top-level effectful script, so it is exercised by the integration suite rather than a unit test (mocking `launchctl`/`claude`/Chrome would test the mocks, not the install). It must, in order:

1. Resolve paths (`resolvePaths(repoRoot, os.homedir())`).
2. Build all packages (`npm run build` at repo root) so `dist/` exists.
3. Derive the pinned extension id from `packages/extension/dist/manifest.json` (`readPinnedExtensionId`).
4. Ensure `~/.claude-browser/config.json` (`ensureConfig`, refreshing the id).
5. Render the launchd plist (broker `renderLaunchdPlist`) to `~/Library/LaunchAgents/com.claude-browser.broker.plist`; `launchctl unload` any prior, then `launchctl load`.
6. Register the MCP server: `claude mcp add claude-browser -- node <abs mcp dist/index.js>`.
7. Print clear "load unpacked extension" instructions and the expected id to confirm.

The broker's `renderLaunchdPlist` is assumed to accept the config the broker needs to launch (node binary + broker entry path); the installer passes the resolved `brokerEntry` and the current `process.execPath` so the plist's `ProgramArguments` are absolute.

- [ ] **Step 1: Write the complete `scripts/install.ts`.** Create `/Users/ming/Documents/code/ai/claude-ext/scripts/install.ts`:

```ts
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { resolvePaths } from './lib/paths.js';
import { readPinnedExtensionId } from './lib/manifest.js';
import { ensureConfig } from './lib/ensure-config.js';
import { run } from './lib/run.js';
import { renderLaunchdPlist } from '@claude-browser/broker';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');

function log(msg: string): void {
  process.stdout.write(`[install] ${msg}\n`);
}

async function main(): Promise<void> {
  const paths = resolvePaths(REPO_ROOT, homedir());

  log('Building all packages...');
  await run('npm', ['run', 'build'], { cwd: REPO_ROOT });

  log('Deriving pinned extension id from built manifest...');
  const extensionId = await readPinnedExtensionId(paths.extensionDist);
  log(`Pinned extension id: ${extensionId}`);

  log(`Ensuring config at ${paths.configFile}...`);
  const { created, config } = await ensureConfig(paths.configFile, extensionId);
  log(created ? `Created new config (port ${config.port}).` : `Updated existing config (port ${config.port}, token preserved).`);

  log('Rendering launchd plist...');
  const plist = renderLaunchdPlist({
    nodePath: process.execPath,
    brokerEntry: paths.brokerEntry,
    workingDirectory: REPO_ROOT,
  });
  await writeFile(paths.plistPath, plist, 'utf8');
  log(`Wrote ${paths.plistPath}`);

  // Unload any previous instance (ignore failure on first install), then load.
  await run('launchctl', ['unload', paths.plistPath], { allowFailure: true });
  await run('launchctl', ['load', paths.plistPath]);
  log('Broker launchd agent loaded (KeepAlive, RunAtLoad).');

  log('Registering MCP server with Claude Code...');
  // Remove any stale registration first so re-installs are idempotent.
  await run('claude', ['mcp', 'remove', 'claude-browser'], { allowFailure: true });
  await run('claude', ['mcp', 'add', 'claude-browser', '--', 'node', paths.mcpServerEntry]);
  log('Registered "claude-browser" MCP server.');

  process.stdout.write(
    [
      '',
      '============================================================',
      ' Almost done — load the Chrome extension (one-time, manual):',
      '============================================================',
      ' 1. Open chrome://extensions',
      ' 2. Enable "Developer mode" (top-right toggle)',
      ' 3. Click "Load unpacked" and select:',
      `      ${paths.extensionDist}`,
      ' 4. Confirm the loaded extension ID equals:',
      `      ${extensionId}`,
      '    (If it differs, the broker will reject it — rebuild the',
      '     extension and re-run install.)',
      '',
      ' The broker is now running and will stay up across reboots.',
      ' Start a new Claude Code session to use the browser_* tools.',
      '============================================================',
      '',
    ].join('\n'),
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`[install] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Type-check the script compiles against the workspace** (no runtime side effects here — it shells out to `launchctl`/`claude`, validated by the integration suite). Run:

```bash
cd /Users/ming/Documents/code/ai/claude-ext && npx tsc --noEmit -p scripts/tsconfig.json 2>/dev/null || npx tsc --noEmit --module esnext --moduleResolution bundler --target es2022 --strict scripts/install.ts
```

Expect: no type errors (the `renderLaunchdPlist` import resolves from `@claude-browser/broker`; if its signature differs from `{nodePath, brokerEntry, workingDirectory}`, adjust the call to match the broker package's exported type — see Assumptions).

- [ ] **Step 3: Commit.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && git add scripts/install.ts && git commit -m "feat(scripts): one-command macOS installer (build, config, launchd, mcp add)"
```

---

### Task 45: `scripts/uninstall.ts` — full teardown

**Files**
- Create: `/Users/ming/Documents/code/ai/claude-ext/scripts/uninstall.ts`

Reverse of install: `launchctl unload` the plist and remove it, `claude mcp remove claude-browser`, and optionally remove the config dir when `--purge` is passed (default keeps the token so a later re-install is seamless). Every step is `allowFailure: true` so a partial prior state still fully tears down. It prints a reminder to remove the unpacked extension from `chrome://extensions` manually (Chrome offers no CLI for that).

- [ ] **Step 1: Write the complete `scripts/uninstall.ts`.** Create `/Users/ming/Documents/code/ai/claude-ext/scripts/uninstall.ts`:

```ts
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import { resolvePaths } from './lib/paths.js';
import { run } from './lib/run.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');

function log(msg: string): void {
  process.stdout.write(`[uninstall] ${msg}\n`);
}

async function main(): Promise<void> {
  const paths = resolvePaths(REPO_ROOT, homedir());
  const purge = process.argv.includes('--purge');

  log('Unloading broker launchd agent...');
  await run('launchctl', ['unload', paths.plistPath], { allowFailure: true });
  await rm(paths.plistPath, { force: true });
  log(`Removed ${paths.plistPath}`);

  log('Removing MCP server registration...');
  await run('claude', ['mcp', 'remove', 'claude-browser'], { allowFailure: true });

  if (purge) {
    log(`Purging config dir ${paths.configDir} (--purge)...`);
    await rm(paths.configDir, { recursive: true, force: true });
  } else {
    log(`Keeping config at ${paths.configFile} (pass --purge to delete the token).`);
  }

  process.stdout.write(
    [
      '',
      ' Uninstall complete. To finish, manually remove the unpacked',
      ' extension at chrome://extensions (Chrome has no CLI for this).',
      '',
    ].join('\n'),
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`[uninstall] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Type-check it compiles.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && npx tsc --noEmit --module esnext --moduleResolution bundler --target es2022 --strict scripts/uninstall.ts scripts/lib/paths.ts scripts/lib/run.ts
```

Expect: no type errors.

- [ ] **Step 3: Commit.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && git add scripts/uninstall.ts && git commit -m "feat(scripts): uninstall (launchctl unload, plist+mcp remove, optional purge)"
```

---

### Task 46: A local HTTP fixture server for the e2e scenario (TDD)

**Files**
- Create: `/Users/ming/Documents/code/ai/claude-ext/test/integration/fixture-server.ts`
- Test: `/Users/ming/Documents/code/ai/claude-ext/test/integration/fixture-server.test.ts`

The e2e scenario navigates to a real page with a button, an input and a `console.log`. Rather than a brittle `data:` URL, we serve a tiny HTML fixture over `http.createServer` on an ephemeral port. This piece is pure node (no Chrome), so it gets a real unit test that lives alongside the integration suite but does not need the `RUN_BROWSER_TESTS` gate — it is hermetic. (It is matched by the integration vitest config's `include` glob, but it never launches Chrome, so it always runs.)

- [ ] **Step 1: Write the failing test with complete code.** Create `/Users/ming/Documents/code/ai/claude-ext/test/integration/fixture-server.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';

let server: FixtureServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('startFixtureServer', () => {
  it('serves the fixture HTML on an ephemeral port', async () => {
    server = await startFixtureServer();
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    const res = await fetch(server.url);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(body).toContain('id="go"'); // the button the e2e clicks
    expect(body).toContain('id="name"'); // the input the e2e types into
    expect(body).toContain('CB_FIXTURE_LOADED'); // the console.log the e2e reads
  });
});
```

- [ ] **Step 2: Run the test, expect FAIL.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && npx vitest run --config vitest.integration.config.ts test/integration/fixture-server.test.ts
```

Expect: failure — `Cannot find module './fixture-server.js'`.

- [ ] **Step 3: Write the minimal implementation with complete code.** Create `/Users/ming/Documents/code/ai/claude-ext/test/integration/fixture-server.ts`:

```ts
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

const FIXTURE_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>CB Fixture</title></head>
  <body>
    <h1 id="heading">Claude Browser Fixture</h1>
    <button id="go">Go</button>
    <input id="name" type="text" aria-label="Name" />
    <p id="result">idle</p>
    <script>
      console.log('CB_FIXTURE_LOADED');
      document.getElementById('go').addEventListener('click', function () {
        document.getElementById('result').textContent = 'clicked';
        console.log('CB_BUTTON_CLICKED');
      });
    </script>
  </body>
</html>`;

export interface FixtureServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Start a one-route HTTP server that serves the e2e fixture page. */
export function startFixtureServer(): Promise<FixtureServer> {
  return new Promise((resolveServer, rejectServer) => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    server.on('error', rejectServer);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolveServer({
        url: `http://127.0.0.1:${port}/`,
        port,
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res())),
          ),
      });
    });
  });
}
```

- [ ] **Step 4: Run the test, expect PASS.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && npx vitest run --config vitest.integration.config.ts test/integration/fixture-server.test.ts
```

Expect: the assertions pass (fetch returns the fixture HTML).

- [ ] **Step 5: Commit.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && git add test/integration/fixture-server.ts test/integration/fixture-server.test.ts && git commit -m "test(integration): local HTTP fixture server for e2e scenario"
```

---

### Task 47: `test/integration/harness.ts` — Chrome + broker + MCP client wiring

**Files**
- Create: `/Users/ming/Documents/code/ai/claude-ext/test/integration/harness.ts`

The harness is the shared setup for both e2e and soak tests. It is effectful (launches Chrome, opens sockets) and is validated by the tests that consume it rather than its own unit test. It must:

- Be a no-op-able module: export a `shouldRunBrowserTests()` guard reading `RUN_BROWSER_TESTS`.
- Write a temp config (`{port, token, extensionId}`) where `extensionId` is derived from the built extension's manifest via `readPinnedExtensionId`, on an **ephemeral** port.
- Start the broker **in-process** (importing `startServer`/`createServer` from `@claude-browser/broker`) bound to `127.0.0.1` on that ephemeral port with that temp config.
- Launch Chrome via `chrome-launcher` with `--load-extension=<extensionDist>`, a temp `--user-data-dir`, `--no-first-run`, `--no-default-browser-check`, and (so MV3 service workers and `chrome.debugger` behave headlessly) `--headless=new` is **avoided** — we use a headful instance because `chrome.debugger` + extension service workers are unreliable headless; instead pass `--disable-gpu` and run with a real (visible) window. Document this in a comment.
- Build the MCP-layer **agent client** by importing the broker client from `@claude-browser/mcp-server` (`createClient`) pointed at `ws://127.0.0.1:<port>` with the temp token, OR — to exercise the real tool surface — construct the `McpServer` tool registrations and call them. The harness exposes a `callTool(name, args)` helper that drives the actual registered tool handlers, so e2e asserts on real tool output (screenshots, snapshots).
- Expose `teardown()` that closes the MCP client, stops the broker, kills Chrome, removes temp dirs.
- Expose **soak hooks**: `forceExtensionOffline()` (drop the broker's browser-side socket to simulate SW death) and `restartMcpClient()` (tear down + recreate just the agent client, leaving the broker and Chrome alive — exactly the per-session restart the stability contract targets).

- [ ] **Step 1: Write the complete `test/integration/harness.ts`.** Create `/Users/ming/Documents/code/ai/claude-ext/test/integration/harness.ts`:

```ts
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, type LaunchedChrome } from 'chrome-launcher';
import { resolvePaths } from '../../scripts/lib/paths.js';
import { readPinnedExtensionId } from '../../scripts/lib/manifest.js';
import { type Config } from '@claude-browser/shared';
// Broker exposes an in-process server factory; client + tool registration come
// from the mcp-server package. These are the public entry points each package
// builds (see Assumptions for exact signatures the synthesizer must align to).
import { createServer as createBroker, type BrokerServer } from '@claude-browser/broker';
import { createClient, registerTools, type BrokerClient } from '@claude-browser/mcp-server';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..', '..');

/** Tests call this first; when false the whole spec turns into a skip. */
export function shouldRunBrowserTests(): boolean {
  return process.env.RUN_BROWSER_TESTS === '1';
}

export interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

export interface Harness {
  config: Config;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** Drop the broker's browser-side socket to simulate service-worker death. */
  forceExtensionOffline(): void;
  /** Recreate only the agent (MCP) client; broker + Chrome stay alive. */
  restartMcpClient(): Promise<void>;
  teardown(): Promise<void>;
}

interface Internal {
  tmpRoot: string;
  userDataDir: string;
  chrome: LaunchedChrome;
  broker: BrokerServer;
  client: BrokerClient;
  tools: Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>;
}

async function ephemeralPort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as import('node:net').AddressInfo).port;
      srv.close(() => res(port));
    });
  });
}

export async function startHarness(): Promise<Harness> {
  const paths = resolvePaths(REPO_ROOT, tmpdir());
  const tmpRoot = await mkdtemp(join(tmpdir(), 'cb-harness-'));
  const userDataDir = join(tmpRoot, 'chrome-profile');
  await mkdir(userDataDir, { recursive: true });

  const port = await ephemeralPort();
  const extensionId = await readPinnedExtensionId(paths.extensionDist);
  const token = 'integration-test-token-0000000000000000000000000000000000000000';
  const config: Config = { port, token, extensionId };

  // Write a temp config the broker reads; broker binds 127.0.0.1:<port>.
  const tmpConfigDir = join(tmpRoot, '.claude-browser');
  await mkdir(tmpConfigDir, { recursive: true });
  await writeFile(join(tmpConfigDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');

  const broker = await createBroker(config);

  // Headful Chrome: chrome.debugger + MV3 service workers are unreliable in
  // headless mode, so we launch a real window (CI must allow a display, e.g.
  // via Xvfb on Linux; on macOS dev machines this just opens a window).
  const chrome = await launch({
    chromeFlags: [
      `--load-extension=${paths.extensionDist}`,
      `--disable-extensions-except=${paths.extensionDist}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-background-timer-throttling',
    ],
    userDataDir,
    ignoreDefaultFlags: false,
  });

  // Build the agent client + register the real browser_* tools against it so
  // tests drive the actual tool handlers.
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>();
  let client = await createClient({ port, token });
  registerInto(tools, client);

  // Wait until the extension has connected to the broker (status -> connected),
  // up to 15s, otherwise tool calls will all error with EXTENSION_DISCONNECTED.
  await waitForExtension(broker, 15_000);

  const internal: Internal = { tmpRoot, userDataDir, chrome, broker, client, tools };

  return {
    config,
    async callTool(name, args) {
      const fn = internal.tools.get(name);
      if (!fn) throw new Error(`tool not registered: ${name}`);
      return fn(args);
    },
    forceExtensionOffline() {
      // Public broker test hook: forcibly close the single browser-side socket.
      internal.broker.dropBrowserConnection();
    },
    async restartMcpClient() {
      await internal.client.close();
      internal.tools.clear();
      internal.client = await createClient({ port, token });
      registerInto(internal.tools, internal.client);
    },
    async teardown() {
      try {
        await internal.client.close();
      } catch {
        /* ignore */
      }
      await internal.broker.close();
      await internal.chrome.kill();
      await rm(internal.tmpRoot, { recursive: true, force: true });
    },
  };
}

/** Register the real browser_* tool handlers, capturing each into a map we can call. */
function registerInto(
  tools: Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>,
  client: BrokerClient,
): void {
  // registerTools accepts a minimal MCP-server-like sink so we can capture the
  // handlers without a full StdioServerTransport. Each captured handler returns
  // the same {content,isError} shape the MCP SDK uses.
  registerTools(
    {
      tool(
        name: string,
        _schema: unknown,
        handler: (args: Record<string, unknown>) => Promise<ToolResult>,
      ) {
        tools.set(name, handler);
      },
    },
    client,
  );
}

/** Resolve once the broker reports a connected browser side, else reject on timeout. */
function waitForExtension(broker: BrokerServer, timeoutMs: number): Promise<void> {
  return new Promise((res, rej) => {
    if (broker.hasBrowserConnection()) {
      res();
      return;
    }
    const timer = setTimeout(() => {
      broker.offBrowserConnected(onConnect);
      rej(new Error(`extension did not connect within ${timeoutMs}ms`));
    }, timeoutMs);
    const onConnect = () => {
      clearTimeout(timer);
      res();
    };
    broker.onBrowserConnected(onConnect);
  });
}
```

- [ ] **Step 2: Type-check the harness compiles against the workspace packages.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && npx tsc --noEmit --module esnext --moduleResolution bundler --target es2022 --strict --skipLibCheck test/integration/harness.ts
```

Expect: no type errors. If the broker/mcp-server export names differ (`createBroker` vs `createServer`, `dropBrowserConnection`, `onBrowserConnected`, `createClient`, `registerTools`), align to the actual exported symbols — these are the integration touch points the synthesizer must reconcile (see Assumptions). The shape (an in-process broker with a "drop the browser socket" hook + connection events, and a client factory + tool registrar) is the contract this harness needs.

- [ ] **Step 3: Commit.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && git add test/integration/harness.ts && git commit -m "test(integration): chrome-launcher + in-process broker + mcp client harness"
```

---

### Task 48: `test/integration/e2e.test.ts` — the scripted scenario

**Files**
- Create: `/Users/ming/Documents/code/ai/claude-ext/test/integration/e2e.test.ts`

The headline functional test: new tab -> navigate to the fixture -> snapshot returns refs -> click_ref the button -> type into the input -> screenshot returns non-empty base64 -> console returns the logged message. It is gated behind `RUN_BROWSER_TESTS=1`; when the flag is absent the whole describe is skipped so unit CI stays hermetic. Because this consumes the effectful harness (Task 47), there is no separate failing/passing micro-cycle — the test *is* the assertion, and we run it once to confirm green under the gate.

- [ ] **Step 1: Write the complete `test/integration/e2e.test.ts`.** Create `/Users/ming/Documents/code/ai/claude-ext/test/integration/e2e.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, shouldRunBrowserTests, type Harness } from './harness.js';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';

const maybe = shouldRunBrowserTests() ? describe : describe.skip;

maybe('e2e: navigate -> snapshot -> click_ref -> type -> screenshot -> console', () => {
  let harness: Harness;
  let fixture: FixtureServer;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    harness = await startHarness();
  }, 120_000);

  afterAll(async () => {
    await harness?.teardown();
    await fixture?.close();
  });

  it('drives a full hybrid scenario end-to-end', async () => {
    // 1. New tab (broker helper via browser_new_tab).
    const newTab = await harness.callTool('browser_new_tab', { url: 'about:blank' });
    expect(newTab.isError).toBeFalsy();

    // 2. Navigate to the local fixture (Page.navigate via ATTACH).
    const nav = await harness.callTool('browser_navigate', { url: fixture.url });
    expect(nav.isError).toBeFalsy();

    // 3. Snapshot returns an accessibility tree with stable refs.
    const snap = await harness.callTool('browser_snapshot', {});
    expect(snap.isError).toBeFalsy();
    const snapText = snap.content.map((c) => c.text ?? '').join('\n');
    // The fixture button labeled "Go" must appear with a ref token like [ref=...].
    expect(snapText).toMatch(/Go/);
    const refMatch = snapText.match(/\[ref=([^\]]+)\]/);
    expect(refMatch, `snapshot should contain a [ref=...] token:\n${snapText}`).not.toBeNull();

    // Find a ref whose line mentions the "Go" button; fall back to first ref.
    const goLine = snapText.split('\n').find((l) => /Go/.test(l) && /\[ref=/.test(l));
    const goRef = (goLine?.match(/\[ref=([^\]]+)\]/) ?? refMatch!)[1];

    // 4. Click the button by ref (DOM.getBoxModel -> Input click at center).
    const click = await harness.callTool('browser_click_ref', { ref: goRef });
    expect(click.isError).toBeFalsy();

    // 5. Type into the input. Re-snapshot to get the input's ref, then fill.
    const snap2 = await harness.callTool('browser_snapshot', {});
    const snap2Text = snap2.content.map((c) => c.text ?? '').join('\n');
    const inputLine = snap2Text.split('\n').find((l) => /Name/.test(l) && /\[ref=/.test(l));
    expect(inputLine, `expected a Name input ref:\n${snap2Text}`).toBeDefined();
    const inputRef = inputLine!.match(/\[ref=([^\]]+)\]/)![1];
    const fill = await harness.callTool('browser_fill', { ref: inputRef, value: 'Ada Lovelace' });
    expect(fill.isError).toBeFalsy();

    // Confirm the value landed via a read-back eval.
    const readBack = await harness.callTool('browser_eval', {
      expression: 'document.getElementById("name").value',
    });
    expect(readBack.content.map((c) => c.text ?? '').join('')).toContain('Ada Lovelace');

    // 6. Screenshot returns non-empty base64.
    const shot = await harness.callTool('browser_screenshot', {});
    expect(shot.isError).toBeFalsy();
    const imagePart = shot.content.find((c) => c.type === 'image' || typeof c.data === 'string');
    expect(imagePart, 'screenshot must return an image part').toBeDefined();
    const b64 = imagePart!.data ?? '';
    expect(b64.length).toBeGreaterThan(1000); // a real PNG is well over 1KB

    // 7. Console returns the message the fixture logged at load (+ on click).
    const consoleRes = await harness.callTool('browser_console', {});
    const consoleText = consoleRes.content.map((c) => c.text ?? '').join('\n');
    expect(consoleText).toContain('CB_FIXTURE_LOADED');
    expect(consoleText).toContain('CB_BUTTON_CLICKED');
  }, 90_000);
});
```

- [ ] **Step 2: Run the gated suite, expect PASS** (requires Chrome installed + a display).

```bash
cd /Users/ming/Documents/code/ai/claude-ext && npm run build && RUN_BROWSER_TESTS=1 npx vitest run --config vitest.integration.config.ts test/integration/e2e.test.ts
```

Expect: the scenario passes. (Without `RUN_BROWSER_TESTS=1` the describe is skipped — confirm by also running `npx vitest run --config vitest.integration.config.ts test/integration/e2e.test.ts` and seeing it reported as skipped.)

- [ ] **Step 3: Commit.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && git add test/integration/e2e.test.ts && git commit -m "test(integration): e2e hybrid scenario (snapshot/click_ref/type/screenshot/console)"
```

---

### Task 49: `test/integration/soak.test.ts` — the headline stability test

**Files**
- Create: `/Users/ming/Documents/code/ai/claude-ext/test/integration/soak.test.ts`

The definition-of-done for stability (spec §6, §12). After a working call, it (a) forces the extension's broker-side socket offline (simulating service-worker death) and asserts the extension's alarm/`setTimeout` reconnect discipline re-establishes within a few seconds, and (b) kills + restarts the MCP (agent) client several times in a loop, asserting tools resume working each iteration with **zero manual action**. Gated behind `RUN_BROWSER_TESTS=1`.

The reconnect timing target derives from the Codex discipline confirmed in the reference: a 5s `setTimeout` retry plus a `chrome.alarms` alarm at `periodInMinutes: 0.5` (30s) that survives worker death, with a 30s heartbeat and a 3s pong timeout. So a forced offline must self-heal well within ~35s; we assert a 30s budget.

- [ ] **Step 1: Write the complete `test/integration/soak.test.ts`.** Create `/Users/ming/Documents/code/ai/claude-ext/test/integration/soak.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, shouldRunBrowserTests, type Harness } from './harness.js';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';

const maybe = shouldRunBrowserTests() ? describe : describe.skip;

/** Poll a tool call until it succeeds (isError falsy) or the deadline passes. */
async function waitForToolToWork(
  harness: Harness,
  name: string,
  args: Record<string, unknown>,
  deadlineMs: number,
): Promise<number> {
  const start = Date.now();
  let lastErr = '';
  while (Date.now() - start < deadlineMs) {
    try {
      const res = await harness.callTool(name, args);
      if (!res.isError) return Date.now() - start;
      lastErr = res.content.map((c) => c.text ?? '').join('');
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`tool ${name} never recovered within ${deadlineMs}ms; last error: ${lastErr}`);
}

maybe('soak: auto-heal across extension offline + repeated MCP restarts', () => {
  let harness: Harness;
  let fixture: FixtureServer;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    harness = await startHarness();
    // Establish a known-good baseline: a tab navigated to the fixture.
    await harness.callTool('browser_new_tab', { url: fixture.url });
    await harness.callTool('browser_navigate', { url: fixture.url });
  }, 120_000);

  afterAll(async () => {
    await harness?.teardown();
    await fixture?.close();
  });

  it('a baseline tool call works before any disruption', async () => {
    const res = await harness.callTool('browser_get_tabs', {});
    expect(res.isError).toBeFalsy();
  }, 30_000);

  it('recovers within ~30s after the extension link is forced offline', async () => {
    // Simulate service-worker death by dropping the broker's browser-side
    // socket. The extension's scheduleReconnect (5s setTimeout + 0.5min alarm)
    // must re-establish the connection automatically.
    harness.forceExtensionOffline();

    // Immediately after the drop, a call should either error (disconnected) or
    // queue; within the budget it must succeed with zero manual action.
    const recoveredInMs = await waitForToolToWork(harness, 'browser_get_tabs', {}, 30_000);
    expect(recoveredInMs).toBeLessThan(30_000);
  }, 45_000);

  it('survives killing + restarting the MCP client repeatedly (zero manual action)', async () => {
    for (let i = 0; i < 5; i++) {
      // Kill the ephemeral per-session agent client and spin up a fresh one,
      // exactly like a new Claude Code session attaching to the warm broker.
      await harness.restartMcpClient();

      // The broker outlived the restart, so the new client must work fast.
      const recoveredInMs = await waitForToolToWork(harness, 'browser_get_tabs', {}, 15_000);
      expect(recoveredInMs, `iteration ${i} should recover quickly`).toBeLessThan(15_000);

      // And a real CDP-backed call must work too, proving the warm extension
      // link is reused (not just the broker socket).
      const nav = await harness.callTool('browser_navigate', { url: fixture.url });
      expect(nav.isError, `navigate should work after restart ${i}`).toBeFalsy();
    }
  }, 120_000);

  it('still works after combining both failure modes', async () => {
    // Worst case: drop the extension AND restart the client at the same time.
    harness.forceExtensionOffline();
    await harness.restartMcpClient();
    const recoveredInMs = await waitForToolToWork(harness, 'browser_get_tabs', {}, 30_000);
    expect(recoveredInMs).toBeLessThan(30_000);
  }, 45_000);
});
```

- [ ] **Step 2: Run the gated soak suite, expect PASS.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && npm run build && RUN_BROWSER_TESTS=1 npx vitest run --config vitest.integration.config.ts test/integration/soak.test.ts
```

Expect: all four soak assertions pass — recovery after forced offline under 30s, five MCP-restart iterations each under 15s, and the combined-failure case under 30s. (Without the env flag, the describe is skipped.)

- [ ] **Step 3: Commit.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && git add test/integration/soak.test.ts && git commit -m "test(integration): headline soak — auto-heal across SW death + MCP restarts"
```

---

### Task 50: Wire `scripts/lib` into the unit suite + final hermetic check

**Files**
- Modify: `/Users/ming/Documents/code/ai/claude-ext/vitest.config.ts`

The `scripts/lib/*.test.ts` files (Tasks 2–6) are hermetic unit tests and must run in the default `npm test`, but the current `include` glob only covers `packages/**`. Extend it to also include `scripts/lib`, while still excluding the real-Chrome integration suite. This keeps unit CI fast and hermetic while covering the installer's pure logic.

- [ ] **Step 1: Update the default vitest include glob.** Edit `/Users/ming/Documents/code/ai/claude-ext/vitest.config.ts` to:

```ts
import { defineConfig } from 'vitest/config';

// Default (hermetic) unit run: every package's own test/ dirs plus the pure
// installer helpers under scripts/lib — never the real-Chrome integration suite
// and never the integration fixture-server test (it lives under test/integration).
export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'scripts/lib/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'test/integration/**'],
  },
});
```

- [ ] **Step 2: Run the full hermetic unit suite (no Chrome), expect PASS and zero integration files touched.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && npx vitest run
```

Expect: all `scripts/lib/*` tests (extension-id, manifest, paths, ensure-config, run) pass; no `test/integration` file is collected; `RUN_BROWSER_TESTS` is unset so nothing launches Chrome.

- [ ] **Step 3: Confirm the gate truly skips integration when the flag is absent.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && npx vitest run --config vitest.integration.config.ts 2>&1 | grep -E "skipped|passed"
```

Expect: `e2e` and `soak` describes report as skipped; `fixture-server.test.ts` passes (it is hermetic).

- [ ] **Step 4: Commit.**

```bash
cd /Users/ming/Documents/code/ai/claude-ext && git add vitest.config.ts && git commit -m "test: include scripts/lib unit tests in hermetic default run"
```
