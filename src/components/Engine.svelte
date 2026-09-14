<script lang="ts">
  import { fade, fly } from 'svelte/transition';
  import StepControls from './StepControls.svelte';
  import { chapters, type NavLink } from '../chapters';
  let { prev, next }: { prev?: NavLink; next?: NavLink } = $props();
  const chNum = (slug: string) => chapters.findIndex((c) => c.slug === slug) + 1;
  const CH_CUDA = chNum('11-cuda-graphs'), CH_DISAGG = chNum('21-disaggregation');
  const W_GB = 16, BW = 3.35;
  const tStep = W_GB / BW;
  const fmt = (ms: number) => (ms < 10 ? ms.toFixed(1) : ms.toFixed(0)) + ' ms';

  type Scene = 'process' | 'overlap' | 'future' | 'map';
  interface Step { caption: string; scene: Scene; v?: number }
  const steps: Step[] = [
    { scene: 'process', v: 0, caption: `Inside process 2. Two lists of <b>Req</b> objects, waiting and running. The page pool and the radix tree from chapters 7 and 8. A model runner that owns the GPU. And one loop, top to bottom, about ${Math.round(1000 / tStep)} times a second.` },
    { scene: 'process', v: 1, caption: `Top of the loop: drain the inbox. Each message becomes a Req: its ids and sampling params, a prefix match against the tree (3 of its 5 tokens are already cached), and a place at the end of the waiting list. Ours arrives now.` },
    { scene: 'process', v: 2, caption: `Chapter 6's decision. Anyone waiting, and room in the pool for what they'll write? Ours needs 2 pages: its 2 uncached prompt tokens. Room enough, so it makes this step's prefill batch.` },
    { scene: 'process', v: 3, caption: `A batch becomes tensors: every token id in one flat array, each request's positions, and each request's page table so attention can find its cache. Pages for the tokens about to be written are allocated here.` },
    { scene: 'process', v: 4, caption: `The model runner runs chapters 2 to 4: embeddings, 32 layers of attention over the paged cache and MLP, logits for the last position of every request. New k and v land in the pages just allocated.` },
    { scene: 'process', v: 5, caption: `Logits become one token per request: temperature, top-p, penalties, whatever each asked for. The id is appended to its Req, and the Req checks itself: EOS? max tokens? finished?` },
    { scene: 'process', v: 6, caption: `Bookkeeping. Finished Reqs leave and hand their pages to the tree. The prefill batch joins the running batch. One message with everyone's new token goes out to the detokenizer. Back to the top.` },
    { scene: 'overlap', caption: `<b>Overlap scheduling.</b> Kernel launches return at once: right after launching step t, the CPU plans t+1, then processes t's results while the GPU runs t+1. SGLang's event_loop_overlap; vLLM v1 calls it async scheduling.` },
    { scene: 'future', caption: `The catch: step t+1's decode input is step t's sampled token, and the CPU planned t+1 before that token existed. So the plan carries a placeholder, a slot in a GPU buffer. Step t's sampler fills it; step t+1's first kernel reads it. No round trip.` },
    { scene: 'map', caption: `The whole site as a file tree. Every chapter is a module in sglang/srt, and the loop you just watched is scheduler.py. Next: how the model runner launches a thousand kernels as one.` },
  ];

  let step = $state(0);
  $effect(() => {
    const q = Number(new URLSearchParams(window.location.search).get('step'));
    if (q >= 1 && q <= steps.length) step = q - 1;
  });
  const cur = $derived(steps[step]);
  const v = $derived(cur.v ?? 0);
  const W = 720, H = 400;

  // ---- process layout --------------------------------------------------------------------------------
  const L = { x: 24, w: 180 };
  const M = { x: 228, w: 250 };
  const R = { x: 502, w: 194 };
  const pipe = [
    { k: 'recv', t: 'recv_requests', s: 'inbox → Req objects', y: 64 },
    { k: 'schedule', t: 'get_next_batch_to_run', s: 'prefill or decode batch', y: 118 },
    { k: 'prepare', t: 'ScheduleBatch → tensors', s: 'ids · positions · pages', y: 172 },
    { k: 'forward', t: 'ModelRunner.forward', s: 'embed → 32 layers → logits', y: 226 },
    { k: 'sample', t: 'Sampler', s: 'logits → tokens', y: 280 },
    { k: 'results', t: 'process_batch_result', s: 'append · finish · send', y: 334 },
  ];
  const BOXH = 44;
  const hot = (i: number) => v === i + 1;
  // side panels lit up by each stage
  const lit = (name: string) => ({
    inbox: v === 1, waiting: v === 1 || v === 2, running: v === 2 || v === 6, outbox: v === 6,
    tree: v === 1 || v === 6, pool: v === 2 || v === 3 || v === 4, gpu: v === 4 || v === 5,
  } as Record<string, boolean>)[name];
  // where our Req sits at each stage
  const reqPos = $derived([
    { x: -100, y: -100 },                    // rest: not yet arrived
    { x: L.x + 12, y: 150 },                 // in the waiting list (108 wide)
    { x: M.x + M.w - 116, y: 118 + 24 },     // inside the schedule box, as this step's prefill batch
    { x: M.x + M.w - 116, y: 172 + 24 },
    { x: R.x + 80, y: 336 },                 // on the GPU
    { x: M.x + M.w - 116, y: 280 + 24 },
    { x: L.x + 12, y: 276 },                 // in the running list
  ][v]);
  const reqTag = $derived(['', 'Req a1f3', 'prefill batch', 'ids · pos · pages', 'forward', 'sample → 12366', 'Req a1f3 · +1 token'][v]);

  // ---- overlap timeline ------------------------------------------------------------------------------
  const OL = { x: 150, pxPerMs: 26 };
  const badgeW = (t: string) => 18 + [...t].reduce((a, c) => a + (c === ' ' ? 3 : c === '·' ? 4 : 6.2), 0);
  const gpuMs = tStep - 0.3;
</script>

<figure class="viz">
  <div class="canvas">
    <svg viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="The engine, step {step + 1}">
      <defs>
        {#each [['grey', '#b8b4aa'], ['accent', '#2f5bea'], ['gen', '#d97706']] as [n, c]}
          <marker id="en-{n}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={c} />
          </marker>
        {/each}
      </defs>

      {#if cur.scene === 'process'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="44" class="rowlabel">process 2 · the scheduler · one step of the loop{v > 0 ? ` · ${pipe[v - 1].t}` : ''}</text>

          <!-- left: lists and wires -->
          <rect x={L.x} y="64" width={L.w} height="30" rx="8" fill="#fbfaf7" stroke={lit('inbox') ? 'var(--accent)' : 'var(--line)'} stroke-width={lit('inbox') ? 2 : 1} />
          <text x={L.x + 10} y="83" class="tag strong">inbox · zmq PULL</text>
          {#if v === 1}
            <rect x={L.x + 120} y="72" width="44" height="14" rx="3" fill="var(--accent)" in:fly={{ x: -30, duration: 300 }} />
            <text x={L.x + 142} y="82" text-anchor="middle" class="tiny">msg</text>
          {/if}

          <rect x={L.x} y="104" width={L.w} height="88" rx="8" fill="#fbfaf7" stroke={lit('waiting') ? 'var(--accent)' : 'var(--line)'} stroke-width={lit('waiting') ? 2 : 1} />
          <text x={L.x + 10} y="122" class="tag strong">waiting_queue</text>
          <text x={L.x + 10} y="136" class="tag">Reqs not yet prefilled · policy order</text>
          {#if v === 0}<text x={L.x + 12} y="160" class="tag muted">empty</text>{/if}

          <rect x={L.x} y="202" width={L.w} height="100" rx="8" fill="#fbfaf7" stroke={lit('running') ? 'var(--gen)' : 'var(--line)'} stroke-width={lit('running') ? 2 : 1} />
          <text x={L.x + 10} y="220" class="tag strong">running_batch</text>
          <text x={L.x + 10} y="234" class="tag">mid-answer · one token per step</text>
          {#each [0, 1] as i}
            <rect x={L.x + 12} y={244 + i * 16} width="120" height="12" rx="3" fill="white" stroke="var(--gen)" stroke-opacity="0.7" />
            <text x={L.x + 18} y={253 + i * 16} class="tiny dark">Req · decoding</text>
          {/each}

          <rect x={L.x} y="312" width={L.w} height="30" rx="8" fill="#fbfaf7" stroke={lit('outbox') ? '#0891b2' : 'var(--line)'} stroke-width={lit('outbox') ? 2 : 1} />
          <text x={L.x + 10} y="331" class="tag strong">outbox · zmq PUSH</text>
          {#if v === 6}
            <rect x={L.x + 120} y="320" width="44" height="14" rx="3" fill="#0891b2" in:fly={{ x: 30, duration: 300 }} />
            <text x={L.x + 142} y="330" text-anchor="middle" class="tiny">ids</text>
          {/if}

          <!-- middle: the pipeline -->
          {#each pipe as p, i}
            <rect x={M.x} y={p.y} width={M.w} height={BOXH} rx="8" fill={hot(i) ? 'white' : '#fbfaf7'} stroke={hot(i) ? 'var(--fg)' : 'var(--line)'} stroke-width={hot(i) ? 2 : 1} />
            <text x={M.x + 12} y={p.y + 18} class="mono" font-weight={hot(i) ? 700 : 400}>{p.t}</text>
            <text x={M.x + 12} y={p.y + 34} class="tag">{p.s}</text>
            {#if i < pipe.length - 1}
              <path d="M {M.x + 40} {p.y + BOXH} V {pipe[i + 1].y - 1}" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#en-grey)" />
            {/if}
          {/each}
          <path d="M {M.x + M.w} 356 H {M.x + M.w + 12} V 86 H {M.x + M.w + 1}" fill="none" stroke="#b8b4aa" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#en-grey)" />

          <!-- right: memory and GPU -->
          <rect x={R.x} y="64" width={R.w} height="90" rx="8" fill="#fbfaf7" stroke={lit('tree') ? 'var(--accent)' : 'var(--line)'} stroke-width={lit('tree') ? 2 : 1} />
          <text x={R.x + 10} y="82" class="tag strong">RadixCache</text>
          <text x={R.x + 10} y="96" class="tag">shared prefixes · chapter 8</text>
          <circle cx={R.x + 62} cy="118" r="6" fill="var(--accent-soft)" stroke="var(--accent)" />
          <circle cx={R.x + 37} cy="140" r="6" fill="var(--accent-soft)" stroke="var(--accent)" /><circle cx={R.x + 87} cy="140" r="6" fill="var(--accent-soft)" stroke="var(--accent)" />
          <line x1={R.x + 58} y1="123" x2={R.x + 41} y2="135" stroke="var(--faint)" /><line x1={R.x + 66} y1="123" x2={R.x + 83} y2="135" stroke="var(--faint)" />
          {#if v === 1}
            <g in:fade>
              <text x={R.x + 108} y="112" class="tag" fill="var(--accent)">match 3 of 5</text>
              <text x={R.x + 108} y="126" class="tag" fill="var(--accent)">→ 2 to prefill</text>
              <text x={R.x + 108} y="140" class="tag" fill="var(--accent)">→ 2 pages</text>
            </g>
          {/if}
          {#if v === 6}
            <g in:fade>
              <text x={R.x + 108} y="118" class="tag" fill="var(--accent)">finished Reqs'</text>
              <text x={R.x + 108} y="132" class="tag" fill="var(--accent)">pages stay here</text>
            </g>
          {/if}

          <rect x={R.x} y="164" width={R.w} height="90" rx="8" fill="#fbfaf7" stroke={lit('pool') ? '#0891b2' : 'var(--line)'} stroke-width={lit('pool') ? 2 : 1} />
          <text x={R.x + 10} y="182" class="tag strong">TokenToKVPool</text>
          <text x={R.x + 10} y="196" class="tag">pages · chapter 7</text>
          {#each Array(24) as _, i}
            {@const own = [1, 3, 4, 6, 9, 10, 13, 15, 18, 20, 21].includes(i)}
            {@const mine = v >= 3 && [7, 12].includes(i)}
            <rect x={R.x + 10 + (i % 12) * 14} y={206 + Math.floor(i / 12) * 14} width="11" height="11" rx="2" fill={mine ? 'var(--accent)' : own ? '#0891b2' : 'white'} stroke={own || mine ? 'none' : 'var(--line)'} opacity={own ? 0.5 : 1} />
          {/each}
          {#if v === 2}<text x={R.x + 10} y="246" class="tag" fill="#0891b2" in:fade>room? 13 free ≥ 2 needed ✓</text>{/if}
          {#if v === 3}<text x={R.x + 10} y="246" class="tag" fill="var(--accent)" in:fade>2 pages allocated</text>{/if}
          {#if v === 4}<text x={R.x + 10} y="246" class="tag" fill="#0891b2" in:fade>read all pages · write 2 new</text>{/if}

          <rect x={R.x} y="264" width={R.w} height="114" rx="8" fill="#fbfaf7" stroke={lit('gpu') ? 'var(--gen)' : 'var(--line)'} stroke-width={lit('gpu') ? 2 : 1} />
          <text x={R.x + 10} y="282" class="tag strong">GPU · ModelRunner</text>
          <text x={R.x + 10} y="296" class="tag">weights + kernels · chapters 2–4</text>
          <rect x={R.x + 10} y="306" width={R.w - 20} height="20" rx="4" fill="var(--accent)" opacity="0.9" />
          <text x={R.x + R.w / 2} y="320" text-anchor="middle" class="steplabel">forward pass · {fmt(tStep)}</text>
          {#if v === 4}<text x={R.x + 10} y="362" class="tag" fill="var(--gen)" in:fade>300 tokens in → logits out</text>{/if}
          {#if v === 5}<text x={R.x + 10} y="346" class="tag" fill="var(--gen)" in:fade>argmax / sample per request</text>{/if}
          {#if v === 5}<text x={R.x + 10} y="362" class="tag" in:fade>our Req: 12366 → " Paris"</text>{/if}

          <!-- our Req, travelling -->
          {#if v >= 1}
            <g class="req" style:transform="translate({reqPos.x}px, {reqPos.y}px)">
              <rect width="108" height="14" rx="4" fill="var(--eos)" />
              <text x="54" y="10" text-anchor="middle" class="tiny">{reqTag}</text>
            </g>
          {/if}
          {#if v === 6}
            <text x={L.x + 126} y="286" class="tag" fill="var(--eos)" in:fade>← joined</text>
          {/if}
        </g>
      {/if}

      {#if cur.scene === 'overlap'}
        {@const plan = 1.5}
        {@const res = 0.8}
        {@const g = gpuMs}
        <g transition:fade={{ duration: 250 }}>
          <!-- row 1: take turns -->
          <text x="16" y="56" class="rowlabel">without overlap · plan, run, wait, process, repeat</text>
          <text x={OL.x - 10} y="88" text-anchor="end" class="rowlabel">CPU · scheduler</text>
          <text x={OL.x - 10} y="128" text-anchor="end" class="rowlabel">GPU</text>
          {#each Array(3) as _, t}
            {@const start = t * (plan + g + res)}
            <rect x={OL.x + start * OL.pxPerMs} y="70" width={plan * OL.pxPerMs - 1} height="28" rx="3" fill="var(--accent)" opacity="0.85" in:fade={{ delay: t * 120 }} />
            <text x={OL.x + (start + plan / 2) * OL.pxPerMs} y="88" text-anchor="middle" class="steplabel">plan {t + 1}</text>
            <rect x={OL.x + (start + plan) * OL.pxPerMs} y="110" width={g * OL.pxPerMs - 1} height="28" rx="3" fill="var(--gen)" opacity="0.85" in:fade={{ delay: t * 120 + 60 }} />
            <text x={OL.x + (start + plan + g / 2) * OL.pxPerMs} y="128" text-anchor="middle" class="steplabel">step {t + 1}</text>
            <rect x={OL.x + (start + plan + g) * OL.pxPerMs} y="70" width={res * OL.pxPerMs - 1} height="28" rx="3" fill="#0891b2" opacity="0.9" in:fade={{ delay: t * 120 + 90 }} />
            <text x={OL.x + (start + plan / 2) * OL.pxPerMs} y="128" text-anchor="middle" class="tag">idle</text>
          {/each}
          <line x1={OL.x} y1="150" x2={OL.x + 21 * OL.pxPerMs} y2="150" stroke="var(--line)" />
          {#each [0, 5, 10, 15, 20] as ms}<text x={OL.x + ms * OL.pxPerMs} y="164" text-anchor="middle" class="tag">{ms} ms</text>{/each}

          <!-- row 2: overlap -->
          <text x="16" y="200" class="rowlabel">with overlap · launch t, plan t+1 right away, process t's results while the GPU runs t+1</text>
          <text x={OL.x - 10} y="232" text-anchor="end" class="rowlabel">CPU · scheduler</text>
          <text x={OL.x - 10} y="272" text-anchor="end" class="rowlabel">GPU</text>
          {#each Array(3) as _, t}
            {@const gs = t * g}
            {@const planStart = t === 0 ? 0.1 : gs + 0.1 + res + 0.1}
            <rect x={OL.x + gs * OL.pxPerMs} y="254" width={g * OL.pxPerMs - 1} height="28" rx="3" fill="var(--gen)" opacity="0.85" in:fade={{ delay: 500 + t * 120 }} />
            <text x={OL.x + (gs + g / 2) * OL.pxPerMs} y="272" text-anchor="middle" class="steplabel">step {t + 1}</text>
            {#if t >= 1}
              <rect x={OL.x + (gs + 0.1) * OL.pxPerMs} y="214" width={res * OL.pxPerMs - 1} height="28" rx="3" fill="#0891b2" opacity="0.9" in:fade={{ delay: 500 + t * 120 + 40 }} />
              <text x={OL.x + (gs + 0.1 + res / 2) * OL.pxPerMs} y="232" text-anchor="middle" class="steplabel">r{t}</text>
            {/if}
            <rect x={OL.x + planStart * OL.pxPerMs} y="214" width={plan * OL.pxPerMs - 1} height="28" rx="3" fill="var(--accent)" opacity="0.85" in:fade={{ delay: 500 + t * 120 + 80 }} />
            <text x={OL.x + (planStart + plan / 2) * OL.pxPerMs} y="232" text-anchor="middle" class="steplabel">plan {t + 2}</text>
          {/each}
          <line x1={OL.x} y1="294" x2={OL.x + 21 * OL.pxPerMs} y2="294" stroke="var(--line)" />
          {#each [0, 5, 10, 15, 20] as ms}<text x={OL.x + ms * OL.pxPerMs} y="308" text-anchor="middle" class="tag">{ms} ms</text>{/each}

          <rect x={OL.x} y="330" width="12" height="12" rx="2" fill="var(--accent)" opacity="0.85" /><text x={OL.x + 18} y="340" class="tag">plan: recv · schedule · flatten · launch kernels</text>
          <rect x={OL.x + 290} y="330" width="12" height="12" rx="2" fill="#0891b2" opacity="0.9" /><text x={OL.x + 308} y="340" class="tag">results: append tokens · finish Reqs · send</text>
          <g in:fade={{ delay: 1400 }}>
            <text x="16" y="372" class="legend">the GPU lane is solid: {fmt(plan + res)} of Python per step comes off the critical path, about {Math.round(((plan + res) / (plan + res + g)) * 100)}% more tokens per second on the same GPU</text>
          </g>
        </g>
      {/if}

      {#if cur.scene === 'future'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="52" class="rowlabel">step t+1 is planned before step t has sampled · the placeholder</text>
          {#each [
            { x: 30, y: 90, w: 200, h: 96, c: 'var(--accent)', title: 'CPU · plan step t+1', lines: ['decode input for our Req:', 'not a token id yet, but', 'future_slot[7]'] },
            { x: 260, y: 90, w: 200, h: 96, c: 'var(--gen)', title: 'GPU · step t · sampler', lines: ['samples 12366 for our Req', 'writes it straight into', 'future_slot[7] = 12366'] },
            { x: 490, y: 90, w: 200, h: 96, c: 'var(--gen)', title: 'GPU · step t+1 · first kernel', lines: ['reads future_slot[7] → 12366', 'looks up its embedding', 'the step runs as normal'] },
          ] as b, i}
            <g in:fly={{ y: 8, delay: i * 350, duration: 300 }}>
              <rect x={b.x} y={b.y} width={b.w} height={b.h} rx="12" fill="#fbfaf7" stroke={b.c} />
              <text x={b.x + 14} y={b.y + 22} class="slab strong small">{b.title}</text>
              {#each b.lines as l, k}<text x={b.x + 14} y={b.y + 44 + k * 17} class={k === 2 ? 'mono' : 'tag'}>{l}</text>{/each}
            </g>
          {/each}
          <path d="M 232 138 H 254" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#en-grey)" />
          <path d="M 462 138 H 484" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#en-grey)" />
          <!-- the buffer -->
          <g in:fade={{ delay: 1100 }}>
            <text x="30" y="226" class="rowlabel">future_token_ids · a small buffer in GPU memory</text>
            {#each Array(12) as _, k}
              <rect x={30 + k * 40} y="236" width="36" height="26" rx="4" fill={k === 7 ? 'var(--gen-soft)' : 'white'} stroke={k === 7 ? 'var(--gen)' : 'var(--line)'} />
              <text x={48 + k * 40} y="253" text-anchor="middle" class="mono">{k === 7 ? '12366' : k < 7 ? '·' : ''}</text>
              <text x={48 + k * 40} y="276" text-anchor="middle" class="tag">{k}</text>
            {/each}
          </g>
          <g in:fade={{ delay: 1700 }}>
            <text x="30" y="316" class="legend">the CPU never waits for the token and never copies it back; it hands out slot numbers and lets the GPU fill and read them</text>
            <text x="30" y="338" class="legend muted">only the bookkeeping waits for a copy: appending the id to the Req and checking for EOS,</text>
            <text x="30" y="356" class="legend muted">and that happens in the results phase, one step behind the GPU</text>
            <text x="30" y="382" class="tag muted">SGLang: <tspan class="mono">TpModelWorkerClient</tspan> · <tspan class="mono">future_token_ids_map</tspan> · <tspan class="mono">resolve_future_token_ids</tspan></text>
          </g>
        </g>
      {/if}

      {#if cur.scene === 'map'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="44" class="rowlabel">python/sglang/srt/</text>
          {#each [
            ['entrypoints/http_server.py', 'the HTTP server · process 1', '9'],
            ['managers/tokenizer_manager.py', 'tokenize, own the streams', '9'],
            ['managers/scheduler.py', 'the loop you just watched', '6 · 9 · 10'],
            ['managers/schedule_batch.py', 'Req and ScheduleBatch', '10'],
            ['managers/schedule_policy.py', 'FCFS, LPM, the chunk cap', '6 · 8'],
            ['managers/detokenizer_manager.py', 'ids → text · process 3', '9'],
            ['mem_cache/memory_pool.py', 'the page pool', '7'],
            ['mem_cache/radix_cache.py', 'the tree', '8'],
            ['model_executor/model_runner.py', 'the forward pass', '4 · 10'],
            ['model_executor/cuda_graph_runner.py', 'a thousand kernels as one', String(CH_CUDA)],
            ['layers/attention/', 'paged attention kernels', '2 · 3'],
            ['layers/sampler.py', 'logits → tokens', '10'],
            ['disaggregation/', 'prefill and decode apart', String(CH_DISAGG)],
          ] as [f, d, ch], i}
            <g in:fly={{ x: -6, delay: i * 60, duration: 200 }}>
              <text x="32" y={68 + i * 23} class="mono">{f}</text>
              <text x="330" y={68 + i * 23} class="tag">{d}</text>
              <rect x="600" y={56 + i * 23} width={badgeW('ch ' + ch)} height="16" rx="8" fill="var(--accent-soft)" />
              <text x="609" y={68 + i * 23} class="tag strong" fill="var(--accent)">ch {ch}</text>
            </g>
          {/each}
          <text x="16" y="386" class="legend muted" in:fade={{ delay: 1000 }}>every chapter so far is one file. The rest of the site is what those files do when the model doesn't fit on one GPU, or one machine.</text>
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
  .mono { font-family: var(--mono); font-size: 10.5px; fill: var(--fg); }
  .tag { font-size: 10px; fill: var(--muted); }
  .tag.strong, .tag .strong { fill: var(--fg); font-weight: 600; }
  .tiny { font-size: 8.5px; fill: white; font-weight: 600; }
  .tag.muted { fill: var(--faint); }
  .tiny.dark { fill: var(--fg); font-weight: 400; font-family: var(--mono); }
  .steplabel { font-size: 10px; fill: white; font-weight: 600; }
  .slab { font-size: 12px; fill: var(--fg); }
  .slab.strong { font-weight: 650; font-size: 14px; }
  .slab.strong.small { font-size: 12px; }
  .legend { font-size: 11.5px; fill: var(--fg); }
  .legend.muted { fill: var(--muted); }
  .req { transition: transform 600ms cubic-bezier(0.2, 0.8, 0.2, 1); }
</style>
