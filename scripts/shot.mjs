// Screenshot pages with real wall-clock waits so Svelte transitions finish.
// usage: node scripts/shot.mjs <outDir> <waitMs> name=url [name=url ...]
//   name=url|Key,Key   presses keys after load: "|ArrowRight,ArrowRight" steps twice
//   CLIP=x,y,w,h       captures just that CSS-pixel region, at 2x
//   SCALE=2            a full-page capture at 2x
// Finds Chrome itself (see lib/browser.mjs); Node 22+.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, sleep } from './lib/browser.mjs';

const [outDir, waitMsArg, ...pairs] = process.argv.slice(2);
if (!outDir || !pairs.length) { console.error('usage: shot.mjs <outDir> <waitMs> name=url ...'); process.exit(1); }
const waitMs = Number(waitMsArg) || 2500;
mkdirSync(outDir, { recursive: true });

const browser = await launch({ port: 9333 });
const page = await browser.tab({ scale: Number(process.env.SCALE) || 1 });
const clip = process.env.CLIP ? (([x, y, width, height]) => ({ x, y, width, height, scale: 2 }))(process.env.CLIP.split(',').map(Number)) : undefined;
for (const pair of pairs) {
  const eq = pair.indexOf('='); const name = pair.slice(0, eq);
  const [url, keys = ''] = pair.slice(eq + 1).split('|');
  await page.goto(url);
  await sleep(800);
  for (const k of keys.split(',').filter(Boolean)) { await page.press(k); await sleep(150); }
  await sleep(waitMs);
  writeFileSync(join(outDir, `${name}.png`), await page.screenshot(clip));
  console.log(`${name}.png <- ${url}`);
}
browser.close();
