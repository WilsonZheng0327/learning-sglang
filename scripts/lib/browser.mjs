// Headless Chrome over the DevTools protocol, using Node 22's built-in WebSocket. Shared by shot.mjs and transcript.mjs.
// Finds the browser in this order: $CHROME, chromium / google-chrome on PATH, then the usual macOS install.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const findChrome = () => {
  if (process.env.CHROME) return process.env.CHROME;
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    try { return execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  }
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(mac)) return mac;
  throw new Error('no Chrome found: install chromium, or set CHROME=/path/to/chrome');
};

export const KEYS = {
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight' },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft' },
};

// Starts a headless browser on `port`. Returns tab() to open a page and close() to shut everything down.
export async function launch({ port, width = 1440, height = 900 }) {
  const profile = mkdtempSync(join(tmpdir(), 'cdp-'));
  // background tabs are throttled by default, which stalls Svelte's transitions: old scenes never leave, new text never fades in.
  // These flags keep every tab running at full speed, so several tabs can render at once.
  const chrome = spawn(findChrome(), ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore' });
  const shutdown = () => {
    chrome.once('exit', () => { try { rmSync(profile, { recursive: true, force: true }); } catch {} });
    chrome.kill();
  };

  let version;
  for (let i = 0; i < 50 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(100); }
  }
  if (!version) { shutdown(); throw new Error('the browser did not start'); }

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

  // One tab at a fixed viewport. Every method runs against this tab only.
  const tab = async ({ scale = 1 } = {}) => {
    const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank', newWindow: true });
    const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false }, sessionId);
    return {
      async goto(url) { const loaded = waitEvent('Page.loadEventFired', sessionId); await send('Page.navigate', { url }, sessionId); await loaded; },
      async press(name) {
        const def = KEYS[name] ?? { key: name, code: name };
        await send('Input.dispatchKeyEvent', { type: 'keyDown', ...def }, sessionId);
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...def }, sessionId);
      },
      async evaluate(expression) {
        const { result } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
        return result.result.value;
      },
      async screenshot(clip) {
        const { result: { data } } = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) }, sessionId);
        return Buffer.from(data, 'base64');
      },
      close: () => send('Target.closeTarget', { targetId }),
    };
  };

  return { tab, close: () => { ws.close(); shutdown(); } };
}
