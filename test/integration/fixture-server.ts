import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

const FIXTURE_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>CB Fixture</title></head>
  <body>
    <h1 id="heading">Browpilot Fixture</h1>
    <button id="go">Go</button>
    <input id="name" type="text" aria-label="Name" />
    <p id="result">idle</p>
    <script>
      console.log('CB_FIXTURE_LOADED');
      document.getElementById('go').addEventListener('click', function () {
        document.getElementById('result').textContent = 'clicked';
        console.log('CB_BUTTON_CLICKED');
      });
    </script>
  </body>
</html>`;

export interface FixtureServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Start a one-route HTTP server that serves the e2e fixture page. */
export function startFixtureServer(): Promise<FixtureServer> {
  return new Promise((resolveServer, rejectServer) => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    server.on('error', rejectServer);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolveServer({
        url: `http://127.0.0.1:${port}/`,
        port,
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res())),
          ),
      });
    });
  });
}
