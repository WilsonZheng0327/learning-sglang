<script lang="ts">
  import { fade, fly } from 'svelte/transition';
  import StepControls from './StepControls.svelte';
  import { chapters, type NavLink } from '../chapters';
  let { prev, next }: { prev?: NavLink; next?: NavLink } = $props();
  const chNum = (slug: string) => chapters.findIndex((c) => c.slug === slug) + 1;
  const CH_NEXT = chNum('14-attention-backends');
  const CH_QUANT = chNum('16-quantization');

  // ---- Numbers: Llama-3-8B bf16 on one H100, continuing chapters 4, 11 and 12 --------------------------
  const D = 4096, F = 14336, LAYERS = 32, BYTES = 2;
  const W_GB = 16, BW = 3.35;
  const tMem = W_GB / BW;                                   // 4.8 ms, the weight read
  const inter = F * BYTES;                                  // 28 KB: one token's silu output, one layer
  const savedPerTokLayer = 2 * inter;                       // written then read back, for nothing
  const savedPerTok = (savedPerTokLayer * LAYERS) / 1e6;    // 1.8 MB a token, whole model
  const B_EX = 256;
  const savedMB = savedPerTok * B_EX;                       // 470 MB at batch 256
  const savedMs = savedMB / 1e3 / BW;                       // and what that is in time
  const actMB = savedPerTok * B_EX * 3;                     // ~1.4 GB of activations all told
  const totalMB = W_GB * 1e3 + actMB;                       // what one decode step moves
  const pctTraffic = (savedMB / (W_GB * 1e3)) * 100;              // against the weight read, as chapter 4 measures a step
  const kb = (b: number) => `${Math.round(b / 1024)} KB`;
  const launchMsEager = 9;                                  // chapter 11's eager step: the launches, not the GPU
  const launchSaved = launchMsEager - tMem;                 // 4.2 ms, what chapters 11 and 12 took off
  const ratio = Math.round(launchSaved / savedMs);          // and how much bigger that was than this
  const fmtMs = (ms: number) => (ms < 10 ? ms.toFixed(1) : ms.toFixed(0)) + ' ms';
  const B_SM = 16;                                          // the batch where autotuning is worth the most
  const SMS = 132;                                          // streaming multiprocessors on an H100 SXM

  type Scene = 'chain' | 'waste' | 'why' | 'fuse' | 'triton' | 'whatfuses' | 'tiles' | 'autotune' | 'worth' | 'cost' | 'closing';
  interface Step { caption: string; scene: Scene }
  const steps: Step[] = [
    { scene: 'chain', caption: `Chapter 12 left a piece looking like this: a chain of kernels between two matmuls, each one reading its input from memory and writing its output back. Take the two in the middle.` },
    { scene: 'waste', caption: `<b>SiLU</b> writes ${kb(inter)} per token per layer into HBM, and <b>multiply</b> reads it back a microsecond later. Nothing else ever reads it. Across ${LAYERS} layers that is ${savedPerTok.toFixed(1)} MB per token, out to memory and straight back.` },
    { scene: 'why', caption: `It exists because eager PyTorch runs one line at a time. <code>silu(gate)</code> is a call, a call returns a tensor, and a tensor lives in HBM. Line 2 has not been read yet, so nothing knows the result is consumed next.` },
    { scene: 'fuse', caption: `<b>Fuse them.</b> One kernel: load gate and up once, compute the SiLU and the multiply in registers, store the answer once. Identical arithmetic, two fewer trips through memory.` },
    { scene: 'triton', caption: `And you can, because chapter 12 already traced the model. <b>Inductor</b> takes that graph, walks the chain of pointwise ops, and writes a <b>Triton</b> kernel that does all of them in one pass.` },
    { scene: 'whatfuses', caption: `<b>Pointwise</b> ops (output i needs only input i: silu, mul, add) and <b>reductions</b> (a row to one number: norm) fuse into one kernel. A matmul needs whole rows and columns, so Inductor <b>picks</b> a library kernel for it and folds the pointwise edges in.` },
    { scene: 'tiles', caption: `One idea first. A matmul's output C is carved into <b>tiles</b>, one per thread block. Whatever the tile's shape, its block loads its rows of A and its columns of B in full, so a bigger tile makes more outputs from each load.` },
    { scene: 'autotune', caption: `At batch ${B_SM}, C has ${B_SM} rows. A square 128 × 128 tile pads 112 of them with zeros, and ${F.toLocaleString()} / 128 is only ${F / 128} tiles for ${SMS} SMs. A ${B_SM} × 64 tile pads nothing and makes ${F / 64}. So benchmark a few shapes on the real C and keep the fastest.` },
    { scene: 'worth', caption: `Fusing that chain removes ${savedMB.toFixed(0)} MB from a decode step at batch ${B_EX}. Against the ${W_GB} GB weight read that is about ${pctTraffic.toFixed(0)}%, which on a memory-bound step is about ${(savedMs * 1000).toFixed(0)} µs of ${fmtMs(tMem)}.` },
    { scene: 'cost', caption: `Startup gains jobs, each once per captured shape: compile a kernel per fused group, benchmark tile shapes per matmul (<code>max-autotune</code> only), then record. Recording goes last: it freezes whichever kernels exist when it is taken.` },
    { scene: 'closing', caption: `The layer has been cut, fused and recorded — except for one kernel. Attention was cut out in chapter 12 and has run eagerly ever since. So what can be done with attention itself? Chapter ${CH_NEXT}.` },
  ];

  let step = $state(0);
  $effect(() => {
    const q = Number(new URLSearchParams(window.location.search).get('step'));
    if (q >= 1 && q <= steps.length) step = q - 1;
  });
  const cur = $derived(steps[step]);
  const W = 720, H = 400;

  // the layer's kernels, as chapter 12 listed them, with what Inductor does to each
  const layerK = [
    { n: 'norm', g: 0, mm: false }, { n: 'qkv', g: 1, mm: true }, { n: 'rope', g: 1, mm: false },
    { n: 'attn', g: 2, mm: false, seam: true }, { n: 'o', g: 3, mm: true }, { n: 'add', g: 3, mm: false },
    { n: 'norm', g: 4, mm: false }, { n: 'gate·up', g: 5, mm: true }, { n: 'silu', g: 6, mm: false },
    { n: 'down', g: 7, mm: true }, { n: 'add', g: 7, mm: false },
  ];
  const GROUPS = 8;

  // record / cut / fuse keep the colours they had in chapters 11, 12 and 13
  const OPS = {
    record: { n: 'record', ch: 11, c: 'var(--gen)' },
    cut: { n: 'cut', ch: 12, c: 'var(--eos)' },
    fuse: { n: 'fuse', ch: 13, c: '#16a34a' },
  };

  // candidate matmul tilings for a batch-16 decode matmul, as an autotune sweep would rank them
  const cands = [
    { n: 'BLOCK 128×128', t: 1.00 }, { n: 'BLOCK 64×128', t: 0.82 }, { n: 'BLOCK 32×128', t: 0.66 },
    { n: 'BLOCK 16×256', t: 0.55 }, { n: 'BLOCK 16×64', t: 0.47 },
  ];
  const best = cands.reduce((a, c) => (c.t < a.t ? c : a));

  // the startup bill, drawn as a grid: one cell per job, one row per captured shape
  // --torch-compile-max-bs 16 fixes the rungs at 1, 2, 4, 8, 16
  const RUNGS = [1, 2, 4, 8, 16];
  const DISTINCT_K = 8;      // fused groups in one layer, from the "what fuses" step
  const MATMULS = 4;         // of those 8
  const jobs = [
    { t: 'compile', s: `${DISTINCT_K} fused kernels`, n: DISTINCT_K, c: 'var(--accent)', op: 0.85 },
    { t: 'benchmark', s: `${MATMULS} matmuls × ${cands.length} tile shapes · max-autotune only`, n: MATMULS * cands.length, c: 'var(--fg)', op: 0.55 },
    { t: 'record', s: 'chapter 11', n: 1, c: 'var(--gen)', op: 0.85 },
  ];
  const JX0 = 128, JPITCH = 15, JGAP = 16;
  const jobX = jobs.map((_, i) => JX0 + jobs.slice(0, i).reduce((a, j) => a + j.n * JPITCH + JGAP, 0));
</script>

<figure class="viz">
  <div class="canvas">
    <svg viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="torch.compile, step {step + 1}">
      <defs>
        <marker id="tc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#b8b4aa" />
        </marker>
        <marker id="tc-arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
        </marker>
        <marker id="tc-arrow-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--eos)" />
        </marker>
        <marker id="tc-arrow-good" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#16a34a" />
        </marker>
      </defs>

      <!-- 1: the chain, from chapter 12 -->
      {#if cur.scene === 'chain'}
        {@const chain = [{ n: 'gate·up', mm: true }, { n: 'silu', mm: false }, { n: 'mul', mm: false }, { n: 'down', mm: true }]}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">one piece from chapter 12 · the MLP end of a layer</text>
          <rect x="40" y="212" width="650" height="34" rx="8" fill="#f4f2ec" stroke="var(--line)" />
          <text x="56" y="234" class="boxtitle">HBM</text>
          {#each chain as k, i}
            {@const cx = 150 + i * 150}
            <g in:fade={{ delay: i * 160, duration: 200 }}>
              <path d="M {cx - 34} 212 V 140" fill="none" stroke="var(--accent)" stroke-width="1.5" marker-end="url(#tc-arrow-hot)" />
              <rect x={cx - 58} y="94" width="116" height="42" rx="8" fill={k.mm ? 'var(--fg)' : 'var(--accent)'} opacity={k.mm ? 0.75 : 0.9} />
              <text x={cx} y="120" text-anchor="middle" class="kname">{k.n}</text>
              <path d="M {cx + 34} 140 V 208" fill="none" stroke="var(--accent)" stroke-width="1.5" marker-end="url(#tc-arrow-hot)" />
            </g>
          {/each}
          <g in:fade={{ delay: 800 }}>
            <rect x="234" y="82" width="280" height="66" rx="10" fill="none" stroke="var(--eos)" stroke-dasharray="4 3" />
            <text x="374" y="74" text-anchor="middle" class="tag strong" fill="var(--eos)">these two</text>
          </g>
          <text x="16" y="286" class="legend" in:fade={{ delay: 1000 }}>the two matmuls have to touch memory: that is where the weights are</text>
          <text x="16" y="308" class="legend muted" in:fade={{ delay: 1000 }}>the two in the middle touch it only because of how they were called</text>
        </g>
      {/if}

      <!-- 2: the intermediate that never needed to exist -->
      {#if cur.scene === 'waste'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">the value between them · one token, one layer</text>
          <rect x="60" y="88" width="130" height="44" rx="8" fill="var(--accent)" opacity="0.9" />
          <text x="125" y="115" text-anchor="middle" class="kname">silu</text>
          <rect x="530" y="88" width="130" height="44" rx="8" fill="var(--accent)" opacity="0.9" />
          <text x="595" y="115" text-anchor="middle" class="kname">mul</text>

          <rect x="40" y="248" width="650" height="34" rx="8" fill="#f4f2ec" stroke="var(--line)" />
          <text x="56" y="270" class="boxtitle">HBM</text>

          <g in:fade={{ delay: 300, duration: 300 }}>
            <path d="M 125 136 V 244" fill="none" stroke="var(--eos)" stroke-width="2" marker-end="url(#tc-arrow-bad)" />
            <text x="136" y="176" class="tag" fill="var(--eos)">write</text>
            <text x="136" y="190" class="tag strong" fill="var(--eos)">{kb(inter)}</text>
          </g>
          <g in:fade={{ delay: 700, duration: 300 }}>
            <rect x="280" y="252" width="160" height="26" rx="4" fill="var(--eos)" opacity="0.25" stroke="var(--eos)" />
            <text x="360" y="269" text-anchor="middle" class="tag strong" fill="var(--eos)">[1 × {F.toLocaleString()}]</text>
          </g>
          <g in:fade={{ delay: 1100, duration: 300 }}>
            <path d="M 595 244 V 140" fill="none" stroke="var(--eos)" stroke-width="2" marker-end="url(#tc-arrow-bad)" />
            <text x="522" y="176" text-anchor="end" class="tag" fill="var(--eos)">read back</text>
            <text x="522" y="190" text-anchor="end" class="tag strong" fill="var(--eos)">{kb(inter)}</text>
          </g>
          <g in:fade={{ delay: 1500 }}>
            <text x="360" y="314" text-anchor="middle" class="tag">nothing else ever reads it</text>
            <text x="16" y="352" class="legend"><tspan class="strong">{kb(savedPerTokLayer)} of traffic per token per layer</tspan>, written and read back within about a microsecond</text>
            <text x="16" y="374" class="legend muted">across {LAYERS} layers, {savedPerTok.toFixed(1)} MB per token</text>
          </g>
        </g>
      {/if}

      <!-- 3: why it is a separate kernel at all -->
      {#if cur.scene === 'why'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">why the value is written down · eager runs one line at a time</text>
          <rect x="40" y="64" width="300" height="118" rx="10" fill="#fbfaf7" stroke="var(--accent)" />
          <text x="56" y="86" class="boxtitle">what you wrote</text>
          {#each ['h = silu(gate)', 'h = h * up', 'y = down(h)'] as line, i}
            {@const y = 114 + i * 26}
            {@const now = i === 0}
            {#if now}
              <rect x="50" y={y - 17} width="280" height="24" rx="5" fill="var(--accent-soft)" />
              <path d="M 58 {y - 10} L 66 {y - 5} L 58 {y} z" fill="var(--accent)" />
            {/if}
            <text x="74" y={y} class="mono {now ? 'strong' : 'faint'}">{line}</text>
            {#if !now}<text x="318" y={y} text-anchor="end" class="tag" fill="var(--faint)">not read yet</text>{/if}
          {/each}

          <g in:fade={{ delay: 600 }}>
            <rect x="380" y="64" width="300" height="118" rx="10" fill="#fbfaf7" stroke="var(--eos)" />
            <text x="396" y="86" class="boxtitle">what the interpreter knows</text>
            <text x="396" y="114" class="tag">line 1 is a call, and a call has to <tspan class="strong">return</tspan></text>
            <text x="396" y="140" class="tag">it returns a tensor, and a tensor lives in HBM</text>
            <text x="396" y="166" class="tag">line 2 is unread: nothing knows <tspan class="strong">h</tspan> is used next</text>
          </g>

          <rect x="40" y="248" width="650" height="34" rx="8" fill="#f4f2ec" stroke="var(--line)" />
          <text x="56" y="270" class="boxtitle">HBM</text>
          <g in:fade={{ delay: 300, duration: 300 }}>
            <path d="M 190 186 V 244" fill="none" stroke="var(--eos)" stroke-width="2" marker-end="url(#tc-arrow-bad)" />
            <text x="202" y="210" class="tag" fill="var(--eos)">silu returns h</text>
            <text x="202" y="224" class="tag strong" fill="var(--eos)">{kb(inter)}</text>
          </g>
          <g in:fade={{ delay: 700, duration: 300 }}>
            <rect x="110" y="252" width="160" height="26" rx="4" fill="var(--eos)" opacity="0.25" stroke="var(--eos)" />
            <text x="190" y="269" text-anchor="middle" class="tag strong" fill="var(--eos)">h · [1 × {F.toLocaleString()}]</text>
          </g>
          <text x="16" y="322" class="legend" in:fade={{ delay: 1000 }}>fusing needs both lines at once; when line 1 runs, the interpreter has only ever seen line 1</text>
        </g>
      {/if}

      <!-- 4: fuse them -->
      {#if cur.scene === 'fuse'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">the same arithmetic, in one kernel</text>
          <rect x="40" y="246" width="650" height="34" rx="8" fill="#f4f2ec" stroke="var(--line)" />
          <text x="56" y="268" class="boxtitle">HBM</text>

          <text x="176" y="76" text-anchor="middle" class="rowlabel">before</text>
          <text x="176" y="92" text-anchor="middle" class="tag strong" fill="var(--eos)">4 trips</text>
          {#each [{ n: 'silu', x: 108 }, { n: 'mul', x: 244 }] as k}
            <rect x={k.x - 48} y="102" width="96" height="34" rx="6" fill="var(--accent)" opacity="0.45" />
            <text x={k.x} y="124" text-anchor="middle" class="kname">{k.n}</text>
            <path d="M {k.x - 24} 242 V 140" fill="none" stroke="var(--eos)" stroke-width="1.2" marker-end="url(#tc-arrow-bad)" opacity="0.6" />
            <path d="M {k.x + 24} 140 V 242" fill="none" stroke="var(--eos)" stroke-width="1.2" marker-end="url(#tc-arrow-bad)" opacity="0.6" />
          {/each}

          <g in:fade={{ delay: 500, duration: 350 }}>
            <text x="530" y="76" text-anchor="middle" class="rowlabel">after</text>
            <text x="530" y="92" text-anchor="middle" class="tag strong" fill="#16a34a">2 trips</text>
            <rect x="380" y="102" width="300" height="34" rx="6" fill="#16a34a" opacity="0.9" />
            <text x="530" y="124" text-anchor="middle" class="kname">silu · mul, fused</text>
            <path d="M 404 242 V 140" fill="none" stroke="#16a34a" stroke-width="2" marker-end="url(#tc-arrow-good)" />
            <path d="M 656 140 V 242" fill="none" stroke="#16a34a" stroke-width="2" marker-end="url(#tc-arrow-good)" />
            {#each ['load gate and up once', 'do both operations in registers', 'store the answer once'] as line, k}
              <text x="530" y={176 + k * 18} text-anchor="middle" class="tag">{line}</text>
            {/each}
          </g>
          <g in:fade={{ delay: 1100 }}>
            <text x="16" y="316" class="legend">the intermediate never leaves the chip — it lives in a register for the two instructions that need it</text>
            <text x="16" y="338" class="legend muted">same maths, same answer, {kb(savedPerTokLayer)} less traffic per token per layer</text>
          </g>
        </g>
      {/if}

      <!-- 5: where the fused kernel comes from -->
      {#if cur.scene === 'triton'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">who writes that kernel</text>
          {#each [
            { t: 'the traced graph', l: ['chapter 12 already', 'has it: a flat list', 'of tensor ops'], c: 'var(--muted)' },
            { t: 'Inductor', l: ['walk the list, group', 'the pointwise ops', 'that touch the same rows'], c: 'var(--accent)' },
            { t: 'Triton, generated', l: ['one kernel per group,', 'compiled at startup,', 'cached on disk'], c: '#16a34a' },
          ] as b, i}
            {@const x = 38 + i * 226}
            <g in:fly={{ y: 8, delay: i * 280, duration: 300 }}>
              <rect {x} y="64" width="190" height="94" rx="12" fill="#fbfaf7" stroke={b.c} />
              <text x={x + 14} y="88" class="slab strong small">{b.t}</text>
              {#each b.l as line, k}<text x={x + 14} y={110 + k * 16} class="tag">{line}</text>{/each}
            </g>
            {#if i < 2}
              <path d="M {x + 196} 111 H {x + 222}" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#tc-arrow)" in:fade={{ delay: i * 280 + 240 }} />
            {/if}
          {/each}
          <g in:fade={{ delay: 900 }}>
            <rect x="22" y="180" width="676" height="128" rx="10" fill="white" stroke="var(--line)" />
            {#each [
              '@triton.jit',
              'def fused_silu_mul(gate, up, out, n):',
              '    i = tl.program_id(0) * BLOCK + tl.arange(0, BLOCK)',
              '    g = tl.load(gate + i)                 # one read',
              '    u = tl.load(up + i)                   # one read',
              '    tl.store(out + i, g * tl.sigmoid(g) * u)   # one write',
            ] as line, i}
              <text x="38" y={204 + i * 17} class="mono code" in:fade={{ delay: 900 + i * 90 }}>{line}</text>
            {/each}
          </g>
          <text x="16" y="336" class="legend muted" in:fade={{ delay: 1600 }}>two loads and one store: <tspan class="mono">g * sigmoid(g)</tspan> never leaves the register it was computed in</text>
          <g in:fade={{ delay: 1900 }}>
            <circle cx="24" cy="364" r="4" fill="var(--gen)" />
            <text x="38" y="368" class="mono strong">--cuda-graph-tc-compiler inductor</text>
            <text x="274" y="368" class="tag">chapter 12's default was <tspan class="strong">eager</tspan>: trace, cut, and stop there</text>
          </g>
        </g>
      {/if}

      <!-- 6: what fuses and what does not -->
      {#if cur.scene === 'whatfuses'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">one layer · {layerK.length} kernels before, {GROUPS} after</text>
          {#each layerK as k, i}
            {@const x = 30 + i * 60}
            <rect {x} y="70" width="52" height="34" rx="5" fill={k.seam ? 'var(--eos)' : k.mm ? 'var(--fg)' : 'var(--accent)'} opacity={k.seam ? 0.85 : k.mm ? 0.75 : 0.9} />
            <text x={x + 26} y="92" text-anchor="middle" class="kname">{k.n}</text>
          {/each}
          {#each Array(GROUPS) as _, g}
            {@const ks = layerK.map((k, i) => ({ k, i })).filter((o) => o.k.g === g)}
            {@const x0 = 30 + ks[0].i * 60}
            {@const x1 = 30 + ks[ks.length - 1].i * 60 + 52}
            <g in:fade={{ delay: 400 + g * 100, duration: 250 }}>
              {#if ks.length > 1}
                <path d="M {x0} 112 V 120 H {x1} V 112" fill="none" stroke="#16a34a" stroke-width="1.8" />
              {/if}
              <rect x={x0} y="132" width={x1 - x0} height="30" rx="5" fill={ks[0].k.seam ? 'var(--eos)' : ks.some((o) => o.k.mm) ? 'var(--fg)' : '#16a34a'} opacity="0.85" />
              <text x={(x0 + x1) / 2} y="152" text-anchor="middle" class="kname">{ks.map((o) => o.k.n).join('·')}</text>
            </g>
          {/each}
          <g in:fade={{ delay: 1300 }}>
            <text x="30" y="190" class="tag"><tspan class="strong">pointwise</tspan> · out[i] depends only on in[i] · silu, mul, add, rope · a chain of them is one pass over the data, so one kernel</text>
            <text x="30" y="206" class="tag"><tspan class="strong">reduction</tspan> · a row collapses to one number · norm's mean of squares · also one pass, with an accumulator</text>
            <text x="30" y="222" class="tag"><tspan class="strong">matmul</tspan> · out[i, j] needs all of row i of A and column j of B · not one pass over anything</text>
          </g>
          <g in:fade={{ delay: 1700 }}>
            {#each [
              { c: '#16a34a', t: 'written', s: 'by Inductor: one new Triton kernel per pointwise or reduction chain', n: 3 },
              { c: 'var(--fg)', t: 'picked', s: 'from a library: cuBLAS, a Triton template or CUTLASS; its pointwise neighbours fold into it', n: 4 },
              { c: 'var(--eos)', t: 'left eager', s: 'the attention seam from chapter 12', n: 1 },
            ] as k, i}
              {@const y = 256 + i * 26}
              <rect x="30" y={y - 12} width="16" height="16" rx="4" fill={k.c} opacity="0.85" />
              <text x="58" y={y} class="slab strong small">{k.t}</text>
              <text x="150" y={y} class="tag">{k.s}</text>
              <text x="690" y={y} text-anchor="end" class="slab strong small">{k.n} of {GROUPS}</text>
            {/each}
          </g>
          <text x="16" y="348" class="legend" in:fade={{ delay: 2100 }}>the 3 kernels that went away were pointwise neighbours of matmuls: <tspan class="mono">rope</tspan> into <tspan class="mono">qkv</tspan>, each <tspan class="mono">add</tspan> into the matmul before it</text>
        </g>
      {/if}

      <!-- 7: what a tile is -->
      {#if cur.scene === 'tiles'}
        {@const CELL = 11}
        {@const M = 8}
        {@const N = 12}
        {@const K = 6}
        {@const tilings = [{ x: 60, bm: 4, bn: 4 }, { x: 400, bm: 8, bn: 6 }]}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">C = A × B · [{M} × {N}] = [{M} × {K}] × [{K} × {N}] · one tile of C and what its block loads, two ways</text>
          {#each tilings as v, p}
            {@const ax = v.x}
            {@const cx = v.x + K * CELL + 14}
            {@const by = 68}
            {@const cy = 68 + K * CELL + 14}
            {@const nT = (M / v.bm) * (N / v.bn)}
            {@const loads = (v.bm + v.bn) * K}
            {@const mats = [
              { n: 'B', x: cx, y: by, rows: K, cols: N, hl: (r: number, c: number) => c < v.bn },
              { n: 'A', x: ax, y: cy, rows: M, cols: K, hl: (r: number, c: number) => r < v.bm },
              { n: 'C', x: cx, y: cy, rows: M, cols: N, hl: (r: number, c: number) => r < v.bm && c < v.bn },
            ]}
            <g in:fade={{ delay: p * 450, duration: 250 }}>
              {#each mats as m}
                {#each Array(m.rows) as _, r}
                  {#each Array(m.cols) as _, c}
                    <rect x={m.x + c * CELL} y={m.y + r * CELL} width={CELL - 1} height={CELL - 1} fill={m.hl(r, c) ? 'var(--accent)' : '#e8e5dd'} opacity={m.hl(r, c) ? 0.85 : 1} />
                  {/each}
                {/each}
                <text x={m.x} y={m.y - 5} class="mono strong">{m.n}</text>
              {/each}
              {#each Array(N / v.bn - 1) as _, c}
                <line x1={cx + (c + 1) * v.bn * CELL - 0.5} y1={cy} x2={cx + (c + 1) * v.bn * CELL - 0.5} y2={cy + M * CELL} stroke="var(--fg)" stroke-width="1.5" />
              {/each}
              {#each Array(M / v.bm - 1) as _, r}
                <line x1={cx} y1={cy + (r + 1) * v.bm * CELL - 0.5} x2={cx + N * CELL} y2={cy + (r + 1) * v.bm * CELL - 0.5} stroke="var(--fg)" stroke-width="1.5" />
              {/each}
              <text x={cx + (v.bn * CELL) / 2} y={cy + (v.bm * CELL) / 2 + 3} text-anchor="middle" class="tag strong" fill="white">tile</text>
              <text x={ax + 105} y="248" text-anchor="middle" class="slab strong small">BLOCK {v.bm} × {v.bn} · {nT} tiles, {nT} thread blocks</text>
              <text x={ax + 105} y="266" text-anchor="middle" class="tag">each block loads {v.bm} rows of A and {v.bn} columns of B</text>
              <text x={ax + 105} y="282" text-anchor="middle" class="tag"><tspan class="strong">{loads} cells loaded</tspan> for {v.bm * v.bn} outputs · {(loads / (v.bm * v.bn)).toFixed(1)} per output</text>
              <text x={ax + 105} y="298" text-anchor="middle" class="tag">whole C: <tspan class="strong">{nT * loads} loads</tspan> for {M * N} outputs</text>
            </g>
          {/each}
          <g in:fade={{ delay: 1200 }}>
            <text x="16" y="334" class="legend">a tile's block loads its rows of A and its columns of B in full, whatever the tile's shape</text>
            <text x="16" y="356" class="legend muted">{tilings[1].bm} × {tilings[1].bn} makes the same {M * N} outputs from {(tilings[1].bm + tilings[1].bn) * K * ((M / tilings[1].bm) * (N / tilings[1].bn))} loads instead of {(tilings[0].bm + tilings[0].bn) * K * ((M / tilings[0].bm) * (N / tilings[0].bn))}, holding {tilings[1].bm * tilings[1].bn} accumulators per block instead of {tilings[0].bm * tilings[0].bn}</text>
            <text x="16" y="378" class="legend muted">but it makes {(M / tilings[1].bm) * (N / tilings[1].bn)} blocks, and an H100 has {SMS} SMs to keep busy: the right shape depends on C</text>
          </g>
        </g>
      {/if}

      <!-- 8: the shape you actually have -->
      {#if cur.scene === 'autotune'}
        {@const PXC = 0.5}
        {@const SHOW = 1024}
        {@const CX0 = 100}
        {@const CY0 = 72}
        {@const SQ = 128}
        {@const WIDE = 64}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">a decode matmul at batch {B_SM} · C = [{B_SM} × {F.toLocaleString()}] · the first {SHOW.toLocaleString()} columns, one pixel per row</text>
          <text x={CX0 - 8} y={CY0 + 12} text-anchor="end" class="tag">C · {B_SM} rows</text>
          <rect x={CX0} y={CY0} width={SHOW * PXC} height={B_SM} fill="var(--accent)" opacity="0.8" />
          <text x={CX0 + SHOW * PXC + 8} y={CY0 + 12} class="tag">… to column {F.toLocaleString()}</text>

          <g in:fade={{ delay: 400, duration: 250 }}>
            <rect x={CX0} y={CY0 + B_SM} width={SQ * PXC} height={SQ - B_SM} fill="var(--eos)" opacity="0.12" />
            <rect x={CX0} y={CY0} width={SQ * PXC} height={SQ} fill="none" stroke="var(--eos)" stroke-width="1.5" stroke-dasharray="4 3" />
            <text x={CX0 + SQ * PXC + 12} y={CY0 + 44} class="slab strong small" fill="var(--eos)">BLOCK {SQ} × {SQ}</text>
            <text x={CX0 + SQ * PXC + 12} y={CY0 + 62} class="tag">{B_SM} of its {SQ} rows exist; {SQ - B_SM} are zero padding</text>
            <text x={CX0 + SQ * PXC + 12} y={CY0 + 78} class="tag">{(SQ - B_SM) / SQ * 8}/8 of the tile's arithmetic is on zeros</text>
            <text x={CX0 + SQ * PXC + 12} y={CY0 + 94} class="tag">{F.toLocaleString()} / {SQ} = {F / SQ} tiles for {SMS} SMs: {SMS - F / SQ} sit idle</text>
          </g>
          <g in:fade={{ delay: 900, duration: 250 }}>
            <rect x={CX0 + 400} y={CY0} width={WIDE * PXC} height={B_SM} fill="none" stroke="#16a34a" stroke-width="2" />
            <text x={CX0 + 400} y={CY0 + 44} class="slab strong small" fill="#16a34a">BLOCK {B_SM} × {WIDE}</text>
            <text x={CX0 + 400} y={CY0 + 62} class="tag">every row it covers is real</text>
            <text x={CX0 + 400} y={CY0 + 78} class="tag">{F.toLocaleString()} / {WIDE} = {F / WIDE} tiles: every SM busy</text>
          </g>

          <text x="16" y="224" class="rowlabel">candidate tile shapes · time on that C, shorter is better</text>
          {#each cands as c, i}
            {@const y = 236 + i * 24}
            {@const win = c.n === best.n}
            <g in:fade={{ delay: 1100 + i * 150, duration: 200 }}>
              <text x="30" y={y + 13} class={win ? 'mono strong' : 'mono muted'}>{c.n}</text>
              <rect x="150" y={y} width={c.t * 400} height="16" rx="4" fill={win ? '#16a34a' : 'var(--faint)'} opacity={win ? 0.9 : 0.5} />
              <text x={150 + c.t * 400 + 8} y={y + 13} class="tag">{(c.t * 100).toFixed(0)}%</text>
              {#if win}<text x={150 + c.t * 400 + 44} y={y + 13} class="tag strong" fill="#16a34a">keep this one</text>{/if}
            </g>
          {/each}
          <text x="16" y="378" class="legend" in:fade={{ delay: 2000 }}>a library's default tile is tuned for a square C; below {SQ} rows it is mostly padding, and a short, wide tile wins</text>
        </g>
      {/if}

      <!-- 9: what it is worth -->
      {#if cur.scene === 'worth'}
        {@const BX = 62}
        {@const BW2 = 590}
        {@const END = BX + BW2}
        {@const perGB = BW2 / (totalMB / 1e3)}
        {@const perMs = BW2 / launchMsEager}
        {@const sliverB = END - (savedMB / 1e3) * perGB}
        {@const sliverT = BX + (tMem - savedMs) * perMs}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">one decode step at batch {B_EX} · weights and activations, then time · chapter 4's KV cache read not shown</text>

          <g in:fade={{ delay: 100, duration: 250 }}>
            <text x="16" y="90" class="rowlabel">bytes</text>
            <text x={BX} y="64" class="tag">weights · {W_GB.toFixed(1)} GB</text>
            <text x={END} y="64" text-anchor="end" class="tag">activations · {(actMB / 1e3).toFixed(1)} GB</text>
            <rect x={BX} y="70" width={W_GB * perGB} height="28" rx="4" fill="var(--gen)" opacity="0.85" />
            <rect x={BX + W_GB * perGB} y="70" width={(actMB / 1e3) * perGB} height="28" rx="4" fill="var(--accent)" opacity="0.85" />
            <text x={END + 10} y="90" class="tag strong">{(totalMB / 1e3).toFixed(1)} GB</text>
            {#each [0, 4, 8, 12, 16] as t}
              <line x1={BX + t * perGB} y1="98" x2={BX + t * perGB} y2="103" stroke="var(--faint)" />
              <text x={BX + t * perGB} y="114" text-anchor="middle" class="tick">{t} GB</text>
            {/each}
          </g>
          <g in:fade={{ delay: 500, duration: 250 }}>
            <rect x={sliverB} y="70" width={(savedMB / 1e3) * perGB} height="28" fill="#16a34a" />
            <path d="M {sliverB + 6} 98 V 126" fill="none" stroke="#16a34a" stroke-width="1" />
            <text x={END} y="138" text-anchor="end" class="tag strong" fill="#16a34a">fusing removes {savedMB.toFixed(0)} MB · {pctTraffic.toFixed(0)}% of the weight read</text>
          </g>

          <text x={BX + BW2 / 2} y="168" text-anchor="middle" class="tag" in:fade={{ delay: 900 }}>the step is memory-bound, so bytes ÷ {BW} TB/s of HBM bandwidth = time</text>

          <g in:fade={{ delay: 1100, duration: 250 }}>
            <text x="16" y="214" class="rowlabel">time</text>
            <text x={BX} y="190" class="tag">GPU · {fmtMs(tMem)} reading the weights</text>
            <text x={END} y="190" text-anchor="end" class="tag">CPU · {fmtMs(launchSaved)} launching · gone since chapters 11 and 12</text>
            <rect x={BX} y="196" width={tMem * perMs} height="28" rx="4" fill="var(--fg)" opacity="0.7" />
            <rect x={BX + tMem * perMs} y="196" width={launchSaved * perMs} height="28" rx="4" fill="var(--accent)" fill-opacity="0.12" stroke="var(--accent)" stroke-dasharray="4 3" />
            <text x={END + 10} y="214" class="tag strong">{fmtMs(launchMsEager)}</text>
            {#each [0, 2, 4, 6, 8] as t}
              <line x1={BX + t * perMs} y1="224" x2={BX + t * perMs} y2="229" stroke="var(--faint)" />
              <text x={BX + t * perMs} y="240" text-anchor="middle" class="tick">{t} ms</text>
            {/each}
          </g>
          <g in:fade={{ delay: 1500, duration: 250 }}>
            <rect x={sliverT} y="196" width={Math.max(3, savedMs * perMs)} height="28" fill="#16a34a" />
            <path d="M {sliverT + 4} 224 V 252" fill="none" stroke="#16a34a" stroke-width="1" />
            <text x={sliverT + 4} y="264" text-anchor="middle" class="tag strong" fill="#16a34a">fusing · {(savedMs * 1000).toFixed(0)} µs</text>
          </g>
          <g in:fade={{ delay: 1900 }}>
            <text x="16" y="310" class="legend">{savedMB.toFixed(0)} MB ÷ {BW} TB/s = <tspan class="strong">{(savedMs * 1000).toFixed(0)} µs</tspan> of a {fmtMs(tMem)} weight read: {pctTraffic.toFixed(0)}% of the weight read, {pctTraffic.toFixed(0)}% of its time</text>
            <text x="16" y="332" class="legend muted">chapters 11 and 12 removed {fmtMs(launchSaved)}; this removes about {ratio}× less</text>
          </g>
        </g>
      {/if}

      <!-- 10: what it costs -->
      {#if cur.scene === 'cost'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">startup, before the first request · one row per captured shape, left to right in order</text>
          {#each jobs as j, i}
            <g in:fade={{ delay: i * 150, duration: 200 }}>
              <text x={jobX[i]} y="70" class="slab strong small">{j.t}</text>
              <text x={jobX[i]} y="84" class="tag">{j.s}</text>
            </g>
          {/each}
          {#each RUNGS as bs, r}
            {@const y = 100 + r * 26}
            <g in:fade={{ delay: 450 + r * 160, duration: 220 }}>
              <text x="30" y={y + 13} class="mono muted">batch {bs}</text>
              {#each jobs as j, i}
                {#each Array(j.n) as _, k}
                  <rect x={jobX[i] + k * JPITCH} {y} width={JPITCH - 2} height="18" rx="3" fill={j.c} opacity={j.op} />
                {/each}
              {/each}
            </g>
          {/each}
          <g in:fade={{ delay: 1350 }}>
            {#each jobs as j, i}
              <text x={jobX[i]} y="246" class="slab strong small">= {j.n * RUNGS.length}</text>
            {/each}
            <text x="30" y="270" class="tag">not ×{LAYERS} for the layers: they are identical, so one compile per shape serves all of them</text>
          </g>

          <g in:fade={{ delay: 1700 }}>
            <text x="16" y="306" class="mono strong">--torch-compile-max-bs {RUNGS[RUNGS.length - 1]}</text>
            <text x="182" y="306" class="tag">sets the rows · larger batches run with none of this</text>
            <text x="16" y="328" class="mono strong">max-autotune</text>
            <text x="182" y="328" class="tag">turns the benchmark column on · off by default, and that column is empty</text>
            <text x="16" y="362" class="legend">measured in SGLang: <tspan class="strong">90 s</tspan> on a 235B MoE, <tspan class="strong">158 s</tspan> on GLM-5.2, before the first request</text>
          </g>
        </g>
      {/if}

      <!-- 11: the one kernel none of this touched -->
      {#if cur.scene === 'closing'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">one layer, after three chapters of work</text>
          {#each layerK as k, i}
            {@const x = 30 + i * 60}
            <g in:fade={{ delay: i * 50, duration: 180 }}>
              <rect {x} y="60" width="52" height="38" rx="5" fill={k.seam ? 'var(--eos)' : k.mm ? 'var(--fg)' : '#16a34a'} opacity={k.seam ? 0.9 : 0.8} />
              <text x={x + 26} y="84" text-anchor="middle" class="kname">{k.n}</text>
            </g>
          {/each}
          <g in:fade={{ delay: 700 }}>
            <path d="M 236 100 V 118" fill="none" stroke="var(--eos)" stroke-width="1.5" marker-end="url(#tc-arrow-bad)" />
            <text x="236" y="134" text-anchor="middle" class="tag strong" fill="var(--eos)">still eager, still untouched</text>
          </g>

          {#each [
            { t: 'the order you met them', y: 168, badges: true, ops: [OPS.record, OPS.cut, OPS.fuse] },
            { t: 'the order they happen', y: 224, badges: false, ops: [OPS.cut, OPS.fuse, OPS.record] },
          ] as row, r}
            <g in:fly={{ x: -10, delay: 900 + r * 280, duration: 280 }}>
              <text x="30" y={row.y + 21} class="slab small" fill="var(--muted)">{row.t}</text>
              {#each row.ops as op, i}
                {@const x = 240 + i * 152}
                {#if row.badges}
                  <text x={x + 65} y={row.y - 8} text-anchor="middle" class="badge">chapter {op.ch}</text>
                {/if}
                <rect {x} y={row.y} width="130" height="32" rx="16" fill={op.c} fill-opacity="0.13" stroke={op.c} stroke-width="1.5" />
                <text x={x + 65} y={row.y + 21} text-anchor="middle" class="slab strong small" fill={op.c}>{op.n}</text>
                {#if i < 2}
                  <path d="M {x + 142} {row.y + 11} L {x + 148} {row.y + 16} L {x + 142} {row.y + 21}" fill="none" stroke="var(--faint)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                {/if}
              {/each}
            </g>
          {/each}

          <g in:fade={{ delay: 1500 }}>
            <text x="16" y="286" class="legend muted">cut before recording: attention would not capture</text>
            <text x="16" y="306" class="legend muted">fuse before recording: a recording freezes whichever kernels exist when it is taken</text>
            <text x="16" y="344" class="legend"><tspan class="strong">Attention sat outside all three.</tspan> So what can be done with the attention kernel itself?</text>
          </g>
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
  .mono { font-family: var(--mono); font-size: 10px; fill: var(--fg); }
  .mono.muted { fill: var(--muted); }
  .mono.faint { fill: var(--faint); }
  .mono.strong { font-weight: 600; }
  .legend .mono, .tag .mono { font-size: 10px; }
  .code { white-space: pre; }
  .tag { font-size: 10px; fill: var(--muted); }
  .tag.strong, .tag .strong, .mono .strong { fill: var(--fg); font-weight: 600; }
  .kname { font-family: var(--mono); font-size: 10px; fill: white; font-weight: 600; }
  .boxtitle { font-family: var(--mono); font-size: 10.5px; fill: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .slab { font-size: 12px; fill: var(--fg); }
  .slab.small { font-size: 11.5px; }
  .slab.strong.small { font-size: 12px; font-weight: 650; }
  .badge { font-family: var(--mono); font-size: 9px; fill: var(--faint); letter-spacing: 0.04em; }
  .tick { font-family: var(--mono); font-size: 9px; fill: var(--faint); }
  .legend { font-size: 11.5px; fill: var(--fg); }
  .legend .strong { font-weight: 650; }
  .legend.muted { fill: var(--muted); }
</style>
