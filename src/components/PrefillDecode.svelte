<script lang="ts">
  import { fade, fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { Tween } from 'svelte/motion';
  import StepControls from './StepControls.svelte';
  import type { NavLink } from '../chapters';
  let { prev, next }: { prev?: NavLink; next?: NavLink } = $props();

  // ---- Numbers: Llama-3-8B in bf16 on one H100 ---------------------------------------------
  const W_GB = 16;               // weights
  const BW = 3.35;               // TB/s HBM
  const FLOPS = 989;             // TFLOP/s dense bf16
  const GFLOP_PER_TOKEN = 16;    // ≈ 2 × params
  const KB_PER_CTX_TOKEN = 128;  // kv cache, from chapter 3
  const cacheGB = (ctx: number) => (ctx * KB_PER_CTX_TOKEN) / 1e6;
  const tMem = (ctx: number) => ((W_GB + cacheGB(ctx)) / BW) * 1000 / 1000;   // ms  (GB / (TB/s) = ms)
  const tComp = (n: number) => (n * GFLOP_PER_TOKEN) / FLOPS;                  // ms  (GFLOP / (TFLOP/s) = ms)
  const fmt = (ms: number) => (ms < 0.1 ? ms.toFixed(3) : ms < 10 ? ms.toFixed(1) : ms.toFixed(0)) + ' ms';
  const balance = Math.round(tMem(0) / tComp(1) / 50) * 50;   // ≈300 tokens per step; rounded so the chart, caption and math note agree

  // ---- Script -------------------------------------------------------------------------------
  type Scene = 'intro' | 'anatomy' | 'timeline';
  interface Step {
    caption: string; scene: Scene; n?: number; ctx?: number;
    focus?: 'weights' | 'tokens' | 'idle'; bars?: boolean; roofline?: boolean; cache?: boolean;
  }
  const steps: Step[] = [
    { scene: 'intro', caption: `The first step has a name: <b>prefill</b>. Every step after: <b>decode</b>. Same model, same weights, very different work.` },
    { scene: 'anatomy', n: 5, focus: 'weights', caption: `Every step, the GPU streams the whole model out of memory and through its compute units. ${W_GB} GB for an 8B model, however many tokens are in the step.` },
    { scene: 'anatomy', n: 5, focus: 'tokens', caption: `Prefill: five tokens ride that one read. The weights are loaded once and used five times, and all five tokens' math runs in parallel.` },
    { scene: 'anatomy', n: 1, focus: 'tokens', caption: `Decode: one token. The same ${W_GB} GB read, one token's worth of math.` },
    { scene: 'anatomy', n: 1, bars: true, caption: `On an H100, reading ${W_GB} GB takes about ${fmt(tMem(0))}. One token's math takes ${fmt(tComp(1))}. The step takes ${fmt(tMem(0))}, and the compute units sit idle for most of it.` },
    { scene: 'anatomy', n: 1, bars: true, cache: true, ctx: 8192, caption: `Decode also drags the KV cache through. Nothing at seven tokens, another 1 GB at 8k, on every single step. Longer context, slower tokens.` },
    { scene: 'anatomy', n: 2000, bars: true, caption: `A 2000-token prompt flips it: ${fmt(tComp(2000))} of math against the same ${fmt(tMem(0))} of reading. Prefill is compute-bound. Decode is memory-bound.` },
    { scene: 'anatomy', n: 2000, roofline: true, caption: `The balance point is around ${balance} tokens per step. Below it the GPU is a memory pump. Above it, a calculator.` },
    { scene: 'timeline', caption: `In a chat, this is what you feel. The pause before the first word is prefill. The typing speed after it is decode, one memory read per token.` },
    { scene: 'anatomy', n: 1, bars: true, focus: 'idle', caption: `So during decode, the GPU is idle almost all the time, waiting on memory to produce one token for one person. What if it weren't one person?` },
  ];

  let step = $state(0);
  $effect(() => {
    const q = Number(new URLSearchParams(window.location.search).get('step'));
    if (q >= 1 && q <= steps.length) step = q - 1;
  });
  const cur = $derived(steps[step]);
  const n = $derived(cur.n ?? 1);
  const ctx = $derived(cur.cache ? (cur.ctx ?? 8192) : 7);
  const memMs = $derived(tMem(cur.cache ? ctx : 0));
  const compMs = $derived(tComp(n));
  const busy = $derived(compMs / Math.max(compMs, memMs));

  // animated bar widths
  const MS_MAX = 35, BAR_X = 130, BAR_W = 460;
  const px = (ms: number) => Math.max(2, (Math.min(ms, MS_MAX) / MS_MAX) * BAR_W);
  const memW = new Tween(0, { duration: 500, easing: cubicOut });
  const compW = new Tween(0, { duration: 500, easing: cubicOut });
  const busyW = new Tween(0, { duration: 500, easing: cubicOut });
  $effect(() => { memW.target = px(memMs); compW.target = px(compMs); busyW.target = Math.max(2, busy * 130); });

  // ---- Geometry -----------------------------------------------------------------------------
  const W = 720, H = 400;
  // intro: same token layout as earlier chapters
  const tokens = ['The', ' capital', ' of', ' France', ' is', ' Paris', '.'];
  const PROMPT_N = 5;
  const cols = (() => { let x = 100; return tokens.map((t) => { const w = Math.round(t.length * 8.2 + 20); const c = { t, x, w, cx: x + w / 2 }; x += w + 6; return c; }); })();
  // anatomy boxes
  const HBM = { x: 40, y: 70, w: 180, h: 150 };
  const CU = { x: 300, y: 70, w: 180, h: 150 };
  const MID = HBM.y + HBM.h / 2;
  const CHIP = { w: 34, h: 16, x: 560 };
  const chipCount = $derived(n >= 100 ? 5 : n);
  const showBusy = $derived(cur.bars || cur.focus === 'idle');
  // roofline chart
  const RL = { x: 130, y: 244, w: 460, h: 104 };
  const rlX = (tok: number) => RL.x + (Math.log2(tok) / 12) * RL.w;
  const rlY = (ms: number) => RL.y + RL.h - (Math.min(ms, MS_MAX) / MS_MAX) * RL.h;
  const compLine = Array.from({ length: 13 }, (_, i) => 2 ** i).map((t) => `${rlX(t).toFixed(1)},${rlY(tComp(t)).toFixed(1)}`).join(' ');
  // chat timeline
  const TL = { x: 90, y: 150, w: 560, ms: 90 };
  const tlPx = (ms: number) => TL.x + (ms / TL.ms) * TL.w;
  const ttft = tComp(2000);
  const decodeTicks = Math.floor((TL.ms - ttft) / tMem(0));
</script>

<figure class="viz">
  <div class="canvas">
    <svg viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Prefill vs decode, step {step + 1}">
      <!-- Intro: the two kinds of step, named -->
      {#if cur.scene === 'intro'}
        {@const a = cols[0].x} {@const b = cols[PROMPT_N - 1].x + cols[PROMPT_N - 1].w}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="118" class="rowlabel">tokens</text>
          {#each cols as c, i}
            <rect x={c.x} y="100" width={c.w} height="28" rx="6" fill={i < PROMPT_N ? 'var(--accent-soft)' : 'var(--gen-soft)'} stroke={i < PROMPT_N ? 'var(--accent)' : 'var(--gen)'} stroke-width="1.5" />
            <text x={c.cx} y="118" text-anchor="middle" class="tok">{c.t.replace(/^ /, '␣')}</text>
          {/each}
          <text x="16" y="178" class="rowlabel">steps</text>
          <g in:fly={{ y: 10, duration: 300 }}>
            <rect x={a} y="158" width={b - a} height="34" rx="6" fill="var(--accent)" opacity="0.9" />
            <text x={(a + b) / 2} y="175" text-anchor="middle" class="steplabel">step 1 · prefill</text>
            <text x={(a + b) / 2} y="187" text-anchor="middle" class="steplabel small">5 tokens, one pass, fills the cache</text>
          </g>
          {#each cols.slice(PROMPT_N) as _, i}
            {@const x = b + 8 + i * 72}
            <g in:fly={{ y: 10, delay: 250 + i * 150, duration: 300 }}>
              <rect {x} y="158" width="64" height="34" rx="6" fill="var(--gen)" opacity="0.9" />
              <text x={x + 32} y="175" text-anchor="middle" class="steplabel">step {i + 2}</text>
              <text x={x + 32} y="187" text-anchor="middle" class="steplabel small">decode</text>
            </g>
          {/each}
          <text x={b + 8} y="215" class="tag" in:fade={{ delay: 700 }}>1 token each, reads the cache</text>
        </g>
      {/if}

      <!-- Anatomy of one step on the GPU -->
      {#if cur.scene === 'anatomy'}
        <g transition:fade={{ duration: 250 }}>
          <!-- HBM -->
          <rect x={HBM.x} y={HBM.y} width={HBM.w} height={HBM.h} rx="10" fill="#fbfaf7" stroke="var(--line)" />
          <text x={HBM.x + 12} y={HBM.y + 18} class="boxtitle">memory (HBM)</text>
          <rect x={HBM.x + 14} y={HBM.y + 30} width={HBM.w - 28} height="74" rx="6" fill="var(--accent-soft)" stroke="var(--accent)" class:pulse={cur.focus === 'weights'} />
          <text x={HBM.x + HBM.w / 2} y={HBM.y + 60} text-anchor="middle" class="slab">weights</text>
          <text x={HBM.x + HBM.w / 2} y={HBM.y + 78} text-anchor="middle" class="slab strong">{W_GB} GB</text>
          {#if cur.cache}
            <g in:fade>
              <rect x={HBM.x + 14} y={HBM.y + 110} width={HBM.w - 28} height="28" rx="6" fill="#cffafe" stroke="#0891b2" />
              <text x={HBM.x + HBM.w / 2} y={HBM.y + 128} text-anchor="middle" class="slab">kv cache · {cacheGB(ctx).toFixed(1)} GB @ {ctx / 1024}k</text>
            </g>
          {:else}
            <rect x={HBM.x + 14} y={HBM.y + 110} width={HBM.w - 28} height="10" rx="3" fill="#cffafe" stroke="#0891b2" />
            <text x={HBM.x + HBM.w / 2} y={HBM.y + 134} text-anchor="middle" class="tag">kv cache · {(cacheGB(7) * 1000).toFixed(1)} MB</text>
          {/if}

          <!-- read arrow -->
          <line x1={HBM.x + HBM.w + 4} y1={MID} x2={CU.x - 12} y2={MID} class="wire" class:active={cur.focus === 'weights'} />
          <polygon points="{CU.x - 12},{MID - 7} {CU.x - 12},{MID + 7} {CU.x - 2},{MID}" fill={cur.focus === 'weights' ? 'var(--accent)' : 'var(--faint)'} />
          <text x={(HBM.x + HBM.w + CU.x) / 2} y={MID - 14} text-anchor="middle" class="tag strong">read {W_GB}{cur.cache ? ` + ${cacheGB(ctx).toFixed(0)}` : ''} GB</text>
          <text x={(HBM.x + HBM.w + CU.x) / 2} y={MID + 22} text-anchor="middle" class="tag">every step</text>

          <!-- compute -->
          <rect x={CU.x} y={CU.y} width={CU.w} height={CU.h} rx="10" fill="#fbfaf7" stroke={cur.focus === 'idle' ? 'var(--eos)' : 'var(--line)'} stroke-width={cur.focus === 'idle' ? 2 : 1} />
          <text x={CU.x + 12} y={CU.y + 18} class="boxtitle">compute</text>
          <text x={CU.x + CU.w / 2} y={CU.y + 62} text-anchor="middle" class="slab">{n.toLocaleString()} × {GFLOP_PER_TOKEN} GFLOP</text>
          <text x={CU.x + CU.w / 2} y={CU.y + 82} text-anchor="middle" class="slab strong">= {n * GFLOP_PER_TOKEN >= 1000 ? `${((n * GFLOP_PER_TOKEN) / 1000).toFixed(0)} TFLOP` : `${n * GFLOP_PER_TOKEN} GFLOP`}</text>
          {#if showBusy}
            <g in:fade>
              <rect x={CU.x + 25} y={CU.y + 112} width="130" height="12" rx="3" fill="var(--line)" />
              <rect x={CU.x + 25} y={CU.y + 112} width={busyW.current} height="12" rx="3" fill={busy > 0.5 ? 'var(--accent)' : 'var(--eos)'} />
              <text x={CU.x + CU.w / 2} y={CU.y + 140} text-anchor="middle" class="tag" class:idle={cur.focus === 'idle'}>busy {(busy * 100).toFixed(busy < 0.1 ? 1 : 0)}% of the step</text>
            </g>
          {/if}

          <!-- tokens in -->
          <text x={CHIP.x + CHIP.w / 2} y={HBM.y + 18} text-anchor="middle" class="boxtitle">{n.toLocaleString()} token{n === 1 ? '' : 's'} in</text>
          {#each Array(chipCount) as _, i (i)}
            {@const y = MID - (chipCount * (CHIP.h + 3)) / 2 + i * (CHIP.h + 3)}
            <g in:fly={{ x: 30, delay: i * 60, duration: 250 }} out:fade={{ duration: 150 }}>
              <rect x={CHIP.x} y={y} width={CHIP.w} height={CHIP.h} rx="4" fill={n === 1 ? 'var(--gen-soft)' : 'var(--accent-soft)'} stroke={n === 1 ? 'var(--gen)' : 'var(--accent)'} class:pulse={cur.focus === 'tokens'} style="animation-delay: {i * 80}ms" />
              <text x={CHIP.x + CHIP.w / 2} y={y + 12} text-anchor="middle" class="cell">{n >= 100 && i === chipCount - 1 ? '…' : 'tok'}</text>
            </g>
          {/each}
          <line x1={CHIP.x - 6} y1={MID} x2={CU.x + CU.w + 12} y2={MID} class="wire" class:active={cur.focus === 'tokens'} />
          <polygon points="{CU.x + CU.w + 12},{MID - 6} {CU.x + CU.w + 12},{MID + 6} {CU.x + CU.w + 2},{MID}" fill={cur.focus === 'tokens' ? 'var(--accent)' : 'var(--faint)'} />
        </g>
      {/if}

      <!-- Time per step -->
      {#if cur.scene === 'anatomy' && cur.bars && !cur.roofline}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="262" class="rowlabel">time per step</text>
          <text x={BAR_X - 10} y="290" text-anchor="end" class="rowlabel">memory</text>
          <rect x={BAR_X} y="278" width={memW.current} height="16" rx="3" fill="#0891b2" />
          <text x={BAR_X + memW.current + 8} y="290" class="num">{fmt(memMs)}</text>
          <text x={BAR_X - 10} y="318" text-anchor="end" class="rowlabel">compute</text>
          <rect x={BAR_X} y="306" width={compW.current} height="16" rx="3" fill="var(--accent)" />
          <text x={BAR_X + compW.current + 8} y="318" class="num">{fmt(compMs)}</text>
          <text x={BAR_X} y="350" class="legend">step ≈ <tspan class="strong">{fmt(Math.max(memMs, compMs))}</tspan>, waiting on <tspan class="strong">{memMs >= compMs ? 'memory' : 'compute'}</tspan></text>
        </g>
      {/if}

      <!-- Roofline-ish: tokens per step vs time -->
      {#if cur.roofline}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y={RL.y - 6} class="rowlabel">time per step vs tokens per step</text>
          <line x1={RL.x} y1={RL.y + RL.h} x2={RL.x + RL.w} y2={RL.y + RL.h} stroke="var(--line)" />
          {#each [1, 10, 100, 1000, 4096] as t}
            <text x={rlX(t)} y={RL.y + RL.h + 14} text-anchor="middle" class="tag">{t >= 1000 ? `${Math.round(t / 1000)}k` : t}</text>
          {/each}
          <line x1={RL.x} y1={rlY(memMs)} x2={RL.x + RL.w} y2={rlY(memMs)} stroke="#0891b2" stroke-width="2" />
          <text x={RL.x + RL.w + 6} y={rlY(memMs) + 4} class="tag" fill="#0891b2">memory {fmt(tMem(0))}</text>
          <polyline points={compLine} fill="none" stroke="var(--accent)" stroke-width="2" />
          <text x={rlX(2048) - 4} y={rlY(tComp(2048)) - 8} text-anchor="end" class="tag" fill="var(--accent)">compute</text>
          <line x1={rlX(balance)} y1={RL.y + 8} x2={rlX(balance)} y2={RL.y + RL.h} stroke="var(--faint)" stroke-dasharray="3 3" />
          <circle cx={rlX(balance)} cy={rlY(memMs)} r="4" fill="white" stroke="var(--fg)" stroke-width="1.5" />
          <text x={rlX(balance)} y={RL.y + 4} text-anchor="middle" class="tag strong">≈{balance} tokens</text>
          <text x={rlX(17)} y={RL.y + RL.h + 30} text-anchor="middle" class="tag">← memory-bound · decode lives here</text>
          <text x={rlX(1200)} y={RL.y + RL.h + 30} text-anchor="middle" class="tag">compute-bound · long prefill →</text>
          {#each [{ t: 1, l: 'decode' }, { t: 5, l: 'prefill (5)' }, { t: 2000, l: 'prefill (2000)' }] as p}
            <circle cx={rlX(p.t)} cy={rlY(Math.max(tMem(0), tComp(p.t)))} r="3.5" fill={p.t === 1 ? 'var(--gen)' : 'var(--accent)'} />
          {/each}
        </g>
      {/if}

      <!-- Chat timeline -->
      {#if cur.scene === 'timeline'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y={TL.y - 30} class="rowlabel">one reply, 2000-token prompt</text>
          <line x1={TL.x} y1={TL.y + 60} x2={TL.x + TL.w} y2={TL.y + 60} stroke="var(--line)" />
          {#each [0, 30, 60, 90] as ms}
            <text x={tlPx(ms)} y={TL.y + 76} text-anchor="middle" class="tag">{ms} ms</text>
          {/each}
          <rect x={tlPx(0)} y={TL.y} width={tlPx(ttft) - tlPx(0)} height="40" rx="6" fill="var(--accent)" opacity="0.9" in:fly={{ x: -20, duration: 400 }} />
          <text x={(tlPx(0) + tlPx(ttft)) / 2} y={TL.y + 18} text-anchor="middle" class="steplabel">prefill</text>
          <text x={(tlPx(0) + tlPx(ttft)) / 2} y={TL.y + 31} text-anchor="middle" class="steplabel small">{fmt(ttft)} of math</text>
          {#each Array(decodeTicks) as _, i}
            {@const x0 = tlPx(ttft + i * tMem(0))}
            <rect x={x0 + 1} y={TL.y} width={tlPx(tMem(0)) - tlPx(0) - 2} height="40" rx="4" fill="var(--gen)" opacity="0.85" in:fly={{ y: -10, delay: 400 + i * 120, duration: 250 }} />
          {/each}
          <line x1={tlPx(ttft)} y1={TL.y - 14} x2={tlPx(ttft)} y2={TL.y + 60} stroke="var(--fg)" stroke-dasharray="3 3" />
          <text x={tlPx(ttft) + 6} y={TL.y - 6} class="tag strong" in:fade={{ delay: 500 }}>first token</text>
          <text x={tlPx(ttft + 2 * tMem(0))} y={TL.y + 100} class="legend" in:fade={{ delay: 1400 }}>then one token every <tspan class="strong">{fmt(tMem(0))}</tspan>, each one a full read of the weights</text>
        </g>
      {/if}
    </svg>
  </div>

  <StepControls {step} total={steps.length} caption={cur.caption} interval={3000} {prev} {next} onchange={(s) => (step = s)} />
</figure>

<style>
  .viz { margin: 0; display: flex; flex-direction: column; min-height: 0; }
  .canvas { flex: 1 1 auto; min-height: 0; border: 1px solid var(--line); border-radius: 16px; background: white; padding: 0.75rem; box-shadow: 0 1px 2px rgba(0,0,0,0.03), 0 12px 32px -20px rgba(0,0,0,0.12); }
  svg { display: block; width: 100%; height: 100%; font-family: var(--sans); }
  .rowlabel { font-family: var(--mono); font-size: 11px; fill: var(--muted); }
  .tok { font-family: var(--mono); font-size: 12.5px; fill: var(--fg); }
  .cell { font-family: var(--mono); font-size: 10px; fill: var(--fg); }
  .num { font-family: var(--mono); font-size: 11px; fill: var(--fg); }
  .tag { font-size: 10px; fill: var(--muted); }
  .tag.strong { fill: var(--fg); font-weight: 600; }
  .tag.idle { fill: var(--eos); font-weight: 600; }
  .steplabel { font-size: 11px; fill: white; font-weight: 600; }
  .steplabel.small { font-size: 9px; font-weight: 400; opacity: 0.9; }
  .boxtitle { font-family: var(--mono); font-size: 10.5px; fill: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .slab { font-size: 12px; fill: var(--fg); }
  .slab.strong { font-weight: 650; font-size: 14px; }
  .legend { font-size: 11.5px; fill: var(--fg); }
  .legend .strong { font-weight: 650; }
  .wire { stroke: var(--line); stroke-width: 6; stroke-linecap: round; transition: stroke 300ms; }
  .wire.active { stroke: var(--accent); stroke-dasharray: 10 8; animation: march 600ms linear infinite; }
  rect.pulse { animation: pulse 900ms ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.45 } }
  @keyframes march { to { stroke-dashoffset: -36 } }
</style>
