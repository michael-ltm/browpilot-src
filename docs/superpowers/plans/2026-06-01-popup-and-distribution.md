# Popup Redesign + npm Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the extension popup presentable (status, auto profile name, GitHub link, usage steps) and ship claude-browser as a no-clone, cross-platform `npx` install with the broker auto-spawned (no OS daemon).

**Architecture:** Area A touches only the extension (manifest perms + `config.ts` label resolver + popup). Area B publishes one assembled `claude-browser` npm package (MCP bin + co-located broker + bundled extension dir), makes the broker-spawn path resolve in both dev and packaged layouts, drops launchd from the default install, and adds publish + Windows-CI workflows.

**Tech Stack:** TypeScript (strict, ESM), npm workspaces, vitest, esbuild, `chrome.identity`, `@modelcontextprotocol/sdk`, `ws`, GitHub Actions, `gh` CLI.

**Build order:** A1→A4 (extension) then B5→B10 (distribution). Run from repo root `/Users/ming/Documents/code/ai/claude-ext`. Branch: `feat/popup-and-distribution`. Spec: `docs/superpowers/specs/2026-06-01-popup-and-distribution-design.md`.

**Conventions:** `npm test -w @claude-browser/<pkg>` per package; commit after each task. The claude-mem Read hook may trim the Read tool — read source via `git show`/`cat` if needed; the plan contains the full code regardless.

---

# Milestone A — Popup + profile name (extension)

### Task 1: chromeMock gains a `chrome.identity` mock

**Files:**
- Modify: `packages/extension/test/chromeMock.ts`

Pure test-infra change (no TDD steps). The mock must expose `chrome.identity.getProfileUserInfo` and a settable email so later tests can drive the label resolver.

- [ ] **Step 1: Add `identityEmail` to the `ChromeMock` interface.** Find the `interface ChromeMock { ... }` block and add this field (next to `storage`):

```ts
  /** Email returned by chrome.identity.getProfileUserInfo (''=signed out). */
  identityEmail: string;
```

- [ ] **Step 2: Initialise it on the `mock` object.** In `installChromeMock()`, in the `const mock: ChromeMock = { ... }` literal, add:

```ts
    identityEmail: '',
```

- [ ] **Step 3: Add the `identity` namespace to `chromeObj`.** Inside the `const chromeObj = { ... }` literal (e.g. right after the `history:` block), add:

```ts
    identity: {
      getProfileUserInfo: vi.fn(
        (
          detailsOrCb: unknown,
          maybeCb?: (info: { email: string; id: string }) => void,
        ) => {
          const cb = (typeof detailsOrCb === 'function' ? detailsOrCb : maybeCb) as (info: {
            email: string;
            id: string;
          }) => void;
          cb({ email: mock.identityEmail, id: mock.identityEmail ? 'gaia-test-id' : '' });
        },
      ),
    },
```

- [ ] **Step 4: Verify it compiles** — `npm run typecheck -w @claude-browser/extension` → no errors. (No test yet; exercised by Task 2.)
- [ ] **Step 5: Commit** — `git add packages/extension/test/chromeMock.ts && git commit -m "test(extension): add chrome.identity.getProfileUserInfo mock"`

---

### Task 2: `config.ts` — email-based label resolution + manifest perms

**Files:**
- Modify: `packages/extension/src/background/config.ts`
- Modify: `packages/extension/manifest.json`
- Test: `packages/extension/test/config.test.ts`

- [ ] **Step 1: Add failing tests** — append to `packages/extension/test/config.test.ts`:

```ts
import { getProfileEmailName } from '../src/background/config.js';

describe('profile name resolution', () => {
  it('getProfileEmailName returns the email local-part when signed in', async () => {
    const m = installChromeMock();
    m.identityEmail = 'user@example.com';
    expect(await getProfileEmailName()).toBe('franco');
  });

  it('getProfileEmailName returns null when signed out', async () => {
    installChromeMock(); // identityEmail = ''
    expect(await getProfileEmailName()).toBeNull();
  });

  it('getLabel prefers a custom label over the email', async () => {
    const m = installChromeMock();
    m.identityEmail = 'user@example.com';
    await chrome.storage.local.set({ claudeBrowserLabel: 'Work' });
    expect(await getLabel('abcd1234')).toBe('Work');
  });

  it('getLabel falls back to the email local-part when no custom label', async () => {
    const m = installChromeMock();
    m.identityEmail = 'user@example.com';
    expect(await getLabel('abcd1234')).toBe('franco');
  });

  it('getLabel falls back to Profile <shortId> when no custom and signed out', async () => {
    installChromeMock();
    expect(await getLabel('abcd1234')).toBe('Profile abcd');
  });
});
```
(Ensure the file imports `getLabel` and `installChromeMock` at the top; add `getLabel` to the existing import from `../src/background/config.js` if not already there.)

- [ ] **Step 2: Run, expect FAIL** — `npm test -w @claude-browser/extension -- config` → `getProfileEmailName` not exported.

- [ ] **Step 3: Edit `packages/extension/src/background/config.ts`.** Add `getProfileEmailName` and replace `getLabel`:

```ts
/** The signed-in Google account's email local-part, or null if unavailable. */
export async function getProfileEmailName(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (info) => {
        const email = info?.email ?? '';
        resolve(email ? email.split('@')[0]! || email : null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** Resolution order: explicit custom label -> Google email local-part -> Profile <shortId>. */
export async function getLabel(instanceId: string): Promise<string> {
  const got = (await chrome.storage.local.get(LABEL_KEY)) as Record<string, unknown>;
  const v = got[LABEL_KEY];
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  const email = await getProfileEmailName();
  if (email) return email;
  return `Profile ${instanceId.slice(0, 4)}`;
}
```

- [ ] **Step 4: Add the identity permissions** in `packages/extension/manifest.json` — replace the `permissions` array:

```json
  "permissions": ["debugger", "tabs", "history", "alarms", "scripting", "storage", "identity", "identity.email"],
```

- [ ] **Step 5: Run tests + typecheck, expect PASS** — `npm test -w @claude-browser/extension -- config && npm run typecheck -w @claude-browser/extension`. (`@types/chrome` provides `chrome.identity.getProfileUserInfo`.)
- [ ] **Step 6: Commit** — `git add packages/extension && git commit -m "feat(extension): resolve profile name from Google email, fall back to custom"`

---

### Task 3: Redesigned popup

**Files:**
- Modify: `packages/extension/src/popup/popup.html`
- Modify: `packages/extension/src/popup/popup.ts`
- Test: `packages/extension/test/popup.test.ts` (unchanged behavior must still pass)

`statusDisplay()` and `applyLabelInput()` keep their signatures (existing tests pass unchanged). Only `render()` and the markup change.

- [ ] **Step 1: Replace `packages/extension/src/popup/popup.html` entirely with:**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>claude-browser</title>
    <style>
      :root { color-scheme: light; }
      body {
        font: 13px/1.45 -apple-system, system-ui, "Segoe UI", sans-serif;
        margin: 0; width: 300px; color: #1f2937; background: #fff;
      }
      header {
        display: flex; align-items: center; gap: 8px;
        padding: 12px 14px; border-bottom: 1px solid #f0f0f2;
      }
      header img { width: 22px; height: 22px; border-radius: 5px; }
      header .name { font-weight: 600; font-size: 14px; }
      header .ver { margin-left: auto; color: #9ca3af; font-size: 11px; }
      .pill {
        display: inline-flex; align-items: center; gap: 7px;
        margin: 10px 14px; padding: 5px 10px; border-radius: 999px;
        background: #f6f7f9; font-size: 12px;
      }
      #dot { width: 9px; height: 9px; border-radius: 50%; background: #ef4444; flex: none; }
      section { padding: 0 14px 12px; }
      h2 {
        font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase;
        color: #9ca3af; margin: 10px 0 6px;
      }
      #cb-label {
        width: 100%; box-sizing: border-box; padding: 7px 9px;
        border: 1px solid #e5e7eb; border-radius: 7px; font: inherit;
      }
      #cb-label:focus { outline: none; border-color: #c4b5fd; box-shadow: 0 0 0 3px #ede9fe; }
      .hint { color: #9ca3af; font-size: 11px; margin-top: 5px; }
      ol { margin: 0; padding-left: 18px; color: #374151; }
      ol code {
        background: #f6f7f9; border-radius: 4px; padding: 1px 5px;
        font-size: 11px; word-break: break-all;
      }
      ol li { margin: 4px 0; }
      footer {
        display: flex; gap: 14px; padding: 10px 14px;
        border-top: 1px solid #f0f0f2; font-size: 12px;
      }
      footer a { color: #6d28d9; text-decoration: none; }
      footer a:hover { text-decoration: underline; }
    </style>
  </head>
  <body>
    <header>
      <img src="icons/icon48.png" alt="" />
      <span class="name">claude-browser</span>
      <span class="ver" id="version"></span>
    </header>

    <div class="pill"><span id="dot"></span><span id="label">Disconnected</span></div>

    <section>
      <h2>Profile</h2>
      <input id="cb-label" type="text" placeholder="Profile name" autocomplete="off" />
      <div class="hint">Auto-detected from your Google account · type to override</div>
    </section>

    <section>
      <h2>How to use</h2>
      <ol>
        <li><code>claude mcp add claude-browser -- npx -y claude-browser</code></li>
        <li>Open a Claude Code session</li>
        <li>Ask it to control the browser</li>
      </ol>
    </section>

    <footer>
      <a id="gh" href="https://github.com/michael-ltm/claude-browser" target="_blank" rel="noreferrer">★ GitHub</a>
      <a id="guide" href="https://github.com/michael-ltm/claude-browser#readme" target="_blank" rel="noreferrer">📖 Full guide</a>
    </footer>

    <script type="module" src="popup.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Replace `render()` in `packages/extension/src/popup/popup.ts`** so it sets the version and prefills the input with the resolved label. Update the import line and the `render` function:

Change the imports at the top to also pull the resolver helpers:
```ts
import { STATUS_KEY } from '../background/transport';
import { LABEL_KEY } from '../background/config';
import { getInstanceId, getLabel } from '../background/config';
```

Replace the whole `async function render(): Promise<void> { ... }` with:
```ts
async function render(): Promise<void> {
  const versionEl = document.getElementById('version');
  if (versionEl) versionEl.textContent = `v${chrome.runtime.getManifest().version}`;

  const dot = document.getElementById('dot');
  const text = document.getElementById('label');
  if (dot && text) {
    const got = await chrome.storage.local.get(STATUS_KEY);
    const status = (got as Record<string, unknown>)[STATUS_KEY] as
      | import('@claude-browser/shared').OnStatusParams
      | undefined;
    const view = statusDisplay(status);
    dot.style.background = view.color;
    text.textContent = view.label;
  }

  const labelInput = document.getElementById('cb-label') as HTMLInputElement | null;
  if (labelInput) {
    // Prefill with the resolved name (custom > email > Profile<short>).
    labelInput.value = await getLabel(await getInstanceId());
    labelInput.addEventListener('change', () => {
      void applyLabelInput(labelInput.value);
    });
  }
}
```
(Keep `statusDisplay`, `applyLabelInput`, and the `DOMContentLoaded` bootstrap as-is. Remove the now-unused top `import { type OnStatusParams }` only if it becomes unused — `statusDisplay`'s signature still references it, so keep it.)

- [ ] **Step 3: Run popup tests + build, expect PASS** — `npm test -w @claude-browser/extension -- popup && npm run build -w @claude-browser/extension`. Existing `statusDisplay`/`applyLabelInput` tests must still pass; the build must emit `dist/popup.html` + `dist/popup.js`.
- [ ] **Step 4: Commit** — `git add packages/extension && git commit -m "feat(extension): redesigned popup (status, auto name, GitHub link, usage)"`

---

### Task 4: Extension gate

**Files:** none (verification)

- [ ] **Step 1: Full extension gate** — `npm test -w @claude-browser/extension && npm run typecheck -w @claude-browser/extension && npm run build -w @claude-browser/extension`. Expected: all tests pass, typecheck clean, `dist/` emitted (manifest with identity perms, popup.html/js, background.js, icons).
- [ ] **Step 2: Commit** (empty if nothing changed) — `git commit --allow-empty -m "test(extension): popup + identity gate green"`

---

# Milestone B — Distribution + cross-platform

### Task 5: Broker-entry resolver (dev + packaged) + Windows-safe spawn

**Files:**
- Modify: `packages/mcp-server/src/client.ts`
- Test: `packages/mcp-server/test/client.spawn.test.ts`

- [ ] **Step 1: Write the failing test** `packages/mcp-server/test/client.spawn.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveBrokerEntry } from '../src/client.js';

describe('resolveBrokerEntry', () => {
  const HERE = '/pkg/dist';
  it('prefers the co-located packaged broker.js', () => {
    const exists = (p: string) => p === '/pkg/dist/broker.js';
    expect(resolveBrokerEntry(HERE, exists)).toBe('/pkg/dist/broker.js');
  });
  it('falls back to the dev monorepo path', () => {
    const exists = (p: string) => p.endsWith('broker/dist/index.js');
    expect(resolveBrokerEntry(HERE, exists)).toContain('broker/dist/index.js');
  });
  it('throws naming both probed paths when neither exists', () => {
    expect(() => resolveBrokerEntry(HERE, () => false)).toThrow(/broker entry not found/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npm test -w @claude-browser/mcp-server -- client.spawn` → `resolveBrokerEntry` not exported.

- [ ] **Step 3: Edit `packages/mcp-server/src/client.ts`.** Add the `existsSync` import and replace `defaultSpawnBroker`:

Add to the node imports near the top:
```ts
import { existsSync } from 'node:fs';
```
Add the exported resolver and update the spawn:
```ts
/** Locate the broker entry in both the packaged (co-located) and dev (monorepo) layouts. */
export function resolveBrokerEntry(here: string, exists: (p: string) => boolean = existsSync): string {
  const packaged = resolvePath(here, 'broker.js'); // published: dist/mcp.js + dist/broker.js
  if (exists(packaged)) return packaged;
  const dev = resolvePath(here, '../../broker/dist/index.js'); // monorepo dev
  if (exists(dev)) return dev;
  throw new Error(`broker entry not found (looked at ${packaged} and ${dev})`);
}

/** Spawn the broker bin detached so it outlives this MCP process (cross-platform). */
function defaultSpawnBroker(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const brokerEntry = resolveBrokerEntry(here);
  const child = spawn(process.execPath, [brokerEntry], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true, // no console flash on Windows
  });
  child.unref();
}
```

- [ ] **Step 4: Run, expect PASS** — `npm test -w @claude-browser/mcp-server -- client.spawn && npm run typecheck -w @claude-browser/mcp-server`.
- [ ] **Step 5: Commit** — `git add packages/mcp-server && git commit -m "feat(mcp): broker-entry resolver (packaged+dev) + windowsHide spawn"`

---

### Task 6: CLI surface for the `bin`

**Files:**
- Modify: `packages/mcp-server/src/index.ts`
- Test: `packages/mcp-server/test/cli.test.ts`

- [ ] **Step 1: Write the failing test** `packages/mcp-server/test/cli.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseCli } from '../src/index.js';

describe('parseCli', () => {
  it('no args -> run the MCP server', () => expect(parseCli([])).toEqual({ kind: 'mcp' }));
  it('extension-path', () => expect(parseCli(['extension-path'])).toEqual({ kind: 'extension-path' }));
  it('install', () => expect(parseCli(['install'])).toEqual({ kind: 'install' }));
  it('--version', () => expect(parseCli(['--version'])).toEqual({ kind: 'version' }));
  it('unknown -> help', () => expect(parseCli(['wat'])).toEqual({ kind: 'help' }));
});
```

- [ ] **Step 2: Run, expect FAIL** — `npm test -w @claude-browser/mcp-server -- cli`.

- [ ] **Step 3: Edit `packages/mcp-server/src/index.ts`.** Add the resolver + parser exports, and replace the `isEntry` block with a dispatch.

Add near the top imports:
```ts
import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
```
Add the CLI types/helpers (e.g. after `registerTools`):
```ts
export type CliCommand =
  | { kind: 'mcp' }
  | { kind: 'extension-path' }
  | { kind: 'install' }
  | { kind: 'version' }
  | { kind: 'help' };

export function parseCli(args: string[]): CliCommand {
  const a = args[0];
  if (a === undefined) return { kind: 'mcp' };
  if (a === 'extension-path') return { kind: 'extension-path' };
  if (a === 'install') return { kind: 'install' };
  if (a === '--version' || a === '-v') return { kind: 'version' };
  return { kind: 'help' };
}

/** Locate the bundled extension dir in packaged (../extension) and dev (../../extension/dist) layouts. */
export function resolveExtensionDir(here: string, exists: (p: string) => boolean = existsSync): string | null {
  const packaged = resolvePath(here, '../extension');         // published: dist/mcp.js -> ../extension
  if (exists(resolvePath(packaged, 'manifest.json'))) return packaged;
  const dev = resolvePath(here, '../../extension/dist');      // monorepo dev
  if (exists(resolvePath(dev, 'manifest.json'))) return dev;
  return null;
}
```
Replace the existing `const isEntry = ...; if (isEntry) { main().catch(...) }` block with:
```ts
const isEntry =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  const cmd = parseCli(process.argv.slice(2));
  const here = dirname(fileURLToPath(import.meta.url));
  if (cmd.kind === 'mcp') {
    main().catch((err) => {
      process.stderr.write(`claude-browser-mcp fatal: ${(err as Error).message}\n`);
      process.exit(1);
    });
  } else if (cmd.kind === 'extension-path') {
    const dir = resolveExtensionDir(here);
    if (dir) process.stdout.write(dir + '\n');
    else { process.stderr.write('extension dir not found\n'); process.exit(1); }
  } else if (cmd.kind === 'install') {
    const r = spawnSync('claude', ['mcp', 'add', 'claude-browser', '--', 'npx', '-y', 'claude-browser'], { stdio: 'inherit' });
    process.exit(r.status ?? 0);
  } else if (cmd.kind === 'version') {
    process.stdout.write('claude-browser ' + process.env.npm_package_version + '\n');
  } else {
    process.stdout.write(
      'Usage:\n  claude-browser                run the MCP server (used by Claude Code)\n' +
      '  claude-browser install        register with Claude Code (claude mcp add)\n' +
      '  claude-browser extension-path print the bundled extension dir to load unpacked\n',
    );
  }
}
```

- [ ] **Step 4: Run, expect PASS** — `npm test -w @claude-browser/mcp-server -- cli && npm run typecheck -w @claude-browser/mcp-server`.
- [ ] **Step 5: Commit** — `git add packages/mcp-server && git commit -m "feat(mcp): CLI dispatch (mcp/install/extension-path)"`

---

### Task 7: Publishable-package assembly script

**Files:**
- Create: `scripts/build-dist-package.mjs`
- Create: `scripts/lib/pkg-manifest.ts`
- Test: `scripts/lib/pkg-manifest.test.ts`

- [ ] **Step 1: Write the failing test** `scripts/lib/pkg-manifest.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { makePackageManifest } from './pkg-manifest.js';

describe('makePackageManifest', () => {
  it('builds a publishable manifest with bin, files, deps and version', () => {
    const m = makePackageManifest('0.2.0', { ws: '^8.18.0' });
    expect(m.name).toBe('claude-browser');
    expect(m.version).toBe('0.2.0');
    expect(m.bin['claude-browser']).toBe('dist/mcp.js');
    expect(m.files).toEqual(['dist', 'extension']);
    expect(m.type).toBe('module');
    expect(m.dependencies.ws).toBe('^8.18.0');
    expect(m.engines.node).toBe('>=20');
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run scripts/lib/pkg-manifest.test.ts`.

- [ ] **Step 3: Create `scripts/lib/pkg-manifest.ts`:**

```ts
export interface PublishManifest {
  name: string;
  version: string;
  description: string;
  type: 'module';
  bin: Record<string, string>;
  files: string[];
  dependencies: Record<string, string>;
  engines: { node: string };
  repository: { type: 'git'; url: string };
  license: string;
}

/** Build the package.json for the assembled, publishable `claude-browser` package. */
export function makePackageManifest(version: string, dependencies: Record<string, string>): PublishManifest {
  return {
    name: 'claude-browser',
    version,
    description: 'Codex-style stable browser control for Claude Code (MCP server + broker + extension).',
    type: 'module',
    bin: { 'claude-browser': 'dist/mcp.js' },
    files: ['dist', 'extension'],
    dependencies,
    engines: { node: '>=20' },
    repository: { type: 'git', url: 'https://github.com/michael-ltm/claude-browser' },
    license: 'MIT',
  };
}
```

- [ ] **Step 4: Run, expect PASS** — `npx vitest run scripts/lib/pkg-manifest.test.ts`.

- [ ] **Step 5: Create the assembly script `scripts/build-dist-package.mjs`:**

```js
// Assembles the publishable `claude-browser` package into dist-pkg/:
//   dist/mcp.js   (bin; MCP server, shared bundled, sdk/ws/zod external)
//   dist/broker.js(broker, shared bundled, ws external)
//   extension/    (built extension dist)
// Run: node scripts/build-dist-package.mjs
import { rmSync, mkdirSync, cpSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import esbuild from 'esbuild';
import { makePackageManifest } from './lib/pkg-manifest.ts';

const OUT = 'dist-pkg';
const EXTERNAL = ['@modelcontextprotocol/sdk', 'ws', 'zod'];

// 1. Build the extension (its dist is copied verbatim).
execSync('npm run build -w @claude-browser/shared', { stdio: 'inherit' });
execSync('npm run build -w @claude-browser/extension', { stdio: 'inherit' });

// 2. Fresh output dir.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(`${OUT}/dist`, { recursive: true });

// 3. Bundle mcp + broker (shared inlined; heavy/native deps external).
await esbuild.build({
  entryPoints: ['packages/mcp-server/src/index.ts'],
  outfile: `${OUT}/dist/mcp.js`,
  bundle: true, platform: 'node', format: 'esm', target: 'node20',
  external: EXTERNAL, banner: { js: '#!/usr/bin/env node' },
});
await esbuild.build({
  entryPoints: ['packages/broker/src/index.ts'],
  outfile: `${OUT}/dist/broker.js`,
  bundle: true, platform: 'node', format: 'esm', target: 'node20',
  external: ['ws'],
});
chmodSync(`${OUT}/dist/mcp.js`, 0o755);

// 4. Copy the built extension.
cpSync('packages/extension/dist', `${OUT}/extension`, { recursive: true });

// 5. package.json — version from root, deps from mcp-server.
const root = JSON.parse(readFileSync('package.json', 'utf8'));
const mcpPkg = JSON.parse(readFileSync('packages/mcp-server/package.json', 'utf8'));
writeFileSync(
  `${OUT}/package.json`,
  JSON.stringify(makePackageManifest(root.version, mcpPkg.dependencies), null, 2) + '\n',
);
// 6. README for the npm page.
writeFileSync(`${OUT}/README.md`, '# claude-browser\n\nInstall: `claude mcp add claude-browser -- npx -y claude-browser`\n\nThen load the unpacked extension printed by `npx claude-browser extension-path`. See https://github.com/michael-ltm/claude-browser\n');
console.log(`Assembled ${OUT}/ (claude-browser@${root.version})`);
```

> Note: the script imports `./lib/pkg-manifest.ts` directly — run it with Node's TS support via `node --experimental-strip-types` (Node 22+) or `npx tsx scripts/build-dist-package.mjs`. The publish workflow (Task 8) uses `npx tsx`.

- [ ] **Step 6: Ensure `esbuild` + `tsx` are available at the repo root** (the assembly script + publish workflow use them). If `node -e "require.resolve('esbuild'); require.resolve('tsx')"` fails, run `npm i -D esbuild tsx` at the repo root. Commit the resulting `package.json` / `package-lock.json` changes with this task.

- [ ] **Step 7: Smoke-test the assembly** — `npx tsx scripts/build-dist-package.mjs && ls dist-pkg dist-pkg/dist dist-pkg/extension && node --check dist-pkg/dist/mcp.js && test -f dist-pkg/extension/manifest.json && echo OK`. Expected: `OK`, with `dist/mcp.js`, `dist/broker.js`, `extension/manifest.json` present.
- [ ] **Step 8: Gitignore the output** — add `dist-pkg/` to `.gitignore`.
- [ ] **Step 9: Commit** — `git add scripts .gitignore && git commit -m "build: assemble publishable claude-browser package (mcp+broker+extension)"`

---

### Task 8: Publish-to-npm workflow (gated on NPM_TOKEN)

**Files:**
- Create: `.github/workflows/publish.yml`

- [ ] **Step 1: Create `.github/workflows/publish.yml`:**

```yaml
name: Publish to npm

on:
  push:
    tags: ['v*']

permissions:
  contents: read

jobs:
  publish:
    name: assemble + npm publish
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: 'https://registry.npmjs.org'
          cache: npm
      - run: npm ci
      - name: Gate on NPM_TOKEN
        id: gate
        env:
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
        run: |
          if [ -z "$NPM_TOKEN" ]; then
            echo "skip=true" >> "$GITHUB_OUTPUT"
            echo "NPM_TOKEN not set — skipping publish (release.yml still ships the zip)."
          else
            echo "skip=false" >> "$GITHUB_OUTPUT"
          fi
      - name: Assemble package
        if: steps.gate.outputs.skip == 'false'
        run: npx tsx scripts/build-dist-package.mjs
      - name: Publish
        if: steps.gate.outputs.skip == 'false'
        working-directory: dist-pkg
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
        run: npm publish --access public
```

- [ ] **Step 2: Validate YAML** — `node -e "require('js-yaml')" 2>/dev/null || true` then visually confirm; or push and let GitHub parse it (Task 10 verification). No local test gate.
- [ ] **Step 3: Commit** — `git add .github/workflows/publish.yml && git commit -m "ci: publish claude-browser to npm on v* tag (gated on NPM_TOKEN)"`

---

### Task 9: Add Windows to the CI matrix

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Edit `.github/workflows/ci.yml`** — make the job run on a matrix of OSes. Replace the `build-test:` job header + `runs-on:` with:

```yaml
  build-test:
    name: build · typecheck · test (${{ matrix.os }})
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
    runs-on: ${{ matrix.os }}
```
(Leave the steps unchanged — `npm ci`, build shared, build all, typecheck, test all run cross-platform.)

- [ ] **Step 2: Commit** — `git add .github/workflows/ci.yml && git commit -m "ci: run the hermetic suite on windows-latest too"`

---

### Task 10: Simplify the installer + update the README

**Files:**
- Modify: `scripts/install.ts`
- Modify: `README.md`

- [ ] **Step 1: Simplify `scripts/install.ts`** (first read the current `scripts/install.ts` + `scripts/lib/` helpers via `cat`, and preserve their existing signatures) — it is now a *dev convenience* (register the local build); it must NOT install a launchd plist. Replace its body so it: (a) ensures `~/.claude-browser/config.json`, (b) runs `claude mcp add claude-browser -- node <abs path to packages/mcp-server/dist/index.js>`, (c) prints the dev extension path (`packages/extension/dist`). Remove any `renderLaunchdPlist`/`launchctl` calls and their imports. Keep `ensureConfig`/path helpers. (End users use the `npx` command from the README, not this script.) Add a one-line banner: `console.log('Dev install: registered local build. End users: claude mcp add claude-browser -- npx -y claude-browser')`.

- [ ] **Step 2: Update the install section in `README.md`** (replace the macOS `git clone` block) with the cross-platform, no-clone flow:

```markdown
## 安装与使用(macOS / Windows / Linux)

**1. 注册 MCP(免 clone,一行命令):**
```bash
claude mcp add claude-browser -- npx -y claude-browser
```
Claude Code 会用 `npx` 拉起 MCP server,broker 自动拉起(无需常驻服务,跨平台)。

**2. 加载扩展:**
- 下载 [最新 Release](https://github.com/michael-ltm/claude-browser/releases) 里的 `claude-browser-extension-*.zip` 并解压;或运行 `npx claude-browser extension-path` 打印已打包的扩展目录。
- 打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选该目录。
- 点开扩展 popup 给这个 profile 起名(默认自动用你的 Google 邮箱名)。

**3. 用:** 打开 Claude Code 会话,`/mcp` 里能看到 `browser_*` 工具,直接让它操作浏览器。

> Chrome 网上应用店一键安装为后续计划。开发者本地开发用 `npm run install:browser`(注册本地构建,不装常驻进程)。
```

- [ ] **Step 3: Verify** — `npm run typecheck` (install.ts compiles) + `npx tsx scripts/install.ts --help 2>/dev/null || true` (does not crash importing launchd). Confirm `grep -rn launchctl scripts/install.ts` returns nothing.
- [ ] **Step 4: Full repo gate** — `npm test && npm run build && npm run typecheck`. Expected: all green.
- [ ] **Step 5: Commit** — `git add scripts/install.ts README.md && git commit -m "docs/build: cross-platform npx install, drop launchd from default installer"`

---

## Definition of done
- Popup: branded layout, live status, profile input prefilled with the resolved name (custom > Google email > Profile<short>), GitHub link, 3-step usage, version. Extension tests + typecheck + build green; manifest has `identity`/`identity.email`.
- `npx tsx scripts/build-dist-package.mjs` produces `dist-pkg/` with `dist/mcp.js` (+shebang), `dist/broker.js`, `extension/manifest.json`, and a valid `package.json` (`bin`, `files`, deps, version).
- `resolveBrokerEntry` + `resolveExtensionDir` work in dev and packaged layouts; broker spawn uses `windowsHide`.
- `bin` CLI: no-args runs MCP, `install` runs `claude mcp add`, `extension-path` prints the dir.
- Workflows: `publish.yml` (gated on `NPM_TOKEN`) + `ci.yml` matrix (ubuntu + windows). README documents the no-clone cross-platform flow.
- Full hermetic suite + typecheck + build green; no `launchctl` in the default install path.
