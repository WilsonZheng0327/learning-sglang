<script lang="ts">
  import { fade, fly } from 'svelte/transition';
  import StepControls from './StepControls.svelte';
  import { chapters, type NavLink } from '../chapters';
  let { prev, next }: { prev?: NavLink; next?: NavLink } = $props();
  const chNum = (slug: string) => chapters.findIndex((c) => c.slug === slug) + 1;
  const CH_NEXT = chNum('13-torch-compile');
  const CH_TP = chNum('18-tensor-parallel');

  // ---- Numbers: Llama-3-8B bf16 on one H100, continuing chapters 4 and 11 ------------------------------
  const W_GB = 16, BW = 3.35;
  const tMem = W_GB / BW;                          // 4.8 ms: the weight read, the floor under any step
  const LAYERS = 32;
  const KERNELS = 1000, LAUNCH_US = 9;
  const launchMs = (KERNELS * LAUNCH_US) / 1000;   // 9 ms of CPU to launch a step kernel by kernel
  const US_PER_TOKEN = 16;                         // 2·8e9 FLOPs per token at ~1 PFLOP/s, as in chapter 4
  const BALANCE = Math.round((tMem * 1000) / US_PER_TOKEN / 10) * 10; // 300: compute catches memory
  const LAUNCH_BOUND = Math.round((launchMs * 1000) / US_PER_TOKEN / 10) * 10; // 560: GPU time catches the launches
  const fmt = (ms: number) => (ms < 10 ? ms.toFixed(1) : ms.toFixed(0)) + ' ms';

  // piecewise cost: one replay per piece, plus attention launched the old way
  const PIECES = LAYERS + 1;
  const REPLAY_PIECE_US = 10, ATTN_LAUNCHES = 3;
  const pieceMs = (PIECES * REPLAY_PIECE_US) / 1000;
  const attnMs = (LAYERS * ATTN_LAUNCHES * LAUNCH_US) / 1000;
  const pieceTotal = pieceMs + attnMs;             // ~1.2 ms

  const SEQ_A = [18, 27, 11];        // same token total, different sequence boundaries
  const SEQ_B = [40, 9, 7];
  const TOTAL = SEQ_A.reduce((a, b) => a + b, 0);
  const SEQC = ['var(--accent)', 'var(--gen)', '#0891b2'];

  // one layer, run on batch 1 and batch 2. Llama-3-8B: hidden 4096, qkv 6144 with GQA, ffn 14336.
  const D = 4096, QKV = 6144, FFN = 14336;
  const tri = (seq: number[]) => seq.map((x) => `${x}×${x}`).join('  ');
  const kernelRows = [
    { n: 'norm', a: `[${TOTAL}, ${D}]` },
    { n: 'qkv', a: `[${TOTAL}, ${D}] × [${D}, ${QKV}]` },
    { n: 'rope', a: `[${TOTAL}, ${D}]` },
    { n: 'attn', a: tri(SEQ_A), b: tri(SEQ_B), seam: true },
    { n: 'o', a: `[${TOTAL}, ${D}] × [${D}, ${D}]` },
    { n: 'add', a: `[${TOTAL}, ${D}]` },
    { n: 'norm', a: `[${TOTAL}, ${D}]` },
    { n: 'gate·up', a: `[${TOTAL}, ${D}] × [${D}, ${2 * FFN}]` },
    { n: 'silu', a: `[${TOTAL}, ${FFN}]` },
    { n: 'down', a: `[${TOTAL}, ${FFN}] × [${FFN}, ${D}]` },
    { n: 'add', a: `[${TOTAL}, ${D}]` },
  ];
  const SAME = kernelRows.filter((r) => !r.seam).length;

  type Scene = 'shapes' | 'bound' | 'bucket' | 'bounds' | 'tokenwise' | 'cut' | 'run' | 'arith' | 'ladder' | 'seams' | 'tracer' | 'closing';
  interface Step { caption: string; scene: Scene; v?: number }
  const steps: Step[] = [
    { scene: 'shapes', caption: `Chapter 11 ended here. Decode gets a graph because its batch is always [B, 1]; prefill is ragged, so it runs eagerly — <b>and that was fine, because prefill is compute-bound anyway</b>. That last part deserves a second look.` },
    { scene: 'bound', caption: `Only above about ${LAUNCH_BOUND} tokens. Below that, the GPU finishes a prefill step in less time than the CPU needs to launch it — prefill is <b>launch-bound</b>, exactly like decode was in chapter 11.` },
    { scene: 'bucket', caption: `So record prefill too. The token count changes every batch, but chapter 11 already solved that: a ladder of sizes and pad up to the next rung. Same trick, a different axis — tokens instead of requests.` },
    { scene: 'bounds', caption: `Except padding fixes the <b>total</b>, not the <b>boundaries</b>. These two batches are both ${TOTAL} tokens, and attention has to do completely different work in each: every token attends only back to the start of its own sequence.` },
    { scene: 'tokenwise', caption: `So run both batches through a layer and compare. ${SAME} of the ${kernelRows.length} kernels do the identical thing, because all they ever see is a row count. Only attention changes — and only attention reads the boundaries.` },
    { scene: 'cut', caption: `So cut there. ${LAYERS} attentions means ${LAYERS} cuts and ${PIECES} pieces, roughly one layer each. Every piece is token-wise, so every piece can be recorded at a padded token count. Attention is left out.` },
    { scene: 'run', caption: `A step is now an alternation: replay a piece, run attention eagerly, replay the next piece. The CPU wakes up ${LAYERS} times instead of once — and stays asleep for the ${KERNELS - LAYERS * ATTN_LAUNCHES} kernels in between.` },
    { scene: 'arith', caption: `${fmt(launchMs)} of CPU becomes about ${fmt(pieceTotal)}: ${PIECES} replays plus the attention launches. That is ${Math.round(pieceTotal / 0.02)}× more CPU than one whole-model graph, and it does not matter. <b>You don't need one graph. You need the CPU under the GPU.</b>` },
    { scene: 'ladder', caption: `The rungs are token counts now, and the gap grows with the count: 4 apart at the bottom, 256 at the top. Every band holds it near a sixteenth of the batch, so what padding wastes is a share of the work rather than a fixed number of tokens.` },
    { scene: 'seams', caption: `Attention isn't the only seam. All-reduce waits on other GPUs (chapter ${CH_TP}); MoE dispatch sends a data-dependent number of tokens to each expert. The rule is the same: if its work depends on the data rather than the token count, cut there.` },
    { scene: 'tracer', caption: `Nobody writes ${PIECES} capture regions by hand. <b>torch.compile</b> traces the model into a graph of operations; you name the ops to split on, it cuts there and hands back the subgraphs. Each one gets the chapter 11 treatment.` },
    { scene: 'closing', caption: `The matmuls have to touch memory: that's where the weights are. The two in the middle touch it only because of how they were called — and the tracer handed them back untouched. Chapter ${CH_NEXT}.` },
  ];

  let step = $state(0);
  $effect(() => {
    const q = Number(new URLSearchParams(window.location.search).get('step'));
    if (q >= 1 && q <= steps.length) step = q - 1;
  });
  const cur = $derived(steps[step]);
  const W = 720, H = 400;

  // ---- scene data -----------------------------------------------------------------------------------
  // SGLang's default capture schedule for prefill: finer where a step is cheapest
  const SCHED = [
    { from: 4, to: 32, by: 4 }, { from: 48, to: 256, by: 16 }, { from: 288, to: 512, by: 32 },
    { from: 576, to: 1024, by: 64 }, { from: 1280, to: 4096, by: 256 },
  ];
  const rungs = SCHED.flatMap((s) => { const out: number[] = []; for (let v = s.from; v <= s.to; v += s.by) out.push(v); return out; });
  const padTo = (n: number) => rungs.find((r) => r >= n) ?? n;

  // the flat op list the tracer hands back, laid out on its own widths
  const tracedOps = (() => {
    const names = ['norm', 'qkv', 'rope', '*attn', 'o', 'add', 'norm', 'gate·up', 'silu', 'down', 'add', '*attn', '…'];
    let x = 40;
    return names.map((raw) => {
      const seam = raw.startsWith('*');
      const n = seam ? raw.slice(1) : raw;
      const o = { n, x, seam };
      x += n.length * 6.2 + (seam ? 38 : 18);   // seams need room for the scissors
      return o;
    });
  })();

  // roofline plot
  const PL = { x0: 92, x1: 664, y0: 300, y1: 78, nMax: 800, tMax: 12 };
  const px = (n: number) => PL.x0 + (n / PL.nMax) * (PL.x1 - PL.x0);
  const py = (ms: number) => PL.y0 - (ms / PL.tMax) * (PL.y0 - PL.y1);
  const gpuMs = (n: number) => Math.max(tMem, (n * US_PER_TOKEN) / 1000);
</script>

<figure class="viz">
  <div class="canvas">
    <svg viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Piecewise CUDA graphs, step {step + 1}">
      <defs>
        <marker id="pw-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#b8b4aa" />
        </marker>
        <marker id="pw-arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
        </marker>
      </defs>

      <!-- 1: chapter 11's two shapes, with the prefill verdict questioned -->
      {#if cur.scene === 'shapes'}
        <g transition:fade={{ duration: 250 }}>
          <rect x="24" y="64" width="330" height="200" rx="12" fill="#fbfaf7" stroke="var(--gen)" />
          <text x="40" y="86" class="boxtitle">a decode batch</text>
          {#each Array(5) as _, i}
            <text x="40" y={114 + i * 18} class="cell">req {i + 1}</text>
            <rect x="82" y={103 + i * 18} width="10" height="14" rx="2" fill="var(--gen)" opacity="0.85" in:fade={{ delay: i * 60 }} />
          {/each}
          <text x="40" y="214" class="slab small">shape [B, 1] · only B changes</text>
          <text x="40" y="240" class="tag">a rung per B · <tspan class="strong" fill="#16a34a">one graph for the whole step</tspan></text>

          <rect x="366" y="64" width="330" height="200" rx="12" fill="#fbfaf7" stroke="var(--accent)" />
          <text x="382" y="86" class="boxtitle">a prefill batch</text>
          {#each SEQ_A as n, i}
            <text x="382" y={116 + i * 26} class="cell">seq {i + 1}</text>
            {#each Array(n) as _, t}
              <rect x={424 + t * 9.5} y={105 + i * 26} width="8" height="14" rx="2" fill="var(--accent)" opacity="0.85" in:fade={{ delay: (i * 20 + t) * 10, duration: 100 }} />
            {/each}
          {/each}
          <text x="382" y="214" class="slab small">shape [Σ tokens, …] · ragged</text>
          <text x="382" y="240" class="tag">no two alike · <tspan class="strong" fill="var(--eos)">eager, kernel by kernel</tspan></text>

          <g in:fade={{ delay: 900 }}>
            <text x="24" y="306" class="legend">chapter 11 signed off on that with "prefill is compute-bound anyway, so the launches are hidden"</text>
            <text x="24" y="330" class="legend muted">which is true of a big prefill. It is not true of a small one.</text>
          </g>
        </g>
      {/if}

      <!-- 2: when prefill is launch-bound -->
      {#if cur.scene === 'bound'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="44" class="rowlabel">one prefill step · time against the number of tokens in it</text>
          <line x1={PL.x0} y1={PL.y0} x2={PL.x1} y2={PL.y0} stroke="var(--line)" />
          <line x1={PL.x0} y1={PL.y0} x2={PL.x0} y2={PL.y1} stroke="var(--line)" />
          {#each [0, 200, 400, 600, 800] as n}
            <text x={px(n)} y={PL.y0 + 16} text-anchor="middle" class="tag">{n}</text>
          {/each}
          <text x={(PL.x0 + PL.x1) / 2} y={PL.y0 + 34} text-anchor="middle" class="tag">tokens in the batch</text>
          {#each [0, 4, 8, 12] as ms}
            <text x={PL.x0 - 8} y={py(ms) + 3.5} text-anchor="end" class="tag">{ms} ms</text>
          {/each}

          <!-- the launch-bound region -->
          <g in:fade={{ delay: 900 }}>
            <rect x={PL.x0} y={PL.y1} width={px(LAUNCH_BOUND) - PL.x0} height={PL.y0 - PL.y1} fill="var(--eos)" opacity="0.06" />
            <line x1={px(LAUNCH_BOUND)} y1={PL.y0} x2={px(LAUNCH_BOUND)} y2={PL.y1} stroke="var(--eos)" stroke-dasharray="4 3" />
            <text x={px(LAUNCH_BOUND) / 2 + PL.x0 / 2} y={PL.y1 + 18} text-anchor="middle" class="tag strong" fill="var(--eos)">launch-bound</text>
            <text x="502" y="160" class="tag">the launches are hidden</text>
          </g>

          <!-- the two costs the GPU curve is the larger of -->
          <g in:fade={{ delay: 200 }}>
            <path d="M {px(0)} {py(tMem)} H {px(PL.nMax)}" fill="none" stroke="var(--gen)" stroke-width="1" stroke-dasharray="3 3" opacity="0.55" />
            <path d="M {px(0)} {py(0)} L {px(PL.nMax)} {py((PL.nMax * US_PER_TOKEN) / 1000)}" fill="none" stroke="var(--gen)" stroke-width="1" stroke-dasharray="3 3" opacity="0.55" />
          </g>
          <!-- CPU launch cost: flat, indifferent to how many tokens ride along -->
          <path d="M {px(0)} {py(launchMs)} H {px(PL.nMax)}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="6 3" in:fade={{ delay: 350 }} />
          <!-- GPU time: whichever of the two is larger -->
          <path d="M {px(0)} {py(tMem)} H {px(BALANCE)} L {px(PL.nMax)} {py(gpuMs(PL.nMax))}" fill="none" stroke="var(--gen)" stroke-width="2.5" in:fade={{ delay: 500 }} />
          <g in:fade={{ delay: 800 }}>
            <circle cx={px(BALANCE)} cy={py(tMem)} r="3.5" fill="var(--gen)" />
            <text x={px(BALANCE) - 10} y={py(tMem) - 10} text-anchor="end" class="tag"><tspan class="strong">{BALANCE}</tspan> · chapter 4's balance point</text>
            <text x={px(LAUNCH_BOUND)} y={PL.y0 + 16} text-anchor="middle" class="tag strong" fill="var(--eos)">{LAUNCH_BOUND}</text>
          </g>

          <!-- a real legend, so no label has to sit on the line it names -->
          <g in:fade={{ delay: 1100 }}>
            <rect x="500" y="220" width="152" height="64" rx="7" fill="white" stroke="var(--line)" />
            {#each [
              { l: 'GPU · the larger of these', c: 'var(--gen)', w: 2.5, d: '', diag: false },
              { l: 'the weight read · 4.8 ms', c: 'var(--gen)', w: 1, d: '3 3', diag: false },
              { l: 'compute · 16 µs a token', c: 'var(--gen)', w: 1, d: '3 3', diag: true },
              { l: 'the launches · 9.0 ms', c: 'var(--accent)', w: 2, d: '6 3', diag: false },
            ] as e, i}
              {@const y = 232 + i * 14}
              <path d={e.diag ? `M 508 ${y + 3} L 526 ${y - 3}` : `M 508 ${y} H 526`} fill="none" stroke={e.c} stroke-width={e.w} stroke-dasharray={e.d} opacity={e.w === 1 ? 0.7 : 1} />
              <text x="532" y={y + 3} class="legendkey">{e.l}</text>
            {/each}
          </g>

          <g in:fade={{ delay: 1400 }}>
            <text x="16" y="348" class="legend">below <tspan class="strong">{LAUNCH_BOUND} tokens</tspan> the step costs what the CPU takes to launch it — the same wall decode hit in chapter 11</text>
            <text x="16" y="370" class="legend muted">a short prompt, the tail chunk of a chunked prefill, a vision encoder: all of them live down there</text>
          </g>
        </g>
      {/if}

      <!-- 3: pad the token count to a rung -->
      {#if cur.scene === 'bucket'}
        {@const batches = [56, 131, 92]}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="44" class="rowlabel">three prefill batches in a row · the token count is different every time</text>
          {#each batches as n, i}
            {@const y = 76 + i * 74}
            {@const rung = padTo(n)}
            <g in:fade={{ delay: i * 500, duration: 250 }}>
              <text x="16" y={y + 20} class="rowlabel">batch {i + 1}</text>
              {#each Array(rung) as _, t}
                <rect x={90 + t * 3.9} y={y} width="2.9" height="26" rx="1"
                      fill={t < n ? 'var(--accent)' : 'white'} stroke={t < n ? 'none' : 'var(--line)'}
                      opacity={t < n ? 0.85 : 1} in:fade={{ delay: i * 500 + t * 3, duration: 80 }} />
              {/each}
              <text x={90 + (n * 3.9) / 2} y={y + 44} text-anchor="middle" class="tag"><tspan class="strong">{n}</tspan> real</text>
              <text x={90 + n * 3.9 + ((rung - n) * 3.9) / 2} y={y + 44} text-anchor="middle" class="tag">+{rung - n}</text>
              <text x={90 + rung * 3.9 + 12} y={y + 20} class="tag strong">→ the {rung} graph</text>
            </g>
          {/each}
          <g in:fade={{ delay: 1700 }}>
            <text x="16" y="330" class="legend">chapter 11's ladder was <tspan class="strong">requests</tspan>; this one is <tspan class="strong">tokens</tspan>. Pad up, replay the rung, drop the padding's output.</text>
            <text x="16" y="352" class="legend muted">so far so good — and this is not enough</text>
          </g>
        </g>
      {/if}

      <!-- 4: same total, different boundaries -->
      {#if cur.scene === 'bounds'}
        {@const C = 3.4}
        {@const MY = 104}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="44" class="rowlabel">two prefill batches · both {TOTAL} tokens · what attention has to compute in each</text>
          {#each [{ seq: SEQ_A, x: 108 }, { seq: SEQ_B, x: 448 }] as p, b}
            <g in:fade={{ delay: b * 650, duration: 300 }}>
              <text x={p.x} y="70" class="slab strong small">batch {b + 1} · {p.seq.join(' + ')}</text>
              <text x={p.x} y="86" class="tag">keys, in order →</text>
              <text x={p.x - 16} y={MY - 6} text-anchor="end" class="tag">queries</text>
              <text x={p.x - 16} y={MY + 6} text-anchor="end" class="tag">↓</text>

              {#each p.seq as n, i}
                {@const o = p.seq.slice(0, i).reduce((a, v) => a + v, 0)}
                <rect x={p.x + o * C} y={MY - 14} width={n * C - 1} height="8" rx="2" fill={SEQC[i]} opacity="0.85" />
                <rect x={p.x - 14} y={MY + o * C} width="8" height={n * C - 1} rx="2" fill={SEQC[i]} opacity="0.85" />
              {/each}

              <rect x={p.x} y={MY} width={TOTAL * C} height={TOTAL * C} fill="#f4f2ec" stroke="var(--line)" />
              {#each p.seq as n, i}
                {@const o = p.seq.slice(0, i).reduce((a, v) => a + v, 0)}
                <path d="M {p.x + o * C} {MY + o * C} L {p.x + o * C} {MY + (o + n) * C} L {p.x + (o + n) * C} {MY + (o + n) * C} Z"
                      fill={SEQC[i]} opacity="0.8" in:fade={{ delay: b * 650 + 300 + i * 220, duration: 350 }} />
              {/each}
              <text x={p.x + (TOTAL * C) / 2} y={MY + TOTAL * C + 20} text-anchor="middle" class="tag">{p.seq.length} triangles · <tspan class="strong">{p.seq.map((n) => `${n}×${n}`).join(' · ')}</tspan></text>
            </g>
          {/each}
          <g in:fade={{ delay: 1900 }}>
            <text x="16" y="348" class="legend">every token attends back only to the start of <tspan class="strong">its own</tspan> sequence, so the boundaries are part of the work</text>
            <text x="16" y="370" class="legend muted">padding gave both batches the same shape. It could not give them the same attention.</text>
          </g>
        </g>
      {/if}

      <!-- 5: everything but attention is token-wise -->
      {#if cur.scene === 'tokenwise'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="44" class="rowlabel">one layer, run on each of them · what actually changes between the two?</text>
          <text x="262" y="74" text-anchor="middle" class="slab strong small">batch 1 · {SEQ_A.join('+')}</text>
          <text x="470" y="74" text-anchor="middle" class="slab strong small">batch 2 · {SEQ_B.join('+')}</text>
          <text x="640" y="74" text-anchor="middle" class="tag">same?</text>
          <line x1="24" y1="82" x2="684" y2="82" stroke="var(--line)" />
          {#each kernelRows as r, i}
            {@const y = 102 + i * 20}
            <g in:fade={{ delay: i * 90, duration: 180 }}>
              {#if r.seam}<rect x="24" y={y - 14} width="660" height="20" rx="4" fill="var(--eos)" opacity="0.09" />{/if}
              <text x="34" y={y} class={r.seam ? 'mono strong' : 'mono'} fill={r.seam ? 'var(--eos)' : undefined}>{r.n}</text>
              <text x="262" y={y} text-anchor="middle" class={r.seam ? 'mono strong' : 'mono muted'} fill={r.seam ? 'var(--eos)' : undefined}>{r.a}</text>
              <text x="470" y={y} text-anchor="middle" class={r.seam ? 'mono strong' : 'mono muted'} fill={r.seam ? 'var(--eos)' : undefined}>{r.b ?? r.a}</text>
              <text x="640" y={y + 1} text-anchor="middle" class="verdict" fill={r.seam ? 'var(--eos)' : '#16a34a'}>{r.seam ? '✗' : '✓'}</text>
            </g>
          {/each}
          <g in:fade={{ delay: 1200 }}>
            <text x="16" y="352" class="legend"><tspan class="strong">{SAME} rows of {kernelRows.length} are identical</tspan>: same kernel, same shapes, same addresses — one recording replays for both batches</text>
            <text x="16" y="374" class="legend muted">the row that differs is the only one that has to know where the sequences start</text>
          </g>
        </g>
      {/if}

      <!-- 6: cut at every attention -->
      {#if cur.scene === 'cut'}
        {@const BX = 40}
        {@const BW2 = 640}
        {@const BY = 96}
        {@const BH = 44}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="44" class="rowlabel">one prefill step · {LAYERS} layers · cut at every attention</text>
          <rect x={BX} y={BY} width={BW2} height={BH} rx="4" fill="var(--accent)" opacity="0.8" />
          {#each Array(LAYERS) as _, l}
            {@const x = BX + ((l + 0.5) / LAYERS) * BW2}
            <rect x={x - 2} y={BY} width="4" height={BH} fill="var(--eos)" in:fade={{ delay: 120 + l * 10 }} />
            <line x1={x} y1={BY - 8} x2={x} y2={BY + BH + 8} stroke="var(--eos)" stroke-width="1" stroke-dasharray="2 2" in:fade={{ delay: 300 + l * 10 }} />
          {/each}
          <text x={BX} y={BY - 16} class="tag">embed</text>
          <text x={BX + BW2} y={BY - 16} text-anchor="end" class="tag">lm_head</text>
          <text x={BX + BW2 / 2} y={BY + BH + 30} text-anchor="middle" class="tag strong" fill="var(--eos)">{LAYERS} attentions · {LAYERS} cuts</text>

          <g in:fade={{ delay: 680 }}>
            <text x="16" y="190" class="rowlabel">what's left between the cuts</text>
            {#each Array(9) as _, i}
              {@const x = 40 + i * 72}
              <rect {x} y="204" width="62" height="34" rx="6" fill="white" stroke="var(--accent)" in:fly={{ y: -6, delay: 680 + i * 35, duration: 180 }} />
              <text x={x + 31} y="225" text-anchor="middle" class="cell">{i < 8 ? `piece ${i + 1}` : '…'}</text>
            {/each}
            <text x="40" y="262" class="tag"><tspan class="strong">{PIECES} pieces</tspan>, roughly one layer each · every one of them token-wise, so every one can be recorded at a padded token count</text>
          </g>
          <text x="16" y="322" class="legend" in:fade={{ delay: 1050 }}>{PIECES} recordings per rung instead of one — <tspan class="strong">that is the whole idea</tspan></text>
        </g>
      {/if}

      <!-- 7: the run-time alternation -->
      {#if cur.scene === 'run'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="44" class="rowlabel">one prefill step, replayed piecewise · time runs left to right</text>
          <text x="80" y="104" text-anchor="end" class="rowlabel">CPU</text>
          <text x="80" y="176" text-anchor="end" class="rowlabel">GPU</text>
          {#each Array(5) as _, i}
            {@const x = 92 + i * 118}
            <g in:fade={{ delay: i * 230, duration: 200 }}>
              <rect {x} y="86" width="18" height="24" rx="4" fill="var(--accent)" opacity="0.9" />
              <text x={x + 9} y="78" text-anchor="middle" class="tag" fill="var(--accent)">replay</text>
              <rect x={x} y="156" width="74" height="26" rx="4" fill="var(--gen)" opacity="0.85" />
              <text x={x + 37} y="174" text-anchor="middle" class="steplabel">piece {i + 1}</text>

              <rect x={x + 78} y="86" width="30" height="24" rx="4" fill="var(--eos)" opacity="0.85" />
              <text x={x + 93} y="78" text-anchor="middle" class="tag" fill="var(--eos)">eager</text>
              <rect x={x + 78} y="156" width="30" height="26" rx="4" fill="var(--eos)" opacity="0.6" />
              <text x={x + 93} y="174" text-anchor="middle" class="steplabel">attn</text>
            </g>
          {/each}
          <text x="682" y="104" text-anchor="end" class="tag">…</text>
          <text x="682" y="176" text-anchor="end" class="tag">…</text>

          <g in:fade={{ delay: 1250 }}>
            <path d="M 92 212 H 682" fill="none" stroke="var(--line)" />
            <text x="92" y="234" class="tag">the CPU is idle inside every orange block and busy only at the seams</text>
            <text x="16" y="284" class="legend">{PIECES} replays and {LAYERS} eager attentions: <tspan class="strong">{PIECES + LAYERS * ATTN_LAUNCHES} things for the CPU to do</tspan>, not {KERNELS.toLocaleString()}</text>
            <text x="16" y="306" class="legend muted">attention is still launched the old way, and it is the one kernel big enough not to care</text>
          </g>
        </g>
      {/if}

      <!-- 8: the arithmetic -->
      {#if cur.scene === 'arith'}
        {@const X = 150}
        {@const SC = 52}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="44" class="rowlabel">CPU time for one prefill step · the GPU needs {fmt(tMem)} of it at small token counts</text>
          {#each [
            { t: 'eager', ms: launchMs, c: 'var(--eos)', sub: `${KERNELS.toLocaleString()} launches × ${LAUNCH_US} µs` },
            { t: 'piecewise', ms: pieceTotal, c: '#16a34a', sub: `${PIECES} replays (${(pieceMs * 1000).toFixed(0)} µs) + ${LAYERS} eager attentions (${(attnMs * 1000).toFixed(0)} µs)` },
            { t: 'one whole-model graph', ms: 0.02, c: 'var(--faint)', sub: 'not available here: the shape changes every batch' },
          ] as row, i}
            {@const y = 90 + i * 68}
            <g in:fade={{ delay: i * 230, duration: 200 }}>
              <text x={X - 12} y={y + 18} text-anchor="end" class="rowlabel">{row.t}</text>
              <rect x={X} y={y} width={Math.max(3, row.ms * SC)} height="26" rx="4" fill={row.c} opacity="0.85" />
              <text x={X + Math.max(3, row.ms * SC) + 10} y={y + 18} class="tag strong">{row.ms < 0.1 ? '20 µs' : fmt(row.ms)}</text>
              <text x={X} y={y + 44} class="tag">{row.sub}</text>
            </g>
          {/each}
          <g in:fade={{ delay: 780 }}>
            <line x1={X + tMem * SC} y1="78" x2={X + tMem * SC} y2="300" stroke="var(--gen)" stroke-width="1.5" stroke-dasharray="4 3" />
            <text x={X + tMem * SC + 8} y="296" class="tag strong" fill="var(--gen)">the GPU's {fmt(tMem)}</text>
            <text x={X + tMem * SC - 8} y="296" text-anchor="end" class="tag" fill="#16a34a">anything left of this line is free</text>
          </g>
          <g in:fade={{ delay: 1080 }}>
            <text x="16" y="342" class="legend"><tspan class="strong">You don't need one graph. You need the CPU under the GPU.</tspan></text>
            <text x="16" y="364" class="legend muted">piecewise costs {Math.round(pieceTotal / 0.02)}× what a whole-model graph costs and buys the same thing, because both are under {fmt(tMem)}</text>
          </g>
        </g>
      {/if}

      <!-- 9: the rung schedule, as the gap between rungs -->
      {#if cur.scene === 'ladder'}
        {@const lx = (n: number) => 90 + (Math.log(n / 4) / Math.log(1024)) * 570}
        {@const ly = (v: number) => 270 - (Math.log(v / 4) / Math.log(128)) * 160}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="44" class="rowlabel">the gap between rungs, against the size of the batch · SGLang's default schedule</text>

          <line x1="90" y1="290" x2="660" y2="290" stroke="var(--line)" />
          {#each [4, 32, 256, 1024, 4096] as n}
            <line x1={lx(n)} y1="290" x2={lx(n)} y2="296" stroke="var(--faint)" />
            <text x={lx(n)} y="310" text-anchor="middle" class="tag">{n}</text>
          {/each}
          <text x="375" y="330" text-anchor="middle" class="tag">tokens in the batch</text>
          <line x1="90" y1="290" x2="90" y2="100" stroke="var(--line)" />
          {#each [4, 16, 64, 256] as v}
            <line x1="84" y1={ly(v)} x2="90" y2={ly(v)} stroke="var(--faint)" />
            <text x="78" y={ly(v) + 3.5} text-anchor="end" class="tag">{v}</text>
          {/each}
          <text x="44" y="98" class="tag">gap</text>

          {#each SCHED as b, i}
            <g in:fade={{ delay: i * 320, duration: 250 }}>
              {#if i > 0}
                <line x1={lx(b.from)} y1={ly(SCHED[i - 1].by)} x2={lx(b.from)} y2={ly(b.by)} stroke="var(--accent)" stroke-width="1" stroke-dasharray="3 2" opacity="0.5" />
              {/if}
              <line x1={lx(b.from)} y1={ly(b.by)} x2={lx(b.to)} y2={ly(b.by)} stroke="var(--accent)" stroke-width="3" />
              {#each Array(Math.round((b.to - b.from) / b.by) + 1) as _, k}
                <line x1={lx(b.from + k * b.by)} y1={ly(b.by) - 4} x2={lx(b.from + k * b.by)} y2={ly(b.by) + 4} stroke="var(--accent)" stroke-width="1" opacity="0.7" />
              {/each}
              <text x={(lx(b.from) + lx(b.to)) / 2} y={ly(b.by) - 22} text-anchor="middle" class="tag strong">every {b.by}</text>
              <text x={(lx(b.from) + lx(b.to)) / 2} y={ly(b.by) - 10} text-anchor="middle" class="tag">{b.from}–{b.to}</text>
            </g>
          {/each}

          <g in:fade={{ delay: 1500 }}>
            <text x="16" y="358" class="legend">above 32 tokens the gap stays under <tspan class="strong">a sixteenth of the batch</tspan></text>
            <text x="16" y="380" class="legend muted">so padding costs a fixed share of the work, never a fixed number of tokens</text>
            <text x="112" y="150" class="tag strong">{rungs.length} rungs in all</text>
            <text x="112" y="166" class="tag">{PIECES} recordings each</text>
            <text x="112" y="182" class="tag">built once at startup</text>
          </g>
        </g>
      {/if}

      <!-- 10: the other seams -->
      {#if cur.scene === 'seams'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="48" class="rowlabel">what gets cut out · and the one question behind all of it</text>
          {#each [
            { t: 'attention', s: 'needs the sequence boundaries, which change every batch', c: 'var(--eos)' },
            { t: 'all-reduce', s: `waits on the other GPUs in the group · chapter ${CH_TP}`, c: '#0891b2' },
            { t: 'MoE dispatch', s: 'how many tokens go to each expert is decided by the tokens', c: 'var(--gen)' },
          ] as row, i}
            {@const y = 68 + i * 46}
            <g in:fly={{ x: -8, delay: i * 150, duration: 250 }}>
              <rect x="30" y={y} width="660" height="36" rx="8" fill="#fbfaf7" stroke={row.c} />
              <text x="48" y={y + 23} class="slab strong small">{row.t}</text>
              <text x="230" y={y + 23} class="tag">{row.s}</text>
            </g>
          {/each}

          <g in:fade={{ delay: 550, duration: 300 }}>
            <rect x="150" y="228" width="420" height="34" rx="17" fill="var(--accent-soft)" stroke="var(--accent)" />
            <text x="360" y="250" text-anchor="middle" class="slab small">does its work depend on the <tspan class="strong">data</tspan>, or only on the <tspan class="strong">token count</tspan>?</text>
          </g>
          <g in:fade={{ delay: 800, duration: 300 }}>
            <path d="M 260 264 L 190 292" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#pw-arrow)" />
            <path d="M 460 264 L 530 292" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#pw-arrow)" />

            <rect x="60" y="296" width="250" height="56" rx="10" fill="#fbfaf7" stroke="#16a34a" />
            <text x="185" y="318" text-anchor="middle" class="slab strong small" fill="#16a34a">only the token count</text>
            <text x="185" y="338" text-anchor="middle" class="tag">pad it, record it, put it in a piece</text>

            <rect x="410" y="296" width="250" height="56" rx="10" fill="#fbfaf7" stroke="var(--eos)" />
            <text x="535" y="318" text-anchor="middle" class="slab strong small" fill="var(--eos)">the data</text>
            <text x="535" y="338" text-anchor="middle" class="tag">leave it out; it becomes a seam</text>
          </g>
          <text x="16" y="378" class="legend muted" in:fade={{ delay: 1150 }}>the seam list is configuration, not a law: an engine names the ops it wants to cut at</text>
        </g>
      {/if}

      <!-- 11: who finds the seams -->
      {#if cur.scene === 'tracer'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="44" class="rowlabel">how {PIECES} capture regions get found without anyone writing them down</text>
          {#each [
            { t: '1 · the model', l: ['a Python class,', 'a forward() that', 'calls other modules'], c: 'var(--muted)' },
            { t: '2 · trace it', l: ['run it once with', 'Dynamo watching;', 'record every op'], c: 'var(--accent)' },
            { t: '3 · cut', l: ['at the named ops:', 'attention, all-reduce,', 'MoE dispatch'], c: 'var(--eos)' },
            { t: '4 · capture', l: [`${PIECES} subgraphs,`, 'each recorded per', 'rung — chapter 11'], c: '#16a34a' },
          ] as b, i}
            {@const x = 22 + i * 172}
            <g in:fly={{ y: 8, delay: i * 320, duration: 300 }}>
              <rect {x} y="76" width="152" height="112" rx="12" fill="#fbfaf7" stroke={b.c} />
              <text x={x + 14} y="100" class="slab strong small">{b.t}</text>
              {#each b.l as line, k}<text x={x + 14} y={124 + k * 17} class="tag">{line}</text>{/each}
            </g>
            {#if i < 3}
              <path d="M {x + 156} 132 H {x + 170}" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#pw-arrow)" in:fade={{ delay: i * 320 + 250 }} />
            {/if}
          {/each}
          <g in:fade={{ delay: 1400 }}>
            <text x="22" y="226" class="rowlabel">what the tracer hands back</text>
            <rect x="22" y="238" width="668" height="46" rx="8" fill="white" stroke="var(--line)" />
            {#each tracedOps as op, i}
              {#if op.seam}
                <text x={op.x} y="270" class="scissors" fill="var(--eos)" in:fade={{ delay: 1400 + i * 60 }}>✂</text>
                <text x={op.x + 20} y="266" class="mono strong" fill="var(--eos)" in:fade={{ delay: 1400 + i * 60 }}>{op.n}</text>
              {:else}
                <text x={op.x} y="266" class="mono muted" in:fade={{ delay: 1400 + i * 60 }}>{op.n}</text>
              {/if}
            {/each}
            <text x="22" y="322" class="legend">a flat list of operations, in order, with the seams marked — <tspan class="strong">the graph was always there; nobody had written it down</tspan></text>
            <text x="22" y="344" class="legend muted">SGLang wraps the model in <tspan class="mono">torch.compile</tspan> for exactly this, then replaces each subgraph with a replayable piece</text>
          </g>
        </g>
      {/if}

      <!-- 12: the tracer has a second half -->
      {#if cur.scene === 'closing'}
        {@const chain = [{ n: 'gate·up', mm: true }, { n: 'silu', mm: false }, { n: 'mul', mm: false }, { n: 'down', mm: true }]}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="36" class="rowlabel">one piece, up close · the token-wise chain the tracer handed back unchanged</text>

          <!-- the CPU's whole involvement, for scale -->
          <rect x="16" y="94" width="68" height="52" rx="8" fill="white" stroke="var(--faint)" stroke-dasharray="3 3" />
          <text x="50" y="116" text-anchor="middle" class="boxtitle">CPU</text>
          <text x="50" y="134" text-anchor="middle" class="tag">asleep</text>
          <path d="M 88 120 H 104" fill="none" stroke="var(--faint)" stroke-width="1.2" marker-end="url(#pw-arrow)" />

          <rect x="108" y="48" width="584" height="214" rx="12" fill="#fbfaf7" stroke="var(--gen)" />
          <text x="122" y="68" class="boxtitle">GPU</text>
          <text x="404" y="72" text-anchor="middle" class="tag">the arithmetic happens up here, in registers on the SM</text>

          {#each chain as k, i}
            {@const cx = 175 + i * 150}
            <g in:fade={{ delay: i * 200, duration: 220 }}>
              <path d="M {cx - 30} 222 V 132" fill="none" stroke="var(--accent)" stroke-width="1.5" marker-end="url(#pw-arrow-hot)" />
              <rect x={cx - 55} y="84" width="110" height="42" rx="8" fill={k.mm ? 'var(--fg)' : 'var(--accent)'} opacity={k.mm ? 0.75 : 0.9} />
              <text x={cx} y="110" text-anchor="middle" class="kname">{k.n}</text>
              <path d="M {cx + 30} 132 V 218" fill="none" stroke="var(--accent)" stroke-width="1.5" marker-end="url(#pw-arrow-hot)" />
              {#if i === 0}
                <text x={cx - 36} y="176" text-anchor="end" class="tag">read</text>
                <text x={cx + 36} y="176" class="tag">write</text>
              {/if}
            </g>
          {/each}

          <g in:fade={{ delay: 1000 }}>
            <rect x="262" y="78" width="276" height="54" rx="10" fill="none" stroke="var(--eos)" stroke-dasharray="4 3" />
          </g>
          <rect x="120" y="222" width="560" height="32" rx="8" fill="#f4f2ec" stroke="var(--line)" />
          <text x="136" y="242" class="boxtitle">HBM</text>
          <text x="184" y="242" class="tag">the GPU's own 80 GB — the weights and the KV cache are in here too</text>

          <g in:fade={{ delay: 900 }}>
            <text x="16" y="290" class="legend"><tspan class="strong">{chain.length} kernels, {chain.length * 2} trips</tspan> — and every arrow is inside the GPU. The CPU sent one replay and went back to sleep.</text>
            <text x="16" y="312" class="legend muted">a kernel's registers are gone the moment it ends, so whatever the next one needs has to go out to memory and come back</text>
            <text x="16" y="334" class="legend muted">×{LAYERS} layers, and again for every token in the batch</text>
          </g>
          <text x="16" y="374" class="legend" in:fade={{ delay: 1400 }}>Nothing but <tspan class="mono strong">mul</tspan> ever reads what <tspan class="mono strong">silu</tspan> wrote, and it wants it immediately. <tspan class="strong">So why are they two kernels?</tspan></text>
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
  .cell { font-family: var(--mono); font-size: 10px; fill: var(--fg); }
  .mono { font-family: var(--mono); font-size: 10px; fill: var(--fg); }
  .mono.muted { fill: var(--muted); }
  .mono.strong { font-weight: 600; }
  .tag { font-size: 10px; fill: var(--muted); }
  .legendkey { font-size: 8.5px; fill: var(--muted); }
  .scissors { font-size: 17px; }
  .tag.strong, .tag .strong, .mono .strong { fill: var(--fg); font-weight: 600; }
  .steplabel { font-size: 10px; fill: white; font-weight: 600; }
  .boxtitle { font-family: var(--mono); font-size: 10.5px; fill: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .slab { font-size: 12px; fill: var(--fg); }
  .slab.small { font-size: 11.5px; }
  .slab.strong.small { font-size: 12px; font-weight: 650; }
  .verdict { font-size: 15px; font-weight: 700; }
  .kname { font-family: var(--mono); font-size: 10px; fill: white; font-weight: 600; }
  .legend { font-size: 11.5px; fill: var(--fg); }
  .legend .strong { font-weight: 650; }
  .legend.muted { fill: var(--muted); }
</style>
