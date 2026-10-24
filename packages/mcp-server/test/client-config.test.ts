import { describe, expect, it } from 'vitest';
import { clientRegistration, clientConfig, parseCommand } from '../src/cli.js';

describe('client-neutral CLI', () => {
  it('registers the actual local entry point with Codex', () => {
    expect(clientRegistration('codex', '/app/dist/mcp.js', '/usr/bin/node')).toEqual({ command: 'codex', args: ['mcp', 'add', 'browpilot', '--', '/usr/bin/node', '/app/dist/mcp.js'] });
  });
  it('generates Claude config without changing existing files', () => {
    expect(JSON.parse(clientConfig('claude', '/app/mcp.js', '/node')).mcpServers.browpilot.args).toEqual(['/app/mcp.js']);
  });
  it('generates correctly escaped Codex TOML on Windows', () => {
    expect(clientConfig('codex', 'C:\\app\\mcp.js', 'C:\\node.exe')).toContain('command = "C:\\\\node.exe"');
  });
  it('parses HTTP port and rejects invalid ports and clients', () => {
    expect(parseCommand(['serve', '--port', '9001'])).toEqual({ kind: 'http', port: 9001 });
    expect(() => parseCommand(['serve', '--port', '0'])).toThrow(/port/);
    expect(() => parseCommand(['install', 'grok'])).toThrow(/Grok/);
    expect(parseCommand(['install', 'codex'])).toEqual({ kind: 'install', client: 'codex' });
  });
});
