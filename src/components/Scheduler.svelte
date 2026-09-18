<script lang="ts">
  import { fade, fly } from 'svelte/transition';
  import StepControls from './StepControls.svelte';
  import { chapters, type NavLink } from '../chapters';
  let { prev, next }: { prev?: NavLink; next?: NavLink } = $props();
  const chNum = (slug: string) => chapters.findIndex((c) => c.slug === slug) + 1;
  const CH_DISAGG = chNum('22-disaggregation'), CH_CUDA = chNum('11-cuda-graphs');

  // ---- Numbers, same as chapters 4 and 5: Llama-3-8B bf16 on one H100 -------------------------
  const W_GB = 16, BW = 3.35, FLOPS = 989, GFLOP = 16;
  const tMem = W_GB / BW;
  const tComp = (n: number) => (n * GFLOP) / FLOPS;
  const stepMs = (n: number) => Math.max(tMem, tComp(n));
  const fmt = (ms: number) => (ms < 10 ? ms.toFixed(1) : ms.toFixed(0)) + ' ms';
  const BALANCE = Math.round(tMem / tComp(1) / 50) * 50;      // ≈300 tokens per step
  const DECODERS = 64, PROMPT = 2000, CHUNK = 512;
  const MIX_CHUNK = BALANCE - DECODERS;                          // what fits beside the decodes without stretching the step
  const WAITING = [1200, 2600, 800];                             // three prompts in the queue for the "batched" step
  const waitingTotal = WAITING.reduce((a, b) => a + b, 0);

  // ---- Timelines: 3 decode steps, then the newcomer(s), then 3 more --------------------------------
  type Mode = 'prefill-first' | 'batched' | 'chunked' | 'mixed';
  interface Seg { ms: number; decode: boolean; prefill: number; first?: boolean; label?: string }
  function timeline(mode: Mode): Seg[] {
    const plain = (): Seg => ({ ms: tMem, decode: true, prefill: 0 });
    let mid: Seg[] = [];
    if (mode === 'prefill-first') mid = [{ ms: stepMs(PROMPT), decode: false, prefill: PROMPT, first: true, label: `prefill · ${PROMPT.toLocaleString()} tokens` }];
    else if (mode === 'batched') mid = [{ ms: stepMs(waitingTotal), decode: false, prefill: waitingTotal, first: true, label: `prefill · 3 prompts · ${waitingTotal.toLocaleString()} tokens` }];
    else if (mode === 'chunked') {
      const n = Math.ceil(PROMPT / CHUNK);
      for (let i = 0; i < n; i++) {
        const c = i < n - 1 ? CHUNK : PROMPT - CHUNK * (n - 1);
        mid.push({ ms: stepMs(c), decode: false, prefill: c, first: i === n - 1, label: String(c) });
        if (i < n - 1) mid.push(plain());
      }
    } else {
      const n = Math.ceil(PROMPT / MIX_CHUNK);
      mid = Array.from({ length: n }, (_, i) => { const c = i < n - 1 ? MIX_CHUNK : PROMPT - MIX_CHUNK * (n - 1); return { ms: stepMs(DECODERS + c), decode: true, prefill: c, first: i === n - 1, label: String(c) }; });
    }
    return [plain(), plain(), plain(), ...mid, plain(), plain(), plain()];
  }
  function metrics(segs: Seg[]) {
    let t = 0, last = 0, worst = 0, ws = 0, we = 0, ttft = 0, arrival = 0;
    segs.forEach((s, i) => {
      if (i === 3) arrival = t;
      t += s.ms;
      if (s.decode) { if (t - last > worst + 1e-6) { worst = t - last; ws = last; we = t; } last = t; }   // first occurrence of the worst gap
      if (s.first) ttft = t - arrival;
    });
    return { worst, ws, we, ttft, total: t, arrival };
  }
  const TL = { x: 90, y: 110, rowH: 26, gapY: 58, pxPerMs: 5.8 };
  const policies: { mode: Mode; name: string; note: string }[] = [
    { mode: 'prefill-first', name: 'prefill first', note: 'one prompt, its own step' },
    { mode: 'chunked', name: `chunked, not mixed · ${CHUNK} per chunk`, note: 'chunk step, decode step, chunk step…' },
    { mode: 'mixed', name: `chunked, mixed · ${MIX_CHUNK} per chunk`, note: 'every step carries a chunk and all the decodes' },
  ];

  // ---- Script ------------------------------------------------------------------------------------------
  type Scene = 'recap' | 'lists' | 'why' | 'timeline' | 'compare' | 'loop';
  interface Step { caption: string; scene: Scene; mode?: Mode }
  const M = Object.fromEntries((['prefill-first', 'batched', 'chunked', 'mixed'] as Mode[]).map((m) => [m, metrics(timeline(m))])) as Record<Mode, ReturnType<typeof metrics>>;
  const steps: Step[] = [
    { scene: 'recap', caption: `Chapter 5 ended here: a newcomer's prefill stretching everyone's decode step. Engines don't run the two together by default. They split the work into two kinds of batch and pick one each step. That's the scheduler.` },
    { scene: 'lists', caption: `The engine keeps two lists. <b>Waiting</b>: new requests that need a prefill. <b>Running</b>: conversations mid-answer that need one more token. Each step runs one batch, from one list.` },
    { scene: 'why', caption: `Same model, two shapes. Prefill: a few sequences, hundreds of tokens each, ragged. Decode: many sequences, one token each, the same shape every step. Two shapes, two batches; chapters ${CH_DISAGG} and ${CH_CUDA} show what that unlocks.` },
    { scene: 'timeline', mode: 'prefill-first', caption: `The default policy: if anyone is waiting, run a prefill batch first. The newcomer's first token comes in ${fmt(M['prefill-first'].ttft)}, but nobody decodes during those ${fmt(M['prefill-first'].ttft)}. A 32k-token prompt would freeze everyone for half a second.` },
    { scene: 'timeline', mode: 'batched', caption: `It gets worse. Waiting prompts are batched into one prefill step, efficient for the GPU and awful for the decoders: three prompts, ${waitingTotal.toLocaleString()} tokens, one ${fmt(M.batched.ttft)} step. Every running conversation freezes for all of it.` },
    { scene: 'timeline', mode: 'chunked', caption: `Cap the prefill batch. Split prompts into chunks and alternate: a chunk, a decode step, a chunk, a decode step. The freeze is now one chunk long, whatever the prompt's size. The first token arrives a little later.` },
    { scene: 'timeline', mode: 'mixed', caption: `Once prefill comes in chunks, a chunk is small enough to ride inside a decode step, on compute the decodes leave idle. No freeze at all, first token in ${fmt(M.mixed.ttft)}. Sarathi-Serve's idea, vLLM v1's default, SGLang's mixed-chunk option.` },
    { scene: 'compare', caption: `Same GPU, same prompt, three policies. Prefill-first: fastest first token, worst freeze. Chunked: a bounded freeze. Mixed: none. The chunk size is the knob between the two clocks, and it belongs to the scheduler, not the model.` },
    { scene: 'loop', caption: `So each step the scheduler asks: anyone waiting, and room in the cache? Then a prefill batch, in policy order, capped by the chunk size. Otherwise the decode batch. Room in the cache is the next question, and it's a whole chapter.` },
  ];

  let step = $state(0);
  $effect(() => {
    const q = Number(new URLSearchParams(window.location.search).get('step'));
    if (q >= 1 && q <= steps.length) step = q - 1;
  });
  const cur = $derived(steps[step]);
  const mode = $derived(cur.mode ?? 'prefill-first');
  const segs = $derived(timeline(mode));
  const met = $derived(M[mode]);
  const segX = $derived(segs.reduce<number[]>((acc, s, i) => { acc.push(i === 0 ? 0 : acc[i - 1] + segs[i - 1].ms); return acc; }, []));
  const W = 720, H = 400;
</script>

<figure class="viz">
  <div class="canvas">
    <svg viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="The scheduler, step {step + 1}">

      <!-- Two lists, one batch per step -->
      {#if cur.scene === 'lists'}
        <g transition:fade={{ duration: 250 }}>
          <rect x="24" y="70" width="200" height="220" rx="12" fill="#fbfaf7" stroke="var(--accent)" stroke-dasharray="5 4" />
          <text x="40" y="92" class="boxtitle">waiting · need a prefill</text>
          {#each WAITING as p, i}
            <g in:fly={{ y: -6, delay: i * 80, duration: 220 }}>
              <rect x="40" y={106 + i * 30} width="168" height="22" rx="5" fill="white" stroke="var(--line)" />
              <text x="50" y={106 + i * 30 + 15} class="cell">req {7 + i}</text>
              <rect x="96" y={106 + i * 30 + 6} width={p * 0.04} height="10" rx="2" fill="var(--accent)" opacity="0.85" />
            </g>
          {/each}
          <text x="40" y="216" class="tag">prompt tokens, none processed yet</text>
          <text x="40" y="266" class="tag">a prefill batch: some of these,</text>
          <text x="40" y="280" class="tag">all their prompt tokens at once</text>

          <rect x="496" y="70" width="200" height="220" rx="12" fill="#fbfaf7" stroke="var(--gen)" stroke-dasharray="5 4" />
          <text x="512" y="92" class="boxtitle">running · need one token</text>
          {#each [10, 4, 15, 7, 3, 9] as a, i}
            <g in:fly={{ y: -6, delay: i * 60, duration: 220 }}>
              <rect x="512" y={106 + i * 24} width="168" height="18" rx="4" fill="white" stroke="var(--line)" />
              <text x="520" y={106 + i * 24 + 13} class="cell">req {i + 1}</text>
              <rect x="566" y={106 + i * 24 + 4} width={a * 6} height="10" rx="2" fill="var(--gen)" opacity="0.85" />
              <rect x={566 + a * 6 + 2} y={106 + i * 24 + 4} width="6" height="10" rx="2" fill="var(--gen)" />
            </g>
          {/each}
          <text x="512" y="266" class="tag">a decode batch: all of these,</text>
          <text x="512" y="280" class="tag">one token each</text>

          <g in:fade={{ delay: 600 }}>
            <rect x="290" y="130" width="140" height="100" rx="12" fill="white" stroke="var(--fg)" stroke-width="1.5" />
            <text x="360" y="156" text-anchor="middle" class="slab strong">this step</text>
            <text x="360" y="178" text-anchor="middle" class="tag">a prefill batch</text>
            <text x="360" y="192" text-anchor="middle" class="tag strong">or</text>
            <text x="360" y="206" text-anchor="middle" class="tag">the decode batch</text>
            <line x1="230" y1="180" x2="282" y2="180" class="wire" />
            <polygon points="282,174 282,186 290,180" fill="var(--faint)" />
            <line x1="490" y1="180" x2="438" y2="180" class="wire" />
            <polygon points="438,174 438,186 430,180" fill="var(--faint)" />
            <text x="360" y="262" text-anchor="middle" class="tag">one forward pass, then back here</text>
          </g>
          <text x="360" y="330" text-anchor="middle" class="legend" in:fade={{ delay: 1200 }}>never both at once, by default. The next step says why.</text>
        </g>
      {/if}

      <!-- Recap: where chapter 5 left off -->
      {#if cur.scene === 'recap'}
        {@const cols = [{ w: 44, wide: false }, { w: 44, wide: false }, { w: 150, wide: true }, { w: 44, wide: false }, { w: 44, wide: false }]}
        {@const xs = cols.reduce<number[]>((a, c, i) => { a.push(i === 0 ? 0 : a[i - 1] + cols[i - 1].w + 4); return a; }, [])}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="54" class="rowlabel">chapter 5, last frame · continuous batching, one newcomer joins</text>
          {#each Array(6) as _, sIdx}
            <text x="120" y={104 + sIdx * 26 + 15} text-anchor="end" class="rowlabel">slot {sIdx + 1}</text>
            {#each cols as c, t}
              {@const x = 132 + xs[t]}
              {@const y = 104 + sIdx * 26}
              {#if c.wide && sIdx === 2}
                <rect {x} {y} width={c.w} height="22" rx="3" fill="var(--accent)" in:fade={{ delay: 300 }} />
                <text x={x + c.w / 2} y={y + 15} text-anchor="middle" class="steplabel">newcomer's prefill</text>
              {:else if c.wide}
                <rect x={x + 0.5} y={y + 0.5} width={c.w - 1} height="21" rx="3" fill="var(--gen-soft)" stroke="var(--gen)" stroke-opacity="0.5" in:fade={{ delay: 300 }} />
                <rect x={x + c.w - 9} {y} width="9" height="22" rx="3" fill="var(--gen)" in:fade={{ delay: 300 }} />
              {:else}
                <rect {x} {y} width={c.w} height="22" rx="3" fill="var(--gen)" opacity="0.85" in:fade={{ delay: t * 60 }} />
              {/if}
            {/each}
          {/each}
          <g in:fade={{ delay: 800 }}>
            <path d="M {132 + xs[2]} 94 V 88 H {132 + xs[2] + 150} V 94" fill="none" stroke="var(--eos)" stroke-width="1.5" />
            <text x={132 + xs[2] + 75} y="82" text-anchor="middle" class="tag" fill="var(--eos)">one step, stretched to a prompt's worth of math</text>
          </g>
          <g in:fade={{ delay: 1400 }}>
            <line x1="500" y1="170" x2="560" y2="170" class="wire" />
            <polygon points="560,163 560,177 572,170" fill="var(--faint)" />
            <rect x="584" y="120" width="116" height="100" rx="12" fill="white" stroke="var(--fg)" stroke-width="1.5" />
            <text x="642" y="150" text-anchor="middle" class="slab strong small">don't mix</text>
            <text x="642" y="172" text-anchor="middle" class="tag">prefill batch</text>
            <text x="642" y="186" text-anchor="middle" class="tag strong">or</text>
            <text x="642" y="200" text-anchor="middle" class="tag">decode batch</text>
          </g>
          <text x="16" y="300" class="legend muted" in:fade={{ delay: 1800 }}>the default in SGLang and vLLM: each step is one kind of batch. Mixing comes back later, on purpose and bounded.</text>
        </g>
      {/if}

      <!-- Why two batch types: the shapes -->
      {#if cur.scene === 'why'}
        <g transition:fade={{ duration: 250 }}>
          <rect x="24" y="64" width="330" height="232" rx="12" fill="#fbfaf7" stroke="var(--accent)" />
          <text x="40" y="86" class="boxtitle">a prefill batch</text>
          {#each [18, 27, 11] as n, i}
            <text x="40" y={116 + i * 26} class="cell">seq {i + 1}</text>
            {#each Array(n) as _, t}
              <rect x={82 + t * 9.5} y={105 + i * 26} width="8" height="14" rx="2" fill="var(--accent)" opacity="0.85" in:fade={{ delay: (i * 20 + t) * 10, duration: 100 }} />
            {/each}
          {/each}
          <text x="40" y="204" class="slab">few sequences · hundreds of tokens each</text>
          <text x="40" y="222" class="slab">ragged lengths</text>
          <text x="40" y="254" class="tag">its own attention kernel · compute-bound</text>
          <text x="40" y="274" class="tag">shapes differ every batch</text>

          <rect x="366" y="64" width="330" height="232" rx="12" fill="#fbfaf7" stroke="var(--gen)" />
          <text x="382" y="86" class="boxtitle">the decode batch</text>
          {#each Array(4) as _, col}
            {#each Array(4) as _, row}
              {@const k = col * 4 + row}
              <text x={382 + col * 78} y={116 + row * 18} class="cell">seq {k + 1}</text>
              <rect x={424 + col * 78} y={105 + row * 18} width="8" height="14" rx="2" fill="var(--gen)" opacity="0.85" in:fade={{ delay: k * 40 }} />
            {/each}
          {/each}
          <text x="382" y="204" class="slab">many sequences · one token each</text>
          <text x="382" y="222" class="slab">always the same shape</text>
          <text x="382" y="254" class="tag">a different attention kernel · memory-bound</text>
          <text x="382" y="274" class="tag">same shape every step → CUDA graph replay, chapter {CH_CUDA}</text>

          <g in:fade={{ delay: 900 }}>
            <text x="360" y="330" text-anchor="middle" class="legend">two shapes → two batches → two fast paths</text>
            <text x="360" y="352" text-anchor="middle" class="legend muted">what the split unlocks: separate machines (chapter {CH_DISAGG}), CUDA graphs for decode (chapter {CH_CUDA})</text>
          </g>
        </g>
      {/if}

      <!-- Timeline: 64 decoders and the newcomer(s), time on the x axis -->
      {#if cur.scene === 'timeline'}
        {@const rowA = TL.y}
        {@const rowN = TL.y + TL.gapY}
        {@const arrX = TL.x + met.arrival * TL.pxPerMs}
        {@const gx0 = TL.x + met.ws * TL.pxPerMs}
        {@const gx1 = TL.x + met.we * TL.pxPerMs - 2}
        {@const firstIdx = segs.findIndex((z) => z.first)}
        {@const ly = rowN + TL.rowH + 66}
        {@const fx = TL.x + (segX[firstIdx] + segs[firstIdx].ms) * TL.pxPerMs - 1}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y={TL.y - 46} class="rowlabel">{DECODERS} users decoding · {mode === 'batched' ? `${WAITING.length} prompts waiting` : `a ${PROMPT.toLocaleString()}-token prompt arrives`}</text>
          <text x="16" y={TL.y - 30} class="rowlabel strong">{mode === 'prefill-first' ? 'prefill first · the prompt gets its own step' : mode === 'batched' ? 'prefill first · three prompts in one prefill step' : mode === 'chunked' ? `chunked prefill, not mixed · chunk step, decode step, chunk step…` : `chunked prefill, mixed · every step carries a chunk and all the decodes`}</text>
          <text x={TL.x - 10} y={rowN + TL.rowH + 18} text-anchor="end" class="rowlabel">step type</text>
          <line x1={TL.x} y1={rowN + TL.rowH + 34} x2={TL.x + 104 * TL.pxPerMs} y2={rowN + TL.rowH + 34} stroke="var(--line)" />
          {#each [0, 25, 50, 75, 100] as ms}
            <text x={TL.x + ms * TL.pxPerMs} y={rowN + TL.rowH + 48} text-anchor="middle" class="tag">{ms} ms</text>
          {/each}
          <text x={TL.x - 10} y={rowA + 17} text-anchor="end" class="rowlabel">everyone else</text>
          <text x={TL.x - 10} y={rowN + 17} text-anchor="end" class="rowlabel">{mode === 'batched' ? 'newcomers' : 'newcomer'}</text>
          {#each segs as s, i}
            {@const x = TL.x + segX[i] * TL.pxPerMs}
            {@const w = Math.max(3, s.ms * TL.pxPerMs - 2)}
            {@const sy = rowN + TL.rowH + 8}
            <g in:fade={{ delay: i * 40, duration: 200 }}>
              {#if s.decode}
                <rect {x} y={rowA} width={w} height={TL.rowH} rx="4" fill="var(--gen)" opacity={s.prefill > 0 ? 0.45 : 0.85} />
                <rect x={x + w - 5} y={rowA} width="5" height={TL.rowH} rx="2" fill="var(--gen)" />
              {:else}
                <rect {x} y={rowA} width={w} height={TL.rowH} rx="4" fill="#ece9e2" />
                {#if w > 40}<text x={x + w / 2} y={rowA + 17} text-anchor="middle" class="tag">frozen</text>{/if}
              {/if}
              {#if s.prefill > 0}
                <rect {x} y={rowN} width={w} height={TL.rowH} rx="4" fill="var(--accent)" opacity="0.9" />
                {#if w > 22}<text x={x + w / 2} y={rowN + 17} text-anchor="middle" class="steplabel">{s.label}</text>{/if}
              {:else if i > firstIdx}
                <rect {x} y={rowN} width={w} height={TL.rowH} rx="4" fill="var(--gen)" opacity="0.85" />
                <rect x={x + w - 5} y={rowN} width="5" height={TL.rowH} rx="2" fill="var(--gen)" />
              {/if}
              <!-- step type strip: what kind of batch this step was -->
              {#if s.prefill > 0 && s.decode}
                <rect {x} y={sy} width={w} height="6" rx="1.5" fill="var(--accent)" />
                <rect {x} y={sy + 6} width={w} height="6" rx="1.5" fill="var(--gen)" />
              {:else if s.prefill > 0}
                <rect {x} y={sy} width={w} height="12" rx="2" fill="var(--accent)" />
              {:else}
                <rect {x} y={sy} width={w} height="12" rx="2" fill="var(--gen)" opacity="0.85" />
              {/if}
            </g>
          {/each}
          <g in:fade={{ delay: firstIdx * 40 + 100 }}>
            <circle cx={fx} cy={rowN + TL.rowH / 2} r="6" fill="white" stroke="var(--fg)" stroke-width="2" />
            <text x={fx} y={rowN - 8} text-anchor="middle" class="tag strong">first token</text>
          </g>
          <line x1={arrX} y1={rowA - 14} x2={arrX} y2={rowN + TL.rowH + 36} stroke="var(--fg)" stroke-dasharray="3 3" />
          <text x={arrX} y={rowN + TL.rowH + 48} text-anchor="middle" class="tag strong">{mode === 'batched' ? 'arrive' : 'arrives'}</text>
          <g in:fade={{ delay: 300 }}>
            <rect x={TL.x} y={ly - 9} width="26" height="10" rx="2" fill="var(--accent)" /><text x={TL.x + 32} y={ly} class="tag">prefill batch</text>
            <rect x={TL.x + 110} y={ly - 9} width="26" height="10" rx="2" fill="var(--gen)" opacity="0.85" /><text x={TL.x + 142} y={ly} class="tag">decode batch</text>
            <rect x={TL.x + 230} y={ly - 9} width="26" height="5" rx="1.5" fill="var(--accent)" /><rect x={TL.x + 230} y={ly - 4} width="26" height="5" rx="1.5" fill="var(--gen)" /><text x={TL.x + 262} y={ly} class="tag">mixed batch: a chunk plus every decode, one forward pass</text>
          </g>
          {#if met.worst > 1.5 * tMem}
            <path d="M {gx0} {rowA - 6} V {rowA - 12} H {gx1} V {rowA - 6}" fill="none" stroke="var(--eos)" stroke-width="1.5" in:fade={{ delay: 500 }} />
            <text x={(gx0 + gx1) / 2} y={rowA - 18} text-anchor="middle" class="tag" fill="var(--eos)" in:fade={{ delay: 500 }}>no token for {fmt(met.worst)}</text>
          {/if}
          <g in:fade={{ delay: 700 }}>
            {#each [
              { v: fmt(met.worst), l: 'everyone else · longest gap between tokens', bad: met.worst > 2 * tMem },
              { v: fmt(met.ttft), l: (mode === 'batched' ? 'newcomers' : 'newcomer') + ' · time to first token', bad: false },
            ] as t, i}
              {@const x = 90 + i * 300}
              <rect {x} y="296" width="280" height="64" rx="10" fill="#fbfaf7" stroke={t.bad ? 'var(--eos)' : 'var(--line)'} />
              <text x={x + 16} y="324" class="tile-value" fill={t.bad ? 'var(--eos)' : 'var(--fg)'}>{t.v}</text>
              <text x={x + 16} y="346" class="tile-label">{t.l}</text>
            {/each}
          </g>
        </g>
      {/if}

      <!-- Compare the policies -->
      {#if cur.scene === 'compare'}
        {@const maxMs = Math.max(...policies.map((p) => Math.max(M[p.mode].ttft, M[p.mode].worst)))}
        {@const bx = 180}
        {@const bw = 460}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="64" class="rowlabel">same {PROMPT.toLocaleString()}-token prompt, {DECODERS} users decoding</text>

          {#each policies as p, i}
            {@const y = 92 + i * 86}
            {@const m = M[p.mode]}
            <g in:fly={{ x: -8, delay: i * 200, duration: 300 }}>
              <text x="16" y={y} class="slab strong small">{p.name}</text>
              <text x="272" y={y} class="tag">{p.note}</text>
              <text x={bx - 8} y={y + 27} text-anchor="end" class="tag">newcomer · first token</text>
              <rect x={bx} y={y + 14} width={(m.ttft / maxMs) * bw} height="18" rx="3" fill="var(--accent)" opacity="0.9" />
              <text x={bx + (m.ttft / maxMs) * bw + 6} y={y + 27} class="num">{fmt(m.ttft)}</text>
              <text x={bx - 8} y={y + 51} text-anchor="end" class="tag">everyone else · longest gap</text>
              <rect x={bx} y={y + 38} width={Math.max(3, (m.worst / maxMs) * bw)} height="18" rx="3" fill={m.worst > 2 * tMem ? 'var(--eos)' : 'var(--gen)'} opacity="0.9" />
              <text x={bx + Math.max(3, (m.worst / maxMs) * bw) + 6} y={y + 51} class="num">{fmt(m.worst)}</text>
            </g>
          {/each}
          <text x="16" y="352" class="legend muted" in:fade={{ delay: 900 }}>the decode step floor is {fmt(tMem)}: a gap of {fmt(tMem)} means nobody noticed the newcomer at all</text>
        </g>
      {/if}

      <!-- The scheduler's loop -->
      {#if cur.scene === 'loop'}
        <g transition:fade={{ duration: 250 }}>
          <defs>
            <marker id="arrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#b8b4aa" />
            </marker>
          </defs>
          <text x="16" y="60" class="rowlabel">one scheduler step</text>
          <g in:fly={{ y: 8, duration: 300 }}>
            <rect x="230" y="80" width="260" height="56" rx="12" fill="white" stroke="var(--fg)" stroke-width="1.5" />
            <text x="360" y="104" text-anchor="middle" class="slab strong small">anyone waiting, and room in the cache?</text>
            <text x="360" y="124" text-anchor="middle" class="tag">the cache question is chapter {chNum('07-kv-memory')}</text>
          </g>
          <g in:fly={{ y: 8, delay: 300, duration: 300 }}>
            <path d="M 300 136 V 158 H 180 V 176" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#arrowhead)" />
            <text x="292" y="154" text-anchor="end" class="tag strong">yes</text>
            <rect x="40" y="180" width="280" height="96" rx="12" fill="#fbfaf7" stroke="var(--accent)" />
            <text x="56" y="204" class="slab strong small">a prefill batch</text>
            <text x="56" y="226" class="tag">from the waiting list, in policy order:</text>
            <text x="56" y="241" class="tag">first come · shortest first · longest cached prefix</text>
            <text x="56" y="262" class="tag">capped at the chunk size, mixed in if enabled</text>
          </g>
          <g in:fly={{ y: 8, delay: 600, duration: 300 }}>
            <path d="M 420 136 V 158 H 540 V 176" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#arrowhead)" />
            <text x="428" y="154" class="tag strong">no</text>
            <rect x="400" y="180" width="280" height="96" rx="12" fill="#fbfaf7" stroke="var(--gen)" />
            <text x="416" y="204" class="slab strong small">the decode batch</text>
            <text x="416" y="226" class="tag">everyone running, one token each</text>
            <text x="416" y="241" class="tag">finished sequences leave, freeing their cache</text>
            <text x="416" y="262" class="tag">fixed shape → CUDA graph replay, chapter {CH_CUDA}</text>
          </g>
          <g in:fade={{ delay: 1000 }}>
            <path d="M 180 276 V 320 H 218" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#arrowhead)" />
            <path d="M 540 276 V 320 H 502" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#arrowhead)" />
            <rect x="222" y="300" width="276" height="40" rx="10" fill="var(--fg)" />
            <text x="360" y="325" text-anchor="middle" class="steplabel big">one forward pass · then back to the top</text>
            <path d="M 360 340 V 354 H 702 V 108 H 496" fill="none" stroke="#b8b4aa" stroke-width="1.5" stroke-dasharray="4 4" marker-end="url(#arrowhead)" />
          </g>
          <text x="360" y="380" text-anchor="middle" class="legend muted" in:fade={{ delay: 1400 }}>SGLang: <tspan class="mono">schedule_policy</tspan>, <tspan class="mono">chunked_prefill_size</tspan>, <tspan class="mono">enable_mixed_chunk</tspan> · this loop is <tspan class="mono">Scheduler.get_next_batch_to_run()</tspan></text>
        </g>
      {/if}
    </svg>
  </div>

  <StepControls {step} total={steps.length} caption={cur.caption} interval={3400} {prev} {next} onchange={(s) => (step = s)} />
</figure>

<style>
  .viz { margin: 0; display: flex; flex-direction: column; min-height: 0; }
  .canvas { flex: 1 1 auto; min-height: 0; border: 1px solid var(--line); border-radius: 16px; background: white; padding: 0.75rem; box-shadow: 0 1px 2px rgba(0,0,0,0.03), 0 12px 32px -20px rgba(0,0,0,0.12); }
  svg { display: block; width: 100%; height: 100%; font-family: var(--sans); }
  .rowlabel { font-family: var(--mono); font-size: 11px; fill: var(--muted); }
  .rowlabel.strong { fill: var(--fg); }
  .cell { font-family: var(--mono); font-size: 10px; fill: var(--fg); }
  .num { font-family: var(--mono); font-size: 10.5px; fill: var(--fg); }
  .mono { font-family: var(--mono); font-size: 10px; }
  .tag { font-size: 10px; fill: var(--muted); }
  .tag.strong { fill: var(--fg); font-weight: 600; }
  .steplabel { font-size: 10px; fill: white; font-weight: 600; }
  .steplabel.big { font-size: 11.5px; }
  .boxtitle { font-family: var(--mono); font-size: 10.5px; fill: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .slab { font-size: 12px; fill: var(--fg); }
  .slab.strong { font-weight: 650; font-size: 14px; }
  .slab.strong.small { font-size: 12.5px; }
  .tile-value { font-size: 20px; font-weight: 650; letter-spacing: -0.02em; }
  .tile-label { font-size: 10.5px; fill: var(--muted); }
  .legend { font-size: 11.5px; fill: var(--fg); }
  .legend.muted { fill: var(--muted); }
  .wire { stroke: var(--line); stroke-width: 6; stroke-linecap: round; }
</style>
