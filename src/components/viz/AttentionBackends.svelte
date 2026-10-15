<script lang="ts">
  import { untrack } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import StepControls from '../StepControls.svelte';
  import LoopProgress from '../LoopProgress.svelte';
  import katex from 'katex';
  import type { NavLink } from '../../chapters';
  import { HEADS, KV_HEADS, HEAD_DIM as HD, LAYERS, BYTES, W_GB, BW, TFLOPS, SMS } from '../../numbers';
  let { prev, next }: { prev?: NavLink; next?: NavLink } = $props();
  const tex = (src: string) => katex.renderToString(src, { throwOnError: false });

  // ---- Numbers: Llama-3-8B bf16 on one H100, continuing chapters 3, 4, 11 and 13 --------------------------
  const tMem = W_GB / BW;                                   // 4.8 ms, the weight read
  const kvPerTokLayer = KV_HEADS * HD * 2 * BYTES;          // 4 KB: k and v for one token in one layer
  const kvPerTok = kvPerTokLayer * LAYERS;                  // 128 KB across the model, chapter 3
  const B_EX = 256;                                         // chapter 13's batch
  const kvGB = (ctx: number, b = B_EX) => (b * ctx * kvPerTok) / 1e9;
  const CTXS = [256, 512, 1024, 2048, 4096];
  const crossTok = Math.round((W_GB * 1e9) / (B_EX * kvPerTok) / 10) * 10;   // where the cache read passes the weights
  const balance = Math.round(TFLOPS / BW);                  // 295: chapter 4's balance point, uses per byte
  const BAL = Math.round(balance / 100) * 100;              // chapter 4 says "about 300"
  const GROUP = HEADS / KV_HEADS;                           // 4 query heads per k/v head
  const TILE_Q = 128;                                       // a prefill tile's height, in queries
  const N_PROMPT = 2000;
  const sMB = (N_PROMPT * N_PROMPT * BYTES) / 1e6;          // the score matrix S for one head: 8 MB
  const CHUNKS = 4;
  const qkvMB = (N_PROMPT * HD * BYTES) / 1e6;              // Q, K or V for one head: 0.512 MB
  const k1MB = 2 * qkvMB + sMB;                             // read Q and K, write S
  const k2MB = 2 * sMB;                                     // read S, write P
  const k3MB = sMB + 2 * qkvMB;                             // read P and V, write out
  const headMB = k1MB + k2MB + k3MB;
  const promptGB = (headMB * HEADS * LAYERS) / 1e3;         // every head of every layer, one prompt
  const CTX_DEC = 8192;
  const SPLITS = Math.floor(SMS / KV_HEADS);               // 16: the most chunks per head that keep 8 × chunks ≤ 132 SMs
  const kvHeadLayerMB = (CTX_DEC * kvPerTokLayer) / KV_HEADS / 1e6;   // one K/V head's keys and values, one layer: 4.2 MB
  const kvLayerMB = kvHeadLayerMB * KV_HEADS;                          // one layer, all heads: 33.5 MB
  const tLayer = (sms: number) => kvLayerMB / 1e3 / (BW * (sms / SMS)); // ms, assuming each busy SM pulls 1/132 of the bandwidth
  // DeepSeek-V3's MLA, for the heads step: 128 query heads read one cached vector, k 576 wide and v 512
  const MLA_HEADS = 128, MLA_K = 576, MLA_V = 512;
  const TILE_K = 64;                                        // keys per chunk of K and V a kernel loads
  const SMEM_KB = 228;                                      // shared memory per H100 SM
  const fmtGB = (gb: number) => (gb < 10 ? gb.toFixed(1) : gb.toFixed(0)) + ' GB';
  const fmtMs = (ms: number) => (ms < 1 ? ms.toFixed(2) : ms < 10 ? ms.toFixed(1) : ms.toFixed(0)) + ' ms';
  const fmtK = (n: number) => (n >= 1024 ? `${n / 1024}k` : String(n));

  // the paged batch of the plan step: page size 1, as SGLang keeps it
  const reqA = { n: 'A', pages: [3, 9, 1, 7, 2], c: 'var(--accent)' };
  const reqB = { n: 'B', pages: [4, 8, 6], c: '#16a34a' };
  const POOL = 10;
  const indptr = [0, reqA.pages.length, reqA.pages.length + reqB.pages.length];
  const indices = [...reqA.pages, ...reqB.pages];

  // SGLang's backends, from docs.sglang.io/advanced_features/attention_backend and get_default_attn_backend
  // columns follow the map: heads is 1, page size stands for 3, GPU is 4
  const general = [
    { n: 'fa3', from: 'FlashAttention-3', heads: 'MHA · GQA · MLA', page: 'any', gpu: 'Hopper', def: 'H100, H200' },
    { n: 'trtllm_mha', from: 'TensorRT-LLM', heads: 'MHA · GQA', page: '16–128', gpu: 'Blackwell', def: 'B200' },
    { n: 'aiter', from: "AMD's aiter", heads: 'MHA · GQA · MLA', page: 'any', gpu: 'AMD', def: 'MI300' },
    { n: 'flashinfer', from: 'FlashInfer', heads: 'MHA · GQA · MLA', page: 'any', gpu: 'any NVIDIA', def: 'other NVIDIA, e.g. A100' },
    { n: 'triton', from: 'Triton, one source', heads: 'MHA · GQA · MLA', page: '1', gpu: 'any, AMD too', def: 'when nothing else fits' },
    { n: 'torch_native', from: "PyTorch's own", heads: 'MHA · GQA', page: '1', gpu: 'any', def: 'by hand only' },
  ];
  const mlaOnly = [{ n: 'flashmla', page: '64' }, { n: 'cutlass_mla', page: '128' }, { n: 'trtllm_mla', page: '32 · 64 · Blackwell' }];

  type Scene = 'bytes' | 'traffic' | 'bill' | 'flash' | 'map' | 'heads' | 'shapes' | 'split' | 'pages' | 'hardware' | 'interface' | 'backends' | 'closing';
  // 'closing' (one request's next 5 positions in one pass) is hidden until speculative decoding follows this chapter again
  const ORDER: Scene[] = ['bytes', 'traffic', 'bill', 'flash', 'map', 'heads', 'shapes', 'split', 'pages', 'hardware', 'interface', 'backends'];
  const at = (s: Scene) => ORDER.indexOf(s) + 1;            // step numbers on the stage follow the order above
  const nb = (s: string) => `<span style="white-space:nowrap">${s}</span>`;   // keeps a hyphenated name on one caption line
  const captions: Record<Scene, string> = {
    bytes: `Chapters 11 to 13 touched everything in a layer but attention. Attention reads every request's whole cache: batch × context × ${kvPerTok / 1024} KB per step. At batch ${B_EX} that passes the ${W_GB} GB of weights at about ${crossTok} tokens of context.`,
    traffic: `Written as three kernels: <b>S</b> = Q·Kᵀ scores every token against every token, <b>P</b> = softmax(S) turns each row into weights, out = P·V. Every entry of P needs the whole row of S it sits in, so S must be complete before P can start.`,
    bill: `At ${N_PROMPT.toLocaleString()} tokens in bf16, Q, K and V are ${qkvMB.toFixed(1)} MB each per head and S and P ${sMB.toFixed(0)} MB each. The three kernels move ${headMB.toFixed(0)} MB per head, ${promptGB.toFixed(0)} GB per prompt over ${HEADS} heads and ${LAYERS} layers: ${fmtMs(promptGB / BW)} at ${BW} TB/s, for two intermediates nobody keeps.`,
    flash: `Fuse the three kernels. Read K and V a chunk at a time, keep only each row's running max, sum and output, and drop each chunk's scores. S and P never reach HBM: ${headMB.toFixed(0)} MB per head becomes ${(4 * qkvMB).toFixed(0)} MB. FlashAttention, 2022.`,
    map: `The loop stays the same; four things change how it has to be written. Two are handled inside every backend: prefill versus decode, and pages. Two decide which backend runs: the model's head layout and the GPU.`,
    heads: `The model fixes how many query heads share a K/V head (1, ${GROUP} or ${MLA_HEADS}) and how wide k and v are. A kernel is compiled for one width: MHA and GQA are both ${HD} and share one; MLA's ${MLA_K} and ${MLA_V} need their own.`,
    shapes: `Prefill has a query per prompt token, so a tile of ${TILE_Q} queries × ${GROUP} heads uses each K/V byte ${TILE_Q * GROUP} times, and the math outlasts the read. Decode has one query: ${GROUP} uses, and the read sets the time. So every backend ships two kernels.`,
    split: `At batch 1 a decode layer runs one block per K/V head: ${KV_HEADS} blocks on ${KV_HEADS} of ${SMS} SMs. Cut each head's keys into ${SPLITS} chunks and ${KV_HEADS * SPLITS} blocks read at once, ${SPLITS}× sooner; a merge then combines their partial results.`,
    pages: `Without pages, a request's K and V are consecutive rows, and the kernel computes each row's address. With pages (Ch. 7 Step 4) rows sit anywhere in a pool, so the kernel reads a table of page numbers first: a different kernel.`,
    hardware: `Each GPU generation adds units a kernel must be written to use. On one H100, ${nb('FlashAttention-2')} (written for the A100) reaches 35% of peak and ${nb('FlashAttention-3')} (written for the H100) 75%. So each generation gets its own kernels.`,
    interface: `Many kernels, one model. The model calls one interface, and every backend fills the same slots: the plan (step ${at('pages')}), a prefill and a decode kernel (steps ${at('shapes')}–${at('split')}), and graph buffers. Which backend fills them is step ${at('backends')}.`,
    backends: `Each backend covers some head layouts, page sizes and GPUs. SGLang picks by GPU and model: fa3 on Hopper, trtllm_mha on Blackwell, aiter on AMD, flashinfer on other NVIDIA, triton when nothing else fits.`,
    closing: `One request decoding alone reads ${fmtMs(tMem)} of weights for every token. Its next five tokens in one pass, as prefill does with a prompt, would take ${fmtMs(tMem + tLayer(KV_HEADS * SPLITS) * LAYERS + 5 * 0.016)}, not ${fmtMs(5 * (tMem + tLayer(KV_HEADS * SPLITS) * LAYERS + 0.016))}. But each one's input is the token before it.`,
  };
  const steps = ORDER.map((scene) => ({ scene, caption: captions[scene] }));

  let step = $state(0);
  $effect(() => {
    const q = Number(new URLSearchParams(window.location.search).get('step'));
    if (q >= 1 && q <= steps.length) step = q - 1;
  });
  const cur = $derived(steps[step]);
  const W = 720, H = 400;

  // within-step phases, both looping: the online-softmax chunk walk, and the split-KV race
  const SLOW_MS = 6400, FAST_MS = SLOW_MS / SPLITS;         // one block walking all the keys, against 16 walking a 16th each
  let lap = $state(0), lapMs = $state(0);           // the looping step's laps, for LoopProgress
  const nextLap = (ms: number) => untrack(() => { lapMs = ms; lap++; });   // untracked, so starting a lap does not re-run the effect
  let phase = $state(0);
  $effect(() => {
    const s = step;
    phase = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const scene = steps[s].scene;
    if (scene === 'flash' || scene === 'split') {
      // flash: chunk 1, 2, 3, 4, then the finished state, then back to the start
      // split: start both, the split side finishes and merges, the unsplit side finishes, rest, reset
      const cycle: [number, number][] = scene === 'flash'
        ? [[1, 1400], [2, 1400], [3, 1400], [4, 1400], [5, 1400], [0, 2600]]
        : [[1, 600], [2, FAST_MS + 300], [3, SLOW_MS - FAST_MS], [0, 2600]];
      let i = 0;
      nextLap(cycle.reduce((a, [, w]) => a + w, 0));
      const tick = () => { const [ph, wait] = cycle[i]; timers.push(setTimeout(() => { phase = ph; i = (i + 1) % cycle.length; if (i === 0) nextLap(lapMs); tick(); }, wait)); };
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
              <text x="32" y="318" class="pt">·</text><text x="42" y="318" class="legend">at n = {N_PROMPT.toLocaleString()}, bf16: Q, K, V, out are {N_PROMPT.toLocaleString()} × {HD} × 2 B = <tspan class="strong">{qkvMB.toFixed(1)} MB</tspan> each · S and P are {N_PROMPT.toLocaleString()}² × 2 B = <tspan class="strong">{sMB.toFixed(0)} MB</tspan> each</text>
              <text x="32" y="340" class="pt">·</text><text x="42" y="340" class="legend">kernel 1 reads Q and K, writes S: {k1MB.toFixed(0)} MB · kernel 2 reads S, writes P: {k2MB.toFixed(0)} MB · kernel 3 reads P and V, writes out: {k3MB.toFixed(0)} MB</text>
            </g>
            <g in:fade={{ delay: 1400 }}>
              <text x="32" y="364" class="pt">·</text><text x="42" y="364" class="legend"><tspan class="strong">{headMB.toFixed(0)} MB per head</tspan> · × {HEADS} heads × {LAYERS} layers = <tspan class="strong">{promptGB.toFixed(0)} GB</tspan> for one {N_PROMPT.toLocaleString()}-token prompt · {fmtMs(promptGB / BW)} at {BW} TB/s</text>
              <text x="32" y="386" class="pt">·</text><text x="42" y="386" class="legend">{(2 * sMB * 2).toFixed(0)} of the {headMB.toFixed(0)} MB are S and P: written once, read once, then never needed again</text>
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
          <text x="16" y="42" class="rowlabel">the same head, the same prefill · one kernel · K and V read in {CHUNKS} chunks</text>

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
          <text x="678" y={HY + 17} text-anchor="end" class="tag">moved for this head: <tspan class="strong">{(4 * qkvMB).toFixed(0)} MB</tspan> · three kernels, step {at('bill')}: {headMB.toFixed(0)} MB</text>
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
          <text x="42" y={GY + N * CELL + 47} class="tag strong">{phase === 0 ? 'the kernel reads one chunk of K and V at a time; nothing goes back down until the end' : phase <= CHUNKS ? `chunk ${active}: score qᵢ against its keys in registers, fold the scores into mᵢ, ℓᵢ, outᵢ, drop them` : `all ${CHUNKS} chunks folded in · outᵢ written once`}</text>

          <!-- the one equation it rests on -->
          <g in:fade={{ delay: 600 }}>
            <text x="30" y="332" class="legend">a new chunk can raise row i's max from m to m′; everything summed so far is corrected by one factor:</text>
            <foreignObject x="30" y="340" width="660" height="30">
              <div xmlns="http://www.w3.org/1999/xhtml" class="math">{@html tex('e^{\\,s - m\'} = e^{\\,s - m}\\, e^{\\,m - m\'} \\qquad\\Rightarrow\\qquad \\ell \\leftarrow \\ell\\, e^{\\,m - m\'} + \\sum_{\\text{chunk}} e^{\\,s - m\'}, \\qquad \\mathrm{out} \\leftarrow \\mathrm{out}\\, e^{\\,m - m\'} + \\sum_{\\text{chunk}} e^{\\,s - m\'}\\, v')}</div>
            </foreignObject>
            <text x="30" y="388" class="legend">so the row never has to be whole: at the end, outᵢ ÷ ℓᵢ equals step {at('traffic')}'s outᵢ exactly</text>
          </g>
        </g>
      {/if}

      <!-- 5: the map · one loop, four things that change how it is written, in two kinds -->
      {#if cur.scene === 'map'}
        {@const PX = 244}
        {@const CA = 458}
        {@const CB = 586}
        {@const rows = [
          { t: "the model's head layout", s: ['how many query heads (blue)', 'share one cached K/V head (orange)'], so: ['a kernel family per', 'layout · MLA its own'], col: CB, step: `step ${at('heads')}` },
          { t: 'how many queries', s: ['prefill: one per prompt token', 'decode: one per request'], so: ['two kernels in each:', 'prefill and decode'], col: CA, step: `steps ${at('shapes')}–${at('split')}` },
          { t: 'where K and V sit', s: ['one tensor per request,', 'or pages anywhere in the pool'], so: ['each reads K and V', 'through a page table'], col: CA, step: `step ${at('pages')}` },
          { t: 'which GPU', s: ['each generation adds hardware', 'the loop has to be written for'], so: ['a rewrite per GPU', 'generation'], col: CB, step: `step ${at('hardware')}` },
        ]}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">one loop · four things that change how it has to be written · one step each</text>
          <rect x="30" y="52" width="660" height="24" rx="8" fill={GREEN} opacity="0.9" />
          <text x="360" y="68" text-anchor="middle" class="kname">the loop of step {at('flash')} · a query row against K and V, a chunk at a time</text>
          <!-- the two kinds, as two columns -->
          <rect x={CA - 8} y="84" width="122" height="298" rx="8" fill="#f4f2ec" />
          <rect x={CB - 8} y="84" width="112" height="298" rx="8" fill="#f4f2ec" />
          <text x={CA + 2} y="98" class="tag strong">inside every backend</text>
          <text x={CB + 2} y="98" class="tag strong">picks the backend</text>
          {#each rows as r, i}
            {@const y = 126 + i * 70}
            <g in:fade={{ delay: 200 + i * 220, duration: 250 }}>
              <line x1="30" y1={y - 20} x2="690" y2={y - 20} stroke="var(--line)" />
              <circle cx="42" cy={y + 8} r="9" fill="var(--fg)" opacity="0.8" />
              <text x="42" y={y + 12} text-anchor="middle" class="kname">{i + 1}</text>
              <text x="60" y={y} class="slab strong small">{r.t}</text>
              {#each r.s as line, k}<text x="60" y={y + 16 + k * 13} class="tag">{line}</text>{/each}
              <!-- pictograms -->
              {#if i === 0}
                {#each [{ x: PX, kv: 'each', n: 'MHA' }, { x: PX + 66, kv: 'one', n: 'GQA' }, { x: PX + 132, kv: 'wide', n: 'MLA' }] as h}
                  {#each Array(4) as _, q}<rect x={h.x + q * 9} y={y - 6} width="8" height="8" fill="var(--accent)" opacity="0.85" />{/each}
                  {#if h.kv === 'each'}{#each Array(4) as _, q}<rect x={h.x + q * 9} y={y + 6} width="8" height="8" fill="var(--gen)" opacity="0.85" />{/each}
                  {:else if h.kv === 'one'}<rect x={h.x + 13} y={y + 6} width="9" height="8" fill="var(--gen)" opacity="0.85" />
                  {:else}<rect x={h.x - 4} y={y + 6} width="43" height="8" fill="var(--gen)" opacity="0.85" />{/if}
                  <text x={h.x + 17} y={y + 32} text-anchor="middle" class="tag">{h.n}</text>
                {/each}
              {:else if i === 1}
                {#each Array(4) as _, rr}{#each Array(4) as _, cc}
                  <rect x={PX + cc * 8} y={y - 6 + rr * 8} width="7" height="7" fill={cc <= rr ? RED : '#e8e5dd'} opacity={cc <= rr ? 0.8 : 1} />
                {/each}{/each}
                <text x={PX + 16} y={y + 38} text-anchor="middle" class="tag">prefill</text>
                {#each Array(4) as _, cc}<rect x={PX + 66 + cc * 8} y={y - 6} width="7" height="7" fill={RED} opacity="0.8" />{/each}
                <text x={PX + 82} y={y + 38} text-anchor="middle" class="tag">decode</text>
              {:else if i === 2}
                {#each Array(6) as _, cc}<rect x={PX + cc * 9} y={y} width="8" height="12" fill={RED} opacity="0.8" />{/each}
                <text x={PX + 26} y={y + 32} text-anchor="middle" class="tag">one tensor</text>
                {#each Array(10) as _, cc}<rect x={PX + 80 + cc * 9} y={y} width="8" height="12" fill={[1, 4, 5, 8].includes(cc) ? RED : '#e8e5dd'} opacity={[1, 4, 5, 8].includes(cc) ? 0.8 : 1} />{/each}
                <text x={PX + 125} y={y + 32} text-anchor="middle" class="tag">pages in a pool</text>
              {:else}
                {#each [['A100', 'FA2'], ['H100', 'FA3'], ['B200', 'TRT-LLM'], ['MI300', 'aiter']] as g, k}
                  <rect x={PX + k * 50} y={y - 8} width="44" height="22" rx="4" fill="#fbfaf7" stroke="var(--fg)" />
                  <text x={PX + k * 50 + 22} y={y + 7} text-anchor="middle" class="mono">{g[0]}</text>
                  <text x={PX + k * 50 + 22} y={y + 32} text-anchor="middle" class="tag">{g[1]}</text>
                {/each}
              {/if}
              {#each r.so as line, k}<text x={r.col + 2} y={y + k * 13} class="tag strong">{line}</text>{/each}
              <text x={r.col + 2} y={y + 30} class="tag">{r.step}</text>
            </g>
          {/each}
        </g>
      {/if}

      <!-- 6: head layout · how many query heads share each cached K/V head, and how wide they are -->
      {#if cur.scene === 'heads'}
        {@const PX = 206}
        {@const P = 6}
        {@const C1 = 420}
        {@const C2 = 500}
        {@const CK = 574}
        {@const tileKB = (kw: number, vw: number) => (TILE_K * (kw + vw) * BYTES) / 1024}
        {@const rows = [
          { n: 'MHA', sub: 'multi-head · Llama-2-7B', q: HEADS, kv: 'each', uses: '1', width: String(HD) },
          { n: 'GQA', sub: 'grouped-query · Llama-3-8B', q: HEADS, kv: 'group', uses: String(GROUP), width: String(HD) },
          { n: 'MLA', sub: 'multi-head latent · DeepSeek-V3', q: MLA_HEADS, kv: 'one', uses: String(MLA_HEADS), width: `k ${MLA_K}|v ${MLA_V}` },
        ]}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">what forces a new kernel · 1 of 4 · the model's head layout · blue: query heads · orange: cached K/V</text>
          <text x={C1} y="76" class="tag strong">uses per byte</text>
          <text x={C2} y="76" class="tag strong">k, v width</text>
          <text x={CK + 2} y="76" class="tag strong">kernel</text>
          {#each rows as r, i}
            {@const y0 = 92 + i * 62}
            <g in:fade={{ delay: 150 + i * 350, duration: 250 }}>
              <line x1="30" y1={y0 - 8} x2={CK - 12} y2={y0 - 8} stroke="var(--line)" />
              <text x="40" y={y0 + 14} class="slab strong small">{r.n}</text>
              <text x="40" y={y0 + 29} class="tag">{r.sub}</text>
              <!-- query heads, then what is cached under them -->
              {#if r.q === HEADS}
                {#each Array(HEADS) as _, h}<rect x={PX + h * P} y={y0 + 4} width={P - 1} height="9" rx="1" fill="var(--accent)" opacity="0.85" />{/each}
              {:else}
                {#each Array(r.q) as _, h}<rect x={PX + (h * P * HEADS) / r.q} y={y0 + 4} width="1" height="9" fill="var(--accent)" opacity="0.85" />{/each}
              {/if}
              {#if r.kv === 'each'}
                {#each Array(HEADS) as _, h}<rect x={PX + h * P} y={y0 + 19} width={P - 1} height="9" rx="1" fill="var(--gen)" opacity="0.85" />{/each}
              {:else if r.kv === 'group'}
                {#each Array(KV_HEADS) as _, g}<rect x={PX + g * P * GROUP} y={y0 + 19} width={P * GROUP - 2} height="9" rx="1.5" fill="var(--gen)" opacity="0.85" />{/each}
              {:else}
                <rect x={PX} y={y0 + 19} width={HEADS * P - 1} height="9" rx="1.5" fill="var(--gen)" opacity="0.85" />
              {/if}
              <text x={PX} y={y0 + 42} class="tag">{r.q} query heads · {r.kv === 'each' ? `${HEADS} K/V heads` : r.kv === 'group' ? `${KV_HEADS} K/V heads` : '1 shared vector'}</text>
              <text x={C1} y={y0 + 22} class="mono strong">{r.uses}</text>
              {#each r.width.split('|') as w, k}<text x={C2} y={y0 + 22 + (k - (r.width.split('|').length - 1) / 2) * 13} class="mono">{w}</text>{/each}
            </g>
          {/each}
          <!-- which kernel: the widths decide it, the count does not -->
          <g in:fade={{ delay: 1300, duration: 250 }}>
            <rect x={CK - 6} y="86" width="122" height="110" rx="8" fill="#f4f2ec" />
            <text x={CK + 2} y="134" class="tag strong">one {HD}-wide kernel</text>
            <text x={CK + 2} y="149" class="tag">group size is a setting</text>
            <rect x={CK - 6} y="210" width="122" height="48" rx="8" fill="#f4f2ec" />
            <text x={CK + 2} y="230" class="tag strong">kernels of its own</text>
            <text x={CK + 2} y="245" class="tag">no {HD}-wide kernel fits</text>
          </g>
          <g in:fade={{ delay: 1700 }}>
            <line x1="30" y1="270" x2="690" y2="270" stroke="var(--line)" />
            <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">uses per byte: query heads served by each K/V byte the kernel loads, for one token</text>
            <text x="18" y="314" class="pt">·</text><text x="28" y="314" class="legend">a kernel is compiled for one head width: the tiles it loads, and the on-chip memory that holds them, are sized for it</text>
            <text x="18" y="332" class="pt">·</text><text x="28" y="332" class="legend">K and V for {TILE_K} keys: {tileKB(HD, HD)} KB at width {HD}, {tileKB(MLA_K, MLA_V)} KB at MLA's {MLA_K} and {MLA_V}, of the {SMEM_KB} KB an H100 SM has</text>
            <text x="18" y="350" class="pt">·</text><text x="28" y="350" class="legend">how many queries share a K/V head is only a count: the same kernel loads each K/V head once, runs them all</text>
            <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">MLA's k is {MLA_V} numbers of content + {MLA_K - MLA_V} of position; its v is the {MLA_V} alone: position only helps pick the tokens</text>
          </g>
        </g>
      {/if}

      <!-- 7: how many queries · prefill tiles versus decode rows, and what the reuse does to the time -->
      {#if cur.scene === 'shapes'}
        {@const CELL = 10}
        {@const N = 8}
        {@const T = 4}
        {@const GY = 88}
        {@const PXG = 56}
        {@const DXG = 396}
        {@const LIGHT = '#f4f2ec'}
        {@const DARK = '#d9d5cb'}
        {@const REUSE = 1}
        {@const chunkB = TILE_K * HD * 2 * BYTES}
        {@const readNs = chunkB / (BW * 1e3)}
        {@const mathNs = (u: number) => (u * chunkB) / (TFLOPS * 1e3)}
        {@const fmtNs = (ns: number) => (ns < 1 ? ns.toFixed(2) : ns < 10 ? ns.toFixed(1) : ns.toFixed(0)) + ' ns'}
        {@const BX = 180}
        {@const pxNs = 230 / mathNs(TILE_Q * GROUP)}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">what forces a new kernel · 2 of 4 · how many queries · S per head · red: one thread block's tile</text>
          <!-- prefill: rows are queries, columns are keys; one outlined column is one key's K/V, used by every query in the tile -->
          <g in:fade={{ delay: 100, duration: 250 }}>
            <text x="40" y="66" class="slab strong small">prefill · n queries × n keys</text>
            <text x={PXG} y={GY - 5} class="tag">keys →</text>
            <text x={PXG - 6} y={GY + (N * CELL) / 2} transform="rotate(-90 {PXG - 6} {GY + (N * CELL) / 2})" text-anchor="middle" class="tag">queries</text>
            {#each Array(N) as _, r}{#each Array(N) as _, c}
              {@const inTile = r >= T && c < T}
              <rect x={PXG + c * CELL} y={GY + r * CELL} width={CELL - 1} height={CELL - 1} fill={c > r ? LIGHT : inTile ? RED : DARK} opacity={inTile ? 0.85 : 1} />
            {/each}{/each}
            <rect x={PXG + REUSE * CELL - 1.5} y={GY + T * CELL - 1.5} width={CELL + 2} height={T * CELL + 2} fill="none" stroke="var(--fg)" stroke-width="1.5" />
            {#each [{ y: 90, fill: LIGHT, t: 'skipped: keys after the query (Ch. 2 Step 7)' }, { y: 104, fill: DARK, t: 'scored in other tiles' }] as k}
              <rect x={PXG + N * CELL + 14} y={k.y - 8} width="8" height="8" fill={k.fill} stroke="var(--line)" />
              <text x={PXG + N * CELL + 26} y={k.y} class="tag">{k.t}</text>
            {/each}
            <text x={PXG + N * CELL + 14} y="124" class="tag strong">one tile: {T} queries × {T} keys</text>
            <rect x={PXG + N * CELL + 14} y="130" width="8" height="8" fill="none" stroke="var(--fg)" stroke-width="1.5" />
            <text x={PXG + N * CELL + 26} y="138" class="tag">one key's K/V: loaded once, used {T} times</text>
            <text x={PXG + N * CELL + 14} y="158" class="tag strong">real: {TILE_Q} queries × {GROUP} heads (step {at('heads')})</text>
            <text x={PXG + N * CELL + 14} y="172" class="tag strong">= {TILE_Q * GROUP} uses per byte</text>
          </g>
          <!-- decode: one row, so each key's column holds one query -->
          <g in:fade={{ delay: 600, duration: 250 }}>
            <text x={DXG} y="66" class="slab strong small">decode · 1 query × n keys</text>
            <text x={DXG} y={GY - 5} class="tag">keys →</text>
            {#each Array(N) as _, c}
              <rect x={DXG + c * CELL} y={GY} width={CELL - 1} height={CELL - 1} fill={c < T ? RED : DARK} opacity={c < T ? 0.85 : 1} />
            {/each}
            <rect x={DXG + REUSE * CELL - 1.5} y={GY - 1.5} width={CELL + 2} height={CELL + 2} fill="none" stroke="var(--fg)" stroke-width="1.5" />
            <rect x={DXG + N * CELL + 14} y="82" width="8" height="8" fill={DARK} stroke="var(--line)" />
            <text x={DXG + N * CELL + 26} y="90" class="tag">scored in other tiles</text>
            <text x={DXG + N * CELL + 14} y="104" class="tag">one row: nothing to skip</text>
            <text x={DXG + N * CELL + 14} y="124" class="tag strong">one tile: 1 query × {T} keys</text>
            <rect x={DXG + N * CELL + 14} y="130" width="8" height="8" fill="none" stroke="var(--fg)" stroke-width="1.5" />
            <text x={DXG + N * CELL + 26} y="138" class="tag">one key's K/V: loaded once, used once</text>
            <text x={DXG + N * CELL + 14} y="158" class="tag strong">real: 1 query × {GROUP} heads</text>
            <text x={DXG + N * CELL + 14} y="172" class="tag strong">= {GROUP} uses per byte</text>
          </g>
          <!-- what the reuse does: one chunk of K and V, the time to read it against the time to use it -->
          <g in:fade={{ delay: 1200, duration: 250 }}>
            <line x1="30" y1="186" x2="690" y2="186" stroke="var(--line)" />
            <text x="40" y="210" class="slab strong small">one chunk of step {at('flash')}'s loop: K and V for {TILE_K} keys of one K/V head, {chunkB / 1024} KB</text>
            {#each [{ t: `decode · ${GROUP} uses`, s: 'the read sets the time', u: GROUP, y: 226 }, { t: `prefill · ${TILE_Q * GROUP} uses`, s: 'the math sets the time', u: TILE_Q * GROUP, y: 272 }] as r}
              {@const mw = Math.max(2, mathNs(r.u) * pxNs)}
              <text x="40" y={r.y + 11} class="tag strong">{r.t}</text>
              <text x="40" y={r.y + 25} class="tag">{r.s}</text>
              <rect x={BX} y={r.y} width={readNs * pxNs} height="12" rx="2" fill={RED} opacity="0.85" />
              <text x={BX + readNs * pxNs + 6} y={r.y + 10} class="tag">read · {chunkB / 1024} KB ÷ {BW} TB/s = <tspan class="strong">{fmtNs(readNs)}</tspan></text>
              <rect x={BX} y={r.y + 16} width={mw} height="12" rx="2" fill={GREEN} opacity="0.9" />
              <text x={BX + mw + 6} y={r.y + 26} class="tag">math · {r.u} × {chunkB / 1024} K flops ÷ {TFLOPS} TFLOP/s = <tspan class="strong">{fmtNs(mathNs(r.u))}</tspan></text>
            {/each}
            <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">a use is one multiply-add on a 2-byte number: 1 flop per byte · the bars are equal at {TFLOPS} ÷ {BW} ≈ {BAL} uses, Ch. 4 Step 8's balance point</text>
          </g>
          <text x="16" y="362" class="legend" in:fade={{ delay: 1800 }}>so every backend has two kernels: <tspan class="mono">forward_extend</tspan> for prefill (it extends a cached prefix, Ch. 8 Step 2) and <tspan class="mono">forward_decode</tspan></text>
        </g>
      {/if}

      <!-- 8: how many queries, continued · decode at batch 1, without and with the split, same layout, same scale -->
      {#if cur.scene === 'split'}
        {@const BARW = 256}
        {@const SEG = BARW / SPLITS}
        {@const COLS = 12}
        {@const SM = 6}
        {@const ROWH = 12}
        {@const BY = 124}
        {@const GRIDY = 242}
        {@const going = phase >= 1}
        {@const BUSY = 'var(--fg)'}
        {@const IDLE = '#e8e5dd'}
        {@const ms = (t: number) => (t < 0.1 ? t.toFixed(3) + ' ms' : fmtMs(t))}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">what forces a new kernel · 2 of 4, continued · decode, one layer · red: K and V read so far</text>
          <text x="16" y="62" class="tag">one request, {CTX_DEC.toLocaleString()} tokens of context: its one query reads {CTX_DEC.toLocaleString()} keys in each of {KV_HEADS} K/V heads (step {at('heads')})</text>
          <line x1="360" y1="78" x2="360" y2="312" stroke="var(--line)" />
          {#each [{ px: 30, split: false }, { px: 370, split: true }] as p}
            {@const x0 = p.px + 10}
            {@const lit = p.split ? KV_HEADS * SPLITS : KV_HEADS}
            {@const pulled = (BW * lit) / SMS}
            {@const tx = x0 + COLS * SM + 12}
            <text x={x0} y="88" class="boxtitle">{p.split ? 'with the split' : 'without the split'}</text>
            <text x={x0} y="104" class="slab strong small">{p.split ? `${SPLITS} blocks per K/V head: ${lit} blocks` : `one block per K/V head: ${lit} blocks`}</text>
            <text x={x0} y="118" class="tag">{p.split ? `each walks ${CTX_DEC / SPLITS} keys · ${SPLITS} is the most with ${KV_HEADS} × ${SPLITS} ≤ ${SMS}` : `each walks its head's ${CTX_DEC.toLocaleString()} keys, a chunk at a time (step ${at('flash')})`}</text>
            <!-- one bar per K/V head: that head's keys and values in this layer, read left to right -->
            {#each Array(KV_HEADS) as _, h}
              {@const y = BY + h * ROWH}
              {#if p.split}
                {#each Array(SPLITS) as _, s}
                  <rect x={x0 + s * SEG} y={y} width={SEG - 1} height={ROWH - 3} fill={IDLE} />
                  <rect x={x0 + s * SEG} y={y} width={SEG - 1} height={ROWH - 3} fill={RED} opacity="0.85"
                    style:transform-box="fill-box" style:transform-origin="left center"
                    style:transform="scaleX({going ? 1 : 0})" style:transition={going ? `transform ${FAST_MS}ms linear` : 'none'} />
                {/each}
                <rect x={x0 + BARW + 4} y={y} width="6" height={ROWH - 3} rx="1.5" fill={GREEN} opacity={phase >= 2 ? 0.95 : 0.15} />
              {:else}
                <rect x={x0} y={y} width={BARW - 1} height={ROWH - 3} fill={IDLE} />
                <rect x={x0} y={y} width={BARW - 1} height={ROWH - 3} fill={RED} opacity="0.85"
                  style:transform-box="fill-box" style:transform-origin="left center"
                  style:transform="scaleX({going ? 1 : 0})" style:transition={going ? `transform ${SLOW_MS}ms linear` : 'none'} />
              {/if}
            {/each}
            <text x={x0} y={BY + KV_HEADS * ROWH + 12} class="tag">{p.split ? `each piece: one block, ${CTX_DEC / SPLITS} keys · green: the merge` : `each bar: one K/V head, ${CTX_DEC.toLocaleString()} × ${HD} × k, v × 2 B = ${kvHeadLayerMB.toFixed(1)} MB`}</text>
            <!-- the SMs those blocks run on, in a colour of their own -->
            {#each Array(SMS) as _, k}
              <rect x={x0 + (k % COLS) * SM} y={GRIDY + Math.floor(k / COLS) * SM} width={SM - 1} height={SM - 1} fill={k < lit ? BUSY : IDLE} opacity={k < lit ? 0.75 : 1} />
            {/each}
            <rect x={tx} y={GRIDY + 1} width="8" height="8" fill={BUSY} opacity="0.75" />
            <text x={tx + 12} y={GRIDY + 9} class="tag strong">{lit} of the H100's {SMS} SMs busy</text>
            <text x={tx} y={GRIDY + 25} class="tag">{lit}/{SMS} × {BW} TB/s = {pulled.toFixed(2)} TB/s pulled</text>
            <text x={tx} y={GRIDY + 39} class="tag">{KV_HEADS} × {kvHeadLayerMB.toFixed(1)} MB ÷ {pulled.toFixed(2)} TB/s = {ms(tLayer(lit))}</text>
            <text x={tx} y={GRIDY + 57} class="tag strong">× {LAYERS} layers = {fmtMs(tLayer(lit) * LAYERS)}</text>
          {/each}
          <text x="18" y="332" class="pt">·</text><text x="28" y="332" class="legend">a block is one piece of a kernel; it runs on one SM, one of the H100's {SMS} processors (Ch. 13 Step 8)</text>
          <text x="18" y="350" class="pt">·</text><text x="28" y="350" class="legend">decode is memory-bound (step {at('shapes')}): more SMs pulling means the same bytes arrive sooner</text>
          <text x="18" y="368" class="pt">·</text><text x="28" y="368" class="legend">each piece ends with its own m, ℓ, out; a merge combines a head's {SPLITS} with step {at('flash')}'s rescaling</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">assumes each busy SM pulls an even 1/{SMS} of {BW} TB/s, a simplification</text>
        </g>
      {/if}

      <!-- 9: where K and V sit · without pages the kernel computes each row's address; with pages it looks the page up first -->
      {#if cur.scene === 'pages'}
        {@const X = 150}
        {@const CW = 36}
        {@const RX = 452}
        {@const edge = (i: number) => X + i * CW - 2}
        {@const packed = [...reqA.pages.map((_, t) => ({ r: reqA, t })), ...reqB.pages.map((_, t) => ({ r: reqB, t }))]}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">what forces a new kernel · 3 of 4 · where K and V sit · request A has {reqA.pages.length} tokens, B has {reqB.pages.length}</text>

          <!-- without pages: the requests' rows packed back to back -->
          <g in:fade={{ delay: 100, duration: 250 }}>
            <text x="40" y="64" class="boxtitle">without pages</text>
            <text x="40" y="80" class="slab strong small">each request's rows packed back to back, in one tensor</text>
            <text x="40" y="103" class="tag">one tensor</text>
            {#each packed as c, i}
              <rect x={X + i * CW} y="88" width={CW - 4} height="22" rx="4" fill={c.r.c} opacity="0.8" />
              <text x={X + i * CW + (CW - 4) / 2} y="103" text-anchor="middle" class="kname">{c.r.n}{c.t}</text>
            {/each}
            <text x={RX} y="97" class="tag">a row: one token's k and v</text>
            <text x={RX} y="111" class="tag">a {TILE_K}-key chunk: {TILE_K} neighbouring rows, one read</text>
            <text x={X} y="130" class="tag strong">B's token t is row {indptr[1]} + t: the kernel computes where it is</text>
          </g>
          <line x1="30" y1="142" x2="690" y2="142" stroke="var(--line)" />

          <!-- with pages: rows anywhere in a pool, found through two arrays -->
          <g in:fade={{ delay: 600, duration: 250 }}>
            <text x="40" y="160" class="boxtitle">with pages · Ch. 7 Step 4</text>
            <text x="40" y="176" class="slab strong small">each token's row in any free page of a shared pool</text>
            <text x="40" y="201" class="tag">the KV pool</text>
            {#each Array(POOL) as _, p}
              {@const owner = reqA.pages.includes(p) ? reqA : reqB.pages.includes(p) ? reqB : null}
              <rect x={X + p * CW} y="186" width={CW - 4} height="22" rx="4" fill={owner ? owner.c : '#f4f2ec'} opacity={owner ? 0.8 : 1} stroke={owner ? 'none' : 'var(--line)'} />
              <text x={X + p * CW + (CW - 4) / 2} y="201" text-anchor="middle" class={owner ? 'kname' : 'tag'}>{p}</text>
            {/each}
            <text x={X + POOL * CW + 8} y="201" class="tag">page numbers · a page holds one row</text>
          </g>
          <g in:fade={{ delay: 1000, duration: 250 }}>
            <text x="40" y="249" class="mono strong">kv_indices</text>
            {#each indices as v, i}
              {@const isB = i >= indptr[1]}
              <rect x={X + i * CW} y="236" width={CW - 4} height="18" rx="3" fill={isB ? reqB.c : reqA.c} opacity={isB ? 0.85 : 0.35} />
              <text x={X + i * CW + (CW - 4) / 2} y="249" text-anchor="middle" class="mono" fill={isB ? 'white' : 'var(--fg)'}>{v}</text>
            {/each}
            <text x={RX} y="249" class="tag">each token's page, request after request</text>
            {#each reqB.pages as p, j}
              <path d="M {X + (indptr[1] + j) * CW + (CW - 4) / 2} 233 L {X + p * CW + (CW - 4) / 2} 213" fill="none" stroke={reqB.c} stroke-width="1.2" marker-end="url(#ab-arrow-green)" opacity="0.8" />
            {/each}
            {#each indptr as v, i}
              <line x1={edge(v)} y1="232" x2={edge(v)} y2="258" stroke="var(--fg)" stroke-width="1.5" />
              <path d="M {X + i * CW + (CW - 4) / 2} 274 L {edge(v)} 260" fill="none" stroke="var(--faint)" stroke-width="1.2" />
            {/each}
            <text x="40" y="289" class="mono strong">kv_indptr</text>
            {#each indptr as v, i}
              <rect x={X + i * CW} y="276" width={CW - 4} height="18" rx="3" fill="white" stroke="var(--fg)" />
              <text x={X + i * CW + (CW - 4) / 2} y="289" text-anchor="middle" class="mono">{v}</text>
            {/each}
            <text x={RX} y="289" class="tag">where each request's slice starts</text>
            <text x={X} y="316" class="tag strong">B's token t: read its page from kv_indices[{indptr[1]} + t] first, then the row</text>
          </g>
          <g in:fade={{ delay: 1500 }}>
            <text x="18" y="342" class="pt">·</text><text x="28" y="342" class="legend">a kernel written for one tensor would read the wrong rows from a pool; reading through a table is another kernel</text>
            <text x="18" y="360" class="pt">·</text><text x="28" y="360" class="legend">kernels written for bigger pages (16 to 128 rows) look up once per page, not per token (step {at('backends')})</text>
            <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">the CPU rebuilds both arrays every batch, in <tspan class="mono">init_forward_metadata</tspan>: Ch. 12 Step 4's sequence boundaries</text>
          </g>
        </g>
      {/if}

      <!-- 10: which GPU · each generation adds units a kernel has to be written to use -->
      {#if cur.scene === 'hardware'}
        {@const C2 = 150}
        {@const C3 = 492}
        {@const gens = [
          { g: 'A100', s: 'Ampere, 2020', add: ['copies from HBM that run while the SM computes'], k: 'FlashAttention-2, FlashInfer' },
          { g: 'H100', s: 'Hopper, 2022', add: ['a unit that copies whole tiles by itself (TMA);', 'matmuls that run while the SM does other work; 8-bit numbers'], k: 'FlashAttention-3' },
          { g: 'B200', s: 'Blackwell, 2024', add: ['a separate memory for matmul results; 4-bit numbers'], k: "TensorRT-LLM's, FlashAttention-4" },
          { g: 'MI300', s: 'AMD, 2023', add: ['not NVIDIA: a different instruction set, no CUDA'], k: "aiter, AMD's library" },
        ]}
        {@const BX = 190}
        {@const BW3 = 400}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">what forces a new kernel · 4 of 4 · which GPU · the same loop, written for each generation</text>
          <text x="40" y="68" class="boxtitle">GPU</text>
          <text x={C2} y="68" class="boxtitle">new in this generation</text>
          <text x={C3} y="68" class="boxtitle">attention kernels for it</text>
          <line x1="30" y1="76" x2="690" y2="76" stroke="var(--line)" />
          {#each gens as r, i}
            {@const y = 94 + i * 38}
            <g in:fade={{ delay: 150 + i * 200, duration: 250 }}>
              <text x="40" y={y} class="mono strong">{r.g}</text>
              <text x="40" y={y + 14} class="tag">{r.s}</text>
              {#each r.add as line, k}<text x={C2} y={y + k * 14} class="tag">{line}</text>{/each}
              <text x={C3} y={y} class="tag strong">{r.k}</text>
              <line x1="30" y1={y + 22} x2="690" y2={y + 22} stroke="var(--line)" />
            </g>
          {/each}
          <!-- the evidence: one card, the old generation's kernel against its own -->
          <g in:fade={{ delay: 1100, duration: 250 }}>
            <text x="40" y="254" class="slab strong small">attention speed on one H100: math done per second, against its {TFLOPS} TFLOP/s peak</text>
            <text x="40" y="268" class="tag">a long prefill, compute-bound (step {at('shapes')}), with all {SMS} SMs busy in both · figures from the FlashAttention-3 paper, 2024</text>
            {#each [{ n: 'FlashAttention-2', w: 'written for A100', f: 0.35, y: 278 }, { n: 'FlashAttention-3', w: 'written for H100', f: 0.75, y: 302 }] as b}
              <text x="40" y={b.y + 12} class="tag strong">{b.n}</text>
              <rect x={BX} y={b.y} width={BW3} height="16" rx="3" fill="#e8e5dd" />
              <rect x={BX} y={b.y} width={BW3 * b.f} height="16" rx="3" fill={GREEN} opacity="0.9" />
              <text x={BX + BW3 * b.f - 6} y={b.y + 12} text-anchor="end" class="tag onbox">≈ {Math.round((b.f * TFLOPS) / 10) * 10} TFLOP/s · {Math.round(b.f * 100)}%</text>
              <text x={BX + BW3 + 8} y={b.y + 12} class="tag">{b.w}</text>
            {/each}
          </g>
          <g in:fade={{ delay: 1600 }}>
            <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">Triton, Ch. 13 Step 5's kernel language, compiles one source for any of these GPUs: portable, usually slower</text>
          </g>
        </g>
      {/if}

      <!-- 11: many kernels, one model · the map's inside column becomes one interface every backend fills -->
      {#if cur.scene === 'interface'}
        {@const BXL = 228}
        {@const BXR = 508}
        {@const CX = 544}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">many kernels, one model · sglang/srt/layers/attention/ · one base class, one subclass per backend</text>
          <text x="16" y="62" class="tag">the model is written once: it calls one interface, and every backend fills the same slots with its own kernels</text>

          <!-- the model: 32 layers, each calling the interface -->
          <g in:fade={{ delay: 100, duration: 250 }}>
            <text x="24" y="90" class="boxtitle">the model</text>
            {#each [8, 4, 0] as d}
              <rect x={24 + d} y={100 + d} width="164" height="62" rx="8" fill={d ? 'white' : '#fbfaf7'} stroke="var(--line)" />
            {/each}
            <text x="36" y="118" class="slab strong small">{LAYERS} layers, each with</text>
            <text x="36" y="136" class="mono">RadixAttention.forward</text>
            <text x="36" y="152" class="tag">its attention layer</text>
            <text x="24" y="190" class="tag">it never names a kernel</text>
          </g>

          <!-- the interface: the map's inside column, as methods -->
          <g in:fade={{ delay: 500, duration: 250 }}>
            <text x={BXL} y="90" class="boxtitle">AttentionBackend</text>
            <text x={BXR} y="90" text-anchor="end" class="tag">every backend has these</text>
            <rect x={BXL} y="98" width={BXR - BXL} height="204" rx="10" fill="#fbfaf7" stroke={RED} />
            <!-- the plan -->
            <rect x={BXL + 10} y="106" width={BXR - BXL - 20} height="36" rx="6" fill="white" stroke="var(--accent)" />
            <text x={BXL + 20} y="121" class="mono strong">init_forward_metadata(batch)</text>
            <text x={BXL + 20} y="135" class="tag">once per batch: kv_indices, kv_indptr (step {at('pages')})</text>
            <circle cx={BXR - 22} cy="124" r="7" fill="var(--fg)" opacity="0.8" /><text x={BXR - 22} y="127.5" text-anchor="middle" class="kname">3</text>
            <!-- the call, and the two kernels behind it -->
            <rect x={BXL + 10} y="152" width={BXR - BXL - 20} height="24" rx="6" fill="white" stroke="var(--fg)" />
            <text x={BXL + 20} y="168" class="mono strong">forward(q, k, v, layer, batch)</text>
            <circle cx={BXR - 22} cy="164" r="7" fill="var(--fg)" opacity="0.8" /><text x={BXR - 22} y="167.5" text-anchor="middle" class="kname">2</text>
            <path d="M {BXL + 70} 176 V 186" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#ab-arrow)" />
            <path d="M {BXR - 70} 176 V 186" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#ab-arrow)" />
            {#each [{ x: BXL + 10, n: 'forward_extend', t: `prefill · step ${at('shapes')}` }, { x: (BXL + BXR) / 2 + 3, n: 'forward_decode', t: `decode · steps ${at('shapes')}–${at('split')}` }] as k}
              <rect x={k.x} y="190" width={(BXR - BXL) / 2 - 13} height="40" rx="6" fill="var(--fg)" opacity="0.75" />
              <text x={k.x + 10} y="206" class="kname">{k.n}</text>
              <text x={k.x + 10} y="222" class="tag onbox">{k.t}</text>
            {/each}
            <!-- the graph buffers -->
            <rect x={BXL + 10} y="240" width={BXR - BXL - 20} height="52" rx="6" fill="white" stroke="var(--gen)" />
            <text x={BXL + 20} y="256" class="mono strong">init_cuda_graph_state(max_bs)</text>
            <text x={BXL + 20} y="271" class="tag">Ch. 11 Step 13's graph replays at fixed addresses, so</text>
            <text x={BXL + 20} y="284" class="tag">each step writes its plan into arrays made once</text>
          </g>
          <g in:fade={{ delay: 800, duration: 250 }}>
            <path d="M 196 130 H 210 V 164 H {BXL - 4}" fill="none" stroke="var(--fg)" stroke-width="1.5" marker-end="url(#ab-arrow)" />
            <text x="198" y="124" class="tag">calls</text>
          </g>

          <!-- the backends that fill the slots -->
          <g in:fade={{ delay: 1100, duration: 250 }}>
            <text x={CX} y="90" class="boxtitle">each fills them</text>
            {#each ['fa3', 'flashinfer', 'trtllm_mha', 'aiter', 'triton'] as n, i}
              <rect x={CX} y={100 + i * 26} width="146" height="20" rx="5" fill="white" stroke="var(--line)" />
              <text x={CX + 10} y={114 + i * 26} class="mono strong">{n}</text>
            {/each}
            <text x={CX} y="244" class="tag">…about two dozen in all</text>
            <path d="M {CX - 6} 164 H {BXR + 4}" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#ab-arrow)" />
            <text x={CX} y="266" class="tag">which one: heads <tspan class="strong">1</tspan> and GPU <tspan class="strong">4</tspan></text>
            <text x={CX} y="280" class="tag">on the map, step {at('backends')}</text>
          </g>

          <g in:fade={{ delay: 1500 }}>
            <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">numbered circles: rows of the map (step {at('map')}) · 2: how many queries · 3: where K and V sit</text>
            <text x="18" y="348" class="pt">·</text><text x="28" y="348" class="legend">swapping <tspan class="mono">--attention-backend</tspan> changes which class fills the slots; the model's code does not change</text>
            <text x="18" y="366" class="pt">·</text><text x="28" y="366" class="legend">both kernels also write the new token's k and v into the pool: only the backend knows where the pages are</text>
          </g>
        </g>
      {/if}

      <!-- 12: the backends, one row each, columns from the map -->
      {#if cur.scene === 'backends'}
        {@const cols = [{ t: 'backend', x: 30 }, { t: 'kernels from', x: 124 }, { t: 'heads', x: 244, m: 1 }, { t: 'page size', x: 366, m: 3 }, { t: 'GPU', x: 460, m: 4 }, { t: 'default for', x: 562 }]}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">--attention-backend · one row per backend · numbered columns are rows of the map, step {at('map')}</text>
          <text x="16" y="62" class="tag">which backend fills step {at('interface')}'s slots: each covers some head layouts, page sizes and GPUs, and SGLang picks by GPU and model</text>
          {#each cols as c}
            {#if c.m}
              <circle cx={c.x + 6} cy="84" r="6.5" fill="var(--fg)" opacity="0.8" />
              <text x={c.x + 6} y="87.5" text-anchor="middle" class="kname">{c.m}</text>
            {/if}
            <text x={c.m ? c.x + 17 : c.x} y="88" class="boxtitle">{c.t}</text>
          {/each}
          <line x1="30" y1="96" x2="690" y2="96" stroke="var(--line)" />
          {#each general as b, i}
            {@const y = 116 + i * 22}
            <g in:fade={{ delay: 200 + i * 130, duration: 200 }}>
              {#if b.n === 'fa3'}<rect x="24" y={y - 15} width="672" height="21" rx="5" fill="var(--accent-soft)" />{/if}
              <text x="30" y={y} class="mono strong">{b.n}</text>
              <text x="124" y={y} class="tag">{b.from}</text>
              <text x="244" y={y} class="tag">{b.heads}</text>
              <text x="366" y={y} class="tag">{b.page}</text>
              <text x="460" y={y} class="tag">{b.gpu}</text>
              <text x="562" y={y} class="tag strong">{b.def}</text>
            </g>
          {/each}
          <g in:fade={{ delay: 1100, duration: 200 }}>
            <line x1="30" y1="244" x2="690" y2="244" stroke="var(--line)" />
            <text x="30" y="264" class="boxtitle">MLA only</text>
            {#each mlaOnly as b, i}
              <text x={124 + i * 190} y="264" class="mono strong">{b.n}</text>
              <text x={124 + i * 190} y="278" class="tag">page {b.page}</text>
            {/each}
          </g>
          <g in:fade={{ delay: 1500 }}>
            <text x="18" y="312" class="pt">·</text><text x="28" y="312" class="legend">highlighted, this book's setup: Llama-3-8B (GQA) on an H100, page size 1. fa3 covers all three, and is the default</text>
            <text x="18" y="330" class="pt">·</text><text x="28" y="330" class="legend">every backend has both a prefill and a decode kernel, which is why map row 2 has no column</text>
            <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">source: docs.sglang.io and <tspan class="mono">get_default_attn_backend</tspan> · <tspan class="mono">attention_registry.py</tspan> maps about two dozen names</text>
          </g>
        </g>
      {/if}

      <!-- 13: closing · one request decoding alone: its next token, or its next 5 consecutive positions in one pass, cost about the same -->
      {#if cur.scene === 'closing'}
        {@const BX = 190}
        {@const BW2 = 400}
        {@const FIVE = 5}
        {@const attn = tLayer(KV_HEADS * SPLITS) * LAYERS}
        {@const mathMs = 0.016}
        {@const one = tMem + attn + mathMs}
        {@const five = tMem + attn + FIVE * mathMs}
        {@const perMs = BW2 / five}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">one request decoding alone (batch 1) · {fmtK(CTX_DEC)} tokens of context · attention split as in step {at('split')}</text>
          {#each [{ y: 78, t: 'next token', s: 'one position, as decode does', n: 1 }, { y: 146, t: `next ${FIVE} tokens`, s: `${FIVE} consecutive positions, one step`, n: FIVE }] as r, i}
            {@const tot = tMem + attn + r.n * mathMs}
            {@const mw = Math.max(3, r.n * mathMs * perMs)}
            <g in:fade={{ delay: 200 + i * 700, duration: 250 }}>
              <text x={BX - 12} y={r.y + 17} text-anchor="end" class="slab strong small">{r.t}</text>
              <text x={BX - 12} y={r.y + 31} text-anchor="end" class="tag">{r.s}</text>
              <rect x={BX} y={r.y} width={tMem * perMs} height="28" rx="4" fill="var(--gen)" opacity="0.85" />
              <rect x={BX + tMem * perMs} y={r.y} width={attn * perMs} height="28" rx="4" fill={RED} opacity="0.85" />
              <rect x={BX + (tMem + attn) * perMs + 1} y={r.y} width={mw} height="28" rx={Math.min(3, mw / 2)} fill={GREEN} />
              <text x={BX + tot * perMs + 10} y={r.y + 13} class="tag strong">{fmtMs(tot)}</text>
              <text x={BX + tot * perMs + 10} y={r.y + 26} class="tag">{fmtMs(tot / r.n)} per token</text>
              <text x={BX} y={r.y + 44} class="tag"><tspan fill="var(--gen)">weights {fmtMs(tMem)}</tspan> · <tspan fill={RED}>attention {fmtMs(attn)}</tspan> · <tspan fill={GREEN}>math {r.n > 1 ? `${r.n} × ${mathMs} = ${(r.n * mathMs).toFixed(2)}` : mathMs} ms</tspan></text>
            </g>
          {/each}
          <g in:fade={{ delay: 1500 }}>
            <text x="18" y="232" class="pt">·</text><text x="28" y="232" class="legend">one pass can compute consecutive positions, as prefill does for a prompt (Ch. 4 Step 3): the weights are read once for all {FIVE}</text>
            <text x="18" y="250" class="pt">·</text><text x="28" y="250" class="legend">the {FIVE} positions read the same cache: {FIVE} × {GROUP} = {FIVE * GROUP} uses per K/V byte, far below ~{BAL}, so attention stays {fmtMs(attn)} (step {at('shapes')})</text>
            <text x="18" y="268" class="pt">·</text><text x="28" y="268" class="legend">only the math grows, {mathMs} ms per position</text>
          </g>
          <g in:fade={{ delay: 2300 }}>
            <text x={W / 2} y="310" text-anchor="middle" class="focus">The next {FIVE} tokens in one step would take {fmtMs(five)}, not {FIVE} × {fmtMs(one)} = {fmtMs(FIVE * one)}.</text>
            <text x={W / 2} y="332" text-anchor="middle" class="legend">But each position's input is the token before it, and decode has only the last one.</text>
            <text x={W / 2} y="350" text-anchor="middle" class="legend">Where would the other {FIVE - 1} inputs come from?</text>
          </g>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">math per position: 16 GFLOP ÷ {TFLOPS} TFLOP/s = {mathMs} ms (Ch. 4 Step 5) · the new positions' own k and v writes are too small to draw</text>
        </g>
      {/if}

      {#if cur.scene === 'flash' || cur.scene === 'split'}<LoopProgress ms={lapMs} {lap} />{/if}
    </svg>
  </div>

  <StepControls {step} total={steps.length} caption={cur.caption} {prev} {next} onchange={(s) => (step = s)} />
</figure>

<style>
  .mono.faint { fill: var(--faint); }
  .legend .mono, .tag .mono { font-size: 10px; }
  .tag.strong, .tag .strong, .mono .strong { fill: var(--fg); font-weight: 600; }
  .focus { font-size: 13px; font-weight: 650; fill: var(--fg); }
  .math { font-size: 11px; color: var(--fg); line-height: 1; }
  .math :global(.katex) { font-size: 1.15em; }
</style>
