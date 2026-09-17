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
  const pctTraffic = (savedMB / totalMB) * 100;
  const kb = (b: number) => `${Math.round(b / 1024)} KB`;
  const launchMsEager = 9;                                  // chapter 11's eager step: the launches, not the GPU
  const launchSaved = launchMsEager - tMem;                 // 4.2 ms, what chapters 11 and 12 took off
  const ratio = Math.round(launchSaved / savedMs);          // and how much bigger that was than this
  const fmtMs = (ms: number) => (ms < 10 ? ms.toFixed(1) : ms.toFixed(0)) + ' ms';

  type Scene = 'chain' | 'waste' | 'why' | 'fuse' | 'triton' | 'whatfuses' | 'tiles' | 'autotune' | 'worth' | 'cost' | 'closing';
  interface Step { caption: string; scene: Scene }
  const steps: Step[] = [
    { scene: 'chain', caption: `Chapter 12 left a piece looking like this: a chain of kernels between two matmuls, each one reading its input from memory and writing its output back. Take the two in the middle.` },
    { scene: 'waste', caption: `<b>SiLU</b> writes ${kb(inter)} per token per layer into HBM, and <b>multiply</b> reads it back a microsecond later. Nothing else ever looks at it. It is a value in flight, given a round trip to memory it never needed.` },
    { scene: 'why', caption: `It exists because eager PyTorch is an interpreter. <code>silu(gate)</code> is a function call, and a function call has to return something real — the next line hasn't been read yet. Every operation materialises its result.` },
    { scene: 'fuse', caption: `<b>Fuse them.</b> One kernel: load gate and up once, compute the SiLU and the multiply in registers, store the answer once. Identical arithmetic, two fewer trips through memory.` },
    { scene: 'triton', caption: `And you can, because chapter 12 already traced the model. <b>Inductor</b> takes that graph, walks the chain of pointwise ops, and writes a <b>Triton</b> kernel that does all of them in one pass.` },
    { scene: 'whatfuses', caption: `Pointwise and reduction chains fuse freely. Matmuls don't: Inductor doesn't write those, it <b>picks</b> one — cuBLAS, a Triton template, CUTLASS — and fuses only the edges into it. Eleven kernels become eight.` },
    { scene: 'tiles', caption: `The second job needs one idea first. A matmul's output is carved into <b>tiles</b>, and each tile is one thread block's share of the work: it reads the rows of A and the columns of B that produce its patch. <code>BLOCK</code> is that tile's shape.` },
    { scene: 'autotune', caption: `A library picks a tile shape that suits a square output. A decode matmul's output is ${B_EX} rows by ${F.toLocaleString()} columns — 56 times wider than it is tall. So benchmark a handful of shapes on the real one and keep the fastest.` },
    { scene: 'worth', caption: `Fusing that chain removes ${savedMB.toFixed(0)} MB from a decode step at batch ${B_EX}. Against the ${(totalMB / 1e3).toFixed(1)} GB the step moves in total that is about ${pctTraffic.toFixed(0)}%, which on a memory-bound step is about ${(savedMs * 1000).toFixed(0)} µs of ${fmtMs(tMem)}.` },
    { scene: 'cost', caption: `Two jobs run at startup, each once per captured shape: Inductor compiles a kernel for every fused group, then chapter 11 records a replay of them. <code>max-autotune</code> adds a benchmark sweep per matmul.` },
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

  // candidate matmul tilings, as an autotune sweep would find them
  // the startup bill, once --torch-compile-max-bs 16 has fixed the rungs at 1, 2, 4, 8, 16
  const DISTINCT_K = 8;      // fused groups in one layer, from the "what fuses" step
  const MATMULS = 4;         // of those 8
  const SHAPES = 5;
  const cands = [
    { n: 'BLOCK 128×128', t: 1.00 }, { n: 'BLOCK 64×256', t: 0.86 }, { n: 'BLOCK 32×256', t: 0.71 },
    { n: 'BLOCK 16×512', t: 0.78 }, { n: 'cuBLAS default', t: 0.94 },
  ];
  const best = cands.reduce((a, c) => (c.t < a.t ? c : a));
  const compiles = DISTINCT_K * SHAPES;
  const benches = MATMULS * cands.length * SHAPES;
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
            <text x="16" y="352" class="legend"><tspan class="strong">{kb(savedPerTokLayer)} of traffic per token per layer</tspan>, for a value that was alive for about a microsecond</text>
            <text x="16" y="374" class="legend muted">across {LAYERS} layers that is {savedPerTok.toFixed(1)} MB a token, moved out to memory and straight back in</text>
          </g>
        </g>
      {/if}

      <!-- 3: why it is a separate kernel at all -->
      {#if cur.scene === 'why'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">why the value is written down at all</text>
          <rect x="40" y="70" width="300" height="122" rx="10" fill="#fbfaf7" stroke="var(--accent)" />
          <text x="56" y="94" class="boxtitle">what you wrote</text>
          <text x="56" y="122" class="mono">h = silu(gate)</text>
          <text x="56" y="144" class="mono">h = h * up</text>
          <text x="56" y="172" class="tag">two calls, in order, one line at a time</text>

          <rect x="380" y="70" width="300" height="122" rx="10" fill="#fbfaf7" stroke="var(--eos)" />
          <text x="396" y="94" class="boxtitle">what eager has to do</text>
          <text x="396" y="122" class="tag">a call must <tspan class="strong">return something</tspan>, and the</text>
          <text x="396" y="140" class="tag">only thing it can return is a real tensor</text>
          <text x="396" y="158" class="tag">in memory. Line 2 has not been read yet.</text>
          <text x="396" y="180" class="tag strong" fill="var(--eos)">so every result is materialised</text>

          <g in:fade={{ delay: 600 }}>
            <text x="16" y="232" class="rowlabel">the interpreter's view, one op at a time</text>
            {#each ['silu', '?', '?', '?'] as op, i}
              {@const x = 40 + i * 106}
              <rect {x} y="248" width="92" height="34" rx="6" fill={i === 0 ? 'var(--accent)' : 'white'} stroke={i === 0 ? 'none' : 'var(--line)'} stroke-dasharray={i === 0 ? 'none' : '3 3'} opacity={i === 0 ? 0.9 : 1} />
              <text x={x + 46} y="270" text-anchor="middle" class={i === 0 ? 'kname' : 'tag'}>{op}</text>
            {/each}
            <text x="480" y="270" class="tag">it can see exactly one box</text>
          </g>
          <text x="16" y="330" class="legend" in:fade={{ delay: 1000 }}>an interpreter cannot fuse what it has not seen yet — <tspan class="strong">this is a knowledge problem, not a kernel problem</tspan></text>
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
          <text x="16" y="336" class="legend muted" in:fade={{ delay: 1600 }}>nobody at SGLang wrote this file; it is generated from the graph, for the shapes the graph was traced with</text>
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
            <rect x="30" y="196" width="320" height="86" rx="10" fill="#fbfaf7" stroke="#16a34a" />
            <text x="46" y="220" class="slab strong small" fill="#16a34a">generated</text>
            <text x="46" y="242" class="tag">pointwise and reduction chains, written fresh</text>
            <text x="46" y="260" class="tag">as one Triton kernel per group</text>

            <rect x="370" y="196" width="320" height="86" rx="10" fill="#fbfaf7" stroke="var(--fg)" />
            <text x="386" y="220" class="slab strong small">chosen, not written</text>
            <text x="386" y="242" class="tag">matmuls come from cuBLAS, a Triton template</text>
            <text x="386" y="260" class="tag">or CUTLASS — only the edges fuse into them</text>
          </g>
          <text x="16" y="326" class="legend" in:fade={{ delay: 1700 }}>4 of the {GROUPS} are matmuls that were never going away, and one is the attention seam from chapter 12</text>
          <text x="16" y="348" class="legend muted" in:fade={{ delay: 1700 }}>what the compiler removed is the glue between them</text>
        </g>
      {/if}

      <!-- 7: what a tile is -->
      {#if cur.scene === 'tiles'}
        {@const CELL = 13}
        {@const ROWS = 8}
        {@const COLS = 12}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">what a tiling is · the output C of a small matmul, [{ROWS} × {COLS}], carved up two ways</text>
          {#each [{ x: 60, bm: 4, bn: 4 }, { x: 400, bm: 8, bn: 6 }] as v, p}
            {@const w = COLS * CELL}
            {@const h = ROWS * CELL}
            {@const nT = (ROWS / v.bm) * (COLS / v.bn)}
            <g in:fade={{ delay: p * 450, duration: 250 }}>
              <text x={v.x + w / 2} y="76" text-anchor="middle" class="slab strong small">BLOCK {v.bm} × {v.bn}</text>
              <rect x={v.x} y="90" width={w} height={h} fill="#f4f2ec" stroke="var(--line)" />
              {#each Array(COLS - 1) as _, c}
                <line x1={v.x + (c + 1) * CELL} y1="90" x2={v.x + (c + 1) * CELL} y2={90 + h} stroke="white" stroke-width="1" />
              {/each}
              {#each Array(ROWS - 1) as _, r}
                <line x1={v.x} y1={90 + (r + 1) * CELL} x2={v.x + w} y2={90 + (r + 1) * CELL} stroke="white" stroke-width="1" />
              {/each}
              <rect x={v.x} y="90" width={v.bn * CELL} height={v.bm * CELL} fill="var(--accent)" opacity="0.8" />
              {#each Array(COLS / v.bn - 1) as _, c}
                <line x1={v.x + (c + 1) * v.bn * CELL} y1="90" x2={v.x + (c + 1) * v.bn * CELL} y2={90 + h} stroke="var(--fg)" stroke-width="1.6" />
              {/each}
              {#each Array(ROWS / v.bm - 1) as _, r}
                <line x1={v.x} y1={90 + (r + 1) * v.bm * CELL} x2={v.x + w} y2={90 + (r + 1) * v.bm * CELL} stroke="var(--fg)" stroke-width="1.6" />
              {/each}
              <text x={v.x + w / 2} y={90 + h + 22} text-anchor="middle" class="tag"><tspan class="strong">{nT} tiles</tspan> → {nT} thread blocks</text>
              <text x={v.x + w / 2} y={90 + h + 40} text-anchor="middle" class="tag">each reads {v.bm} rows of A, {v.bn} columns of B</text>
            </g>
          {/each}
          <g in:fade={{ delay: 900 }}>
            <rect x="248" y="112" width="104" height="60" rx="8" fill="var(--accent-soft)" stroke="var(--accent)" />
            <text x="300" y="134" text-anchor="middle" class="tag strong">one tile</text>
            <text x="300" y="150" text-anchor="middle" class="tag">= one block's</text>
            <text x="300" y="164" text-anchor="middle" class="tag">patch of C</text>
          </g>
          <g in:fade={{ delay: 1200 }}>
            <text x="16" y="300" class="legend">a bigger tile reuses more of what it loads, and needs more registers to hold it</text>
            <text x="16" y="322" class="legend muted">a smaller tile makes more blocks, which is how you keep every SM on the GPU busy</text>
            <text x="16" y="344" class="legend muted">the right trade depends on the shape of C — so it depends on the batch</text>
          </g>
        </g>
      {/if}

      <!-- 8: the shape you actually have -->
      {#if cur.scene === 'autotune'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">the shape a decode matmul actually has</text>
          <text x="40" y="70" class="tag">C = [{B_EX} × {F.toLocaleString()}] · {B_EX} rows, {F.toLocaleString()} columns</text>
          <rect x="40" y="78" width="640" height="12" fill="var(--accent)" opacity="0.8" />
          <text x="40" y="106" class="tag">56 times wider than it is tall — there are only {B_EX} rows to divide between tiles</text>

          <text x="16" y="146" class="rowlabel">candidate tile shapes · time on that exact C, shorter is better</text>
          {#each cands as c, i}
            {@const y = 164 + i * 28}
            {@const win = c.n === best.n}
            <g in:fade={{ delay: i * 180, duration: 200 }}>
              <text x="30" y={y + 14} class={win ? 'mono strong' : 'mono muted'}>{c.n}</text>
              <rect x="170" y={y} width={c.t * 400} height="18" rx="4" fill={win ? '#16a34a' : 'var(--faint)'} opacity={win ? 0.9 : 0.5} />
              <text x={170 + c.t * 400 + 8} y={y + 14} class="tag">{(c.t * 100).toFixed(0)}%</text>
              {#if win}<text x={170 + c.t * 400 + 44} y={y + 14} class="tag strong" fill="#16a34a">keep this one</text>{/if}
            </g>
          {/each}
          <g in:fade={{ delay: 1000 }}>
            <text x="16" y="336" class="legend">a library's default tile is chosen for a <tspan class="strong">square</tspan> output; this one is a sliver, and a different shape wins</text>
            <text x="16" y="358" class="legend muted">most of the reported "5–15% at small batch" comes from here, not from the fusion</text>
          </g>
        </g>
      {/if}

      <!-- 9: what it is worth -->
      {#if cur.scene === 'worth'}
        {@const BX = 170}
        {@const BW2 = 500}
        {@const perGB = BW2 / (totalMB / 1e3)}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">one decode step at batch {B_EX} · the bytes it moves</text>

          <g in:fade={{ delay: 100, duration: 250 }}>
            <text x={BX - 12} y="98" text-anchor="end" class="rowlabel">it moves</text>
            <rect x={BX} y="80" width={W_GB * perGB} height="28" rx="4" fill="var(--gen)" opacity="0.85" />
            <rect x={BX + W_GB * perGB} y="80" width={(actMB / 1e3) * perGB} height="28" rx="4" fill="var(--accent)" opacity="0.85" />
            <text x={BX + BW2 + 12} y="98" class="tag strong">{(totalMB / 1e3).toFixed(1)} GB</text>
            <text x={BX + (W_GB * perGB) / 2} y="126" text-anchor="middle" class="tag">the weights · {W_GB.toFixed(1)} GB, read whatever the batch is</text>
            <path d="M {BX + BW2 - 20} 112 V 140" fill="none" stroke="var(--faint)" stroke-width="1" />
            <text x={BX + BW2 - 28} y="152" text-anchor="end" class="tag">activations · {(actMB / 1e3).toFixed(1)} GB</text>
          </g>

          <g in:fade={{ delay: 500, duration: 250 }}>
            <text x={BX - 12} y="196" text-anchor="end" class="rowlabel">fusing removes</text>
            <rect x={BX} y="178" width={Math.max(3, (savedMB / 1e3) * perGB)} height="28" rx="2" fill="#16a34a" opacity="0.9" />
            <text x={BX + 22} y="196" class="tag strong">{savedMB.toFixed(0)} MB</text>
            <text x={BX + 96} y="196" class="tag">the intermediates that never needed a trip</text>
          </g>

          <g in:fade={{ delay: 900 }}>
            <text x="16" y="248" class="legend">{savedMB.toFixed(0)} MB out of {(totalMB / 1e3).toFixed(1)} GB is <tspan class="strong">{pctTraffic.toFixed(0)}% of the bytes</tspan></text>
            <text x="16" y="270" class="legend muted">the step is memory-bound, so {pctTraffic.toFixed(0)}% of the bytes is about {pctTraffic.toFixed(0)}% of the time: {(savedMs * 1000).toFixed(0)} µs of {fmtMs(tMem)}</text>
          </g>
          <g in:fade={{ delay: 1300 }}>
            <rect x="16" y="296" width="676" height="52" rx="10" fill="var(--accent-soft)" stroke="var(--accent)" />
            <text x="32" y="318" class="slab small">Chapters 11 and 12 removed <tspan class="strong">{fmtMs(launchSaved)}</tspan> of launch overhead — nearly half of a {fmtMs(launchMsEager)} step.</text>
            <text x="32" y="338" class="slab small">Fusing removes <tspan class="strong">{(savedMs * 1000).toFixed(0)} µs</tspan>, about {ratio}× smaller. Compiler wins are this size.</text>
          </g>
        </g>
      {/if}

      <!-- 10: what it costs -->
      {#if cur.scene === 'cost'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">two jobs at startup · both of them once per captured shape</text>
          {#each [
            { t: '1 · compile', c: 'var(--accent)', l: ['Inductor generates and compiles a Triton', 'kernel for each fused group'], out: 'output: kernels' },
            { t: '2 · capture', c: 'var(--gen)', l: ['chapter 11 records a replay of those', 'kernels running, in order'], out: 'output: a graph' },
          ] as b, i}
            {@const x = 30 + i * 336}
            <g in:fade={{ delay: i * 250, duration: 250 }}>
              <rect {x} y="60" width="300" height="76" rx="12" fill="#fbfaf7" stroke={b.c} />
              <text x={x + 16} y="82" class="slab strong small">{b.t}</text>
              {#each b.l as line, k}<text x={x + 16} y={102 + k * 15} class="tag">{line}</text>{/each}
              <text x={x + 284} y="82" text-anchor="end" class="tag" fill={b.c}>{b.out}</text>
            </g>
          {/each}
          <path d="M 336 98 H 358" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#tc-arrow)" in:fade={{ delay: 220 }} />
          <text x="16" y="156" class="tag" in:fade={{ delay: 500 }}>compile has to run first: a recording freezes whichever kernels exist when it is taken</text>

          <g in:fade={{ delay: 700 }}>
            <text x="16" y="192" class="rowlabel">the bill, with {SHAPES} shapes captured</text>
            <text x="30" y="220" class="slab small">kernels to compile</text>
            <text x="230" y="220" class="mono">{DISTINCT_K} distinct kernels × {SHAPES} shapes</text>
            <text x="560" y="220" class="slab strong small">= {compiles}</text>
            <text x="30" y="246" class="slab small">matmuls to benchmark</text>
            <text x="230" y="246" class="mono">{MATMULS} matmuls × {cands.length} candidates × {SHAPES} shapes</text>
            <text x="560" y="246" class="slab strong small">= {benches}</text>
            <text x="30" y="270" class="tag">not ×{LAYERS} for the layers: they are identical, so Inductor compiles one and caches it</text>
          </g>

          <g in:fade={{ delay: 1100 }}>
            <text x="16" y="306" class="mono strong">max-autotune</text>
            <text x="182" y="306" class="tag">the mode that asks for the sweep two steps back · without it the second row is 0</text>
            <text x="16" y="328" class="mono strong">--torch-compile-max-bs 16</text>
            <text x="182" y="328" class="tag">sets the "{SHAPES} shapes" — bigger batches then run with none of this</text>
            <text x="16" y="358" class="legend">measured in SGLang: <tspan class="strong">90 s</tspan> on a 235B MoE, <tspan class="strong">158 s</tspan> on GLM-5.2, before the first request</text>
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
            <text x="16" y="286" class="legend muted">you cut before you record, because you cannot record what will not capture</text>
            <text x="16" y="306" class="legend muted">and you fuse before you record, because a recording freezes whichever kernels exist when it is taken</text>
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
  .mono.strong { font-weight: 600; }
  .code { white-space: pre; }
  .tag { font-size: 10px; fill: var(--muted); }
  .tag.strong, .tag .strong, .mono .strong { fill: var(--fg); font-weight: 600; }
  .kname { font-family: var(--mono); font-size: 10px; fill: white; font-weight: 600; }
  .boxtitle { font-family: var(--mono); font-size: 10.5px; fill: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .slab { font-size: 12px; fill: var(--fg); }
  .slab.small { font-size: 11.5px; }
  .slab.strong.small { font-size: 12px; font-weight: 650; }
  .badge { font-family: var(--mono); font-size: 9px; fill: var(--faint); letter-spacing: 0.04em; }
  .legend { font-size: 11.5px; fill: var(--fg); }
  .legend .strong { font-weight: 650; }
  .legend.muted { fill: var(--muted); }
</style>
