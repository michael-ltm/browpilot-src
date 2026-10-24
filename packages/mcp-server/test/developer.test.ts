import { afterEach, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { DeveloperBrowser } from '../src/developer/index.js';

let server: Server | undefined;
let browser: DeveloperBrowser | undefined;
let pushFrame: ((value: string) => void) | undefined;
let disconnectPeer: (() => void) | undefined;
afterEach(async () => { await browser?.close(); await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve()); server = undefined; browser = undefined; });

async function fixture(handler: (message: Record<string, unknown>, send: (value: unknown) => void) => void): Promise<number> {
  server = createServer((request, response) => {
    if (request.url === '/json/version') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${(server!.address() as {port:number}).port}/devtools/browser/test` })); }
    else { response.statusCode = 404; response.end(); }
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', socket => { pushFrame = value => socket.send(value); disconnectPeer = () => socket.close(); socket.on('message', data => handler(JSON.parse(data.toString()), value => socket.send(JSON.stringify(value)))); });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  return (server.address() as {port:number}).port;
}

test('routes flat sessions and preserves event identity', async () => {
  const port = await fixture((message, send) => {
    const { id, method } = message;
    if (method === 'Target.getTargets') send({ id, result: { targetInfos: [{ targetId: 'page-1', type: 'page', title: 'One', url: 'about:blank' }] } });
    if (method === 'Target.attachToTarget') send({ id, result: { sessionId: 'session-1' } });
    if (method === 'Runtime.evaluate') { send({ method: 'Runtime.consoleAPICalled', params: { type: 'log' }, sessionId: 'session-1' }); send({ id, sessionId: 'session-1', result: { result: { value: 7 } } }); }
  });
  browser = new DeveloperBrowser(); await browser.connect(port);
  expect(await browser.targets()).toEqual([{ targetId: 'page-1', type: 'page', title: 'One', url: 'about:blank' }]);
  expect(await browser.attach('page-1')).toEqual({ sessionId: 'session-1' });
  expect(await browser.command({ method: 'Runtime.evaluate', params: { expression: '7' }, sessionId: 'session-1' })).toEqual({ result: { value: 7 } });
  expect(browser.events({ sessionId: 'session-1' })).toMatchObject([{ method: 'Runtime.consoleAPICalled', sessionId: 'session-1', targetId: 'page-1' }]);
});

test('refuses non-loopback browser socket URLs', async () => {
  server = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({webSocketDebuggerUrl:'ws://example.com/devtools/browser/x'})); });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  browser = new DeveloperBrowser();
  await expect(browser.connect((server.address() as {port:number}).port)).rejects.toThrow(/loopback/i);
});

test('blocks page emulation on worker sessions', async () => {
  const port = await fixture((message, send) => {
    if (message.method === 'Target.getTargets') send({ id: message.id, result: { targetInfos: [{ targetId: 'worker-1', type: 'service_worker', title: '', url: 'https://example.test/sw.js' }] } });
    if (message.method === 'Target.attachToTarget') send({ id: message.id, result: { sessionId: 'worker-session' } });
  });
  browser = new DeveloperBrowser(); await browser.connect(port);
  await browser.targets(); await browser.attach('worker-1');
  await expect(browser.command({method:'Emulation.setDeviceMetricsOverride', sessionId:'worker-session', params:{width:100,height:100,deviceScaleFactor:1,mobile:false}})).rejects.toThrow(/worker/i);
});

test('surfaces CDP protocol errors without corrupting later commands', async () => {
  const port = await fixture((message, send) => {
    if (message.method === 'Runtime.evaluate') send({ id: message.id, error: { code: -32601, message: 'Unknown method' } });
    if (message.method === 'Target.getTargets') send({ id: message.id, result: { targetInfos: [] } });
  });
  browser = new DeveloperBrowser(); await browser.connect(port);
  await expect(browser.command({ method: 'Runtime.evaluate' })).rejects.toThrow('Unknown method');
  expect(await browser.targets()).toEqual([]);
});

test('refuses the Linux daily Chrome user data directory before spawning', async () => {
  browser = new DeveloperBrowser();
  await expect(browser.launch({ executable: '/nonexistent/browser', userDataDir: `${process.env.HOME}/.config/google-chrome` })).rejects.toThrow(/default browser profile/i);
});

test('rejects HTTP discovery redirects before following them', async () => {
  let redirected = 0;
  server = createServer((request, response) => {
    if (request.url === '/json/version') { response.writeHead(302, { location: `http://127.0.0.1:${(server!.address() as {port:number}).port}/remote` }); response.end(); }
    else { redirected++; response.end('{}'); }
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  browser = new DeveloperBrowser();
  await expect(browser.connect((server.address() as {port:number}).port)).rejects.toThrow();
  expect(redirected).toBe(0);
});

test('one concurrent connection cannot replace another', async () => {
  const port = await fixture((message, send) => { if (message.method === 'Target.getTargets') send({id:message.id,result:{targetInfos:[]}}); });
  browser = new DeveloperBrowser();
  const first = browser.connect(port);
  const second = browser.connect(port);
  await expect(second).rejects.toThrow(/already|progress/i);
  await first;
  expect(await browser.targets()).toEqual([]);
});

test('rejects a worker emulation command without prior target listing', async () => {
  const port = await fixture((message, send) => {
    if (message.method === 'Target.getTargets') send({id:message.id,result:{targetInfos:[{targetId:'worker-2',type:'service_worker',title:'',url:''}]}});
    if (message.method === 'Target.attachToTarget') send({id:message.id,result:{sessionId:'s2'}});
  });
  browser = new DeveloperBrowser(); await browser.connect(port); await browser.attach('worker-2');
  await expect(browser.command({method:'Emulation.setDeviceMetricsOverride',sessionId:'s2'})).rejects.toThrow(/worker|unknown/i);
});

test('rejects a dangling SingletonLock symlink', async () => {
  const { mkdtemp, symlink, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'developer-lock-'));
  try {
    await symlink('host-12345', join(dir, 'SingletonLock'));
    browser = new DeveloperBrowser();
    await expect(browser.launch({executable:'/nonexistent/browser',userDataDir:dir})).rejects.toThrow(/locked/i);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('ignores malformed null CDP frames and preserves command service', async () => {
  const port = await fixture((message, send) => { if (message.method === 'Target.getTargets') send({id:message.id,result:{targetInfos:[]}}); });
  browser = new DeveloperBrowser(); await browser.connect(port);
  pushFrame?.('null'); pushFrame?.('[]');
  expect(await browser.targets()).toEqual([]);
});

test('auto-attached worker events retain target identity and are cleared on close', async () => {
  const port = await fixture((message, send) => {
    if (message.method === 'Target.getTargets') send({id:message.id,result:{targetInfos:[]}});
  });
  browser = new DeveloperBrowser(); await browser.connect(port);
  pushFrame?.(JSON.stringify({method:'Target.attachedToTarget',params:{sessionId:'auto-1',targetInfo:{targetId:'sw-auto',type:'service_worker',title:'',url:''}}}));
  pushFrame?.(JSON.stringify({method:'Runtime.consoleAPICalled',sessionId:'auto-1',params:{type:'log'}}));
  await browser.targets();
  expect(browser.events({sessionId:'auto-1'})).toMatchObject([{targetId:'sw-auto',method:'Target.attachedToTarget'}, {targetId:'sw-auto',method:'Runtime.consoleAPICalled'}]);
  await expect(browser.command({method:'Emulation.setDeviceMetricsOverride',sessionId:'auto-1'})).rejects.toThrow(/worker/i);
  await browser.close();
  expect(browser.events()).toEqual([]);
});

test('truncates oversized event data before returning it', async () => {
  const port = await fixture((message, send) => { if (message.method === 'Target.getTargets') send({id:message.id,result:{targetInfos:[]}}); });
  browser = new DeveloperBrowser(); await browser.connect(port);
  pushFrame?.(JSON.stringify({method:'Runtime.consoleAPICalled',params:{args:[{value:'x'.repeat(100000)}]}}));
  await browser.targets();
  expect(browser.events()).toMatchObject([{method:'Runtime.consoleAPICalled',params:{truncated:true}}]);
});

test('refuses a symlink into an XDG-configured daily profile', async () => {
  const { mkdtemp, mkdir, symlink, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const base = await mkdtemp(join(tmpdir(), 'developer-xdg-'));
  const previous = process.env.XDG_CONFIG_HOME;
  try {
    const config = join(base, 'xdg'); const daily = join(config, 'google-chrome');
    await mkdir(daily,{recursive:true}); await symlink(daily,join(base,'custom-profile'));
    process.env.XDG_CONFIG_HOME = config;
    browser = new DeveloperBrowser();
    await expect(browser.launch({executable:'/nonexistent/browser',userDataDir:join(base,'custom-profile')})).rejects.toThrow(/default browser profile/i);
  } finally { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; await rm(base,{recursive:true,force:true}); }
});

test('close cancels pending discovery and permits a fresh connection', async () => {
  let release!: () => void;
  let requested!: () => void;
  const requestedPromise = new Promise<void>(resolve => { requested = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  server = createServer(async (request, response) => {
    if (request.url === '/json/version') { requested(); await hold; response.end('{}'); }
  });
  await new Promise<void>(resolve => server!.listen(0,'127.0.0.1',resolve));
  browser = new DeveloperBrowser();
  const pending = browser.connect((server.address() as {port:number}).port);
  await requestedPromise;
  await browser.close(); release();
  await expect(pending).rejects.toThrow();
  await expect(browser.connect(0)).rejects.toThrow(/port/i);
});

test('launch discards stale DevToolsActivePort and attaches to the fresh endpoint', async () => {
  const { mkdtemp, writeFile, chmod, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const base = await mkdtemp(join(tmpdir(), 'developer-port-'));
  const port = await fixture((message, send) => { if (message.method === 'Target.getTargets') send({id:message.id,result:{targetInfos:[]}}); });
  const executable = join(base,'fake-browser'); const profile = join(base,'profile');
  try {
    const { mkdir } = await import('node:fs/promises'); await mkdir(profile);
    await writeFile(join(profile,'DevToolsActivePort'),'1\n/devtools/browser/stale\n');
    await writeFile(executable,`#!/usr/bin/env node\nconst fs=require('fs'); const dir=process.argv.find(x=>x.startsWith('--user-data-dir=')).slice(16); setTimeout(()=>fs.writeFileSync(dir+'/DevToolsActivePort','${port}\\n/devtools/browser/test\\n'),100); setInterval(()=>{},1000);\n`);
    await chmod(executable,0o755);
    browser = new DeveloperBrowser();
    expect(await browser.launch({executable,userDataDir:profile})).toEqual({port,userDataDir:profile});
    expect(await browser.targets()).toEqual([]);
  } finally { await browser?.close(); await rm(base,{recursive:true,force:true}); }
});

test('socket disconnect rejects pending command and removes stale events', async () => {
  const port = await fixture(() => {});
  browser = new DeveloperBrowser(); await browser.connect(port);
  pushFrame?.(JSON.stringify({method:'Runtime.consoleAPICalled',params:{type:'log'}}));
  const pending = browser.command({method:'Runtime.evaluate',params:{expression:'1'}});
  disconnectPeer?.();
  await expect(pending).rejects.toThrow(/closed/i);
  expect(browser.events()).toEqual([]);
});

test('requires an absolute executable path', async () => {
  browser = new DeveloperBrowser();
  await expect(browser.launch({executable:'chrome'})).rejects.toThrow(/absolute/i);
});

test('execution contexts reflect live lifecycle after event clearing', async () => {
  const port = await fixture((message, send) => { if (message.method === 'Runtime.enable') send({id:message.id,result:{}}); });
  browser = new DeveloperBrowser(); await browser.connect(port);
  pushFrame?.(JSON.stringify({method:'Runtime.executionContextCreated',sessionId:'s-live',params:{context:{id:1,origin:'https://a.test',name:'main',auxData:{isDefault:true}}}}));
  pushFrame?.(JSON.stringify({method:'Runtime.executionContextCreated',sessionId:'s-live',params:{context:{id:2,origin:'https://a.test',name:'isolated'}}}));
  expect(await browser.contexts('s-live')).toMatchObject([{id:1},{id:2}]);
  browser.events({clear:true});
  expect(await browser.contexts('s-live')).toMatchObject([{id:1},{id:2}]);
  pushFrame?.(JSON.stringify({method:'Runtime.executionContextDestroyed',sessionId:'s-live',params:{executionContextId:1}}));
  await browser.command({method:'Runtime.enable',sessionId:'s-live'});
  expect(await browser.contexts('s-live')).toMatchObject([{id:2}]);
  pushFrame?.(JSON.stringify({method:'Runtime.executionContextsCleared',sessionId:'s-live',params:{}}));
  await browser.command({method:'Runtime.enable',sessionId:'s-live'});
  expect(await browser.contexts('s-live')).toEqual([]);
});

test('nested auto-attach lifecycle pairs child session with child target', async () => {
  const port = await fixture((message, send) => { if (message.method === 'Target.getTargets') send({id:message.id,result:{targetInfos:[]}}); });
  browser = new DeveloperBrowser(); await browser.connect(port);
  pushFrame?.(JSON.stringify({method:'Target.attachedToTarget',sessionId:'parent-session',params:{sessionId:'child-session',targetInfo:{targetId:'child-target',type:'service_worker',title:'',url:''}}}));
  await browser.targets();
  expect(browser.events({sessionId:'child-session'})).toMatchObject([{method:'Target.attachedToTarget',sessionId:'child-session',targetId:'child-target'}]);
  pushFrame?.(JSON.stringify({method:'Target.detachedFromTarget',sessionId:'parent-session',params:{sessionId:'child-session'}}));
  await browser.targets();
  expect(browser.events({sessionId:'child-session'})).toMatchObject([{method:'Target.attachedToTarget',targetId:'child-target'},{method:'Target.detachedFromTarget',targetId:'child-target'}]);
});

test('live launched child blocks a replacement after CDP disconnect', async () => {
  const { mkdtemp, writeFile, chmod, rm, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const base = await mkdtemp(join(tmpdir(),'developer-child-'));
  const port = await fixture(() => {});
  const executable = join(base,'fake-browser'); const profile = join(base,'profile');
  try {
    await mkdir(profile); await writeFile(executable,`#!/usr/bin/env node\nconst fs=require('fs'); const dir=process.argv.find(x=>x.startsWith('--user-data-dir=')).slice(16); fs.writeFileSync(dir+'/DevToolsActivePort','${port}\\n/devtools/browser/test\\n'); setInterval(()=>{},1000);\n`); await chmod(executable,0o755);
    browser = new DeveloperBrowser(); await browser.launch({executable,userDataDir:profile});
    disconnectPeer?.(); await new Promise(resolve=>setTimeout(resolve,20));
    await expect(browser.launch({executable,userDataDir:join(base,'second')})).rejects.toThrow(/already|owned|close/i);
  } finally { await browser?.close(); await rm(base,{recursive:true,force:true}); }
});

test('closing a pending WebSocket handshake completes without an unhandled socket error', async () => {
  let upgraded!: () => void;
  const upgradeSeen = new Promise<void>(resolve => { upgraded = resolve; });
  let peer: import('node:stream').Duplex | undefined;
  server = createServer((_request,response) => response.end(JSON.stringify({webSocketDebuggerUrl:`ws://127.0.0.1:${(server!.address() as {port:number}).port}/devtools/browser/test`})));
  server.on('upgrade',(_request,socket) => { peer = socket; upgraded(); });
  await new Promise<void>(resolve => server!.listen(0,'127.0.0.1',resolve));
  browser = new DeveloperBrowser();
  const pending = browser.connect((server.address() as {port:number}).port);
  await upgradeSeen;
  await browser.close();
  await expect(pending).rejects.toThrow();
  await new Promise(resolve=>setTimeout(resolve,30));
  peer?.destroy();
});

test('clearing or evicting events never removes live contexts', async () => {
  const port = await fixture((message, send) => { if (message.method === 'Runtime.enable') send({id:message.id,result:{}}); });
  browser = new DeveloperBrowser(); await browser.connect(port);
  pushFrame?.(JSON.stringify({method:'Runtime.executionContextCreated',sessionId:'s-ring',params:{context:{id:42,origin:'',name:'main'}}}));
  for (let i=0;i<1010;i++) pushFrame?.(JSON.stringify({method:'Runtime.consoleAPICalled',sessionId:'s-ring',params:{type:'log'}}));
  await browser.contexts('s-ring');
  browser.events({clear:true});
  expect(await browser.contexts('s-ring')).toMatchObject([{id:42}]);
});

test('detaching a session removes its live execution contexts', async () => {
  const port = await fixture((message, send) => { if (message.method === 'Runtime.enable' || message.method === 'Target.getTargets') send({id:message.id,result:message.method === 'Target.getTargets'?{targetInfos:[]}:{}}); });
  browser = new DeveloperBrowser(); await browser.connect(port);
  pushFrame?.(JSON.stringify({method:'Target.attachedToTarget',params:{sessionId:'s-detach',targetInfo:{targetId:'page-detach',type:'page',title:'',url:''}}}));
  pushFrame?.(JSON.stringify({method:'Runtime.executionContextCreated',sessionId:'s-detach',params:{context:{id:3,origin:'',name:'main'}}}));
  expect(await browser.contexts('s-detach')).toMatchObject([{id:3}]);
  pushFrame?.(JSON.stringify({method:'Target.detachedFromTarget',params:{sessionId:'s-detach'}}));
  await browser.targets();
  expect(await browser.contexts('s-detach')).toEqual([]);
});

test('new connection is blocked throughout asynchronous child shutdown', async () => {
  const { mkdtemp, writeFile, chmod, rm, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const base = await mkdtemp(join(tmpdir(),'developer-closing-'));
  const port = await fixture(() => {});
  const executable = join(base,'fake-browser'); const profile = join(base,'profile');
  try {
    await mkdir(profile); await writeFile(executable,`#!/usr/bin/env node\nconst fs=require('fs'); const dir=process.argv.find(x=>x.startsWith('--user-data-dir=')).slice(16); fs.writeFileSync(dir+'/DevToolsActivePort','${port}\\n/devtools/browser/test\\n'); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);\n`); await chmod(executable,0o755);
    browser = new DeveloperBrowser(); await browser.launch({executable,userDataDir:profile});
    const closing = browser.close();
    await expect(browser.connect(port)).rejects.toThrow(/closing|progress/i);
    await closing;
  } finally { await browser?.close(); await rm(base,{recursive:true,force:true}); }
}, 5000);

test('raw commands with unknown session identity reach CDP', async () => {
  const port = await fixture((message, send) => { if (message.method === 'Emulation.clearDeviceMetricsOverride') send({id:message.id,sessionId:message.sessionId,result:{}}); });
  browser = new DeveloperBrowser(); await browser.connect(port);
  expect(await browser.command({method:'Emulation.clearDeviceMetricsOverride',sessionId:'external-session'})).toEqual({});
});
