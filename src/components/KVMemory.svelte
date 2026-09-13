<script lang="ts">
  import { fade, fly } from 'svelte/transition';
  import StepControls from './StepControls.svelte';
  import { chapters, type NavLink } from '../chapters';
  let { prev, next }: { prev?: NavLink; next?: NavLink } = $props();
  const chNum = (slug: string) => chapters.findIndex((c) => c.slug === slug) + 1;
  const CH_PREFIX = chNum('08-prefix-caching'), CH_DISAGG = chNum('13-disaggregation');

  // ---- Numbers, same as before: Llama-3-8B bf16 on one H100 ------------------------------------
  const W_GB = 16, HBM_GB = 80, KB_TOK = 128, BW = 3.35, FLOPS = 989, GFLOP = 16;
  const tMem = W_GB / BW;
  const tComp = (n: number) => (n * GFLOP) / FLOPS;
  const BALANCE = Math.round(tMem / tComp(1) / 50) * 50;
  const seqGB = (ctx: number) => (ctx * KB_TOK) / 1e6;
  const capAt = (ctx: number) => Math.floor((HBM_GB - W_GB) / seqGB(ctx));
  const BAR = { x: 40, y: 120, w: 640, h: 44 };
  const pxPerGB = BAR.w / HBM_GB;
  const running = [24, 36, 12, 48, 20, 32, 40, 16];          // context length in k tokens
  const usedGB = running.reduce((a, c) => a + seqGB(c * 1024), 0);

  // ---- Reservation scene ---------------------------------------------------------------------------------
  const MAXCTX = 8192;
  const reserved = [0.35, 0.6, 0.2, 0.5, 0.15];
  const wasted = 1 - reserved.reduce((a, b) => a + b, 0) / reserved.length;
  const churn: { gb: number; kind: 'live' | 'hole' }[] = [
    { gb: 0.6, kind: 'live' }, { gb: 0.4, kind: 'hole' }, { gb: 1.0, kind: 'live' }, { gb: 0.6, kind: 'hole' },
    { gb: 0.8, kind: 'live' }, { gb: 0.3, kind: 'hole' }, { gb: 1.0, kind: 'live' }, { gb: 0.2, kind: 'hole' }, { gb: 0.9, kind: 'live' },
  ];
  const churnFree = churn.filter((c) => c.kind === 'hole').reduce((a, c) => a + c.gb, 0);

  // ---- Page pool ------------------------------------------------------------------------------------------
  const COLS = 20, ROWS = 6, CELL = 24, GAP = 3;
  const PG = { x: 60, y: 108 };
  const STRIP = { x: 300, y: 60 };                              // where a newcomer's pages appear before they land
  const owners = ['#2f5bea', '#7c3aed', '#0891b2', '#16a34a', '#d97706', '#db2777', '#0f766e'];
  const pageOwner = (i: number) => { const h = (i * 2654435761) >>> 0; return h % 100 < 26 ? -1 : (h >>> 8) % 5; };
  const pages0 = Array.from({ length: COLS * ROWS }, (_, i) => pageOwner(i));
  const freeOf = (arr: number[]) => arr.map((o, i) => (o < 0 ? i : -1)).filter((i) => i >= 0);
  const pick = (idx: number[], n: number) => Array.from({ length: n }, (_, k) => idx[Math.floor(((k + 0.5) * idx.length) / n)]);
  const allocA = pick(freeOf(pages0), 5);                                             // req 6 takes 5 pages
  const pages1 = pages0.map((o, i) => (allocA.includes(i) ? 5 : o));
  const FINISHED = 4;                                                                 // req 5 finishes
  const freed = pages1.map((o, i) => (o === FINISHED ? i : -1)).filter((i) => i >= 0);
  const pages2 = pages1.map((o) => (o === FINISHED ? -1 : o));
  const allocB = pick(freed, 8);                                                      // req 7 takes 8 of the freed pages
  const pages3 = pages2.map((o, i) => (allocB.includes(i) ? 6 : o));
  const cellXY = (i: number) => ({ x: PG.x + (i % COLS) * (CELL + GAP), y: PG.y + Math.floor(i / COLS) * (CELL + GAP) });

  // ---- Script ----------------------------------------------------------------------------------------------
  type Scene = 'room' | 'caps' | 'reserve' | 'alloc' | 'free' | 'closing';
  interface Step { caption: string; scene: Scene; base?: number[]; alloc?: number[]; owner?: number; name?: string }
  const steps: Step[] = [
    { scene: 'room', caption: `The scheduler checks for room for KV cache before admitting a new request. ${HBM_GB} GB on the card, ${W_GB} GB of weights, and everything else is room for KV cache. Running requests fill it a token per step.` },
    { scene: 'caps', caption: `How many fit? Same card, three context lengths. At 4k tokens each, ${capAt(4096)} requests. At 8k, ${capAt(8192)}. At 32k, ${capAt(32768)}. Compute could take ${BALANCE} per step; memory never lets it get there.` },
    { scene: 'reserve', caption: `The naive way: reserve each request's maximum length up front, in one contiguous block. Most never use it, and finished requests leave holes no newcomer fits into. Most of the card, wasted.` },
    { scene: 'alloc', base: pages0, alloc: allocA, owner: 5, name: 'req 6', caption: `<b>Paging</b>: cut the room into fixed-size pages. A newcomer's cache isn't one block; it's however many pages it needs, taken from anywhere that's free, with the page numbers written in its table. No holes, nothing reserved.` },
    { scene: 'free', caption: `When a request finishes, its pages go straight back to the pool. No compaction, nobody else moves. The pool just has more free pages, wherever they happen to be.` },
    { scene: 'alloc', base: pages2, alloc: allocB, owner: 6, name: 'req 7', caption: `The next newcomer takes what it needs from those, or any other free pages. Its table lists them, and the attention kernel follows the table. vLLM pages 16 tokens at a time; SGLang, 1.` },
    { scene: 'closing', caption: `Admission is a count: free pages against pages needed. Yes: admit and write the table. No: wait for a finish, or retract the newest request. Sharing pages between requests: next chapter.` },
  ];

  let step = $state(0);
  $effect(() => {
    const q = Number(new URLSearchParams(window.location.search).get('step'));
    if (q >= 1 && q <= steps.length) step = q - 1;
  });
  const cur = $derived(steps[step]);

  // within-step animation phases, replayed whenever the step changes
  let phase = $state(0);
  $effect(() => {
    const sc = steps[step].scene;
    phase = 0;
    const plan = sc === 'alloc' ? [500, 1200, 1900, 2800] : sc === 'free' ? [700, 1800] : [];
    const timers = plan.map((ms, i) => setTimeout(() => (phase = i + 1), ms));
    return () => timers.forEach(clearTimeout);
  });
  const W = 720, H = 400;
</script>

<figure class="viz">
  <div class="canvas">
    <svg viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="KV memory, step {step + 1}">
      <defs>
        <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="#e0f2fe" />
          <line x1="0" y1="0" x2="0" y2="6" stroke="#0891b2" stroke-width="1.2" opacity="0.5" />
        </pattern>
      </defs>

      <!-- Room: the card, total room, and what's empty now -->
      {#if cur.scene === 'room'}
        {@const x0 = BAR.x + W_GB * pxPerGB}
        {@const xUsed = x0 + usedGB * pxPerGB}
        {@const xEnd = BAR.x + BAR.w}
        <g transition:fade={{ duration: 250 }}>
          <text x={BAR.x} y={BAR.y - 56} class="rowlabel">one H100 · {HBM_GB} GB of HBM</text>
          <rect x={BAR.x} y={BAR.y} width={BAR.w} height={BAR.h} rx="8" fill="white" stroke="var(--line)" />
          <rect x={BAR.x} y={BAR.y} width={W_GB * pxPerGB} height={BAR.h} rx="8" fill="var(--accent)" opacity="0.9" />
          <text x={BAR.x + (W_GB * pxPerGB) / 2} y={BAR.y + 27} text-anchor="middle" class="steplabel">weights {W_GB} GB</text>
          {#each running as ctxK, i}
            {@const xs = x0 + running.slice(0, i).reduce((a, c) => a + seqGB(c * 1024), 0) * pxPerGB}
            {@const w = seqGB(ctxK * 1024) * pxPerGB - 1}
            <rect x={xs} y={BAR.y + 1} width={w} height={BAR.h - 2} rx="2" fill="#0891b2" opacity={0.5 + 0.3 * (i % 2)} in:fly={{ x: -6, delay: 150 + i * 90, duration: 250 }} />
            {#if w > 26}<text x={xs + w / 2} y={BAR.y + 27} text-anchor="middle" class="steplabel">{ctxK}k</text>{/if}
          {/each}
          <!-- brackets -->
          <g in:fade={{ delay: 1100 }}>
            <path d="M {x0} {BAR.y + BAR.h + 8} V {BAR.y + BAR.h + 16} H {xEnd} V {BAR.y + BAR.h + 8}" fill="none" stroke="var(--fg)" stroke-width="1.5" />
            <text x={(x0 + xEnd) / 2} y={BAR.y + BAR.h + 32} text-anchor="middle" class="tag strong">room for KV cache · {HBM_GB - W_GB} GB</text>
          </g>
          <g in:fade={{ delay: 1600 }}>
            <path d="M {x0} {BAR.y - 8} V {BAR.y - 16} H {xUsed - 2} V {BAR.y - 8}" fill="none" stroke="#0891b2" stroke-width="1.5" />
            <text x={(x0 + xUsed) / 2} y={BAR.y - 22} text-anchor="middle" class="tag" fill="#0891b2">in use · {usedGB.toFixed(0)} GB, {running.length} requests</text>
            <path d="M {xUsed + 2} {BAR.y - 8} V {BAR.y - 16} H {xEnd} V {BAR.y - 8}" fill="none" stroke="var(--gen)" stroke-width="1.5" />
            <text x={(xUsed + xEnd) / 2} y={BAR.y - 22} text-anchor="middle" class="tag strong" fill="var(--gen)">empty right now · {(HBM_GB - W_GB - usedGB).toFixed(0)} GB</text>
          </g>
          <text x={BAR.x} y={BAR.y + 110} class="legend muted" in:fade={{ delay: 2100 }}>each running request grows {KB_TOK} KB per step; the empty part is what newcomers can be admitted into</text>
        </g>
      {/if}

      <!-- Caps: the same card at three context lengths -->
      {#if cur.scene === 'caps'}
        <g transition:fade={{ duration: 250 }}>
          {#each [4096, 8192, 32768] as ctx, r}
            {@const y = 70 + r * 98}
            {@const n = capAt(ctx)}
            {@const h = 34}
            <g in:fade={{ delay: r * 300 }}>
              <text x={BAR.x} y={y - 10} class="rowlabel">every request at {ctx / 1024}k tokens of context · {(seqGB(ctx) * 1000).toFixed(0)} MB each</text>
              <rect x={BAR.x} {y} width={BAR.w} height={h} rx="7" fill="white" stroke="var(--line)" />
              <rect x={BAR.x} {y} width={W_GB * pxPerGB} height={h} rx="7" fill="var(--accent)" opacity="0.9" />
              <text x={BAR.x + (W_GB * pxPerGB) / 2} y={y + 22} text-anchor="middle" class="steplabel">weights</text>
              {#each Array(n) as _, i}
                {@const x = BAR.x + W_GB * pxPerGB + i * seqGB(ctx) * pxPerGB}
                <rect {x} y={y + 1} width={Math.max(0.8, seqGB(ctx) * pxPerGB - 1)} height={h - 2} fill="#0891b2" opacity={0.55 + 0.35 * (i % 2)} in:fly={{ x: -5, delay: r * 300 + 100 + i * (ctx > 8192 ? 40 : 8), duration: 200 }} />
              {/each}
              <text x={BAR.x + BAR.w} y={y + h + 16} text-anchor="end" class="legend"><tspan class="strong">{n} requests</tspan> fit</text>
            </g>
          {/each}
          <text x={BAR.x} y="366" class="legend muted" in:fade={{ delay: 1400 }}>chapter 5's sweet spot was {BALANCE} requests decoding at once; the most this card ever holds is {capAt(4096)}, and that's at a short context</text>
        </g>
      {/if}

      <!-- Naive reservation: contiguous max-length blocks, then fragmentation -->
      {#if cur.scene === 'reserve'}
        {@const R = { x: 40, y: 92, w: 640, h: 40 }}
        {@const perReq = R.w / reserved.length}
        {@const C = { x: 40, y: 220, w: 640, h: 40 }}
        {@const cpx = C.w / churn.reduce((a, c) => a + c.gb, 0)}
        <g transition:fade={{ duration: 250 }}>
          <text x={R.x} y={R.y - 14} class="rowlabel">reserve the maximum for everyone · {MAXCTX / 1024}k tokens = {(seqGB(MAXCTX)).toFixed(0)} GB per request</text>
          {#each reserved as used, i}
            {@const x = R.x + i * perReq}
            <g in:fly={{ x: -6, delay: i * 120, duration: 250 }}>
              <rect x={x + 1} y={R.y} width={perReq - 2} height={R.h} rx="5" fill="url(#hatch)" stroke="#0891b2" stroke-opacity="0.5" />
              <rect x={x + 1} y={R.y} width={(perReq - 2) * used} height={R.h} rx="5" fill="#0891b2" opacity="0.85" />
              <text x={x + 4} y={R.y + R.h + 14} class="tag">req {i + 1} · using {(used * MAXCTX / 1024).toFixed(1)}k of {MAXCTX / 1024}k</text>
            </g>
          {/each}
          <g in:fade={{ delay: 800 }}>
            <rect x={R.x} y={R.y + R.h + 26} width="12" height="12" rx="2" fill="url(#hatch)" stroke="#0891b2" stroke-opacity="0.5" /><text x={R.x + 18} y={R.y + R.h + 36} class="tag">reserved, never written: <tspan class="strong">{Math.round(wasted * 100)}%</tspan> of the cache budget</text>
          </g>
          <text x={C.x} y={C.y - 14} class="rowlabel" in:fade={{ delay: 1300 }}>a while later · requests finished at different times</text>
          {#each churn as seg, i}
            {@const x = C.x + churn.slice(0, i).reduce((a, c) => a + c.gb, 0) * cpx}
            <g in:fade={{ delay: 1300 + i * 80 }}>
              {#if seg.kind === 'live'}
                <rect x={x + 1} y={C.y} width={seg.gb * cpx - 2} height={C.h} rx="5" fill="#0891b2" opacity="0.85" />
              {:else}
                <rect x={x + 1} y={C.y} width={seg.gb * cpx - 2} height={C.h} rx="5" fill="white" stroke="var(--line)" stroke-dasharray="4 3" />
                <text x={x + (seg.gb * cpx) / 2} y={C.y + 24} text-anchor="middle" class="tag">{seg.gb} GB</text>
              {/if}
            </g>
          {/each}
          <g in:fade={{ delay: 2300 }}>
            <rect x={C.x} y={C.y + C.h + 16} width={1.0 * cpx} height="22" rx="5" fill="none" stroke="var(--eos)" stroke-width="1.5" stroke-dasharray="5 3" />
            <text x={C.x + (1.0 * cpx) / 2} y={C.y + C.h + 31} text-anchor="middle" class="tag" fill="var(--eos)">1 GB</text>
            <text x={C.x + 1.0 * cpx + 12} y={C.y + C.h + 31} class="legend">← a newcomer needs 1 GB in one piece · <tspan class="strong">{churnFree.toFixed(1)} GB free</tspan>, no hole big enough. Fragmentation.</text>
          </g>
        </g>
      {/if}

      <!-- Page pool: allocate a newcomer (animated), or free a finished request (animated) -->
      {#if cur.scene === 'alloc' || cur.scene === 'free'}
        {@const base = cur.scene === 'alloc' ? cur.base! : pages1}
        {@const alloc = cur.scene === 'alloc' ? cur.alloc! : []}
        {@const owner = cur.owner ?? 0}
        {@const need = alloc.length}
        <g transition:fade={{ duration: 250 }}>
          <text x={PG.x} y="40" class="rowlabel">the {HBM_GB - W_GB} GB after the weights, cut into pages · {COLS * ROWS} shown of many thousands</text>

          <!-- the grid (fades in once; steps 4 → 5 → 6 keep it mounted so nothing replays) -->
          {#each base as o, i}
            {@const { x, y } = cellXY(i)}
            {@const landing = alloc.includes(i)}
            {@const leaving = cur.scene === 'free' && o === FINISHED}
            {#if o < 0 || landing}
              <rect {x} {y} width={CELL} height={CELL} rx="4" fill="white" stroke="var(--line)" stroke-dasharray="3 2" />
            {/if}
            {#if o >= 0 && !landing && !leaving}
              <rect {x} {y} width={CELL} height={CELL} rx="4" fill={owners[o]} opacity="0.85" />
            {/if}
            {#if leaving}
              <rect {x} {y} width={CELL} height={CELL} rx="4" fill="white" stroke={phase >= 1 ? 'var(--gen)' : 'var(--line)'} stroke-dasharray="3 2" />
              {#if phase < 1}
                <rect {x} {y} width={CELL} height={CELL} rx="4" fill={owners[o]} opacity="0.85" out:fade={{ duration: 700 }} />
              {/if}
            {/if}
            {#if landing && phase >= 3}
              {@const k = alloc.indexOf(i)}
              <rect {x} {y} width={CELL} height={CELL} rx="4" fill={owners[owner]} opacity="0.9"
                    in:fly={{ x: STRIP.x + k * (CELL + GAP) - x, y: STRIP.y - y, delay: k * 90, duration: 650 }} />
            {/if}
          {/each}

          <!-- legend -->
          {#each owners.slice(0, cur.scene === 'alloc' && owner === 6 ? 7 : cur.scene === 'alloc' ? 6 : 6) as c, r}
            {@const gone = (cur.scene === 'free' && r === FINISHED && phase >= 1) || (cur.scene === 'alloc' && owner === 6 && r === FINISHED)}
            <rect x="608" y={PG.y + r * 20} width="12" height="12" rx="2" fill={c} opacity={gone ? 0.25 : 0.85} />
            <text x="626" y={PG.y + r * 20 + 10} class="tag" opacity={gone ? 0.5 : 1}>req {r + 1}{gone ? ' · done' : ''}</text>
          {/each}
          <rect x="608" y={PG.y + 7 * 20} width="12" height="12" rx="2" fill="white" stroke="var(--line)" stroke-dasharray="3 2" /><text x="626" y={PG.y + 7 * 20 + 10} class="tag">free</text>

          {#if cur.scene === 'alloc'}
            <!-- the newcomer: one block, then pages, then gone into the grid -->
            {#if phase >= 1}
              <text x={PG.x} y={STRIP.y + 16} class="legend" in:fade><tspan class="strong">{cur.name}</tspan> arrives · needs {need} pages</text>
            {/if}
            {#if phase === 1}
              <rect x={STRIP.x} y={STRIP.y} width={need * (CELL + GAP) - GAP} height={CELL} rx="5" fill={owners[owner]} opacity="0.9" transition:fade={{ duration: 250 }} />
            {/if}
            {#if phase === 2}
              {#each Array(need) as _, k}
                <rect x={STRIP.x + k * (CELL + GAP)} y={STRIP.y} width={CELL} height={CELL} rx="4" fill={owners[owner]} opacity="0.9" in:fly={{ x: -k * 4, duration: 300 }} out:fade={{ duration: 100 }} />
              {/each}
            {/if}
            {#if phase === 2}
              <text x={STRIP.x + need * (CELL + GAP) + 10} y={STRIP.y + 16} class="tag" in:fade>split into {need} pages, not one block</text>
            {/if}
            {#if phase >= 3}
              <text x={STRIP.x} y={STRIP.y + 16} class="tag" in:fade={{ delay: 400 }}>→ any {need} free pages, wherever they are</text>
            {/if}
            {#if phase >= 4}
              <g in:fade>
                <text x={PG.x} y={PG.y + ROWS * (CELL + GAP) + 26} class="legend"><tspan class="strong">{cur.name}'s page table:</tspan> {alloc.join(', ')}</text>
                <text x={PG.x} y={PG.y + ROWS * (CELL + GAP) + 48} class="legend muted">attention reads the cache through this list; nothing needs to be next to anything</text>
              </g>
            {/if}
          {:else}
            {#if phase >= 1}
              <text x={PG.x} y={STRIP.y + 16} class="legend" in:fade><tspan class="strong">req {FINISHED + 1}</tspan> finished · its {freed.length} pages go back to the pool</text>
            {/if}
            {#if phase >= 2}
              <text x={PG.x} y={PG.y + ROWS * (CELL + GAP) + 26} class="legend" in:fade>{freeOf(pages2).length} free pages now, scattered · nobody else moved</text>
            {/if}
          {/if}
        </g>
      {/if}

      <!-- Closing: admission as a decision, and what a request actually holds -->
      {#if cur.scene === 'closing'}
        {@const MC = 13}
        {@const MG = 2}
        {@const MX = 372}
        {@const MY = 214}
        <g transition:fade={{ duration: 250 }}>
          <defs>
            <marker id="kvarrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#b8b4aa" />
            </marker>
          </defs>
          <text x="40" y="52" class="rowlabel">admitting a newcomer</text>
          <g in:fly={{ y: 8, duration: 300 }}>
            <rect x="40" y="70" width="290" height="56" rx="12" fill="white" stroke="var(--fg)" stroke-width="1.5" />
            <text x="185" y="94" text-anchor="middle" class="slab strong small">free pages ≥ pages needed?</text>
            <text x="185" y="114" text-anchor="middle" class="tag">needed: one per running request, plus the prompt</text>
          </g>
          <g in:fly={{ y: 8, delay: 300, duration: 300 }}>
            <path d="M 110 126 V 168" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#kvarrow)" />
            <text x="118" y="152" class="tag strong" fill="#16a34a">yes</text>
            <rect x="40" y="172" width="290" height="62" rx="12" fill="#fbfaf7" stroke="#16a34a" />
            <text x="56" y="196" class="slab strong small">admit</text>
            <text x="56" y="216" class="tag">take any free pages, write the page table</text>
          </g>
          <g in:fly={{ y: 8, delay: 600, duration: 300 }}>
            <path d="M 250 126 V 148 H 280 V 262" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#kvarrow)" />
            <text x="258" y="144" class="tag strong" fill="var(--eos)">no</text>
            <rect x="40" y="266" width="290" height="112" rx="12" fill="#fbfaf7" stroke="var(--eos)" />
            <text x="56" y="290" class="slab strong small">wait</text>
            <text x="56" y="310" class="tag">until a running request finishes</text>
            <text x="56" y="326" class="tag">and frees its pages</text>
            <text x="56" y="346" class="tag">pool dry and nobody finishing?</text>
            <text x="56" y="362" class="tag"><tspan class="strong">retract</tspan> the newest request, re-prefill it later</text>
          </g>

          <!-- what a request holds: a list of page numbers -->
          <g in:fade={{ delay: 900 }}>
            <rect x="350" y="70" width="350" height="318" rx="12" fill="#fbfaf7" stroke={owners[6]} />
            <text x="366" y="94" class="boxtitle">what req 7 holds</text>
            <text x="366" y="118" class="slab small">not a region of memory, a <tspan class="strong">page table</tspan>:</text>
            {#each allocB as pg, k}
              {@const cx = 366 + k * 38}
              <rect x={cx} y="132" width="32" height="22" rx="5" fill={owners[6]} opacity="0.9" />
              <text x={cx + 16} y="147" text-anchor="middle" class="steplabel">{pg}</text>
              <text x={cx + 16} y="168" text-anchor="middle" class="tag">{k + 1}</text>
            {/each}
            <text x="366" y="196" class="tag">the same pages, where they actually sit in the pool:</text>
            {#each pages3 as o, i}
              {@const x = MX + (i % COLS) * (MC + MG)}
              {@const y = MY + Math.floor(i / COLS) * (MC + MG)}
              {@const mine = o === 6}
              <rect {x} {y} width={MC} height={MC} rx="2" fill={mine ? owners[6] : o < 0 ? 'white' : '#e6e3db'} stroke={mine ? 'none' : o < 0 ? 'var(--line)' : 'none'} opacity={mine ? 0.95 : 1} />
              {#if mine}<text x={x + MC / 2} y={y + MC - 3.5} text-anchor="middle" class="tiny">{allocB.indexOf(i) + 1}</text>{/if}
            {/each}
            <text x="366" y="328" class="tag">attention walks the list in order;</text>
            <text x="366" y="344" class="tag">the pages never need to be adjacent</text>
            <text x="366" y="364" class="tag muted">same page in two lists → chapter {CH_PREFIX}</text>
            <text x="366" y="380" class="tag muted">a list sent to another GPU → chapter {CH_DISAGG}</text>
          </g>
          <text x="40" y="394" class="tag muted" in:fade={{ delay: 1500 }}>SGLang: <tspan class="mono">TokenToKVPool</tspan> · <tspan class="mono">req_to_token</tspan> · <tspan class="mono">retract_decode</tspan></text>
        </g>
      {/if}
    </svg>
  </div>

  <StepControls {step} total={steps.length} caption={cur.caption} interval={4200} {prev} {next} onchange={(s) => (step = s)} />
</figure>

<style>
  .viz { margin: 0; display: flex; flex-direction: column; min-height: 0; }
  .canvas { flex: 1 1 auto; min-height: 0; border: 1px solid var(--line); border-radius: 16px; background: white; padding: 0.75rem; box-shadow: 0 1px 2px rgba(0,0,0,0.03), 0 12px 32px -20px rgba(0,0,0,0.12); }
  svg { display: block; width: 100%; height: 100%; font-family: var(--sans); }
  .rowlabel { font-family: var(--mono); font-size: 11px; fill: var(--muted); }
  .mono { font-family: var(--mono); font-size: 10px; }
  .tag { font-size: 10px; fill: var(--muted); }
  .tag.strong, .tag .strong { fill: var(--fg); font-weight: 600; }
  .steplabel { font-size: 10px; fill: white; font-weight: 600; }
  .tiny { font-size: 8px; fill: white; font-weight: 700; }
  .boxtitle { font-family: var(--mono); font-size: 10.5px; fill: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .tag.muted { fill: var(--faint); }
  .slab { font-size: 12px; fill: var(--fg); }
  .slab.strong { font-weight: 650; font-size: 14px; }
  .slab.small { font-size: 11.5px; }
  .slab.strong.small { font-size: 12px; }
  .legend { font-size: 11.5px; fill: var(--fg); }
  .legend .strong { font-weight: 650; }
  .legend.muted, .legend .muted { fill: var(--muted); font-weight: 400; }
</style>
