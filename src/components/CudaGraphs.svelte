<script lang="ts">
  import { fade, fly } from 'svelte/transition';
  import StepControls from './StepControls.svelte';
  import { chapters, type NavLink } from '../chapters';
  let { prev, next }: { prev?: NavLink; next?: NavLink } = $props();
  const chNum = (slug: string) => chapters.findIndex((c) => c.slug === slug) + 1;
  const CH_NEXT = chNum('12-piecewise-compile');

  // ---- Numbers: Llama-3-8B bf16 on one H100, as in chapters 4 to 10 ----------------------------------
  const W_GB = 16, BW = 3.35;
  const tMem = W_GB / BW;                                  // 4.8 ms: the GPU work of a decode step at small batch
  const LAYERS = 32;
  const KERNELS = 1000;
  const LAUNCH_US = 9;
  const launchMs = (KERNELS * LAUNCH_US) / 1000;           // 9 ms of CPU per step
  const REPLAY_US = 20;
  const kernelUs = (tMem * 1000 / KERNELS).toFixed(0);   // ~5 µs: the average kernel at batch 1
  const fmt = (ms: number) => (ms < 10 ? ms.toFixed(1) : ms.toFixed(0)) + ' ms';
  const CAPTURED = [1, 2, 4, 8, 16, 24, 32, 48, 64, 96, 128, 160, 256];

  type Scene = 'zoom' | 'layer' | 'lanes' | 'eager' | 'record' | 'replay' | 'shape' | 'ladder' | 'pad' | 'shapes' | 'buffers' | 'closing';
  interface Step { caption: string; scene: Scene; v?: number }
  const steps: Step[] = [
    { scene: 'zoom', v: 0, caption: `Back to chapter 9's three lanes. The scheduler's lane is a row of decode steps, ${fmt(tMem)} each. Pick one and zoom in.` },
    { scene: 'zoom', v: 1, caption: `One step is one forward pass through the whole model. Our example throughout is <b>Llama-3-8B</b>: an embedding, ${LAYERS} identical layers, a final projection to logits, then sampling. Almost all of the ${fmt(tMem)} is the ${LAYERS} layers.` },
    { scene: 'layer', caption: `Zoom into a layer and it isn't one thing either. The GPU runs it as 11 kernels: norm, QKV matmul, RoPE, attention, output matmul, add, norm, gate-up matmul, SiLU, down matmul, add. Times ${LAYERS}, plus the ends: about a thousand kernels a step.` },
    { scene: 'lanes', v: 0, caption: `Each kernel is launched by the CPU: Python, PyTorch's dispatcher, the CUDA driver, about ${LAUNCH_US} µs each. A thousand of them is ${fmt(launchMs)} of CPU work for a step whose GPU work is ${fmt(tMem)}. At small batch the GPU waits on its launcher.` },
    { scene: 'eager', caption: `Closer still. <b>Eager mode</b> is a conversation, one kernel at a time: Python calls PyTorch, the dispatcher picks a kernel, the driver hands it over. About ${LAUNCH_US} µs to ask, ${kernelUs} µs to run, then the GPU waits.` },
    { scene: 'record', caption: `<b>Recording.</b> Run the step once with capture on and nothing executes. Each launch is written down instead: which kernel, which addresses it reads and writes, how many rows. Built once at startup, not once per step.` },
    { scene: 'replay', caption: `<b>Replay.</b> One call hands the GPU the finished list, and it walks the entries itself, back to back. A thousand round trips became one, and the CPU is out of the loop for the rest of the step.` },
    { scene: 'lanes', v: 1, caption: `Back to the two lanes. The CPU spends ${REPLAY_US} µs, the GPU runs the thousand kernels back to back: ${fmt(tMem)}. The CPU is free for the whole step, which is exactly what chapter 10's overlap needed.` },
    { scene: 'shape', caption: `A recording is literal: this kernel, these addresses, this many rows. Give it more rows than it saw and the extra ones are never touched — including the output buffer the CPU reads afterwards. Nothing below the engine will stop you.` },
    { scene: 'ladder', caption: `But the running batch changes size every few steps as requests finish and join. So at startup the engine records a ladder of graphs, one per size: ${CAPTURED.slice(0, 4).join(', ')} … ${CAPTURED[CAPTURED.length - 1]}. A few seconds, once.` },
    { scene: 'pad', caption: `So a batch of 37 is padded up to the next rung, 48. The 11 dummy rows go through the whole step and their logits are thrown away, which still costs far less than a thousand launches.` },
    { scene: 'shapes', caption: `Only decode gets graphs: its batches are [B, 1], so the ladder covers them. Prefill is ragged, different every batch, and runs eagerly, which is fine because prefill is compute-bound anyway. Chapter 6's two shapes, again.` },
    { scene: 'buffers', caption: `The addresses are frozen, so nothing can be passed in as an argument. Instead each request's sampled token is written back into its own slot in the same buffer, and the same recording is replayed. Chapter 1's loop, in place.` },
    { scene: 'closing', caption: `What a graph can't hold: anything data-dependent. MoE routing, speculative verification, attention plans that change shape, a .item() that syncs with the CPU. Cut the graph there and compile the rest: chapter ${CH_NEXT}.` },
  ];

  let step = $state(0);
  $effect(() => {
    const q = Number(new URLSearchParams(window.location.search).get('step'));
    if (q >= 1 && q <= steps.length) step = q - 1;
  });
  const cur = $derived(steps[step]);
  const v = $derived(cur.v ?? 0);
  const W = 720, H = 400;

  // ---- zoom: chapter 9's lanes, then one step fills the width ------------------------------------------
  const TL = { x: 150, pxPerMs: 13 };
  const LANE = { server: 70, sched: 122, detok: 174 };
  const PICK = 2;                                           // which decode step we zoom into
  const BAR = { x: 60, y: 70, w: 600, h: 34 };
  const small = { x: TL.x + PICK * tMem * TL.pxPerMs, y: LANE.sched, w: tMem * TL.pxPerMs - 1, h: 28 };
  const zoomT = $derived(v === 0
    ? `translate(${small.x - BAR.x}px, ${small.y - BAR.y}px) scale(${small.w / BAR.w}, ${small.h / BAR.h})`
    : 'translate(0px, 0px) scale(1, 1)');

  // one layer's kernels, widths ∝ rough time share at small batch
  const layerOps = [
    { n: 'norm', w: 3, c: '#8a8780' }, { n: 'qkv', w: 10, c: 'var(--accent)' }, { n: 'rope', w: 2, c: '#8a8780' }, { n: 'attn', w: 8, c: 'var(--gen)' },
    { n: 'o', w: 6, c: 'var(--accent)' }, { n: 'add', w: 1.5, c: '#8a8780' }, { n: 'norm', w: 3, c: '#8a8780' }, { n: 'gate·up', w: 18, c: 'var(--accent)' },
    { n: 'silu', w: 2, c: '#8a8780' }, { n: 'down', w: 12, c: 'var(--accent)' }, { n: 'add', w: 1.5, c: '#8a8780' },
  ];
  const layerTotal = layerOps.reduce((a, o) => a + o.w, 0);
  // the step bar, as segments: embed, 32 layers, lm_head, sample (share of the 600px)
  const ENDS = { embed: 8, head: 22, sample: 10 };
  const layersW = BAR.w - ENDS.embed - ENDS.head - ENDS.sample;

  // ---- recording scene -----------------------------------------------------------------------------------
  const recorded = [
    { k: 'norm', a: '0x7f10', b: '0x7f11' }, { k: 'qkv', a: '0x7f11', b: '0x7f12' }, { k: 'rope', a: '0x7f12', b: '0x7f12' },
    { k: 'attn', a: '0x7f12', b: '0x7f13' }, { k: 'o', a: '0x7f13', b: '0x7f14' }, { k: 'add', a: '0x7f14', b: '0x7f10' },
  ];
  // one frame for the eager / record / replay trio: the boxes hold still, only their contents change
  const FR = { cpu: 40, cpuW: 190, graph: 258, graphW: 300, gpu: 580, gpuW: 116, y: 64, h: 252 };
  // Three decode steps in a row. A decode step feeds ONE new token per request, so ids is [B]:
  // the rows are requests, not positions in a sequence. stepIds[c] is step c's ids; stepIds[c+1] is
  // what it samples, which is why the sampled column and the next step's ids column are the same list.
  const B_EX = 48;
  const OURS = 1;                                   // the request we follow, with chapter 1's tokens
  const stepIds = [[92, 374, 1120], [41, 12366, 887], [5, 13, 62], [77, 2, 300]];
  const decode: Record<number, string> = { 374: '" is"', 12366: '" Paris"', 13: '"."', 2: '<EOS>' };
  const trip = recorded.slice(0, 4);      // the round trips drawn in the eager ladder
  const listed = recorded.slice(0, 5);    // the entries drawn in the graph list

  // ---- ladder scene: running batch size over steps --------------------------------------------------------
  const sizes = [37, 37, 38, 38, 36, 36, 36, 41, 41, 40, 44, 44, 43, 43, 43, 51, 51, 50, 50, 48, 48, 61, 61, 60, 59, 59, 59, 58, 66, 66, 65, 65, 70, 70, 69, 69, 68, 72, 72, 71];
  const padTo = (n: number) => CAPTURED.find((c) => c >= n) ?? CAPTURED[CAPTURED.length - 1];
</script>

<figure class="viz">
  <div class="canvas">
    <svg viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="CUDA graphs, step {step + 1}">
      <defs>
        <marker id="cg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#b8b4aa" />
        </marker>
        <marker id="cg-arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
        </marker>
        <marker id="cg-arrow-back" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#b8b4aa" />
        </marker>
      </defs>

      <!-- 1–2: from chapter 9's lanes into one step -->
      {#if cur.scene === 'zoom'}
        <g transition:fade={{ duration: 250 }}>
          {#if v === 0}
            <g out:fade={{ duration: 300 }}>
              <text x="16" y="44" class="rowlabel">chapter 9 · three processes · the scheduler's lane is decode steps</text>
              {#each [['server + tokenizer', LANE.server], ['scheduler + GPU', LANE.sched], ['detokenizer', LANE.detok]] as [name, y]}
                <text x={TL.x - 10} y={(y as number) + 18} text-anchor="end" class="rowlabel">{name}</text>
                <line x1={TL.x} y1={(y as number) + 14} x2={TL.x + 25 * TL.pxPerMs} y2={(y as number) + 14} stroke="var(--line)" />
              {/each}
              {#each [{ t: 0.9, ms: 2.1 }, { t: 5.5, ms: 0.6 }, { t: 10.3, ms: 0.6 }, { t: 11, ms: 1.6 }, { t: 15.1, ms: 0.6 }, { t: 19.9, ms: 0.6 }] as sg}
                <rect x={TL.x + sg.t * TL.pxPerMs} y={LANE.server} width={Math.max(3, sg.ms * TL.pxPerMs - 1)} height="28" rx="3" fill="var(--accent)" opacity="0.85" />
              {/each}
              {#each Array(5) as _, i}
                {#if i !== PICK}
                  <rect x={TL.x + i * tMem * TL.pxPerMs} y={LANE.sched} width={tMem * TL.pxPerMs - 1} height="28" rx="3" fill="var(--gen)" opacity="0.85" />
                  <text x={TL.x + (i + 0.5) * tMem * TL.pxPerMs} y={LANE.sched + 18} text-anchor="middle" class="steplabel">step</text>
                {/if}
              {/each}
              {#each Array(4) as _, i}
                <rect x={TL.x + ((i + 1) * tMem + 0.1) * TL.pxPerMs} y={LANE.detok} width="5" height="28" rx="2" fill="#0891b2" opacity="0.9" />
              {/each}
              <line x1={TL.x} y1="220" x2={TL.x + 25 * TL.pxPerMs} y2="220" stroke="var(--line)" />
              {#each [0, 5, 10, 15, 20] as ms}<text x={TL.x + ms * TL.pxPerMs} y="234" text-anchor="middle" class="tag">{ms} ms</text>{/each}
              <g in:fade={{ delay: 800 }}>
                <rect x={small.x - 4} y={small.y - 4} width={small.w + 8} height={small.h + 8} rx="5" fill="none" stroke="var(--fg)" stroke-width="1.5" stroke-dasharray="4 3" />
                <text x={small.x + small.w / 2} y={small.y - 10} text-anchor="middle" class="tag strong">this one</text>
              </g>
            </g>
          {:else}
            <g in:fade={{ delay: 500 }}>
              <text x="16" y="44" class="rowlabel">one decode step · Llama-3-8B · {fmt(tMem)} of GPU time</text>
              <!-- segment separators drawn over the zoomed bar -->
              <text x={BAR.x + ENDS.embed / 2} y={BAR.y + BAR.h + 16} text-anchor="middle" class="tag">embed</text>
              {#each Array(LAYERS) as _, l}
                <line x1={BAR.x + ENDS.embed + (l / LAYERS) * layersW} y1={BAR.y} x2={BAR.x + ENDS.embed + (l / LAYERS) * layersW} y2={BAR.y + BAR.h} stroke="white" stroke-width="1.5" in:fade={{ delay: 500 + l * 25 }} />
              {/each}
              <line x1={BAR.x + ENDS.embed + layersW} y1={BAR.y} x2={BAR.x + ENDS.embed + layersW} y2={BAR.y + BAR.h} stroke="white" stroke-width="1.5" />
              <line x1={BAR.x + ENDS.embed + layersW + ENDS.head} y1={BAR.y} x2={BAR.x + ENDS.embed + layersW + ENDS.head} y2={BAR.y + BAR.h} stroke="white" stroke-width="1.5" />
              <text x={BAR.x + ENDS.embed + layersW / 2} y={BAR.y + BAR.h + 16} text-anchor="middle" class="tag strong">{LAYERS} layers, identical in shape, different weights</text>
              <text x={BAR.x + BAR.w} y={BAR.y + BAR.h + 16} text-anchor="end" class="tag">lm_head · sample</text>
              <g in:fade={{ delay: 1400 }}>
                <text x={BAR.x} y="180" class="legend">the model, once: <tspan class="strong">ids → embedding → layer 1 → layer 2 → … → layer {LAYERS} → logits → one token</tspan></text>
                <text x={BAR.x} y="204" class="legend muted">every layer reads its slice of the 16 GB of weights (chapter 4) and its slice of the KV cache (chapter 3)</text>
                <text x={BAR.x} y="236" class="legend muted">each layer is a few hundred microseconds; the picture is about to get finer</text>
              </g>
            </g>
          {/if}
          <!-- the picked step: the same rect in both views, transformed -->
          <rect x={BAR.x} y={BAR.y} width={BAR.w} height={BAR.h} rx="4" fill="var(--gen)" opacity="0.9" class="zoomrect" style:transform={zoomT} />
          {#if v === 0}<text x={small.x + small.w / 2} y={small.y + 18} text-anchor="middle" class="steplabel">step</text>{/if}
        </g>
      {/if}

      <!-- 3: one layer, 11 kernels -->
      {#if cur.scene === 'layer'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="44" class="rowlabel">one decode step · {LAYERS} layers · one of them zoomed</text>
          <rect x={BAR.x} y={BAR.y} width={BAR.w} height={BAR.h} rx="4" fill="var(--gen)" opacity="0.35" />
          {#each Array(LAYERS) as _, l}
            <line x1={BAR.x + ENDS.embed + (l / LAYERS) * layersW} y1={BAR.y} x2={BAR.x + ENDS.embed + (l / LAYERS) * layersW} y2={BAR.y + BAR.h} stroke="white" stroke-width="1.5" />
          {/each}
          <rect x={BAR.x + ENDS.embed + (5 / LAYERS) * layersW} y={BAR.y} width={layersW / LAYERS} height={BAR.h} fill="var(--gen)" />
          <text x={BAR.x + ENDS.embed + (5.5 / LAYERS) * layersW} y={BAR.y - 6} text-anchor="middle" class="tag strong">layer 6</text>
          <g in:fade={{ delay: 400 }}>
            <path d="M {BAR.x + ENDS.embed + (5 / LAYERS) * layersW} {BAR.y + BAR.h} L 100 172 M {BAR.x + ENDS.embed + (6 / LAYERS) * layersW} {BAR.y + BAR.h} L 660 172" fill="none" stroke="var(--faint)" stroke-dasharray="3 3" />
            <text x="126" y="164" class="rowlabel">one layer · {layerOps.length} kernels · ~{(tMem * 1000 / LAYERS).toFixed(0)} µs</text>
            {#each layerOps as o, k}
              {@const x0 = 100 + (layerOps.slice(0, k).reduce((a, p) => a + p.w, 0) / layerTotal) * 560}
              {@const w = (o.w / layerTotal) * 560}
              <rect x={x0 + 1} y="176" width={w - 2} height="40" rx="4" fill={o.c} opacity="0.9" in:fly={{ y: 6, delay: 500 + k * 70, duration: 200 }} />
              {#if w > 26}<text x={x0 + w / 2} y="200" text-anchor="middle" class="steplabel">{o.n}</text>{/if}
            {/each}
            <rect x="100" y="234" width="12" height="12" rx="2" fill="var(--accent)" /><text x="118" y="244" class="tag">matmul against the weights</text>
            <rect x="330" y="234" width="12" height="12" rx="2" fill="var(--gen)" /><text x="348" y="244" class="tag">attention over the KV cache</text>
            <rect x="530" y="234" width="12" height="12" rx="2" fill="#8a8780" /><text x="548" y="244" class="tag">everything else</text>
          </g>
          <g in:fade={{ delay: 1600 }}>
            <text x="16" y="296" class="legend">{layerOps.length} × {LAYERS} = {layerOps.length * LAYERS}, plus the ends and every small PyTorch op between them: <tspan class="strong">about {KERNELS.toLocaleString()} kernels a step</tspan></text>
            <text x="16" y="320" class="legend muted">at batch size 1 the average one runs for about {(tMem * 1000 / KERNELS).toFixed(0)} µs. Keep that number in mind.</text>
          </g>
        </g>
      {/if}

      <!-- 4 and 8: CPU launch lane vs GPU lane -->
      {#if cur.scene === 'lanes'}
        {@const graph = v === 1}
        {@const px = 52}
        {@const X0 = 150}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="52" class="rowlabel">{graph ? 'the same step, replayed from a CUDA graph' : 'the same step, launched kernel by kernel (eager mode)'} · batch size 1</text>
          <text x={X0 - 10} y="112" text-anchor="end" class="rowlabel">CPU · launches</text>
          {#if !graph}<text x={X0 - 10} y="126" text-anchor="end" class="tag">{KERNELS.toLocaleString()} × {LAUNCH_US} µs = {fmt(launchMs)}</text>{/if}
          <text x={X0 - 10} y="172" text-anchor="end" class="rowlabel">GPU · runs</text>
          <text x={X0 - 10} y="186" text-anchor="end" class="tag">{fmt(tMem)} of work</text>
          {#if !graph}
            {#each Array(40) as _, i}
              {@const t = (i / 40) * launchMs}
              <rect x={X0 + t * px} y="100" width={(launchMs / 40) * px - 1.5} height="28" rx="2" fill="var(--accent)" opacity="0.85" in:fade={{ delay: i * 20, duration: 80 }} />
              <rect x={X0 + t * px + 2} y="160" width={((tMem / 40) * px) - 1.5} height="28" rx="2" fill="var(--gen)" opacity="0.85" in:fade={{ delay: i * 20 + 30, duration: 80 }} />
            {/each}
            <g in:fade={{ delay: 1100 }}>
              <path d="M {X0} 214 H {X0 + launchMs * px}" fill="none" stroke="var(--eos)" stroke-width="1.5" />
              <text x={X0 + (launchMs * px) / 2} y="232" text-anchor="middle" class="tag" fill="var(--eos)">step = {fmt(launchMs)} · GPU busy {Math.round((tMem / launchMs) * 100)}% of it</text>
            </g>
          {:else}
            <rect x={X0} y="100" width="4" height="28" rx="1" fill="var(--accent)" in:fade />
            <text x={X0 + 10} y="118" class="tag">one launch · {REPLAY_US} µs · then the CPU is free</text>
            <rect x={X0} y="160" width={tMem * px} height="28" rx="3" fill="var(--gen)" opacity="0.85" in:fly={{ x: -20, duration: 400 }} />
            <text x={X0 + (tMem * px) / 2} y="178" text-anchor="middle" class="steplabel">{KERNELS.toLocaleString()} kernels, back to back</text>
            <g in:fade={{ delay: 700 }}>
              <path d="M {X0} 214 H {X0 + tMem * px}" fill="none" stroke="#16a34a" stroke-width="1.5" />
              <text x={X0 + (tMem * px) / 2} y="232" text-anchor="middle" class="tag" fill="#16a34a">step = {fmt(tMem)} · GPU busy ~100%</text>
            </g>
          {/if}
          <line x1={X0} y1="256" x2={X0 + 10 * px} y2="256" stroke="var(--line)" />
          {#each [0, 2, 4, 6, 8, 10] as ms}<text x={X0 + ms * px} y="270" text-anchor="middle" class="tag">{ms} ms</text>{/each}
          <g in:fade={{ delay: 1500 }}>
            {#if !graph}
              <text x="16" y="318" class="legend">the GPU finishes each {(tMem * 1000 / KERNELS).toFixed(0)} µs kernel before the CPU has launched the next one, and idles in between</text>
              <text x="16" y="340" class="legend muted">this is why batch-1 decode in plain PyTorch runs at roughly half the speed the memory bandwidth allows</text>
            {:else}
              <text x="16" y="318" class="legend">the recording played back: <tspan class="mono">graph.replay()</tspan>, one driver call, no Python in the loop</text>
            {/if}
          </g>
        </g>
      {/if}

      <!-- 5: eager, one launch at a time -->
      {#if cur.scene === 'eager'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="44" class="rowlabel">eager · one launch per kernel · the first {trip.length} of about {KERNELS.toLocaleString()} in this step</text>

          <line x1="22" y1="96" x2="22" y2="296" stroke="var(--line)" marker-end="url(#cg-arrow)" />
          <text x="13" y="196" text-anchor="middle" transform="rotate(-90 13 196)" class="tag">time</text>

          <rect x={FR.cpu} y={FR.y} width={FR.cpuW} height={FR.h} rx="12" fill="#fbfaf7" stroke="var(--accent)" />
          <text x="54" y="86" class="boxtitle">CPU · Python</text>
          <rect x={FR.gpu} y={FR.y} width={FR.gpuW} height={FR.h} rx="12" fill="#fbfaf7" stroke="var(--gen)" />
          <text x="594" y="86" class="boxtitle">GPU</text>
          <text x="404" y="86" text-anchor="middle" class="tag">driver · PCIe</text>

          {#each trip as r, i}
            {@const yc = 104 + i * 48}
            <g in:fade={{ delay: i * 520, duration: 200 }}>
              <rect x="54" y={yc - 11} width="162" height="22" rx="4" fill="var(--accent)" opacity="0.9" />
              <text x="64" y={yc + 4} class="kname">launch {r.k}</text>
              <text x="206" y={yc + 4} text-anchor="end" class="steplabel">{LAUNCH_US} µs</text>
            </g>
            <path d="M 238 {yc} L 574 {yc + 13}" fill="none" stroke="var(--accent)" stroke-width="1.5" marker-end="url(#cg-arrow-hot)" in:fly={{ x: -330, delay: i * 520 + 180, duration: 300 }} />
            <g in:fade={{ delay: i * 520 + 400, duration: 200 }}>
              <rect x="592" y={yc + 3} width="92" height="22" rx="4" fill="var(--gen)" opacity="0.9" />
              <text x="600" y={yc + 18} class="kname">run {r.k}</text>
              <text x="678" y={yc + 18} text-anchor="end" class="steplabel">{kernelUs} µs</text>
            </g>
            {#if i < trip.length - 1}
              <g in:fade={{ delay: i * 520 + 580, duration: 200 }}>
                <rect x="592" y={yc + 29} width="92" height="16" rx="4" fill="none" stroke="var(--eos)" stroke-dasharray="3 3" opacity="0.6" />
                <text x="638" y={yc + 41} text-anchor="middle" class="tag" fill="var(--eos)">idle</text>
              </g>
            {/if}
          {/each}
          <text x="54" y="288" class="mono muted">… ×{KERNELS.toLocaleString()}</text>
          <text x="592" y="288" class="tag">… and waiting</text>

          <g in:fade={{ delay: 2400, duration: 300 }}>
            <path d="M 574 310 H 238" fill="none" stroke="var(--faint)" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#cg-arrow-back)" />
            <text x="404" y="302" text-anchor="middle" class="tag">one sync at the end of the step · the CPU reads the logits</text>
          </g>

          <text x="16" y="342" class="legend">nothing comes back per kernel — the launches go one way, a thousand of them: <tspan class="strong">{LAUNCH_US} µs to ask, {kernelUs} µs to run</tspan></text>
          <text x="16" y="364" class="legend muted">so the GPU's {fmt(tMem)} of real work is stretched over {fmt(launchMs)} of launching, idle in every gap</text>
        </g>
      {/if}

      <!-- 6: recording -->
      {#if cur.scene === 'record'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="44" class="rowlabel">recording · the same launches, with capture on · nothing executes</text>

          <rect x={FR.cpu} y={FR.y} width={FR.cpuW} height={FR.h} rx="12" fill="#fbfaf7" stroke="var(--accent)" />
          <text x="54" y="86" class="boxtitle">CPU · Python</text>
          <rect x={FR.gpu} y={FR.y} width={FR.gpuW} height={FR.h} rx="12" fill="#fbfaf7" stroke="var(--gen)" />
          <text x="594" y="86" class="boxtitle">GPU</text>

          <rect x={FR.graph} y="88" width={FR.graphW} height="228" rx="10" fill="white" stroke="var(--fg)" stroke-dasharray="4 3" />
          <text x="272" y="112" class="tag strong">the graph · a list of launches</text>

          {#each listed as r, i}
            {@const yc = 134 + i * 34}
            <g in:fade={{ delay: i * 420, duration: 200 }}>
              <rect x="54" y={yc - 11} width="162" height="22" rx="4" fill="var(--accent)" opacity="0.9" />
              <text x="64" y={yc + 4} class="kname">launch {r.k}</text>
            </g>
            <path d="M 236 {yc} H 254" fill="none" stroke="var(--accent)" stroke-width="1.5" marker-end="url(#cg-arrow-hot)" in:fade={{ delay: i * 420 + 160, duration: 200 }} />
            <g in:fly={{ x: -16, delay: i * 420 + 260, duration: 250 }}>
              <text x="272" y={yc + 4} class="mono">{i + 1}. {r.k}</text>
              <text x="340" y={yc + 4} class="mono muted">in {r.a}</text>
              <text x="404" y={yc + 4} class="mono muted">out {r.b}</text>
              <text x="472" y={yc + 4} class="mono muted">[64 rows]</text>
            </g>
          {/each}
          <text x="54" y="302" class="mono muted">… ×{KERNELS.toLocaleString()}</text>
          <text x="272" y="302" class="tag">… {KERNELS.toLocaleString()} entries · every address fixed</text>

          <g in:fade={{ delay: 2200, duration: 300 }}>
            <rect x="594" y="150" width="88" height="80" rx="8" fill="none" stroke="var(--faint)" stroke-dasharray="3 3" />
            <text x="638" y="184" text-anchor="middle" class="tag">nothing</text>
            <text x="638" y="200" text-anchor="middle" class="tag">runs yet</text>
          </g>

          <text x="16" y="342" class="legend">an entry pins the kernel, the addresses it reads and writes, and the row count — <tspan class="strong">no Python left in it</tspan></text>
          <text x="16" y="364" class="legend muted">the engine records once per rung at startup, not once per step</text>
        </g>
      {/if}

      <!-- 7: replay -->
      {#if cur.scene === 'replay'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="44" class="rowlabel">replay · one message, then the GPU walks the list by itself</text>

          <rect x={FR.cpu} y={FR.y} width={FR.cpuW} height={FR.h} rx="12" fill="#fbfaf7" stroke="var(--accent)" />
          <text x="54" y="86" class="boxtitle">CPU · Python</text>
          <rect x={FR.gpu} y={FR.y} width={FR.gpuW} height={FR.h} rx="12" fill="#fbfaf7" stroke="var(--gen)" />
          <text x="594" y="86" class="boxtitle">GPU</text>

          <rect x={FR.graph} y="88" width={FR.graphW} height="228" rx="10" fill="white" stroke="var(--fg)" stroke-dasharray="4 3" />
          <text x="272" y="112" class="tag strong">the graph, recorded last step</text>

          <text x="54" y="112" class="tag strong">one message · {REPLAY_US} µs</text>
          <rect x="54" y="123" width="162" height="22" rx="4" fill="var(--accent)" opacity="0.9" />
          <text x="64" y="138" class="kname">graph.replay()</text>
          <path d="M 236 134 H 254" fill="none" stroke="var(--accent)" stroke-width="2.5" marker-end="url(#cg-arrow-hot)" />
          <g in:fade={{ delay: 900, duration: 300 }}>
            <text x="54" y="180" class="tag">then nothing. The CPU is free</text>
            <text x="54" y="196" class="tag">for the rest of the step —</text>
            <text x="54" y="212" class="tag">chapter 10's overlap, paid for.</text>
          </g>

          {#each listed as r, i}
            {@const yc = 134 + i * 34}
            <text x="272" y={yc + 4} class="mono">{i + 1}. {r.k}</text>
            <text x="340" y={yc + 4} class="mono">@ {r.a}</text>
            <text x="412" y={yc + 4} class="mono muted">[64 rows]</text>
            <path d="M 562 {yc} H 576" fill="none" stroke="var(--accent)" stroke-width="1.5" marker-end="url(#cg-arrow-hot)" in:fade={{ delay: 400 + i * 260, duration: 180 }} />
            <g in:fade={{ delay: 500 + i * 260, duration: 200 }}>
              <rect x="592" y={yc - 11} width="92" height="22" rx="4" fill="var(--gen)" opacity="0.9" />
              <text x="600" y={yc + 4} class="kname">run {r.k}</text>
            </g>
          {/each}
          <text x="272" y="302" class="tag">… {KERNELS.toLocaleString()} entries</text>
          <text x="592" y="302" class="tag">… back to back</text>

          <text x="16" y="342" class="legend">every address was baked in at record time, so there is <tspan class="strong">nothing to pass and nothing to decide</tspan></text>
          <text x="16" y="364" class="legend muted">{fmt(launchMs)} of CPU became {REPLAY_US} µs. The GPU's {fmt(tMem)} is unchanged — and now it is the whole step.</text>
        </g>
      {/if}

      <!-- 9: the recording is literal about shape -->
      {#if cur.scene === 'shape'}
        {@const CW = 9}
        {@const IN = 30}
        {@const OUT = 400}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="44" class="rowlabel">one entry from a graph recorded at batch size 64</text>
          <rect x="30" y="60" width="660" height="52" rx="10" fill="white" stroke="var(--fg)" stroke-dasharray="4 3" />
          <text x="46" y="82" class="mono">2. qkv matmul · reads 0x7f11 <tspan class="strong">[64 × 4096]</tspan> · writes 0x7f12 <tspan class="strong">[64 × 12288]</tspan></text>
          <text x="46" y="100" class="tag">the row count and the addresses are part of the entry, not arguments</text>

          <text x={IN} y="136" class="boxtitle">rows handed to the replay</text>
          <text x={OUT} y="136" class="boxtitle">the buffer the CPU reads afterwards</text>

          <g in:fade={{ delay: 400 }}>
            <text x={IN} y="164" class="slab strong small">a batch of 64</text>
            {#each Array(16) as _, i}<rect x={IN + i * CW} y="172" width={CW - 2} height="22" rx="2" fill="var(--gen)" opacity="0.85" />{/each}
            <path d="M 300 183 H 386" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#cg-arrow)" />
            <text x="343" y="177" text-anchor="middle" class="tag">replay</text>
            {#each Array(16) as _, i}<rect x={OUT + i * CW} y="172" width={CW - 2} height="22" rx="2" fill="#16a34a" opacity="0.85" />{/each}
            <text x="556" y="190" class="verdict" fill="#16a34a">✓</text>
            <text x={IN} y="212" class="tag">64 rows in · exactly what the entry expects</text>
            <text x={OUT} y="212" class="tag">64 rows written · <tspan fill="#16a34a">every one is this step's</tspan></text>
          </g>

          <g in:fade={{ delay: 1200 }}>
            <text x={IN} y="252" class="slab strong small">a batch of 96</text>
            {#each Array(24) as _, i}<rect x={IN + i * CW} y="260" width={CW - 2} height="22" rx="2" fill={i < 16 ? 'var(--gen)' : 'var(--eos)'} opacity="0.85" />{/each}
            <path d="M 300 271 H 386" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#cg-arrow)" />
            <text x="343" y="265" text-anchor="middle" class="tag">replay</text>
            {#each Array(24) as _, i}
              {#if i < 16}
                <rect x={OUT + i * CW} y="260" width={CW - 2} height="22" rx="2" fill="#16a34a" opacity="0.85" />
              {:else}
                <rect x={OUT + i * CW} y="260" width={CW - 2} height="22" rx="2" fill="none" stroke="var(--eos)" stroke-dasharray="2 2" />
              {/if}
            {/each}
            <text x={OUT + 20 * CW} y="254" text-anchor="middle" class="tag" fill="var(--eos)">never written</text>
            <text x="628" y="278" class="verdict" fill="var(--eos)">✗</text>
            <text x={IN} y="300" class="tag">96 rows in · <tspan fill="var(--eos)">rows 65–96 were never in the recording</tspan></text>
            <text x={OUT} y="300" class="tag">still 64 written · <tspan fill="var(--eos)">the CPU reads last step's logits for 32 requests</tspan></text>
          </g>

          <g in:fade={{ delay: 2000 }}>
            <text x="30" y="332" class="legend">no error, no crash: shapes aren't arguments to <tspan class="mono">replay()</tspan>, they're inside the recording, so <tspan class="strong">CUDA has nothing to check</tspan></text>
            <text x="30" y="354" class="legend muted">the guard has to sit above it, in the engine — which is what the next two steps are</text>
          </g>
        </g>
      {/if}

      <!-- 10: batch size varies, so record a ladder -->
      {#if cur.scene === 'ladder'}
        {@const X = 60}
        {@const Y = 200}
        {@const px = 14}
        {@const py = 1.3}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="44" class="rowlabel">the running batch over 40 decode steps · requests finish, newcomers join</text>
          <line x1={X} y1={Y} x2={X + 40 * px} y2={Y} stroke="var(--line)" />
          {#each [0, 20, 40, 60, 80] as b}
            <line x1={X - 3} y1={Y - b * py} x2={X} y2={Y - b * py} stroke="var(--line)" />
            <text x={X - 7} y={Y - b * py + 3.5} text-anchor="end" class="tag">{b}</text>
          {/each}

          {#each sizes as n, i}
            <rect x={X + i * px} y={Y - n * py} width={px - 2} height={n * py} fill="var(--gen)" opacity="0.6" in:fade={{ delay: i * 30, duration: 120 }} />
            <rect x={X + i * px} y={Y - padTo(n) * py} width={px - 2} height="2" fill="var(--accent)" in:fade={{ delay: 1400 + i * 20, duration: 120 }} />
          {/each}
          <text x={X} y={Y + 18} class="tag" in:fade={{ delay: 1400 }}>bars: requests running · <tspan fill="var(--accent)" font-weight="600">dashes</tspan>: the rung it replays on</text>
          <g in:fade={{ delay: 2000 }}>
            <text x="16" y="250" class="rowlabel">so, at startup: one graph per rung</text>
            {#each CAPTURED as B, i}
              {@const x = 40 + i * 49}
              <rect {x} y="262" width="42" height="30" rx="6" fill="white" stroke="var(--accent)" in:fly={{ y: -6, delay: 2000 + i * 50, duration: 200 }} />
              <text x={x + 21} y="282" text-anchor="middle" class="cell">{B}</text>
            {/each}
            <text x="40" y="316" class="tag"><tspan class="mono">Capture cuda graph bs [{CAPTURED.join(', ')}]</tspan> · a few seconds, once</text>
            <text x="40" y="352" class="legend muted">rungs are closer together at small sizes, where a step is cheapest and padding would waste the most</text>
          </g>
        </g>
      {/if}

      <!-- 11: padding -->
      {#if cur.scene === 'pad'}
        {@const RUN = 37}
        {@const RUNG = padTo(RUN)}
        {@const CW = 624 / RUNG}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="44" class="rowlabel">a step arrives with {RUN} running requests · the ladder has 32 and {RUNG}</text>
          {#each CAPTURED as B, i}
            {@const x = 40 + i * 49}
            <rect {x} y="60" width="42" height="30" rx="6" fill={B === RUNG ? 'var(--accent)' : 'white'} stroke="var(--accent)" opacity={B === 32 || B === RUNG ? 1 : 0.4} />
            <text x={x + 21} y="80" text-anchor="middle" class={B === RUNG ? 'steplabel' : 'cell'} fill={B === RUNG ? 'white' : 'var(--fg)'}>{B}</text>
          {/each}
          <text x={40 + CAPTURED.indexOf(RUNG) * 49 + 21} y="108" text-anchor="middle" class="tag"><tspan class="strong">32</tspan> is too small → pad up to <tspan class="strong">{RUNG}</tspan>, the next rung</text>

          <g in:fade={{ delay: 500 }}>
            <text x="40" y="142" class="boxtitle">rows in</text>
            {#each Array(RUNG) as _, i}
              <rect x={40 + i * CW} y="150" width={CW - 2} height="26" rx="2" fill={i < RUN ? 'var(--gen)' : 'white'} stroke={i < RUN ? 'none' : 'var(--line)'} stroke-dasharray={i < RUN ? 'none' : '2 2'} opacity={i < RUN ? 0.85 : 1} in:fade={{ delay: 500 + i * 16, duration: 100 }} />
            {/each}
            <text x={40 + (RUN * CW) / 2} y="194" text-anchor="middle" class="tag"><tspan class="strong">{RUN} real</tspan></text>
            <text x={40 + RUN * CW + ((RUNG - RUN) * CW) / 2} y="194" text-anchor="middle" class="tag">{RUNG - RUN} dummy</text>
          </g>

          <g in:fade={{ delay: 1300 }}>
            <path d="M 360 200 V 214" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#cg-arrow)" />
            <rect x="256" y="220" width="208" height="28" rx="14" fill="var(--gen)" opacity="0.9" />
            <text x="360" y="239" text-anchor="middle" class="kname">replay the {RUNG} graph · {fmt(tMem)}</text>
            <path d="M 360 254 V 268" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#cg-arrow)" />
          </g>

          <g in:fade={{ delay: 1900 }}>
            <text x="40" y="288" class="boxtitle">logits out</text>
            {#each Array(RUNG) as _, i}
              <rect x={40 + i * CW} y="296" width={CW - 2} height="26" rx="2" fill={i < RUN ? '#16a34a' : 'none'} stroke={i < RUN ? 'none' : 'var(--eos)'} stroke-dasharray={i < RUN ? 'none' : '2 2'} opacity={i < RUN ? 0.85 : 1} />
            {/each}
            <text x={40 + (RUN * CW) / 2} y="340" text-anchor="middle" class="tag" fill="#16a34a">{RUN} → the sampler</text>
            <text x={40 + RUN * CW + ((RUNG - RUN) * CW) / 2} y="340" text-anchor="middle" class="tag" fill="var(--eos)">{RUNG - RUN} dropped</text>
            <text x="40" y="368" class="legend muted">{RUNG - RUN} wasted rows of a memory-bound step cost almost nothing; a thousand launches would have cost {fmt(launchMs)}</text>
          </g>
        </g>
      {/if}

      <!-- 12: decode only -->
      {#if cur.scene === 'shapes'}
        <g transition:fade={{ duration: 250 }}>
          <rect x="24" y="64" width="330" height="240" rx="12" fill="#fbfaf7" stroke="var(--gen)" />
          <text x="40" y="86" class="boxtitle">a decode batch</text>
          {#each Array(6) as _, i}
            <text x="40" y={116 + i * 18} class="cell">req {i + 1}</text>
            <rect x="82" y={105 + i * 18} width="10" height="14" rx="2" fill="var(--gen)" opacity="0.85" in:fade={{ delay: i * 60 }} />
          {/each}
          <text x="40" y="228" class="cell">… ×B</text>
          <text x="40" y="256" class="slab small">shape [B, 1] · only B changes</text>
          <text x="40" y="276" class="tag">a rung per B, padded up · <tspan class="strong" fill="#16a34a">replayable</tspan></text>

          <rect x="366" y="64" width="330" height="240" rx="12" fill="#fbfaf7" stroke="var(--accent)" />
          <text x="382" y="86" class="boxtitle">a prefill batch</text>
          {#each [18, 27, 11] as n, i}
            <text x="382" y={116 + i * 26} class="cell">seq {i + 1}</text>
            {#each Array(n) as _, t}
              <rect x={424 + t * 9.5} y={105 + i * 26} width="8" height="14" rx="2" fill="var(--accent)" opacity="0.85" in:fade={{ delay: (i * 20 + t) * 10, duration: 100 }} />
            {/each}
          {/each}
          <text x="382" y="228" class="cell">different lengths every batch</text>
          <text x="382" y="256" class="slab small">shape [Σ tokens, …] · ragged</text>
          <text x="382" y="276" class="tag">no two alike · <tspan class="strong" fill="var(--eos)">eager</tspan>, and fine: compute-bound anyway</text>
        </g>
      {/if}

      <!-- 13: the addresses are frozen, so how do the next tokens get in? -->
      {#if cur.scene === 'buffers'}
        {@const CX = [130, 330, 530]}
        {@const SLOT = [0, 1, 2]}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="44" class="rowlabel">three decode steps in a row · each row is a request, each column is a step</text>
          <text x="16" y="58" class="tag">{B_EX} = the rung this graph was recorded for · 128256 = tokens in Llama-3's vocabulary</text>

          <!-- one band per fixed address: the three boxes inside it are the same memory at three moments -->
          <rect x="120" y="80" width="562" height="92" rx="14" fill="#f4f2ec" stroke="var(--line)" />
          <rect x="120" y="214" width="562" height="40" rx="14" fill="#f4f2ec" stroke="var(--line)" />

          <text x="16" y="82" class="tag strong">ids @ 0x7f00</text>
          <text x="16" y="94" class="tag muted">one buffer</text>
          {#each SLOT as r}<text x="16" y={106 + r * 22} class="mono" fill={r === OURS ? 'var(--accent)' : 'var(--muted)'}>req {r}</text>{/each}
          <text x="16" y="168" class="mono muted">… {B_EX - 3} more</text>
          <text x="16" y="232" class="tag strong">logits @ 0x7f20</text>
          <text x="16" y="244" class="tag muted">one buffer</text>
          <text x="16" y="270" class="tag strong">sampled</text>
          {#each SLOT as r}<text x="16" y={282 + r * 22} class="mono" fill={r === OURS ? 'var(--accent)' : 'var(--muted)'}>req {r}</text>{/each}

          {#each CX as X, c}
            {@const cx = X + 70}
            <g in:fade={{ delay: c * 650, duration: 300 }}>
              <text x={cx} y="72" text-anchor="middle" class="rowlabel">step {c === 0 ? 't' : `t+${c}`}</text>

              <rect x={X} y="88" width="140" height="76" rx="8" fill="white" stroke="var(--accent)" />
              {#each SLOT as r}
                {@const id = stepIds[c][r]}
                <rect x={X + 10} y={93 + r * 22} width="120" height="18" rx="3" fill={r === OURS ? 'var(--accent-soft)' : 'none'} />
                <text x={X + 20} y={106 + r * 22} class={r === OURS ? 'mono ours' : 'mono'}>{id}</text>
                {#if r === OURS}<text x={X + 66} y={106 + r * 22} class="mono ours">{decode[id]}</text>{/if}
              {/each}

              <path d="M {cx} 168 V 178" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#cg-arrow)" />
              <rect x={X + 10} y="182" width="120" height="22" rx="11" fill="var(--gen)" opacity="0.9" />
              <text x={cx} y="197" text-anchor="middle" class="kname">replay</text>
              <path d="M {cx} 208 V 218" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#cg-arrow)" />

              <rect x={X} y="222" width="140" height="24" rx="6" fill="white" stroke="#16a34a" />
              <text x={cx} y="238" text-anchor="middle" class="mono">[ {B_EX} × 128256 ]</text>
              <path d="M {cx} 250 V 260" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#cg-arrow)" />

              <rect x={X} y="264" width="140" height="76" rx="8" fill="#fbfaf7" stroke="var(--accent)" />
              {#each SLOT as r}
                {@const id = stepIds[c + 1][r]}
                <rect x={X + 10} y={269 + r * 22} width="120" height="18" rx="3" fill={r === OURS ? 'var(--accent-soft)' : 'none'} />
                <text x={X + 20} y={282 + r * 22} class={r === OURS ? 'mono ours' : 'mono'}>{id}</text>
                {#if r === OURS}<text x={X + 66} y={282 + r * 22} class="mono ours">{decode[id]}</text>{/if}
              {/each}
            </g>

            {#if c < CX.length - 1}
              {@const gx = X + 165}
              <g in:fade={{ delay: c * 650 + 450, duration: 300 }}>
                <path d="M {X + 140} 300 H {gx} V 124 H {CX[c + 1] + 6}" fill="none" stroke="var(--accent)" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#cg-arrow-hot)" />
                <text x={gx - 6} y="213" text-anchor="middle" transform="rotate(-90 {gx - 6} 212)" class="tag">written back</text>
              </g>
            {/if}
          {/each}

          <g in:fade={{ delay: 2100 }}>
            <text x="16" y="360" class="legend">each shaded band is <tspan class="strong">one buffer</tspan> — the same memory at three moments, not three different places</text>
            <text x="16" y="380" class="legend muted">step t's sampled column is step t+1's ids column: the same {B_EX} slots overwritten in place, one request followed in blue</text>
          </g>
        </g>
      {/if}

      <!-- 14: what breaks a graph -->
      {#if cur.scene === 'closing'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="52" class="rowlabel">a graph is a fixed recording · these aren't fixed</text>
          {#each [
            { t: 'MoE routing', s: 'which experts run depends on the tokens', c: 'var(--accent)' },
            { t: 'speculative verification', s: 'how many drafts survive is data', c: 'var(--gen)' },
            { t: 'attention plans', s: 'some backends build per-batch shapes on the CPU', c: '#0891b2' },
            { t: 'a .item() anywhere', s: 'a sync with the CPU; a recording can\'t contain one', c: 'var(--eos)' },
          ] as row, i}
            {@const y = 74 + i * 52}
            <g in:fly={{ x: -8, delay: i * 200, duration: 300 }}>
              <rect x="30" y={y} width="660" height="40" rx="10" fill="#fbfaf7" stroke={row.c} />
              <text x="46" y={y + 25} class="slab strong small">{row.t}</text>
              <text x="250" y={y + 25} class="tag">{row.s}</text>
            </g>
          {/each}
          <g in:fade={{ delay: 1100 }}>
            <text x="30" y="312" class="legend muted">SGLang: <tspan class="mono">--enable-piecewise-cuda-graph</tspan> · <tspan class="mono">--enable-torch-compile</tspan></text>
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
  .cell { font-family: var(--mono); font-size: 10px; fill: var(--fg); }
  .mono { font-family: var(--mono); font-size: 10px; fill: var(--fg); }
  .mono.muted { fill: var(--muted); }
  .tag { font-size: 10px; fill: var(--muted); }
  .tag.strong, .tag .strong, .mono .strong { fill: var(--fg); font-weight: 600; }
  .steplabel { font-size: 10px; fill: white; font-weight: 600; }
  .kname { font-family: var(--mono); font-size: 10px; fill: white; font-weight: 600; }
  .boxtitle { font-family: var(--mono); font-size: 10.5px; fill: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .slab { font-size: 12px; fill: var(--fg); }
  .slab.small { font-size: 11.5px; }
  .slab.strong.small { font-size: 12px; font-weight: 650; }
  .verdict { font-size: 20px; font-weight: 700; }
  .ours { fill: var(--accent); font-weight: 700; }
  .legend { font-size: 11.5px; fill: var(--fg); }
  .legend .strong { font-weight: 650; }
  .legend.muted { fill: var(--muted); }
  .zoomrect { transform-box: fill-box; transform-origin: 0 0; transition: transform 800ms cubic-bezier(0.2, 0.8, 0.2, 1); }
</style>
