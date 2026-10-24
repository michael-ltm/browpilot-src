import { describe, it, expect } from 'vitest';
import { pathToFileURL } from 'node:url';
import { parseCli, isMainModule } from '../src/index.js';

describe('parseCli', () => {
  it('no args -> run the MCP server', () => expect(parseCli([])).toEqual({ kind: 'mcp' }));
  it('extension-path', () => expect(parseCli(['extension-path'])).toEqual({ kind: 'extension-path' }));
  it('install', () => expect(parseCli(['install'])).toEqual({ kind: 'install' }));
  it('--version', () => expect(parseCli(['--version'])).toEqual({ kind: 'version' }));
  it('unknown -> help', () => expect(parseCli(['wat'])).toEqual({ kind: 'help' }));
});

describe('isMainModule', () => {
  const moduleUrl = pathToFileURL('/real/dist/mcp.js').href;
  const identity = (p: string) => p;

  it('true when argv path resolves to the module', () => {
    expect(isMainModule(moduleUrl, '/real/dist/mcp.js', identity)).toBe(true);
  });
  it('true when argv is a .bin symlink resolving to the module (npx case)', () => {
    const realpath = (p: string) => (p === '/tmp/.bin/browpilot' ? '/real/dist/mcp.js' : p);
    expect(isMainModule(moduleUrl, '/tmp/.bin/browpilot', realpath)).toBe(true);
  });
  it('false when argv resolves elsewhere (imported as a library)', () => {
    expect(isMainModule(moduleUrl, '/some/vitest-runner.js', identity)).toBe(false);
  });
  it('false when argv is undefined', () => {
    expect(isMainModule(moduleUrl, undefined, identity)).toBe(false);
  });
  it('false when realpath throws (path missing)', () => {
    expect(
      isMainModule(moduleUrl, '/missing', () => {
        throw new Error('ENOENT');
      }),
    ).toBe(false);
  });
});
