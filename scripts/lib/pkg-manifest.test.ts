import { describe, it, expect } from 'vitest';
import { makePackageManifest } from './pkg-manifest.js';

describe('makePackageManifest', () => {
  it('builds a publishable manifest with bin, files, deps and version', () => {
    const m = makePackageManifest('0.2.0', { ws: '^8.18.0' });
    expect(m.name).toBe('claude-browser');
    expect(m.version).toBe('0.2.0');
    expect(m.bin['claude-browser']).toBe('dist/mcp.js');
    expect(m.files).toEqual(['dist', 'extension']);
    expect(m.type).toBe('module');
    expect(m.dependencies.ws).toBe('^8.18.0');
    expect(m.engines.node).toBe('>=20');
  });
});
