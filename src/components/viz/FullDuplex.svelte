<script lang="ts">
  import { untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import StepControls from '../StepControls.svelte';
  import LoopProgress from '../LoopProgress.svelte';
  import { chapterNumber as chNum, type NavLink } from '../../chapters';
  import { HBM_GB, BYTES, OMNI_PARAMS_B as P, OMNI_KB_PER_TOKEN as KV_KB, AUDIO_FRAMES_PER_SEC, AUDIO_POS_PER_100 } from '../../numbers';
  let { prev, next }: { prev?: NavLink; next?: NavLink } = $props();

  const CH_KV = chNum('07-kv-memory'), CH_PREFIX = chNum('08-prefix-caching'), CH_OMNI = chNum('16-omni-models'), CH_STAGES = chNum('17-stages-and-schedulers'), CH_BETWEEN = chNum('18-between-stages'), CH_GPUS = chNum('19-sharing-gpus');
  const fmt = (n: number) => n.toLocaleString('en-US');
  const f1 = (n: number) => n.toFixed(1);

  // MiniCPM-o 4.5, the native full-duplex model SGLang-Omni serves: it takes the listener's audio a second at a time
  const CALL_S = 60;                                                     // a one-minute call
  const CALL_UNITS = CALL_S;
  const UNIT_S = 1;                                                      // a unit's length, in seconds
  const UNITS_SHOWN = 4;                                                 // units step 2 plays through the stages

  // the closing: Qwen3-Omni's thinker keeps 13 positions of KV per second of listening (Ch. 16 Step 2), 96 KB each
  const POS_PER_S = (AUDIO_FRAMES_PER_SEC * AUDIO_POS_PER_100) / 100;     // 13
  const CALL_MIN = 30;
  const CALL_KV_GB = (CALL_MIN * 60 * POS_PER_S * KV_KB) / 1e6;          // 2.2
  const GPU0_W = (P.thinker + P.audio + P.vision + P.code2wav) * BYTES;   // 63.8, GPU 0 of the default layout (Ch. 19 Step 1)
  const CALLS_FIT = Math.floor((HBM_GB - GPU0_W) / CALL_KV_GB);          // 7

  // step 1: the same eleven seconds of the listener, served turn-based behind a VAD and full duplex. Times in seconds.
  const DX0 = 150, DPX = 50, DUPLEX_S = 11;
  const dx = (s: number) => DX0 + s * DPX;
  const VAD_MS = 800;                                                    // Qwen3-Omni's VAD: this much silence ends a turn
  const LISTENER = [{ a: 0, b: 1.6, n: 'is it cold…' }, { a: 2.8, b: 4.3, n: '…in Paris?' }, { a: 6.6, b: 7.5, n: 'mm-hm' }];
  const SILENT = [1.6, 4.3, 7.5].map((a) => ({ a, b: a + VAD_MS / 1000 }));   // the silence the VAD waits out after each stretch of speech
  const TURNS = [{ a: 2.4, b: 2.8, n: '', cut: true }, { a: 5.1, b: 6.6, n: 'the answer', cut: true }, { a: 8.3, b: DUPLEX_S, n: 'a reply to “mm-hm”', cut: false }];
  const SPEAK_FROM = 5;                                                  // the full-duplex model listens through units 1–5, then speaks
  const DUPLEX = [{ a: SPEAK_FROM, b: DUPLEX_S, n: 'the answer', cut: false }];

  type Scene = 'duplex' | 'units' | 'forget' | 'session' | 'needs' | 'hooks' | 'queue' | 'closing';
  const steps: { scene: Scene; caption: string }[] = [
    { scene: 'duplex', caption: `A turn-based server finds turns with a voice detector (VAD): ${VAD_MS} ms of silence ends a turn, and any speech stops the reply. In full duplex the model hears while it speaks and decides itself.` },
    { scene: 'units', caption: `So the server cuts the incoming audio into units, a second each for MiniCPM-o, and each unit goes through the stages as a request of its own. A one-minute call is ${CALL_UNITS} requests through every stage.` },
    { scene: 'forget', caption: `A request carries everything it needs, and each stage forgets it once it ends (Ch. ${CH_KV} Step 5). In a full-duplex model every unit is a request, so between units the model forgets everything it heard and said.` },
    { scene: 'session', caption: `A session is one conversation the server keeps open. The client opens it, appends a unit at a time for as long as it lasts, and closes it. In between, each stage keeps that session's state.` },
    { scene: 'needs', caption: `Sessions need three things at once. Each stage keeps a state per session, each unit goes in only after the one before it, and every state stays on the GPU until close.` },
    { scene: 'hooks', caption: `Session operations reach each stage as requests tagged omni_session. The stage calls the matching hook: open creates the session's state, append runs a unit on it, close frees it.` },
    { scene: 'queue', caption: `The server holds the listener's audio as it arrives and sends one unit through all four stages before the next. So each unit must finish within its own ${UNIT_S} s, or the audio left waiting keeps growing.` },
    { scene: 'closing', caption: `Every open session keeps its KV cache on the GPU for the whole call: half an hour of listening is ${f1(CALL_KV_GB)} GB of the thinker's alone, so about ${CALLS_FIT} fit beside its weights.` },
  ];

  let step = $state(0);
  $effect(() => {
    const q = Number(new URLSearchParams(window.location.search).get('step'));
    if (q >= 1 && q <= steps.length) step = q - 1;
  });
  const cur = $derived(steps[step]);

  // step 2: units through MiniCPM-o's four stages, each the counterpart of a Qwen3-Omni stage (Ch. 17 Step 4)
  const STAGES = [
    { n: 'perception', q: 'the encoders', keeps: 'audio encoder state' }, { n: 'thinker', q: 'thinker', keeps: 'KV cache' },
    { n: 'talker', q: 'talker', keeps: 'KV cache' }, { n: 'speech', q: 'code2wav', keeps: 'vocoder state' },
  ];
  const SPEAKS = [false, false, true, true];                             // the model listens through units 1–2 and speaks from unit 3
  const UNIT_MS = 2600, HOP_MS = 450;

  // step 3: three units, each a request that is forgotten when it ends
  const FORGET_MS = 3600, RUN_MS = 2200;

  // step 4: a session's life, in ms: open (upstream first), three appends, close (downstream first).
  // Each `now:` line holds HOLD; within an append the unit hops a stage every HOP.
  const HOLD = 5000, OPEN_AT = 2500, STAGGER = 600, HOP = 500;
  const APPEND_AT = OPEN_AT + HOLD, CLOSE_AT = APPEND_AT + 3 * HOLD;
  const SESSION_SPAN = CLOSE_AT + HOLD + 2500;                            // 'closed' shows for the last 2.5 s, then the rest
  const sessionStatus = (t: number) => {
    if (t < OPEN_AT) return 'the client asks to open a session';
    if (t < APPEND_AT) return 'open: each stage creates the session\'s state, upstream first';
    if (t < CLOSE_AT) { const k = Math.floor((t - APPEND_AT) / HOLD); return `append: unit ${k + 1} through every stage; each adds to its state`; }
    if (t < CLOSE_AT + HOLD) return 'close: each stage frees the session\'s state, downstream first';
    return 'closed: nothing is kept';
  };

  // step 6: three tagged requests reach the thinker, each held HOOK_MS; its hook fires HOOK_FIRE in
  const HOOKS = [
    { op: 'open', s: 'C', does: 'create the state', now: 'open for session C creates its state, empty for now' },
    { op: 'append', s: 'A', does: 'run the unit on it', now: 'append for session A runs unit 3 on A\'s state and adds it' },
    { op: 'close', s: 'B', does: 'free the state', now: 'close for session B frees B\'s state' },
  ];
  const HOOK_MS = 5000, HOOK_FIRE = 1200;
  const hookDone = (t: number, k: number) => t >= k * HOOK_MS + HOOK_FIRE;
  const sessionsAt = (t: number) => [
    { s: 'A', units: hookDone(t, 1) ? 3 : 2, on: true },
    { s: 'B', units: 4, on: !hookDone(t, 2) },
    { s: 'C', units: 0, on: hookDone(t, 0) },
  ];

  // step 7: a unit arrives every UNIT_S and goes through the stages one at a time. Unit k (1-based) is the audio
  // from k − 1 to k, ready at k; it starts once it is ready and the unit before it is done.
  const QUEUE_S = 12, MAX_WAITING_S = 60;                                // the server holds at most 60 s of audio (max_input_bytes)
  const PACES = [{ d: 0.8, t: 'EACH UNIT TAKES 0.8 S · IT KEEPS UP' }, { d: 1.5, t: 'EACH UNIT TAKES 1.5 S · IT FALLS BEHIND' }];
  const startOf = (k: number, d: number) => { let s = 0; for (let j = 1; j <= k; j++) s = Math.max(j * UNIT_S, s + (j > 1 ? d : 0)); return s; };
  // the first second at which more than MAX_WAITING_S of audio is held at the slow pace: about 3 minutes
  const REJECT_S = (() => { const d = PACES[1].d; for (let t = 1; ; t++) { let done = 0; while (startOf(done + 1, d) + d <= t) done++; if (t - done * UNIT_S > MAX_WAITING_S) return t; } })();


  // the animated steps play a stretch of time (span, in ms) at a speed, rest, and loop; `once` plays it once and stops
  const ANIM: Partial<Record<Scene, [number, number, once?: boolean]>> = {
    duplex: [DUPLEX_S * 1000, 1], units: [UNITS_SHOWN * UNIT_MS + 400, 1], forget: [3 * FORGET_MS, 1], session: [SESSION_SPAN, 1],
    hooks: [HOOKS.length * HOOK_MS, 1], queue: [QUEUE_S * 1000, 1, true],
  };
  const REST = 2500;
  let t = $state(0);
  let lap = $state(0), lapMs = $state(0);           // the looping step's laps, for LoopProgress
  const nextLap = (ms: number) => untrack(() => { lapMs = ms; lap++; });   // untracked, so starting a lap does not re-run the effect
  $effect(() => {
    const anim = ANIM[cur.scene];
    if (!anim) return;
    const [span, slow, once] = anim;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { t = span; return; }
    const lapLen = span * slow + REST;
    let raf = 0, t0 = 0;
    const tick = (now: number) => {
      if (!t0 || (!once && now - t0 >= lapLen)) { t0 = now; if (!once) nextLap(lapLen); }
      t = Math.min(span, (now - t0) / slow);
      if (!once || t < span) raf = requestAnimationFrame(tick);
    };
    t = 0;
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  const W = 720, H = 400;
  const RED = 'var(--eos)';
  const LIS = 'var(--gen)', MOD = 'var(--accent)';
  const REST_FILL = '#f6f4ee';

</script>

<figure class="viz">
  <div class="canvas">
    <svg viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Full duplex, step {step + 1}">
      <defs>
        {#each [['fd-arrow', '#b8b4aa'], ['fd-arrow-fg', 'var(--fg)'], ['fd-arrow-mod', 'var(--accent)'], ['fd-arrow-gen', 'var(--gen)']] as [id, c]}
          <marker {id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={c} />
          </marker>
        {/each}
      </defs>

      {#if cur.scene === 'duplex'}
        {@const ts = t / 1000}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">turn-based or full duplex · who decides when the model talks</text>
          {#each [
            { t: 'TURN-BASED · A VAD DECIDES', rule: `by rule: ${VAD_MS} ms of silence ends a turn, and any speech stops a reply`, y: 70, model: TURNS, full: false },
            { t: 'FULL DUPLEX · THE MODEL DECIDES', rule: 'MiniCPM-o 4.5, once a second, from what it has heard', y: 178, model: DUPLEX, full: true },
          ] as p}
            <text x="16" y={p.y} class="boxtitle">{p.t}</text>
            <text x={p.full ? 262 : 214} y={p.y} class="tag">{p.rule}</text>
            {#each [{ n: 'the listener', y: p.y + 10, segs: LISTENER, c: LIS }, { n: 'the model', y: p.y + 38, segs: p.model, c: MOD }] as r}
              <text x="16" y={r.y + 15} class="tag strong">{r.n}</text>
              <rect x={DX0} y={r.y} width={DUPLEX_S * DPX} height="22" rx="4" fill="#fbfaf7" stroke="var(--line)" />
              {#each r.segs as sg}
                {@const w = clamp(ts - sg.a, 0, sg.b - sg.a) * DPX}
                {#if w > 0}<rect x={dx(sg.a)} y={r.y} width={w} height="22" rx="4" fill={r.c} opacity="0.8" />{/if}
                {#if sg.n}<text x={dx((sg.a + sg.b) / 2)} y={r.y + 15} text-anchor="middle" class="steplabel" style:opacity={ts >= Math.min(sg.b - 0.2, (sg.a + sg.b) / 2 + 0.8) ? 1 : 0} style="transition: opacity 200ms">{sg.n}</text>{/if}
              {/each}
            {/each}
            {#if !p.full}
              <!-- the VAD: each stretch of silence it waits out, and the replies it stops -->
              {#each SILENT as s}
                <g style:opacity={ts >= s.a ? 1 : 0} style="transition: opacity 200ms">
                  <rect x={dx(s.a) + 1} y={p.y + 12} width={(s.b - s.a) * DPX - 2} height="18" rx="3" fill="#ebe8e0" />
                  <text x={dx((s.a + s.b) / 2)} y={p.y + 25} text-anchor="middle" class="tag">{VAD_MS} ms</text>
                </g>
              {/each}
              {#each TURNS.filter((r) => r.cut) as r}
                <line x1={dx(r.b)} y1={p.y + 34} x2={dx(r.b)} y2={p.y + 64} stroke={RED} stroke-width="2" style:opacity={ts >= r.b ? 1 : 0} />
              {/each}
              <text x={dx(TURNS[0].a)} y={p.y + 76} class="tag strong" style:fill={RED} style:opacity={ts >= TURNS[0].b ? 1 : 0} style="transition: opacity 250ms">half the question</text>
              <text x={dx(TURNS[1].a)} y={p.y + 76} class="tag strong" style:fill={RED} style:opacity={ts >= TURNS[1].b ? 1 : 0} style="transition: opacity 250ms">stopped by “mm-hm”</text>
            {:else}
              <!-- one decision a second: listen or speak -->
              <text x="16" y={p.y + 79} class="tag strong">decides, each second</text>
              {#each Array.from({ length: DUPLEX_S }) as _, k}
                {@const sp = k >= SPEAK_FROM}
                <g style:opacity={ts >= k ? 1 : 0} style="transition: opacity 200ms">
                  <rect x={dx(k) + 2} y={p.y + 66} width={DPX - 4} height="18" rx="3" fill={sp ? 'var(--accent-soft)' : REST_FILL} stroke={sp ? MOD : 'var(--line)'} />
                  <text x={dx(k) + DPX / 2} y={p.y + 79} text-anchor="middle" class="tag strong" style:fill={sp ? MOD : 'var(--muted)'}>{sp ? 'speak' : 'listen'}</text>
                </g>
              {/each}
              <text x={dx(1.4)} y={p.y + 100} class="tag strong" style:fill={MOD} style:opacity={ts >= 3 ? 1 : 0} style="transition: opacity 250ms">listens through the pause</text>
              <text x={dx(LISTENER[2].a)} y={p.y + 100} class="tag strong" style:fill={MOD} style:opacity={ts >= LISTENER[2].b ? 1 : 0} style="transition: opacity 250ms">hears “mm-hm”, keeps talking</text>
            {/if}
            <!-- now -->
            <line x1={dx(ts)} y1={p.y + 6} x2={dx(ts)} y2={p.y + (p.full ? 86 : 64)} stroke="var(--fg)" opacity="0.35" />
          {/each}
          {#each [0, 2, 4, 6, 8, 10] as s}<text x={dx(s)} y="306" text-anchor="middle" class="tag">{s} s</text>{/each}
          <line x1={DX0} y1="294" x2={dx(DUPLEX_S)} y2="294" stroke="var(--faint)" marker-end="url(#fd-arrow)" />
          <g in:fade={{ delay: 300 }}>
            <text x="18" y="330" class="pt">·</text><text x="28" y="330" class="legend">a VAD hears only whether someone is speaking: a pause ends the turn, and “mm-hm” stops the reply</text>
            <text x="18" y="347" class="pt">·</text><text x="28" y="347" class="legend">a full-duplex model hears the words while it speaks, and decides from them whether to listen or speak</text>
          </g>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">amber: the listener · blue: the model · grey: the {VAD_MS} ms of silence the VAD waits for · red: a reply stopped · times illustrative</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">SGLang-Omni serves Qwen3-Omni turn-based with a Silero VAD in front; MiniCPM-o 4.5 decides every 1 s, PersonaPlex every 80 ms</text>
        </g>
      {/if}

      {#if cur.scene === 'units'}
        {@const k = Math.min(UNITS_SHOWN - 1, Math.floor(t / UNIT_MS))}
        {@const local = t - k * UNIT_MS}
        {@const hop = clamp(Math.floor((local - 300) / HOP_MS), -1, STAGES.length)}
        {@const UX0 = 150}
        {@const UPX = 64}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">a conversation as units · the listener's audio, a second at a time</text>
          <!-- the incoming audio, cut into units -->
          <text x="16" y="88" class="tag strong">the listener</text>
          {#each Array.from({ length: 8 }) as _, u}
            <rect x={UX0 + u * UPX + 1} y="74" width={UPX - 2} height="22" rx="3" fill={u === k ? LIS : 'var(--gen-soft)'} stroke="var(--gen)" opacity={u <= k ? 1 : 0.4} />
            <text x={UX0 + u * UPX + UPX / 2} y="89" text-anchor="middle" class="tag strong" style:fill={u === k ? 'white' : 'var(--fg)'}>unit {u + 1}</text>
          {/each}
          <text x={UX0 + 8 * UPX + 6} y="89" class="tag">1 s each</text>

          <!-- the four stages; the current unit hops through them -->
          {#each STAGES as sg, i}
            {@const x0 = 150 + i * 140}
            <rect x={x0} y="140" width="112" height="34" rx="7" fill={hop === i ? 'var(--accent-soft)' : 'white'} stroke={hop === i ? MOD : 'var(--fg)'} stroke-width={hop === i ? 2 : 1} />
            <text x={x0 + 56} y="161" text-anchor="middle" class="mono strong">{sg.n}</text>
            <text x={x0 + 56} y="190" text-anchor="middle" class="tag">Qwen3-Omni: {sg.q}</text>
            {#if i < STAGES.length - 1}<line x1={x0 + 114} y1="157" x2={x0 + 138} y2="157" stroke="var(--faint)" marker-end="url(#fd-arrow)" />{/if}
          {/each}
          <path d="M {UX0 + k * UPX + UPX / 2} 98 V 116 H 206 V 137" fill="none" stroke="var(--gen)" stroke-dasharray="3 2" marker-end="url(#fd-arrow-gen)" />
          <text x="16" y="161" class="tag strong">unit {k + 1}, as a request</text>

          <!-- what comes back for each unit: sound or silence -->
          <text x="16" y="246" class="tag strong">the model</text>
          {#each Array.from({ length: 8 }) as _, u}
            {@const done = u < k || (u === k && hop >= STAGES.length)}
            <rect x={UX0 + u * UPX + 1} y="232" width={UPX - 2} height="22" rx="3" fill={done && SPEAKS[u] ? MOD : REST_FILL} stroke={done ? (SPEAKS[u] ? MOD : 'var(--line)') : 'var(--line)'} opacity={done ? 0.85 : 0.35} />
            {#if done}<text x={UX0 + u * UPX + UPX / 2} y="247" text-anchor="middle" class="tag strong" style:fill={SPEAKS[u] ? 'white' : 'var(--muted)'}>{SPEAKS[u] ? 'speaks' : 'listens'}</text>{/if}
          {/each}
          <path d="M 684 157 H 702 V 212 H {UX0 + k * UPX + UPX / 2} V 229" fill="none" stroke={MOD} stroke-dasharray="3 2" marker-end="url(#fd-arrow-mod)" style:opacity={hop >= STAGES.length ? 1 : 0} />
          <text x="16" y="292" class="legend strong">requests so far, through every stage: {k + (hop >= STAGES.length ? 1 : 0)}</text>

          <g in:fade={{ delay: 300 }}>
            <text x="18" y="322" class="pt">·</text><text x="28" y="322" class="legend">each unit goes through all four stages, and what comes back is a second of sound or of silence</text>
            <text x="18" y="339" class="pt">·</text><text x="28" y="339" class="legend">the listener keeps talking while it does: unit {k + 2} is already arriving</text>
          </g>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">MiniCPM-o 4.5's stages beside Qwen3-Omni's (Ch. {CH_STAGES} Step 4): perception holds its audio and image encoders, speech its vocoder</text>
        </g>
      {/if}

      {#if cur.scene === 'forget'}
        {@const k = Math.min(2, Math.floor(t / FORGET_MS))}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">what a request is · everything it needs comes with it, and it is forgotten at its end</text>
          <text x="16" y="92" class="tag strong">the request</text>
          <text x="16" y="160" class="tag strong">the thinker's</text>
          <text x="16" y="174" class="tag strong">KV cache</text>
          <text x="16" y="226" class="tag strong">what it knows</text>
          {#each [0, 1, 2] as i}
            {@const x0 = 150 + i * 186}
            {@const local = t - i * FORGET_MS}
            {@const on = local >= 0}
            {@const fill = clamp(local / RUN_MS, 0, 1)}
            {@const freed = local >= RUN_MS}
            <g style:opacity={on ? (i < k ? 0.55 : 1) : 0} style="transition: opacity 250ms">
              <rect x={x0} y="76" width="166" height="26" rx="6" fill="var(--gen-soft)" stroke="var(--gen)" />
              <text x={x0 + 83} y="93" text-anchor="middle" class="tag strong">unit {i + 1}: its 1 s of audio</text>
              <line x1={x0 + 83} y1="104" x2={x0 + 83} y2="122" stroke="var(--faint)" marker-end="url(#fd-arrow)" />
              <rect x={x0} y="126" width="166" height="62" rx="6" fill="white" stroke="var(--fg)" />
              <rect x={x0 + 6} y={182 - fill * 50} width="154" height={fill * 50} rx="3" fill={LIS} opacity={freed ? 0.12 : 0.75} style="transition: opacity 400ms" />
              <text x={x0 + 83} y="162" text-anchor="middle" class="tag strong" style:fill={freed ? RED : 'white'} style:opacity={fill > 0.5 ? 1 : 0}>{freed ? 'freed at the end' : `unit ${i + 1}'s tokens`}</text>
              <text x={x0 + 83} y="226" text-anchor="middle" class="tag strong">{i === 0 ? 'unit 1 only' : `unit ${i + 1} only: nothing`}</text>
              {#if i > 0}<text x={x0 + 83} y="240" text-anchor="middle" class="tag strong" style:fill={RED}>of unit {i === 1 ? '1' : '1 or 2'}</text>{/if}
            </g>
          {/each}
          <g in:fade={{ delay: 300 }}>
            <text x="18" y="290" class="pt">·</text><text x="28" y="290" class="legend">a request carries everything it needs, and each stage frees what it built for it when it ends</text>
            <text x="18" y="307" class="pt">·</text><text x="28" y="307" class="legend">a full-duplex model's request is one unit: 1 s of audio for MiniCPM-o, 80 ms for PersonaPlex</text>
          </g>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">the talker's KV cache and the running state of perception and of the vocoder are freed the same way</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">Ch. {CH_PREFIX} Step 6's prefix cache reuses a resent text history; audio enters as embeddings it cannot match, and it can evict (Ch. {CH_PREFIX} Step 7)</text>
        </g>
      {/if}

      {#if cur.scene === 'session'}
        {@const OPS = ['open', 'append 1', 'append 2', 'append 3', 'close']}
        {@const opIdx = t < APPEND_AT ? 0 : t < CLOSE_AT ? 1 + Math.floor((t - APPEND_AT) / HOLD) : 4}
        {@const appended = t < APPEND_AT ? 0 : Math.min(3, Math.floor((t - APPEND_AT) / HOLD) + 1)}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">a session · one conversation the server keeps open</text>
          <text x="16" y="88" class="tag strong">the client</text>
          {#each OPS as o, i}
            <rect x={150 + i * 108} y="74" width="98" height="22" rx="11" fill={i === opIdx ? 'var(--fg)' : 'white'} stroke="var(--fg)" opacity={i <= opIdx ? 1 : 0.35} />
            <text x={199 + i * 108} y="89" text-anchor="middle" class="tag strong" style:fill={i === opIdx ? 'white' : 'var(--fg)'}>{o}</text>
          {/each}
          <text x="16" y="141" class="tag strong">the stages</text>
          <text x="16" y="194" class="tag strong">the session's</text>
          <text x="16" y="208" class="tag strong">state, per stage</text>
          {#each STAGES as sg, i}
            {@const x0 = 150 + i * 140}
            {@const exists = t >= OPEN_AT + i * STAGGER && t < CLOSE_AT + (3 - i) * STAGGER}
            {@const unitAt = APPEND_AT + (appended - 1) * HOLD}
            {@const levels = appended === 0 ? 0 : appended - 1 + (t >= unitAt + i * HOP ? 1 : 0)}
            <rect x={x0} y="124" width="112" height="28" rx="6" fill="white" stroke="var(--fg)" />
            <text x={x0 + 56} y="142" text-anchor="middle" class="mono strong">{sg.n}</text>
            <rect x={x0} y="168" width="112" height="50" rx="6" fill={exists ? 'var(--accent-soft)' : 'white'} stroke={exists ? MOD : 'var(--faint)'} stroke-dasharray={exists ? '' : '3 3'} style="transition: fill 250ms" />
            {#if exists}
              {#each Array.from({ length: levels }) as _, l}<rect x={x0 + 8} y={193 - (levels * 11 - 2) / 2 + l * 11} width="96" height="9" rx="2" fill={MOD} opacity="0.55" />{/each}
            {/if}
            <text x={x0 + 56} y="232" text-anchor="middle" class={exists ? 'tag strong' : 'tag'} style:fill={exists ? MOD : 'var(--muted)'}>{exists ? sg.keeps : 'no state'}</text>
            {#if i < STAGES.length - 1}<line x1={x0 + 114} y1="138" x2={x0 + 138} y2="138" stroke="var(--faint)" marker-end="url(#fd-arrow)" />{/if}
          {/each}
          {#if t >= APPEND_AT && t < CLOSE_AT && (t - APPEND_AT) % HOLD < 4 * HOP}
            {@const at = Math.floor(((t - APPEND_AT) % HOLD) / HOP)}
            <rect x={150 + at * 140 + 36} y="114" width="40" height="14" rx="3" fill={LIS} />
            <text x={150 + at * 140 + 56} y="125" text-anchor="middle" class="steplabel">unit {appended}</text>
          {/if}
          <rect x="16" y="252" width="688" height="30" rx="6" fill="#fbfaf7" stroke="var(--line)" />
          <text x="30" y="272" class="legend strong">now: {sessionStatus(t)}</text>
          <text x="16" y="314" class="legend" in:fade={{ delay: 400 }}>each append prefills only its own unit; the units before it are already in the thinker's KV cache</text>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">blue: a stage's state for this session, a stripe per unit, named under it</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">open runs upstream first and close downstream first, so no stage gets a unit its upstream has not opened for</text>
        </g>
      {/if}

      {#if cur.scene === 'needs'}
        {@const PW = 220}
        {@const px = (k: number) => 16 + k * (PW + 14)}
        {@const bx = px(2) + 22}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">what a session needs from the server · three parts, all needed at once</text>
          {#each [
            { h: '1 · IN EACH STAGE', say: ['one state per open session, and', 'each unit\'s work goes into its', 'own session\'s state'], link: 'session hooks · step 6' },
            { h: '2 · ON THE WAY IN', say: ['units keep arriving while earlier', 'ones run; each goes in only after', 'the unit before it is done'], link: 'one at a time · step 7' },
            { h: '3 · ON THE GPU', say: ['a session\'s state stays on the GPU', 'from open to close, so memory caps', 'how many sessions run at once'], link: 'memory · step 8' },
          ] as c, k}
            {@const x0 = px(k)}
            <g in:fade={{ delay: 150 + k * 350, duration: 300 }}>
              <rect x={x0} y="58" width={PW} height="252" rx="10" fill="#fbfaf7" stroke="var(--line)" />
              <text x={x0 + 12} y="78" class="boxtitle">{c.h}</text>
              {#each c.say as line, l}<text x={x0 + 12} y={234 + l * 15} class="tag strong">{line}</text>{/each}
              <text x={x0 + 12} y="292" class="tag strong" style:fill={MOD}>{c.link}</text>
            </g>
          {/each}

          <!-- 1: one stage, a state per session; a unit goes into its own session's -->
          <g in:fade={{ delay: 150, duration: 300 }}>
            <rect x={px(0) + 50} y="88" width="120" height="18" rx="3" fill={LIS} />
            <text x={px(0) + 110} y="101" text-anchor="middle" class="steplabel">unit 2 of session A</text>
            <rect x={px(0) + 12} y="116" width={PW - 24} height="92" rx="7" fill="white" stroke="var(--fg)" />
            <text x={px(0) + 22} y="132" class="mono strong">thinker</text>
            {#each ['session A', 'session B'] as v, j}
              <rect x={px(0) + 22} y={140 + j * 32} width={PW - 44} height="26" rx="4" fill="var(--accent-soft)" stroke={MOD} />
              <text x={px(0) + PW / 2} y={157 + j * 32} text-anchor="middle" class="tag strong" style:fill={MOD}>{v}'s state</text>
            {/each}
            <line x1={px(0) + 170} y1="97" x2={px(0) + 176} y2="97" stroke="var(--gen)" />
            <path d="M {px(0) + 176} 97 V 136" fill="none" stroke="var(--gen)" marker-end="url(#fd-arrow)" />
          </g>

          <!-- 2: the coordinator holds session A's later units until the one before is done -->
          <g in:fade={{ delay: 500, duration: 300 }}>
            <rect x={px(1) + 12} y="86" width={PW - 24} height="50" rx="6" fill="white" stroke="var(--fg)" />
            <text x={px(1) + 22} y="102" class="tag strong">the server</text>
            {#each [3, 4] as u, j}
              <rect x={px(1) + 22 + j * 52} y="110" width="46" height="18" rx="3" fill="var(--gen-soft)" stroke="var(--gen)" />
              <text x={px(1) + 45 + j * 52} y="123" text-anchor="middle" class="tag strong">unit {u}</text>
            {/each}
            <text x={px(1) + 128} y="123" class="tag">waiting</text>
            <line x1={px(1) + 45} y1="138" x2={px(1) + 45} y2="154" stroke="var(--gen)" marker-end="url(#fd-arrow)" />
            <rect x={px(1) + 12} y="158" width={PW - 24} height="50" rx="6" fill="white" stroke="var(--fg)" />
            <text x={px(1) + 22} y="174" class="mono strong">thinker</text>
            <rect x={px(1) + 22} y="182" width="46" height="18" rx="3" fill={LIS} />
            <text x={px(1) + 45} y="195" text-anchor="middle" class="steplabel">unit 2</text>
            <line x1={px(1) + 72} y1="191" x2={px(1) + 92} y2="191" stroke="var(--gen)" marker-end="url(#fd-arrow)" />
            <rect x={px(1) + 96} y="182" width="100" height="18" rx="3" fill="var(--accent-soft)" stroke={MOD} />
            <text x={px(1) + 146} y="195" text-anchor="middle" class="tag strong" style:fill={MOD}>A's state</text>
          </g>

          <!-- 3: a session's state grows with every unit and is held until close -->
          <g in:fade={{ delay: 850, duration: 300 }}>
            <text x={bx} y="100" class="tag strong">session A's state on the GPU</text>
            <line x1={bx} y1="200" x2={bx + 172} y2="200" stroke="var(--faint)" marker-end="url(#fd-arrow)" />
            {#each Array.from({ length: 6 }) as _, u}
              <rect x={bx + 4 + u * 20} y={198 - (u + 1) * 13} width="16" height={(u + 1) * 13} rx="2" fill="var(--accent-soft)" stroke={MOD} />
            {/each}
            <line x1={bx + 130} y1="108" x2={bx + 130} y2="198" stroke={RED} stroke-dasharray="3 2" />
            <text x={bx + 136} y="150" class="tag strong" style:fill={RED}>close:</text>
            <text x={bx + 136} y="164" class="tag strong" style:fill={RED}>freed</text>
            <text x={bx} y="214" class="tag">units 1 to 6 of the call →</text>
          </g>
        </g>
      {/if}

      {#if cur.scene === 'hooks'}
        {@const h = Math.min(HOOKS.length - 1, Math.floor(t / HOOK_MS))}
        {@const op = HOOKS[h]}
        {@const fired = hookDone(t, h)}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">what a session needs · 1 of 3 · in each stage, a hook per operation</text>
          <!-- the request: an ordinary one, with the session's operation in its metadata -->
          {#key h}
            <g in:fade={{ duration: 400 }}>
              <rect x="16" y="74" width="190" height="190" rx="8" fill="#fbfaf7" stroke="var(--fg)" />
              <text x="28" y="94" class="boxtitle">A REQUEST</text>
              <text x="28" y="120" class="tag strong">data:</text>
              {#if op.op === 'append'}
                <rect x="60" y="108" width="46" height="18" rx="3" fill={LIS} />
                <text x="83" y="121" text-anchor="middle" class="steplabel">unit 3</text>
              {:else}
                <text x="60" y="120" class="tag">none</text>
              {/if}
              <text x="28" y="148" class="tag strong">metadata:</text>
              <rect x="28" y="156" width="166" height="58" rx="6" fill="white" stroke="var(--fg)" />
              <text x="38" y="178" class="mono strong">omni_session</text>
              <text x="38" y="198" class="tag strong">{op.op}, session {op.s}</text>
            </g>
          {/key}
          <line x1="208" y1="169" x2="222" y2="169" stroke="var(--fg)" marker-end="url(#fd-arrow-fg)" />
          <!-- the stage: a hook per operation, a state per open session -->
          <rect x="226" y="74" width="478" height="190" rx="8" fill="white" stroke="var(--fg)" />
          <text x="240" y="94" class="mono strong">thinker</text>
          <text x="300" y="94" class="tag">reads the tag and calls that hook</text>
          <text x="240" y="118" class="boxtitle">ITS HOOKS</text>
          <text x="420" y="118" class="boxtitle">ITS STATE, PER SESSION</text>
          {#each HOOKS as o, i}
            {@const live = i === h && fired}
            <rect x="240" y={128 + i * 44} width="164" height="32" rx="5" fill={live ? 'var(--fg)' : 'white'} stroke={live ? 'var(--fg)' : 'var(--line)'} style="transition: fill 250ms" />
            <text x="250" y={148 + i * 44} class="mono strong" style:fill={live ? 'white' : 'var(--fg)'}>{o.op}</text>
            <text x="310" y={148 + i * 44} class="tag strong" style:fill={live ? 'white' : 'var(--fg)'}>{o.does}</text>
          {/each}
          {#each sessionsAt(t) as st, j}
            {@const y = 128 + j * 44}
            {@const hit = fired && op.s === st.s}
            {#if st.on}
              <rect x="420" y={y} width="270" height="32" rx="5" fill="var(--accent-soft)" stroke={MOD} stroke-width={hit ? 2.4 : 1} />
              <text x="430" y={y + 20} class="tag strong" style:fill={MOD}>session {st.s}'s state</text>
              {#each Array.from({ length: st.units }) as _, k}<rect x={540 + k * 14} y={y + 8} width="10" height="16" rx="2" fill={MOD} opacity="0.55" />{/each}
              <text x="680" y={y + 20} text-anchor="end" class="tag strong" style:fill={MOD}>{st.units ? `units 1–${st.units}` : 'empty'}</text>
            {:else if st.s === 'B'}
              <rect x="420" y={y} width="270" height="32" rx="5" fill="white" stroke={RED} stroke-dasharray="3 3" />
              <text x="430" y={y + 20} class="tag strong" style:fill={RED}>session B's state: freed</text>
            {/if}
          {/each}
          <rect x="16" y="286" width="688" height="30" rx="6" fill="#fbfaf7" stroke="var(--line)" />
          <text x="30" y="306" class="legend strong">now: {fired ? op.now : `a request tagged ${op.op}, session ${op.s} arrives`}</text>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">two more hooks: control, for an event such as an interrupt, and usage, the bytes a session's state holds</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">SGLang-Omni: SessionHooks (scheduling/session.py); the thinker and talker run theirs inside SGLang's own loop (Ch. {CH_STAGES} Step 9)</text>
        </g>
      {/if}

      {#if cur.scene === 'queue'}
        {@const ts = t / 1000}
        {@const QX0 = 150}
        {@const QPX = 46}
        {@const qx = (s: number) => QX0 + s * QPX}
        {@const units = Array.from({ length: QUEUE_S }, (_, i) => i + 1)}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">what a session needs · 2 of 3 · on the way in, one unit at a time</text>
          {#each PACES as p, pi}
            {@const y0 = 74 + pi * 104}
            <text x="16" y={y0} class="boxtitle">{p.t}</text>
            <text x="16" y={y0 + 25} class="tag strong">the listener</text>
            <text x="16" y={y0 + 67} class="tag strong">the four stages</text>
            <rect x={QX0} y={y0 + 10} width={QUEUE_S * QPX} height="22" rx="4" fill="#fbfaf7" stroke="var(--line)" />
            <rect x={QX0} y={y0 + 52} width={QUEUE_S * QPX} height="22" rx="4" fill="#fbfaf7" stroke="var(--line)" />
            {#each units as k}
              {@const heard = clamp(ts - (k - 1) * UNIT_S, 0, UNIT_S)}
              {@const s0 = startOf(k, p.d)}
              {@const ran = clamp(ts - s0, 0, p.d)}
              {#if heard > 0}
                {@const held = heard >= UNIT_S && ts < s0}
                <rect x={qx(k - 1) + 1} y={y0 + 10} width={heard * QPX - 2} height="22" rx="3" fill={held ? LIS : 'var(--gen-soft)'} stroke="var(--gen)" />
                {#if heard >= UNIT_S}<text x={qx(k - 0.5)} y={y0 + 25} text-anchor="middle" class={held ? 'steplabel' : 'tag strong'}>{k}</text>{/if}
              {/if}
              {#if ran > 0}
                <line x1={qx(k)} y1={y0 + 33} x2={qx(s0)} y2={y0 + 51} stroke="var(--gen)" stroke-dasharray="2 2" />
                <rect x={qx(s0) + 1} y={y0 + 52} width={Math.max(0, ran * QPX - 2)} height="22" rx="3" fill="var(--fg)" opacity="0.72" />
                {#if ran * QPX >= 14}<text x={qx(s0 + ran / 2)} y={y0 + 67} text-anchor="middle" class="steplabel">{k}</text>{/if}
              {/if}
            {/each}
          {/each}
          {#each [0, 2, 4, 6, 8, 10, 12] as s}<text x={qx(s)} y="286" text-anchor="middle" class="tag">{s} s</text>{/each}
          <line x1={QX0} y1="272" x2={qx(QUEUE_S) + 6} y2="272" stroke="var(--faint)" marker-end="url(#fd-arrow)" />
          <g in:fade={{ delay: 300 }}>
            <text x="18" y="318" class="pt">·</text><text x="28" y="318" class="legend">at {PACES[1].d} s a unit, one more second of audio is left waiting every {PACES[1].d / (PACES[1].d - UNIT_S)} s, and each unit starts later than the last</text>
            <text x="18" y="335" class="pt">·</text><text x="28" y="335" class="legend">after about {Math.round(REJECT_S / 60)} minutes, {MAX_WAITING_S} s of audio is waiting, the most the server holds, and it rejects new audio</text>
          </g>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">light amber: audio being said or already sent in · solid amber: a unit still waiting · dark: a unit in the four stages</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">times illustrative · SGLang-Omni: the realtime session's pump (serve/realtime/runtime.py), then the coordinator's (Ch. {CH_BETWEEN} Step 10)</text>
        </g>
      {/if}

      {#if cur.scene === 'closing'}
        {@const BX = 150}
        {@const px = 540 / HBM_GB}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">what a session needs · 3 of 3 · on the GPU, its KV cache for the whole call</text>
          <text x="16" y="88" class="tag strong">one call</text>
          <text x="150" y="80" class="tag strong">{CALL_MIN} min of listening × {POS_PER_S} positions a second × {KV_KB} KB = {f1(CALL_KV_GB)} GB</text>
          <text x="150" y="95" class="tag">in Qwen3-Omni's thinker's KV cache alone, held until the call ends</text>
          <text x="16" y="146" class="tag strong">GPU 0, an H100</text>
          <text x="16" y="160" class="tag">{HBM_GB} GB</text>
          <rect x={BX - 3} y="131" width={HBM_GB * px + 6} height="34" rx="6" fill="#fbfaf7" stroke="var(--fg)" />
          <rect x={BX} y="136" width={GPU0_W * px} height="24" rx="3" fill="var(--fg)" opacity="0.72" />
          <text x={BX + 8} y="152" class="steplabel">weights {f1(GPU0_W)} GB</text>
          {#each Array.from({ length: CALLS_FIT }) as _, c}
            <rect x={BX + (GPU0_W + c * CALL_KV_GB) * px + 1} y="136" width={CALL_KV_GB * px - 2} height="24" rx="2" fill={MOD} opacity="0.7" />
          {/each}
          <path d="M {BX + GPU0_W * px} 172 V 178 H {BX + (GPU0_W + CALLS_FIT * CALL_KV_GB) * px} V 172" fill="none" stroke={MOD} />
          <text x={BX + (GPU0_W + CALLS_FIT * CALL_KV_GB) * px} y="194" text-anchor="end" class="tag strong" style:fill={MOD}>{CALLS_FIT} calls × {f1(CALL_KV_GB)} GB fill the rest</text>
          <path d="M {BX} 172 V 178 H {BX + GPU0_W * px - 4} V 172" fill="none" stroke="var(--fg)" />
          <text x={BX} y="194" class="tag strong">GPU 0's weights in the default layout (Ch. {CH_GPUS} Step 1)</text>
          <g in:fade={{ delay: 400 }}>
            <text x="18" y="244" class="pt">·</text><text x="28" y="244" class="legend">a session's KV cache grows with every unit and is freed only when the session closes</text>
            <text x="18" y="261" class="pt">·</text><text x="28" y="261" class="legend">MiniCPM-o reserves room for full-length sessions up front: 2 by default (max_sessions)</text>
          </g>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">{POS_PER_S} positions a second of audio (Ch. {CH_OMNI} Step 2) · {KV_KB} KB a token (Ch. {CH_GPUS} Step 4) · fewer in practice, as working memory takes part of the rest</text>
        </g>
      {/if}
      {#if ANIM[cur.scene] && !ANIM[cur.scene]?.[2]}<LoopProgress ms={lapMs} {lap} />{/if}
    </svg>
  </div>

  <StepControls {step} total={steps.length} caption={cur.caption} {prev} {next} onchange={(s) => (step = s)} />
</figure>
