<script lang="ts">
  import { fade, fly } from 'svelte/transition';
  import StepControls from '../StepControls.svelte';
  import { chapterNumber as chNum, chapters, type NavLink } from '../../chapters';
  import { W_GB, HBM_GB, BW } from '../../numbers';
  let { prev, next }: { prev?: NavLink; next?: NavLink } = $props();
  const CH_ENGINE = chNum('10-engine'), CH_TP = chNum('24-tensor-parallel'), CH_DP = chNum('26-dp-attention');

  const tStep = W_GB / BW;                                  // ≈ 4.8 ms decode step, from chapter 4
  const fmt = (ms: number) => (ms < 10 ? ms.toFixed(1) : ms.toFixed(0)) + ' ms';

  // ---- Script ---------------------------------------------------------------------------------------------
  type Scene = 'system' | 'timeline' | 'queue' | 'zmq';
  interface Step { caption: string; scene: Scene; v?: number }
  const steps: Step[] = [
    { scene: 'system', v: 0, caption: `Launch the server. It loads the ${W_GB} GB of weights onto the GPU, carves most of the rest of the card into a KV pool, and opens an HTTP port. Then it waits.` },
    { scene: 'system', v: 1, caption: `A client sends a chat request: JSON over HTTP, with <code>stream: true</code>. The server parses it and applies the chat template. Now it has a string, and the GPU can't use a string.` },
    { scene: 'system', v: 2, caption: `Tokenization turns the text into ids, Ch. 1 Step 2. It's CPU work: microseconds for a short prompt, a couple of milliseconds for a long one. Now the ids need to reach the scheduler loop, which needs the CPU too.` },
    { scene: 'timeline', v: 0, caption: `Put it all in one process and the scheduler loop shares one Python interpreter with the HTTP server, the tokenizer, and the detokenizer. Python runs one at a time, so every one of those jobs lands between steps while the GPU idles.` },
    { scene: 'timeline', v: 1, caption: `So SGLang splits the work into three processes: one talks HTTP and tokenizes, one runs the scheduler loop that drives the GPU and nothing else, one turns ids back into text. Three interpreters on three cores; the loop never waits.` },
    { scene: 'queue', v: 0, caption: `Three processes need a way to hand things over. <b>ZeroMQ</b> is a queue between processes: the tokenizer drops a message in and moves on. At the top of every step the scheduler takes out whatever has arrived. Neither waits for the other.` },
    { scene: 'zmq', v: 1, caption: `Three wires, three queues, each touched by exactly two processes. The same request rides around the outside, changing shape at each hop but keeping its rid. A queue over a Unix socket works over TCP too.` },
    { scene: 'system', v: 3, caption: `Inside the scheduler the message becomes a <b>Req</b>, the object that carries this request from here on. It joins the waiting list, gets its prefill, then a token every step, as chapters 6 to 8 described.` },
    { scene: 'system', v: 4, caption: `The detokenizer turns each id into text, and the server sends it to the client as a server-sent event, one per token. Ch. 6 Step 9 picked the batch. What else does process 2 do to put out one id every ${fmt(tStep)}? Chapter ${CH_ENGINE}.` },
  ];

  let step = $state(0);
  $effect(() => {
    const q = Number(new URLSearchParams(window.location.search).get('step'));
    if (q >= 1 && q <= steps.length) step = q - 1;
  });
  const cur = $derived(steps[step]);
  const v = $derived(cur.v ?? 0);
  // within-step phases for the queue animation, replayed on every step change
  let phase = $state(0);
  $effect(() => {
    const sc = steps[step].scene;
    phase = 0;
    const plan = sc === 'queue' ? [600, 1500, 2400, 4400, 5200] : [];
    const timers = plan.map((ms, i) => setTimeout(() => (phase = i + 1), ms));
    return () => timers.forEach(clearTimeout);
  });
  const mk = (c: string) => `url(#oa-${c})`;

  // ---- System diagram geometry -------------------------------------------------------------------------------
  const CL = { x: 12, y: 130, w: 96, h: 84 };             // client
  const SV = { x: 158, y: 90, w: 190, h: 124 };           // server process: http + tokenizer
  const SC = { x: 404, y: 60, w: 300, h: 184 };           // scheduler process
  const DT = { x: 158, y: 262, w: 190, h: 64 };           // detokenizer process
  const W = 720, H = 400;

  // ---- Timeline: the same segments, placed on one lane (v=0) or on three process lanes (v=1) ------------
  const TL = { x: 150, pxPerMs: 13 };
  const LANE = { single: 78, server: 70, sched: 122, detok: 174 };
  type Kind = 'step' | 'tok' | 'json' | 'detok' | 'write';
  interface Seg { kind: Kind; ms: number; lane: 'server' | 'sched' | 'detok'; t: number }   // t = start in the three-lane picture
  const segs: Seg[] = [
    { kind: 'step', ms: tStep, lane: 'sched', t: 0 },
    { kind: 'detok', ms: 0.4, lane: 'detok', t: tStep + 0.1 },
    { kind: 'write', ms: 0.6, lane: 'server', t: tStep + 0.7 },
    { kind: 'step', ms: tStep, lane: 'sched', t: tStep },
    { kind: 'json', ms: 0.3, lane: 'server', t: 0.4 },
    { kind: 'tok', ms: 2.1, lane: 'server', t: 0.9 },
    { kind: 'detok', ms: 0.4, lane: 'detok', t: 2 * tStep + 0.1 },
    { kind: 'write', ms: 0.6, lane: 'server', t: 2 * tStep + 0.7 },
    { kind: 'step', ms: tStep, lane: 'sched', t: 2 * tStep },
    { kind: 'detok', ms: 0.4, lane: 'detok', t: 3 * tStep + 0.1 },
    { kind: 'write', ms: 0.6, lane: 'server', t: 3 * tStep + 0.7 },
    { kind: 'step', ms: tStep, lane: 'sched', t: 3 * tStep },
    { kind: 'tok', ms: 1.6, lane: 'server', t: 2 * tStep + 1.6 },
    { kind: 'detok', ms: 0.4, lane: 'detok', t: 4 * tStep + 0.1 },
    { kind: 'write', ms: 0.6, lane: 'server', t: 4 * tStep + 0.7 },
    { kind: 'step', ms: tStep, lane: 'sched', t: 4 * tStep },
  ];
  const singleStart = segs.map((_, i) => segs.slice(0, i).reduce((a, x) => a + x.ms, 0));
  const singleTotal = segs.reduce((a, x) => a + x.ms, 0);
  const singleIdle = segs.filter((x) => x.kind !== 'step').reduce((a, x) => a + x.ms, 0);
  const kindColor: Record<Kind, string> = { step: 'var(--gen)', tok: 'var(--accent)', json: '#7c3aed', detok: '#0891b2', write: '#16a34a' };
  const kindLabel: Record<Kind, string> = { step: 'GPU step', tok: 'tokenize', json: 'parse JSON', detok: 'detokenize', write: 'write responses' };
  const segPos = (i: number, multi: boolean) => multi
    ? { x: TL.x + segs[i].t * TL.pxPerMs, y: LANE[segs[i].lane] }
    : { x: TL.x + singleStart[i] * TL.pxPerMs, y: LANE.single };
</script>

<figure class="viz">
  <div class="canvas">
    <svg viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="One request end to end, step {step + 1}">
      <defs>
        {#each [['grey', '#b8b4aa'], ['accent', '#2f5bea'], ['gen', '#d97706'], ['cyan', '#0891b2'], ['green', '#16a34a']] as [n, c]}
          <marker id="oa-{n}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={c} />
          </marker>
        {/each}
      </defs>

      <!-- System diagram -->
      {#if cur.scene === 'system'}
        {@const procs = v >= 3}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="40" class="rowlabel">{v === 0 ? 'sglang serve --model-path … --port 30000' : v <= 2 ? 'one request comes in' : 'one request, all the way through'}</text>

          <!-- client -->
          {#if v >= 1}
            <g in:fade>
              <rect x={CL.x} y={CL.y} width={CL.w} height={CL.h} rx="10" fill="white" stroke="var(--line)" />
              <text x={CL.x + 12} y={CL.y + 20} class="boxtitle">client</text>
              <text x={CL.x + 12} y={CL.y + 44} class="tag">POST /v1/chat/</text>
              <text x={CL.x + 12} y={CL.y + 58} class="tag">completions</text>
              <text x={CL.x + 12} y={CL.y + 74} class="tag">stream: true</text>
            </g>
          {/if}

          <!-- server process -->
          <rect x={SV.x} y={SV.y} width={SV.w} height={SV.h} rx="10" fill="#fbfaf7" stroke={v === 1 || v === 2 || v === 4 ? 'var(--accent)' : 'var(--line)'} stroke-width={v === 1 || v === 2 || v === 4 ? 2 : 1} />
          <text x={SV.x + 12} y={SV.y + 20} class="boxtitle">{procs ? 'process 1 · server' : 'http server'}</text>
          <text x={SV.x + 12} y={SV.y + 42} class="slab small">listening on :30000</text>
          <text x={SV.x + 12} y={SV.y + 60} class="tag">async · thousands of connections</text>
          {#if v >= 2}
            <text x={SV.x + 12} y={SV.y + 86} class="slab small" in:fade>tokenizer</text>
            <text x={SV.x + 12} y={SV.y + 102} class="tag" in:fade>"The capital of France is"</text>
            <text x={SV.x + 12} y={SV.y + 116} class="tag" in:fade>→ 791 6864 315 9822 374</text>
          {:else}
            <text x={SV.x + 12} y={SV.y + 86} class="slab small">tokenizer</text>
            <text x={SV.x + 12} y={SV.y + 104} class="tag">text ↔ ids</text>
          {/if}

          <!-- scheduler process with the GPU -->
          <rect x={SC.x} y={SC.y} width={SC.w} height={SC.h} rx="10" fill="#fbfaf7" stroke={v === 3 ? 'var(--gen)' : 'var(--line)'} stroke-width={v === 3 ? 2 : 1} />
          <text x={SC.x + 12} y={SC.y + 20} class="boxtitle">{procs ? 'process 2 · scheduler' : 'the scheduler loop'}</text>
          <rect x={SC.x + 12} y={SC.y + 32} width={SC.w - 24} height="64" rx="8" fill="white" stroke="var(--line)" />
          <text x={SC.x + 22} y={SC.y + 50} class="tag">GPU · {HBM_GB} GB</text>
          <rect x={SC.x + 22} y={SC.y + 58} width={(SC.w - 44) * (W_GB / HBM_GB)} height="24" rx="4" fill="var(--accent)" opacity="0.9" />
          <text x={SC.x + 22 + ((SC.w - 44) * (W_GB / HBM_GB)) / 2} y={SC.y + 74} text-anchor="middle" class="steplabel">weights</text>
          <rect x={SC.x + 22 + (SC.w - 44) * (W_GB / HBM_GB) + 3} y={SC.y + 58} width={(SC.w - 44) * (1 - W_GB / HBM_GB) - 3} height="24" rx="4" fill="white" stroke="#0891b2" stroke-dasharray="4 3" />
          <text x={SC.x + 22 + (SC.w - 44) * (W_GB / HBM_GB) + 3 + ((SC.w - 44) * (1 - W_GB / HBM_GB)) / 2} y={SC.y + 74} text-anchor="middle" class="tag">KV pool · {HBM_GB - W_GB} GB{v >= 3 ? ', pages' : ', empty'}</text>
          {#if v >= 3}
            <g in:fade>
              <text x={SC.x + 12} y={SC.y + 122} class="tag">waiting → <tspan class="strong">prefill</tspan> → running → <tspan class="strong">decode</tspan></text>
              {#each Array(7) as _, i}
                <rect x={SC.x + 12 + i * 20} y={SC.y + 136} width="16" height="16" rx="3" fill={i === 0 ? 'var(--accent)' : 'var(--gen)'} opacity="0.85" in:fly={{ x: -6, delay: 300 + i * 120, duration: 200 }} />
              {/each}
              <text x={SC.x + 12 + 7 * 20 + 6} y={SC.y + 148} class="tag">→ one id out, every {fmt(tStep)}</text>
              <text x={SC.x + 12} y={SC.y + 172} class="tag"><tspan class="mono">Req</tspan> · rid · input ids · output ids · pages · sampling</text>
            </g>
          {:else}
            <text x={SC.x + 12} y={SC.y + 122} class="tag">waiting list: empty · running: none</text>
            <text x={SC.x + 12} y={SC.y + 140} class="tag">polling its inbox, no GPU work yet</text>
          {/if}

          <!-- detokenizer -->
          {#if procs}
            <g in:fade>
              <rect x={DT.x} y={DT.y} width={DT.w} height={DT.h} rx="10" fill="#fbfaf7" stroke={v === 4 ? '#0891b2' : 'var(--line)'} stroke-width={v === 4 ? 2 : 1} />
              <text x={DT.x + 12} y={DT.y + 20} class="boxtitle">process 3 · detokenizer</text>
              <text x={DT.x + 12} y={DT.y + 44} class="tag">12366 → " Paris" · 13 → "."</text>
            </g>
          {/if}

          <!-- arrows per stage -->
          {#if v === 1}
            <g in:fade>
              <path d="M {CL.x + CL.w} {CL.y + 22} H {SV.x - 4}" fill="none" stroke="var(--accent)" stroke-width="1.5" marker-end={mk('accent')} />
              <text x={(CL.x + CL.w + SV.x) / 2} y={CL.y + 14} text-anchor="middle" class="tag strong">JSON</text>
            </g>
          {:else if v === 2}
            <path d="M {SV.x + SV.w} {SV.y + 60} H {SC.x - 4}" fill="none" stroke="var(--faint)" stroke-width="1.5" stroke-dasharray="4 3" marker-end={mk('grey')} />
            <text x={(SV.x + SV.w + SC.x) / 2} y={SV.y + 52} text-anchor="middle" class="tag">ids → ?</text>
            <!-- each side's CPU work and its rhythm: the server's comes at random, the loop's between GPU steps -->
            <g in:fade={{ delay: 500 }}>
              <text x={SV.x} y="266" class="tag strong">server · whenever a client sends</text>
              {#each [[0, 6], [18, 26], [72, 4], [104, 14], [142, 8], [164, 22]] as [dx, w]}
                <rect x={SV.x + dx} y="276" width={w} height="16" rx="2" fill="var(--accent)" opacity="0.85" />
              {/each}
              <text x={SV.x} y="310" class="tag">parse JSON, tokenize: µs to 2 ms</text>
              <text x={SV.x} y="324" class="tag">per token: ids → text, write it out</text>

              <text x={SC.x} y="266" class="tag strong">scheduler loop · once requests are running</text>
              {#each [0, 1, 2] as k}
                <rect x={SC.x + k * 100} y="276" width="6" height="16" rx="1.5" fill="var(--fg)" />
                <rect x={SC.x + k * 100 + 8} y="276" width="90" height="16" rx="2" fill="var(--gen)" opacity="0.85" />
                <text x={SC.x + k * 100 + 53} y="288" text-anchor="middle" class="steplabel">GPU step</text>
              {/each}
              <text x={SC.x} y="310" class="tag">GPU step: {fmt(tStep)} each, Ch. 4 Step 5's weight read</text>
              <rect x={SC.x} y="316" width="6" height="10" rx="1.5" fill="var(--fg)" />
              <text x={SC.x + 12} y="324" class="tag">between steps, on the CPU: pick the next batch</text>
            </g>
            <g in:fade={{ delay: 1100 }}>
              <text x="18" y="356" class="pt">·</text>
              <text x="28" y="356" class="legend">both sides are Python code, and both run on the CPU</text>
              <text x="18" y="374" class="pt">·</text>
              <text x="28" y="374" class="legend">the simplest hand-off: run both in one process, and pass the ids as a function call</text>
            </g>
          {:else if v >= 3}
            <path d="M {CL.x + CL.w} {CL.y + 22} H {SV.x - 4}" fill="none" stroke="var(--faint)" stroke-width="1.5" marker-end={mk('grey')} />
            <path d="M {SV.x + SV.w} {SV.y + 60} H {SC.x - 4}" fill="none" stroke={v === 3 ? 'var(--accent)' : 'var(--faint)'} stroke-width="1.5" marker-end={mk(v === 3 ? 'accent' : 'grey')} />
            <text x={(SV.x + SV.w + SC.x) / 2} y={SV.y + 52} text-anchor="middle" class="tag">ids</text>
            <path d="M {SC.x + 60} {SC.y + SC.h} V {DT.y + 32} H {DT.x + DT.w + 4}" fill="none" stroke={v === 4 ? '#0891b2' : 'var(--faint)'} stroke-width="1.5" marker-end={mk(v === 4 ? 'cyan' : 'grey')} />
            <text x={SC.x + 66} y={DT.y + 24} class="tag">token ids · zmq</text>
            <path d="M {DT.x + 30} {DT.y} V {SV.y + SV.h + 4}" fill="none" stroke={v === 4 ? '#0891b2' : 'var(--faint)'} stroke-width="1.5" marker-end={mk(v === 4 ? 'cyan' : 'grey')} />
            <text x={DT.x + 36} y={SV.y + SV.h + 30} class="tag">text · zmq</text>
            <path d="M {SV.x} {CL.y + 64} H {CL.x + CL.w + 4}" fill="none" stroke={v === 4 ? '#16a34a' : 'var(--faint)'} stroke-width="1.5" marker-end={mk(v === 4 ? 'green' : 'grey')} />
            {#if v === 4}
              <g in:fade={{ delay: 400 }}>
                <rect x={CL.x} y="338" width="330" height="52" rx="8" fill="white" stroke="#16a34a" />
                <text x={CL.x + 10} y="356" class="mono">data: {'{'}"choices":[{'{'}"delta":{'{'}"content":" Paris"{'}'}{'}'}]{'}'}</text>
                <text x={CL.x + 10} y="376" class="mono">data: {'{'}"choices":[{'{'}"delta":{'{'}"content":"."{'}'}{'}'}]{'}'}</text>
                <text x={CL.x + 342} y="367" class="tag">← one server-sent event per token, {fmt(tStep)} apart</text>
              </g>
            {/if}
          {/if}
          {#if v === 0}
            <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote" in:fade={{ delay: 900 }}>weights loaded once; the KV pool is most of Ch. 7 Step 1's {HBM_GB - W_GB} GB; the loop from Ch. 6 Step 9 is already spinning</text>
          {/if}
        </g>
      {/if}

      <!-- Timeline: one process, then the same work split across three -->
      {#if cur.scene === 'timeline'}
        {@const multi = v === 1}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="44" class="rowlabel">{multi ? `three processes · three interpreters · three cores · the same work, ${Math.round(5 * tStep)} ms instead of ${Math.round(singleTotal)}` : 'one process · everything shares one Python interpreter (the GIL) and one core'}</text>

          <!-- lane labels and baselines -->
          {#if multi}
            {#each [['server + tokenizer', LANE.server], ['scheduler + GPU', LANE.sched], ['detokenizer', LANE.detok]] as [name, y]}
              <text x={TL.x - 10} y={(y as number) + 18} text-anchor="end" class="rowlabel" in:fade>{name}</text>
              <line x1={TL.x} y1={(y as number) + 14} x2={TL.x + 25 * TL.pxPerMs} y2={(y as number) + 14} stroke="var(--line)" in:fade />
            {/each}
          {:else}
            <text x={TL.x - 10} y={LANE.single + 18} text-anchor="end" class="rowlabel">the only thread</text>
            <text x={TL.x - 10} y="140" text-anchor="end" class="rowlabel">GPU</text>
            {#each segs as sg, i}
              {@const x = TL.x + singleStart[i] * TL.pxPerMs}
              <rect {x} y="124" width={sg.ms * TL.pxPerMs - 1} height="24" rx="3" fill={sg.kind === 'step' ? 'var(--gen)' : '#ece9e2'} opacity="0.85" out:fade={{ duration: 200 }} />
              {#if sg.kind !== 'step' && sg.ms >= 1.5}<text x={x + (sg.ms * TL.pxPerMs) / 2} y="140" text-anchor="middle" class="tag" out:fade={{ duration: 200 }}>idle</text>{/if}
            {/each}
          {/if}

          <!-- the segments themselves: same elements in both steps, they slide into their lanes -->
          {#each segs as sg, i (i)}
            {@const pos = segPos(i, multi)}
            <g class="seg" style:transform="translate({pos.x}px, {pos.y}px)" style:transition-delay="{multi ? i * 40 : 0}ms">
              <rect width={Math.max(3, sg.ms * TL.pxPerMs - 1)} height="28" rx="3" fill={kindColor[sg.kind]} opacity={sg.kind === 'step' ? 0.85 : 0.95} />
              {#if sg.kind === 'step'}<text x={(sg.ms * TL.pxPerMs) / 2} y="18" text-anchor="middle" class="steplabel">step</text>{/if}
            </g>
          {/each}

          <!-- axis -->
          <line x1={TL.x} y1="220" x2={TL.x + (multi ? 25 : singleTotal) * TL.pxPerMs} y2="220" stroke="var(--line)" class="axis" />
          {#each (multi ? [0, 5, 10, 15, 20] : [0, 10, 20, 30]) as ms (ms)}
            <text x={TL.x + ms * TL.pxPerMs} y="234" text-anchor="middle" class="tag" in:fade>{ms} ms</text>
          {/each}
          {#each Object.keys(kindLabel) as k, i}
            <rect x={TL.x + i * 118} y="250" width="12" height="12" rx="2" fill={kindColor[k as Kind]} /><text x={TL.x + i * 118 + 18} y="260" class="tag">{kindLabel[k as Kind]}</text>
          {/each}

          {#if multi}
            <g in:fade={{ delay: 1200 }}>
              <text x="16" y="300" class="legend">the GPU lane is solid: tokenizing the next prompt and detokenizing the last step's tokens happen <tspan class="strong">while</tspan> the current step runs</text>
              <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">with tensor parallelism there is one scheduler process per GPU (chapter {CH_TP}); the server and detokenizer stay single</text>
            </g>
          {:else}
            <g in:fade={{ delay: 900 }}>
              <text x="18" y="300" class="pt">·</text><text x="28" y="300" class="legend">GPU idle <tspan class="strong">{Math.round((singleIdle / singleTotal) * 100)}%</tspan> of the time, and the gaps are random: a long prompt to tokenize, a burst of clients to answer</text>
              <text x="18" y="322" class="pt">·</text><text x="28" y="322" class="legend">a {fmt(tStep)} step can't afford to share its interpreter with anything that takes milliseconds</text>
            </g>
          {/if}
        </g>
      {/if}

      <!-- Queue: what ZMQ is, before why -->
      {#if cur.scene === 'queue'}
        {@const QX = 250}
        {@const QW = 220}
        {@const slots = 6}
        {@const inQ = phase === 0 ? 0 : phase <= 3 ? phase : 0}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="44" class="rowlabel">a queue between two processes</text>
          <rect x="30" y="116" width="170" height="98" rx="12" fill="#fbfaf7" stroke="var(--accent)" />
          <text x="115" y="144" text-anchor="middle" class="slab strong small">server + tokenizer</text>
          <text x="115" y="164" text-anchor="middle" class="tag">process 1 · its own loop:</text>
          <text x="115" y="180" text-anchor="middle" class="tag">accept → tokenize → put</text>

          <rect x="520" y="116" width="170" height="112" rx="12" fill="#fbfaf7" stroke="var(--gen)" />
          <text x="605" y="144" text-anchor="middle" class="slab strong small">scheduler</text>
          <text x="605" y="164" text-anchor="middle" class="tag">process 2 · its own loop:</text>
          <text x="605" y="180" text-anchor="middle" class="tag">take → step → put</text>

          <rect x={QX} y="146" width={QW} height="38" rx="8" fill="white" stroke="var(--line)" />
          {#each Array(slots) as _, i}
            <rect x={QX + 8 + i * 34} y="154" width="28" height="22" rx="4" fill="white" stroke="var(--line)" stroke-dasharray="3 2" />
          {/each}
          {#each Array(inQ) as _, i (i)}
            {@const sx = QX + 8 + i * 34}
            <rect x={sx} y="154" width="28" height="22" rx="4" fill="var(--accent)" opacity="0.9"
                  in:fly={{ x: 150 - sx, y: 0, duration: 600 }} out:fly={{ x: 590 - sx, y: 0, duration: 700 }} />
          {/each}
          <text x={QX + QW / 2} y="136" text-anchor="middle" class="tag strong">the zmq socket · a queue</text>
          <path d="M 204 165 H {QX - 4}" fill="none" stroke="var(--faint)" stroke-width="1.5" marker-end={mk('grey')} />
          <text x={(204 + QX) / 2} y="158" text-anchor="middle" class="tag">put</text>
          <path d="M {QX + QW + 4} 165 H 516" fill="none" stroke="var(--faint)" stroke-width="1.5" marker-end={mk('grey')} />
          <text x={(QX + QW + 516) / 2} y="158" text-anchor="middle" class="tag">take</text>

          <rect x="540" y="192" width="130" height="8" rx="3" fill="var(--line)" />
          <rect x="540" y="192" width="130" height="8" rx="3" fill="var(--gen)" class="stepfill" style:animation-play-state={phase >= 4 ? 'paused' : 'running'} />
          <text x="605" y="248" text-anchor="middle" class="tag" fill="var(--gen)">{phase < 4 ? 'busy: a step in progress' : phase === 4 ? 'step done → take all 3 at once' : 'next step: 3 newcomers in the waiting list'}</text>
          {#if phase >= 1 && phase <= 3}
            <text x="115" y="248" text-anchor="middle" class="tag" fill="var(--accent)">request {phase} tokenized → put → back to accepting</text>
          {/if}
          {#if phase >= 5}
            {#each Array(3) as _, i}
              <rect x={548 + i * 34} y="208" width="28" height="10" rx="3" fill="var(--accent)" opacity="0.9" in:fade />
            {/each}
          {/if}
          <text x={QX + QW / 2} y="276" text-anchor="middle" class="tag">process 1 puts and moves on · process 2 takes everything at the top of its next step</text>
          <g in:fade={{ delay: 5600 }}>
            <text x="30" y="318" class="pt">·</text><text x="40" y="318" class="legend">the same shape on every wire: scheduler → detokenizer, detokenizer → server</text>
            <text x="30" y="340" class="pt">·</text><text x="40" y="340" class="legend">a Unix socket underneath, tens of microseconds; messages wait in the receiver's queue until it asks for them</text>
          </g>
        </g>
      {/if}

      <!-- ZMQ: three processes, three queues, the object riding around the outside -->
      {#if cur.scene === 'zmq'}
        {@const Q = [
          { x: 312, y: 132, c: 'var(--accent)' },
          { x: 422, y: 215, c: 'var(--gen)' },
          { x: 202, y: 215, c: '#0891b2' },
        ]}
        <g transition:fade={{ duration: 250 }}>
          <!-- outer triangle: the processes -->
          <rect x="70" y="66" width="160" height="48" rx="10" fill="#fbfaf7" stroke="var(--accent)" />
          <text x="150" y="86" text-anchor="middle" class="slab strong small">server + tokenizer</text>
          <text x="150" y="104" text-anchor="middle" class="tag">process 1</text>
          <rect x="490" y="66" width="160" height="48" rx="10" fill="#fbfaf7" stroke="var(--gen)" />
          <text x="570" y="86" text-anchor="middle" class="slab strong small">scheduler</text>
          <text x="570" y="104" text-anchor="middle" class="tag">process 2</text>
          <rect x="280" y="306" width="160" height="48" rx="10" fill="#fbfaf7" stroke="#0891b2" />
          <text x="360" y="326" text-anchor="middle" class="slab strong small">detokenizer</text>
          <text x="360" y="344" text-anchor="middle" class="tag">process 3</text>

          <!-- inner triangle: one zmq queue per wire, each touched by exactly two processes -->
          {#each Q as q, i}
            <g in:fade={{ delay: 200 + i * 150 }}>
              <rect x={q.x} y={q.y} width="96" height="22" rx="6" fill="white" stroke="var(--line)" />
              {#each Array(4) as _, k}
                <rect x={q.x + 6 + k * 22} y={q.y + 5} width="18" height="12" rx="3" fill={k < 2 ? q.c : 'white'} stroke={k < 2 ? 'none' : 'var(--line)'} stroke-dasharray={k < 2 ? 'none' : '3 2'} opacity={k < 2 ? 0.9 : 1} />
              {/each}
            </g>
          {/each}
          <!-- producer → queue → consumer -->
          <path d="M 232 104 L 306 141" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end={mk('grey')} />
          <path d="M 412 141 L 486 104" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end={mk('grey')} />
          <path d="M 572 116 L 506 212" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end={mk('grey')} />
          <path d="M 446 240 L 412 302" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end={mk('grey')} />
          <path d="M 308 302 L 274 240" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end={mk('grey')} />
          <path d="M 214 212 L 148 116" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end={mk('grey')} />

          <!-- the object, riding around the outside, in the shape each wire carries -->
          {#each [
            { x: 272, y: 22, w: 176, title: 'TokenizedGenerateReqInput', body: 'rid a1f3 · ids […]', c: 'var(--accent)', bg: 'var(--accent-soft)' },
            { x: 520, y: 248, w: 176, title: 'BatchTokenIDOutput', body: 'rids […] · ids [12366, …]', c: 'var(--gen)', bg: 'var(--gen-soft)' },
            { x: 24, y: 248, w: 176, title: 'BatchStrOutput', body: 'rids […] · [" Paris", …]', c: '#0891b2', bg: '#cffafe' },
          ] as m, i}
            <g in:fly={{ y: 6, delay: 700 + i * 250, duration: 300 }}>
              <rect x={m.x} y={m.y} width={m.w} height="38" rx="8" fill={m.bg} />
              <text x={m.x + 10} y={m.y + 15} class="mono strong" fill={m.c}>{m.title}</text>
              <text x={m.x + 10} y={m.y + 29} class="mono" fill={m.c}>{m.body}</text>
            </g>
          {/each}

          <g in:fade={{ delay: 1500 }}>
            <text x="360" y="386" text-anchor="middle" class="tag"><tspan class="strong">any transport</tspan> · ipc:// here; tcp:// with data-parallel attention (chapter {CH_DP}), same code</text>
          </g>
        </g>
      {/if}

    </svg>
  </div>

  <StepControls {step} total={steps.length} caption={cur.caption} {prev} {next} onchange={(s) => (step = s)} />
</figure>

<style>
  .mono.strong { font-weight: 700; }
  .tag.muted { fill: var(--faint); }
  .seg { transition: transform 700ms cubic-bezier(0.2, 0.8, 0.2, 1); }
  .stepfill { transform-box: fill-box; transform-origin: left center; animation: stepfill 4.4s linear forwards; }
  @keyframes stepfill { from { transform: scaleX(0); } to { transform: scaleX(1); } }
</style>
