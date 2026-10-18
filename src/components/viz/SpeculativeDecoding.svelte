<script lang="ts">
  import { untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import StepControls from '../StepControls.svelte';
  import LoopProgress from '../LoopProgress.svelte';
  import { chapterNumber as chNum, type NavLink } from '../../chapters';
  import { W_GB, BW, GFLOP_PER_TOKEN, TFLOPS, LAYERS, D_MODEL, D_FF, BYTES } from '../../numbers';
  let { prev, next }: { prev?: NavLink; next?: NavLink } = $props();

  const CH_QUANT = chNum('22-quantization');

  // ---- one request decoding alone, Llama-3-8B on one H100 (Ch. 4 Steps 3 and 5) ----
  const T_READ = (W_GB / (BW * 1000)) * 1000;          // 4.8 ms: the weight read
  const T_TOK = GFLOP_PER_TOKEN / TFLOPS;              // 0.016 ms of math per position
  const fmt1 = (ms: number) => ms.toFixed(1);
  const N = 4;                                          // tokens the example writes
  const T_PLAIN = N * T_READ;                           // 19.1 ms without speculation
  // a pass takes as long as its read; even 5 positions' math (0.08 ms) finishes inside it (Ch. 4 Step 5)

  // the running example: chapter 1's prompt, the target's continuation, and a draft that misses on the 4th token
  const CTX = 'The capital of France is';
  const TARGET = [' Paris', '.', ' It', ' is'];
  const DRAFT = [' Paris', '.', ' The', ' city'];
  const KEPT = DRAFT.findIndex((t, i) => t !== TARGET[i]);   // 2 agreed; the 3rd is the target's own, the 4th thrown away

  // DSpark's Table 1, Qwen3-8B target, accepted length per round (counting the target's own token)
  const TABLE = [
    { d: 'GSM8K · math', v: [5.30, 5.33, 6.17] },
    { d: 'HumanEval · code', v: [4.33, 4.64, 5.52] },
    { d: 'MT-Bench · chat', v: [2.66, 3.11, 3.72] },
  ];

  type Scene = 'pass' | 'before' | 'after' | 'map' | 'eagle' | 'dflash' | 'dspark' | 'compare';
  const steps: { scene: Scene; caption: string }[] = [
    { scene: 'pass', caption: `A position is one token the pass works on, one row of numbers. Each layer's weights arrive once and every row is multiplied by them while the next layer is read, so 5 rows make the math longer but not the pass.` },
    { scene: 'before', caption: `Normal decoding writes one token per pass, and each pass reads all ${W_GB} GB of weights in ${fmt1(T_READ)} ms. Five positions in one pass do 5 times the math, and the math still finishes inside that one read.` },
    { scene: 'after', caption: `So guess the next tokens. A draft model proposes ${N}, and the target checks them in one pass. It keeps the ones it agrees with, puts its own token at the first miss, and drops the rest, here ${KEPT + 1} tokens.` },
    { scene: 'map', caption: `The three drafters differ in how they make the ${N} guesses. EAGLE makes them one pass at a time, DFlash all in one pass, and DSpark in one pass plus a short chain that links each guess to the one before.` },
    { scene: 'eagle', caption: `EAGLE drafts with one extra layer that reads the target's own hidden states. Each pass makes one guess, and the next pass needs that guess, so ${N} guesses take ${N} passes in a row.` },
    { scene: 'dflash', caption: `DFlash's drafter is 5 small layers of its own, fed the target's hidden states as context. The last token and ${N - 1} blanks go through all 5 layers once, and ${N} guesses come out together.` },
    { scene: 'dspark', caption: `DSpark runs DFlash's one pass, then a small head links each guess to the one above it. It scores each guess's chance to survive and sends the target only the ones worth checking.` },
    { scene: 'compare', caption: `Normal decoding gets 1 token per target pass. With the same training data and 7 guesses a round, the three drafters get 2.7 to 6.2, and DSpark gets the most in every domain.` },
  ];

  let step = $state(0);
  $effect(() => {
    const q = Number(new URLSearchParams(window.location.search).get('step'));
    if (q >= 1 && q <= steps.length) step = q - 1;
  });
  const cur = $derived(steps[step]);
  // step 3's animation, played once: the draft's 4 guesses one by one, the verify pass, the target's picks, what is kept
  let lap = $state(0), lapMs = $state(0);           // the looping step's laps, for LoopProgress
  const nextLap = (ms: number) => untrack(() => { lapMs = ms; lap++; });   // untracked, so starting a lap does not re-run the effect
  let sp = $state(7);
  $effect(() => {
    if (cur.scene !== 'after') return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const AT = [800, 1900, 3000, 4100, 5400, 7200, 8800];
    sp = 0;
    AT.forEach((t, i) => timers.push(setTimeout(() => (sp = i + 1), t)));
    nextLap(AT[AT.length - 1]);
    return () => timers.forEach(clearTimeout);
  });
  const W = 720, H = 400;
  const RED = 'var(--eos)', GREEN = '#16a34a', DRAFT_C = 'var(--gen)', TARGET_C = 'var(--accent)';

  // the shared time axis of steps 2 and 3
  const X0 = 74, PX_MS = 26;
  const tx = (ms: number) => X0 + ms * PX_MS;
  const BURSTS = 16;                                    // the compute lane's bursts, a layer pair each: math happens as each layer's weights arrive
  const BURST_W = 1.2;                                  // one position's burst, drawn wide enough to see
  const MATH_X = Math.round((BURSTS * BURST_W) / (T_TOK * PX_MS));   // how much wider than scale
  const T_GUESS = 0.3;                                  // one draft pass, drawn at a nominal length (steps 5–7)
  const DRAFT_END = N * T_GUESS;
  // the rows steps 2 and 3 share
  const YA = 96, YB = 160, BAR_H = 22, AXIS_Y = 204;
</script>

<figure class="viz">
  <div class="canvas">
    <svg viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Speculative decoding, step {step + 1}">
      <defs>
        {#each [['sd-arrow', '#b8b4aa'], ['sd-arrow-gen', 'var(--gen)'], ['sd-arrow-acc', 'var(--accent)'], ['sd-arrow-fg', 'var(--fg)'], ['sd-arrow-grn', '#16a34a']] as [id, c]}
          <marker {id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={c} />
          </marker>
        {/each}
      </defs>

      <!-- the pieces steps 2 and 3 share: the axis, one pass (its read, its math), the autoregressive row -->
      {#snippet axis(y: number)}
        <line x1={tx(0)} y1={y} x2={tx(20)} y2={y} stroke="var(--faint)" />
        {#each [0, 5, 10, 15, 20] as t}
          <line x1={tx(t)} y1={y} x2={tx(t)} y2={y + 4} stroke="var(--faint)" />
          <text x={tx(t)} y={y + 16} text-anchor="middle" class="tag">{t} ms</text>
        {/each}
      {/snippet}
      {#snippet pass(t0: number, y: number, positions: number, label: string)}
        <rect x={tx(t0)} {y} width={T_READ * PX_MS - 3} height={BAR_H} rx="4" fill="#5b5b5b" />
        <text x={tx(t0) + (T_READ * PX_MS) / 2} y={y + 15} text-anchor="middle" class="tag onbox">{label}</text>
        <rect x={tx(t0)} y={y + BAR_H + 3} width={T_READ * PX_MS - 3} height="8" rx="2" fill="none" stroke="var(--line)" />
        {#each Array(BURSTS) as _, b}
          <rect x={tx(t0) + 1 + (b * (T_READ * PX_MS - 5)) / BURSTS} y={y + BAR_H + 4} width={BURST_W * positions} height="6" rx="0.5" fill={TARGET_C} />
        {/each}
      {/snippet}
      {#snippet lanes(y: number)}
        <text x={X0 - 8} y={y + 15} text-anchor="end" class="tag strong">memory</text>
        <text x={X0 - 8} y={y + BAR_H + 10} text-anchor="end" class="tag strong">compute</text>
      {/snippet}
      {#snippet autoregressive()}
        <text x="16" y="64" class="boxtitle">normal autoregressive decoding</text>
        {@render lanes(YA)}
        {#each TARGET as t, i}
          <rect x={tx(i * T_READ) + 32} y="72" width={T_READ * PX_MS - 67} height="18" rx="5" fill="var(--accent-soft)" stroke={TARGET_C} />
          <text x={tx(i * T_READ) + (T_READ * PX_MS) / 2 - 1} y="85" text-anchor="middle" class="mono strong">{t.trim()}</text>
          {@render pass(i * T_READ, YA, 1, 'reads 16 GB')}
        {/each}
        <text x={tx(T_PLAIN) + 8} y={YA + 15} class="tag strong">{N} tokens · {fmt1(T_PLAIN)} ms</text>
      {/snippet}

      <!-- 1: inside one pass · each layer's weights arrive, its math runs while the next layer is read; 1 position against 5 -->
      {#if cur.scene === 'pass'}
        {@const LX0 = 92}
        {@const LN = 6}
        {@const LCW = 66}
        {@const BW1 = 5}
        {@const lx = (k: number) => LX0 + k * LCW}
        {@const panels = [{ y: 78, n: 1, t: '1 position · normal decoding, the newest token' }, { y: 182, n: 5, t: '5 positions · 5 tokens in one pass, as prefill does' }]}
        {@const MX = 536}
        {@const W_MB = Math.round((D_MODEL * D_FF * BYTES) / 1e6)}
        {@const fmtN = (n: number) => n.toLocaleString('en-US')}
        {@const ENL = Math.round(BW1 / ((T_TOK / LAYERS) * (LCW / (T_READ / LAYERS))))}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">inside one pass · the weights arrive a layer at a time · the first {LN} of {LAYERS} layers</text>
          {#each panels as p, pi}
            <g in:fade={{ delay: 100 + pi * 700, duration: 250 }}>
              <text x="16" y={p.y} class="boxtitle">{p.t}</text>
              <text x={LX0 - 8} y={p.y + 25} text-anchor="end" class="tag strong">memory</text>
              <text x={LX0 - 8} y={p.y + 53} text-anchor="end" class="tag strong">compute</text>
              {#each Array(LN) as _, k}
                <rect x={lx(k)} y={p.y + 10} width={LCW - 2} height="22" rx="3" fill="#5b5b5b" opacity={k % 2 ? 0.8 : 1} />
                <text x={lx(k) + LCW / 2} y={p.y + 25} text-anchor="middle" class="tag onbox">layer {k + 1}</text>
                <rect x={lx(k) + LCW - 2} y={p.y + 40} width={BW1 * p.n} height="18" rx="2" fill={TARGET_C} />
              {/each}
              <rect x={lx(0)} y={p.y + 40} width={LN * LCW + BW1 * p.n} height="18" rx="3" fill="none" stroke="var(--line)" />
              <!-- one layer's math: the positions' rows times a weight matrix -->
              {#each Array(p.n) as _, r}
                <rect x={MX} y={p.y + 8 + r * 8} width="34" height="7" rx="1.5" fill="var(--accent-soft)" stroke={TARGET_C} stroke-width="0.8" />
              {/each}
              <text x={MX + 44} y={p.y + 27} text-anchor="middle" class="tag strong">×</text>
              <rect x={MX + 54} y={p.y + 4} width="50" height="44" rx="3" fill="#5b5b5b" />
              <text x={MX + 79} y={p.y + 30} text-anchor="middle" class="tag onbox">W</text>
              <text x={MX} y={p.y + 64} class="tag"><tspan class="strong">x</tspan> · {p.n} × {fmtN(D_MODEL)}, a row per position</text>
              <text x={MX} y={p.y + 77} class="tag"><tspan class="strong">W</tspan> · {fmtN(D_MODEL)} × {fmtN(D_FF)} = {W_MB} MB</text>
            </g>
          {/each}
          <!-- what the picture shows, on the first panel -->
          <g in:fade={{ delay: 1500, duration: 250 }}>
            <path d="M {lx(1) + 2} {78 + 61} V {78 + 66}" fill="none" stroke="var(--faint)" stroke-width="1" />
            <text x={lx(1) - 4} y={78 + 77} class="tag">layer 1's math runs while layer 2 is read, then waits</text>
          </g>
          <g in:fade={{ delay: 2000 }}>
            <text x={W / 2} y="296" text-anchor="middle" class="legend">5 rows make each burst of math 5 times longer, and it still ends before the next layer arrives</text>
            <text x={W / 2} y="314" text-anchor="middle" class="legend">so the pass ends when the read ends: {fmt1(T_READ)} ms, for 1 position or 5</text>
          </g>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">W: one of a layer's weight matrices (the MLP's gate) · the pass: {fmt1(T_READ)} ms of reading, {T_TOK.toFixed(3)} ms of math a position (Ch. 4 Step 5)</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">the math is drawn about {ENL}× wider than scale so it shows</text>
        </g>
      {/if}

      <!-- 1: before and after · one pass per token, against one pass over 5 positions -->
      {#if cur.scene === 'before'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">one request on Llama-3-8B and one H100 · {N} tokens two ways</text>
          <g in:fade={{ delay: 100, duration: 250 }}>{@render autoregressive()}</g>
          <g in:fade={{ delay: 600, duration: 250 }}>
            <text x="16" y="152" class="boxtitle">one pass over 5 positions · if the next {N} tokens were known</text>
            {@render lanes(YB)}
            {@render pass(0, YB, 5, 'reads 16 GB')}
            <text x={tx(T_READ) + 8} y={YB + 15} class="tag strong">one read · {fmt1(T_READ)} ms</text>
            <text x={tx(T_READ) + 8} y={YB + 30} class="tag">5 positions' math: still inside the read</text>
            {@render axis(AXIS_Y)}
          </g>
          <g in:fade={{ delay: 900, duration: 250 }}>
            <rect x="16" y="240" width="16" height="10" rx="2" fill="#5b5b5b" />
            <text x="38" y="249" class="tag">reading {W_GB} GB of weights, {fmt1(T_READ)} ms</text>
            <rect x="270" y="242" width="6" height="6" rx="1" fill={TARGET_C} />
            <text x="282" y="249" class="tag">math, done layer by layer as the weights arrive: {T_TOK.toFixed(3)} ms a position</text>
          </g>
          <g in:fade={{ delay: 1200 }}>
            <text x={W / 2} y="300" text-anchor="middle" class="legend">if the next {N} tokens were known, {N} reads would become 1</text>
          </g>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">the math is drawn about {MATH_X}× wider than scale so it shows</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">batch 1 · the KV cache read is left out, small at this length (Ch. 4 Step 6)</text>
        </g>
      {/if}

      <!-- 3: speculative decoding · step 2's second row, built as it happens: the draft's guesses, then one pass that checks them -->
      {#if cur.scene === 'after'}
        {@const CX = 150}
        {@const CW = 86}
        {@const ROWS = [{ y: 244, n: 'the draft guesses', c: DRAFT_C }, { y: 272, n: "the target's picks", c: TARGET_C }, { y: 300, n: 'kept', c: 'var(--fg)' }]}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">speculative decoding · step 2's second row, with a draft in front</text>
          {@render autoregressive()}

          <!-- the speculative row, built on its timeline as the round runs -->
          <text x="16" y="152" class="boxtitle">speculative decoding</text>
          {@render lanes(YB)}
          {#each Array(N) as _, k}
            {#if sp >= k + 1}
              <g transition:fade={{ duration: 200 }}>
                <rect x={tx(k * T_GUESS)} y={YB} width={T_GUESS * PX_MS - 1.5} height={BAR_H} rx="2" fill={DRAFT_C} opacity="0.85" />
                <rect x={tx(k * T_GUESS) + T_GUESS * PX_MS - 3} y={YB + BAR_H + 4} width="1.5" height="6" fill={DRAFT_C} />
              </g>
            {/if}
          {/each}
          {#if sp >= 5}
            <g transition:fade={{ duration: 150 }}>{@render pass(DRAFT_END, YB, 5, 'verify · 5 positions')}</g>
          {/if}
          {#if sp >= 1}<text x={tx(DRAFT_END + T_READ) + 8} y={YB + 30} class="tag" style:fill={DRAFT_C} transition:fade={{ duration: 200 }}>amber: the draft, a small model · {N} passes, each a small read and a little math</text>{/if}
          {#if sp >= 7}
            <text x={tx(DRAFT_END + T_READ) + 8} y={YB + 15} class="tag strong" transition:fade={{ duration: 300 }}>{KEPT + 1} tokens · draft + {fmt1(T_READ)} ms</text>
          {/if}
          {@render axis(AXIS_Y)}

          <!-- the tokens, filled in step with the timeline -->
          {#each ROWS as r, ri}
            <text x="16" y={r.y + 14} class="tag strong" style:fill={r.c}>{r.n}</text>
            {#each Array(N) as _, k}
              {@const show = ri === 0 ? sp >= k + 1 : ri === 1 ? sp >= 6 : sp >= 7}
              {@const gone = ri > 0 && k > KEPT}
              {@const t = ri === 0 ? DRAFT[k] : TARGET[k]}
              <rect x={CX + k * CW} y={r.y} width={CW - 16} height="20" rx="5" fill="none" stroke="var(--line)" stroke-dasharray="3 3" />
              {#if show}
                <g transition:fade={{ duration: 250 }}>
                  {#if gone}
                    <text x={CX + k * CW + (CW - 16) / 2} y={r.y + 14} text-anchor="middle" class="tag" style:fill={RED}>{ri === 1 ? 'not used' : 'thrown away'}</text>
                  {:else}
                    <rect x={CX + k * CW} y={r.y} width={CW - 16} height="20" rx="5"
                      fill={ri === 0 ? 'var(--gen-soft)' : ri === 1 ? 'var(--accent-soft)' : k < KEPT ? '#dcfce7' : 'var(--accent-soft)'}
                      stroke={ri === 0 ? DRAFT_C : ri === 1 ? TARGET_C : k < KEPT ? GREEN : TARGET_C} />
                    <text x={CX + k * CW + (CW - 16) / 2} y={r.y + 14} text-anchor="middle" class="mono strong">{t.trim()}</text>
                    {#if ri === 1}
                      <text x={CX + k * CW + CW - 13} y={r.y + 14} class="tag strong" style:fill={k < KEPT ? GREEN : RED}>{k < KEPT ? '✓' : '✗'}</text>
                    {/if}
                  {/if}
                </g>
              {/if}
            {/each}
          {/each}
          {#if sp >= 7}
            <g transition:fade={{ duration: 300 }}>
              {#each ['"Paris" and "." match: kept', '"The" is wrong: "It" replaces it', '"city" came after "The": dropped'] as line, li}
                <text x={CX + N * CW + 2} y={282 + li * 15} class="pt">·</text>
                <text x={CX + N * CW + 12} y={282 + li * 15} class="tag">{line}</text>
              {/each}
              <rect x="30" y="330" width="660" height="26" rx="13" fill="var(--accent-soft)" stroke="var(--accent)" />
              <text x={W / 2} y="347" text-anchor="middle" class="need"><tspan class="strong">time per token</tspan> = (the draft's small reads + the target's one read) ÷ tokens kept</text>
            </g>
          {/if}
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">the draft is drawn at a nominal length (its cost is steps 5–7) · with sampling, an acceptance test keeps the target's distribution</text>
          <LoopProgress ms={lapMs} {lap} label="plays once" />
        </g>
      {/if}

      <!-- 3: the map · the same 4 guesses three ways; DSpark is DFlash's pass plus EAGLE's link between guesses -->
      {#if cur.scene === 'map'}
        {@const CW = 220}
        {@const CX = [16, 250, 484]}
        {@const GY = 132}
        {@const BY = 180}
        {@const IY = 222}
        {@const gx = (x: number, j: number) => x + 14 + j * 49}
        {@const cards = [
          { n: 'EAGLE', passes: `${N} passes, one after another`, link: 'each guess sees the one before' },
          { n: 'DFlash', passes: '1 pass for all of them', link: 'each guess made on its own' },
          { n: 'DSpark', passes: "DFlash's 1 pass, then a short chain", link: 'each guess sees the one before' },
        ]}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">three drafters · the same {N} guesses, made three ways · read each card bottom to top</text>
          {#each cards as c, i}
            {@const x = CX[i]}
            <g in:fade={{ delay: 100 + i * 400, duration: 250 }}>
              <rect {x} y="56" width={CW} height="250" rx="12" fill="#fbfaf7" stroke="var(--line)" />
              <text x={x + 14} y="76" class="boxtitle">{i + 1} of 3</text>
              <text x={x + 14} y="96" class="slab strong small">{c.n}</text>
              {#each DRAFT as t, j}
                <rect x={gx(x, j)} y={GY} width="40" height="20" rx="5" fill="var(--gen-soft)" stroke={DRAFT_C} />
                <text x={gx(x, j) + 20} y={GY + 14} text-anchor="middle" class="mono strong">{t.trim()}</text>
              {/each}
              {#if i === 0}
                {#each Array(N) as _, j}
                  <rect x={gx(x, j)} y={BY} width="40" height="22" rx="5" fill={DRAFT_C} opacity="0.85" />
                  <text x={gx(x, j) + 20} y={BY + 15} text-anchor="middle" class="tag onbox">pass {j + 1}</text>
                  <path d="M {gx(x, j) + 20} {BY - 2} V {GY + 26}" fill="none" stroke={DRAFT_C} stroke-width="1.3" marker-end="url(#sd-arrow-gen)" />
                  {#if j < N - 1}
                    <path d="M {gx(x, j) + 36} {GY + 22} C {gx(x, j) + 40} {GY + 34}, {gx(x, j + 1) + 8} {BY - 18}, {gx(x, j + 1) + 8} {BY - 10} L {gx(x, j + 1) + 8} {BY - 3}" fill="none" stroke={DRAFT_C} stroke-width="1.2" stroke-dasharray="3 2" marker-end="url(#sd-arrow-gen)" />
                  {/if}
                {/each}
                <rect x={gx(x, 0)} y={IY} width="40" height="18" rx="5" fill="var(--accent-soft)" stroke={TARGET_C} />
                <text x={gx(x, 0) + 20} y={IY + 13} text-anchor="middle" class="mono strong">is</text>
                <path d="M {gx(x, 0) + 20} {IY - 2} V {BY + 26}" fill="none" stroke={TARGET_C} stroke-width="1.2" marker-end="url(#sd-arrow-acc)" />
                <text x={gx(x, 1)} y={IY + 13} class="tag">dashed: a guess fed back in</text>
              {:else}
                <rect x={gx(x, 0)} y={BY} width={3 * 49 + 40} height="22" rx="5" fill={DRAFT_C} opacity="0.85" />
                <text x={gx(x, 0) + (3 * 49 + 40) / 2} y={BY + 15} text-anchor="middle" class="tag onbox">{i === 1 ? 'one pass' : "DFlash's one pass"}</text>
                {#each Array(N) as _, j}
                  <path d="M {gx(x, j) + 20} {BY - 2} V {GY + 26}" fill="none" stroke={DRAFT_C} stroke-width="1.3" marker-end="url(#sd-arrow-gen)" />
                  <rect x={gx(x, j)} y={IY} width="40" height="18" rx="5" fill={j ? 'white' : 'var(--accent-soft)'} stroke={j ? 'var(--faint)' : TARGET_C} stroke-dasharray={j ? '3 2' : 'none'} />
                  <text x={gx(x, j) + 20} y={IY + 13} text-anchor="middle" class={j ? 'tag' : 'mono strong'}>{j ? 'blank' : 'is'}</text>
                  <path d="M {gx(x, j) + 20} {IY - 2} V {BY + 26}" fill="none" stroke="#b8b4aa" stroke-width="1.2" marker-end="url(#sd-arrow)" />
                {/each}
                {#if i === 2}
                  {#each Array(N - 1) as _, j}
                    <path d="M {gx(x, j) + 22} {GY - 2} Q {(gx(x, j) + gx(x, j + 1)) / 2 + 20} {GY - 20}, {gx(x, j + 1) + 18} {GY - 4}" fill="none" stroke={GREEN} stroke-width="1.6" marker-end="url(#sd-arrow-grn)" />
                  {/each}
                {/if}
              {/if}
              <text x={x + 14} y="272" class="tag strong">{c.passes}</text>
              <text x={x + 14} y="288" class="tag" style:fill={i === 1 ? RED : GREEN}>{c.link}</text>
            </g>
          {/each}
          <text x={W / 2} y="334" text-anchor="middle" class="legend" in:fade={{ delay: 1500 }}>DSpark is DFlash's one pass plus EAGLE's link between guesses (green), made cheap</text>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">{N} guesses each to compare them · the defaults are 5 steps for EAGLE in SGLang and a block of 16 for DFlash</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">SGLang: --speculative-algorithm EAGLE3 or DFLASH; DSpark runs under the same block flags as DFLASH</text>
        </g>
      {/if}

      <!-- the target's layers, drawn across, with tapped layers lit; shared by steps 5 and 6 -->
      {#snippet layers(x: number, y: number, taps: number[], names: string[])}
        <text {x} y={y - (names.length ? 20 : 8)} class="tag strong">the target · {LAYERS} layers, left to right</text>
        {#each Array(LAYERS) as _, l}
          <rect x={x + l * 7} {y} width="5" height="30" rx="1" fill={taps.includes(l) ? TARGET_C : 'var(--line)'} />
        {/each}
        {#each taps as l, k}
          {#if names[k]}<text x={x + l * 7 + 2.5} y={y - 5} text-anchor="middle" class="tag">{names[k]}</text>{/if}
        {/each}
      {/snippet}
      {#snippet num(x: number, y: number, n: number)}
        <circle cx={x} cy={y} r="8" fill="var(--fg)" />
        <text {x} y={y + 3.5} text-anchor="middle" class="tag onbox">{n}</text>
      {/snippet}

      <!-- 4: 1 of 3, EAGLE · a chain, left to right: each pass takes the guess before it -->
      {#if cur.scene === 'eagle'}
        {@const CY = 214}
        {@const HW = 50}
        {@const KW = 44}
        {@const AR = 14}
        {@const X0E = 70}
        {@const hx = (k: number) => X0E + 40 + AR + k * (HW + AR + KW + AR)}
        {@const kx = (k: number) => hx(k) + HW + AR}
        {@const TAPS = [3, 16, 29]}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">1 of 3 · EAGLE · one small layer, one guess per pass</text>
          <!-- ① the target's hidden states, fused -->
          <g in:fade={{ delay: 100, duration: 250 }}>
            {@render num(30, 96, 1)}
            {@render layers(hx(0) - 60, 82, TAPS, ['low', 'middle', 'high'])}
            {#each TAPS as l}
              <path d="M {hx(0) - 60 + l * 7 + 2.5} 114 C {hx(0) - 60 + l * 7 + 2.5} 150, {hx(0) + HW / 2} 160, {hx(0) + HW / 2} {CY - 21}" fill="none" stroke={TARGET_C} stroke-width="1.1" marker-end="url(#sd-arrow-acc)" />
            {/each}
            <text x={hx(0) - 60 + 236} y="140" class="tag">its hidden states at 3 depths, into pass 1</text>
          </g>
          <!-- ② the chain -->
          <g in:fade={{ delay: 500, duration: 250 }}>
            {@render num(30, CY, 2)}
            <rect x={X0E} y={CY - 10} width="40" height="20" rx="5" fill="var(--accent-soft)" stroke={TARGET_C} />
            <text x={X0E + 20} y={CY + 4} text-anchor="middle" class="mono strong">is</text>
            {#each DRAFT as t, k}
              <path d="M {(k ? kx(k - 1) + KW : X0E + 40) + 2} {CY} H {hx(k) - 3}" fill="none" stroke={k ? DRAFT_C : TARGET_C} stroke-width="1.4" marker-end={k ? 'url(#sd-arrow-gen)' : 'url(#sd-arrow-acc)'} />
              <rect x={hx(k)} y={CY - 17} width={HW} height="34" rx="6" fill={DRAFT_C} opacity="0.85" />
              <text x={hx(k) + HW / 2} y={CY - 3} text-anchor="middle" class="tag onbox">head</text>
              <text x={hx(k) + HW / 2} y={CY + 10} text-anchor="middle" class="tag onbox">pass {k + 1}</text>
              <path d="M {hx(k) + HW + 2} {CY} H {kx(k) - 3}" fill="none" stroke={DRAFT_C} stroke-width="1.4" marker-end="url(#sd-arrow-gen)" />
              <rect x={kx(k)} y={CY - 11} width={KW} height="22" rx="5" fill="var(--gen-soft)" stroke={DRAFT_C} />
              <text x={kx(k) + KW / 2} y={CY + 4} text-anchor="middle" class="mono strong">{t.trim()}</text>
            {/each}
          </g>
          <!-- ③ the time it takes -->
          <g in:fade={{ delay: 900, duration: 250 }}>
            {@render num(30, 270, 3)}
            {#each Array(N) as _, k}
              <rect x={hx(k)} y="262" width={HW} height="14" rx="3" fill={DRAFT_C} opacity="0.55" />
            {/each}
            <path d="M {hx(0)} 284 V 290 H {hx(N - 1) + HW} V 284" fill="none" stroke="var(--faint)" />
            <text x={(hx(0) + hx(N - 1) + HW) / 2} y="304" text-anchor="middle" class="tag strong">{N} passes, one after another: each waits for the guess before it</text>
          </g>
          <text x={W / 2} y="340" text-anchor="middle" class="legend" in:fade={{ delay: 1200 }}>then the target checks all {N} guesses in one pass (step 3)</text>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">EAGLE-3: a low, a middle and a high layer fused, trained on its own drafts · layer positions drawn for illustration</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">SGLang also branches: 4 candidates a step, the 8 likeliest checked as a tree (--speculative-eagle-topk 4)</text>
        </g>
      {/if}

      <!-- 5: 2 of 3, DFlash · context from above, tokens left to right through the drafter's 5 layers in one pass -->
      {#if cur.scene === 'dflash'}
        {@const TAPS = [2, 9, 15, 22, 29]}
        {@const LX = 170}
        {@const SL = 232}
        {@const SW = 30}
        {@const SG = 16}
        {@const sx = (k: number) => SL + k * (SW + SG)}
        {@const RY = (j: number) => 196 + j * 26}
        {@const OUTX = sx(4) + SW + 24}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">2 of 3 · DFlash · all {N} guesses in one pass</text>
          <!-- ① the target's hidden states → ② one context -->
          <g in:fade={{ delay: 100, duration: 250 }}>
            {@render num(LX - 22, 84, 1)}
            {@render layers(LX, 76, TAPS, [])}
            {#each TAPS as l}
              <path d="M {LX + l * 7 + 2.5} 108 L {LX + l * 7 + 2.5} 124" fill="none" stroke={TARGET_C} stroke-width="1.1" marker-end="url(#sd-arrow-acc)" />
            {/each}
            {@render num(LX - 22, 138, 2)}
            <rect x={LX} y="128" width={sx(4) + SW - LX} height="22" rx="5" fill="var(--accent-soft)" stroke={TARGET_C} />
            <text x={LX + 8} y="143" class="tag strong">context: 5 of the target's hidden states, joined</text>
            {#each Array(5) as _, k}
              <path d="M {sx(k) + SW / 2} 152 V {RY(0) - 14}" fill="none" stroke={TARGET_C} stroke-width="1.1" marker-end="url(#sd-arrow-acc)" />
            {/each}
            <text x={sx(4) + SW + 8} y="143" class="tag">into every drafter layer</text>
          </g>
          <!-- ③ the input → ④ 5 drafter layers, one pass → ⑤ the guesses -->
          <g in:fade={{ delay: 500, duration: 250 }}>
            {@render num(60, RY(0) - 22, 3)}
            {#each Array(N) as _, j}
              <rect x="70" y={RY(j) - 10} width="56" height="20" rx="5" fill={j ? 'white' : 'var(--accent-soft)'} stroke={j ? 'var(--faint)' : TARGET_C} stroke-dasharray={j ? '3 2' : 'none'} />
              <text x="98" y={RY(j) + 4} text-anchor="middle" class={j ? 'tag' : 'mono strong'}>{j ? 'blank' : 'is'}</text>
              <path d="M 130 {RY(j)} H {SL - 4}" fill="none" stroke="#b8b4aa" stroke-width="1.1" marker-end="url(#sd-arrow)" />
            {/each}
            {@render num(sx(0) - 14, RY(N - 1) + 40, 4)}
            {#each Array(5) as _, k}
              <rect x={sx(k)} y={RY(0) - 12} width={SW} height={RY(N - 1) - RY(0) + 24} rx="5" fill="var(--gen-soft)" stroke={DRAFT_C} />
              <text x={sx(k) + SW / 2} y={RY(N - 1) + 28} text-anchor="middle" class="tag">{k + 1}</text>
              {#if k < 4}<path d="M {sx(k) + SW + 2} {(RY(0) + RY(N - 1)) / 2} H {sx(k + 1) - 3}" fill="none" stroke={DRAFT_C} stroke-width="1.2" marker-end="url(#sd-arrow-gen)" />{/if}
            {/each}
            <text x={(sx(0) + sx(4) + SW) / 2} y={RY(N - 1) + 44} text-anchor="middle" class="tag strong">the drafter's own 5 layers, run once</text>
          </g>
          <g in:fade={{ delay: 900, duration: 250 }}>
            {@render num(OUTX + 28, RY(0) - 22, 5)}
            {#each DRAFT as t, j}
              <path d="M {sx(4) + SW + 2} {RY(j)} H {OUTX - 3}" fill="none" stroke={DRAFT_C} stroke-width="1.2" marker-end="url(#sd-arrow-gen)" />
              <rect x={OUTX} y={RY(j) - 10} width="56" height="20" rx="5" fill="var(--gen-soft)" stroke={DRAFT_C} />
              <text x={OUTX + 28} y={RY(j) + 4} text-anchor="middle" class="mono strong">{t.trim()}</text>
            {/each}
            <text x={OUTX + 66} y={RY(1) + 4} class="tag strong">{N} guesses,</text>
            <text x={OUTX + 66} y={RY(2) + 4} class="tag strong">together</text>
          </g>
          <text x={W / 2} y="340" text-anchor="middle" class="legend" in:fade={{ delay: 1300 }}>no guess sees the others, so later ones miss more: on chat 72% of first guesses survive, 63% of 7th</text>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">DFlash: Chen, Liang, Liu (ICML 2026) · {N} positions drawn; its default block is 16, in the same one pass · taps illustrative</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">survival rates: DSpark's paper, Qwen3-4B target, given every earlier guess survived (step 8's setup)</text>
        </g>
      {/if}

      <!-- 6: 3 of 3, DSpark · left to right: DFlash's pass, the linking head, the chance to survive, the target -->
      {#if cur.scene === 'dspark'}
        {@const RY = (j: number) => 126 + j * 34}
        {@const SURV = [0.95, 0.85, 0.68, 0.21]}
        {@const KEEP = 3}
        {@const C = { in: 20, pass: 98, g: 214, conf: 326, tgt: 470 }}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">3 of 3 · DSpark · DFlash's one pass, then a small head that links the guesses</text>
          <!-- ① input → ② DFlash's pass -->
          <g in:fade={{ delay: 100, duration: 250 }}>
            {@render num(C.in + 28, 80, 1)}
            <text x={C.in + 28} y="102" text-anchor="middle" class="tag strong">input</text>
            {#each Array(N) as _, j}
              <rect x={C.in} y={RY(j) - 10} width="56" height="20" rx="5" fill={j ? 'white' : 'var(--accent-soft)'} stroke={j ? 'var(--faint)' : TARGET_C} stroke-dasharray={j ? '3 2' : 'none'} />
              <text x={C.in + 28} y={RY(j) + 4} text-anchor="middle" class={j ? 'tag' : 'mono strong'}>{j ? 'blank' : 'is'}</text>
              <path d="M {C.in + 58} {RY(j)} H {C.pass - 4}" fill="none" stroke="#b8b4aa" stroke-width="1.1" marker-end="url(#sd-arrow)" />
            {/each}
            {@render num(C.pass + 42, 80, 2)}
            <text x={C.pass + 42} y="102" text-anchor="middle" class="tag strong">DFlash's one pass</text>
            <rect x={C.pass} y={RY(0) - 12} width="84" height={RY(N - 1) - RY(0) + 24} rx="6" fill={DRAFT_C} opacity="0.85" />
            <text x={C.pass + 42} y={(RY(0) + RY(N - 1)) / 2 + 4} text-anchor="middle" class="tag onbox">as in step 6</text>
          </g>
          <!-- ③ the guesses, each linked to the one above -->
          <g in:fade={{ delay: 500, duration: 250 }}>
            {@render num(C.g + 30, 80, 3)}
            <text x={C.g + 30} y="102" text-anchor="middle" class="tag strong">linked guesses</text>
            {#each DRAFT as t, j}
              <path d="M {C.pass + 86} {RY(j)} H {C.g - 4}" fill="none" stroke={DRAFT_C} stroke-width="1.1" marker-end="url(#sd-arrow-gen)" />
              <rect x={C.g} y={RY(j) - 10} width="60" height="20" rx="5" fill="var(--gen-soft)" stroke={DRAFT_C} />
              <text x={C.g + 30} y={RY(j) + 4} text-anchor="middle" class="mono strong">{t.trim()}</text>
              {#if j < N - 1}
                <path d="M {C.g + 64} {RY(j) + 5} A 15 15 0 0 1 {C.g + 69.5} {RY(j) + 20.9} L {C.g + 64} {RY(j + 1) - 5}" fill="none" stroke={GREEN} stroke-width="1.6" marker-end="url(#sd-arrow-grn)" />
              {/if}
            {/each}
            <text x={C.g + 92} y={(RY(0) + RY(N - 1)) / 2 + 4} class="tag" style:fill={GREEN}>small head</text>
          </g>
          <!-- ④ the chance each survives, and the trim -->
          <g in:fade={{ delay: 900, duration: 250 }}>
            {@render num(C.conf + 50, 80, 4)}
            <text x={C.conf + 50} y="102" text-anchor="middle" class="tag strong">chance to survive</text>
            {#each SURV as a, j}
              <rect x={C.conf} y={RY(j) - 4} width="100" height="8" rx="4" fill="var(--line)" />
              <rect x={C.conf} y={RY(j) - 4} width={100 * a} height="8" rx="4" fill={j < KEEP ? GREEN : RED} opacity="0.75" />
              <text x={C.conf + 108} y={RY(j) + 4} class="tag strong" style:fill={j < KEEP ? 'var(--fg)' : RED}>{a.toFixed(2)}</text>
            {/each}
            <path d="M {C.g - 6} {(RY(KEEP - 1) + RY(KEEP)) / 2} H {C.tgt + 70}" fill="none" stroke={RED} stroke-width="1.3" stroke-dasharray="4 3" />
            <text x={C.tgt + 76} y={(RY(KEEP - 1) + RY(KEEP)) / 2 + 4} class="tag strong" style:fill={RED}>cut</text>
          </g>
          <!-- ⑤ the target checks what is left, and adds its own -->
          <g in:fade={{ delay: 1300, duration: 250 }}>
            {@render num(C.tgt + 30, 80, 5)}
            <text x={C.tgt + 30} y="102" text-anchor="middle" class="tag strong">the target checks 3</text>
            {#each ['Paris', '.', 'It', ''] as t, j}
              <path d="M {C.conf + 136} {RY(j)} H {C.tgt - 4}" fill="none" stroke={j < KEEP ? '#b8b4aa' : 'var(--line)'} stroke-width="1.1" stroke-dasharray={j < KEEP ? 'none' : '3 3'} marker-end={j < KEEP ? 'url(#sd-arrow)' : undefined} />
              {#if j < KEEP}
                <rect x={C.tgt} y={RY(j) - 10} width="60" height="20" rx="5" fill={j < KEPT ? '#dcfce7' : 'var(--accent-soft)'} stroke={j < KEPT ? GREEN : TARGET_C} />
                <text x={C.tgt + 30} y={RY(j) + 4} text-anchor="middle" class="mono strong">{t}</text>
                <text x={C.tgt + 66} y={RY(j) + 4} class="tag strong" style:fill={j < KEPT ? GREEN : TARGET_C}>{j < KEPT ? '✓' : 'its own'}</text>
              {:else}
                <text x={C.tgt + 30} y={RY(j) + 4} text-anchor="middle" class="tag">not sent</text>
              {/if}
            {/each}
          </g>
          <!-- why the link matters, in one example -->
          <g in:fade={{ delay: 1700 }}>
            <text x="18" y="296" class="pt">·</text><text x="28" y="296" class="legend">the link: in DFlash each guess is made on its own; here each next guess is based on the guess before it</text>
            <text x="18" y="313" class="pt">·</text><text x="28" y="313" class="legend">the cut: in a full batch, checking a likely miss takes room from other requests, so fewer are sent</text>
          </g>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">the chances are illustrative · each is the product of the guess's own score and those above it, which must all survive</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">DSpark: DeepSeek-AI and Peking University (2026) · its small head is a rank-256 bias from the guess above</text>
        </g>
      {/if}

      <!-- 7: does it work · tokens per target pass, against normal decoding's 1 -->
      {#if cur.scene === 'compare'}
        {@const GX0 = 90}
        {@const GW = 196}
        {@const YB = 268}
        {@const SC = 28}
        {@const COLS = ['#94a3b8', DRAFT_C, GREEN]}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">does it work · tokens per target pass, Qwen3-8B · higher is better</text>
          <g in:fade={{ delay: 100, duration: 250 }}>
            <rect x={GX0} y="58" width="14" height="10" rx="2" fill="white" stroke="var(--faint)" stroke-dasharray="3 2" />
            <text x={GX0 + 20} y="67" class="tag strong">normal decoding</text>
            {#each ['EAGLE-3', 'DFlash', 'DSpark'] as n, i}
              <rect x={GX0 + 130 + i * 100} y="58" width="14" height="10" rx="2" fill={COLS[i]} />
              <text x={GX0 + 150 + i * 100} y="67" class="tag strong">{n}</text>
            {/each}
            {#each [0, 2, 4, 6] as v}
              <line x1={GX0 - 10} y1={YB - v * SC} x2={GX0 + 3 * GW - 10} y2={YB - v * SC} stroke="var(--line)" />
              <text x={GX0 - 16} y={YB - v * SC + 3} text-anchor="end" class="tag">{v}</text>
            {/each}
          </g>
          {#each TABLE as g, gi}
            {@const bx = (i: number) => GX0 + gi * GW + 14 + i * 42}
            <g in:fade={{ delay: 300 + gi * 300, duration: 250 }}>
              <rect x={bx(0)} y={YB - SC} width="34" height={SC} rx="3" fill="white" stroke="var(--faint)" stroke-dasharray="3 2" />
              <text x={bx(0) + 17} y={YB - SC - 5} text-anchor="middle" class="tag strong">1</text>
              {#each g.v as v, i}
                <rect x={bx(i + 1)} y={YB - v * SC} width="34" height={v * SC} rx="3" fill={COLS[i]} opacity="0.85" />
                <text x={bx(i + 1) + 17} y={YB - v * SC - 5} text-anchor="middle" class="tag strong">{v.toFixed(2)}</text>
              {/each}
              <text x={bx(0) + 80} y={YB + 16} text-anchor="middle" class="tag strong">{g.d}</text>
            </g>
          {/each}
          <g in:fade={{ delay: 1300 }}>
            <text x="18" y="310" class="pt">·</text><text x="28" y="310" class="legend">each round is one target pass, so tokens per pass is how many times fewer passes the answer needs</text>
            <text x="18" y="327" class="pt">·</text><text x="28" y="327" class="legend">the draft's own time comes off that; chat is harder to guess than math or code for all three</text>
          </g>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">source: Cheng et al., DSpark, arXiv 2607.05147, Table 1 · all three retrained on the same data, 7 guesses a round, temperature 1</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">a round's count includes the target's own token · making each pass's 16 GB read smaller: chapter {CH_QUANT}</text>
        </g>
      {/if}

    </svg>
  </div>

  <StepControls {step} total={steps.length} caption={cur.caption} {prev} {next} onchange={(s) => (step = s)} />
</figure>

