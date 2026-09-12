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
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: Number(process.env.SCALE) || 1, mobile: false }, sessionId);

// name=url|Key,Key presses keys after load (e.g. "|Space" to start playback, "|ArrowRight,ArrowRight" to step).
const KEYS = { Space: { key: ' ', code: 'Space' }, ArrowRight: { key: 'ArrowRight', code: 'ArrowRight' }, ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft' } };
for (const pair of pairs) {
  const eq = pair.indexOf('='); const name = pair.slice(0, eq);
  const [url, keys = ''] = pair.slice(eq + 1).split('|');
  const loaded = waitEvent('Page.loadEventFired', sessionId);
  await send('Page.navigate', { url }, sessionId);
  await loaded;
  await sleep(800);
  for (const k of keys.split(',').filter(Boolean)) {
    const def = KEYS[k] ?? { key: k, code: k };
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...def }, sessionId);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...def }, sessionId);
    await sleep(150);
  }
  await sleep(waitMs);
  // CLIP="x,y,w,h" captures just that CSS-pixel region at 2x, handy for inspecting small controls.
  const clip = process.env.CLIP ? (([x, y, width, height]) => ({ x, y, width, height, scale: 2 }))(process.env.CLIP.split(',').map(Number)) : undefined;
  const { result: { data } } = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) }, sessionId);
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`${name}.png <- ${url}`);
}
ws.close(); shutdown();
