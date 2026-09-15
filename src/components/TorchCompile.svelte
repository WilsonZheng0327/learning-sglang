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
  const pctTraffic = (savedMB / 1e3 / W_GB) * 100;
  const kb = (b: number) => `${Math.round(b / 1024)} KB`;
  const fmtMs = (ms: number) => (ms < 10 ? ms.toFixed(1) : ms.toFixed(0)) + ' ms';

  type Scene = 'chain' | 'waste' | 'why' | 'fuse' | 'triton' | 'whatfuses' | 'autotune' | 'worth' | 'cost' | 'closing';
  interface Step { caption: string; scene: Scene }
  const steps: Step[] = [
    { scene: 'chain', caption: `Chapter 12 left a piece looking like this: a chain of kernels between two matmuls, each one reading its input from memory and writing its output back. Take the two in the middle.` },
    { scene: 'waste', caption: `<b>SiLU</b> writes ${kb(inter)} per token per layer into HBM, and <b>multiply</b> reads it back a microsecond later. Nothing else ever looks at it. It is a value in flight, given a round trip to memory it never needed.` },
    { scene: 'why', caption: `It exists because eager PyTorch is an interpreter. <code>silu(gate)</code> is a function call, and a function call has to return something real — the next line hasn't been read yet. Every operation materialises its result.` },
    { scene: 'fuse', caption: `<b>Fuse them.</b> One kernel: load gate and up once, compute the SiLU and the multiply in registers, store the answer once. Identical arithmetic, two fewer trips through memory.` },
    { scene: 'triton', caption: `And you can, because chapter 12 already traced the model. <b>Inductor</b> takes that graph, walks the chain of pointwise ops, and writes a <b>Triton</b> kernel that does all of them in one pass.` },
    { scene: 'whatfuses', caption: `Pointwise and reduction chains fuse freely. Matmuls don't: Inductor doesn't write those, it <b>picks</b> one — cuBLAS, a Triton template, CUTLASS — and fuses only the edges into it. Eleven kernels become eight.` },
    { scene: 'autotune', caption: `The second job. A decode matmul is <b>skinny</b>: ${B_EX} rows against a 4096×14336 weight. Library defaults are tuned for square. So benchmark a handful of tilings on the shape you actually have, and keep the winner.` },
    { scene: 'worth', caption: `What it's worth: single digits. Fusing the chain removes about ${pctTraffic.toFixed(0)}% of a decode step's memory traffic; autotuning skinny matmuls is worth another few. After chapters 11 and 12 took the ${(9).toFixed(0)} ms of launches, single digits is <b>what's left</b>.` },
    { scene: 'cost', caption: `And it isn't free. Every shape gets compiled, and <code>max-autotune</code> benchmarks every candidate for every shape — minutes of startup, once per rung. Hence a cap on which batch sizes get compiled, and a cache you can ship to the next machine.` },
    { scene: 'closing', caption: `So the layer is recorded, cut, fused and tuned. One kernel in the middle has had none of it: attention was cut out in chapter 12 and has been running eagerly ever since. What <i>is</i> that kernel — and why does SGLang ship five of them? Chapter ${CH_NEXT}.` },
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

  // candidate matmul tilings, as an autotune sweep would find them
  const cands = [
    { n: 'BLOCK 128×128', t: 1.00 }, { n: 'BLOCK 64×256', t: 0.86 }, { n: 'BLOCK 32×256', t: 0.71 },
    { n: 'BLOCK 16×512', t: 0.78 }, { n: 'cuBLAS default', t: 0.94 },
  ];
  const best = cands.reduce((a, c) => (c.t < a.t ? c : a));
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
            <rect x="238" y="82" width="216" height="66" rx="10" fill="none" stroke="var(--eos)" stroke-dasharray="4 3" />
            <text x="346" y="74" text-anchor="middle" class="tag strong" fill="var(--eos)">these two</text>
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
            {@const x = 22 + i * 236}
            <g in:fly={{ y: 8, delay: i * 280, duration: 300 }}>
              <rect {x} y="64" width="216" height="94" rx="12" fill="#fbfaf7" stroke={b.c} />
              <text x={x + 14} y="88" class="slab strong small">{b.t}</text>
              {#each b.l as line, k}<text x={x + 14} y={110 + k * 16} class="tag">{line}</text>{/each}
            </g>
            {#if i < 2}
              <path d="M {x + 220} 111 H {x + 232}" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#tc-arrow)" in:fade={{ delay: i * 280 + 240 }} />
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

      <!-- 7: autotuning the shapes you actually have -->
      {#if cur.scene === 'autotune'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">the other job · picking the kernel for the shape in front of you</text>
          <rect x="30" y="64" width="660" height="44" rx="10" fill="#fbfaf7" stroke="var(--accent)" />
          <text x="48" y="92" class="mono">one decode matmul · <tspan class="strong">[{B_EX}, {D.toLocaleString()}]</tspan> × [{D.toLocaleString()}, {F.toLocaleString()}] — {B_EX} rows against a wall of weights</text>
          <text x="16" y="140" class="rowlabel">candidate tilings · time on that exact shape, shorter is better</text>
          {#each cands as c, i}
            {@const y = 160 + i * 30}
            {@const win = c.n === best.n}
            <g in:fade={{ delay: i * 200, duration: 200 }}>
              <text x="30" y={y + 14} class={win ? 'mono strong' : 'mono muted'}>{c.n}</text>
              <rect x="170" y={y} width={c.t * 420} height="18" rx="4" fill={win ? '#16a34a' : 'var(--faint)'} opacity={win ? 0.9 : 0.5} />
              <text x={170 + c.t * 420 + 8} y={y + 14} class="tag">{(c.t * 100).toFixed(0)}%</text>
              {#if win}<text x={170 + c.t * 420 + 44} y={y + 14} class="tag strong" fill="#16a34a">keep this one</text>{/if}
            </g>
          {/each}
          <g in:fade={{ delay: 1200 }}>
            <text x="16" y="336" class="legend">a library default is tuned for <tspan class="strong">square</tspan> matmuls; a decode matmul is a sliver, and the best tiling for it is a different one</text>
            <text x="16" y="358" class="legend muted">this is where most of the reported "5–15% at small batch" comes from, not from the fusion</text>
          </g>
        </g>
      {/if}

      <!-- 8: what it is worth -->
      {#if cur.scene === 'worth'}
        {@const X = 210}
        {@const SC = 26}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">one decode step at batch {B_EX} · where the bytes go</text>
          {#each [
            { t: 'the weights', gb: W_GB, c: 'var(--gen)', s: 'read every step, irreducible' },
            { t: 'activations', gb: (savedPerTok * B_EX * 3) / 1e3, c: 'var(--accent)', s: 'everything the layers pass along' },
            { t: 'of which: fusible', gb: savedMB / 1e3, c: '#16a34a', s: 'intermediates that never needed a trip' },
          ] as row, i}
            {@const y = 84 + i * 62}
            <g in:fade={{ delay: i * 250, duration: 220 }}>
              <text x={X - 12} y={y + 18} text-anchor="end" class="rowlabel">{row.t}</text>
              <rect x={X} y={y} width={Math.max(3, row.gb * SC)} height="26" rx="4" fill={row.c} opacity="0.85" />
              <text x={X + Math.max(3, row.gb * SC) + 10} y={y + 18} class="tag strong">{row.gb < 1 ? `${Math.round(row.gb * 1000)} MB` : `${row.gb.toFixed(1)} GB`}</text>
              <text x={X} y={y + 40} class="tag">{row.s}</text>
            </g>
          {/each}
          <g in:fade={{ delay: 900 }}>
            <text x="16" y="292" class="legend">fusing the chain takes <tspan class="strong">{pctTraffic.toFixed(0)}%</tspan> off the step: {savedMB.toFixed(0)} MB, about {(savedMs * 1000).toFixed(0)} µs of the {fmtMs(tMem)}</text>
            <text x="16" y="314" class="legend muted">autotuning the matmuls is worth a few more percent — and more still on a quantised model (chapter {CH_QUANT})</text>
          </g>
          <g in:fade={{ delay: 1400 }}>
            <rect x="16" y="336" width="676" height="44" rx="10" fill="var(--accent-soft)" stroke="var(--accent)" />
            <text x="360" y="363" text-anchor="middle" class="slab small">chapters 11 and 12 took the <tspan class="strong">9 ms</tspan> of launches. <tspan class="strong">Single digits is what's left.</tspan></text>
          </g>
        </g>
      {/if}

      <!-- 9: what it costs -->
      {#if cur.scene === 'cost'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">what you pay for it, and when</text>
          {#each [
            { t: 'trace', s: 'once per model', bar: 0.06, c: 'var(--muted)' },
            { t: 'generate the Triton', s: 'once per group, per shape', bar: 0.22, c: 'var(--accent)' },
            { t: 'autotune', s: 'every candidate × every shape', bar: 1.0, c: 'var(--eos)' },
          ] as row, i}
            {@const y = 76 + i * 56}
            <g in:fade={{ delay: i * 250, duration: 220 }}>
              <text x="188" y={y + 18} text-anchor="end" class="rowlabel">{row.t}</text>
              <rect x="200" y={y} width={row.bar * 340} height="26" rx="4" fill={row.c} opacity="0.85" />
              <text x={200 + row.bar * 340 + 10} y={y + 18} class="tag">{row.s}</text>
            </g>
          {/each}
          <g in:fade={{ delay: 900 }}>
            <text x="16" y="266" class="legend">all of it at startup, all of it before the first request — <tspan class="strong">minutes, not seconds</tspan></text>
            <text x="16" y="292" class="legend muted">so you cap which batch sizes get compiled, and you keep the result</text>
            <rect x="16" y="310" width="676" height="62" rx="10" fill="#fbfaf7" stroke="var(--line)" />
            <text x="32" y="332" class="mono strong">--torch-compile-max-bs</text>
            <text x="230" y="332" class="tag">compile up to this batch size and no further</text>
            <text x="32" y="356" class="mono strong">TORCHINDUCTOR_CACHE_DIR</text>
            <text x="230" y="356" class="tag">the generated kernels, on disk — ship it and the next machine skips the wait</text>
          </g>
        </g>
      {/if}

      <!-- 10: the one kernel none of this touched -->
      {#if cur.scene === 'closing'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">one layer, after three chapters of work</text>
          {#each layerK as k, i}
            {@const x = 30 + i * 60}
            <g in:fade={{ delay: i * 60, duration: 200 }}>
              <rect {x} y="76" width="52" height="40" rx="5" fill={k.seam ? 'var(--eos)' : k.mm ? 'var(--fg)' : '#16a34a'} opacity={k.seam ? 0.9 : 0.8} />
              <text x={x + 26} y="101" text-anchor="middle" class="kname">{k.n}</text>
            </g>
          {/each}
          <g in:fade={{ delay: 800 }}>
            <path d="M 216 126 V 146" fill="none" stroke="var(--eos)" stroke-width="1.5" marker-end="url(#tc-arrow-bad)" />
            <text x="216" y="164" text-anchor="middle" class="tag strong" fill="var(--eos)">still eager, still untouched</text>
          </g>
          {#each [
            { c: 11, t: 'recorded', s: 'the launches became one replay' },
            { c: 12, t: 'cut', s: 'and attention was left out of the recording' },
            { c: 13, t: 'fused and tuned', s: 'the glue between the matmuls was rewritten' },
          ] as row, i}
            {@const y = 196 + i * 42}
            <g in:fly={{ x: -8, delay: 1000 + i * 180, duration: 250 }}>
              <text x="30" y={y + 16} class="rowlabel">chapter {row.c}</text>
              <text x="130" y={y + 16} class="slab strong small">{row.t}</text>
              <text x="290" y={y + 16} class="tag">{row.s}</text>
            </g>
          {/each}
          <text x="16" y="348" class="legend" in:fade={{ delay: 1700 }}><tspan class="strong">Attention has had none of it.</tspan> It was cut out in chapter {CH_NEXT - 2} and has been running eagerly ever since.</text>
          <text x="16" y="370" class="legend muted" in:fade={{ delay: 1700 }}>so what is that kernel, and why does SGLang ship five different ones?</text>
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
  .legend { font-size: 11.5px; fill: var(--fg); }
  .legend .strong { font-weight: 650; }
  .legend.muted { fill: var(--muted); }
</style>
