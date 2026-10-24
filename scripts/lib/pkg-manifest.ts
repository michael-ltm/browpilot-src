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
    name: '@john523100/claude-browser',
    version,
    description: 'Browpilot — Browser MCP for AI agents, with local profile discovery, startup and extension debugging.',
    type: 'module',
    bin: { 'claude-browser': 'dist/mcp.js', browpilot: 'dist/mcp.js' },
    files: ['dist', 'extension'],
    dependencies,
    engines: { node: '>=20' },
    repository: { type: 'git', url: 'https://github.com/michael-ltm/claude-browser' },
    license: 'MIT',
  };
}
