// Screenshot pages with real wall-clock waits so Svelte transitions finish.
// usage: node scripts/shot.mjs <outDir> <waitMs> name=url [name=url ...]
// Needs chromium on PATH. Uses the DevTools protocol over the built-in WebSocket (Node 22+).
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [outDir, waitMsArg, ...pairs] = process.argv.slice(2);
if (!outDir || !pairs.length) { console.error('usage: shot.mjs <outDir> <waitMs> name=url ...'); process.exit(1); }
const waitMs = Number(waitMsArg) || 2500;
const port = 9333;
const profile = mkdtempSync(join(tmpdir(), 'shot-'));
const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
const shutdown = () => { chrome.kill(); rmSync(profile, { recursive: true, force: true }); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let version;
for (let i = 0; i < 50 && !version; i++) {
  try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(100); }
}
if (!version) { shutdown(); throw new Error('chromium did not start'); }

const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const listeners = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else listeners.forEach((l) => l(m));
};
const send = (method, params = {}, sessionId) => new Promise((resolve) => {
  const msgId = ++id; pending.set(msgId, resolve);
  ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
});
const waitEvent = (name, sessionId) => new Promise((resolve) => {
  const l = (m) => { if (m.method === name && m.sessionId === sessionId) { listeners.splice(listeners.indexOf(l), 1); resolve(m); } };
  listeners.push(l);
});

const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);

for (const pair of pairs) {
  const eq = pair.indexOf('='); const name = pair.slice(0, eq); const url = pair.slice(eq + 1);
  const loaded = waitEvent('Page.loadEventFired', sessionId);
  await send('Page.navigate', { url }, sessionId);
  await loaded;
  await sleep(waitMs);
  const { result: { data } } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`${name}.png <- ${url}`);
}
ws.close(); shutdown();
