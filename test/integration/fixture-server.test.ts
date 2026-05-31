import { describe, it, expect, afterEach } from 'vitest';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';

let server: FixtureServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('startFixtureServer', () => {
  it('serves the fixture HTML on an ephemeral port', async () => {
    server = await startFixtureServer();
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    const res = await fetch(server.url);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(body).toContain('id="go"'); // the button the e2e clicks
    expect(body).toContain('id="name"'); // the input the e2e types into
    expect(body).toContain('CB_FIXTURE_LOADED'); // the console.log the e2e reads
  });
});
