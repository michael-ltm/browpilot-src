import { describe, it, expect } from 'vitest';
import { run } from './run.js';

describe('run', () => {
  it('resolves with stdout on success', async () => {
    const res = await run('node', ['-e', 'process.stdout.write("hi")']);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('hi');
  });

  it('rejects on a non-zero exit by default', async () => {
    await expect(run('node', ['-e', 'process.exit(3)'])).rejects.toThrow(/exited with code 3/);
  });

  it('does not reject when allowFailure is set, returning the code', async () => {
    const res = await run('node', ['-e', 'process.exit(3)'], { allowFailure: true });
    expect(res.code).toBe(3);
  });

  it('rejects with a clear error when the binary is missing', async () => {
    await expect(run('definitely-not-a-real-binary-xyz', [])).rejects.toThrow();
  });
});
