<script lang="ts">
  import { untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import StepControls from '../StepControls.svelte';
  import LoopProgress from '../LoopProgress.svelte';
  import { chapterNumber as chNum, type NavLink } from '../../chapters';
  import { BYTES, OMNI_HIDDEN, VISION_PATCH, VISION_MERGE, AUDIO_FRAMES_PER_SEC, AUDIO_POS_PER_100, CODES_PER_FRAME, SPEECH_OUT_HZ, SAMPLES_PER_FRAME } from '../../numbers';
  let { prev, next }: { prev?: NavLink; next?: NavLink } = $props();

  const CH_PROC = chNum('09-one-request'), CH_OMNI = chNum('15-omni-models'), CH_STAGES = chNum('16-stages-and-schedulers');
  const CH_GPUS = chNum('18-sharing-gpus'), CH_DISAGG = chNum('28-disaggregation');

  // chapter 15's request, in the units that cross the edges
  const PHOTO = 896, Q_SEC = 10, CHUNK = 10;
  const fmt = (n: number) => n.toLocaleString('en-US');
  const IMG_POS = (PHOTO / (VISION_PATCH * VISION_MERGE)) ** 2;          // 784
  const AUD_POS = (Q_SEC * AUDIO_FRAMES_PER_SEC / 100) * AUDIO_POS_PER_100; // 130
  const VEC_KB = (OMNI_HIDDEN * BYTES) / 1024;                             // 4 KB per vector or embedding
  const FRAME_MS = (SAMPLES_PER_FRAME / SPEECH_OUT_HZ) * 1000;            // 80

  type Scene = 'edges' | 'handoff' | 'planes' | 'map' | 'local' | 'cudaipc' | 'shm' | 'remote' | 'layout' | 'coordinator' | 'closing';
  const steps: { scene: Scene; caption: string }[] = [
    { scene: 'edges', caption: `Ch. ${CH_STAGES} Step 12 numbered the edges. What crosses them ranges from one token id to ${fmt(IMG_POS * VEC_KB)} KB of embeddings, sent once per request or once per token.` },
    { scene: 'handoff', caption: `A hand-off has two parts. The data goes somewhere the receiver can read it, and a small notice over ZMQ says where. Once the receiver has read it, an ack lets the sender free the space.` },
    { scene: 'planes', caption: `Why not send the data itself over ZMQ? A ZMQ message is bytes in CPU memory, so a vector on GPU 0 would leave the GPU, cross the socket and come back. With the notice on its own, the data can take a shorter path.` },
    { scene: 'map', caption: `SGLang-Omni picks the data's path for each edge from where its two stages sit. There are four cases, from sharing a process to sitting on different machines.` },
    { scene: 'local', caption: `When two stages share a process, the sender hands over the Python object itself. Nothing is copied and no notice crosses a socket. The receiver must not change the object, since the sender still holds it.` },
    { scene: 'cudaipc', caption: `When the data is on a GPU and both stages run on GPUs in one machine, the sender passes a handle to its GPU memory. The receiver opens the handle and reads the data, over the link between GPUs if it sits on another.` },
    { scene: 'shm', caption: `When the data is in CPU memory, or a stage runs on the CPU, the sender writes it once into shared memory. The receiver maps the same memory and reads it in place.` },
    { scene: 'remote', caption: `When the receiver is on another machine, Mooncake moves the data. Its network cards read the sender's memory and write the receiver's directly, with no copy through either CPU.` },
    { scene: 'layout', caption: `Qwen3-Omni's default layout, edge by edge. The four GPU-to-GPU edges use CUDA IPC, the edges with a CPU end use shared memory, and no two stages share a process.` },
    { scene: 'coordinator', caption: `One more process, the coordinator, sits outside the graph. It hands each request to the first stage, merges the text and the sound that come out into one response, and sends an abort to every stage at once.` },
    { scene: 'closing', caption: `Which path an edge takes depends on where its two stages sit. Ch. ${CH_STAGES} Step 4 put four stages on GPU 0 and the talker alone on GPU 1. Who decides that, and how do stages on one GPU split its memory?` },
  ];

  let step = $state(0);
  $effect(() => {
    const q = Number(new URLSearchParams(window.location.search).get('step'));
    if (q >= 1 && q <= steps.length) step = q - 1;
  });
  const cur = $derived(steps[step]);

  // step 2's loop: the vector's walk from the thinker's scheduler to the talker's inbox
  const HOPS = 11;
  let lap = $state(0), lapMs = $state(0);           // the looping step's laps, for LoopProgress
  const nextLap = (ms: number) => untrack(() => { lapMs = ms; lap++; });   // untracked, so starting a lap does not re-run the effect
  let hp = $state(0);
  $effect(() => {
    if (cur.scene !== 'handoff') return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const run = () => {
      hp = 0;
      for (let i = 1; i < HOPS; i++) timers.push(setTimeout(() => (hp = i), 1500 + i * 2600));
      timers.push(setTimeout(run, 1500 + HOPS * 2600 + 3000));
      nextLap(1500 + HOPS * 2600 + 3000);
    };
    run();
    return () => timers.forEach(clearTimeout);
  });

  const W = 720, H = 400;
  const RED = 'var(--eos)';
  const NOMODEL = '#ece9e1';
  const IPC = 'var(--accent)', SHM = 'var(--gen)';

  // chapter 16's graph, compact: the seven stages and edges 1–8
  const G = {
    pre: { x: 16, y: 104, n: 'preprocessing', d: 'CPU', f: NOMODEL, s: 'var(--faint)' },
    img: { x: 162, y: 60, n: 'image_encoder', d: 'GPU 0', f: 'white', s: 'var(--fg)' },
    aud: { x: 162, y: 148, n: 'audio_encoder', d: 'GPU 0', f: 'white', s: 'var(--fg)' },
    thk: { x: 308, y: 104, n: 'thinker', d: 'GPU 0', f: 'var(--accent-soft)', s: 'var(--accent)' },
    dec: { x: 454, y: 60, n: 'decode', d: 'CPU', f: NOMODEL, s: 'var(--faint)' },
    tlk: { x: 454, y: 148, n: 'talker_ar', d: 'GPU 1', f: 'var(--accent-soft)', s: 'var(--accent)' },
    c2w: { x: 602, y: 148, n: 'code2wav', d: 'GPU 0', f: 'white', s: 'var(--fg)' },
  };
  type Node = (typeof G)['pre'];
  const GBW = 100, GBH = 36;
  const EDGES: { a: Node; b: Node; t: 'shm' | 'ipc' }[] = [
    { a: G.pre, b: G.img, t: 'shm' }, { a: G.pre, b: G.aud, t: 'shm' }, { a: G.pre, b: G.thk, t: 'shm' },
    { a: G.img, b: G.thk, t: 'ipc' }, { a: G.aud, b: G.thk, t: 'ipc' },
    { a: G.thk, b: G.dec, t: 'shm' }, { a: G.thk, b: G.tlk, t: 'ipc' }, { a: G.tlk, b: G.c2w, t: 'ipc' },
  ];
  const ey = (n: Node) => n.y + GBH / 2;
  const edgePath = (a: Node, b: Node) =>
    `M ${a.x + GBW + 6} ${ey(a)} C ${a.x + GBW + 16} ${ey(a)}, ${b.x - 26} ${ey(b)}, ${b.x - 20} ${ey(b)} L ${b.x - 6} ${ey(b)}`;
  const mid = (a: Node, b: Node) => [(a.x + GBW + b.x) / 2, (ey(a) + ey(b)) / 2];
</script>

<figure class="viz">
  <div class="canvas">
    <svg viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Between stages, step {step + 1}">
      <defs>
        {#each [['bs-arrow', '#b8b4aa'], ['bs-arrow-red', 'var(--eos)'], ['bs-arrow-ipc', 'var(--accent)'], ['bs-arrow-shm', 'var(--gen)'], ['bs-arrow-fg', 'var(--fg)']] as [id, c]}
          <marker {id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={c} />
          </marker>
        {/each}
      </defs>

      <!-- chapter 16's graph, compact; each edge coloured by colourOf and badged with its number -->
      {#snippet graph(colourOf: (t: 'shm' | 'ipc') => string, markerOf: (t: 'shm' | 'ipc') => string)}
        {#each EDGES as e, i}
          {@const [mx, my] = mid(e.a, e.b)}
          <path d={edgePath(e.a, e.b)} fill="none" stroke={colourOf(e.t)} stroke-width="1.5" marker-end="url(#{markerOf(e.t)})" />
          <circle cx={mx} cy={my} r="7.5" fill="white" stroke={colourOf(e.t)} />
          <text x={mx} y={my + 3.5} text-anchor="middle" class="tag strong">{i + 1}</text>
        {/each}
        {#each Object.values(G) as n}
          <rect x={n.x} y={n.y} width={GBW} height={GBH} rx="7" fill={n.f} stroke={n.s} />
          <text x={n.x + GBW / 2} y={n.y + 15} text-anchor="middle" class="mono strong">{n.n}</text>
          <text x={n.x + GBW / 2} y={n.y + 28} text-anchor="middle" class="tag">{n.d}</text>
        {/each}
      {/snippet}

      <!-- 1: what crosses each edge, how big, how often -->
      {#if cur.scene === 'edges'}
        {@const rows = [
          ['1', 'preprocessing → image_encoder', 'the photo, as patches', `${PHOTO} × ${PHOTO} × 3 = ${fmt(PHOTO * PHOTO * 3)} values`, 'once'],
          ['2', 'preprocessing → audio_encoder', 'the question, as frames', `${Q_SEC} s × ${AUDIO_FRAMES_PER_SEC} = ${fmt(Q_SEC * AUDIO_FRAMES_PER_SEC)} feature frames`, 'once'],
          ['3', 'preprocessing → thinker', "the prompt's token ids", 'one number per text position', 'once'],
          ['4', 'image_encoder → thinker', `${IMG_POS} embeddings`, `${IMG_POS} × ${VEC_KB} KB = ${fmt(IMG_POS * VEC_KB)} KB`, 'once'],
          ['5', 'audio_encoder → thinker', `${AUD_POS} embeddings`, `${AUD_POS} × ${VEC_KB} KB = ${fmt(AUD_POS * VEC_KB)} KB`, 'once'],
          ['6', 'thinker → decode', 'a token id', 'one number', 'every token'],
          ['7', 'thinker → talker_ar', "the token's vector", `${fmt(OMNI_HIDDEN)} × ${BYTES} B = ${VEC_KB} KB`, 'every token'],
          ['8', 'talker_ar → code2wav', 'codes', `${CHUNK} frames × ${CODES_PER_FRAME} = ${CHUNK * CODES_PER_FRAME} numbers`, `every ${CHUNK} frames`],
          ['9–11', 'the same inputs → talker_ar', 'rows 3–5, for its prompt', 'as rows 3–5', 'once'],
        ]}
        {@const TX = [16, 48, 214, 372, 580]}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">what crosses each edge of Ch. {CH_STAGES} Step 12's graph · how big, and how often</text>
          <g in:fade={{ delay: 100, duration: 250 }}>
            {@render graph(() => RED, () => 'bs-arrow-red')}
          </g>
          <g in:fade={{ delay: 500, duration: 250 }}>
            {#each ['#', 'edge', 'what crosses', 'size', 'how often'] as h, i}
              <text x={TX[i]} y="208" class="tag strong">{h}</text>
            {/each}
            <line x1="16" y1="213" x2="704" y2="213" stroke="var(--line)" />
            {#each rows as r, k}
              {@const y = 227 + k * 13.5}
              {#each r as c, i}
                <text x={TX[i]} {y} class={i === 0 ? 'tag strong' : 'tag'} style:fill={i === 0 ? RED : (k === 5 || k === 6 || k === 7) && i === 4 ? 'var(--fg)' : null}>{c}</text>
              {/each}
            {/each}
          </g>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">{VEC_KB} KB: one vector is the thinker's width, {fmt(OMNI_HIDDEN)} numbers of {BYTES} bytes · the photo and the question: Ch. {CH_OMNI} Steps 1 and 2</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">edges 9–11 are not drawn: talker_ar builds its own prompt from the same inputs as the thinker</text>
        </g>
      {/if}

      <!-- 2: one hand-off, edge 7 · data through the data plane, a notice through ZMQ, an ack back -->
      {#if cur.scene === 'handoff'}
        {@const SX = 16}
        {@const RX = 484}
        {@const SW = 220}
        {@const pos = {
          sched: [SX + 110, 270], out: [SX + 110, 186], rt: [SX + 110, 146],
          buf: [360, 262],
          rrt: [RX + 110, 146], rin: [RX + 110, 186],
        }}
        {@const dataAt = hp <= 0 ? pos.sched : hp === 1 ? pos.out : hp === 2 ? pos.rt : hp <= 5 ? pos.buf : hp <= 8 ? pos.rrt : pos.rin}
        {@const notes = [
          "the thinker's scheduler has the token's vector ready",
          '1 · the scheduler puts it in the outbox',
          '2 · the runtime takes it and looks up the next stage, talker_ar',
          '3 · the runtime writes the vector where talker_ar can read it',
          '4 · it sends a small notice over ZMQ saying where the vector is',
          '4 · it sends a small notice over ZMQ saying where the vector is',
          "5 · talker_ar's runtime wakes on the notice and reads the vector",
          '6 · it sends an ack back, so the thinker can reuse that space',
          '6 · it sends an ack back, so the thinker can reuse that space',
          "7 · it puts the vector in talker_ar's inbox",
          "7 · it puts the vector in talker_ar's inbox",
        ]}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">one hand-off, edge 7 · thinker to talker_ar, one token's vector</text>

          <!-- the two stages, as Ch. 16 Step 2 drew them -->
          {#each [{ x: SX, n: 'thinker · GPU 0', q: 'outbox' }, { x: RX, n: 'talker_ar · GPU 1', q: 'inbox' }] as st, k}
            <rect x={st.x} y="60" width={SW} height="252" rx="12" fill="#fbfaf7" stroke="var(--fg)" />
            <text x={st.x + 12} y="77" class="boxtitle">{st.n}</text>
            <rect x={st.x + 12} y="86" width={SW - 24} height="76" rx="8" fill="white" stroke="var(--faint)" />
            <text x={st.x + SW / 2} y="103" text-anchor="middle" class="tag strong">runtime</text>
            <text x={st.x + SW / 2} y="116" text-anchor="middle" class="tag">talks to other stages</text>
            {#each [0, 1, 2] as j}
              <rect x={st.x + SW / 2 - 14} y={174 + j * 9} width="28" height="8" rx="2" fill="white" stroke="var(--faint)" />
            {/each}
            <text x={st.x + SW / 2 + (k ? -32 : 32)} y="190" text-anchor={k ? 'end' : 'start'} class="tag strong">{st.q}</text>
            <rect x={st.x + 12} y="216" width={SW - 24} height="84" rx="8" fill="white" stroke="var(--accent)" />
            <text x={st.x + SW / 2} y="236" text-anchor="middle" class="tag strong">scheduler</text>
            <text x={st.x + SW / 2} y="249" text-anchor="middle" class="tag">its own loop (Ch. {CH_STAGES} Step 2)</text>
          {/each}

          <!-- the control plane: the notice goes right, the ack comes back -->
          <text x="360" y="92" text-anchor="middle" class="tag strong">control plane · ZMQ</text>
          <text x="360" y="104" text-anchor="middle" class="tag">small messages (Ch. {CH_PROC} Step 6)</text>
          <path d="M {SX + SW + 6} 124 H {RX - 6}" fill="none" stroke="var(--line)" stroke-width="1.4" />
          <path d="M {RX - 6} 140 H {SX + SW + 6}" fill="none" stroke="var(--line)" stroke-width="1.4" stroke-dasharray="3 3" />
          <text x="360" y="160" text-anchor="middle" class="tag">notice → · ← ack</text>
          {#if hp >= 4 && hp <= 6}
            <g style="transform: translate({hp >= 5 ? RX - 70 : SX + SW + 8}px, 116px); transition: transform 1.1s ease-in-out;" transition:fade={{ duration: 200 }}>
              <rect x="0" y="0" width="62" height="16" rx="8" fill="white" stroke="var(--fg)" />
              <text x="31" y="11.5" text-anchor="middle" class="tag strong">data ready</text>
            </g>
          {/if}
          {#if hp >= 7 && hp <= 8}
            <g style="transform: translate({hp >= 8 ? SX + SW + 8 : RX - 44}px, 132px); transition: transform 1.1s ease-in-out;" transition:fade={{ duration: 200 }}>
              <rect x="0" y="0" width="36" height="16" rx="8" fill="white" stroke="var(--fg)" stroke-dasharray="3 2" />
              <text x="18" y="11.5" text-anchor="middle" class="tag strong">ack</text>
            </g>
          {/if}

          <!-- the data plane: somewhere the receiver can read -->
          <text x="360" y="222" text-anchor="middle" class="tag strong">data plane</text>
          <text x="360" y="234" text-anchor="middle" class="tag">the data itself</text>
          <rect x="314" y="246" width="92" height="32" rx="6" fill={hp >= 8 ? 'white' : 'var(--accent-soft)'} stroke="var(--accent)" stroke-dasharray={hp >= 8 ? '4 3' : 'none'} style="transition: fill 0.4s;" />
          <text x="360" y="292" text-anchor="middle" class="tag">{hp >= 8 ? 'freed for the next one' : 'space the receiver can read'}</text>

          <!-- the vector itself -->
          <g style="transform: translate({dataAt[0]}px, {dataAt[1]}px); transition: transform 1.1s ease-in-out;">
            <rect x="-24" y="-9" width="48" height="18" rx="9" fill="var(--gen)" />
            <text x="0" y="4" text-anchor="middle" class="tag onbox">vector</text>
          </g>

          <text x="16" y="342" class="legend"><tspan class="strong">{notes[hp]}</tspan></text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">SGLang-Omni's names: DataReadyMessage, DataAckMessage · how the data plane works depends on the edge (step 4)</text>
        </g>
      {/if}

      <!-- 3: why two planes · the same vector, sent through the socket or by the data plane -->
      {#if cur.scene === 'planes'}
        {@const hop = (x: number, y: number, n: string, f: string, s: string, w = 90) => ({ x, y, n, f, s, w })}
        {@const top = [hop(16, 92, 'GPU 0 memory', 'var(--accent-soft)', 'var(--accent)'), hop(150, 92, 'CPU memory', 'white', 'var(--fg)'), hop(284, 92, 'ZMQ socket', 'white', 'var(--fg)'), hop(418, 92, 'CPU memory', 'white', 'var(--fg)'), hop(552, 92, 'GPU 1 memory', 'var(--accent-soft)', 'var(--accent)')]}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">why the notice and the data travel apart · edge 7's vector, two ways</text>

          <g in:fade={{ delay: 100, duration: 250 }}>
            <text x="16" y="78" class="boxtitle">everything through ZMQ</text>
            {#each top as h, i}
              <rect x={h.x} y={h.y} width={h.w} height="34" rx="7" fill={h.f} stroke={h.s} />
              <text x={h.x + h.w / 2} y={h.y + 21} text-anchor="middle" class="tag strong">{h.n}</text>
              {#if i < top.length - 1}
                <path d="M {h.x + h.w + 6} {h.y + 17} H {top[i + 1].x - 6}" fill="none" stroke={RED} stroke-width="1.5" marker-end="url(#bs-arrow-red)" />
                <text x={(h.x + h.w + top[i + 1].x) / 2} y={h.y + 50} text-anchor="middle" class="tag">{['out of the GPU', 'into the socket', 'out of the socket', 'back to a GPU'][i]}</text>
              {/if}
            {/each}
            <text x="16" y="170" class="tag"><tspan class="strong" style:fill={RED}>4 trips</tspan> through CPU memory and the socket, for every token · the encoders' {fmt(IMG_POS * VEC_KB)} KB would take the same 4</text>
          </g>

          <g in:fade={{ delay: 700, duration: 250 }}>
            <text x="16" y="212" class="boxtitle">notice through ZMQ, data on its own path</text>
            <rect x="16" y="226" width="90" height="34" rx="7" fill="var(--accent-soft)" stroke="var(--accent)" />
            <text x="61" y="247" text-anchor="middle" class="tag strong">GPU 0 memory</text>
            <rect x="552" y="226" width="90" height="34" rx="7" fill="var(--accent-soft)" stroke="var(--accent)" />
            <text x="597" y="247" text-anchor="middle" class="tag strong">GPU 1 memory</text>
            <path d="M 112 243 H 546" fill="none" stroke="var(--accent)" stroke-width="2" marker-end="url(#bs-arrow-ipc)" />
            <text x="329" y="236" text-anchor="middle" class="tag strong">1 trip, GPU to GPU</text>
            <rect x="284" y="276" width="90" height="26" rx="7" fill="white" stroke="var(--fg)" />
            <text x="329" y="293" text-anchor="middle" class="tag strong">ZMQ socket</text>
            <path d="M 112 289 H 278" fill="none" stroke="#b8b4aa" stroke-width="1.2" stroke-dasharray="3 3" />
            <path d="M 380 289 H 546" fill="none" stroke="#b8b4aa" stroke-width="1.2" stroke-dasharray="3 3" marker-end="url(#bs-arrow)" />
            <text x="195" y="282" text-anchor="middle" class="tag">only the notice</text>
          </g>

          <g in:fade={{ delay: 1200 }}>
            <text x="18" y="330" class="pt">·</text><text x="28" y="330" class="legend">ZMQ carries bytes between processes' CPU memory, which suits a notice of a few fields</text>
            <text x="18" y="347" class="pt">·</text><text x="28" y="347" class="legend">the notice is the same whatever path the data takes, so each edge can use its own path</text>
          </g>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">trips counted as whole moves of the data, not to scale · the GPU-to-GPU path is step 6's</text>
        </g>
      {/if}

      <!-- 4: the map · where the two stages sit picks the data's path -->
      {#if cur.scene === 'map'}
        {@const rows = [
          { k: 1, where: 'in one process', how: 'a reference', what: 'nothing moves: the receiver gets the same object', eg: 'none by default' },
          { k: 2, where: 'on GPUs, one machine', how: 'CUDA IPC', what: "the receiver opens the sender's GPU memory", eg: 'edges 4, 5, 7, 8' },
          { k: 3, where: 'a CPU end, one machine', how: 'shared memory', what: 'CPU memory that both processes map', eg: 'edges 1, 2, 3, 6' },
          { k: 4, where: 'on two machines', how: 'Mooncake', what: 'network cards copy machine to machine', eg: 'none by default' },
        ]}
        {@const ry = (i: number) => 76 + i * 62}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">four paths for the data · picked per edge from where its two stages sit</text>
          <g in:fade={{ delay: 100, duration: 250 }}>
            {#each ['where the two stages sit', 'the data goes by', 'what happens', 'in Qwen3-Omni'] as h, i}
              <text x={[16, 216, 330, 600][i]} y="66" class="tag strong">{h}</text>
            {/each}
          </g>
          {#each rows as r, i}
            {@const y = ry(i)}
            <g in:fade={{ delay: 300 + i * 300, duration: 250 }}>
              <rect x="16" y={y} width="688" height="52" rx="8" fill="#fbfaf7" stroke="var(--line)" />
              <text x="28" y={y + 19} class="boxtitle">{r.k} of 4</text>
              <!-- a small picture of the arrangement -->
              {#if r.k === 1}
                <rect x="28" y={y + 26} width="150" height="20" rx="5" fill="none" stroke="var(--faint)" stroke-dasharray="3 2" />
                <rect x="36" y={y + 30} width="58" height="12" rx="3" fill="var(--accent-soft)" stroke="var(--accent)" />
                <rect x="112" y={y + 30} width="58" height="12" rx="3" fill="var(--accent-soft)" stroke="var(--accent)" />
              {:else if r.k === 2}
                {#each [0, 1] as j}
                  <rect x={28 + j * 80} y={y + 26} width="70" height="20" rx="5" fill="none" stroke="var(--faint)" stroke-dasharray="3 2" />
                  <rect x={34 + j * 80} y={y + 30} width="58" height="12" rx="3" fill="var(--accent-soft)" stroke="var(--accent)" />
                  <text x={63 + j * 80} y={y + 39.5} text-anchor="middle" class="tag" style="font-size: 8px;">GPU</text>
                {/each}
              {:else if r.k === 3}
                <rect x="28" y={y + 26} width="70" height="20" rx="5" fill="none" stroke="var(--faint)" stroke-dasharray="3 2" />
                <rect x="34" y={y + 30} width="58" height="12" rx="3" fill={NOMODEL} stroke="var(--faint)" />
                <text x="63" y={y + 39.5} text-anchor="middle" class="tag" style="font-size: 8px;">CPU</text>
                <rect x="108" y={y + 26} width="70" height="20" rx="5" fill="none" stroke="var(--faint)" stroke-dasharray="3 2" />
                <rect x="114" y={y + 30} width="58" height="12" rx="3" fill="var(--accent-soft)" stroke="var(--accent)" />
              {:else}
                {#each [0, 1] as j}
                  <rect x={28 + j * 80} y={y + 24} width="70" height="24" rx="5" fill="none" stroke="var(--fg)" />
                  <rect x={34 + j * 80} y={y + 30} width="58" height="12" rx="3" fill="var(--accent-soft)" stroke="var(--accent)" />
                {/each}
              {/if}
              <text x="216" y={y + 31} class="tag strong" style:fill={r.k === 2 ? IPC : r.k === 3 ? SHM : 'var(--fg)'}>{r.how}</text>
              <text x="330" y={y + 31} class="tag">{r.what}</text>
              <text x="600" y={y + 31} class="tag">{r.eg}</text>
            </g>
          {/each}
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">dashed: a process · solid: a machine · the edges are Ch. {CH_STAGES} Step 12's · SGLang-Omni's CommRouter makes the choice</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">the tools are general: SGLang also moves KV cache between servers with Mooncake (chapter {CH_DISAGG})</text>
        </g>
      {/if}

      <!-- 5: 1 of 4, one process · the receiver gets the object itself -->
      {#if cur.scene === 'local'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">1 of 4 · two stages in one process · the object itself is handed over</text>
          <g in:fade={{ delay: 100, duration: 250 }}>
            <rect x="60" y="64" width="600" height="190" rx="12" fill="none" stroke="var(--faint)" stroke-dasharray="5 4" />
            <text x="72" y="80" class="tag">one process: one Python interpreter, one memory (Ch. {CH_STAGES} Step 3)</text>
            {#each [{ x: 90, n: 'stage A', r: 'sender' }, { x: 470, n: 'stage B', r: 'receiver' }] as st}
              <rect x={st.x} y="100" width="160" height="40" rx="8" fill="var(--accent-soft)" stroke="var(--accent)" />
              <text x={st.x + 80} y="118" text-anchor="middle" class="tag strong">{st.n}</text>
              <text x={st.x + 80} y="131" text-anchor="middle" class="tag">{st.r}</text>
            {/each}
            <path d="M 256 120 H 464" fill="none" stroke="var(--fg)" stroke-width="1.4" marker-end="url(#bs-arrow-fg)" />
            <text x="360" y="112" text-anchor="middle" class="tag strong">a direct call, with a reference</text>
          </g>
          <g in:fade={{ delay: 500, duration: 250 }}>
            <rect x="290" y="186" width="140" height="44" rx="8" fill="var(--gen-soft)" stroke="var(--gen)" />
            <text x="360" y="205" text-anchor="middle" class="tag strong">the payload</text>
            <text x="360" y="219" text-anchor="middle" class="tag">one copy in memory</text>
            <path d="M 170 144 C 170 190, 220 208, 284 208" fill="none" stroke="var(--gen)" stroke-width="1.4" marker-end="url(#bs-arrow-shm)" />
            <path d="M 550 144 C 550 190, 500 208, 436 208" fill="none" stroke="var(--gen)" stroke-width="1.4" marker-end="url(#bs-arrow-shm)" />
            <text x="160" y="196" text-anchor="end" class="tag">A still holds it</text>
            <text x="560" y="196" class="tag">B now holds it too</text>
          </g>
          <g in:fade={{ delay: 900 }}>
            <text x="18" y="290" class="pt">·</text><text x="28" y="290" class="legend">no copy, no notice over ZMQ, no ack: the call itself is the hand-off</text>
            <text x="18" y="307" class="pt">·</text><text x="28" y="307" class="legend">the catch: both stages hold one object, so the receiver must treat it as read-only</text>
            <text x="18" y="324" class="pt">·</text><text x="28" y="324" class="legend">Qwen3-Omni's text-only pipeline runs all its stages in one process; passing references cut its mean latency by 33%</text>
          </g>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">the 33%: SGLang-Omni's design notes (PR #496) · SGLang-Omni's name for this path: LOCAL_OBJECT</text>
        </g>
      {/if}

      <!-- 6: 2 of 4, CUDA IPC · a handle to GPU memory travels with the notice; the data is read across the GPU link -->
      {#if cur.scene === 'cudaipc'}
        {@const G0 = 30}
        {@const G1 = 450}
        {@const GW = 240}
        {@const SLOT = G0 + 12 + 2 * 36}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">2 of 4 · data on a GPU, both stages on GPUs · edge 7, GPU 0 to GPU 1</text>
          {#each [{ x: G0, n: 'GPU 0 · the thinker' }, { x: G1, n: 'GPU 1 · talker_ar' }] as g}
            <rect x={g.x} y="64" width={GW} height="122" rx="12" fill="#fbfaf7" stroke="var(--fg)" />
            <text x={g.x + 12} y="81" class="boxtitle">{g.n}</text>
          {/each}
          <g in:fade={{ delay: 100, duration: 250 }}>
            <text x={G0 + 12} y="102" class="tag strong">a pool of slots, set aside at start</text>
            {#each Array(6) as _, j}
              <rect x={G0 + 12 + j * 36} y="110" width="32" height="26" rx="4" fill={j === 2 ? 'var(--gen)' : 'white'} opacity={j === 2 ? 0.8 : 1} stroke={j === 2 ? 'var(--gen)' : 'var(--faint)'} />
            {/each}
            <text x={SLOT + 16} y="154" text-anchor="middle" class="tag strong">① the vector, in slot 2</text>
          </g>
          <g in:fade={{ delay: 500, duration: 250 }}>
            <path d="M {G0 + GW + 6} 104 H {G1 - 6}" fill="none" stroke="var(--fg)" stroke-width="1.4" marker-end="url(#bs-arrow-fg)" />
            <rect x="296" y="89" width="128" height="30" rx="6" fill="white" stroke="var(--fg)" />
            <text x="360" y="102" text-anchor="middle" class="tag strong">② a handle</text>
            <text x="360" y="114" text-anchor="middle" class="tag">GPU 0, slot 2</text>
            <text x="360" y="136" text-anchor="middle" class="tag">in the notice, over ZMQ</text>
          </g>
          <g in:fade={{ delay: 900, duration: 250 }}>
            <path d="M {SLOT + 16} 160 V 172 C {SLOT + 16} 200, 300 204, 360 204 C 420 204, {G1 + 50} 200, {G1 + 50} 160 L {G1 + 50} 146" fill="none" stroke="var(--accent)" stroke-width="2" marker-end="url(#bs-arrow-ipc)" />
            <text x="360" y="222" text-anchor="middle" class="tag strong" style:fill={IPC}>③ talker_ar reads it over the link between the GPUs</text>
            <rect x={G1 + 30} y="114" width="40" height="26" rx="4" fill="var(--gen)" opacity="0.8" />
            <text x={G1 + 78} y="131" class="tag">the vector, on GPU 1</text>
          </g>
          <g in:fade={{ delay: 1300, duration: 250 }}>
            <path d="M {G1 - 6} 248 H {G0 + GW + 6}" fill="none" stroke="var(--fg)" stroke-width="1.2" stroke-dasharray="3 3" marker-end="url(#bs-arrow-fg)" />
            <text x="360" y="242" text-anchor="middle" class="tag strong">④ the ack, so slot 2 can take the next vector</text>
          </g>
          <g in:fade={{ delay: 1700 }}>
            <text x="18" y="286" class="pt">·</text><text x="28" y="286" class="legend">the data never leaves GPU memory; on one GPU, the receiver reads the same slot in place</text>
            <text x="18" y="303" class="pt">·</text><text x="28" y="303" class="legend">a fixed pool means a fast sender waits for acks instead of filling the GPU's memory</text>
            <text x="18" y="320" class="pt">·</text><text x="28" y="320" class="legend">if the two GPUs cannot read each other's memory, the edge falls back to shared memory (3 of 4)</text>
          </g>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">CUDA IPC: NVIDIA's way for one process to open another's GPU memory · the link: NVLink, or PCIe without it</text>
        </g>
      {/if}

      <!-- 7: 3 of 4, shared memory · written once into CPU memory both processes map -->
      {#if cur.scene === 'shm'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">3 of 4 · data in CPU memory, or a stage on the CPU · edge 1, preprocessing to image_encoder</text>
          <g in:fade={{ delay: 100, duration: 250 }}>
            <rect x="30" y="66" width="200" height="66" rx="10" fill="none" stroke="var(--faint)" stroke-dasharray="5 4" />
            <text x="40" y="81" class="tag">process</text>
            <rect x="44" y="88" width="172" height="34" rx="7" fill={NOMODEL} stroke="var(--faint)" />
            <text x="130" y="109" text-anchor="middle" class="mono strong">preprocessing · CPU</text>
            <rect x="490" y="66" width="200" height="66" rx="10" fill="none" stroke="var(--faint)" stroke-dasharray="5 4" />
            <text x="500" y="81" class="tag">process</text>
            <rect x="504" y="88" width="172" height="34" rx="7" fill="white" stroke="var(--fg)" />
            <text x="590" y="109" text-anchor="middle" class="mono strong">image_encoder · GPU 0</text>
          </g>
          <g in:fade={{ delay: 500, duration: 250 }}>
            <rect x="210" y="176" width="300" height="46" rx="8" fill="var(--gen-soft)" stroke="var(--gen)" />
            <text x="360" y="196" text-anchor="middle" class="tag strong">shared memory</text>
            <text x="360" y="210" text-anchor="middle" class="tag">CPU memory both processes map</text>
            <path d="M 130 128 C 130 170, 160 199, 204 199" fill="none" stroke="var(--gen)" stroke-width="1.6" marker-end="url(#bs-arrow-shm)" />
            <text x="122" y="172" text-anchor="end" class="tag strong">① written once</text>
            <path d="M 516 199 C 560 199, 590 170, 590 136" fill="none" stroke="var(--gen)" stroke-width="1.6" marker-end="url(#bs-arrow-shm)" />
            <text x="604" y="168" class="tag strong">③ read in place</text>
            <path d="M 236 99 H 484" fill="none" stroke="var(--fg)" stroke-width="1.2" marker-end="url(#bs-arrow-fg)" />
            <text x="360" y="92" text-anchor="middle" class="tag strong">② the notice, over ZMQ</text>
            <text x="604" y="184" class="tag">then copied to GPU 0</text>
          </g>
          <g in:fade={{ delay: 1000 }}>
            <text x="18" y="290" class="pt">·</text><text x="28" y="290" class="legend">used where the data starts in CPU memory: edges 1, 2 and 3 from preprocessing, and edge 6, token ids for decode</text>
            <text x="18" y="307" class="pt">·</text><text x="28" y="307" class="legend">one write, and the receiver reads it in place, against four trips through ZMQ (step 3)</text>
          </g>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">SGLang-Omni's name for this path: SHM · it also catches GPU edges that cannot use CUDA IPC</text>
        </g>
      {/if}

      <!-- 8: 4 of 4, another machine · Mooncake copies between the two machines' memory over the network -->
      {#if cur.scene === 'remote'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">4 of 4 · the receiver on another machine · not used by the default layout</text>
          {#each [{ x: 30, n: 'machine 1', s: 'a stage', mem: 46, nic: 176 }, { x: 430, n: 'machine 2', s: 'the next stage', mem: 554, nic: 446 }] as m, i}
            <g in:fade={{ delay: 100 + i * 300, duration: 250 }}>
              <rect x={m.x} y="64" width="260" height="150" rx="12" fill="#fbfaf7" stroke="var(--fg)" />
              <text x={m.x + 12} y="81" class="boxtitle">{m.n}</text>
              <rect x={m.mem} y="96" width="120" height="34" rx="7" fill="var(--accent-soft)" stroke="var(--accent)" />
              <text x={m.mem + 60} y="117" text-anchor="middle" class="tag strong">{m.s}</text>
              <rect x={m.mem} y="160" width="120" height="34" rx="7" fill="var(--gen-soft)" stroke="var(--gen)" />
              <text x={m.mem + 60} y="181" text-anchor="middle" class="tag strong">its memory</text>
              <rect x={m.nic} y="160" width="98" height="34" rx="7" fill="white" stroke="var(--fg)" />
              <text x={m.nic + 49} y="181" text-anchor="middle" class="tag strong">network card</text>
            </g>
          {/each}
          <g in:fade={{ delay: 800, duration: 250 }}>
            <path d="M 166 177 H 170" fill="none" stroke="var(--gen)" stroke-width="2" marker-end="url(#bs-arrow-shm)" />
            <path d="M 280 177 H 440" fill="none" stroke="var(--gen)" stroke-width="2" marker-end="url(#bs-arrow-shm)" />
            <text x="360" y="170" text-anchor="middle" class="tag strong">the network (RDMA)</text>
            <path d="M 550 177 H 548" fill="none" stroke="var(--gen)" stroke-width="2" marker-end="url(#bs-arrow-shm)" />
          </g>
          <g in:fade={{ delay: 1200 }}>
            <text x="18" y="262" class="pt">·</text><text x="28" y="262" class="legend">the network cards read one machine's memory and write the other's, with no copy through either CPU</text>
            <text x="18" y="279" class="pt">·</text><text x="28" y="279" class="legend">the notice still goes over ZMQ, now between machines</text>
          </g>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">RDMA: remote direct memory access · Mooncake: the transfer engine SGLang-Omni uses for it</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">setups across machines are left to the multi-GPU part; SGLang uses Mooncake for KV cache in chapter {CH_DISAGG}</text>
        </g>
      {/if}

      <!-- 9: Qwen3-Omni's default layout, each edge coloured by its path -->
      {#if cur.scene === 'layout'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">Ch. {CH_STAGES} Step 12's graph, each edge coloured by its path in the default layout</text>
          <g in:fade={{ delay: 100, duration: 250 }}>
            {@render graph((t) => (t === 'ipc' ? IPC : SHM), (t) => (t === 'ipc' ? 'bs-arrow-ipc' : 'bs-arrow-shm'))}
          </g>
          <g in:fade={{ delay: 600, duration: 250 }}>
            <rect x="16" y="214" width="16" height="10" rx="2" fill={IPC} />
            <text x="40" y="223" class="tag"><tspan class="strong">CUDA IPC (2 of 4)</tspan> · edges 4, 5, 7, 8: GPU data between GPU stages, on one GPU (4, 5) or two (7, 8)</text>
            <rect x="16" y="234" width="16" height="10" rx="2" fill={SHM} />
            <text x="40" y="243" class="tag"><tspan class="strong">shared memory (3 of 4)</tspan> · edges 1, 2, 3, 6: a CPU stage at one end</text>
            <text x="40" y="263" class="tag"><tspan class="strong">a reference (1 of 4)</tspan> · none: every stage has its own process (Ch. {CH_STAGES} Step 4)</text>
            <text x="40" y="279" class="tag"><tspan class="strong">Mooncake (4 of 4)</tspan> · none: both GPUs are in one machine</text>
          </g>
          <text x={W / 2} y="326" text-anchor="middle" class="legend" in:fade={{ delay: 1100 }}>the edges that run every token, 6 and 7, never send their data through ZMQ</text>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">edges 9–11 follow the same rules: 9 from preprocessing by shared memory, 10 and 11 from the encoders by CUDA IPC</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">by SGLang-Omni's CommRouter rules, assuming each tensor stays on the device that made it; not traced on a server</text>
        </g>
      {/if}

      <!-- 10: the coordinator · in front of the graph: submits, merges two outputs, broadcasts aborts -->
      {#if cur.scene === 'coordinator'}
        {@const SY = 196}
        {@const stages = [['preprocessing', 16], ['image_encoder', 116], ['audio_encoder', 216], ['thinker', 316], ['decode', 416], ['talker_ar', 516], ['code2wav', 616]] as [string, number][]}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">the coordinator · one process in front of the seven stages</text>
          <g in:fade={{ delay: 100, duration: 250 }}>
            <rect x="16" y="64" width="120" height="40" rx="8" fill="white" stroke="var(--fg)" />
            <text x="76" y="82" text-anchor="middle" class="tag strong">the client</text>
            <text x="76" y="95" text-anchor="middle" class="tag">HTTP (Ch. {CH_PROC} Step 2)</text>
            <rect x="240" y="64" width="240" height="40" rx="8" fill="var(--accent-soft)" stroke="var(--accent)" />
            <text x="360" y="82" text-anchor="middle" class="tag strong">coordinator</text>
            <text x="360" y="95" text-anchor="middle" class="tag">a process of its own</text>
            <path d="M 142 78 H 234" fill="none" stroke="#b8b4aa" stroke-width="1.4" marker-end="url(#bs-arrow)" />
            <path d="M 234 92 H 142" fill="none" stroke="#b8b4aa" stroke-width="1.4" marker-end="url(#bs-arrow)" />
            {#each stages as [n, x]}
              <rect {x} y={SY} width="92" height="30" rx="6" fill={n === 'thinker' || n === 'talker_ar' ? 'var(--accent-soft)' : n === 'preprocessing' || n === 'decode' ? NOMODEL : 'white'} stroke={n === 'thinker' || n === 'talker_ar' ? 'var(--accent)' : 'var(--faint)'} />
              <text x={x + 46} y={SY + 19} text-anchor="middle" class="mono strong" style="font-size: 9.5px;">{n}</text>
            {/each}
          </g>
          <g in:fade={{ delay: 500, duration: 250 }}>
            <path d="M 262 110 V 150 H 62 V {SY - 6}" fill="none" stroke="var(--fg)" stroke-width="1.4" marker-end="url(#bs-arrow-fg)" />
            <text x="76" y="143" class="tag strong">① submit, to the first stage</text>
          </g>
          <g in:fade={{ delay: 900, duration: 250 }}>
            <path d="M 462 {SY - 4} V 110" fill="none" stroke="var(--gen)" stroke-width="1.4" marker-end="url(#bs-arrow-shm)" />
            <path d="M 662 {SY - 4} V 84 H 486" fill="none" stroke="var(--gen)" stroke-width="1.4" marker-end="url(#bs-arrow-shm)" />
            <text x="496" y="124" class="tag strong">② text from decode,</text>
            <text x="496" y="137" class="tag strong">sound from code2wav,</text>
            <text x="496" y="150" class="tag">merged into one response</text>
          </g>
          <g in:fade={{ delay: 1300, duration: 250 }}>
            <path d="M 412 110 V 250" fill="none" stroke={RED} stroke-width="1.2" stroke-dasharray="4 3" />
            <path d="M 62 250 H 662" fill="none" stroke={RED} stroke-width="1.2" stroke-dasharray="4 3" />
            {#each stages as [, x]}
              <path d="M {x + 46} 250 V {SY + 36}" fill="none" stroke={RED} stroke-width="1.2" marker-end="url(#bs-arrow-red)" />
            {/each}
            <text x={W / 2} y="268" text-anchor="middle" class="tag strong" style:fill={RED}>③ abort: one message, and every stage hears it</text>
          </g>
          <g in:fade={{ delay: 1700 }}>
            <text x="18" y="304" class="pt">·</text><text x="28" y="304" class="legend">the coordinator handles requests, not their data; the stages pass the data among themselves</text>
            <text x="18" y="321" class="pt">·</text><text x="28" y="321" class="legend">each stage drops the aborted request, wherever it is in that stage's loop</text>
          </g>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">the abort uses ZMQ publish/subscribe, where one sender reaches every subscriber</text>
        </g>
      {/if}

      <!-- 11: the closing question · the layout decides the paths; who decides the layout, and how a shared GPU's memory is split -->
      {#if cur.scene === 'closing'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">the paths follow the layout · the layout from Ch. {CH_STAGES} Step 4</text>
          {#each [{ x: 30, n: 'GPU 0', st: ['image_encoder', 'audio_encoder', 'thinker', 'code2wav'] }, { x: 390, n: 'GPU 1', st: ['talker_ar'] }] as g, i}
            <g in:fade={{ delay: 100 + i * 300, duration: 250 }}>
              <rect x={g.x} y="64" width="300" height="186" rx="12" fill="#fbfaf7" stroke="var(--fg)" />
              <text x={g.x + 12} y="81" class="boxtitle">{g.n}</text>
              {#each g.st as n, j}
                <rect x={g.x + 14} y={92 + j * 30} width="130" height="24" rx="6" fill={n === 'thinker' || n === 'talker_ar' ? 'var(--accent-soft)' : 'white'} stroke={n === 'thinker' || n === 'talker_ar' ? 'var(--accent)' : 'var(--fg)'} />
                <text x={g.x + 79} y={108 + j * 30} text-anchor="middle" class="mono strong">{n}</text>
              {/each}
              <!-- the memory: whose share is how big? -->
              <text x={g.x + 160} y="102" class="tag strong">memory</text>
              <rect x={g.x + 160} y="110" width="126" height="122" rx="6" fill="white" stroke="var(--faint)" />
              {#each g.st as _, j}
                <rect x={g.x + 166} y={116 + j * (110 / g.st.length)} width="114" height={110 / g.st.length - 4} rx="3" fill="none" stroke={RED} stroke-dasharray="3 2" />
                <text x={g.x + 223} y={116 + j * (110 / g.st.length) + (110 / g.st.length) / 2 + 2} text-anchor="middle" class="tag strong" style:fill={RED}>?</text>
              {/each}
            </g>
          {/each}
          <g in:fade={{ delay: 800 }}>
            <text x="18" y="282" class="pt">·</text><text x="28" y="282" class="legend">four stages share GPU 0, each needing weights and working memory, the thinker also a KV cache</text>
            <text x="18" y="299" class="pt">·</text><text x="28" y="299" class="legend">talker_ar has GPU 1 to itself, and leaves it under 2% busy (Ch. {CH_OMNI} Step 6)</text>
            <text x="18" y="316" class="pt">·</text><text x="28" y="316" class="legend">moving a stage changes which path its edges take (step 4)</text>
          </g>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">who decides the layout, and how one GPU's memory is split between its stages: chapter {CH_GPUS}</text>
        </g>
      {/if}
      {#if cur.scene === 'handoff'}<LoopProgress ms={lapMs} {lap} />{/if}
    </svg>
  </div>

  <StepControls {step} total={steps.length} caption={cur.caption} {prev} {next} onchange={(s) => (step = s)} />
</figure>
