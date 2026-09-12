<script lang="ts">
  import { fly, fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import StepControls from './StepControls.svelte';
  import type { NavLink } from '../chapters';
  let { prev, next }: { prev?: NavLink; next?: NavLink } = $props();

  // ---- The "script": one entry per generation round -------------------------------------------
  // Every round shows the same three phases, which is the whole point: inference is a loop.
  type Kind = 'prompt' | 'gen' | 'eos';
  interface Tok { text: string; id: number; kind: Kind }
  interface Round { dist: { text: string; p: number }[]; pick: Tok }

  const promptText = 'The capital of France is';
  const prompt: Tok[] = [
    { text: 'The', id: 791, kind: 'prompt' },
    { text: ' capital', id: 6864, kind: 'prompt' },
    { text: ' of', id: 315, kind: 'prompt' },
    { text: ' France', id: 9822, kind: 'prompt' },
    { text: ' is', id: 374, kind: 'prompt' },
  ];
  const rounds: Round[] = [
    { dist: [{ text: ' Paris', p: 0.82 }, { text: ' Lyon', p: 0.05 }, { text: ' a', p: 0.04 }, { text: ' the', p: 0.03 }], pick: { text: ' Paris', id: 12366, kind: 'gen' } },
    { dist: [{ text: '.', p: 0.71 }, { text: ',', p: 0.15 }, { text: ' and', p: 0.06 }, { text: '!', p: 0.02 }], pick: { text: '.', id: 13, kind: 'gen' } },
    { dist: [{ text: '<EOS>', p: 0.88 }, { text: ' It', p: 0.05 }, { text: ' The', p: 0.03 }, { text: '\\n', p: 0.02 }], pick: { text: '<EOS>', id: 2, kind: 'eos' } },
  ];

  // ---- Expand the script into flat steps: each step is a complete state + caption -------------
  type Phase = 'raw' | 'tokenize' | 'forward' | 'sample' | 'append' | 'done' | 'tally';
  interface Step { phase: Phase; seq: Tok[]; round?: Round; caption: string }

  function buildSteps(): Step[] {
    const steps: Step[] = [];
    let seq = [...prompt];
    steps.push({ phase: 'raw', seq: [], caption: `A prompt is just a string.` });
    steps.push({ phase: 'tokenize', seq, caption: `Split into tokens, each one an integer id. The model never sees the text, only these numbers.` });
    rounds.forEach((round, i) => {
      const n = seq.length;
      steps.push({
        phase: 'forward', seq, round,
        caption: i === 0
          ? `<b>Forward pass.</b> All ${n} ids go in, and out comes a score for every token in the vocabulary. One guess at what comes next.`
          : `Forward pass again, on all ${n}. The first ${prompt.length} get computed from scratch, same as before.`,
      });
      steps.push({
        phase: 'sample', seq, round,
        caption: i === 0
          ? `Softmax turns the scores into probabilities. Take the top one, or sample.`
          : round.pick.kind === 'eos'
            ? `This time the top pick is <code>&lt;EOS&gt;</code>. It's a normal token in the vocabulary; the model learned to produce it when it's done.`
            : `Pick again.`,
      });
      seq = [...seq, round.pick];
      steps.push({
        phase: round.pick.kind === 'eos' ? 'done' : 'append', seq, round,
        caption: round.pick.kind === 'eos'
          ? `<b>Stop.</b> Decode the ids back to text. That's inference: tokenize, then forward, pick, append, until EOS.`
          : i === 0
            ? `<b>Append it.</b> The output becomes part of the input, which is all "autoregressive" means.`
            : `Append.`,
      });
    });
    const counts = rounds.map((_, r) => prompt.length + r);
    const total = counts.reduce((a, b) => a + b, 0);
    steps.push({
      phase: 'tally', seq,
      caption: `<b>The bill.</b> ${total} positions computed for ${rounds.length} new tokens. The first ${prompt.length} columns got the exact same treatment ${rounds.length} times. What's actually being recomputed?`,
    });
    return steps;
  }

  const steps = buildSteps();
  let step = $state(0);
  // Deep-linkable: ?step=7 opens at step 7 (1-based). Applied after hydration so server HTML matches.
  $effect(() => {
    const q = Number(new URLSearchParams(window.location.search).get('step'));
    if (q >= 1 && q <= steps.length) step = q - 1;
  });
  const cur = $derived(steps[step]);

  // ---- Geometry (SVG viewBox units; the SVG scales to fill the stage) ---------------------------
  const W = 720, H = 400;
  const charW = 8.2, padX = 10, gap = 6, tokH = 30, seqY = 44;
  const boxW = (t: Tok) => Math.round(t.text.length * charW + padX * 2);
  const layout = $derived.by(() => {
    let x = 16;
    return cur.seq.map((t) => { const w = boxW(t); const item = { t, x, w }; x += w + gap; return item; });
  });
  const seqEndX = $derived(layout.length ? layout[layout.length - 1].x + layout[layout.length - 1].w : 16);

  const modelX = W / 2 - 110, modelY = 140, modelW = 220, modelH = 54;
  const distY = 240, barH = 18, barGap = 8, barMaxW = 300, barLabelX = 250;
  const tallyY = 130, tallyRow = 32, tallySz = 22;
  const counts = rounds.map((_, r) => prompt.length + r);

  const fill = (k: Kind) => (k === 'prompt' ? 'var(--accent-soft)' : k === 'gen' ? 'var(--gen-soft)' : 'var(--eos-soft)');
  const stroke = (k: Kind) => (k === 'prompt' ? 'var(--accent)' : k === 'gen' ? 'var(--gen)' : 'var(--eos)');
  const showModel = $derived(['forward', 'sample', 'append', 'done'].includes(cur.phase));
  const showDist = $derived(['sample', 'append', 'done'].includes(cur.phase));
  const flying = $derived(cur.phase === 'append' || cur.phase === 'done');
  const detok = $derived(cur.seq.filter((t) => t.kind !== 'eos').map((t) => t.text).join(''));
  const generated = $derived(detok.slice(promptText.length));

  // how each token box enters, depending on why it appeared
  function enter(i: number) {
    if (cur.phase === 'tokenize') return { y: -14, delay: i * 70, duration: 300, easing: cubicOut };
    if (flying && i === layout.length - 1) return { y: 120, duration: 450, easing: cubicOut };
    return { duration: 0 };
  }
</script>

<figure class="viz">
  <div class="canvas">
    <svg viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Autoregressive generation, step {step + 1}">
      <!-- Row 1: the raw prompt, then the token sequence -->
      <text x="16" y="22" class="label">{cur.phase === 'raw' ? 'prompt' : `sequence (${cur.seq.length} tokens)`}</text>
      {#if cur.phase === 'raw'}
        <g out:fade={{ duration: 200 }}>
          <rect x="16" y={seqY} width={promptText.length * charW + padX * 2} height={tokH} rx="6" fill="white" stroke="var(--line)" stroke-width="1.5" />
          <text x={16 + padX} y={seqY + 19} class="tok">"{promptText}"</text>
        </g>
      {/if}
      {#each layout as { t, x, w }, i (i)}
        <g in:fly={enter(i)}>
          <rect {x} y={seqY} width={w} height={tokH} rx="6" fill={fill(t.kind)} stroke={stroke(t.kind)} stroke-width="1.5"
                class:pulse={cur.phase === 'forward'} style="animation-delay: {i * 60}ms" />
          <text x={x + w / 2} y={seqY + 19} text-anchor="middle" class="tok">{t.text.replace(/^ /, '␣')}</text>
          <text x={x + w / 2} y={seqY + tokH + 14} text-anchor="middle" class="id">{t.id}</text>
        </g>
      {/each}

      <!-- Model box with wires in and out -->
      {#if showModel}
        <g transition:fade={{ duration: 250 }}>
          <path d="M {seqEndX + 4} {seqY + tokH / 2} H {seqEndX + 22} V {seqY + tokH + 24} H {W / 2} V {modelY - 6}"
                class="wire" class:active={cur.phase === 'forward'} />
          <polygon points="{W / 2 - 5},{modelY - 8} {W / 2 + 5},{modelY - 8} {W / 2},{modelY}" fill="var(--muted)" />
          <rect x={modelX} y={modelY} width={modelW} height={modelH} rx="10" class="model" class:busy={cur.phase === 'forward'} />
          <text x={W / 2} y={modelY + 24} text-anchor="middle" class="model-title">transformer</text>
          <text x={W / 2} y={modelY + 42} text-anchor="middle" class="model-sub">
            {cur.phase === 'forward' ? `processing ${cur.seq.length} tokens…` : 'scores for every vocab token'}
          </text>
          <path d="M {W / 2} {modelY + modelH} V {distY - 10}" class="wire" class:active={cur.phase === 'sample'} />
          <polygon points="{W / 2 - 5},{distY - 12} {W / 2 + 5},{distY - 12} {W / 2},{distY - 4}" fill="var(--muted)" />
        </g>
      {/if}

      <!-- Next-token distribution -->
      {#if showDist && cur.round}
        <g transition:fade={{ duration: 250 }}>
          <text x={barLabelX - 60} y={distY + 4} class="label">p(next token | sequence)</text>
          {#each cur.round.dist as d, i}
            {@const y = distY + 14 + i * (barH + barGap)}
            {@const chosen = d.text === cur.round.pick.text}
            <text x={barLabelX - 8} y={y + 13} text-anchor="end" class="tok" class:dim={!chosen}>{d.text.replace(/^ /, '␣')}</text>
            <rect x={barLabelX} {y} width={d.p * barMaxW} height={barH} rx="3"
                  fill={chosen ? stroke(cur.round.pick.kind) : 'var(--line)'} class="bar" />
            <text x={barLabelX + d.p * barMaxW + 6} y={y + 13} class="id" class:dim={!chosen}>{d.p.toFixed(2)}</text>
          {/each}
          {#if cur.phase === 'sample'}
            <text x={barLabelX + barMaxW + 50} y={distY + 27} class="pick" in:fade>← pick</text>
          {/if}
        </g>
      {/if}

      <!-- Done: decoded output -->
      {#if cur.phase === 'done'}
        <g in:fade>
          <rect x="16" y={modelY + 12} width="200" height="30" rx="6" fill="white" stroke="var(--eos)" />
          <text x="28" y={modelY + 31} class="id">output: <tspan class="out">"{generated}"</tspan></text>
        </g>
      {/if}

      <!-- Tally: one row of cells per round, aligned under the token each cell recomputed -->
      {#if cur.phase === 'tally'}
        <g in:fade>
          {#each counts as n, r}
            {@const y = tallyY + r * tallyRow}
            {#each layout.slice(0, n) as { t, x, w }, c}
              <rect x={x + w / 2 - tallySz / 2} {y} width={tallySz} height={tallySz} rx="4" fill={fill(t.kind)} stroke={stroke(t.kind)}
                    in:fly={{ y: -8, delay: (r * 8 + c) * 35, duration: 250 }} />
            {/each}
            {@const last = layout[n - 1]}
            <text x={last.x + last.w / 2 + tallySz / 2 + 10} y={y + 15} class="id" in:fade={{ delay: (r * 8 + n) * 35 }}>round {r + 1} · {n} positions</text>
          {/each}
          <g in:fade={{ delay: 900 }}>
            <text x="16" y={tallyY + rounds.length * tallyRow + 22} class="sum">{counts.join(' + ')} = {counts.reduce((a, b) => a + b, 0)} positions computed</text>
            <text x="16" y={tallyY + rounds.length * tallyRow + 44} class="sum">{rounds.length} tokens produced</text>
            <text x="16" y={tallyY + rounds.length * tallyRow + 70} class="id">the {prompt.length} prompt columns: same input, same output, computed {rounds.length}×</text>
          </g>
        </g>
      {/if}
    </svg>
  </div>

  <StepControls {step} total={steps.length} caption={cur.caption} {prev} {next} onchange={(s) => (step = s)} />
</figure>

<style>
  .viz { margin: 0; display: flex; flex-direction: column; min-height: 0; }
  .canvas { flex: 1 1 auto; min-height: 0; border: 1px solid var(--line); border-radius: 16px; background: white; padding: 0.75rem; box-shadow: 0 1px 2px rgba(0,0,0,0.03), 0 12px 32px -20px rgba(0,0,0,0.12); }
  svg { display: block; width: 100%; height: 100%; font-family: var(--sans); }
  .label { font-size: 11px; fill: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .tok { font-family: var(--mono); font-size: 13px; fill: var(--fg); }
  .id { font-family: var(--mono); font-size: 10.5px; fill: var(--muted); }
  .sum { font-size: 15px; font-weight: 600; fill: var(--fg); }
  .out { fill: var(--fg); }
  .dim { opacity: 0.45; }
  .pick { font-size: 12px; fill: var(--fg); font-weight: 600; }
  .wire { fill: none; stroke: var(--line); stroke-width: 2; transition: stroke 300ms; }
  .wire.active { stroke: var(--accent); stroke-dasharray: 6 4; animation: march 700ms linear infinite; }
  .model { fill: #f3f1ec; stroke: var(--line); stroke-width: 1.5; transition: stroke 300ms, fill 300ms; }
  .model.busy { stroke: var(--accent); fill: var(--accent-soft); }
  .model-title { font-size: 14px; font-weight: 600; fill: var(--fg); }
  .model-sub { font-size: 11px; fill: var(--muted); }
  .bar { transition: width 400ms ease-out, fill 300ms; }
  rect.pulse { animation: pulse 900ms ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.45 } }
  @keyframes march { to { stroke-dashoffset: -20 } }
</style>
