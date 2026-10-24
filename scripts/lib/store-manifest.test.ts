import { describe, expect, it } from 'vitest';
import { storeManifest } from './store-manifest.js';

describe('store package manifest', () => {
  it('removes the development key while retaining permissions and extension entry points', () => {
    const manifest = storeManifest({ name: 'Browpilot', key: 'public-dev-key', permissions: ['debugger'], background: { service_worker: 'background.js' } }, '0.2.0');
    expect(manifest).not.toHaveProperty('key');
    expect(manifest.version).toBe('0.2.0');
    expect(manifest.background).toEqual({ service_worker: 'background.js' });
    expect(manifest.permissions).toEqual(['debugger']);
  });
});
