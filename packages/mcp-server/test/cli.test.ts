import { describe, it, expect } from 'vitest';
import { parseCli } from '../src/index.js';

describe('parseCli', () => {
  it('no args -> run the MCP server', () => expect(parseCli([])).toEqual({ kind: 'mcp' }));
  it('extension-path', () => expect(parseCli(['extension-path'])).toEqual({ kind: 'extension-path' }));
  it('install', () => expect(parseCli(['install'])).toEqual({ kind: 'install' }));
  it('--version', () => expect(parseCli(['--version'])).toEqual({ kind: 'version' }));
  it('unknown -> help', () => expect(parseCli(['wat'])).toEqual({ kind: 'help' }));
});
