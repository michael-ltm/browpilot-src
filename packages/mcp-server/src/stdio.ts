import type { Readable, Writable } from 'node:stream';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/** Tie broker/developer resources to the lifetime of the stdio caller. */
export async function connectStdioSession(
  resource: { server: McpServer; dispose(): void | Promise<void> },
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<() => Promise<void>> {
  const transport = new StdioServerTransport(input, output);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    // Set the promise before server.close() invokes its onclose callback.
    closing ??= Promise.resolve().then(async () => {
      try { await resource.server.close(); }
      finally { await resource.dispose(); }
    });
    return closing;
  };
  const onClosed = () => { void close().catch(() => {}); };
  input.once('end', onClosed);
  input.once('close', onClosed);
  input.on('error', onClosed);
  output.on('error', onClosed);
  output.once('close', onClosed);
  resource.server.server.onclose = onClosed;
  try {
    await resource.server.connect(transport);
    // A caller may have gone away before transport.start() installed listeners.
    if (input.readableEnded || input.destroyed || output.destroyed) await close();
  } catch (error) {
    await close();
    throw error;
  }
  return close;
}
