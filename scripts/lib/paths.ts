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
