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
  const fmt = (ms: number) => (ms < 10 ? ms.toFixed(1) : ms.toFixed(0)) + ' ms';
  const CAPTURED = [1, 2, 4, 8, 16, 24, 32, 48, 64, 96, 128, 160, 256];

  type Scene = 'zoom' | 'layer' | 'lanes' | 'record' | 'shape' | 'ladder' | 'pad' | 'shapes' | 'buffers' | 'closing';
  interface Step { caption: string; scene: Scene; v?: number }
  const steps: Step[] = [
    { scene: 'zoom', v: 0, caption: `Back to chapter 9's three lanes. The scheduler's lane is a row of decode steps, ${fmt(tMem)} each. Pick one and zoom in.` },
    { scene: 'zoom', v: 1, caption: `One step is one forward pass through the whole model. Our example throughout is <b>Llama-3-8B</b>: an embedding, ${LAYERS} identical layers, a final projection to logits, then sampling. Almost all of the ${fmt(tMem)} is the ${LAYERS} layers.` },
    { scene: 'layer', caption: `Zoom into a layer and it isn't one thing either. The GPU runs it as 11 kernels: norm, QKV matmul, RoPE, attention, output matmul, add, norm, gate-up matmul, SiLU, down matmul, add. Times ${LAYERS}, plus the ends: about a thousand kernels a step.` },
    { scene: 'lanes', v: 0, caption: `Each kernel is launched by the CPU: Python, PyTorch's dispatcher, the CUDA driver, about ${LAUNCH_US} µs each. A thousand of them is ${fmt(launchMs)} of CPU work for a step whose GPU work is ${fmt(tMem)}. At small batch the GPU waits on its launcher.` },
    { scene: 'record', caption: `<b>Recording</b>: run the step once with capture on. Every launch is written down with the exact memory addresses it read and wrote. Replay hands the GPU that list. A thousand CPU-to-GPU round trips become one.` },
    { scene: 'lanes', v: 1, caption: `Replayed, the CPU spends ${REPLAY_US} µs and the GPU runs the thousand kernels back to back: ${fmt(tMem)}. The CPU is free for the whole step, which is exactly what chapter 10's overlap needed.` },
    { scene: 'shape', caption: `A recording is literal: this kernel, this many rows, these addresses. Feed it a different batch size and the recorded reads and writes land in the wrong places. A graph is valid only for the exact shapes it was recorded with.` },
    { scene: 'ladder', caption: `But the running batch changes size every few steps as requests finish and join. So at startup the engine records a ladder of graphs, one per size: ${CAPTURED.slice(0, 4).join(', ')} … ${CAPTURED[CAPTURED.length - 1]}. A few seconds, once.` },
    { scene: 'pad', caption: `At run time a batch of 37 is padded with 27 dummy rows and replayed on the 64 graph. The padding computes garbage nobody reads, and still beats a thousand launches.` },
    { scene: 'shapes', caption: `Only decode gets graphs: its batches are [B, 1], so the ladder covers them. Prefill is ragged, different every batch, and runs eagerly, which is fine because prefill is compute-bound anyway. Chapter 6's two shapes, again.` },
    { scene: 'buffers', caption: `Per step, the scheduler copies the new token ids, positions, and page tables into the graph's fixed buffers, replays, and reads the logits back out. The kernels read the buffers, never Python.` },
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

  // within-step phases for the recording animation
  let phase = $state(0);
  $effect(() => {
    const sc = steps[step].scene;
    phase = 0;
    const plan = sc === 'record' ? [2200, 4800] : [];
    const timers = plan.map((ms, i) => setTimeout(() => (phase = i + 1), ms));
    return () => timers.forEach(clearTimeout);
  });

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
            <text x="100" y="164" class="rowlabel">one layer · {layerOps.length} kernels · ~{(tMem * 1000 / LAYERS).toFixed(0)} µs</text>
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

      <!-- 4 and 6: CPU launch lane vs GPU lane -->
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
              <text x="16" y="318" class="legend">the recording from the last step, played back: <tspan class="mono">graph.replay()</tspan>, one driver call, no Python in the loop</text>
            {/if}
          </g>
        </g>
      {/if}

      <!-- 5: what recording means -->
      {#if cur.scene === 'record'}
        {@const mode = phase === 0 ? 'eager' : phase === 1 ? 'record' : 'replay'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="44" class="rowlabel">{mode === 'eager' ? 'eager · every kernel is a message from the CPU to the GPU' : mode === 'record' ? 'recording · run it once with capture on; the driver writes each launch down' : 'replay · one message; the GPU walks its own list'}</text>
          <rect x="30" y="70" width="180" height="250" rx="12" fill="#fbfaf7" stroke="var(--accent)" />
          <text x="46" y="92" class="boxtitle">CPU · Python</text>
          <rect x="510" y="70" width="180" height="250" rx="12" fill="#fbfaf7" stroke="var(--gen)" />
          <text x="526" y="92" class="boxtitle">GPU</text>
          <text x="360" y="92" text-anchor="middle" class="tag">driver · PCIe</text>

          {#if mode === 'eager'}
            {#each recorded as r, i}
              {@const y = 112 + i * 34}
              <g in:fade={{ delay: i * 320, duration: 200 }}>
                <text x="46" y={y + 13} class="mono">launch {r.k}(…)</text>
                <path d="M 214 {y + 8} H 502" fill="none" stroke="var(--accent)" stroke-width="1.5" marker-end="url(#cg-arrow-hot)" in:fly={{ x: -280, duration: 300 }} />
                <rect x="526" y={y} width="148" height="18" rx="4" fill="var(--gen)" opacity="0.85" in:fade={{ delay: 260 }} />
                <text x="600" y={y + 13} text-anchor="middle" class="steplabel">run {r.k}</text>
              </g>
            {/each}
            <text x="360" y="322" text-anchor="middle" class="tag">… ×{KERNELS.toLocaleString()} per step, {LAUNCH_US} µs each, in order, one at a time</text>
          {:else if mode === 'record'}
            {#each recorded as r, i}
              {@const y = 112 + i * 34}
              <g in:fade={{ delay: i * 280, duration: 200 }}>
                <text x="46" y={y + 13} class="mono">launch {r.k}(…)</text>
                <path d="M 214 {y + 8} H 360" fill="none" stroke="var(--accent)" stroke-width="1.5" marker-end="url(#cg-arrow-hot)" in:fly={{ x: -140, duration: 250 }} />
              </g>
            {/each}
            <rect x="372" y="104" width="300" height="216" rx="8" fill="white" stroke="var(--fg)" stroke-dasharray="4 3" in:fade />
            <text x="384" y="122" class="tag strong">the graph · a list, on the GPU side</text>
            {#each recorded as r, i}
              {@const y = 134 + i * 28}
              <g in:fly={{ x: -20, delay: i * 280 + 200, duration: 250 }}>
                <text x="384" y={y + 12} class="mono">{i + 1}. {r.k}</text>
                <text x="450" y={y + 12} class="mono muted">in {r.a} · out {r.b} · [64 rows]</text>
              </g>
            {/each}
            <text x="384" y="310" class="tag">… {KERNELS.toLocaleString()} entries · every address fixed</text>
          {:else}
            <text x="46" y="125" class="mono">graph.replay()</text>
            <path d="M 214 120 H 502" fill="none" stroke="var(--accent)" stroke-width="2.5" marker-end="url(#cg-arrow-hot)" in:fly={{ x: -280, duration: 350 }} />
            <text x="360" y="112" text-anchor="middle" class="tag strong">one message, {REPLAY_US} µs</text>
            <text x="46" y="160" class="tag" in:fade={{ delay: 500 }}>then nothing. The CPU is done</text>
            <text x="46" y="176" class="tag" in:fade={{ delay: 500 }}>with this step.</text>
            {#each recorded as r, i}
              {@const y = 140 + i * 26}
              <rect x="526" y={y} width="148" height="18" rx="4" fill="var(--gen)" opacity="0.85" in:fade={{ delay: 400 + i * 160, duration: 150 }} />
              <text x="600" y={y + 13} text-anchor="middle" class="steplabel" in:fade={{ delay: 400 + i * 160 }}>{i + 1}. {r.k} @ {r.a}</text>
            {/each}
            <text x="600" y="312" text-anchor="middle" class="tag" in:fade={{ delay: 1400 }}>… the GPU launches the rest itself</text>
          {/if}
          <text x="16" y="352" class="legend muted" in:fade={{ delay: 5600 }}>a graph is a recording of launches with their addresses baked in;</text>
          <text x="16" y="370" class="legend muted" in:fade={{ delay: 5600 }}>a replay is the GPU reading that recording without asking the CPU for anything</text>
        </g>
      {/if}

      <!-- 7: the recording is literal about shape -->
      {#if cur.scene === 'shape'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="44" class="rowlabel">one entry from a graph recorded at batch size 64</text>
          <rect x="30" y="60" width="660" height="52" rx="10" fill="white" stroke="var(--fg)" stroke-dasharray="4 3" />
          <text x="46" y="82" class="mono">2. qkv matmul · reads 0x7f11 <tspan class="strong">[64 × 4096]</tspan> · writes 0x7f12 <tspan class="strong">[64 × 12288]</tspan></text>
          <text x="46" y="100" class="tag">the row count and the addresses are part of the entry, not arguments</text>
          <g in:fade={{ delay: 500 }}>
            <text x="30" y="150" class="slab strong small">replay with a batch of 64</text>
            {#each Array(16) as _, i}<rect x={30 + i * 14} y="160" width="12" height="18" rx="2" fill="var(--gen)" opacity="0.85" />{/each}
            <text x="264" y="174" class="tag">64 rows in 0x7f11 → the kernel reads exactly what's there</text>
            <text x="30" y="210" class="tag" fill="#16a34a">✓ correct</text>
          </g>
          <g in:fade={{ delay: 1300 }}>
            <text x="30" y="250" class="slab strong small">replay with a batch of 96</text>
            {#each Array(24) as _, i}<rect x={30 + i * 14} y="260" width="12" height="18" rx="2" fill={i < 16 ? 'var(--gen)' : 'var(--eos)'} opacity="0.85" />{/each}
            <text x="376" y="274" class="tag">rows 65–96 were never in the recording</text>
            <text x="30" y="310" class="tag" fill="var(--eos)">✗ the kernel still reads 64 rows: 32 requests get no output, and the entry after it reads the wrong buffer</text>
          </g>
          <text x="30" y="360" class="legend muted" in:fade={{ delay: 2000 }}>a graph is only valid for the exact shapes it saw when recorded. The shapes are the price of skipping the CPU.</text>
        </g>
      {/if}

      <!-- 8: batch size varies, so record a ladder -->
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

      <!-- 9: padding -->
      {#if cur.scene === 'pad'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="44" class="rowlabel">a step arrives with 37 running requests · the ladder has 32 and 64</text>
          {#each CAPTURED as B, i}
            {@const x = 40 + i * 49}
            <rect {x} y="60" width="42" height="30" rx="6" fill={B === 64 ? 'var(--accent)' : 'white'} stroke="var(--accent)" opacity={B === 32 || B === 64 ? 1 : 0.4} />
            <text x={x + 21} y="80" text-anchor="middle" class={B === 64 ? 'steplabel' : 'cell'} fill={B === 64 ? 'white' : 'var(--fg)'}>{B}</text>
          {/each}
          <text x={40 + 8 * 49 + 21} y="108" text-anchor="middle" class="tag"><tspan class="strong">32</tspan> is too small → pad up to <tspan class="strong">64</tspan>, the next rung</text>
          <g in:fade={{ delay: 600 }}>
            {#each Array(64) as _, i}
              <rect x={40 + i * 10} y="140" width="8" height="26" rx="2" fill={i < 37 ? 'var(--gen)' : 'white'} stroke={i < 37 ? 'none' : 'var(--line)'} stroke-dasharray={i < 37 ? 'none' : '2 2'} opacity={i < 37 ? 0.85 : 1} in:fade={{ delay: 600 + i * 12, duration: 100 }} />
            {/each}
            <text x="40" y="188" class="tag"><tspan class="strong">37 real rows</tspan> · 27 padding rows filled with a dummy token</text>
          </g>
          <g in:fade={{ delay: 1800 }}>
            <text x="40" y="228" class="legend">replay the 64 graph · {fmt(tMem)} · the padding rows compute garbage, and their logits are dropped</text>
            <text x="40" y="250" class="legend muted">27 wasted rows of a memory-bound step cost almost nothing; a thousand launches would have cost {fmt(launchMs)}</text>
          </g>
        </g>
      {/if}

      <!-- 10: decode only -->
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

      <!-- 11: one replay from the scheduler's side -->
      {#if cur.scene === 'buffers'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="52" class="rowlabel">one replay, from the scheduler's point of view</text>
          {#each [
            { x: 30, c: 'var(--accent)', t: '1 · copy in', l: ['input_ids[:37] · positions[:37]', 'page tables · seq lens', 'a few memcpys, ~10 µs'] },
            { x: 260, c: 'var(--gen)', t: '2 · replay', l: ['graph.replay()', `${fmt(tMem)} of GPU`, '0 of Python'] },
            { x: 490, c: '#16a34a', t: '3 · read out', l: ['logits[:37] → sampler', 'rows 37–63: ignored', 'next step: back to 1'] },
          ] as b, i}
            <g in:fly={{ y: 8, delay: i * 350, duration: 300 }}>
              <rect x={b.x} y="76" width="200" height="104" rx="12" fill="#fbfaf7" stroke={b.c} />
              <text x={b.x + 14} y="100" class="slab strong small">{b.t}</text>
              {#each b.l as line, k}<text x={b.x + 14} y={122 + k * 17} class={k === 0 ? 'mono' : 'tag'}>{line}</text>{/each}
            </g>
          {/each}
          <path d="M 232 128 H 254" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#cg-arrow)" />
          <path d="M 462 128 H 484" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#cg-arrow)" />
          <g in:fade={{ delay: 1200 }}>
            <text x="30" y="232" class="legend">attention works the same way: its page table lives in a fixed buffer, so the recorded kernel serves every step</text>
            <text x="30" y="254" class="legend muted">same shapes, same addresses, new contents. Chapter 10's future-token slot was the same trick.</text>
          </g>
        </g>
      {/if}

      <!-- 12: what breaks a graph -->
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
            <text x="30" y="306" class="legend">next: <tspan class="strong">cut the graph</tspan> around the dynamic parts and replay the pieces, and <tspan class="strong">torch.compile</tspan> what's between them</text>
            <text x="30" y="344" class="legend muted">SGLang: <tspan class="mono">--enable-piecewise-cuda-graph</tspan> · <tspan class="mono">--enable-torch-compile</tspan></text>
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
  .boxtitle { font-family: var(--mono); font-size: 10.5px; fill: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .slab { font-size: 12px; fill: var(--fg); }
  .slab.small { font-size: 11.5px; }
  .slab.strong.small { font-size: 12px; font-weight: 650; }
  .legend { font-size: 11.5px; fill: var(--fg); }
  .legend .strong { font-weight: 650; }
  .legend.muted { fill: var(--muted); }
  .zoomrect { transform-box: fill-box; transform-origin: 0 0; transition: transform 800ms cubic-bezier(0.2, 0.8, 0.2, 1); }
</style>
