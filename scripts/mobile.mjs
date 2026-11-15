// Check every page at phone widths: the home page and every step of every ready chapter, each at 360, 390 and 430 px wide.
// It flags, on stdout:
//   overflow   the page scrolls sideways (document wider than the viewport), with the widest elements that cause it
//   caption    the caption's text is cut off (taller than its box)
//   controls   a step-control button or link runs past the viewport's edge
// Exits 1 if anything was flagged, so it can gate a commit.
//
// usage: node scripts/mobile.mjs [baseUrl]        (default http://localhost:4321/learning-sglang)
//   WIDTHS=360,390,430   phone widths to check (CSS px, 844 tall)
//   ONLY=13              one chapter by number
//   WAIT=ms              settle time per step (default 900; layout does not wait on the within-step animations)
// Needs a dev or preview server on baseUrl and Node 22+; finds Chrome itself (see lib/browser.mjs).
import { readFileSync } from 'node:fs';
import { launch, sleep } from './lib/browser.mjs';

const base = (process.argv[2] ?? 'http://localhost:4321/learning-sglang').replace(/\/$/, '');
const widths = (process.env.WIDTHS ?? '360,390,430').split(',').map(Number);
const only = process.env.ONLY ? Number(process.env.ONLY) : null;
const waitMs = Number(process.env.WAIT) || 900;

const roster = readFileSync('src/chapters.ts', 'utf8');
const chapters = [...roster.matchAll(/slug:\s*'([^']+)',[\s\S]*?ready:\s*(true|false)/g)]
  .map((m, i) => ({ n: i + 1, slug: m[1], ready: m[2] === 'true' }))
  .filter((c) => c.ready && (only === null || c.n === only));

// Runs in the page. Returns the step counter and every layout break it can see.
const CHECK = `(() => {
  const vw = document.documentElement.clientWidth;
  const out = [];
  const name = (el) => el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
  if (document.documentElement.scrollWidth > vw + 1) {
    // the outermost elements that stick out past the right edge (SVG internals are clipped by their <svg>, so skip them)
    const wide = [...document.querySelectorAll('body *')].filter((el) => !el.closest('svg') || el.tagName === 'svg')
      .filter((el) => el.getBoundingClientRect().right > vw + 1)
      .filter((el) => !el.parentElement || el.parentElement.getBoundingClientRect().right <= vw + 1);
    out.push('overflow: page is ' + document.documentElement.scrollWidth + 'px wide in a ' + vw + 'px viewport · ' + wide.slice(0, 4).map(name).join(', '));
  }
  const cap = document.querySelector('.caption'); const span = cap?.querySelector('span');
  if (cap && span && span.getBoundingClientRect().height > cap.getBoundingClientRect().height + 1) out.push('caption: text is clipped by its box');
  for (const el of document.querySelectorAll('.controls button, .controls a')) {
    const r = el.getBoundingClientRect();
    if (r.width && (r.right > vw + 1 || r.left < -1)) out.push('controls: ' + name(el) + ' runs past the edge');
  }
  const m = (document.querySelector('.counter')?.textContent ?? '').match(/(\\d+)\\s*\\/\\s*(\\d+)/);
  return { step: m ? +m[1] : 0, total: m ? +m[2] : 0, out };
})()`;

const browser = await launch({ port: 9335 });
let flagged = 0;
for (const w of widths) {
  const page = await browser.tab({ width: w, height: 844, mobile: true });
  if (only === null) {
    await page.goto(`${base}/`); await sleep(waitMs);
    const r = await page.evaluate(CHECK);
    for (const o of r.out) { console.log(`${w}px · home · ${o}`); flagged++; }
  }
  for (const ch of chapters) {
    const hits = [];
    for (let n = 1, total = 1; n <= total; n++) {
      await page.goto(`${base}/ch/${ch.slug}/?step=${n}`); await sleep(waitMs);
      const r = await page.evaluate(CHECK);
      total = r.total || 1;
      for (const o of r.out) hits.push(`step ${n} · ${o}`);
    }
    for (const h of hits) console.log(`${w}px · ${ch.slug} · ${h}`);
    flagged += hits.length;
  }
  await page.close();
}
console.log(flagged ? `${flagged} layout break(s) at phone width` : `no layout breaks at ${widths.join(', ')} px`);
browser.close();
process.exit(flagged ? 1 : 0);
