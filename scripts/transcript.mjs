// Write a plain-text transcript of every ready chapter: each step's caption, every piece of text drawn
// on the stage once its transitions and phases have settled, and the chapter's <details> prose.
// The output is transcript/NN-slug.md, one file per chapter, meant for reading and diffing — not editing.
//
// It also checks each step against the layout rules in AGENTS.md, flags breaks in the file, and lists them on stdout:
//   caption     wraps past the three-line budget
//   clipped     stage text runs past the SVG's edge
//   overlap     two pieces of stage text cover each other
//   footnote    a .footnote that is not centred at the bottom of the stage, or a grey .legend.muted line left over
//   dot         a single .pt dot (a lone statement takes none), or a leftover round bullet
// Edit the component or the MDX, then regenerate.
//
// usage: node scripts/transcript.mjs [baseUrl]        (default http://localhost:4321/learning-sglang)
//   WAIT=ms      settle time per step (default 3400, enough for the slowest within-step phases)
//   ONLY=13      regenerate one chapter by number
//   JOBS=4       chapters rendered concurrently, one tab each
//   LINES=3      caption line budget to flag against
// Needs a dev or preview server on baseUrl and Node 22+; finds Chrome itself (see lib/browser.mjs).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, sleep } from './lib/browser.mjs';

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

// Runs in the page. Returns the step counter, the caption, the stage's text in document order
// (every SVG <text> plus any HTML leaf inside .canvas, the container every viz uses), and the rule checks.
const EXTRACT = `(() => {
  const norm = (s) => s.replace(/\\s+/g, ' ').trim();
  const counter = norm(document.querySelector('.counter')?.textContent ?? '');
  const m = counter.match(/(\\d+)\\s*\\/\\s*(\\d+)/);
  const caption = norm(document.querySelector('.caption')?.textContent ?? '');
  const cap = document.querySelector('.caption'); const span = cap?.querySelector('span');
  const lh = cap ? parseFloat(getComputedStyle(cap).lineHeight) : 0;
  const capLines = span && lh ? Math.round(span.getBoundingClientRect().height / lh) : 0;
  const root = document.querySelector('.canvas') ?? document.querySelector('.viz');
  const svg = root?.querySelector('svg');
  const vb = svg?.viewBox?.baseVal;
  const clipped = [], overlaps = [], rules = [];

  // what the reader can see: skip text faded out, hidden, or inside a foreignObject
  const shown = (el) => {
    for (let e = el, o = 1; e && e !== svg; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      o *= Number(cs.opacity); if (o < 0.05) return false;
    }
    return true;
  };
  const texts = svg ? [...svg.querySelectorAll('text')].filter((t) => !t.closest('foreignObject') && norm(t.textContent) && shown(t)) : [];
  const cls = (t) => t.classList;

  if (vb?.width) {
    const ctm = svg.getScreenCTM();
    const left = ctm.e + vb.x * ctm.a, right = ctm.e + (vb.x + vb.width) * ctm.a;
    for (const t of texts) {
      const r = t.getBoundingClientRect();
      if (r.width && (r.right > right - 2 * ctm.a || r.left < left)) clipped.push(norm(t.textContent));
    }
    // overlap: two boxes on screen that cross by more than a pixel each way (transforms included)
    const boxes = texts.map((t) => ({ t, r: t.getBoundingClientRect() }));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].r, b = boxes[j].r;
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 1 && h > 1) overlaps.push(norm(boxes[i].t.textContent).slice(0, 60) + '  ×  ' + norm(boxes[j].t.textContent).slice(0, 60));
    }
    // footnotes sit centred at the bottom; grey legend lines are footnotes or they are text
    for (const t of texts) {
      if (cls(t).contains('footnote')) {
        const x = t.x.baseVal[0]?.value ?? 0, y = t.y.baseVal[0]?.value ?? 0;
        const centred = getComputedStyle(t).textAnchor === 'middle' && Math.abs(x - vb.width / 2) < 2;
        if (!centred || y < vb.height - 40) rules.push('footnote not centred at the bottom: ' + norm(t.textContent).slice(0, 70));
      }
      if (cls(t).contains('legend') && cls(t).contains('muted')) rules.push('grey legend line (make it a .footnote, or regular text): ' + norm(t.textContent).slice(0, 70));
    }
    // a footnote needs clear space: no drawn shape under it
    const shapes = [...svg.querySelectorAll('rect, path, line, circle, polygon, polyline, ellipse')]
      .filter((s) => !s.closest('defs, marker, foreignObject') && shown(s)).map((s) => s.getBoundingClientRect()).filter((r) => r.width || r.height);
    for (const t of texts.filter((t) => cls(t).contains('footnote'))) {
      const a = t.getBoundingClientRect();
      if (shapes.some((b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1))
        rules.push('footnote crosses a drawn shape: ' + norm(t.textContent).slice(0, 70));
    }
    const dots = texts.filter((t) => cls(t).contains('pt'));
    if (dots.length === 1) rules.push('a lone .pt dot: a single statement takes none');
    if (svg.querySelector('circle.dot')) rules.push('a round bullet: use the .pt centre dot');
  }

  // the transcript itself: a dot joins the statement after it, and footnotes say so
  const lines = [];
  let dot = false;
  const walk = (el) => {
    if (el.tagName === 'text' || el.tagName === 'TEXT') {
      const t = norm(el.textContent); if (!t) return;
      if (el.classList.contains('pt')) { dot = true; return; }
      lines.push((el.classList.contains('footnote') ? '_footnote:_ ' : dot ? '· ' : '') + t); dot = false; return;
    }
    if (el.tagName === 'title' || el.tagName === 'defs' || el.tagName === 'style') return;
    const kids = [...el.children];
    if (!kids.length && !(el instanceof SVGElement)) { const t = norm(el.textContent); if (t) lines.push(t); return; }
    kids.forEach(walk);
  };
  if (root) walk(root);
  return { step: m ? Number(m[1]) : NaN, total: m ? Number(m[2]) : NaN, caption, capLines, lines, clipped, overlaps, rules };
})()`;

const prose = (slug) => {
  const mdx = readFileSync(`src/pages/ch/${slug}.mdx`, 'utf8');
  const m = mdx.match(/<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/);
  return m ? { summary: m[1].trim(), body: m[2].trim() } : null;
};

const browser = await launch({ port: 9334 });

const transcribe = async (ch) => {
  // each step opened by its ?step=N link, which every viz honours: keyboard focus is unreliable across several headless windows
  const page = await browser.tab();
  const steps = [];
  for (let n = 1, total = 1; n <= total; n++) {
    await page.goto(`${base}/ch/${ch.slug}/?step=${n}`);
    await sleep(waitMs);
    const s = await page.evaluate(EXTRACT);
    if (s.step !== n) throw new Error(`${ch.slug}: opened step ${n}, the counter says ${s.step}`);
    steps.push(s);
    total = s.total;
  }
  await page.close();

  const component = (readFileSync(`src/pages/ch/${ch.slug}.mdx`, 'utf8').match(/(components\/[\w/]+\.svelte)/) ?? [])[1];
  const out = [];
  out.push(`# ${String(ch.n).padStart(2, '0')} · ${ch.title}`, '', ch.hook, '');
  out.push(`Source: \`src/pages/ch/${ch.slug}.mdx\`${component ? ` · \`src/${component}\`` : ''}`);
  out.push(`Generated by \`node scripts/transcript.mjs\` — edit the source, not this file.`, '');
  const flag = (title, items) => { if (items.length) { out.push(`**${title}**`, ''); for (const l of items) out.push(`- ${l}`); out.push(''); } };
  for (const s of steps) {
    out.push(`## Step ${s.step} of ${s.total}`, '');
    const over = s.capLines > budget ? ` (${s.capLines} lines: OVERFLOWS the ${budget}-line caption budget)` : '';
    out.push(`**Caption${over}.** ${s.caption}`, '');
    if (s.lines.length) { out.push('**On stage.**', ''); for (const l of s.lines) out.push(`- ${l}`); out.push(''); }
    flag('CLIPPED · runs past the edge of the stage.', s.clipped);
    flag('OVERLAP · stage text covering other stage text.', s.overlaps);
    flag('RULE · breaks a layout rule in AGENTS.md.', s.rules);
  }
  const p = prose(ch.slug);
  if (p) { out.push(`## Prose · ${p.summary}`, '', p.body, ''); }
  writeFileSync(join(outDir, `${ch.slug}.md`), out.join('\n'));

  const at = (pred) => steps.filter(pred).map((s) => s.step).join(', ');
  const report = [
    [steps.some((s) => s.capLines > budget), `captions over ${budget} lines at step ${at((s) => s.capLines > budget)}`],
    [steps.some((s) => s.clipped.length), `clipped stage text at step ${at((s) => s.clipped.length)}`],
    [steps.some((s) => s.overlaps.length), `overlapping text at step ${at((s) => s.overlaps.length)}`],
    [steps.some((s) => s.rules.length), `layout rules broken at step ${at((s) => s.rules.length)}`],
  ].filter(([hit]) => hit).map(([, msg]) => msg);
  console.log(`${ch.slug}: ${steps.length} steps${report.length ? ' · ' + report.join(' · ') : ''}`);
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
browser.close();
