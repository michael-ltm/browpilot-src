export type ClientName = 'codex' | 'claude';
export type Command =
  | { kind: 'mcp' | 'extension-path' | 'version' | 'help' }
  | { kind: 'install'; client?: ClientName }
  | { kind: 'config'; client: ClientName }
  | { kind: 'http'; port: number };

function clientName(value: string): ClientName {
  if (value === 'codex' || value === 'claude') return value;
  throw new Error('Client must be codex or claude. Grok uses the authenticated HTTP server: browpilot serve.');
}

export function parseCommand(args: string[]): Command {
  const [command, option, value] = args;
  if (!command) return { kind: 'mcp' };
  if (command === 'extension-path') return { kind: 'extension-path' };
  if (command === '--version' || command === '-v') return { kind: 'version' };
  if (command === 'install') return option ? { kind: 'install', client: clientName(option) } : { kind: 'install' };
  if (command === 'config') return { kind: 'config', client: clientName(option ?? 'codex') };
  if (command === 'serve') {
    const port = option === undefined ? 8788 : option === '--port' ? Number(value) : NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65535 || args.length > 3) throw new Error('serve requires --port between 1 and 65535');
    return { kind: 'http', port };
  }
  return { kind: 'help' };
}

/** Register the actual installed executable, not an unpublished npm name. */
export function clientRegistration(client: ClientName, entry: string, node: string = process.execPath) {
  return { command: client, args: ['mcp', 'add', 'browpilot', '--', node, entry] };
}

export function clientConfig(client: ClientName, entry: string, node: string = process.execPath): string {
  if (client === 'codex') return `[mcp_servers.browpilot]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(entry)}]\n`;
  return JSON.stringify({ mcpServers: { browpilot: { command: node, args: [entry] } } }, null, 2) + '\n';
}
