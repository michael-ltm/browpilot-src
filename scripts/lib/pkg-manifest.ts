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
