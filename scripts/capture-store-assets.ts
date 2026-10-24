/** Render truthful Browpilot store assets from the built extension in isolated Chromium. */
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { DeveloperBrowser } from '../packages/mcp-server/src/developer/index.js';
import { idFromManifestKey } from '../packages/mcp-server/src/bootstrap.js';

const temp = await mkdtemp(join(tmpdir(), 'browpilot-store-assets-'));
const extension = join(temp, 'extension');
const profile = join(temp, 'profile');
const output = resolve('artifacts/store-assets');
const executable = process.env.BROWPILOT_TEST_BROWSER ?? '/usr/bin/chromium';
let child: ChildProcess | undefined;
let dev: DeveloperBrowser | undefined;
let stderr = '';
async function until<T>(check: () => Promise<T | undefined>, timeout = 15000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null) throw new Error(`Chromium exited: ${stderr}`);
    const result = await check(); if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Chromium: ${stderr}`);
}
async function target(url: string) {
  return until(async () => (await dev!.targets()).find(item => item.type === 'page' && item.url === url));
}
async function screenshot(sessionId: string, width: number, height: number): Promise<Buffer> {
  await dev!.command({ method: 'Emulation.setDeviceMetricsOverride', sessionId, params: { width, height, deviceScaleFactor: 1, mobile: false } });
  const result = await dev!.command({ method: 'Page.captureScreenshot', sessionId, params: { format: 'png', fromSurface: true, captureBeyondViewport: false } }) as { data: string };
  return Buffer.from(result.data, 'base64');
}
async function renderHtml(html: string, name: string, width: number, height: number): Promise<void> {
  const file = join(temp, `${name}.html`);
  await writeFile(file, html);
  const url = `file://${file}`;
  const created = await dev!.command({ method: 'Target.createTarget', params: { url } }) as { targetId: string };
  const attached = await dev!.attach(created.targetId);
  await dev!.command({ method: 'Page.enable', sessionId: attached.sessionId });
  await until(async () => {
    const response = await dev!.command({ method: 'Runtime.evaluate', sessionId: attached.sessionId, params: { expression: 'document.readyState', returnByValue: true } }) as { result?: { value?: string } };
    return response.result?.value === 'complete' ? true : undefined;
  });
  await writeFile(join(output, `${name}.png`), await screenshot(attached.sessionId, width, height));
}
try {
  await cp(resolve('packages/extension/dist'), extension, { recursive: true });
  // The copied extension must never attach to a daily broker on its default port.
  const backgroundFile = join(extension, 'background.js');
  const background = await readFile(backgroundFile, 'utf8');
  assert.match(background, /var DEFAULT_PORT = 8787;/);
  await writeFile(backgroundFile, background.replace('var DEFAULT_PORT = 8787;', 'var DEFAULT_PORT = 1;'));
  await mkdir(output, { recursive: true });
  child = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--load-extension=${extension}`, `--disable-extensions-except=${extension}`, '--window-size=1280,800', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-4000); });
  await once(child, 'spawn');
  const port = await until(async () => {
    try { const n = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return n > 0 ? n : undefined; }
    catch { return undefined; }
  });
  dev = new DeveloperBrowser(); await dev.connect(port);
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8')) as { key: string; version: string };
  const id = idFromManifestKey(manifest.key);
  assert.equal(manifest.version, '0.2.0');
  const worker = await until(async () => (await dev!.targets()).find(item => item.type === 'service_worker' && item.url.startsWith(`chrome-extension://${id}/`)));
  const workerSession = await dev.attach(worker.targetId);
  await dev.contexts(workerSession.sessionId);
  const popupUrl = `chrome-extension://${id}/popup.html`;
  await dev.command({ method: 'Runtime.evaluate', sessionId: workerSession.sessionId, params: { expression: `chrome.tabs.create({url:${JSON.stringify(popupUrl)}})`, awaitPromise: true, returnByValue: true } });
  const popupTarget = await target(popupUrl);
  const popupSession = await dev.attach(popupTarget.targetId);
  await dev.command({ method: 'Page.enable', sessionId: popupSession.sessionId });
  await until(async () => {
    const response = await dev!.command({ method: 'Runtime.evaluate', sessionId: popupSession.sessionId, params: { expression: 'document.querySelector("#version")?.textContent', returnByValue: true } }) as { result?: { value?: string } };
    return response.result?.value === 'v0.2.0' ? true : undefined;
  });
  await dev.command({ method: 'Emulation.setDeviceMetricsOverride', sessionId: popupSession.sessionId, params: { width: 300, height: 700, deviceScaleFactor: 2, mobile: false } });
  const popupResult = await dev.command({ method: 'Page.captureScreenshot', sessionId: popupSession.sessionId, params: { format: 'png', clip: { x: 0, y: 0, width: 300, height: 520, scale: 1 }, fromSurface: true, captureBeyondViewport: true } }) as { data: string };
  const popupPng = popupResult.data;
  const svg = await readFile(join(extension, 'icons', 'browpilot.svg'), 'utf8');
  const mark = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const presentation = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{margin:0;width:1280px;height:800px;font-family:Inter,system-ui,'Segoe UI',sans-serif}body{background:#0b1629;color:#f0fdfa;overflow:hidden}
    .glow{position:absolute;right:-90px;top:-110px;width:750px;height:900px;background:radial-gradient(circle,#17444b 0%,#0b1629 66%)}
    .line{position:absolute;left:70px;top:70px;width:1140px;height:1px;background:#2b5660}
    .brand{position:absolute;left:80px;top:85px;display:flex;align-items:center;gap:16px;font-size:25px;font-weight:750;letter-spacing:-.03em}.brand img{width:52px;height:52px}
    .copy{position:absolute;left:80px;top:220px;width:620px}.eyebrow{font-size:18px;letter-spacing:.16em;color:#2dd4bf;font-weight:700;text-transform:uppercase}
    h1{font-size:62px;line-height:1.04;letter-spacing:-.055em;margin:26px 0 22px;max-width:610px}p{font-size:23px;line-height:1.42;color:#bbd4d6;max-width:565px;margin:0}
    .facts{margin-top:48px;display:flex;gap:18px;flex-wrap:wrap}.fact{border:1px solid #31626b;border-radius:999px;padding:13px 19px;color:#d7f4ee;font-size:16px}
    .capture{position:absolute;right:115px;top:125px;width:390px;height:600px;padding:24px;background:#f9fbfb;border-radius:22px;box-shadow:0 24px 80px #0008;display:flex;align-items:center;justify-content:center}
    .capture img{display:block;width:300px;height:auto;max-height:520px;object-fit:contain;box-shadow:0 8px 28px #0b16292b}
    .caption{position:absolute;bottom:45px;right:125px;color:#89b5b6;font-size:14px}
  </style></head><body><div class="glow"></div><div class="line"></div><div class="brand"><img src="${mark}">Browpilot</div>
  <div class="copy"><div class="eyebrow">Browser companion</div><h1>Bring your browser profile to your AI tools.</h1><p>The extension popup lets you name a profile, set debugger idle time, and follow the setup guide.</p><div class="facts"><span class="fact">Profile label</span><span class="fact">Debugger idle setting</span><span class="fact">Setup guidance</span></div></div>
  <div class="capture"><img src="data:image/png;base64,${popupPng}" alt="Actual Browpilot popup"></div><div class="caption">Actual v0.2.0 popup · isolated Chromium profile</div></body></html>`;
  await renderHtml(presentation, 'browpilot-popup-1280x800', 1280, 800);
  const tile = `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{width:440px;height:280px;margin:0}body{font-family:Inter,system-ui,'Segoe UI',sans-serif;background:#0b1629;color:#f0fdfa;overflow:hidden}.glow{position:absolute;right:-90px;top:-90px;width:350px;height:350px;background:radial-gradient(circle,#15535b,#0b1629 70%)}img{position:absolute;left:35px;top:40px;width:76px;height:76px}h1{position:absolute;left:128px;top:49px;font-size:38px;letter-spacing:-.05em;margin:0}p{position:absolute;left:36px;top:151px;width:355px;font-size:23px;line-height:1.22;margin:0;color:#bce8e3}.rule{position:absolute;left:36px;bottom:30px;width:368px;height:4px;background:#2dd4bf;border-radius:2px}</style></head><body><div class="glow"></div><img src="${mark}"><h1>Browpilot</h1><p>Browser companion for AI tools</p><div class="rule"></div></body></html>`;
  await renderHtml(tile, 'browpilot-promo-440x280', 440, 280);
  console.log('Created', join(output, 'browpilot-popup-1280x800.png'), join(output, 'browpilot-promo-440x280.png'));
} finally {
  await dev?.close();
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 1000))]); if (child.exitCode === null) child.kill('SIGKILL'); }
  await rm(temp, { recursive: true, force: true });
}
