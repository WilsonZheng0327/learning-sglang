<script lang="ts">
  import { fly, fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import StepControls from './StepControls.svelte';
  import type { NavLink } from '../chapters';
  let { prev, next }: { prev?: NavLink; next?: NavLink } = $props();

  // ---- Data --------------------------------------------------------------------------------
  const tokens = ['The', ' capital', ' of', ' France', ' is', ' Paris', '.'];
  const PROMPT_N = 5, MAX_N = tokens.length;
  const scores: Record<number, number[]> = {
    5: [0.3, 1.4, 0.1, 1.8, 0.6, 2.2],
    6: [0.2, 1.1, 0.1, 1.5, 0.5, 1.9, 0.8],
  };
  const softmax = (a: number[]) => {
    const m = Math.max(...a); const e = a.map((v) => Math.exp(v - m)); const s = e.reduce((x, y) => x + y, 0);
    return e.map((v) => v / s);
  };
  // Llama-3-8B-ish: 32 layers, 8 kv heads, head dim 128, bf16, k and v.
  const KB_PER_TOKEN = (32 * 8 * 128 * 2 * 2) / 1024;

  // ---- Script -------------------------------------------------------------------------------
  interface Step {
    caption: string; n: number; cached: number;
    compute?: number[]; flyIn?: boolean; store?: boolean; dropQ?: boolean;
    attend?: number; whyNotQ?: boolean; cost?: boolean; contrast?: boolean;
  }
  const all5 = [0, 1, 2, 3, 4];
  const steps: Step[] = [
    { n: 5, cached: 0, caption: `Same sequence, same layer. This time we keep what we compute.` },
    { n: 5, cached: 0, compute: all5, caption: `First step: all five tokens at once. Each gets its q, k and v, exactly as before.` },
    { n: 5, cached: 5, compute: all5, store: true, dropQ: true, caption: `Attention runs as before. Then, instead of throwing k and v away, we file them. Five slots. The queries were used, so they go.` },
    { n: 6, cached: 5, compute: [5], flyIn: true, caption: `Decode step. Paris arrives. Only Paris gets an x, a q, a k and a v. One column of work, not six.` },
    { n: 6, cached: 6, compute: [5], store: true, caption: `Its k and v go into the cache. Slot six.` },
    { n: 6, cached: 6, compute: [5], attend: 5, caption: `Its query reads every key in the cache and blends every value in the cache. Same result as recomputing, because the cache holds exactly what recomputing would have produced.` },
    { n: 7, cached: 7, compute: [6], flyIn: true, store: true, attend: 6, caption: `Next token, same routine. One column of compute, one more slot, one read of the whole cache.` },
    { n: 7, cached: 7, compute: [6], whyNotQ: true, caption: `Why not keep q too? Nobody asks for it later. A query is used on the step it's made, and its output is consumed right there.` },
    { n: 7, cached: 7, compute: [6], cost: true, caption: `The cache isn't free. Every token keeps a k and a v in every head of every layer. For an 8B model that's about ${KB_PER_TOKEN} KB per token, per sequence.` },
    { n: 7, cached: 7, compute: [6], cost: true, contrast: true, caption: `Look at the two kinds of step. The first crunched five tokens and wrote five slots. Every step since computes one token and reads the whole cache. Two very different jobs.` },
  ];

  let step = $state(0);
  $effect(() => {
    const q = Number(new URLSearchParams(window.location.search).get('step'));
    if (q >= 1 && q <= steps.length) step = q - 1;
  });
  const cur = $derived(steps[step]);

  // ---- Geometry (viewBox units) --------------------------------------------------------------
  const W = 720, H = 400;
  const X0 = 100, charW = 8.2, padX = 10, gap = 6, tokH = 28, seqY = 36;
  const boxW = (t: string) => Math.round(t.length * charW + padX * 2);
  // all MAX_N columns are laid out up front so cache slots have a home before their token exists
  const allCols = (() => {
    let x = X0;
    return tokens.map((t) => { const w = boxW(t); const c = { t, x, w, cx: x + w / 2 }; x += w + gap; return c; });
  })();
  const cols = $derived(allCols.slice(0, cur.n));

  const CW = 32, CH = 20;
  const ROW = { x: 92, q: 120, k: 148, v: 176 } as const;
  type Row = keyof typeof ROW;
  const COLOR: Record<Row, [string, string]> = {
    x: ['#eeece6', '#8a8780'], q: ['#ede9fe', '#7c3aed'], k: ['#cffafe', '#0891b2'], v: ['#dcfce7', '#16a34a'],
  };
  const CACHE = { y: 222, h: 118 };
  const CK = 242, CV = 278, CQ = 312;      // cache rows: k, v, and the ghost q row
  const outX = allCols[MAX_N - 1].x + allCols[MAX_N - 1].w + 48;
  const sub = (i: number) => String(i).replace(/\d/g, (d) => '₀₁₂₃₄₅₆₇₈₉'[+d]);

  const computed = (c: number) => (cur.compute ?? []).includes(c);
  const isDecode = $derived(cur.n > PROMPT_N);
  const w = $derived(cur.attend !== undefined ? softmax(scores[cur.attend]) : []);
  const cacheKB = $derived(cur.cached * KB_PER_TOKEN);
</script>

<figure class="viz">
  <div class="canvas">
    <svg viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="The KV cache, step {step + 1}">
      <!-- Contrast brackets: first step vs every step after -->
      {#if cur.contrast}
        {@const a = allCols[0].x} {@const b = allCols[PROMPT_N - 1].x + allCols[PROMPT_N - 1].w}
        {@const c = allCols[PROMPT_N].x} {@const d = allCols[cur.n - 1].x + allCols[cur.n - 1].w}
        <g in:fade>
          <path d="M {a} 26 V 20 H {b} V 26" fill="none" stroke="var(--accent)" stroke-width="1.5" />
          <text x={(a + b) / 2} y="14" text-anchor="middle" class="tag strong">first step · five tokens, one pass, writes the cache</text>
          <path d="M {c} 26 V 20 H {d} V 26" fill="none" stroke="var(--gen)" stroke-width="1.5" />
          <text x={c} y="14" class="tag strong gen">every step after · one token, reads the whole cache</text>
        </g>
      {/if}

      <!-- Token row -->
      <text x="16" y={seqY + 18} class="rowlabel">tokens</text>
      {#each cols as c, i (i)}
        <g in:fly={cur.flyIn && i === cols.length - 1 ? { y: -30, duration: 450, easing: cubicOut } : { duration: 0 }}>
          <rect x={c.x} y={seqY} width={c.w} height={tokH} rx="6" fill={i < PROMPT_N ? 'var(--accent-soft)' : 'var(--gen-soft)'} stroke={i < PROMPT_N ? 'var(--accent)' : 'var(--gen)'} stroke-width="1.5" />
          <text x={c.cx} y={seqY + 18} text-anchor="middle" class="tok">{c.t.replace(/^ /, '␣')}</text>
        </g>
      {/each}

      <!-- This step: x / q / k / v for the columns actually computed -->
      {#if cur.compute}
        <g transition:fade={{ duration: 200 }}>
          <text x="16" y={ROW.x - 10} class="tag">computed this step</text>
          {#each (['x', 'q', 'k', 'v'] as Row[]) as r, ri}
            <text x="16" y={ROW[r] + 14} class="rowlabel">{r}</text>
            {#each cols as c, i (i)}
              {#if computed(i)}
                <g in:fly={{ y: -8, delay: (ri * 2 + i) * 45, duration: 250 }} class="cellg"
                   style:opacity={r === 'q' && cur.dropQ ? 0.25 : 1}>
                  <rect x={c.cx - CW / 2} y={ROW[r]} width={CW} height={CH} rx="4" fill={COLOR[r][0]} stroke={COLOR[r][1]}
                        stroke-width={r === 'q' && cur.attend === i ? 2.5 : 1} />
                  <text x={c.cx} y={ROW[r] + 14} text-anchor="middle" class="cell">{r}{sub(i + 1)}</text>
                </g>
              {:else if isDecode}
                <rect x={c.cx - CW / 2} y={ROW[r]} width={CW} height={CH} rx="4" fill="none" stroke="var(--line)" stroke-dasharray="3 3" in:fade />
              {/if}
            {/each}
          {/each}
        </g>
      {/if}

      <!-- The cache -->
      <text x="16" y={CACHE.y - 8} class="rowlabel">KV cache <tspan class="eq">· one layer, one head</tspan></text>
      <rect x="10" y={CACHE.y} width={W - 20} height={CACHE.h} rx="10" fill="#fbfaf7" stroke="var(--line)" stroke-dasharray="5 4" />
      <text x="24" y={CK + 14} class="rowlabel">k</text>
      <text x="24" y={CV + 14} class="rowlabel">v</text>
      {#each allCols as c, s}
        {#if s >= cur.cached}
          <rect x={c.cx - CW / 2} y={CK} width={CW} height={CH} rx="4" fill="none" stroke="var(--line)" stroke-dasharray="3 3" />
          <rect x={c.cx - CW / 2} y={CV} width={CW} height={CH} rx="4" fill="none" stroke="var(--line)" stroke-dasharray="3 3" />
        {/if}
      {/each}
      {#each Array(cur.cached) as _, s (s)}
        {@const c = allCols[s]}
        <g in:fly={{ y: ROW.k - CK, delay: s * 40, duration: 500, easing: cubicOut }}>
          {#if cur.attend !== undefined && w[s] !== undefined}
            <text x={c.cx} y={CK - 5} text-anchor="middle" class="num" in:fade={{ delay: s * 60 }}>{w[s].toFixed(2)}</text>
          {/if}
          <rect x={c.cx - CW / 2} y={CK} width={CW} height={CH} rx="4" fill={COLOR.k[0]} stroke={COLOR.k[1]} stroke-width={cur.attend !== undefined ? 2 : 1} />
          <text x={c.cx} y={CK + 14} text-anchor="middle" class="cell">k{sub(s + 1)}</text>
        </g>
        <g in:fly={{ y: ROW.v - CV, delay: s * 40 + 60, duration: 500, easing: cubicOut }} class="cellg"
           style:opacity={cur.attend !== undefined && w[s] !== undefined ? 0.35 + 0.65 * w[s] : 1}>
          <rect x={c.cx - CW / 2} y={CV} width={CW} height={CH} rx="4" fill={COLOR.v[0]} stroke={COLOR.v[1]} />
          <text x={c.cx} y={CV + 14} text-anchor="middle" class="cell">v{sub(s + 1)}</text>
        </g>
      {/each}

      <!-- Blend: cached values -> output for the attending token -->
      {#if cur.attend !== undefined}
        <g transition:fade={{ duration: 250 }}>
          {#each allCols.slice(0, cur.cached) as c, s}
            <path d="M {c.cx} {CV + CH} C {c.cx} {CV + 40}, {outX - 6} {CV + 40}, {outX} {CV + CH}"
                  fill="none" stroke={COLOR.v[1]} stroke-width={0.8 + w[s] * 6} opacity="0.55" />
          {/each}
          <rect x={outX - 20} y={CV} width="40" height={CH} rx="4" fill="white" stroke={COLOR.v[1]} stroke-width="2" />
          <text x={outX} y={CV + 14} text-anchor="middle" class="cell">out{sub(cur.attend + 1)}</text>
          <text x={outX} y={CK + 14} text-anchor="middle" class="tag">q{sub(cur.attend + 1)} reads all {cur.cached}</text>
        </g>
      {/if}

      <!-- Why not q: a ghost row that would never be read -->
      {#if cur.whyNotQ}
        <g transition:fade={{ duration: 250 }}>
          <text x="24" y={CQ + 14} class="rowlabel" opacity="0.6">q</text>
          {#each allCols.slice(0, cur.cached) as c, s}
            <g in:fade={{ delay: s * 40 }} opacity="0.5">
              <rect x={c.cx - CW / 2} y={CQ} width={CW} height={CH} rx="4" fill={COLOR.q[0]} stroke={COLOR.q[1]} stroke-dasharray="3 3" />
              <text x={c.cx} y={CQ + 14} text-anchor="middle" class="cell">q{sub(s + 1)}</text>
              <line x1={c.cx - CW / 2 + 3} y1={CQ + CH - 3} x2={c.cx + CW / 2 - 3} y2={CQ + 3} stroke={COLOR.q[1]} stroke-width="1.5" />
            </g>
          {/each}
          <text x={outX - 20} y={CQ + 14} class="tag" in:fade={{ delay: 400 }}>used once, never read again</text>
        </g>
      {/if}

      <!-- Cost readout -->
      {#if cur.cost}
        <g in:fade>
          <text x="16" y={CACHE.y + CACHE.h + 24} class="legend">
            <tspan class="strong">{cur.cached} tokens × {KB_PER_TOKEN} KB</tspan> = {cacheKB.toLocaleString()} KB
            <tspan class="muted">   (32 layers · 8 kv heads · 128 dims · k and v · 2 bytes)</tspan>
          </text>
          <text x="16" y={CACHE.y + CACHE.h + 44} class="legend muted" in:fade={{ delay: 500 }}>
            at 8k tokens: <tspan class="strong">{((8192 * KB_PER_TOKEN) / 1024 / 1024).toFixed(0)} GB</tspan>, for one sequence. Keep that number in mind.
          </text>
        </g>
      {/if}
    </svg>
  </div>

  <StepControls {step} total={steps.length} caption={cur.caption} {prev} {next} interval={2800} onchange={(s) => (step = s)} />
</figure>

<style>
  .viz { margin: 0; display: flex; flex-direction: column; min-height: 0; }
  .canvas { flex: 1 1 auto; min-height: 0; border: 1px solid var(--line); border-radius: 16px; background: white; padding: 0.75rem; box-shadow: 0 1px 2px rgba(0,0,0,0.03), 0 12px 32px -20px rgba(0,0,0,0.12); }
  svg { display: block; width: 100%; height: 100%; font-family: var(--sans); }
  .rowlabel { font-family: var(--mono); font-size: 11px; fill: var(--muted); }
  .rowlabel .eq { fill: var(--faint); }
  .tok { font-family: var(--mono); font-size: 12.5px; fill: var(--fg); }
  .cell { font-family: var(--mono); font-size: 10.5px; fill: var(--fg); }
  .cellg { transition: opacity 300ms; }
  .num { font-family: var(--mono); font-size: 10px; fill: var(--fg); }
  .tag { font-size: 10px; fill: var(--muted); }
  .tag.strong { fill: var(--accent); font-weight: 600; }
  .tag.strong.gen { fill: var(--gen); }
  .legend { font-size: 11.5px; fill: var(--fg); }
  .legend .strong { font-weight: 650; }
  .legend .muted, .legend.muted { fill: var(--muted); }
</style>
