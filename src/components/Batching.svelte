<script lang="ts">
  import { fade, fly } from 'svelte/transition';
  import StepControls from './StepControls.svelte';
  import type { NavLink } from '../chapters';
  let { prev, next }: { prev?: NavLink; next?: NavLink } = $props();

  // ---- Numbers, same as chapter 4: Llama-3-8B bf16 on one H100 -----------------------------
  const W_GB = 16, BW = 3.35, FLOPS = 989, GFLOP_PER_TOKEN = 16;
  const tMem = W_GB / BW;                                   // ms per step just to read the weights
  const tComp = (n: number) => (n * GFLOP_PER_TOKEN) / FLOPS;
  const stepMs = (B: number) => Math.max(tMem, tComp(B));
  const busy = (B: number) => tComp(B) / stepMs(B);
  const tput = (B: number) => (B / stepMs(B)) * 1000;      // tokens per second
  const balance = Math.round(tMem / tComp(1) / 50) * 50;
  const fmt = (ms: number) => (ms < 10 ? ms.toFixed(1) : ms.toFixed(0)) + ' ms';

  // ---- Requests: what a real queue looks like -------------------------------------------------
  // answer = decode steps in the grid; prompt in tokens; arrival in ms (for the ragged view only)
  const requests = [
    { id: 1, arrival: 0, prompt: 1200, answer: 10 },
    { id: 2, arrival: 4, prompt: 300, answer: 4 },
    { id: 3, arrival: 7, prompt: 2600, answer: 15 },
    { id: 4, arrival: 15, prompt: 800, answer: 7 },
    { id: 5, arrival: 18, prompt: 150, answer: 3 },
    { id: 6, arrival: 26, prompt: 2000, answer: 9 },
  ];
  const queueAnswers = [6, 9, 4, 7, 5, 8, 6, 5, 7, 4];      // requests 7, 8, 9 … waiting behind them

  // ---- Script -------------------------------------------------------------------------------
  type Scene = 'batch' | 'ragged' | 'static' | 'grid';
  interface Step { caption: string; scene: Scene; B?: number; mode?: 'static' | 'continuous'; highlight?: boolean }
  const steps: Step[] = [
    { scene: 'batch', B: 1, caption: `One user. One token per step, ${fmt(tMem)} per step, and the GPU mostly waiting.` },
    { scene: 'batch', B: 2, caption: `A second user's token rides the same read. Two tokens per step, still ${fmt(tMem)}.` },
    { scene: 'batch', B: 64, caption: `Keep adding. 64 users, 64 tokens per step, still ${fmt(stepMs(64))}. Throughput went up 64×, and nobody got slower.` },
    { scene: 'batch', B: 512, caption: `Past the balance point the math outlasts the read and the step stretches. Around ${balance} tokens per step is the sweet spot for this GPU and model.` },
    { scene: 'ragged', caption: `${balance} tokens per step means ${balance} requests in flight. Real requests don't cooperate: they arrive whenever, prompts run from a line to a document, and answers from a word to a page.` },
    { scene: 'static', caption: `The simplest way to batch: take the next six requests, prefill them together, decode them in lockstep until the last one finishes, then take the next six. Membership never changes while the batch runs. That's what <b>static</b> means.` },
    { scene: 'grid', mode: 'static', caption: `Slots go idle as short answers finish, and request 7 waits until the longest answer is done. The two prefill columns are drawn short; they take many decode steps' worth of time.` },
    { scene: 'grid', mode: 'continuous', caption: `<b>Continuous batching</b>: rebuild the batch every step. When a sequence finishes, the next request takes its slot on the very next step. Its prefill runs in the same forward pass as everyone else's decode token.` },
    { scene: 'grid', mode: 'continuous', highlight: true, caption: `More tokens, and no batch boundaries. But every wide column stretches everyone's decode step to the length of one prompt's math. Can a newcomer join without slowing everyone else down? That's the scheduler's problem.` },
  ];

  let step = $state(0);
  $effect(() => {
    const q = Number(new URLSearchParams(window.location.search).get('step'));
    if (q >= 1 && q <= steps.length) step = q - 1;
  });
  const cur = $derived(steps[step]);
  const B = $derived(cur.B ?? 1);

  // ---- Batch scene ------------------------------------------------------------------------------
  const W = 720, H = 400;
  const HBM = { x: 40, y: 70, w: 150, h: 120 };
  const CU = { x: 260, y: 70, w: 180, h: 120 };
  const MID = HBM.y + HBM.h / 2;
  const CHIP = { w: 34, h: 16, x: 560 };
  const chipCount = $derived(Math.min(B, 6));
  const tiles = $derived([
    { label: 'tokens per step', value: B.toLocaleString() },
    { label: 'step time', value: fmt(stepMs(B)) },
    { label: 'GPU busy', value: `${(busy(B) * 100).toFixed(busy(B) < 0.1 ? 1 : 0)}%` },
    { label: 'tokens per second', value: Math.round(tput(B)).toLocaleString() },
  ]);

  // ---- Ragged scene: arrival timeline with prompt and answer bars -------------------------------
  const RG = { x: 130, y: 84, rowH: 36, msW: 5.2, promptScale: 0.05, answerScale: 7 };

  // ---- Grid scene: six slots over T engine steps, static vs continuous --------------------------
  const T = 20, SLOTS = 6;
  type Cell = 'prefill' | 'decode' | 'idle';
  function simulate(mode: 'static' | 'continuous') {
    const grid: Cell[][] = Array.from({ length: SLOTS }, () => Array(T).fill('idle'));
    const q = [...queueAnswers];
    const place = (s: number, t0: number, len: number) => {
      if (t0 < T) grid[s][t0] = 'prefill';
      for (let t = t0 + 1; t <= t0 + len && t < T; t++) grid[s][t] = 'decode';
      return t0 + len + 1;
    };
    const free = requests.map((r, s) => place(s, 0, r.answer));
    if (mode === 'static') {
      const batchEnd = Math.max(...free);
      for (let s = 0; s < SLOTS; s++) if (q.length) place(s, batchEnd, q.shift()!);
    } else {
      for (let t = 0; t < T; t++) for (let s = 0; s < SLOTS; s++) if (free[s] === t && q.length) free[s] = place(s, t, q.shift()!);
    }
    // a column with any prefill in it is a long step; draw it wider
    const wide = Array.from({ length: T }, (_, t) => grid.some((row) => row[t] === 'prefill'));
    const NORMAL = 20, WIDE = 36, GAP = 3;
    let x = 0; const colX: number[] = []; const colW: number[] = [];
    for (let t = 0; t < T; t++) { colX.push(x); colW.push(wide[t] ? WIDE : NORMAL); x += colW[t] + GAP; }
    const flat = grid.flat();
    return { grid, wide, colX, colW, width: x - GAP, tokens: flat.filter((c) => c === 'decode').length, idle: flat.filter((c) => c === 'idle').length };
  }
  const sims = { static: simulate('static'), continuous: simulate('continuous') };
  const G = { x: 96, y: 92, ch: 20, gap: 3 };
  const cellColor: Record<Cell, string> = { prefill: 'var(--accent)', decode: 'var(--gen)', idle: '#ece9e2' };
  const batchEnd = Math.max(...requests.map((r) => r.answer)) + 1;
</script>

<figure class="viz">
  <div class="canvas">
    <svg viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Batching, step {step + 1}">

      <!-- Batch: B users share one weight read -->
      {#if cur.scene === 'batch'}
        <g transition:fade={{ duration: 250 }}>
          <rect x={HBM.x} y={HBM.y} width={HBM.w} height={HBM.h} rx="10" fill="#fbfaf7" stroke="var(--line)" />
          <text x={HBM.x + 12} y={HBM.y + 18} class="boxtitle">memory</text>
          <rect x={HBM.x + 14} y={HBM.y + 32} width={HBM.w - 28} height="64" rx="6" fill="var(--accent-soft)" stroke="var(--accent)" />
          <text x={HBM.x + HBM.w / 2} y={HBM.y + 58} text-anchor="middle" class="slab">weights</text>
          <text x={HBM.x + HBM.w / 2} y={HBM.y + 78} text-anchor="middle" class="slab strong">{W_GB} GB</text>
          <line x1={HBM.x + HBM.w + 4} y1={MID} x2={CU.x - 12} y2={MID} class="wire" />
          <polygon points="{CU.x - 12},{MID - 7} {CU.x - 12},{MID + 7} {CU.x - 2},{MID}" fill="var(--faint)" />
          <text x={(HBM.x + HBM.w + CU.x) / 2} y={MID - 14} text-anchor="middle" class="tag strong">read {W_GB} GB</text>
          <text x={(HBM.x + HBM.w + CU.x) / 2} y={MID + 22} text-anchor="middle" class="tag">once per step</text>

          <rect x={CU.x} y={CU.y} width={CU.w} height={CU.h} rx="10" fill="#fbfaf7" stroke="var(--line)" />
          <text x={CU.x + 12} y={CU.y + 18} class="boxtitle">compute</text>
          <text x={CU.x + CU.w / 2} y={CU.y + 52} text-anchor="middle" class="slab">{B.toLocaleString()} × {GFLOP_PER_TOKEN} GFLOP</text>
          <rect x={CU.x + 25} y={CU.y + 74} width="130" height="12" rx="3" fill="var(--line)" />
          <rect x={CU.x + 25} y={CU.y + 74} width="130" height="12" rx="3" fill={busy(B) > 0.5 ? 'var(--accent)' : 'var(--eos)'} class="bar" style:transform="scaleX({Math.max(2 / 130, busy(B))})" />
          <text x={CU.x + CU.w / 2} y={CU.y + 104} text-anchor="middle" class="tag">busy {(busy(B) * 100).toFixed(busy(B) < 0.1 ? 1 : 0)}% of the step</text>

          <text x={CHIP.x + CHIP.w / 2} y={HBM.y - 12} text-anchor="middle" class="boxtitle">{B.toLocaleString()} user{B === 1 ? '' : 's'}, one token each</text>
          {#each Array(chipCount) as _, i (i)}
            {@const y = MID - (chipCount * (CHIP.h + 3)) / 2 + i * (CHIP.h + 3)}
            <g in:fly={{ x: 30, delay: i * 60, duration: 250 }} out:fade={{ duration: 150 }}>
              <rect x={CHIP.x} y={y} width={CHIP.w} height={CHIP.h} rx="4" fill="var(--gen-soft)" stroke="var(--gen)" />
              <text x={CHIP.x + CHIP.w / 2} y={y + 12} text-anchor="middle" class="cell">{B > 6 && i === chipCount - 1 ? '…' : 'tok'}</text>
            </g>
          {/each}
          <line x1={CHIP.x - 6} y1={MID} x2={CU.x + CU.w + 12} y2={MID} class="wire" />
          <polygon points="{CU.x + CU.w + 12},{MID - 6} {CU.x + CU.w + 12},{MID + 6} {CU.x + CU.w + 2},{MID}" fill="var(--faint)" />

          {#each tiles as t, i}
            {@const x = 40 + i * 165}
            <rect {x} y="236" width="150" height="66" rx="10" fill="#fbfaf7" stroke="var(--line)" />
            <text x={x + 14} y="262" class="tile-value">{t.value}</text>
            <text x={x + 14} y="286" class="tile-label">{t.label}</text>
          {/each}
          {#if B > balance}
            <text x="40" y="332" class="legend" in:fade>{B} tokens of math take {fmt(tComp(B))}, longer than the {fmt(tMem)} read. Every extra token now costs time.</text>
          {:else if B > 1}
            <text x="40" y="332" class="legend" in:fade>{B} tokens share one {fmt(tMem)} read. Per-user latency: unchanged.</text>
          {/if}
        </g>
      {/if}

      <!-- Ragged: six real-looking requests on an arrival timeline -->
      {#if cur.scene === 'ragged'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y={RG.y - 34} class="rowlabel">six requests, as they arrive</text>
          <line x1={RG.x} y1={RG.y - 14} x2={RG.x + 100 * RG.msW} y2={RG.y - 14} stroke="var(--line)" />
          {#each [0, 25, 50, 75, 100] as ms}
            <text x={RG.x + ms * RG.msW} y={RG.y - 20} text-anchor="middle" class="tag">{ms} ms</text>
          {/each}
          {#each requests as r, i}
            {@const y = RG.y + i * RG.rowH}
            {@const x = RG.x + r.arrival * RG.msW}
            {@const pw = r.prompt * RG.promptScale}
            {@const aw = r.answer * RG.answerScale}
            <g in:fly={{ x: -10, delay: i * 60, duration: 250 }}>
              <text x={RG.x - 12} y={y + 12} text-anchor="end" class="rowlabel">req {r.id}</text>
              <line x1={x} y1={y - 4} x2={x} y2={y + 20} stroke="var(--faint)" />
              <rect {x} y={y} width={pw} height="16" rx="3" fill="var(--accent)" opacity="0.85" />
              <rect x={x + pw + 2} y={y} width={aw} height="16" rx="3" fill="var(--gen)" opacity="0.85" />
              <text x={x + pw + aw + 10} y={y + 12} class="tag">prompt {r.prompt.toLocaleString()} · answer ~{r.answer * 10} tokens</text>
            </g>
          {/each}
          <g in:fade={{ delay: 400 }}>
            <rect x="16" y={RG.y + 6 * RG.rowH + 4} width="12" height="12" rx="2" fill="var(--accent)" opacity="0.85" /><text x="34" y={RG.y + 6 * RG.rowH + 14} class="tag">prompt: one prefill, all its tokens at once</text>
            <rect x="260" y={RG.y + 6 * RG.rowH + 4} width="12" height="12" rx="2" fill="var(--gen)" opacity="0.85" /><text x="278" y={RG.y + 6 * RG.rowH + 14} class="tag">then the answer: one decode step per token</text>
          </g>
        </g>
      {/if}

      <!-- Static batching, defined -->
      {#if cur.scene === 'static'}
        <g transition:fade={{ duration: 250 }}>
          <rect x="24" y="70" width="196" height="220" rx="12" fill="#fbfaf7" stroke="var(--accent)" stroke-dasharray="5 4" />
          <text x="40" y="92" class="boxtitle">batch 1 · six requests</text>
          {#each requests as r, i}
            <g in:fly={{ y: -6, delay: i * 50, duration: 220 }}>
              <rect x="40" y={106 + i * 27} width="164" height="21" rx="5" fill="white" stroke="var(--line)" />
              <text x="50" y={106 + i * 27 + 14} class="cell">req {r.id}</text>
              <rect x={94} y={106 + i * 27 + 5} width={Math.max(4, r.prompt * 0.02)} height="11" rx="2" fill="var(--accent)" opacity="0.85" />
              <rect x={94 + Math.max(4, r.prompt * 0.02) + 3} y={106 + i * 27 + 5} width={r.answer * 2.6} height="11" rx="2" fill="var(--gen)" opacity="0.85" />
            </g>
          {/each}
          <text x="40" y="279" class="tag">fixed until all six finish</text>

          <line x1="226" y1="180" x2="240" y2="180" class="wire" />
          <polygon points="238,174 238,186 248,180" fill="var(--faint)" />

          <rect x="252" y="70" width="244" height="220" rx="12" fill="#fbfaf7" stroke="var(--line)" />
          <text x="268" y="92" class="boxtitle">the GPU, step by step</text>
          {#each [
            { n: '1', t: 'prefill all six prompts', s: 'one forward pass, so they finish together', c: 'var(--accent)' },
            { n: '2', t: 'decode, in lockstep', s: 'one token for each, per step', c: 'var(--gen)' },
            { n: '3', t: 'repeat until the last is done', s: 'short answers sit idle meanwhile', c: 'var(--gen)' },
            { n: '4', t: 'then admit the next six', s: 'and prefill them together', c: 'var(--accent)' },
          ] as row, i}
            <g in:fade={{ delay: 300 + i * 150 }}>
              <circle cx="278" cy={118 + i * 44} r="8" fill={row.c} />
              <text x="278" y={118 + i * 44 + 3.5} text-anchor="middle" class="steplabel">{row.n}</text>
              <text x="296" y={118 + i * 44 + 1} class="slab">{row.t}</text>
              <text x="296" y={118 + i * 44 + 15} class="tag">{row.s}</text>
            </g>
          {/each}

          <g in:fade={{ delay: 900 }}>
            <rect x="512" y="70" width="192" height="220" rx="12" fill="white" stroke="var(--line)" stroke-dasharray="5 4" />
            <text x="528" y="92" class="boxtitle">queue</text>
            {#each queueAnswers.slice(0, 5) as _, i}
              <rect x="528" y={106 + i * 27} width="160" height="21" rx="5" fill="#fbfaf7" stroke="var(--line)" />
              <text x="538" y={106 + i * 27 + 14} class="cell">req {7 + i}</text>
              <text x="678" y={106 + i * 27 + 14} text-anchor="end" class="tag">waiting</text>
            {/each}
            <text x="528" y="265" class="tag">admitted after batch 1 ends,</text>
            <text x="528" y="279" class="tag">even if most of it finished early</text>
          </g>
        </g>
      {/if}

      <!-- Grid: slots × engine steps -->
      {#if cur.scene === 'grid'}
        {@const sim = sims[cur.mode === 'continuous' ? 'continuous' : 'static']}
        {@const ly = G.y + SLOTS * (G.ch + G.gap) + 22}
        {@const sy = ly + (cur.highlight ? 58 : 40)}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y={G.y - 34} class="rowlabel">{SLOTS} slots · {T} engine steps · {cur.mode === 'continuous' ? 'continuous batching' : 'static batching'}</text>
          {#each Array(T) as _, t}
            {#if t % 5 === 0 && !sim.wide[t]}
              <text x={G.x + sim.colX[t] + sim.colW[t] / 2} y={G.y - 8} text-anchor="middle" class="tag">{t}</text>
            {/if}
            {#if sim.wide[t]}
              <text x={G.x + sim.colX[t] + sim.colW[t] / 2} y={G.y - 8} text-anchor="middle" class="tag strong" fill="var(--accent)">⫽</text>
            {/if}
          {/each}
          {#each sim.grid as row, s}
            <text x={G.x - 10} y={G.y + s * (G.ch + G.gap) + 14} text-anchor="end" class="rowlabel">slot {s + 1}</text>
            {#each row as c, t}
              {@const cx = G.x + sim.colX[t]}
              {@const cy = G.y + s * (G.ch + G.gap)}
              {#if cur.highlight && sim.wide[t] && c === 'decode'}
                <!-- a decode slot in a prefill step: its step is stretched to the prompt's math; the token comes out at the end -->
                <rect x={cx + 0.5} y={cy + 0.5} width={sim.colW[t] - 1} height={G.ch - 1} rx="3" fill="var(--gen-soft)" stroke="var(--gen)" stroke-opacity="0.5" class="cellg" in:fade={{ duration: 300 }} />
                <rect x={cx + sim.colW[t] - 9} y={cy} width="9" height={G.ch} rx="3" fill={cellColor.decode} class="cellg" in:fade={{ duration: 300 }} />
              {:else}
                <rect x={cx} y={cy} width={sim.colW[t]} height={G.ch} rx="3" fill={cellColor[c]}
                      opacity={cur.highlight && !sim.wide[t] ? 0.25 : 1} class="cellg" in:fade={{ delay: t * 35, duration: 150 }} />
              {/if}
            {/each}
          {/each}
          <rect x={G.x} y={ly - 10} width="12" height="12" rx="2" fill={cellColor.prefill} /><text x={G.x + 18} y={ly} class="tag">prefill step ⫽ drawn short, really 5–40× a decode step</text>
          <rect x={G.x + 290} y={ly - 10} width="12" height="12" rx="2" fill={cellColor.decode} /><text x={G.x + 308} y={ly} class="tag">decode step, one token</text>
          <rect x={G.x + 440} y={ly - 10} width="12" height="12" rx="2" fill={cellColor.idle} /><text x={G.x + 458} y={ly} class="tag">idle slot</text>
          {#if cur.highlight}
            <g in:fade>
              <rect x={G.x + 0.5} y={ly + 8.5} width="35" height="11" rx="2" fill="var(--gen-soft)" stroke="var(--gen)" stroke-opacity="0.5" /><rect x={G.x + 28} y={ly + 8} width="8" height="12" rx="2" fill={cellColor.decode} />
              <text x={G.x + 42} y={ly + 18} class="tag">a decode slot in a prefill step: same one token, but its step is stretched to the length of the prompt's math</text>
            </g>
          {/if}
          <g in:fade={{ delay: 900 }}>
            <text x={G.x} y={sy} class="legend">tokens produced: <tspan class="strong">{sim.tokens}</tspan> · idle slot-steps: <tspan class="strong">{sim.idle}</tspan> of {SLOTS * T}</text>
            {#if cur.highlight}
              <text x={G.x} y={sy + 22} class="legend muted">{sim.wide.filter(Boolean).length} of {T} steps carry a prefill. In each one, every other slot's token only comes out when the whole pass, prompt included, is done.</text>
            {:else if cur.mode === 'continuous'}
              <text x={G.x} y={sy + 22} class="legend muted">same {T} steps: {Math.round(((sim.tokens - sims.static.tokens) / sims.static.tokens) * 100)}% more tokens than static, and request 7 started at step {sims.continuous.grid.flat().length ? requests.reduce((m, r) => Math.min(m, r.answer), 99) + 1 : 0} instead of {batchEnd}.</text>
            {:else}
              <text x={G.x} y={sy + 22} class="legend muted">request 7 can't start until request 3 finishes at step {batchEnd}. Slot 5 sat idle for {batchEnd - requests[4].answer - 1} of those steps.</text>
            {/if}
          </g>
        </g>
      {/if}
    </svg>
  </div>

  <StepControls {step} total={steps.length} caption={cur.caption} interval={3200} {prev} {next} onchange={(s) => (step = s)} />
</figure>

<style>
  .viz { margin: 0; display: flex; flex-direction: column; min-height: 0; }
  .canvas { flex: 1 1 auto; min-height: 0; border: 1px solid var(--line); border-radius: 16px; background: white; padding: 0.75rem; box-shadow: 0 1px 2px rgba(0,0,0,0.03), 0 12px 32px -20px rgba(0,0,0,0.12); }
  svg { display: block; width: 100%; height: 100%; font-family: var(--sans); }
  .rowlabel { font-family: var(--mono); font-size: 11px; fill: var(--muted); }
  .cell { font-family: var(--mono); font-size: 10px; fill: var(--fg); }
  .cellg { transition: opacity 300ms; }
  .tag { font-size: 10px; fill: var(--muted); }
  .tag.strong { fill: var(--fg); font-weight: 600; }
  .steplabel { font-size: 10px; fill: white; font-weight: 600; }
  .boxtitle { font-family: var(--mono); font-size: 10.5px; fill: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .slab { font-size: 12px; fill: var(--fg); }
  .slab.strong { font-weight: 650; font-size: 14px; }
  .tile-value { font-size: 20px; font-weight: 650; fill: var(--fg); letter-spacing: -0.02em; }
  .tile-label { font-size: 10.5px; fill: var(--muted); }
  .legend { font-size: 11.5px; fill: var(--fg); }
  .legend .strong { font-weight: 650; }
  .legend.muted { fill: var(--muted); }
  .bar { transform-box: fill-box; transform-origin: left center; transition: transform 500ms cubic-bezier(0.2, 0.8, 0.2, 1), fill 300ms; }
  .wire { stroke: var(--line); stroke-width: 6; stroke-linecap: round; }
</style>
