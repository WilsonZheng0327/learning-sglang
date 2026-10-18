<script lang="ts">
  import { untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import StepControls from '../StepControls.svelte';
  import LoopProgress from '../LoopProgress.svelte';
  import { chapterNumber as chNum, type NavLink } from '../../chapters';
  import { SPEECH_OUT_HZ, CODES_PER_FRAME, SAMPLES_PER_FRAME } from '../../numbers';
  let { prev, next }: { prev?: NavLink; next?: NavLink } = $props();

  const CH_ENGINE = chNum('10-engine'), CH_PROC = chNum('09-one-request'), CH_OMNI = chNum('16-omni-models'), CH_EDGES = chNum('18-between-stages');
  const CH_PLACE = chNum('19-sharing-gpus'), CH_TP = chNum('24-tensor-parallel');
  // chapter 16's 20 s spoken answer, in frames
  const A_SEC = 20;
  const FRAMES = (A_SEC * SPEECH_OUT_HZ) / SAMPLES_PER_FRAME;   // 250
  const FRAME_MS = (SAMPLES_PER_FRAME / SPEECH_OUT_HZ) * 1000;  // 80
  const CHUNK = 10, CONTEXT = 25;                                // code2wav's frames per pass, and earlier frames it rereads (SGLang-Omni's defaults)

  type Scene = 'gap' | 'stage' | 'process' | 'stages' | 'predictor' | 'handoffs' | 'kinds' | 'onepass' | 'loop' | 'talker' | 'streaming' | 'closing';
  const steps: { scene: Scene; caption: string }[] = [
    { scene: 'gap', caption: `Today, SGLang runs one model in one process: the scheduler, which also runs the encoders inside its prefill. The talker, code predictor and code2wav have no process to run in.` },
    { scene: 'stage', caption: `A stage is the home SGLang-Omni gives each piece of work: a runtime that trades with other stages, and a scheduler thread that runs the work, joined by an inbox and an outbox.` },
    { scene: 'process', caption: `A stage is not a process. By default each stage gets its own, as Ch. ${CH_PROC} Step 5's three did; but several can share one, and one can span several. Only the hand-off changes.` },
    { scene: 'stages', caption: `SGLang-Omni runs Qwen3-Omni as seven stages, each in its own process: one per model, except that the talker and code predictor share one, plus preprocessing and the detokenizer.` },
    { scene: 'predictor', caption: `Each talker step, the code predictor takes the talker's hidden state and code 0 and writes codes 1–15. The finished frame becomes the talker's next input, so what the code predictor reads and writes both belong to the talker.` },
    { scene: 'handoffs', caption: `As a separate stage, every frame would go to the code predictor and back, which is ${FRAMES * 2} hand-offs for the ${A_SEC} s answer. The talker waits through each one. Inside the talker's step there are none.` },
    { scene: 'kinds', caption: `Why not one scheduler for all seven stages? Because stages keep different things between calls. Some keep nothing, some keep a KV cache that grows every step, and some keep the pieces of a request still arriving.` },
    { scene: 'onepass', caption: `One pass needs only part of SGLang's loop. No request is ever halfway through an answer, so there are no lists, no pages and no token to pick. The scheduler takes what is waiting, runs it once and sends each result on.` },
    { scene: 'loop', caption: `The thinker and the talker loop like the engine in Ch. ${CH_ENGINE} Step 1, so SGLang-Omni keeps the middle of its scheduler unchanged. Requests now arrive in the stage's inbox, and each token is sent on as soon as it is picked.` },
    { scene: 'talker', caption: `The talker's scheduler adds one row to step 9's loop. Before each decode step, it checks that every request in the batch has its next token. If one is missing, the whole batch waits.` },
    { scene: 'streaming', caption: `decode and code2wav get each request in pieces from a stage that is still running. Each keeps what has arrived until a whole character or ${CHUNK} new frames are ready to go out.` },
    { scene: 'closing', caption: `Eight edges join the seven stages. Some carry a request's inputs once and some a piece every token, between processes that may share a GPU, sit on two, or have the CPU at one end. How is each hand-off made?` },
  ];

  let step = $state(0);
  $effect(() => {
    const q = Number(new URLSearchParams(window.location.search).get('step'));
    if (q >= 1 && q <= steps.length) step = q - 1;
  });
  const cur = $derived(steps[step]);
  // step 2's loop: one request walks through a stage and into the next; each scheduler holds it while it works on it
  const HOPS = 10;
  const WORK = [3, 8];                               // the hops spent inside a scheduler
  const GLIDE = 850;                                 // ms the request takes to move between spots (the CSS transition below)
  let lap = $state(0), lapMs = $state(0);           // the looping step's laps, for LoopProgress
  const nextLap = (ms: number) => untrack(() => { lapMs = ms; lap++; });   // untracked, so starting a lap does not re-run the effect
  let hop = $state(0);
  let working = $state(false);                       // on only once the request has arrived inside a scheduler
  $effect(() => {
    if (cur.scene !== 'stage') return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const run = () => {
      hop = 0; working = false;
      let t = 600;
      for (let i = 1; i < HOPS; i++) {
        t += WORK.includes(i - 1) ? 3000 : 1150;
        const h = i;
        timers.push(setTimeout(() => { hop = h; working = false; }, t));
        if (WORK.includes(h)) timers.push(setTimeout(() => (working = true), t + GLIDE));
      }
      timers.push(setTimeout(run, t + 2400));
      nextLap(t + 2400);
    };
    run();
    return () => timers.forEach(clearTimeout);
  });
  // step 10's loop: step 9's rows, the new row slides in, the batch is held twice, C's token arrives, the batch runs
  let tp = $state(0);
  $effect(() => {
    if (cur.scene !== 'talker') return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const run = () => {
      tp = 0;
      [1000, 2800, 4800, 7000, 9200, 10600].forEach((t, i) => timers.push(setTimeout(() => (tp = i + 1), t)));
      timers.push(setTimeout(run, 14600));
      nextLap(14600);
    };
    run();
    return () => timers.forEach(clearTimeout);
  });
  const W = 720, H = 400;
  const RED = 'var(--eos)';

  // chapter 16's six models, in its map's two kinds: one pass (white) and a loop (blue)
  const MODELS = [
    { n: 'vision encoder', loop: false, home: true },
    { n: 'audio encoder', loop: false, home: true },
    { n: 'the engine', loop: true, home: true },
    { n: 'talker', loop: true, home: false },
    { n: 'code predictor', loop: true, home: false },
    { n: 'code2wav', loop: false, home: false },
  ];
</script>

<figure class="viz">
  <div class="canvas">
    <svg viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Stages and schedulers, step {step + 1}">
      <defs>
        <marker id="ss-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#b8b4aa" />
        </marker>
        <marker id="ss-arrow-red" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--eos)" />
        </marker>
        <marker id="ss-arrow-gen" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--gen)" />
        </marker>
        <marker id="ss-arrow-accent" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
        </marker>
      </defs>

      <!-- 1: SGLang's three processes from chapter 9, and chapter 16's six models: three have a home, three have none -->
      {#if cur.scene === 'gap'}
        {@const PW = 160}
        {@const PX = [30, 280, 530]}
        {@const PY = 76}
        {@const MW = 100}
        {@const mx = (i: number) => 20 + i * 116}
        {@const MY = 214}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">where do Ch. {CH_OMNI} Step 4's models run? · SGLang has one process with a model in it</text>

          <!-- SGLang today: three processes, one model -->
          <g in:fade={{ delay: 100, duration: 250 }}>
            <text x="16" y="66" class="boxtitle">SGLang today · Ch. {CH_PROC} Step 5</text>
            {#each [{ n: 'server + tokenizer', t: 'CPU · no model' }, { n: 'scheduler + model', t: 'GPU · one loop' }, { n: 'detokenizer', t: 'CPU · no model' }] as p, i}
              <rect x={PX[i]} y={PY} width={PW} height="44" rx="8" fill={i === 1 ? 'var(--accent-soft)' : 'white'} stroke={i === 1 ? 'var(--accent)' : 'var(--fg)'} />
              <text x={PX[i] + PW / 2} y={PY + 19} text-anchor="middle" class="tag strong">{p.n}</text>
              <text x={PX[i] + PW / 2} y={PY + 33} text-anchor="middle" class="tag">{p.t}</text>
            {/each}
            {#each [0, 1] as i}
              <path d="M {PX[i] + PW + 4} {PY + 22} H {PX[i + 1] - 4}" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#ss-arrow)" />
              <text x={(PX[i] + PW + PX[i + 1]) / 2} y={PY + 15} text-anchor="middle" class="tag">queue</text>
            {/each}
          </g>

          <!-- chapter 16's models: the encoders and the engine run in the scheduler process; the speech models have no process -->
          <g in:fade={{ delay: 500, duration: 250 }}>
            <text x="704" y={MY - 14} text-anchor="end" class="boxtitle">Qwen3-Omni's six models · Ch. {CH_OMNI} Step 4</text>
            {#each MODELS as m, i}
              <rect x={mx(i)} y={MY} width={MW} height="36" rx="8" fill={m.loop ? 'var(--accent-soft)' : 'white'} stroke={m.home ? (m.loop ? 'var(--accent)' : 'var(--fg)') : RED} stroke-dasharray={m.home ? 'none' : '4 3'} />
              <text x={mx(i) + MW / 2} y={MY + 22} text-anchor="middle" class="tag strong">{m.n}</text>
            {/each}
          </g>
          <g in:fade={{ delay: 900, duration: 250 }}>
            {#each [0, 1, 2] as i}
              <path d="M {mx(i) + MW / 2} {MY - 4} C {mx(i) + MW / 2} {MY - 40}, {PX[1] + 50 + i * 30} {PY + 90}, {PX[1] + 50 + i * 30} {PY + 60} L {PX[1] + 50 + i * 30} {PY + 48}" fill="none" stroke="var(--accent)" stroke-width="1.2" marker-end="url(#ss-arrow-accent)" />
            {/each}
            <text x={mx(0)} y={MY + 56} class="tag">run inside the scheduler process:</text>
            <text x={mx(0)} y={MY + 70} class="tag">the encoders in its prefill (Ch. {CH_OMNI} Step 2)</text>
            <path d="M {mx(3)} {MY + 44} v 6 H {mx(5) + MW} v -6" fill="none" stroke={RED} />
            <text x={(mx(3) + mx(5) + MW) / 2} y={MY + 66} text-anchor="middle" class="tag strong" style:fill={RED}>no process runs these</text>
          </g>

          <g in:fade={{ delay: 1300, duration: 250 }}>
            <rect x="30" y="321" width="660" height="28" rx="14" fill="var(--accent-soft)" stroke="var(--accent)" />
            <text x={W / 2} y="340" text-anchor="middle" class="need"><tspan class="strong">needed:</tspan> somewhere for every model to run, each in the right kind of loop, joined by queues</text>
          </g>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">white: one pass · blue: a loop (Ch. {CH_OMNI} Step 4) · a red dashed outline: no process runs it in SGLang</text>
        </g>
      {/if}
      <!-- 2: what a stage is · a runtime and a scheduler thread, joined by an inbox and an outbox; one request walks through two -->
      {#if cur.scene === 'stage'}
        {@const SX = [40, 420]}
        {@const SW = 260}
        {@const IN = 70}
        {@const OUT = 190}
        {@const at = [
          [16, 128], [SX[0] + IN, 128], [SX[0] + IN, 177], [SX[0] + 100, 236], [SX[0] + OUT, 177], [SX[0] + OUT, 128],
          [SX[1] + IN, 128], [SX[1] + IN, 177], [SX[1] + 100, 236], [SX[1] + 100, 236],
        ]}
        {@const done = hop > 8 ? 2 : hop > 3 ? 1 : 0}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">what a stage is · a runtime that trades with other stages, a scheduler that does the work</text>
          {#each SX as x, k}
            <g in:fade={{ delay: 100 + k * 300, duration: 250 }}>
              <rect {x} y="58" width={SW} height="256" rx="12" fill="#fbfaf7" stroke="var(--fg)" />
              <text x={x + 12} y="75" class="boxtitle">{k ? 'the next stage' : 'a stage'}</text>
              <!-- the runtime: the stage's I/O -->
              <rect x={x + 14} y="82" width={SW - 28} height="60" rx="8" fill="white" stroke="var(--faint)" />
              <text x={x + SW / 2} y="98" text-anchor="middle" class="tag strong">runtime</text>
              <text x={x + SW / 2} y="111" text-anchor="middle" class="tag">receives from stages, sends to stages</text>
              <!-- the two queues between them -->
              {#each [{ qx: x + IN, n: 'inbox', down: true }, { qx: x + OUT, n: 'outbox', down: false }] as q}
                {#each [0, 1, 2] as j}
                  <rect x={q.qx - 14} y={160 + j * 12} width="28" height="10" rx="2" fill="white" stroke="var(--faint)" />
                {/each}
                <text x={q.down ? q.qx - 22 : q.qx + 22} y="181" text-anchor={q.down ? 'end' : 'start'} class="tag strong">{q.n}</text>
                <path d={q.down ? `M ${q.qx} 146 V 156` : `M ${q.qx} 156 V 146`} fill="none" stroke="#b8b4aa" stroke-width="1.4" marker-end="url(#ss-arrow)" />
                <path d={q.down ? `M ${q.qx} 198 V 212` : `M ${q.qx} 212 V 198`} fill="none" stroke="#b8b4aa" stroke-width="1.4" marker-end="url(#ss-arrow)" />
              {/each}
              <!-- the scheduler: its own thread, its own loop -->
              <rect x={x + 14} y="216" width={SW - 28} height="86" rx="8" fill={working && hop === WORK[k] ? 'var(--accent-soft)' : 'white'} stroke="var(--accent)" stroke-width={working && hop === WORK[k] ? 2 : 1} />
              <text x={x + SW / 2} y="268" text-anchor="middle" class="tag strong">scheduler · a thread of its own</text>
              <text x={x + SW / 2} y="282" text-anchor="middle" class="tag">its loop: take from the inbox,</text>
              <text x={x + SW / 2} y="295" text-anchor="middle" class="tag">run the work, put into the outbox</text>
            </g>
          {/each}
          <g in:fade={{ delay: 600, duration: 250 }}>
            <path d="M 18 128 H {SX[0] + 10}" fill="none" stroke="#b8b4aa" stroke-width="1.4" marker-end="url(#ss-arrow)" />
            <path d="M {SX[0] + SW + 4} 128 H {SX[1] - 4}" fill="none" stroke="#b8b4aa" stroke-width="1.4" marker-end="url(#ss-arrow)" />
            <text x={(SX[0] + SW + SX[1]) / 2} y="120" text-anchor="middle" class="tag">to the next stage</text>
            <text x={(SX[0] + SW + SX[1]) / 2} y="144" text-anchor="middle" class="tag">how: Ch. {CH_EDGES} Step 2</text>
          </g>
          <!-- the request, hop by hop -->
          <!-- the request: each scheduler works on it (a bar fills) and hands on something new (a new colour, a new mark) -->
          <g style="transform: translate({at[hop][0]}px, {at[hop][1]}px); transition: transform {GLIDE}ms ease-in-out;">
            <rect x="-17" y="-8" width="34" height="16" rx="8" fill={['var(--gen)', 'var(--accent)', '#16a34a'][done]} style="transition: fill 0.4s;" />
            <text x="0" y="4" text-anchor="middle" class="tag onbox">{['req', 'req′', 'req″'][done]}</text>
            {#if working}
              {#key hop}
                <rect x="-17" y="12" width="34" height="4" rx="2" fill="var(--line)" />
                <rect x="-17" y="12" width="34" height="4" rx="2" fill="var(--fg)" class="work" />
              {/key}
              <text x="24" y="4" class="tag strong">running the work</text>
            {/if}
          </g>

          <g in:fade={{ delay: 1000 }}>
            <text x="18" y="336" class="pt">·</text><text x="28" y="336" class="legend">the scheduler only sees its inbox and outbox: it never calls the next stage, and never waits for it</text>
            <text x="18" y="353" class="pt">·</text><text x="28" y="353" class="legend">Ch. {CH_PROC} Step 6's scheduler process worked the same way: at the top of every step it took whatever had arrived</text>
          </g>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">req′, req″: the same request, as each stage's work leaves it (tokens, embeddings, codes …)</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">SGLang-Omni's Stage is the runtime: an event loop for I/O, which starts the scheduler in a thread named scheduler-&lt;stage&gt;</text>
        </g>
      {/if}

      <!-- 3: a stage is not a process · three layouts of the same stages; only the hand-off between them changes -->
      {#if cur.scene === 'process'}
        {@const CX = [16, 252, 488]}
        {@const CW = 216}
        {@const proc = (x: number, y: number, w: number, h: number, label: string) => ({ x, y, w, h, label })}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">a stage is a unit of work · a process is where it runs</text>

          <!-- one process per stage: the speech default -->
          <g in:fade={{ delay: 100, duration: 250 }}>
            <text x={CX[0]} y="70" class="boxtitle">one process per stage</text>
            {#each ['thinker', 'talker_ar', 'code2wav'] as n, i}
              {@const y = 82 + i * 74}
              <rect x={CX[0]} {y} width={CW - 30} height="52" rx="8" fill="none" stroke="var(--faint)" stroke-dasharray="4 3" />
              <text x={CX[0] + 8} y={y + 13} class="tag">process</text>
              <rect x={CX[0] + 30} y={y + 18} width={CW - 90} height="26" rx="6" fill={n === 'code2wav' ? 'white' : 'var(--accent-soft)'} stroke={n === 'code2wav' ? 'var(--fg)' : 'var(--accent)'} />
              <text x={CX[0] + 30 + (CW - 90) / 2} y={y + 35} text-anchor="middle" class="mono strong">{n}</text>
              {#if i < 2}
                <path d="M {CX[0] + 93} {y + 56} V {y + 70}" fill="none" stroke="#b8b4aa" stroke-width="1.4" marker-end="url(#ss-arrow)" />
                <text x={CX[0] + 102} y={y + 67} class="tag">a message</text>
              {/if}
            {/each}
          </g>

          <!-- several stages in one process -->
          <g in:fade={{ delay: 500, duration: 250 }}>
            <text x={CX[1]} y="70" class="boxtitle">several in one process</text>
            <rect x={CX[1]} y="82" width={CW - 30} height="200" rx="8" fill="none" stroke="var(--faint)" stroke-dasharray="4 3" />
            <text x={CX[1] + 8} y="95" class="tag">process</text>
            {#each ['preprocessing', 'thinker', 'decode'] as n, i}
              {@const y = 104 + i * 60}
              <rect x={CX[1] + 30} {y} width={CW - 90} height="26" rx="6" fill={n === 'thinker' ? 'var(--accent-soft)' : '#ece9e1'} stroke={n === 'thinker' ? 'var(--accent)' : 'var(--faint)'} />
              <text x={CX[1] + 30 + (CW - 90) / 2} y={y + 17} text-anchor="middle" class="mono strong">{n}</text>
              {#if i < 2}
                <path d="M {CX[1] + 93} {y + 30} V {y + 56}" fill="none" stroke="#b8b4aa" stroke-width="1.4" marker-end="url(#ss-arrow)" />
                <text x={CX[1] + 102} y={y + 47} class="tag">a direct call</text>
              {/if}
            {/each}
          </g>

          <!-- one stage across several processes -->
          <g in:fade={{ delay: 900, duration: 250 }}>
            <text x={CX[2]} y="70" class="boxtitle">one stage, several processes</text>
            {#each [0, 1] as r}
              <rect x={CX[2] + r * 108} y="82" width="100" height="88" rx="8" fill="none" stroke="var(--faint)" stroke-dasharray="4 3" />
              <text x={CX[2] + r * 108 + 8} y="95" class="tag">process · GPU {r}</text>
            {/each}
            <rect x={CX[2] + 14} y="116" width="180" height="30" rx="6" fill="var(--accent-soft)" stroke="var(--accent)" />
            <text x={CX[2] + 104} y="135" text-anchor="middle" class="mono strong">thinker</text>
          </g>

          <!-- what each layout is for -->
          <g in:fade={{ delay: 1300, duration: 250 }}>
            <text x={CX[0]} y="304" class="tag strong">Qwen3-Omni's speech default</text>
            <text x={CX[0]} y="318" class="tag">one stage's CPU work can't stall another</text>
            <text x={CX[1]} y="304" class="tag strong">Qwen3-Omni's text-only pipeline</text>
            <text x={CX[1]} y="318" class="tag">one interpreter, and they fail together</text>
            <text x={CX[2]} y="190" class="tag strong">tensor parallelism</text>
            <text x={CX[2]} y="204" class="tag">one model split over two GPUs (chapter {CH_TP})</text>
          </g>

          <g in:fade={{ delay: 1700, duration: 250 }}>
            <rect x="30" y="332" width="660" height="28" rx="14" fill="var(--accent-soft)" stroke="var(--accent)" />
            <text x={W / 2} y="351" text-anchor="middle" class="need">the stage is the same in all three; only the hand-off changes: a direct call, or a message</text>
          </g>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">a process: one running program with its own Python interpreter (Ch. {CH_PROC} Step 4) · which layout to use is chapter {CH_PLACE}'s question</text>
        </g>
      {/if}

      <!-- 4: Qwen3-Omni as SGLang-Omni runs it · seven stages, each named with the model it holds -->
      {#if cur.scene === 'stages' || cur.scene === 'closing'}
        {@const END = cur.scene === 'closing'}
        {@const BW = 100}
        {@const X = [16, 162, 308, 454, 602]}
        {@const NOMODEL = '#ece9e1'}
        {@const box = (x: number, y: number, h: number, fill: string, stroke: string) => ({ x, y, h, fill, stroke })}
        {@const S = {
          pre: box(X[0], 140, 52, NOMODEL, 'var(--faint)'),
          img: box(X[1], 84, 52, 'white', 'var(--fg)'),
          aud: box(X[1], END ? 210 : 196, 52, 'white', 'var(--fg)'),
          thk: box(X[2], 140, 52, 'var(--accent-soft)', 'var(--accent)'),
          dec: box(X[3], 72, END ? 76 : 52, NOMODEL, 'var(--faint)'),
          tlk: box(X[3], END ? 210 : 192, END ? 64 : 56, 'var(--accent-soft)', 'var(--accent)'),
          c2w: box(X[4], END ? 210 : 192, END ? 64 : 56, 'white', 'var(--fg)'),
        }}
        {@const right = (b: { x: number }) => b.x + BW}
        {@const midY = (b: { y: number; h: number }) => b.y + b.h / 2}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">{END ? "seven stages, each with the scheduler its work needs · and each in its own process" : "Qwen3-Omni as SGLang-Omni runs it · seven stages, each in its own process"}</text>

          <!-- the edges first, so the boxes sit on top -->
          <g in:fade={{ delay: 600, duration: 250 }}>
            {#each [[S.pre, S.img], [S.pre, S.aud], [S.pre, S.thk], [S.img, S.thk], [S.aud, S.thk], [S.thk, S.dec], [S.thk, S.tlk], [S.tlk, S.c2w]] as [a, b], e}
              <path d="M {right(a) + 9} {midY(a)} C {right(a) + 18} {midY(a)}, {b.x - 30} {midY(b)}, {b.x - 24} {midY(b)} L {b.x - 10} {midY(b)}" fill="none" stroke={END ? RED : '#b8b4aa'} stroke-width="1.4" marker-end={END ? 'url(#ss-arrow-red)' : 'url(#ss-arrow)'} />
              {#if END}
                {@const mx = (right(a) + b.x) / 2}
                {@const my = (midY(a) + midY(b)) / 2}
                <circle cx={mx} cy={my} r="8" fill="white" stroke={RED} />
                <text x={mx} y={my + 3.5} text-anchor="middle" class="tag strong" style:fill={RED}>{e + 1}</text>
              {/if}
            {/each}
            {#if !END}<text x={S.dec.x - 13} y={midY(S.dec) - 8} text-anchor="end" class="tag">token ids</text>{/if}
            {#if !END}<text x={S.tlk.x - 13} y={midY(S.tlk) + 16} text-anchor="end" class="tag">each token</text>{/if}
            {#if !END}<text x={(right(S.tlk) + S.c2w.x) / 2} y={midY(S.c2w) - 8} text-anchor="middle" class="tag">codes</text>{/if}
            <path d="M {right(S.dec) + 9} {midY(S.dec)} H {right(S.dec) + 32}" fill="none" stroke="#b8b4aa" stroke-width="1.4" marker-end="url(#ss-arrow)" />
            <text x={right(S.dec) + 38} y={midY(S.dec) + 4} class="tag strong">text out</text>
            <path d="M {S.c2w.x + BW / 2} {S.c2w.y + S.c2w.h + 11} V {S.c2w.y + S.c2w.h + 24}" fill="none" stroke="#b8b4aa" stroke-width="1.4" marker-end="url(#ss-arrow)" />
            <text x={S.c2w.x + BW / 2} y={S.c2w.y + S.c2w.h + 38} text-anchor="middle" class="tag strong">sound out</text>
          </g>

          <!-- the stages: stage name, what it holds, where it runs -->
          {#each [
            { b: S.pre, n: 'preprocessing', sc: ['SimpleScheduler'], l: END ? ['CPU'] : ['no model', 'CPU'], d: 100 },
            { b: S.img, n: 'image_encoder', sc: ['SimpleScheduler'], l: END ? ['GPU 0'] : ['vision encoder', 'GPU 0'], d: 250 },
            { b: S.aud, n: 'audio_encoder', sc: ['SimpleScheduler'], l: END ? ['GPU 0'] : ['audio encoder', 'GPU 0'], d: 250 },
            { b: S.thk, n: 'thinker', sc: ['OmniScheduler'], l: END ? ['GPU 0'] : ['the engine', 'GPU 0'], d: 400 },
            { b: S.dec, n: 'decode', sc: ['Streaming', 'Detokenize', 'Scheduler'], l: END ? ['CPU'] : ['no model', 'CPU'], d: 500 },
            { b: S.tlk, n: 'talker_ar', sc: ['QwenTalker', 'Scheduler'], l: END ? ['GPU 1'] : ['talker + code', 'predictor · GPU 1'], d: 500 },
            { b: S.c2w, n: 'code2wav', sc: ['Code2Wav', 'Scheduler'], l: END ? ['GPU 0'] : ['code2wav', 'GPU 0'], d: 500 },
          ] as st}
            <g in:fade={{ delay: st.d, duration: 250 }}>
              <rect x={st.b.x - 6} y={st.b.y - 19} width={BW + 12} height={st.b.h + 27} rx="11" fill="none" stroke="var(--faint)" stroke-dasharray="4 3" />
              <text x={st.b.x - 1} y={st.b.y - 7} class="tag">process</text>
              <rect x={st.b.x} y={st.b.y} width={BW} height={st.b.h} rx="8" fill={st.b.fill} stroke={st.b.stroke} />
              <text x={st.b.x + BW / 2} y={st.b.y + 17} text-anchor="middle" class="mono strong">{st.n}</text>
              {#each [...(END ? st.sc : []), ...st.l] as line, i}
                <text x={st.b.x + BW / 2} y={st.b.y + 31 + i * 12} text-anchor="middle" class={END && i < st.sc.length ? 'tag strong' : 'tag'}>{line}</text>
              {/each}
            </g>
          {/each}

          {#if END}
            <g in:fade={{ delay: 1000, duration: 250 }}>
              <text x="18" y="322" class="pt">·</text><text x="28" y="322" class="legend">edges 1–5 carry a request's inputs once; edges 6–8 carry a piece every token or every 10 frames</text>
              <text x="18" y="339" class="pt">·</text><text x="28" y="339" class="legend">each edge joins two processes, which may share a GPU (4, 5), sit on two GPUs (7, 8), or have the CPU at one end (1–3, 6)</text>
            </g>
            <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">each box: the stage, its scheduler (steps 7–11), and where it runs · dashed: a process · both GPUs in one machine</text>
            <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">not drawn: three more edges carry the same inputs to talker_ar, which builds its own prompt (Ch. {CH_EDGES} Step 1)</text>
          {:else}
          <!-- the count: chapter 16's six models, one stage they share, two stages with none -->
          <g in:fade={{ delay: 1000, duration: 250 }}>
            <text x="18" y="304" class="pt">·</text><text x="28" y="304" class="legend"><tspan class="strong">7 stages</tspan> = Ch. {CH_OMNI} Step 4's 6 models, − 1 because the talker and code predictor share one, + 2 that run no model</text>
            <text x="18" y="321" class="pt">·</text><text x="28" y="321" class="legend">preprocessing turns the request into tokens, photo patches and audio frames; decode is the detokenizer</text>
            <text x="18" y="338" class="pt">·</text><text x="28" y="338" class="legend"><tspan class="strong">7 processes</tspan>: 2 on the CPU, 4 sharing GPU 0, the talker alone on GPU 1 (why this layout: chapter {CH_PLACE})</text>
          </g>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">white: one pass · blue: a loop (Ch. {CH_OMNI} Step 4) · grey: no model · dashed: a process · the talker also reads the prompt (Ch. {CH_EDGES} Step 1)</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">SGLang-Omni's speech pipeline; its design notes add an eighth stage, mm_aggregate, a join the thinker and talker now do themselves</text>
          {/if}
        </g>
      {/if}
      <!-- 5: why the code predictor has no stage · what it reads and what it writes are both the talker's -->
      {#if cur.scene === 'predictor'}
        {@const TB = { x: 270, y: 104, w: 170, h: 56 }}
        {@const PB = { x: 270, y: 222, w: 170, h: 56 }}
        {@const CHIP = { x: 40, w: 150 }}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">why the code predictor has no stage · what it reads and what it writes are both the talker's</text>

          <!-- one talker step, drawn as the loop it is: inputs in, talker, code predictor, the frame, and back -->
          <g in:fade={{ delay: 100, duration: 250 }}>
            <text x="16" y="70" class="boxtitle">one talker step · one frame</text>
            <rect x="16" y="78" width="688" height="262" rx="12" fill="none" stroke="var(--faint)" stroke-dasharray="4 3" />

            <rect x={CHIP.x} y="112" width={CHIP.w} height="26" rx="6" fill="#ece9e1" stroke="var(--faint)" />
            <text x={CHIP.x + CHIP.w / 2} y="129" text-anchor="middle" class="tag strong">a token, from the thinker</text>
            <rect x={CHIP.x} y="176" width={CHIP.w} height="26" rx="6" fill="var(--gen-soft)" stroke="var(--gen)" />
            <text x={CHIP.x + CHIP.w / 2} y="193" text-anchor="middle" class="tag strong">the last frame</text>
            <path d="M {CHIP.x + CHIP.w + 4} 125 C 230 125, 236 126, {TB.x - 12} 126 L {TB.x - 4} 126" fill="none" stroke="#b8b4aa" stroke-width="1.4" marker-end="url(#ss-arrow)" />
            <path d="M {CHIP.x + CHIP.w + 4} 189 C 232 189, 232 140, {TB.x - 12} 140 L {TB.x - 4} 140" fill="none" stroke="#b8b4aa" stroke-width="1.4" marker-end="url(#ss-arrow)" />

            <rect x={TB.x} y={TB.y} width={TB.w} height={TB.h} rx="8" fill="var(--accent-soft)" stroke="var(--accent)" />
            <text x={TB.x + TB.w / 2} y={TB.y + 24} text-anchor="middle" class="slab strong small">talker</text>
            <text x={TB.x + TB.w / 2} y={TB.y + 40} text-anchor="middle" class="tag">one forward pass · code 0</text>
          </g>

          <g in:fade={{ delay: 500, duration: 250 }}>
            <path d="M {TB.x + TB.w / 2} {TB.y + TB.h + 4} V {PB.y - 4}" fill="none" stroke="var(--accent)" stroke-width="1.4" marker-end="url(#ss-arrow-accent)" />
            <text x={TB.x + TB.w / 2 + 12} y="186" class="tag strong" style:fill="var(--accent)">read from the talker:</text>
            <text x={TB.x + TB.w / 2 + 12} y="200" class="tag">its hidden state and code 0</text>
            <rect x={PB.x} y={PB.y} width={PB.w} height={PB.h} rx="8" fill="var(--gen-soft)" stroke="var(--gen)" />
            <text x={PB.x + PB.w / 2} y={PB.y + 24} text-anchor="middle" class="slab strong small">code predictor</text>
            <text x={PB.x + PB.w / 2} y={PB.y + 40} text-anchor="middle" class="tag">codes 1–{CODES_PER_FRAME - 1}, one after another</text>
          </g>

          <g in:fade={{ delay: 900, duration: 250 }}>
            <path d="M {PB.x + PB.w + 4} {PB.y + PB.h / 2} H 482" fill="none" stroke="#b8b4aa" stroke-width="1.4" marker-end="url(#ss-arrow)" />
            <rect x="486" y={PB.y + PB.h / 2 - 14} width="128" height="28" rx="6" fill="var(--gen-soft)" stroke="var(--gen)" />
            <text x="550" y={PB.y + PB.h / 2 + 4} text-anchor="middle" class="tag strong">the frame · {CODES_PER_FRAME} codes</text>
            <path d="M 618 {PB.y + PB.h / 2} H 684" fill="none" stroke="#b8b4aa" stroke-width="1.4" marker-end="url(#ss-arrow)" />
            <text x="650" y={PB.y + PB.h / 2 - 8} text-anchor="middle" class="tag">to code2wav</text>
            <!-- the frame goes back to the start of the loop -->
            <path d="M 550 {PB.y + PB.h / 2 + 18} V 312 H {CHIP.x + CHIP.w / 2} V 206" fill="none" stroke="var(--gen)" stroke-width="1.5" marker-end="url(#ss-arrow-gen)" />
            <text x={(CHIP.x + CHIP.w / 2 + 550) / 2} y="304" text-anchor="middle" class="tag strong" style:fill="var(--gen)">written for the talker: its next input</text>
          </g>

          <text x={W / 2} y="366" text-anchor="middle" class="legend" in:fade={{ delay: 1300 }}>so as a stage of its own, every frame would leave the talker's stage and come back (next step)</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">in SGLang-Omni the code predictor runs inside talker_ar's forward pass, after the talker's own layers</text>
        </g>
      {/if}

      <!-- 6: what a stage of its own would cost · two hand-offs a frame, on the talker's path -->
      {#if cur.scene === 'handoffs'}
        {@const T = 26}
        {@const P = 56}
        {@const HO = 26}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">what a stage of its own would cost · two hand-offs every frame</text>
          <g transform="translate(0, -86)">
          <!-- the same frames, two ways: a stage of its own pays two hand-offs a frame on the talker's path -->
            <g in:fade={{ delay: 700, duration: 250 }}>
              <text x="16" y="208" class="boxtitle">if the code predictor were a stage of its own</text>
              {#each Array(5) as _, f}
                {@const x = 16 + f * (T + HO + P + HO)}
                <rect {x} y="216" width={T - 2} height="18" rx="3" fill="var(--accent)" opacity="0.75" />
                <rect x={x + T} y="216" width={HO - 2} height="18" rx="3" fill="var(--eos-soft)" stroke={RED} stroke-dasharray="3 2" />
                <rect x={x + T + HO} y="216" width={P - 2} height="18" rx="3" fill="var(--gen)" opacity="0.75" />
                <rect x={x + T + HO + P} y="216" width={HO - 2} height="18" rx="3" fill="var(--eos-soft)" stroke={RED} stroke-dasharray="3 2" />
              {/each}
              <text x="16" y="250" class="tag"><tspan class="strong" style:fill={RED}>2 hand-offs a frame</tspan>, and the talker waits through both: {FRAMES} frames × 2 = {FRAMES * 2} for the {A_SEC} s answer</text>
            </g>
            <g in:fade={{ delay: 1100, duration: 250 }}>
              <text x="16" y="280" class="boxtitle">inside the talker's step · as SGLang-Omni runs it</text>
              {#each Array(8) as _, f}
                {@const x = 16 + f * (T + P)}
                <rect {x} y="288" width={T - 2} height="18" rx="3" fill="var(--accent)" opacity="0.75" />
                <rect x={x + T} y="288" width={P - 2} height="18" rx="3" fill="var(--gen)" opacity="0.75" />
              {/each}
              <text x="16" y="322" class="tag"><tspan class="strong">0 hand-offs</tspan>: the hidden state and the frame stay where the step left them, on the GPU</text>
            </g>

          </g>
          <!-- the colour key, next to what it explains -->
          <g in:fade={{ delay: 300, duration: 250 }}>
            {#each [{ f: 'var(--accent)', o: 0.75, n: 'a talker pass' }, { f: 'var(--gen)', o: 0.75, n: "the code predictor's passes" }] as k, i}
              <rect x={16 + i * 114} y="268" width="16" height="11" rx="2" fill={k.f} opacity={k.o} />
              <text x={38 + i * 114} y="278" class="tag">{k.n}</text>
            {/each}
            <rect x="302" y="268" width="16" height="11" rx="2" fill="var(--eos-soft)" stroke={RED} stroke-dasharray="3 2" />
            <text x="324" y="278" class="tag">a hand-off between stages, not to scale (what one costs: Ch. {CH_EDGES} Step 3)</text>
          </g>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">SGLang-Omni's placement check: "Qwen code predictor is part of talker_ar and must not be a stage"</text>
        </g>
      {/if}
      <!-- 7: the map · three kinds of scheduler, sorted by what a stage keeps between calls -->
      {#if cur.scene === 'kinds'}
        {@const CW = 220}
        {@const CX = [16, 250, 484]}
        {@const NOMODEL = '#ece9e1'}
        {@const kinds = [
          { n: 'one pass', keep: ['nothing: each request arrives whole,', 'runs once, and is gone'], sched: 'SimpleScheduler',
            stages: [{ n: 'preprocessing', f: NOMODEL, s: 'var(--faint)' }, { n: 'image_encoder', f: 'white', s: 'var(--fg)' }, { n: 'audio_encoder', f: 'white', s: 'var(--fg)' }] },
          { n: 'a loop', keep: ["each request's KV cache, growing", 'every step, and the running batch'], sched: "SGLang's own scheduler",
            stages: [{ n: 'thinker', f: 'var(--accent-soft)', s: 'var(--accent)' }, { n: 'talker_ar', f: 'var(--accent-soft)', s: 'var(--accent)' }] },
          { n: 'streaming', keep: ["each request's pieces so far,", 'until there are enough to use'], sched: 'its own, per stage',
            stages: [{ n: 'decode', f: NOMODEL, s: 'var(--faint)' }, { n: 'code2wav', f: 'white', s: 'var(--fg)' }] },
        ]}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">three kinds of scheduler · sorted by what a stage keeps between calls</text>
          {#each kinds as k, i}
            {@const x = CX[i]}
            <g in:fade={{ delay: 100 + i * 400, duration: 250 }}>
              <rect {x} y="56" width={CW} height="276" rx="12" fill="#fbfaf7" stroke="var(--line)" />
              <text x={x + 14} y="76" class="boxtitle">{i + 1} of 3</text>
              <text x={x + 14} y="94" class="slab strong small">{k.n}</text>

              <!-- what the work looks like -->
              {#if i === 0}
                <rect x={x + 14} y="112" width="56" height="28" rx="5" fill="white" stroke="var(--faint)" />
                <text x={x + 42} y="130" text-anchor="middle" class="tag strong">input</text>
                <path d="M {x + 74} 126 H {x + 84}" fill="none" stroke="#b8b4aa" stroke-width="1.4" marker-end="url(#ss-arrow)" />
                <rect x={x + 88} y="112" width="44" height="28" rx="5" fill="white" stroke="var(--fg)" />
                <text x={x + 110} y="130" text-anchor="middle" class="tag strong">run</text>
                <path d="M {x + 136} 126 H {x + 146}" fill="none" stroke="#b8b4aa" stroke-width="1.4" marker-end="url(#ss-arrow)" />
                <rect x={x + 150} y="112" width="56" height="28" rx="5" fill="white" stroke="var(--faint)" />
                <text x={x + 178} y="130" text-anchor="middle" class="tag strong">result</text>
                <text x={x + 14} y="162" class="tag">the whole input at once, one run</text>
              {:else if i === 1}
                {#each [0, 1, 2, 3] as j}
                  <rect x={x + 14 + j * 48} y="108" width="40" height="22" rx="5" fill="var(--accent-soft)" stroke="var(--accent)" />
                  <text x={x + 34 + j * 48} y="123" text-anchor="middle" class="tag strong">step {j + 1}</text>
                  {#each Array(j + 1) as _, c}
                    <rect x={x + 14 + j * 48 + c * 10} y="136" width="8" height="10" rx="1.5" fill="var(--accent)" opacity="0.6" />
                  {/each}
                {/each}
                <text x={x + 14} y="162" class="tag">a step at a time, its KV cache growing</text>
              {:else}
                {#each [0, 1, 2] as j}
                  <rect x={x + 14 + j * 22} y="116" width="18" height="18" rx="3" fill="var(--gen-soft)" stroke="var(--gen)" />
                  <text x={x + 23 + j * 22} y="129" text-anchor="middle" class="tag strong">{j + 1}</text>
                {/each}
                <path d="M {x + 82} 125 H {x + 92}" fill="none" stroke="#b8b4aa" stroke-width="1.4" marker-end="url(#ss-arrow)" />
                <rect x={x + 96} y="108" width="62" height="34" rx="5" fill="white" stroke="var(--faint)" stroke-dasharray="3 2" />
                {#each [0, 1, 2] as j}
                  <rect x={x + 102 + j * 18} y="118" width="14" height="14" rx="2" fill="var(--gen)" opacity="0.55" />
                {/each}
                <path d="M {x + 162} 125 H {x + 172}" fill="none" stroke="#b8b4aa" stroke-width="1.4" marker-end="url(#ss-arrow)" />
                <rect x={x + 176} y="114" width="30" height="22" rx="5" fill="white" stroke="var(--faint)" />
                <text x={x + 191} y="129" text-anchor="middle" class="tag strong">out</text>
                <text x={x + 14} y="162" class="tag">pieces arrive while it runs</text>
              {/if}

              <!-- what it keeps between calls -->
              <text x={x + 14} y="190" class="tag strong">keeps between calls</text>
              {#each k.keep as line, j}
                <text x={x + 14} y={204 + j * 13} class="tag">{line}</text>
              {/each}

              <!-- which of step 4's stages use it -->
              <text x={x + 14} y="246" class="tag strong">used by</text>
              {#each k.stages as st, j}
                <rect x={x + 14} y={254 + j * 24} width="110" height="20" rx="5" fill={st.f} stroke={st.s} />
                <text x={x + 69} y={268 + j * 24} text-anchor="middle" class="mono strong">{st.n}</text>
              {/each}
              <text x={x + CW - 14} y="94" text-anchor="end" class="tag">{k.sched}</text>
            </g>
          {/each}

          <text x={W / 2} y="356" text-anchor="middle" class="legend" in:fade={{ delay: 1500 }}>a scheduler built around a KV cache has nothing to do for an encoder, and no way to wait for pieces</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">SGLang-Omni's names: SimpleScheduler · OmniScheduler, which reuses SGLang's · StreamingDetokenizeScheduler and Code2WavScheduler</text>
        </g>
      {/if}
      <!-- 8: 1 of 3, one pass · chapter 10's loop, row by row, against SimpleScheduler's -->
      {#if cur.scene === 'onepass'}
        {@const LX = 16}
        {@const LW = 300}
        {@const RX = 384}
        {@const RW = 320}
        {@const RH = 34}
        {@const ry = (i: number) => 92 + i * 40}
        {@const rows = [
          { n: 'recv_requests', d: 'inbox → Req objects', keep: true, r: 'take what is waiting in the inbox, up to 32' },
          { n: 'get_next_batch_to_run', d: 'prefill or decode? room in the pool?', keep: false, r: 'every request is new, and done after this run' },
          { n: 'ScheduleBatch → tensors', d: 'ids · positions · pages', keep: true, r: 'stack the inputs: no positions, no pages' },
          { n: 'ModelRunner.forward', d: 'embed → 32 layers → logits', keep: true, r: 'run the encoder once' },
          { n: 'Sampler', d: 'logits → tokens', keep: false, r: 'an encoder hands over embeddings: nothing to pick' },
          { n: 'process_batch_result', d: 'append · finish · send', keep: true, r: 'put each result in the outbox: all finished' },
        ]}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">1 of 3 · one pass · SimpleScheduler, against SGLang's loop row by row</text>
          <g in:fade={{ delay: 100, duration: 250 }}>
            <text x={LX} y="70" class="boxtitle">SGLang's loop · Ch. {CH_ENGINE} Step 1</text>
            <text x={LX} y="84" class="tag">keeps: waiting and running lists, KV pages, the radix tree</text>
            {#each rows as r, i}
              <rect x={LX} y={ry(i)} width={LW} height={RH} rx="6" fill="var(--accent-soft)" stroke="var(--accent)" />
              <text x={LX + 10} y={ry(i) + 15} class="mono strong">{r.n}</text>
              <text x={LX + 10} y={ry(i) + 28} class="tag">{r.d}</text>
            {/each}
          </g>
          <g in:fade={{ delay: 500, duration: 250 }}>
            <text x={RX} y="70" class="boxtitle">one pass · SimpleScheduler</text>
            <text x={RX} y="84" class="tag">keeps: nothing</text>
            {#each rows as r, i}
              <path d="M {LX + LW + 6} {ry(i) + RH / 2} H {RX - 6}" fill="none" stroke={r.keep ? '#b8b4aa' : 'var(--line)'} stroke-width="1.4" stroke-dasharray={r.keep ? 'none' : '3 3'} marker-end={r.keep ? 'url(#ss-arrow)' : undefined} />
              {#if r.keep}
                <rect x={RX} y={ry(i)} width={RW} height={RH} rx="6" fill="white" stroke="var(--fg)" />
                <text x={RX + 10} y={ry(i) + 21} class="tag strong">{r.r}</text>
              {:else}
                <rect x={RX} y={ry(i)} width={RW} height={RH} rx="6" fill="none" stroke="var(--faint)" stroke-dasharray="4 3" />
                <text x={RX + 10} y={ry(i) + 15} class="tag strong" style:fill="var(--muted)">not needed</text>
                <text x={RX + 10} y={ry(i) + 28} class="tag">{r.r}</text>
              {/if}
            {/each}
          </g>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">the encoders batch whatever is already waiting, up to 32 requests, and by default do not wait for more</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">an encoder also keeps recent results by the input's hash (Ch. {CH_OMNI} Step 2), but in its own code, not the scheduler's</text>
        </g>
      {/if}
      <!-- 9: 2 of 3, a loop · the same six rows; SGLang's own code in the middle, changed only at the edges -->
      {#if cur.scene === 'loop'}
        {@const LX = 16}
        {@const LW = 300}
        {@const RX = 384}
        {@const RW = 320}
        {@const RH = 34}
        {@const ry = (i: number) => 92 + i * 40}
        {@const rows = [
          { n: 'recv_requests', d: 'inbox → Req objects', own: false, r: "read the stage's inbox, not a socket" },
          { n: 'get_next_batch_to_run', d: 'prefill or decode? room in the pool?', own: true, r: 'the same choice, the same pool' },
          { n: 'ScheduleBatch → tensors', d: 'ids · positions · pages', own: true, r: 'the same tensors, the same pages' },
          { n: 'ModelRunner.forward', d: 'embed → 32 layers → logits', own: false, r: "the model's runner: embeddings in, each token sent on" },
          { n: 'Sampler', d: 'logits → tokens', own: false, r: "picked inside the model's runner" },
          { n: 'process_batch_result', d: 'append · finish · send', own: true, r: 'the same append and finish; its send is switched off' },
        ]}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">2 of 3 · a loop · SGLang's own scheduler, reused for the thinker and the talker</text>
          <g in:fade={{ delay: 100, duration: 250 }}>
            <text x={LX} y="70" class="boxtitle">SGLang's loop · Ch. {CH_ENGINE} Step 1</text>
            <text x={LX} y="84" class="tag">keeps: waiting and running lists, KV pages, the radix tree</text>
            {#each rows as r, i}
              <rect x={LX} y={ry(i)} width={LW} height={RH} rx="6" fill="var(--accent-soft)" stroke="var(--accent)" />
              <text x={LX + 10} y={ry(i) + 15} class="mono strong">{r.n}</text>
              <text x={LX + 10} y={ry(i) + 28} class="tag">{r.d}</text>
            {/each}
          </g>
          <g in:fade={{ delay: 500, duration: 250 }}>
            <text x={RX} y="70" class="boxtitle">a loop · SGLang-Omni's OmniScheduler</text>
            <text x={RX} y="84" class="tag">keeps: the same lists, pages and tree</text>
            {#each rows as r, i}
              <path d="M {LX + LW + 6} {ry(i) + RH / 2} H {RX - 6}" fill="none" stroke="#b8b4aa" stroke-width="1.4" marker-end="url(#ss-arrow)" />
              <rect x={RX} y={ry(i)} width={RW} height={RH} rx="6" fill={r.own ? 'var(--accent-soft)' : 'white'} stroke={r.own ? 'var(--accent)' : 'var(--fg)'} />
              <text x={RX + 10} y={ry(i) + 15} class="tag strong">{r.own ? "SGLang's own code" : 'changed'}</text>
              <text x={RX + 10} y={ry(i) + 28} class="tag">{r.r}</text>
            {/each}
          </g>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">OmniScheduler calls SGLang's Scheduler methods directly (no copy, no subclass), and overrides the ones that touch the inbox or the runner</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">left out of SGLang's scheduler: its sockets, tokenizer, grammar, LoRA and speculative decoding (SGLang-Omni's design notes)</text>
        </g>
      {/if}
      <!-- 10: the talker's version · step 9's rows, the ready check slid in, and the check at work on one batch -->
      {#if cur.scene === 'talker'}
        {@const LX = 34}
        {@const LW = 250}
        {@const rh = 26}
        {@const ry = (i: number) => 78 + i * 32}
        {@const loopRows = [
          { n: 'recv_requests', t: 'changed', f: 'white', s: 'var(--fg)', at: 0 },
          { n: 'get_next_batch_to_run', t: "SGLang's own", f: 'var(--accent-soft)', s: 'var(--accent)', at: 1 },
          { n: 'ScheduleBatch → tensors', t: "SGLang's own", f: 'var(--accent-soft)', s: 'var(--accent)', at: 2 },
          { n: 'ModelRunner.forward', t: 'changed', f: 'white', s: 'var(--fg)', at: 3 },
          { n: 'Sampler', t: 'changed', f: 'white', s: 'var(--fg)', at: 4 },
          { n: 'process_batch_result', t: "SGLang's own", f: 'var(--accent-soft)', s: 'var(--accent)', at: 5 },
        ]}
        {@const inserted = tp >= 1}
        {@const checking = tp >= 2 && tp <= 4}
        {@const running = tp >= 6}
        {@const PX = 320}
        {@const PY = 76}
        {@const reqs = ['A', 'B', 'C']}
        {@const qx = (i: number) => PX + 130 + i * 56}
        {@const cHere = tp >= 5}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">the check Ch. {CH_OMNI} Step 5 asked for · step 9's loop, plus one row</text>

          <!-- the loop: step 9's five rows; rows below the new one slide down to make room -->
          <text x="16" y="68" class="boxtitle">the talker's loop</text>
          {#each loopRows as r}
            {@const y = ry(r.at + (inserted && r.at >= 2 ? 1 : 0))}
            {@const hot = running && r.n === 'ModelRunner.forward'}
            <g style="transform: translate(0px, {y}px); transition: transform 0.7s ease-in-out;">
              <rect x={LX} y="0" width={LW} height={rh} rx="6" fill={r.f} stroke={r.s} stroke-width={hot ? 2 : 1} />
              <text x={LX + 10} y="17" class="mono strong">{r.n}</text>
              <text x={LX + LW - 8} y="17" text-anchor="end" class="tag">{r.t}</text>
            </g>
          {/each}
          {#if inserted}
            <g in:fade={{ delay: 650, duration: 400 }} out:fade={{ duration: 150 }}>
              <rect x={LX} y={ry(2)} width={LW} height={rh} rx="6" fill="var(--gen-soft)" stroke="var(--gen)" stroke-width={checking ? 2.5 : 1.5} />
              <text x={LX + 10} y={ry(2) + 17} class="mono strong">ready check</text>
              <text x={LX + LW - 8} y={ry(2) + 17} text-anchor="end" class="tag">next token here?</text>
              <text x={LX + LW + 8} y={ry(2) + 17} class="tag strong" style:fill="var(--gen)">new</text>
            </g>
          {/if}
          <path d="M {LX} {ry(inserted ? 6 : 5) + rh / 2} H {LX - 20} V {ry(0) + rh / 2} H {LX - 6}" fill="none" stroke="#b8b4aa" stroke-width="1.4" marker-end="url(#ss-arrow)" style="transition: d 0.7s ease-in-out;" />

          <!-- the check at work on one batch: three iterations along the top, held while C's token is missing, then run -->
          {#if tp >= 2}
            {@const curIt = tp <= 3 ? 0 : tp <= 5 ? 1 : 2}
            {@const result = (k: number) => (k === 0 ? (tp >= 3 ? 'held' : 'checking') : k === 1 ? (tp >= 4 ? 'held' : '') : tp >= 6 ? 'ran' : '')}
            <g transition:fade={{ duration: 300 }}>
              <rect x={PX} y={PY} width="384" height="200" rx="10" fill="#fbfaf7" stroke="var(--line)" />
              {#each [0, 1, 2] as k}
                {@const r = k <= curIt ? result(k) : ''}
                {@const ix = PX + 12 + k * 122}
                <rect x={ix} y={PY + 12} width="112" height="34" rx="6"
                  fill={r === 'held' ? 'var(--eos-soft)' : r === 'ran' ? 'var(--accent-soft)' : k === curIt ? 'white' : 'none'}
                  stroke={k === curIt ? 'var(--fg)' : r === 'held' ? RED : r === 'ran' ? 'var(--accent)' : 'var(--faint)'}
                  stroke-width={k === curIt ? 2 : 1} stroke-dasharray={k > curIt ? '3 3' : 'none'} style="transition: fill 0.3s, stroke 0.3s;" />
                <text x={ix + 56} y={PY + 26} text-anchor="middle" class="tag strong" style:fill={k > curIt ? 'var(--muted)' : 'var(--fg)'}>iteration {k + 1}</text>
                <text x={ix + 56} y={PY + 39} text-anchor="middle" class="tag strong" style:fill={r === 'held' ? RED : 'var(--fg)'}>{r}</text>
              {/each}
              <!-- a pulse on the iteration that just started -->
              {#key curIt}
                <rect x={PX + 12 + curIt * 122} y={PY + 12} width="112" height="34" rx="6" fill="none" stroke="var(--fg)" class="ss-pulse" />
              {/key}

              <text x={PX + 14} y={PY + 80} class="tag strong">the talker's batch</text>
              <text x={PX + 14} y={PY + 114} class="tag strong">next token</text>
              {#each reqs as q, i}
                <rect x={qx(i)} y={PY + 67} width="40" height="18" rx="9" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width={running ? 2 : 1} />
                <text x={qx(i) + 20} y={PY + 80} text-anchor="middle" class="tag strong">{q}</text>
                {#if i < 2}
                  <rect x={qx(i) + 6} y={PY + 100} width="28" height="20" rx="4" fill="var(--gen-soft)" stroke="var(--gen)" />
                  <text x={qx(i) + 20} y={PY + 114} text-anchor="middle" class="tag strong">here</text>
                {:else}
                  <rect x={qx(i) + 6} y={PY + 100} width="28" height="20" rx="4" fill="var(--eos-soft)" stroke={RED} stroke-dasharray="3 2" />
                {/if}
              {/each}
              <!-- C's token: it appears on the thinker's side, then moves into C's slot -->
              {#if tp >= 4}
                <g transition:fade={{ duration: 200 }}>
                  {#if !cHere}<text x={PX + 330} y={PY + 136} text-anchor="middle" class="tag" transition:fade={{ duration: 150 }}>from the thinker</text>{/if}
                  <g style="transform: translate({cHere ? qx(2) + 6 : PX + 316}px, {PY + 100}px); transition: transform 0.9s ease-in-out;">
                    <rect x="0" y="0" width="28" height="20" rx="4" fill="var(--gen-soft)" stroke="var(--gen)" />
                    <text x="14" y="14" text-anchor="middle" class="tag strong">{cHere ? 'here' : 'C'}</text>
                  </g>
                </g>
              {/if}
              <text x={PX + 14} y={PY + 164} class="tag strong" style:fill={tp === 3 || tp === 4 ? RED : 'var(--fg)'}>
                {tp <= 2 ? "checking that every request's next token is here" : tp <= 4 ? "C's token is not here, so nothing runs" : tp === 5 ? "C's token arrives from the thinker" : 'all three are here, so one forward pass runs'}
              </text>
              <text x={PX + 14} y={PY + 180} class="tag">
                {tp <= 2 ? '' : tp <= 4 ? 'the loop goes back to the top and checks again' : tp === 5 ? 'through the inbox, filed under C' : 'for A, B and C together'}
              </text>
            </g>
          {/if}

          <g in:fade={{ delay: 600, duration: 250 }}>
            <text x="18" y="318" class="pt">·</text><text x="28" y="318" class="legend">overlap scheduling is off (Ch. {CH_ENGINE} Step 8), since each step's input is the frame the step before wrote</text>
            <text x="18" y="336" class="pt">·</text><text x="28" y="336" class="legend">the radix cache is off (Ch. 8 Step 4), since the tree matches token ids and the talker's prompt arrives as vectors</text>
          </g>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">chunked prefill is off for the talker too · after the thinker's last token, every request reads a pad token, which is always there</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">SGLang-Omni's QwenTalkerScheduler skips a decode batch that is missing any request's input, and rolls back its prep</text>
        </g>
      {/if}

      <!-- 11: 3 of 3, streaming · the same six rows, one column per streaming stage -->
      {#if cur.scene === 'streaming'}
        {@const LX = 16}
        {@const LW = 196}
        {@const CX = [250, 490]}
        {@const CW2 = 214}
        {@const RH = 34}
        {@const ry = (i: number) => 92 + i * 40}
        {@const rows = [
          { n: 'recv_requests', d: 'inbox → Req objects',
            c: [{ keep: true, r: 'a token at a time, filed by request' }, { keep: true, r: 'frames in pieces, filed by request' }] },
          { n: 'get_next_batch_to_run', d: 'prefill or decode? room in the pool?',
            c: [{ keep: false, r: 'each token is handled as it arrives' }, { keep: true, r: `requests with ${CHUNK} new frames, batched` }] },
          { n: 'ScheduleBatch → tensors', d: 'ids · positions · pages',
            c: [{ keep: false, r: 'no model, no GPU' }, { keep: true, r: `up to ${CONTEXT} earlier frames + the ${CHUNK} new` }] },
          { n: 'ModelRunner.forward', d: 'embed → 32 layers → logits',
            c: [{ keep: true, r: 'pending tokens → text, on the CPU' }, { keep: true, r: 'code2wav, once over each window' }] },
          { n: 'Sampler', d: 'logits → tokens',
            c: [{ keep: false, r: 'nothing to pick' }, { keep: false, r: 'nothing to pick: it writes sound' }] },
          { n: 'process_batch_result', d: 'append · finish · send',
            c: [{ keep: true, r: 'send the text; keep half a character' }, { keep: true, r: `send the ${CHUNK} new frames' sound` }] },
        ]}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">3 of 3 · streaming · decode and code2wav, against SGLang's loop row by row</text>
          <g in:fade={{ delay: 100, duration: 250 }}>
            <text x={LX} y="70" class="boxtitle">SGLang's loop · Ch. {CH_ENGINE} Step 1</text>
            <text x={LX} y="84" class="tag">keeps: lists, KV pages, the tree</text>
            {#each rows as r, i}
              <rect x={LX} y={ry(i)} width={LW} height={RH} rx="6" fill="var(--accent-soft)" stroke="var(--accent)" />
              <text x={LX + 10} y={ry(i) + 15} class="mono strong">{r.n}</text>
              <text x={LX + 10} y={ry(i) + 28} class="tag">{r.d}</text>
            {/each}
          </g>
          {#each [{ n: 'decode', k: 'keeps: tokens not yet a whole character' }, { n: 'code2wav', k: 'keeps: the frames so far' }] as col, j}
            <g in:fade={{ delay: 500 + j * 400, duration: 250 }}>
              <text x={CX[j]} y="70" class="boxtitle">{col.n}</text>
              <text x={CX[j]} y="84" class="tag">{col.k}</text>
              {#each rows as r, i}
                {@const c = r.c[j]}
                {#if j === 0}
                  <path d="M {LX + LW + 7} {ry(i) + RH / 2} H {CX[0] - 7}" fill="none" stroke={c.keep ? '#b8b4aa' : 'var(--line)'} stroke-width="1.4" stroke-dasharray={c.keep ? 'none' : '3 3'} marker-end={c.keep ? 'url(#ss-arrow)' : undefined} />
                {/if}
                {#if c.keep}
                  <rect x={CX[j]} y={ry(i)} width={CW2} height={RH} rx="6" fill="white" stroke="var(--fg)" />
                  <text x={CX[j] + 10} y={ry(i) + 15} class="tag strong">changed</text>
                {:else}
                  <rect x={CX[j]} y={ry(i)} width={CW2} height={RH} rx="6" fill="none" stroke="var(--faint)" stroke-dasharray="4 3" />
                  <text x={CX[j] + 10} y={ry(i) + 15} class="tag strong" style:fill="var(--muted)">not needed</text>
                {/if}
                <text x={CX[j] + 10} y={ry(i) + 28} class="tag">{c.r}</text>
              {/each}
            </g>
          {/each}
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">half a character: the tokenizer works on bytes, so one character can span two tokens</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">SGLang-Omni's StreamingDetokenizeScheduler and Code2WavScheduler · code2wav rereads earlier frames so the seams are smooth</text>
        </g>
      {/if}
      {#if cur.scene === 'stage' || cur.scene === 'talker'}<LoopProgress ms={lapMs} {lap} />{/if}
    </svg>
  </div>

  <StepControls {step} total={steps.length} caption={cur.caption} {prev} {next} onchange={(s) => (step = s)} />
</figure>

<style>
  /* step 2: a scheduler working on the request, as a bar that fills */
  .work { transform-box: fill-box; transform-origin: left; animation: work 1.8s linear forwards; }
  @keyframes work { from { transform: scaleX(0); } to { transform: scaleX(1); } }
  /* step 10: the iteration that just started flashes its outline */
  .ss-pulse { animation: ss-pulse 1s ease-out forwards; }
  @keyframes ss-pulse { from { stroke-width: 6; stroke-opacity: 0.45; } to { stroke-width: 2; stroke-opacity: 0; } }
</style>
