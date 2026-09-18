// Write a plain-text transcript of every ready chapter: each step's caption, every piece of text drawn
// on the stage once its transitions and phases have settled, and the chapter's <details> prose.
// The output is transcript/NN-slug.md, one file per chapter, meant for reading and diffing — not editing.
// A caption that wraps past the three-line budget is flagged in the file and on stdout.
// Edit the component or the MDX, then regenerate.
//
// usage: node scripts/transcript.mjs [baseUrl]        (default http://localhost:4321/learning-sglang)
//   WAIT=ms      settle time per step (default 3400, enough for the slowest within-step phases)
//   ONLY=13      regenerate one chapter by number
//   JOBS=4       chapters rendered concurrently, one tab each
//   LINES=3      caption line budget to flag against
// Needs a dev or preview server on baseUrl, chromium on PATH, and Node 22+.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = (process.argv[2] ?? 'http://localhost:4321/learning-sglang').replace(/\/$/, '');
const waitMs = Number(process.env.WAIT) || 3400;
const jobs = Number(process.env.JOBS) || 4;
const budget = Number(process.env.LINES) || 3;   // the caption budget from StepControls: three lines at 60ch
const only = process.env.ONLY ? Number(process.env.ONLY) : null;
const outDir = 'transcript';
mkdirSync(outDir, { recursive: true });

// ---- the roster, straight from chapters.ts -----------------------------------------------------------------
const roster = readFileSync('src/chapters.ts', 'utf8');
const chapters = [...roster.matchAll(/\{\s*part:\s*'(\w+)',\s*slug:\s*'([^']+)',\s*title:\s*(?:'([^']*)'|"([^"]*)"),\s*hook:\s*'([^']*)',\s*ready:\s*(true|false)\s*\}/g)]
  .map((m, i) => ({ n: i + 1, part: m[1], slug: m[2], title: m[3] ?? m[4], hook: m[5], ready: m[6] === 'true' }))
  .filter((c) => c.ready && (only === null || c.n === only));
if (!chapters.length) { console.error('no ready chapters matched'); process.exit(1); }

// ---- chromium over the DevTools protocol, as in shot.mjs -----------------------------------------------------
const port = 9334;
const profile = mkdtempSync(join(tmpdir(), 'transcript-'));
const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
const shutdown = () => {
  chrome.once('exit', () => { try { rmSync(profile, { recursive: true, force: true }); } catch {} });
  chrome.kill();
};
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
const evaluate = async (expression, sessionId) => {
  const { result } = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
};

// Runs in the page. Returns the step counter, the caption, and the stage's text in document order:
// every SVG <text> plus any HTML leaf element inside .canvas (the viz container every component uses).
const EXTRACT = `(() => {
  const norm = (s) => s.replace(/\\s+/g, ' ').trim();
  const counter = norm(document.querySelector('.counter')?.textContent ?? '');
  const m = counter.match(/(\\d+)\\s*\\/\\s*(\\d+)/);
  const caption = norm(document.querySelector('.caption')?.textContent ?? '');
  const cap = document.querySelector('.caption'); const span = cap?.querySelector('span');
  const lh = cap ? parseFloat(getComputedStyle(cap).lineHeight) : 0;
  const capLines = span && lh ? Math.round(span.getBoundingClientRect().height / lh) : 0;
  const root = document.querySelector('.canvas') ?? document.querySelector('.viz');
  const lines = [];
  const walk = (el) => {
    if (el.tagName === 'text' || el.tagName === 'TEXT') { const t = norm(el.textContent); if (t) lines.push(t); return; }
    if (el.tagName === 'title' || el.tagName === 'defs' || el.tagName === 'style') return;
    const kids = [...el.children];
    if (!kids.length && !(el instanceof SVGElement)) { const t = norm(el.textContent); if (t) lines.push(t); return; }
    kids.forEach(walk);
  };
  if (root) walk(root);
  return { step: m ? Number(m[1]) : NaN, total: m ? Number(m[2]) : NaN, caption, capLines, lines };
})()`;

const RIGHT = { key: 'ArrowRight', code: 'ArrowRight' };
const press = async (sessionId) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...RIGHT }, sessionId);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...RIGHT }, sessionId);
};

const prose = (slug) => {
  const mdx = readFileSync(`src/pages/ch/${slug}.mdx`, 'utf8');
  const m = mdx.match(/<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/);
  return m ? { summary: m[1].trim(), body: m[2].trim() } : null;
};

const transcribe = async (ch) => {
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  const url = `${base}/ch/${ch.slug}/?step=1`;
  const loaded = waitEvent('Page.loadEventFired', sessionId);
  await send('Page.navigate', { url }, sessionId);
  await loaded;
  await sleep(waitMs);

  const steps = [];
  for (let guard = 0; guard < 60; guard++) {
    const s = await evaluate(EXTRACT, sessionId);
    if (!Number.isFinite(s.step)) throw new Error(`${ch.slug}: could not read the step counter`);
    steps.push(s);
    if (s.step >= s.total) break;
    await press(sessionId);
    await sleep(waitMs);
  }
  await send('Target.closeTarget', { targetId });

  const component = (readFileSync(`src/pages/ch/${ch.slug}.mdx`, 'utf8').match(/components\/(\w+)\.svelte/) ?? [])[1];
  const out = [];
  out.push(`# ${String(ch.n).padStart(2, '0')} · ${ch.title}`, '', ch.hook, '');
  out.push(`Source: \`src/pages/ch/${ch.slug}.mdx\`${component ? ` · \`src/components/${component}.svelte\`` : ''}`);
  out.push(`Generated by \`node scripts/transcript.mjs\` — edit the source, not this file.`, '');
  for (const s of steps) {
    out.push(`## Step ${s.step} of ${s.total}`, '');
    const over = s.capLines > budget ? ` (${s.capLines} lines: OVERFLOWS the ${budget}-line caption budget)` : '';
    out.push(`**Caption${over}.** ${s.caption}`, '');
    if (s.lines.length) { out.push('**On stage.**', ''); for (const l of s.lines) out.push(`- ${l}`); out.push(''); }
  }
  const p = prose(ch.slug);
  if (p) { out.push(`## Prose · ${p.summary}`, '', p.body, ''); }
  writeFileSync(join(outDir, `${ch.slug}.md`), out.join('\n'));
  const overflowing = steps.filter((s) => s.capLines > budget).map((s) => s.step);
  console.log(`${ch.slug}: ${steps.length} steps${overflowing.length ? ` · captions over ${budget} lines at step ${overflowing.join(', ')}` : ''}`);
};

// a small pool: `jobs` chapters at a time, each in its own tab
const queue = [...chapters];
const workers = Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  while (queue.length) { const ch = queue.shift(); try { await transcribe(ch); } catch (e) { console.error(`${ch.slug}: ${e.message}`); } }
});
await Promise.all(workers);

// the index: one line per chapter
const all = [...roster.matchAll(/slug:\s*'([^']+)',\s*title:\s*(?:'([^']*)'|"([^"]*)"),\s*hook:\s*'([^']*)',\s*ready:\s*(true|false)/g)]
  .map((m, i) => ({ n: i + 1, slug: m[1], title: m[2] ?? m[3], hook: m[4], ready: m[5] === 'true' }));
const index = ['# Transcript', '',
  'Plain text of every ready chapter: each step\'s caption, the text drawn on the stage once it has settled, and the prose under the stage.',
  'Read it to check wording and numbers across chapters without opening the components. It is generated — edit the source, then run',
  '`node scripts/transcript.mjs` against a running dev server (`ONLY=13` for one chapter).', '', '| # | chapter | steps |', '|---|---|---|'];
for (const c of all.filter((c) => c.ready)) {
  let n = '';
  try { n = String((readFileSync(join(outDir, `${c.slug}.md`), 'utf8').match(/^## Step /gm) ?? []).length); } catch {}
  index.push(`| ${String(c.n).padStart(2, '0')} | [${c.title}](${c.slug}.md) | ${n} |`);
}
writeFileSync(join(outDir, 'README.md'), index.join('\n') + '\n');
ws.close(); shutdown();
