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
