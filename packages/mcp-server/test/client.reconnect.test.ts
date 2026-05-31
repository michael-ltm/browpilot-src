import { describe, it, expect, vi } from 'vitest';
import { BrokerClient, type ClientSocket } from '../src/client.js';

/** Socket whose 'error'/'open' we drive manually. */
class ScriptedSocket implements ClientSocket {
  handlers: Record<string, ((arg: unknown) => void)[]> = {};
  sent: string[] = [];
  on(event: string, cb: (arg: unknown) => void): this {
    (this.handlers[event] ??= []).push(cb);
    return this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.emit('close', undefined);
  }
  emit(event: string, arg: unknown): void {
    for (const cb of this.handlers[event] ?? []) cb(arg);
  }
}

describe('BrokerClient.connectWithRetry', () => {
  it('spawns the broker detached when the first connection is refused, then succeeds on retry', async () => {
    const sockets: ScriptedSocket[] = [];
    const spawnBroker = vi.fn();
    const delay = vi.fn().mockResolvedValue(undefined);

    const client = new BrokerClient({
      port: 8787,
      token: 'tok',
      sessionId: 's',
      socketFactory: () => {
        const s = new ScriptedSocket();
        sockets.push(s);
        return s;
      },
      spawnBroker,
      delay,
    });

    const done = client.connectWithRetry();

    // First socket: emit a refused error.
    await Promise.resolve();
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    sockets[0]!.emit('error', refused);

    // Allow the retry loop to spawn + delay + open a new socket.
    await vi.waitFor(() => expect(sockets.length).toBe(2));
    sockets[1]!.emit('open', undefined);

    await done;
    expect(spawnBroker).toHaveBeenCalledTimes(1);
    expect(delay).toHaveBeenCalled();
    expect(client.isOpen).toBe(true);
  });

  it('does NOT spawn when the error is not ECONNREFUSED, but still retries', async () => {
    const sockets: ScriptedSocket[] = [];
    const spawnBroker = vi.fn();
    const delay = vi.fn().mockResolvedValue(undefined);

    const client = new BrokerClient({
      port: 8787,
      token: 'tok',
      sessionId: 's',
      socketFactory: () => {
        const s = new ScriptedSocket();
        sockets.push(s);
        return s;
      },
      spawnBroker,
      delay,
    });

    const done = client.connectWithRetry();
    await Promise.resolve();
    sockets[0]!.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' }));

    await vi.waitFor(() => expect(sockets.length).toBe(2));
    sockets[1]!.emit('open', undefined);
    await done;

    expect(spawnBroker).not.toHaveBeenCalled();
  });

  it('caps the backoff delay at maxBackoffMs', async () => {
    const sockets: ScriptedSocket[] = [];
    const delays: number[] = [];
    const client = new BrokerClient({
      port: 8787,
      token: 'tok',
      sessionId: 's',
      baseBackoffMs: 100,
      maxBackoffMs: 400,
      socketFactory: () => {
        const s = new ScriptedSocket();
        sockets.push(s);
        return s;
      },
      spawnBroker: vi.fn(),
      delay: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });

    const done = client.connectWithRetry();
    // Fail the first 4 attempts (refused), then succeed on the 5th.
    for (let i = 0; i < 4; i++) {
      await vi.waitFor(() => expect(sockets.length).toBe(i + 1));
      sockets[i]!.emit('error', Object.assign(new Error('x'), { code: 'ECONNREFUSED' }));
    }
    await vi.waitFor(() => expect(sockets.length).toBe(5));
    sockets[4]!.emit('open', undefined);
    await done;

    // 100, 200, 400, 400 (capped)
    expect(delays).toEqual([100, 200, 400, 400]);
  });
});
