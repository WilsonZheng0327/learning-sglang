<script lang="ts">
  import { fade, fly } from 'svelte/transition';
  import StepControls from './StepControls.svelte';
  import katex from 'katex';
  const tex = (src: string) => katex.renderToString(src, { throwOnError: false });
  import { chapters, type NavLink } from '../chapters';
  let { prev, next }: { prev?: NavLink; next?: NavLink } = $props();
  const chNum = (slug: string) => chapters.findIndex((c) => c.slug === slug) + 1;
  const CH_NEXT = chNum('15-speculative-decoding');

  // ---- Numbers: Llama-3-8B bf16 on one H100, continuing chapters 3, 4, 11 and 13 --------------------------
  const HEADS = 32, KV_HEADS = 8, HD = 128, LAYERS = 32, BYTES = 2;
  const W_GB = 16, BW = 3.35, TFLOPS = 989, SMS = 132;
  const tMem = W_GB / BW;                                   // 4.8 ms, the weight read
  const kvPerTokLayer = KV_HEADS * HD * 2 * BYTES;          // 4 KB: k and v for one token in one layer
  const kvPerTok = kvPerTokLayer * LAYERS;                  // 128 KB across the model, chapter 3
  const B_EX = 256;                                         // chapter 13's batch
  const kvGB = (ctx: number, b = B_EX) => (b * ctx * kvPerTok) / 1e9;
  const CTXS = [256, 512, 1024, 2048, 4096];
  const crossTok = Math.round((W_GB * 1e9) / (B_EX * kvPerTok) / 10) * 10;   // where the cache read passes the weights
  const balance = Math.round(TFLOPS / BW);                  // 295 flop per byte, chapter 4
  const GROUP = HEADS / KV_HEADS;                           // 4 query heads per k/v head
  const N_PROMPT = 2000;
  const kvHeadMB = (N_PROMPT * HD * BYTES) / 1e6;           // K (or V) for one head at prefill: 0.5 MB
  const sMB = (N_PROMPT * N_PROMPT * BYTES) / 1e6;          // the score matrix S for one head: 8 MB
  const beforeMB = 2 * kvHeadMB + 4 * sMB;                  // K, V, and S and P written then read back
  const afterMB = 2 * kvHeadMB;                             // K and V, once
  const CHUNKS = 4;
  const qkvMB = (N_PROMPT * HD * BYTES) / 1e6;              // Q, K or V for one head: 0.512 MB
  const k1MB = 2 * qkvMB + sMB;                             // read Q and K, write S
  const k2MB = 2 * sMB;                                     // read S, write P
  const k3MB = sMB + 2 * qkvMB;                             // read P and V, write out
  const headMB = k1MB + k2MB + k3MB;
  const promptGB = (headMB * HEADS * LAYERS) / 1e3;         // every head of every layer, one prompt
  const CTX_DEC = 8192;
  const SPLITS = 16;
  const fmtGB = (gb: number) => (gb < 10 ? gb.toFixed(1) : gb.toFixed(0)) + ' GB';
  const fmtMs = (ms: number) => (ms < 1 ? ms.toFixed(2) : ms < 10 ? ms.toFixed(1) : ms.toFixed(0)) + ' ms';
  const fmtK = (n: number) => (n >= 1024 ? `${n / 1024}k` : String(n));

  // the paged batch of the plan step: page size 1, as SGLang keeps it
  const reqA = { n: 'A', pages: [3, 9, 1, 7, 2], c: 'var(--accent)' };
  const reqB = { n: 'B', pages: [4, 8, 6], c: '#16a34a' };
  const POOL = 10;
  const indptr = [0, reqA.pages.length, reqA.pages.length + reqB.pages.length];
  const indices = [...reqA.pages, ...reqB.pages];

  // SGLang's backends, from docs.sglang.io/advanced_features/attention_backend · columns follow the axes of the map step
  const mha = [
    { n: 'fa3', from: 'FlashAttention-3', gpu: 'Hopper', heads: 'MHA · GQA · MLA', page: 'any', def: 'H100, H200' },
    { n: 'flashinfer', from: 'FlashInfer, JIT', gpu: 'any NVIDIA', heads: 'MHA · GQA · MLA', page: 'any', def: 'A100 and other NVIDIA' },
    { n: 'trtllm_mha', from: 'TensorRT-LLM', gpu: 'Blackwell', heads: 'MHA · GQA', page: '16 · 32 · 64', def: 'B200' },
    { n: 'triton', from: 'Triton, one source', gpu: 'any, AMD too', heads: 'MHA · GQA · MLA', page: 'any', def: 'when nothing else fits' },
    { n: 'torch_native', from: 'PyTorch SDPA', gpu: 'any', heads: 'MHA · GQA', page: '1', def: 'by hand only' },
  ];
  const mlaOnly = [{ n: 'flashmla', page: '64' }, { n: 'cutlass_mla', page: '128' }, { n: 'trtllm_mla', page: '32 · 64 · Blackwell default' }];

  type Scene = 'bytes' | 'traffic' | 'bill' | 'flash' | 'map' | 'shapes' | 'pages' | 'heads' | 'hardware' | 'interface' | 'backends' | 'closing';
  interface Step { caption: string; scene: Scene }
  const steps: Step[] = [
    { scene: 'bytes', caption: `Chapters 11 to 13 touched everything in a layer but attention. Attention reads every request's whole cache: batch × context × ${kvPerTok / 1024} KB per step. At batch ${B_EX} that passes the ${W_GB} GB of weights at about ${crossTok} tokens of context.` },
    { scene: 'traffic', caption: `Written as three kernels: <b>S</b> = Q·Kᵀ scores every token against every token, <b>P</b> = softmax(S) turns each row into weights, out = P·V. Every entry of P needs the whole row of S it sits in, so S must be complete before P can start.` },
    { scene: 'bill', caption: `At ${N_PROMPT.toLocaleString()} tokens in bf16, Q, K and V are ${qkvMB.toFixed(1)} MB each per head and S and P ${sMB.toFixed(0)} MB each. The three kernels move ${headMB.toFixed(0)} MB per head, ${promptGB.toFixed(0)} GB per prompt over ${HEADS} heads and ${LAYERS} layers: ${fmtMs(promptGB / BW)} at ${BW} TB/s, for two intermediates nobody keeps.` },
    { scene: 'flash', caption: `Fuse the three kernels and carry each row's max, sum and output as running values, updated one chunk of K and V at a time: S and P never exist. FlashAttention, 2022. ${headMB.toFixed(0)} MB per head becomes ${(4 * qkvMB).toFixed(0)} MB.` },
    { scene: 'map', caption: `The loop is fixed. Four things change how it must be written: many queries or one, where K and V sit in memory, how the model lays out its heads, and which GPU runs it. A backend is one implementation of one combination.` },
    { scene: 'shapes', caption: `Prefill: n queries per key, so a tile of queries reuses every K/V byte it loads. Decode: one query, so each byte is used once, and at small batch there are too few blocks, so the decode kernel splits the context across the SMs.` },
    { scene: 'pages', caption: `K and V are not one tensor: each request has its own length and pages (chapter 7). The kernel gets two arrays, the page numbers and where each request's slice starts, rebuilt on the CPU every batch: the plan chapter 12 cut around.` },
    { scene: 'heads', caption: `Llama-3's ${HEADS} query heads share ${KV_HEADS} K/V heads, so the loop runs ${GROUP} queries per K/V block. DeepSeek's MLA keeps one 576-wide vector per token for all heads, shapes no MHA kernel has. The model's head layout picks the kernel family.` },
    { scene: 'hardware', caption: `The same loop, rewritten per GPU. FlashAttention-3 uses Hopper's copy engine and two alternating warp groups so loads, softmax and matmuls overlap. Blackwell gets TensorRT-LLM's kernels; Triton compiles one source for anything.` },
    { scene: 'interface', caption: `One interface per backend: a plan per batch, a prefill kernel, a decode kernel, and fixed buffers the plan is copied into so chapter 11's graph can replay decode attention. The model only ever calls <code>forward</code>.` },
    { scene: 'backends', caption: `Five MHA backends and an MLA family, each one implementation of the loop for one GPU, head layout and page size. SGLang picks by GPU and model: fa3 on Hopper, flashinfer elsewhere, TensorRT-LLM's on Blackwell.` },
    { scene: 'closing', caption: `Batch-1 decode, ${fmtK(CTX_DEC)} context: attention went from ${KV_HEADS} blocks pulling ${fmtGB(kvGB(CTX_DEC, 1))} at ${KV_HEADS}/${SMS} of the bandwidth to ${KV_HEADS * SPLITS} blocks at full speed. The step is ${fmtMs(tMem + kvGB(CTX_DEC, 1) / BW + 0.016)} for one token, 0.016 ms of it math. Five tokens would cost the same read. Chapter ${CH_NEXT}.` },
  ];

  let step = $state(0);
  $effect(() => {
    const q = Number(new URLSearchParams(window.location.search).get('step'));
    if (q >= 1 && q <= steps.length) step = q - 1;
  });
  const cur = $derived(steps[step]);
  const W = 720, H = 400;

  // within-step phases: the online-softmax step reveals one block at a time
  let phase = $state(0);
  $effect(() => {
    const s = step;
    phase = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (steps[s].scene === 'flash') {
      // chunk 1, 2, 3, 4, then the finished state, then back to the start; slow enough to follow, and it repeats
      const cycle: [number, number][] = [[1, 1400], [2, 1400], [3, 1400], [4, 1400], [5, 1400], [0, 2600]];
      let i = 0;
      const tick = () => { const [ph, wait] = cycle[i]; timers.push(setTimeout(() => { phase = ph; i = (i + 1) % cycle.length; tick(); }, wait)); };
      tick();
    }
    return () => timers.forEach(clearTimeout);
  });

  const RED = 'var(--eos)', GREEN = '#16a34a';
</script>

<figure class="viz">
  <div class="canvas">
    <svg viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Attention backends, step {step + 1}">
      <defs>
        <marker id="ab-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#b8b4aa" />
        </marker>
        <marker id="ab-arrow-red" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--eos)" />
        </marker>
        <marker id="ab-arrow-green" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#16a34a" />
        </marker>
      </defs>

      <!-- 1: what attention reads -->
      {#if cur.scene === 'bytes'}
        {@const X0 = 110}
        {@const GW = 108}
        {@const BASE = 290}
        {@const maxGB = kvGB(CTXS[CTXS.length - 1])}
        {@const px = 200 / maxGB}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">one decode step at batch {B_EX} · bytes read, by context · cache read = batch × context × {kvPerTok / 1024} KB</text>
          <line x1={X0 - 20} y1={BASE} x2={X0 + CTXS.length * GW} y2={BASE} stroke="var(--line)" />
          {#each CTXS as ctx, i}
            {@const gx = X0 + i * GW}
            {@const kv = kvGB(ctx)}
            <g in:fade={{ delay: 200 + i * 220, duration: 250 }}>
              <rect x={gx} y={BASE - W_GB * px} width="36" height={W_GB * px} rx="3" fill="var(--gen)" opacity="0.85" />
              <text x={gx + 18} y={BASE - W_GB * px - 6} text-anchor="middle" class="tag">{W_GB} GB</text>
              <rect x={gx + 44} y={BASE - kv * px} width="36" height={kv * px} rx="3" fill={RED} opacity="0.85" />
              <text x={gx + 62} y={Math.min(BASE - kv * px, BASE - W_GB * px) - 6} text-anchor="middle" class="tag strong">{fmtGB(kv)}</text>
              <text x={gx + 40} y={BASE + 18} text-anchor="middle" class="mono">{fmtK(ctx)} tokens</text>
              <text x={gx + 40} y={BASE + 32} text-anchor="middle" class="tag">{fmtMs(kv / BW)} of reading</text>
            </g>
          {/each}
          <g in:fade={{ delay: 1400 }}>
            <line x1={X0 - 20} y1={BASE - W_GB * px} x2={X0 + CTXS.length * GW} y2={BASE - W_GB * px} stroke="var(--gen)" stroke-dasharray="4 3" />
            <text x={X0 - 26} y={BASE - W_GB * px + 4} text-anchor="end" class="tag" fill="var(--gen)">{fmtMs(tMem)}</text>
            <rect x="24" y="66" width="12" height="12" rx="3" fill="var(--gen)" opacity="0.85" /><text x="42" y="76" class="tag">the weights, {W_GB} GB whatever the context</text>
            <rect x="24" y="86" width="12" height="12" rx="3" fill={RED} opacity="0.85" /><text x="42" y="96" class="tag">the KV cache, read inside the attention kernel</text>
          </g>
        </g>
      {/if}

      <!-- 2 and 3: attention written the obvious way · what moves, then what it costs -->
      {#if cur.scene === 'traffic' || cur.scene === 'bill'}
        {@const N = 6}
        {@const CELL = 12}
        {@const ROW = 3}
        {@const KY = 64}
        {@const KH = 34}
        {@const LANE = 120}
        {@const HY = 148}
        {@const HH = 146}
        {@const GY = HY + 30}
        {@const bill = cur.scene === 'bill'}
        {@const items = [
          { n: 'Q', x: 70, w: 20, grid: false, mb: qkvMB, shape: `n × ${HD}`, hot: 'row' },
          { n: 'K', x: 142, w: 20, grid: false, mb: qkvMB, shape: `n × ${HD}`, hot: 'all' },
          { n: 'S', x: 214, w: N * CELL, grid: true, mb: sMB, shape: 'n × n', hot: 'row' },
          { n: 'P', x: 346, w: N * CELL, grid: true, mb: sMB, shape: 'n × n', hot: 'row' },
          { n: 'V', x: 480, w: 20, grid: false, mb: qkvMB, shape: `n × ${HD}`, hot: 'all' },
          { n: 'out', x: 600, w: 20, grid: false, mb: qkvMB, shape: `n × ${HD}`, hot: 'row' },
        ]}
        {@const kernels = [
          { n: 'S = Q · Kᵀ', cx: 116, mm: true, ins: [80, 152], out: 236 },
          { n: 'P = softmax(S)', cx: 250, mm: false, ins: [264], out: 368 },
          { n: 'out = P · V', cx: 443, mm: true, ins: [396, 490], out: 610 },
        ]}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">one head · a prefill of n tokens, drawn with n = {N} · red: what token i's output touches</text>

          <!-- three kernels: inputs come up from HBM into the bottom, the output leaves the right side and drops into HBM -->
          {#each kernels as k, i}
            <g in:fade={{ delay: 100 + i * 250, duration: 200 }}>
              <rect x={k.cx - 54} y={KY} width="108" height={KH} rx="8" fill={k.mm ? 'var(--fg)' : 'var(--accent)'} opacity={k.mm ? 0.75 : 0.9} />
              <text x={k.cx} y={KY + 22} text-anchor="middle" class="kname">{k.n}</text>
              {#each k.ins as x}
                <path d="M {x} {HY - 4} V {KY + KH + 4}" fill="none" stroke={RED} stroke-width="1.5" marker-end="url(#ab-arrow-red)" />
              {/each}
              <path d="M {k.cx + 54} {KY + KH / 2} H {k.cx + 68} V {LANE} H {k.out} V {HY - 4}" fill="none" stroke={i === 2 ? GREEN : RED} stroke-width="1.5" marker-end={i === 2 ? 'url(#ab-arrow-green)' : 'url(#ab-arrow-red)'} />
            </g>
          {/each}
          <text x="690" y={KY + KH / 2 + 4} text-anchor="end" class="tag">reads ↑ · writes ↓</text>

          <!-- HBM, holding everything -->
          <rect x="30" y={HY} width="660" height={HH} rx="10" fill="#f4f2ec" stroke="var(--line)" />
          <text x="42" y={HY + 17} class="boxtitle">HBM</text>
          {#each items as it, i}
            <g in:fade={{ delay: 100 + i * 120, duration: 200 }}>
              {#if it.grid}
                {#each Array(N) as _, r}
                  {#each Array(N) as _, c}
                    <rect x={it.x + c * CELL} y={GY + r * CELL} width={CELL - 1} height={CELL - 1} fill={r === ROW ? RED : '#d9d5cb'} opacity={r === ROW ? 0.85 : 1} />
                  {/each}
                {/each}
                {#if it.n === 'P'}
                  <rect x={it.x + 4 * CELL - 1} y={GY + ROW * CELL - 1} width={CELL + 1} height={CELL + 1} fill="none" stroke="var(--fg)" stroke-width="1.5" />
                  <text x={it.x + N * CELL + 8} y={GY + ROW * CELL + 9} class="tag strong">Pᵢⱼ</text>
                {/if}
                {#if it.n === 'S'}
                  <text x={it.x - 6} y={GY + ROW * CELL + 9} text-anchor="end" class="tag strong">row i</text>
                {/if}
              {:else}
                <rect x={it.x} y={GY} width={it.w} height={N * CELL - 1} rx="3" fill={it.hot === 'all' ? RED : '#d9d5cb'} opacity={it.hot === 'all' ? 0.85 : 1} />
                {#if it.hot === 'row'}<rect x={it.x} y={GY + ROW * CELL} width={it.w} height={CELL - 1} fill={RED} opacity="0.85" />{/if}
                {#if it.n === 'Q'}<text x={it.x - 6} y={GY + ROW * CELL + 9} text-anchor="end" class="tag strong">qᵢ</text>{/if}
              {/if}
              <text x={it.x + it.w / 2} y={GY + N * CELL + 15} text-anchor="middle" class="tag strong">{it.n} · {it.shape}</text>
              {#if bill}
                <text x={it.x + it.w / 2} y={GY + N * CELL + 29} text-anchor="middle" class="tag" in:fade={{ delay: 300 + i * 120 }}>{it.mb < 1 ? it.mb.toFixed(1) : it.mb.toFixed(0)} MB</text>
              {/if}
            </g>
          {/each}

          {#if !bill}
            <!-- what the letters mean, typeset -->
            <g in:fade={{ delay: 900 }}>
              {#each [
                { y: 302, h: 26, m: 'S_{ij} = q_i \\cdot k_j', t: ['the score of token i on token j · row i belongs to token i, the query'], ty: 318 },
                { y: 328, h: 46, m: 'P_{ij} = \\dfrac{e^{\\,S_{ij} - m_i}}{\\sum_k e^{\\,S_{ik} - m_i}}, \\qquad m_i = \\max_k S_{ik}', t: ['every entry of row i needs the whole row: its max and its sum', 'subtracting the max keeps e^(…) from overflowing; it cancels in the ratio'], ty: 346 },
                { y: 376, h: 26, m: '\\mathrm{out}_i = \\sum_j P_{ij}\\, v_j', t: ['row i of P weighs every v · one output row per token'], ty: 392 },
              ] as d}
                <foreignObject x="30" y={d.y} width="330" height={d.h}>
                  <div xmlns="http://www.w3.org/1999/xhtml" class="math">{@html tex(d.m)}</div>
                </foreignObject>
                {#each d.t as line, k}<text x="372" y={d.ty + k * 14} class="tag">{line}</text>{/each}
              {/each}
            </g>
          {:else}
            <!-- the bill -->
            <g in:fade={{ delay: 800 }}>
              <text x="30" y="318" class="legend">at n = {N_PROMPT.toLocaleString()}, bf16: Q, K, V, out are {N_PROMPT.toLocaleString()} × {HD} × 2 B = <tspan class="strong">{qkvMB.toFixed(1)} MB</tspan> each · S and P are {N_PROMPT.toLocaleString()}² × 2 B = <tspan class="strong">{sMB.toFixed(0)} MB</tspan> each</text>
              <text x="30" y="340" class="legend">kernel 1 reads Q and K, writes S: {k1MB.toFixed(0)} MB · kernel 2 reads S, writes P: {k2MB.toFixed(0)} MB · kernel 3 reads P and V, writes out: {k3MB.toFixed(0)} MB</text>
            </g>
            <g in:fade={{ delay: 1400 }}>
              <text x="30" y="364" class="legend"><tspan class="strong">{headMB.toFixed(0)} MB per head</tspan> · × {HEADS} heads × {LAYERS} layers = <tspan class="strong">{promptGB.toFixed(0)} GB</tspan> for one {N_PROMPT.toLocaleString()}-token prompt · {fmtMs(promptGB / BW)} at {BW} TB/s</text>
              <text x="30" y="386" class="legend muted">{(2 * sMB * 2).toFixed(0)} of the {headMB.toFixed(0)} MB are S and P: written once, read once, then never needed again</text>
            </g>
          {/if}
        </g>
      {/if}

      <!-- 4: FlashAttention · step 3's picture, with S and P gone -->
      {#if cur.scene === 'flash'}
        {@const N = 6}
        {@const CELL = 12}
        {@const ROW = 3}
        {@const KY = 64}
        {@const KH = 46}
        {@const LANE = 126}
        {@const HY = 148}
        {@const HH = 162}
        {@const GY = HY + 30}
        {@const BAND = (N * CELL - 1) / CHUNKS}
        {@const KX = 142}
        {@const VX = 480}
        {@const CX = 310}
        {@const active = Math.min(phase, CHUNKS)}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">the same head, the same prefill · one kernel · K and V in {CHUNKS} chunks · S and P never written</text>

          <!-- one kernel -->
          <rect x="60" y={KY} width="500" height={KH} rx="8" fill={GREEN} opacity="0.9" />
          <text x={CX} y={KY + 19} text-anchor="middle" class="kname">attention · fused · online softmax</text>
          <text x={CX} y={KY + 36} text-anchor="middle" class="tag onbox">carried per row i: mᵢ (max) · ℓᵢ (sum) · outᵢ, so far</text>
          <path d="M 80 {HY - 4} V {KY + KH + 4}" fill="none" stroke={RED} stroke-width="1.5" marker-end="url(#ab-arrow-red)" />
          {#if active >= 1}
            <path d="M {KX + 10} {HY - 4} V {KY + KH + 4}" fill="none" stroke={RED} stroke-width="1.5" marker-end="url(#ab-arrow-red)" />
            <path d="M {VX + 10} {HY - 4} V {KY + KH + 4}" fill="none" stroke={RED} stroke-width="1.5" marker-end="url(#ab-arrow-red)" />
          {/if}
          <path d="M 560 {KY + KH / 2} H 574 V {LANE} H 610 V {HY - 4}" fill="none" stroke={GREEN} stroke-width="1.5" marker-end="url(#ab-arrow-green)" opacity={phase > CHUNKS ? 1 : 0.3} />
          <text x="690" y={KY + KH / 2 + 4} text-anchor="end" class="tag">reads ↑ · writes ↓</text>

          <!-- HBM -->
          <rect x="30" y={HY} width="660" height={HH} rx="10" fill="#f4f2ec" stroke="var(--line)" />
          <text x="42" y={HY + 17} class="boxtitle">HBM</text>
          <!-- Q -->
          <rect x="70" y={GY} width="20" height={N * CELL - 1} rx="3" fill="#d9d5cb" />
          <rect x="70" y={GY + ROW * CELL} width="20" height={CELL - 1} fill={RED} opacity="0.85" />
          <text x="64" y={GY + ROW * CELL + 9} text-anchor="end" class="tag strong">qᵢ</text>
          <text x="80" y={GY + N * CELL + 15} text-anchor="middle" class="tag strong">Q · n × {HD}</text>
          <text x="80" y={GY + N * CELL + 29} text-anchor="middle" class="tag">{qkvMB.toFixed(1)} MB</text>
          <!-- K and V, in chunks -->
          {#each [{ n: 'K', x: KX }, { n: 'V', x: VX }] as m}
            {#each Array(CHUNKS) as _, c}
              {@const on = c + 1 === active}
              {@const done = c + 1 < active}
              <rect x={m.x} y={GY + c * BAND} width="20" height={BAND - 2} rx="2" fill={RED} opacity={on ? 0.95 : done ? 0.3 : 0.6} />
              <text x={m.x + 26} y={GY + c * BAND + BAND / 2 + 3} class="tag" fill={on ? 'var(--fg)' : 'var(--faint)'}>{c + 1}</text>
            {/each}
            <text x={m.x + 10} y={GY + N * CELL + 15} text-anchor="middle" class="tag strong">{m.n} · n × {HD}</text>
            <text x={m.x + 10} y={GY + N * CELL + 29} text-anchor="middle" class="tag">{qkvMB.toFixed(1)} MB</text>
          {/each}
          <!-- S and P, as ghosts -->
          {#each [{ n: 'S', x: 214 }, { n: 'P', x: 346 }] as g}
            <rect x={g.x} y={GY} width={N * CELL - 1} height={N * CELL - 1} rx="3" fill="none" stroke="var(--faint)" stroke-dasharray="3 3" />
            <text x={g.x + (N * CELL) / 2} y={GY + (N * CELL) / 2 + 4} text-anchor="middle" class="tag">never written</text>
            <text x={g.x + (N * CELL) / 2} y={GY + N * CELL + 15} text-anchor="middle" class="tag strong" fill="var(--faint)">{g.n} · n × n</text>
            <text x={g.x + (N * CELL) / 2} y={GY + N * CELL + 29} text-anchor="middle" class="tag">0 MB</text>
          {/each}
          <!-- out -->
          <rect x="600" y={GY} width="20" height={N * CELL - 1} rx="3" fill="#d9d5cb" />
          <rect x="600" y={GY + ROW * CELL} width="20" height={CELL - 1} fill={RED} opacity={phase > CHUNKS ? 0.85 : 0.25} />
          <text x="610" y={GY + N * CELL + 15} text-anchor="middle" class="tag strong">out · n × {HD}</text>
          <text x="610" y={GY + N * CELL + 29} text-anchor="middle" class="tag">{qkvMB.toFixed(1)} MB</text>
          <!-- what is happening now -->
          <text x="42" y={GY + N * CELL + 47} class="tag strong">{phase === 0 ? 'the kernel reads one chunk of K and V at a time; nothing goes back down until the end' : phase <= CHUNKS ? `chunk ${active}: score qᵢ against its keys, fold them into mᵢ, ℓᵢ, outᵢ, drop them · the scores live in registers for one chunk` : `all ${CHUNKS} chunks folded in · outᵢ written once · ${(4 * qkvMB).toFixed(0)} MB across HBM, against ${headMB.toFixed(0)}`}</text>

          <!-- the one equation it rests on -->
          <g in:fade={{ delay: 600 }}>
            <text x="30" y="330" class="legend">a chunk can raise row i's max from m to m′ · what was summed under the old max is fixed by one factor, because</text>
            <foreignObject x="30" y="338" width="660" height="30">
              <div xmlns="http://www.w3.org/1999/xhtml" class="math">{@html tex('e^{\\,s - m\'} = e^{\\,s - m}\\, e^{\\,m - m\'} \\qquad\\Rightarrow\\qquad \\ell \\leftarrow \\ell\\, e^{\\,m - m\'} + \\sum_{\\text{chunk}} e^{\\,s - m\'}, \\qquad \\mathrm{out} \\leftarrow \\mathrm{out}\\, e^{\\,m - m\'} + \\sum_{\\text{chunk}} e^{\\,s - m\'}\\, v')}</div>
            </foreignObject>
            <text x="30" y="382" class="legend muted">the row never has to be whole, and outᵢ ÷ ℓᵢ at the end equals the full softmax exactly · Dao et al., FlashAttention, 2022</text>
            <text x="30" y="396" class="legend muted">every backend in this chapter is an implementation of this loop · what differs between them is the next step</text>
          </g>
        </g>
      {/if}

      <!-- 5: the map · one loop, four things that change how it is written -->
      {#if cur.scene === 'map'}
        {@const rows = [
          { t: 'how many queries', s: 'prefill has n per key · decode has one', so: 'two kernels: extend and decode', step: 6 },
          { t: 'where K and V sit', s: 'one tensor · or pages, anywhere in the pool', so: 'a table per batch, gathered through', step: 7 },
          { t: 'how the model lays out heads', s: 'MHA · GQA · MLA', so: 'a loop per layout · MLA its own family', step: 8 },
          { t: 'which GPU', s: 'A100 · H100 · B200 · MI300', so: 'a rewrite per generation', step: 9 },
        ]}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">one loop · four things that change how it has to be written · one step each</text>
          <rect x="30" y="56" width="660" height="30" rx="8" fill={GREEN} opacity="0.9" />
          <text x="360" y="75" text-anchor="middle" class="kname">the loop of step 4 · one query row against K and V, a chunk at a time</text>
          {#each rows as r, i}
            {@const y = 108 + i * 64}
            <g in:fade={{ delay: 200 + i * 220, duration: 250 }}>
              <line x1="30" y1={y - 12} x2="690" y2={y - 12} stroke="var(--line)" />
              <circle cx="42" cy={y + 10} r="9" fill="var(--fg)" opacity="0.8" />
              <text x="42" y={y + 14} text-anchor="middle" class="kname">{i + 1}</text>
              <text x="60" y={y + 6} class="slab strong small">{r.t}</text>
              <text x="60" y={y + 22} class="tag">{r.s}</text>
              <!-- pictograms -->
              {#if i === 0}
                {#each Array(4) as _, rr}{#each Array(4) as _, cc}
                  <rect x={250 + cc * 9} y={y - 4 + rr * 9} width="8" height="8" fill={cc <= rr ? RED : '#e8e5dd'} opacity={cc <= rr ? 0.8 : 1} />
                {/each}{/each}
                <text x={267} y={y + 44} text-anchor="middle" class="tag">prefill</text>
                {#each Array(4) as _, cc}<rect x={330 + cc * 9} y={y - 4} width="8" height="8" fill={RED} opacity="0.8" />{/each}
                <text x={347} y={y + 44} text-anchor="middle" class="tag">decode</text>
              {:else if i === 1}
                {#each Array(6) as _, cc}<rect x={250 + cc * 9} y={y + 2} width="8" height="12" fill={RED} opacity="0.8" />{/each}
                <text x={276} y={y + 44} text-anchor="middle" class="tag">one tensor</text>
                {#each Array(10) as _, cc}<rect x={330 + cc * 9} y={y + 2} width="8" height="12" fill={[1, 4, 5, 8].includes(cc) ? RED : '#e8e5dd'} opacity={[1, 4, 5, 8].includes(cc) ? 0.8 : 1} />{/each}
                <text x={375} y={y + 44} text-anchor="middle" class="tag">pages in a pool</text>
              {:else if i === 2}
                {#each [{ x: 250, kv: 4, n: 'MHA' }, { x: 310, kv: 1, n: 'GQA' }, { x: 370, kv: 0, n: 'MLA' }] as h}
                  {#each Array(4) as _, q}<rect x={h.x + q * 9} y={y - 4} width="8" height="8" fill="var(--accent)" opacity="0.85" />{/each}
                  {#if h.kv === 4}{#each Array(4) as _, q}<rect x={h.x + q * 9} y={y + 10} width="8" height="8" fill="var(--gen)" opacity="0.85" />{/each}
                  {:else if h.kv === 1}<rect x={h.x + 13} y={y + 10} width="9" height="8" fill="var(--gen)" opacity="0.85" />
                  {:else}<rect x={h.x} y={y + 10} width="35" height="8" fill="var(--gen)" opacity="0.85" />{/if}
                  <text x={h.x + 17} y={y + 44} text-anchor="middle" class="tag">{h.n}</text>
                {/each}
              {:else}
                {#each [['A100', 'FA2'], ['H100', 'FA3'], ['B200', 'TRT-LLM'], ['MI300', 'Triton']] as g, k}
                  <rect x={250 + k * 62} y={y - 6} width="54" height="22" rx="4" fill="#fbfaf7" stroke="var(--fg)" />
                  <text x={277 + k * 62} y={y + 9} text-anchor="middle" class="mono">{g[0]}</text>
                  <text x={277 + k * 62} y={y + 34} text-anchor="middle" class="tag">{g[1]}</text>
                {/each}
              {/if}
              <text x="520" y={y + 6} class="tag strong">{r.so}</text>
              <text x="520" y={y + 22} class="tag">step {r.step}</text>
            </g>
          {/each}
          <text x="16" y="386" class="legend" in:fade={{ delay: 1200 }}>a backend is one implementation, written for one combination · SGLang ships several and picks by GPU and model (step 11)</text>
        </g>
      {/if}

      <!-- 6: how many queries · prefill vs decode, and the decode split -->
      {#if cur.scene === 'shapes'}
        {@const CELL = 12}
        {@const N = 8}
        {@const T = 4}
        {@const SM = 6}
        {@const COLS = 12}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">what forces a new kernel · 1 of 4 · how many queries · S per head · red: one thread block's tile</text>
          <g in:fade={{ delay: 100, duration: 250 }}>
            <text x="40" y="70" class="slab strong small">prefill · n queries × n keys</text>
            {#each Array(N) as _, r}{#each Array(N) as _, c}
              {@const inTile = r >= T && c < T}
              <rect x={40 + c * CELL} y={80 + r * CELL} width={CELL - 1} height={CELL - 1} fill={c > r ? '#f4f2ec' : inTile ? RED : '#d9d5cb'} opacity={c > r ? 1 : inTile ? 0.85 : 1} />
            {/each}{/each}
            <text x={40 + N * CELL + 16} y="92" class="tag">grey: keys after the query, skipped (chapter 2)</text>
            <text x={40 + N * CELL + 16} y="112" class="tag strong">one tile: {T} queries × {T} keys</text>
            <text x={40 + N * CELL + 16} y="126" class="tag">loads {T} keys' K/V once, uses each byte {T} times</text>
            <text x={40 + N * CELL + 16} y="140" class="tag">real tiles: 64–128 queries, 64–128 uses per byte</text>
            <text x={40 + N * CELL + 16} y="160" class="tag strong">compute-bound, by chapter 4's rule</text>
          </g>
          <g in:fade={{ delay: 600, duration: 250 }}>
            <text x="400" y="70" class="slab strong small">decode · 1 query × n keys</text>
            {#each Array(N) as _, c}
              <rect x={400 + c * CELL} y="80" width={CELL - 1} height={CELL - 1} fill={c < T ? RED : '#d9d5cb'} opacity={c < T ? 0.85 : 1} />
            {/each}
            <text x={400 + N * CELL + 16} y="92" class="tag">one row, so no triangle to skip</text>
            <text x={400 + N * CELL + 16} y="112" class="tag strong">one tile: 1 query × {T} keys</text>
            <text x={400 + N * CELL + 16} y="126" class="tag">loads {T} keys' K/V once, uses each once</text>
            <text x={400 + N * CELL + 16} y="140" class="tag">no tile height to grow: 1 use per byte</text>
            <text x={400 + N * CELL + 16} y="160" class="tag strong">memory-bound, by the same rule</text>
          </g>
          <g in:fade={{ delay: 1200, duration: 250 }}>
            <line x1="30" y1="186" x2="690" y2="186" stroke="var(--line)" />
            <text x="40" y="208" class="slab strong small">decode at batch 1, {fmtK(CTX_DEC)} context · each square is one of the H100's {SMS} SMs, the units that run thread blocks</text>
            {#each [{ x: 40, lit: KV_HEADS, t: `a tile is one row, so a head is one block`, u: `${KV_HEADS} blocks · ${fmtGB(kvGB(CTX_DEC, 1))} ÷ ${KV_HEADS} = ${(kvGB(CTX_DEC, 1) * 1e3 / KV_HEADS).toFixed(0)} MB each`, v: `each streamed by one SM, alone` }, { x: 380, lit: KV_HEADS * SPLITS, t: `cut each head's row into ${SPLITS} chunks`, u: `${KV_HEADS * SPLITS} blocks · each keeps its own m, ℓ, out (step 4)`, v: `a merge folds the ${SPLITS} together` }] as g}
              {#each Array(SMS) as _, k}
                <rect x={g.x + (k % COLS) * SM} y={220 + Math.floor(k / COLS) * SM} width={SM - 1} height={SM - 1} fill={k < g.lit ? RED : '#e8e5dd'} opacity={k < g.lit ? 0.85 : 1} />
              {/each}
              <text x={g.x + COLS * SM + 12} y="232" class="tag strong">{g.t}</text>
              <text x={g.x + COLS * SM + 12} y="248" class="tag">{g.u}</text>
              <text x={g.x + COLS * SM + 12} y="264" class="tag">{g.v}</text>
            {/each}
          </g>
          <text x="16" y="322" class="legend" in:fade={{ delay: 1800 }}>two kernels per backend: <tspan class="mono">forward_extend</tspan> (prefill, from a cached prefix, chapter 8) and <tspan class="mono">forward_decode</tspan> · Flash-Decoding, 2023</text>
        </g>
      {/if}

      <!-- 7: where K and V sit · pages, and the plan -->
      {#if cur.scene === 'pages'}
        {@const PX = 60}
        {@const PW = 40}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">what forces a new kernel · 2 of 4 · where K and V sit · two requests, page size 1, a pool of {POOL} pages</text>
          <text x="40" y="76" class="tag">the KV pool</text>
          {#each Array(POOL) as _, p}
            {@const owner = reqA.pages.includes(p) ? reqA : reqB.pages.includes(p) ? reqB : null}
            <rect x={PX + p * PW} y="84" width={PW - 3} height="30" rx="4" fill={owner ? owner.c : '#f4f2ec'} opacity={owner ? 0.8 : 1} stroke={owner ? 'none' : 'var(--line)'} />
            <text x={PX + p * PW + (PW - 3) / 2} y="103" text-anchor="middle" class={owner ? 'kname' : 'tag'}>{p}</text>
          {/each}
          {#each [reqA, reqB] as r, i}
            <g in:fade={{ delay: 300 + i * 200 }}>
              <rect x="500" y={78 + i * 22} width="12" height="12" rx="3" fill={r.c} opacity="0.8" />
              <text x="518" y={88 + i * 22} class="tag">{r.n} · pages {r.pages.join(', ')}, in token order</text>
            </g>
          {/each}
          <g in:fade={{ delay: 800 }}>
            <text x="40" y="178" class="mono strong">kv_indptr</text>
            {#each indptr as v, i}
              <rect x={150 + i * 34} y="166" width="30" height="18" rx="3" fill="white" stroke="var(--fg)" />
              <text x={165 + i * 34} y="179" text-anchor="middle" class="mono">{v}</text>
            {/each}
            <text x="266" y="179" class="tag">where each request's slice starts</text>
            <text x="40" y="208" class="mono strong">kv_indices</text>
            {#each indices as v, i}
              {@const isB = i >= indptr[1]}
              <rect x={150 + i * 34} y="196" width="30" height="18" rx="3" fill={isB ? reqB.c : reqA.c} opacity={isB ? 0.85 : 0.35} />
              <text x={165 + i * 34} y="209" text-anchor="middle" class="mono" fill={isB ? 'white' : 'var(--fg)'}>{v}</text>
            {/each}
            <text x={150 + indices.length * 34 + 10} y="209" class="tag">the page numbers, request after request</text>
          </g>
          <g in:fade={{ delay: 1300 }}>
            {#each reqB.pages as p, j}
              <path d="M {165 + (indptr[1] + j) * 34} 216 C {165 + (indptr[1] + j) * 34} 240, {PX + p * PW + 18} 130, {PX + p * PW + 18} 118" fill="none" stroke={reqB.c} stroke-width="1.2" marker-end="url(#ab-arrow-green)" opacity="0.8" />
            {/each}
            <text x="40" y="246" class="tag">B's block reads <tspan class="mono">kv_indices[{indptr[1]}:{indptr[2]}]</tspan> and gathers its K and V from those pages</text>
          </g>
          <g in:fade={{ delay: 1700 }}>
            <text x="16" y="300" class="legend">built on the CPU every batch, before the forward: <tspan class="mono">init_forward_metadata</tspan></text>
            <text x="16" y="322" class="legend muted">a graph freezes sizes (chapter 11), and these two arrays' sizes follow the batch: that is why chapter 12 cut at attention</text>
          </g>
        </g>
      {/if}

      <!-- 8: how the model lays out its heads · GQA and MLA -->
      {#if cur.scene === 'heads'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">what forces a new kernel · 3 of 4 · the model's head layout · blue: query heads · orange: cached per token</text>
          <g in:fade={{ delay: 100, duration: 250 }}>
            <text x="40" y="76" class="slab strong small">grouped-query attention · Llama-3-8B</text>
            {#each Array(HEADS) as _, h}
              <rect x={40 + h * 9} y="92" width="7" height="10" rx="1.5" fill="var(--accent)" opacity="0.85" />
            {/each}
            {#each Array(KV_HEADS) as _, g}
              <path d="M {40 + g * 36 + 16} 104 V 118" fill="none" stroke="var(--faint)" />
              <rect x={40 + g * 36 + 4} y="120" width="24" height="12" rx="2" fill="var(--gen)" opacity="0.85" />
            {/each}
            <text x="40" y="152" class="tag">{HEADS} query heads · {KV_HEADS} K/V heads · {GROUP} queries per K/V block</text>
            <text x="40" y="176" class="tag strong">load a K/V block once, run {GROUP} queries on it</text>
            <text x="40" y="190" class="tag">{GROUP} uses per byte, like a {GROUP}-query tile in step 6</text>
            <text x="40" y="204" class="tag">{kvPerTok / 1024} KB cached per token (chapter 3)</text>
          </g>
          <g in:fade={{ delay: 700, duration: 250 }}>
            <text x="400" y="76" class="slab strong small">multi-head latent attention · DeepSeek-V3</text>
            {#each Array(30) as _, h}
              <rect x={400 + h * 9} y="92" width="7" height="10" rx="1.5" fill="var(--accent)" opacity="0.85" />
            {/each}
            <text x="674" y="100" class="tag">…</text>
            <path d="M 540 104 V 118" fill="none" stroke="var(--faint)" />
            <rect x="400" y="120" width="256" height="12" rx="2" fill="var(--gen)" opacity="0.85" />
            <rect x="656" y="120" width="32" height="12" rx="2" fill="var(--gen)" opacity="0.5" />
            <text x="400" y="152" class="tag">128 query heads · one 576-wide latent per token, for all of them</text>
            <text x="400" y="176" class="tag strong">K and V are never stored</text>
            <text x="400" y="190" class="tag">the kernel turns the latent back into each head's k and v</text>
            <text x="400" y="204" class="tag">so its q, k are 576 wide and its v 512, not 128</text>
            <text x="400" y="218" class="tag">576 × 2 B × 61 layers ≈ 70 KB cached per token</text>
          </g>
          <g in:fade={{ delay: 1300 }}>
            <text x="16" y="262" class="legend">no MHA kernel has MLA's shapes, so MLA is its own family: flashinfer (MLA), flashmla, cutlass_mla, trtllm_mla</text>
            <text x="16" y="284" class="legend muted">the model fixes this axis; it decides which kernels apply at all</text>
          </g>
        </g>
      {/if}

      <!-- 9: which GPU · the same loop, rewritten -->
      {#if cur.scene === 'hardware'}
        {@const X0 = 150}
        {@const U = 44}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">what forces a new kernel · 4 of 4 · which GPU · one thread block sweeping K/V blocks · time runs right</text>
          <g in:fade={{ delay: 100, duration: 250 }}>
            <text x="16" y="82" class="slab strong small">FlashAttention-2</text>
            <text x="16" y="96" class="tag">Ampere · A100</text>
            {#each Array(5) as _, k}
              <rect x={X0 + k * 2 * U} y="70" width={U - 2} height="18" rx="3" fill="var(--gen)" opacity="0.85" />
              <text x={X0 + k * 2 * U + U / 2} y="83" text-anchor="middle" class="tag onbox">load {k + 1}</text>
              <rect x={X0 + k * 2 * U + U} y="70" width={U - 2} height="18" rx="3" fill="var(--fg)" opacity="0.7" />
              <text x={X0 + k * 2 * U + U + U / 2} y="83" text-anchor="middle" class="tag onbox">compute</text>
            {/each}
            <text x={X0} y="108" class="tag">a warp is 32 threads running in lockstep; a thread block is a few warps</text>
            <text x={X0} y="122" class="tag">here every warp loads, then computes: the tensor cores idle during each load</text>
          </g>
          <g in:fade={{ delay: 700, duration: 250 }}>
            <text x="16" y="150" class="slab strong small">FlashAttention-3 <tspan class="tag">· Hopper · H100</tspan></text>
            <text x={X0 - 8} y="173" text-anchor="end" class="tag">producer warps</text>
            {#each Array(6) as _, k}
              <rect x={X0 + k * U} y="160" width={U - 2} height="18" rx="3" fill="var(--gen)" opacity="0.85" />
              <text x={X0 + k * U + U / 2} y="173" text-anchor="middle" class="tag onbox">load {k + 1}</text>
            {/each}
            <text x={X0 - 8} y="195" text-anchor="end" class="tag">consumer warps A</text>
            {#each Array(3) as _, k}
              <rect x={X0 + U + k * 2 * U} y="182" width={U - 2} height="18" rx="3" fill="var(--fg)" opacity="0.7" />
              <text x={X0 + U + k * 2 * U + U / 2} y="195" text-anchor="middle" class="tag onbox">mm {2 * k + 1}</text>
              <rect x={X0 + 2 * U + k * 2 * U} y="182" width={U - 2} height="18" rx="3" fill="var(--accent)" opacity="0.8" />
              <text x={X0 + 2 * U + k * 2 * U + U / 2} y="195" text-anchor="middle" class="tag onbox">softmax</text>
            {/each}
            <text x={X0 - 8} y="217" text-anchor="end" class="tag">consumer warps B</text>
            {#each Array(3) as _, k}
              <rect x={X0 + 2 * U + k * 2 * U} y="204" width={U - 2} height="18" rx="3" fill="var(--fg)" opacity="0.7" />
              <text x={X0 + 2 * U + k * 2 * U + U / 2} y="217" text-anchor="middle" class="tag onbox">mm {2 * k + 2}</text>
              {#if k < 2}
                <rect x={X0 + 3 * U + k * 2 * U} y="204" width={U - 2} height="18" rx="3" fill="var(--accent)" opacity="0.8" />
                <text x={X0 + 3 * U + k * 2 * U + U / 2} y="217" text-anchor="middle" class="tag onbox">softmax</text>
              {/if}
            {/each}
            <text x={X0} y="242" class="tag">mm: a block's two matmuls, on the tensor cores · softmax runs on the ordinary units</text>
            <text x={X0} y="256" class="tag">so one group's softmax overlaps the other's mm, and the tensor cores stay busy</text>
            <text x={X0} y="270" class="tag">producer warps only issue loads to the copy engine, hardware that moves bytes on its own</text>
            <text x={X0} y="284" class="tag">about 75% of the H100's peak, against 35% for FA2 run on the same card</text>
          </g>
          <g in:fade={{ delay: 1400 }}>
            {#each [['Blackwell · B200', 'TensorRT-LLM kernels'], ['AMD · MI300', 'aiter, wave'], ['any GPU · triton', 'compiled on the spot, slower'], ['any NVIDIA · flashinfer', 'generated at first use, cached']] as g, k}
              <rect x={30 + k * 166} y="308" width="156" height="44" rx="8" fill="#fbfaf7" stroke="var(--line)" />
              <text x={38 + k * 166} y="326" class="tag strong">{g[0]}</text>
              <text x={38 + k * 166} y="342" class="tag">{g[1]}</text>
            {/each}
          </g>
        </g>
      {/if}

      <!-- 10: SGLang's interface, as one step's flow -->
      {#if cur.scene === 'interface'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">sglang/srt/layers/attention/ · one base class, one subclass per backend · one step, left to right</text>
          <!-- the runner's step, as a column of three events -->
          <g in:fade={{ delay: 100, duration: 250 }}>
            <text x="40" y="70" class="boxtitle">model runner · one step</text>
            <rect x="40" y="82" width="230" height="40" rx="8" fill="#fbfaf7" stroke="var(--accent)" />
            <text x="52" y="100" class="slab strong small">1 · plan the batch</text>
            <text x="52" y="114" class="tag">lengths, page tables · step 7</text>
            <rect x="40" y="150" width="230" height="88" rx="8" fill="#fbfaf7" stroke="var(--fg)" />
            <text x="52" y="168" class="slab strong small">2 · forward · {LAYERS} layers</text>
            {#each Array(3) as _, i}
              <rect x={52 + i * 6} y={178 + i * 6} width="164" height="34" rx="5" fill="white" stroke="var(--line)" />
            {/each}
            <text x="72" y="199" class="mono">RadixAttention.forward</text>
            <text x="52" y="230" class="tag">SGLang's attention layer · nothing else</text>
            <rect x="40" y="266" width="230" height="40" rx="8" fill="#fbfaf7" stroke="var(--gen)" />
            <text x="52" y="284" class="slab strong small">3 · decode rung: replay</text>
            <text x="52" y="298" class="tag">chapter 11's graph</text>
          </g>
          <!-- the backend, as slots -->
          <g in:fade={{ delay: 500, duration: 250 }}>
            <rect x="330" y="60" width="360" height="252" rx="10" fill="#fbfaf7" stroke={RED} />
            <text x="346" y="78" class="boxtitle">AttentionBackend</text>
            <rect x="346" y="88" width="328" height="28" rx="6" fill="white" stroke="var(--accent)" />
            <text x="358" y="106" class="mono strong">init_forward_metadata(batch)</text>
            <text x="662" y="106" text-anchor="end" class="tag">→ the plan</text>
            <rect x="346" y="150" width="328" height="28" rx="6" fill="white" stroke="var(--fg)" />
            <text x="358" y="168" class="mono strong">forward(q, k, v, layer, batch)</text>
            <text x="662" y="168" text-anchor="end" class="tag">prefill or decode?</text>
            <path d="M 430 178 V 190 H 400 V 196" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#ab-arrow)" />
            <path d="M 590 178 V 190 H 620 V 196" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#ab-arrow)" />
            <rect x="346" y="200" width="156" height="28" rx="6" fill="var(--fg)" opacity="0.75" />
            <text x="424" y="218" text-anchor="middle" class="kname">forward_extend</text>
            <rect x="518" y="200" width="156" height="28" rx="6" fill="var(--fg)" opacity="0.75" />
            <text x="596" y="218" text-anchor="middle" class="kname">forward_decode</text>
            <text x="424" y="244" text-anchor="middle" class="tag">step 6's prefill kernel</text>
            <text x="596" y="244" text-anchor="middle" class="tag">step 6's decode kernel</text>
            <rect x="346" y="262" width="328" height="36" rx="6" fill="white" stroke="var(--gen)" />
            <text x="358" y="278" class="mono strong">fixed buffers · capture / replay hooks</text>
            <text x="358" y="292" class="tag">the plan is copied in; the same kernel runs on the same addresses</text>
          </g>
          <!-- the calls -->
          <g in:fade={{ delay: 900, duration: 250 }}>
            <path d="M 270 102 H 340" fill="none" stroke="var(--accent)" stroke-width="1.5" marker-end="url(#ab-arrow)" />
            <path d="M 270 194 H 340" fill="none" stroke="var(--fg)" stroke-width="1.5" marker-end="url(#ab-arrow)" />
            <path d="M 270 286 H 340" fill="none" stroke="var(--gen)" stroke-width="1.5" marker-end="url(#ab-arrow)" />
            <text x="305" y="188" text-anchor="middle" class="tag">× {LAYERS}</text>
          </g>
          <text x="16" y="350" class="legend" in:fade={{ delay: 1400 }}>both kernels also write the new k and v into the paged pool: the backend, not the model, knows where the pages are</text>
        </g>
      {/if}

      <!-- 11: the backends, one row per implementation, columns per axis -->
      {#if cur.scene === 'backends'}
        {@const cols = [['backend', 30], ['kernels from', 128], ['GPU · 4', 262], ['heads · 3', 366], ['page size', 486], ['default for', 566]]}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">--attention-backend · one row per implementation of the loop · the columns are the map's axes</text>
          {#each cols as c}<text x={c[1]} y="70" class="boxtitle">{c[0]}</text>{/each}
          <line x1="30" y1="76" x2="690" y2="76" stroke="var(--line)" />
          {#each mha as b, i}
            {@const y = 96 + i * 24}
            <g in:fade={{ delay: 200 + i * 150, duration: 200 }}>
              <text x="30" y={y} class="mono strong">{b.n}</text>
              <text x="128" y={y} class="tag">{b.from}</text>
              <text x="262" y={y} class="tag">{b.gpu}</text>
              <text x="366" y={y} class="tag">{b.heads}</text>
              <text x="486" y={y} class="tag">{b.page}</text>
              <text x="566" y={y} class="tag strong">{b.def}</text>
            </g>
          {/each}
          <g in:fade={{ delay: 1100, duration: 200 }}>
            <line x1="30" y1="212" x2="690" y2="212" stroke="var(--line)" />
            <text x="30" y="232" class="boxtitle">MLA only</text>
            {#each mlaOnly as b, i}
              <text x={128 + i * 190} y="232" class="mono strong">{b.n}</text>
              <text x={128 + i * 190} y="246" class="tag">page {b.page}</text>
            {/each}
          </g>
          <g in:fade={{ delay: 1500 }}>
            <text x="16" y="290" class="legend">the same loop five times, each for one GPU, one head layout and one page size · the engine's page size (chapter 7) must match</text>
            <text x="16" y="312" class="legend muted"><tspan class="mono">--prefill-attention-backend</tspan> and <tspan class="mono">--decode-attention-backend</tspan> split step 6's pair across two backends</text>
            <text x="16" y="334" class="legend muted">source: docs.sglang.io · <tspan class="mono">attention_registry.py</tspan> maps about two dozen names to classes</text>
          </g>
        </g>
      {/if}

      <!-- 12: closing · attention before and after this chapter, one decode step -->
      {#if cur.scene === 'closing'}
        {@const BX = 200}
        {@const BW2 = 440}
        {@const kvB = kvGB(CTX_DEC, 1)}
        {@const share = KV_HEADS / SMS}
        {@const attnBefore = kvB / (BW * share)}
        {@const attnAfter = kvB / BW}
        {@const mathMs = 0.016}
        {@const before = tMem + attnBefore}
        {@const after = tMem + attnAfter + mathMs}
        {@const perMs = BW2 / before}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">one decode step at batch 1, {fmtK(CTX_DEC)} tokens of context · attention before and after this chapter</text>
          {#each [{ y: 90, t: 'before', s: `${KV_HEADS} blocks, one per head, alone`, w: tMem, a: attnBefore, m: 0, tot: before, note: `${fmtGB(kvB)} at ${KV_HEADS}/${SMS} of ${BW} TB/s: ${fmtMs(attnBefore)}` }, { y: 190, t: 'after', s: `fused · ${KV_HEADS * SPLITS} blocks · the right backend`, w: tMem, a: attnAfter, m: mathMs, tot: after, note: `${fmtGB(kvB)} at full bandwidth: ${fmtMs(attnAfter)}` }] as b, i}
            <g in:fade={{ delay: 200 + i * 600, duration: 250 }}>
              <text x={BX - 12} y={b.y + 18} text-anchor="end" class="slab strong small">{b.t}</text>
              <text x={BX - 12} y={b.y + 34} text-anchor="end" class="tag">{b.s}</text>
              <rect x={BX} y={b.y} width={b.w * perMs} height="28" rx="4" fill="var(--gen)" opacity="0.85" />
              <rect x={BX + b.w * perMs} y={b.y} width={b.a * perMs} height="28" rx="4" fill={RED} opacity="0.85" />
              {#if b.m}<rect x={BX + (b.w + b.a) * perMs} y={b.y} width={Math.max(2, b.m * perMs)} height="28" fill={GREEN} />{/if}
              <text x={BX + b.tot * perMs + 10} y={b.y + 18} class="tag strong">{fmtMs(b.tot)}</text>
              <text x={BX} y={b.y + 44} class="tag">weights · {W_GB} GB · {fmtMs(tMem)}</text>
              <text x={BX + b.w * perMs + 6} y={b.y + 44} class="tag" fill={RED}>attention · {b.note}</text>
            </g>
          {/each}
          <g in:fade={{ delay: 1500 }}>
            <path d="M {BX + (tMem + attnAfter) * perMs} 218 V 262" fill="none" stroke={GREEN} stroke-width="1" />
            <text x={BX + (tMem + attnAfter) * perMs + 6} y="266" class="tag strong" fill={GREEN}>math · 0.016 ms · one token · {((mathMs / after) * 100).toFixed(1)}% of the step</text>
            <text x="16" y="312" class="legend">the weight read did not move: {fmtMs(tMem)} either way · five queries against the same cache and weights would cost the same read</text>
            <text x="16" y="348" class="legend"><tspan class="strong">The step could verify five candidate tokens for the price of one.</tspan> Where would five candidates come from?</text>
          </g>
        </g>
      {/if}

    </svg>
  </div>

  <StepControls {step} total={steps.length} caption={cur.caption} interval={4600} {prev} {next} onchange={(s) => (step = s)} />
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
  .tag.onbox { fill: white; font-weight: 600; }
  .math { font-size: 11px; color: var(--fg); line-height: 1; }
  .math :global(.katex) { font-size: 1.15em; }
</style>
