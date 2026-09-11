<script lang="ts">
  import { fly, fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import StepControls from './StepControls.svelte';

  // ---- Data --------------------------------------------------------------------------------
  const tokens = ['The', ' capital', ' of', ' France', ' is', ' Paris'];
  const PROMPT_N = 5;
  // Made-up but plausible attention scores (q · k) for the attending token against each key.
  const scores: Record<number, number[]> = {
    4: [0.4, 1.9, 0.2, 2.6, 0.9],
    5: [0.3, 1.4, 0.1, 1.8, 0.6, 2.2],
  };
  const softmax = (a: number[]) => {
    const m = Math.max(...a); const e = a.map((v) => Math.exp(v - m)); const s = e.reduce((x, y) => x + y, 0);
    return e.map((v) => v / s);
  };

  // ---- Script: each step is a complete description of what is on screen ---------------------
  interface Step {
    caption: string; n: number;
    x?: boolean; rows?: boolean; rowsFor?: number; flyIn?: boolean;
    attend?: number; scores?: boolean; weights?: boolean; mix?: boolean;
    causal?: boolean; recompute?: boolean; unusedQ?: boolean; tally?: boolean;
  }
  const steps: Step[] = [
    { n: 5, caption: `Same five tokens, one forward pass. This time we watch what one attention layer does with them.` },
    { n: 5, x: true, caption: `Each token comes in as a vector. Call it x.` },
    { n: 5, rows: true, caption: `Every token multiplies its own x by three learned matrices and gets a <b>query</b>, a <b>key</b> and a <b>value</b>. No other token is involved yet.` },
    { n: 5, rows: true, attend: 4, scores: true, caption: `The last token's query gets dotted with every key. A big score means "this one matters to me".` },
    { n: 5, rows: true, attend: 4, scores: true, weights: true, caption: `Softmax turns the scores into weights that add up to one.` },
    { n: 5, rows: true, attend: 4, weights: true, mix: true, caption: `Its output is the values, blended by those weights. This is how "is" finds out it's sitting after "capital of France".` },
    { n: 5, rows: true, causal: true, caption: `Every position does the same thing with its own query, over the keys up to itself. One pass, all five outputs at once.` },
    { n: 6, rows: true, rowsFor: 5, flyIn: true, caption: `Decode step. "Paris" joins the sequence, and the layer runs again on all six.` },
    { n: 6, rows: true, recompute: true, caption: `All six make q, k, v again. For the five old tokens: same x, same matrices, same vectors as last time.` },
    { n: 6, rows: true, attend: 5, weights: true, mix: true, caption: `Paris's query looks at all six keys and blends all six values. It needs every earlier key and value.` },
    { n: 6, rows: true, unusedQ: true, caption: `The old queries? They'd produce outputs for positions we already predicted. Nothing reads them.` },
    { n: 6, rows: true, tally: true, caption: `So each decode step, the new token needs every earlier k and v, and nothing else from the past. We recomputed them all, identically, in every head of every layer. Why not just keep them?` },
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
  const cols = $derived.by(() => {
    let x = X0;
    return tokens.slice(0, cur.n).map((t) => { const w = boxW(t); const c = { t, x, w, cx: x + w / 2 }; x += w + gap; return c; });
  });
  const seqEndX = $derived(cols[cols.length - 1].x + cols[cols.length - 1].w);

  const CW = 32, CH = 20;
  const ROW = { x: 96, q: 128, k: 156, v: 184 } as const;
  type Row = keyof typeof ROW;
  const COLOR: Record<Row, [string, string]> = {
    x: ['#eeece6', '#8a8780'], q: ['#ede9fe', '#7c3aed'], k: ['#cffafe', '#0891b2'], v: ['#dcfce7', '#16a34a'],
  };
  const LOW = 226;                  // top of the lower panel
  const BAR_BASE = LOW + 128, BAR_MAX = 78, BAR_W = 26;
  const sub = (i: number) => String(i).replace(/\d/g, (d) => '₀₁₂₃₄₅₆₇₈₉'[+d]);

  const rowsFor = $derived(cur.rows ? (cur.rowsFor ?? cur.n) : 0);
  const w = $derived(cur.attend !== undefined ? softmax(scores[cur.attend]) : []);
  const isNewCol = (c: number) => cur.n > PROMPT_N && c >= PROMPT_N;
  const isOld = (c: number) => cur.n > PROMPT_N && c < PROMPT_N;
  const sameBadge = (r: Row, c: number) => (cur.recompute || cur.tally) && (r === 'k' || r === 'v') && isOld(c);
  const unused = (r: Row, c: number) => (cur.unusedQ || cur.tally) && r === 'q' && isOld(c);
  const hotQ = (r: Row, c: number) => r === 'q' && cur.attend === c;
  const hotK = (r: Row, c: number) => r === 'k' && cur.attend !== undefined && (cur.scores || cur.weights) && c <= cur.attend;
  const hotV = (r: Row, c: number) => r === 'v' && cur.mix && cur.attend !== undefined && c <= cur.attend;
  const outX = $derived(seqEndX + 44);
</script>

<figure class="viz">
  <div class="canvas">
    <svg viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Attention per decode step, step {step + 1}">
      <!-- Token row -->
      <text x="16" y={seqY + 18} class="rowlabel">tokens</text>
      {#each cols as c, i (i)}
        <g in:fly={cur.flyIn && i === cols.length - 1 ? { y: -30, duration: 450, easing: cubicOut } : { duration: 0 }}>
          <rect x={c.x} y={seqY} width={c.w} height={tokH} rx="6" fill={i < PROMPT_N ? 'var(--accent-soft)' : 'var(--gen-soft)'} stroke={i < PROMPT_N ? 'var(--accent)' : 'var(--gen)'} stroke-width="1.5" />
          <text x={c.cx} y={seqY + 18} text-anchor="middle" class="tok">{c.t.replace(/^ /, '␣')}</text>
        </g>
      {/each}
      {#if cur.n > PROMPT_N && rowsFor === cur.n}
        <text x={cols[cur.n - 1].cx} y={ROW.x - 8} text-anchor="middle" class="tag new" in:fade>new</text>
      {/if}

      <!-- x / q / k / v rows -->
      {#if cur.x || cur.rows}
        <g transition:fade={{ duration: 200 }}>
          <text x="16" y={ROW.x + 14} class="rowlabel">x</text>
          {#each cols as c, i (i)}
            <g in:fly={{ y: -8, delay: i * 50, duration: 250 }}>
              <rect x={c.cx - CW / 2} y={ROW.x} width={CW} height={CH} rx="4" fill={COLOR.x[0]} stroke={COLOR.x[1]} />
              <text x={c.cx} y={ROW.x + 14} text-anchor="middle" class="cell">x{sub(i + 1)}</text>
            </g>
          {/each}
        </g>
      {/if}
      {#if cur.rows}
        <g transition:fade={{ duration: 200 }}>
          {#each (['q', 'k', 'v'] as Row[]) as r, ri}
            <text x="16" y={ROW[r] + 14} class="rowlabel">{r} <tspan class="eq">= W<tspan class="sub">{r.toUpperCase()}</tspan> x</tspan></text>
            {#each cols.slice(0, rowsFor) as c, i (i)}
              {@const hot = hotQ(r, i) || hotK(r, i) || hotV(r, i)}
              <g in:fly={{ y: -8, delay: (ri * 2 + i) * 45, duration: 250 }}
                 style:opacity={unused(r, i) ? 0.3 : hotV(r, i) ? 0.35 + 0.65 * w[i] : 1} class="cellg">
                <rect x={c.cx - CW / 2} y={ROW[r]} width={CW} height={CH} rx="4" fill={COLOR[r][0]} stroke={COLOR[r][1]}
                      stroke-width={hot || isNewCol(i) ? 2.5 : 1} class:pulse={cur.recompute && !isNewCol(i)} style="animation-delay: {i * 60}ms" />
                <text x={c.cx} y={ROW[r] + 14} text-anchor="middle" class="cell">{r}{sub(i + 1)}</text>
                {#if sameBadge(r, i)}
                  <g in:fade={{ delay: 400 + i * 60 }}>
                    <circle cx={c.cx + CW / 2} cy={ROW[r]} r="6.5" fill="white" stroke={COLOR[r][1]} />
                    <text x={c.cx + CW / 2} y={ROW[r] + 3.5} text-anchor="middle" class="badge" fill={COLOR[r][1]}>=</text>
                  </g>
                {/if}
                {#if unused(r, i)}
                  <line x1={c.cx - CW / 2 + 3} y1={ROW[r] + CH - 3} x2={c.cx + CW / 2 - 3} y2={ROW[r] + 3} stroke={COLOR.q[1]} stroke-width="2" in:fade />
                {/if}
              </g>
            {/each}
          {/each}
        </g>
      {/if}

      <!-- Blend lines from values to the output cell -->
      {#if cur.mix && cur.attend !== undefined}
        <g transition:fade={{ duration: 250 }}>
          {#each cols.slice(0, cur.attend + 1) as c, i}
            <path d="M {c.cx} {ROW.v + CH} C {c.cx} {ROW.v + 46}, {outX - 6} {ROW.v + 46}, {outX} {ROW.v + CH}"
                  fill="none" stroke={COLOR.v[1]} stroke-width={0.8 + w[i] * 6} opacity="0.55" />
          {/each}
          <rect x={outX - 20} y={ROW.v} width="40" height={CH} rx="4" fill="white" stroke={COLOR.v[1]} stroke-width="2" />
          <text x={outX} y={ROW.v + 14} text-anchor="middle" class="cell">out{sub(cur.attend + 1)}</text>
          <text x={outX} y={ROW.v - 8} text-anchor="middle" class="tag">Σ wⱼ vⱼ</text>
        </g>
      {/if}

      <!-- Lower panel: scores and weights for the attending token -->
      {#if cur.attend !== undefined && (cur.scores || cur.weights)}
        <g transition:fade={{ duration: 250 }}>
          {#if cur.scores}
            <text x="16" y={LOW + 16} class="rowlabel">q{sub(cur.attend + 1)} · k<tspan class="sub">j</tspan></text>
            {#each cols.slice(0, cur.attend + 1) as c, i}
              <text x={c.cx} y={LOW + 16} text-anchor="middle" class="num" in:fade={{ delay: i * 60 }}>{scores[cur.attend][i].toFixed(1)}</text>
            {/each}
          {/if}
          {#if cur.weights}
            <text x="16" y={BAR_BASE - 4} class="rowlabel">softmax</text>
            {#each cols.slice(0, cur.attend + 1) as c, i}
              {@const h = w[i] * BAR_MAX}
              <g in:fly={{ y: 10, delay: i * 60, duration: 300 }}>
                <rect x={c.cx - BAR_W / 2} y={BAR_BASE - h} width={BAR_W} height={h} rx="3" fill={COLOR.k[1]} opacity={0.35 + 0.65 * w[i]} />
                <text x={c.cx} y={BAR_BASE - h - 6} text-anchor="middle" class="num">{w[i].toFixed(2)}</text>
              </g>
            {/each}
            <line x1={cols[0].x} y1={BAR_BASE + 0.5} x2={cols[cur.attend].x + cols[cur.attend].w} y2={BAR_BASE + 0.5} stroke="var(--line)" />
          {/if}
        </g>
      {/if}

      <!-- Causal matrix: who attends to whom in one forward pass -->
      {#if cur.causal}
        {@const G = 22}
        {@const gx = 330}
        {@const gy = LOW + 30}
        <g transition:fade={{ duration: 250 }}>
          <text x={gx - 14} y={gy - 12} text-anchor="end" class="tag">query ↓</text>
          <text x={gx + (PROMPT_N * G) / 2} y={gy - 12} text-anchor="middle" class="tag">key →</text>
          {#each Array(PROMPT_N) as _, i}
            <text x={gx - 8} y={gy + i * G + 15} text-anchor="end" class="cell">q{sub(i + 1)}</text>
            {#each Array(PROMPT_N) as _, j}
              {#if j <= i}
                <rect x={gx + j * G} y={gy + i * G} width={G - 3} height={G - 3} rx="3"
                      fill={i === PROMPT_N - 1 ? COLOR.k[1] : COLOR.k[0]} stroke={COLOR.k[1]} stroke-width="0.8"
                      in:fly={{ y: -6, delay: (i * PROMPT_N + j) * 30, duration: 200 }} />
              {/if}
            {/each}
          {/each}
          <text x={gx + PROMPT_N * G + 14} y={gy + (PROMPT_N - 1) * G + 15} class="tag" in:fade={{ delay: 900 }}>← the row we just watched</text>
        </g>
      {/if}

      <!-- Tally legend -->
      {#if cur.tally}
        {@const ly = LOW + 24}
        <g in:fade={{ duration: 300 }}>
          <rect x="16" y={ly - 10} width="14" height="14" rx="3" fill={COLOR.k[0]} stroke={COLOR.k[1]} />
          <rect x="34" y={ly - 10} width="14" height="14" rx="3" fill={COLOR.v[0]} stroke={COLOR.v[1]} />
          <text x="58" y={ly + 1} class="legend"><tspan class="strong">needed</tspan> by every future token: k and v of every earlier position. Recomputed this step, identical.</text>
          <rect x="16" y={ly + 20} width="14" height="14" rx="3" fill={COLOR.q[0]} stroke={COLOR.q[1]} opacity="0.5" />
          <line x1="18" y1={ly + 32} x2="28" y2={ly + 22} stroke={COLOR.q[1]} stroke-width="1.5" />
          <text x="58" y={ly + 31} class="legend"><tspan class="strong">not needed</tspan>: the old queries. Each one was used once, on its own step.</text>
          <rect x="16" y={ly + 50} width="14" height="14" rx="3" fill="white" stroke="var(--gen)" stroke-width="2" />
          <text x="58" y={ly + 61} class="legend"><tspan class="strong">new</tspan>: q, k, v for the token that just arrived.</text>
          <text x="16" y={ly + 100} class="legend muted" in:fade={{ delay: 700 }}>per head, per layer: {PROMPT_N * 2} vectors recomputed that were already known. A 32-layer, 32-head model does this 1024 times per step.</text>
        </g>
      {/if}
    </svg>
  </div>

  <StepControls {step} total={steps.length} caption={cur.caption} interval={2600} onchange={(s) => (step = s)} />
</figure>

<style>
  .viz { margin: 0; display: flex; flex-direction: column; min-height: 0; }
  .canvas { flex: 1 1 auto; min-height: 0; border: 1px solid var(--line); border-radius: 16px; background: white; padding: 0.75rem; box-shadow: 0 1px 2px rgba(0,0,0,0.03), 0 12px 32px -20px rgba(0,0,0,0.12); }
  svg { display: block; width: 100%; height: 100%; font-family: var(--sans); }
  .rowlabel { font-family: var(--mono); font-size: 11px; fill: var(--muted); }
  .rowlabel .eq { fill: var(--faint); }
  .sub { font-size: 8px; baseline-shift: sub; }
  .tok { font-family: var(--mono); font-size: 12.5px; fill: var(--fg); }
  .cell { font-family: var(--mono); font-size: 10.5px; fill: var(--fg); }
  .cellg { transition: opacity 300ms; }
  .badge { font-family: var(--mono); font-size: 10px; font-weight: 700; }
  .num { font-family: var(--mono); font-size: 10.5px; fill: var(--fg); }
  .tag { font-size: 10px; fill: var(--muted); }
  .tag.new { fill: var(--gen); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; font-size: 9px; }
  .legend { font-size: 11.5px; fill: var(--fg); }
  .legend .strong { font-weight: 650; }
  .legend.muted { fill: var(--muted); }
  rect.pulse { animation: pulse 700ms ease-in-out 2; }
  @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.3 } }
</style>
