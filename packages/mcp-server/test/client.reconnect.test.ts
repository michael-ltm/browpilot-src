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
  it('settles a pending retry on close and never creates another socket', async () => {
    const sockets: ScriptedSocket[] = [];
    let release!: () => void;
    const client = new BrokerClient({ token: 't', sessionId: 's', socketFactory: () => { const s = new ScriptedSocket(); sockets.push(s); return s; }, spawnBroker: () => {}, delay: () => new Promise<void>(resolve => { release = resolve; }) });
    const connection = client.connectWithRetry();
    sockets[0]!.emit('error', new Error('offline'));
    await vi.waitFor(() => expect(release).toBeDefined());
    client.close();
    await connection;
    release(); await Promise.resolve(); await Promise.resolve();
    expect(sockets).toHaveLength(1);
    expect(client.isOpen).toBe(false);
  });
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

describe('BrokerClient close-after-open auto-reconnect', () => {
  it('reconnects automatically when an established connection closes', async () => {
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

    // Connect initially and open the first socket.
    const firstConnect = client.connectWithRetry();
    await Promise.resolve();
    sockets[0]!.emit('open', undefined);
    await firstConnect;
    expect(client.isOpen).toBe(true);

    // Close the established connection; the client should auto-reconnect.
    sockets[0]!.emit('close', undefined);

    // Wait for the second socket to be created and open it.
    await vi.waitFor(() => expect(sockets.length).toBe(2));
    sockets[1]!.emit('open', undefined);

    await vi.waitFor(() => expect(client.isOpen).toBe(true));

    // Broker should not have been spawned (no ECONNREFUSED).
    expect(spawnBroker).not.toHaveBeenCalled();
  });

  it('resets brokerSpawned after close so a subsequent ECONNREFUSED triggers a fresh spawn', async () => {
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

    // First connect: ECONNREFUSED → spawn → retry → open.
    const firstConnect = client.connectWithRetry();
    await Promise.resolve();
    sockets[0]!.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
    await vi.waitFor(() => expect(sockets.length).toBe(2));
    sockets[1]!.emit('open', undefined);
    await firstConnect;
    expect(spawnBroker).toHaveBeenCalledTimes(1);

    // Simulate broker crash: close the established connection.
    sockets[1]!.emit('close', undefined);

    // The reconnect attempt gets ECONNREFUSED again → must spawn a second time.
    await vi.waitFor(() => expect(sockets.length).toBe(3));
    sockets[2]!.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));

    await vi.waitFor(() => expect(sockets.length).toBe(4));
    sockets[3]!.emit('open', undefined);

    await vi.waitFor(() => expect(client.isOpen).toBe(true));
    expect(spawnBroker).toHaveBeenCalledTimes(2);
  });

  it('the reconnecting guard prevents concurrent reconnect storms', async () => {
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

    // Connect and open.
    const firstConnect = client.connectWithRetry();
    await Promise.resolve();
    sockets[0]!.emit('open', undefined);
    await firstConnect;

    // Emit close twice rapidly — should only trigger one reconnect.
    sockets[0]!.emit('close', undefined);
    sockets[0]!.emit('close', undefined);

    // Only one new socket should be created (not two).
    await vi.waitFor(() => expect(sockets.length).toBe(2));
    // Allow a tick for any unintended second socket creation.
    await Promise.resolve();
    expect(sockets.length).toBe(2);

    sockets[1]!.emit('open', undefined);
    await vi.waitFor(() => expect(client.isOpen).toBe(true));
  });
});
