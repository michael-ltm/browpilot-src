import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { resolvePaths, LAUNCHD_LABEL } from './paths.js';
import { CONFIG_DIR, CONFIG_FILE } from '@claude-browser/shared';

// resolvePaths uses node:path join, so expectations are built with join too —
// otherwise the hardcoded POSIX separators fail on Windows (backslashes).
describe('resolvePaths', () => {
  const p = resolvePaths('/repo', '/home/u');

  it('points config at ~/.claude-browser/config.json using the contract names', () => {
    expect(p.configDir).toBe(join('/home/u', CONFIG_DIR));
    expect(p.configFile).toBe(join('/home/u', CONFIG_DIR, CONFIG_FILE));
  });

  it('locates each package dist directory under the repo root', () => {
    expect(p.extensionDist).toBe(join('/repo', 'packages', 'extension', 'dist'));
    expect(p.brokerDist).toBe(join('/repo', 'packages', 'broker', 'dist'));
    expect(p.mcpServerEntry).toBe(join('/repo', 'packages', 'mcp-server', 'dist', 'index.js'));
    expect(p.brokerEntry).toBe(join('/repo', 'packages', 'broker', 'dist', 'index.js'));
  });

  it('places the launchd plist in ~/Library/LaunchAgents with the broker label', () => {
    expect(LAUNCHD_LABEL).toBe('com.claude-browser.broker');
    expect(p.plistPath).toBe(join('/home/u', 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`));
  });
});
