<script lang="ts">
  import { untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import StepControls from '../StepControls.svelte';
  import LoopProgress from '../LoopProgress.svelte';
  import { chapterNumber as chNum, type NavLink } from '../../chapters';
  import { SAMPLES_PER_FRAME, SPEECH_OUT_HZ, CODES_PER_FRAME } from '../../numbers';
  let { prev, next }: { prev?: NavLink; next?: NavLink } = $props();

  const CH_PROC = chNum('09-one-request'), CH_OMNI = chNum('16-omni-models'), CH_STAGES = chNum('17-stages-and-schedulers'), CH_BETWEEN = chNum('18-between-stages');
  const fmt = (n: number) => n.toLocaleString('en-US');

  // chapter 16's sound: frames of 80 ms, 16 codes each, turned into sound 10 frames at a time
  const FRAME_MS = (SAMPLES_PER_FRAME / SPEECH_OUT_HZ) * 1000;     // 80
  const CHUNK = 10;                                                // frames per code2wav window (stream_chunk_size)
  const CHUNK_MS = CHUNK * FRAME_MS;                               // 800
  const LEFT = 25;                                                 // earlier frames each window rereads (left_context_size)
  const STEPS = CODES_PER_FRAME;                                   // a frame: 1 talker step + 15 code predictor steps
  const STEP_MS = FRAME_MS / STEPS;                                // 5
  const ANSWER_FRAMES = (20 * 1000) / FRAME_MS;                    // chapter 16's 20 s answer: 250 frames
  const SMALL_FIRST_N = 4;                                         // the first window proposed in PR #2800

  type Scene = 'gap' | 'whole' | 'stream' | 'inside' | 'seam' | 'size';
  const steps: { scene: Scene; caption: string }[] = [
    { scene: 'gap', caption: `The player plays each chunk the moment the one before it ends. If the next has not arrived, the sound stops. Two things matter: how soon the first sound comes, and whether a gap ever opens.` },
    { scene: 'whole', caption: `The simplest decoder waits for the whole answer: all ${ANSWER_FRAMES} frames, then one call to code2wav. Nothing can play before that, so the listener sits through the whole generation in silence.` },
    { scene: 'stream', caption: `A streaming decoder runs as frames come in. Every ${CHUNK} frames, code2wav sends ${CHUNK_MS} ms of sound. While chunk 1 plays, the talker writes the next ${CHUNK}, so chunk 2 is ready before chunk 1 ends.` },
    { scene: 'inside', caption: `code2wav runs the streaming scheduler of Ch. ${CH_STAGES} Step 11. For each request it keeps the frames so far and how many it has sent. At ${CHUNK} new frames it decodes and sends; when the talker is done, it sends the rest.` },
    { scene: 'seam', caption: `Each moment of code2wav's sound depends on the frames before it, and code2wav keeps nothing between windows. So each window takes the frames before it again, up to ${LEFT}, and keeps only the new sound.` },
    { scene: 'size', caption: `Smaller chunks bring the first sound sooner, but each frame then gets decoded more times, since every window rereads the ${LEFT} before it. SGLang-Omni uses ${CHUNK}; a smaller first window gets both.` },
  ];

  let step = $state(0);
  $effect(() => {
    const q = Number(new URLSearchParams(window.location.search).get('step'));
    if (q >= 1 && q <= steps.length) step = q - 1;
  });
  const cur = $derived(steps[step]);

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  const W = 720, H = 400;
  const RED = 'var(--eos)';
  const TLK = 'var(--accent)', C2W = '#57534e';
  const REST_FILL = '#f6f4ee', PLAYED = '#e3ded3';

  // step 1: one timeline per case, chunks played back to back from when each arrives
  const TX0 = 150, MSPX = 0.165;
  const tx = (ms: number) => TX0 + ms * MSPX;
  const play = (ready: number[]) => { let end = 0; return ready.map((a, i) => { const s = i === 0 ? a : Math.max(a, end); const gap = i === 0 ? 0 : Math.max(0, a - end); end = s + CHUNK_MS; return { a, s, e: end, gap }; }); };
  const CASES = [
    { t: 'ON TIME', y: 84, chunks: play([450, 1000, 1700]) },
    { t: 'ONE CHUNK LATE', y: 212, chunks: play([450, 1550, 2150]) },
  ];

  // steps 2 and 3: the same three rows over the same 4 s. The talker writes a frame every 40 ms here
  // (twice real time) after 200 ms of getting going; code2wav's call is drawn as 40 ms.
  const SPAN = 4000, PX2 = 540 / SPAN, GEN_MS = 40, T0 = 200, DEC_MS = 40;
  const sx = (ms: number) => 150 + ms * PX2;
  const GROUPS = Math.ceil((SPAN - T0) / (CHUNK * GEN_MS));
  const group = (g: number) => ({ a: T0 + g * CHUNK * GEN_MS, b: T0 + (g + 1) * CHUNK * GEN_MS });
  const decodes = Array.from({ length: GROUPS }, (_, g) => ({ a: group(g).b, b: group(g).b + DEC_MS })).filter((d) => d.a < SPAN);
  const streamChunks = play(decodes.map((d) => d.b)).filter((c) => c.s < SPAN);
  const WHOLE_FIRST = T0 + ANSWER_FRAMES * GEN_MS + DEC_MS;       // when the first sound would come without streaming
  const RY = { talker: 96, c2w: 156, player: 216 };

  // step 4: a stand-in for code2wav's sound, so a seam can be seen. Decoded alone, chunk 2's first frames miss
  // the frames before them, drawn as an offset that fades over its first frames.
  const wave = (f: number) => 0.55 * Math.sin(f * 1.9) + 0.3 * Math.sin(f * 4.7 + 1) + 0.15 * Math.sin(f * 9.3 + 2);
  const alone = (f: number) => 1.1 * Math.exp(-(f - CHUNK) / 1.3);
  const FX0 = 150, FPX = 18;
  const fx = (f: number) => FX0 + f * FPX;
  const wavePath = (f0: number, f1: number, mid: number, off: (f: number) => number = () => 0) => {
    const pts: string[] = [];
    for (let f = f0; f <= f1 + 1e-9; f += 0.1) pts.push(`${fx(f).toFixed(1)},${(mid - 11 * (wave(f) + off(f))).toFixed(1)}`);
    return pts.length > 1 ? 'M ' + pts.join(' L ') : '';
  };
  // the inside step: one request of 34 frames through code2wav's streaming scheduler. The first 10 frames arrive
  // one at a time, then tens, then the last 4 with the talker's done signal (times illustrative)
  const IN_FRAMES = 34;
  // after the first ten frames count in, every status line holds for HOLD ms
  const HOLD = 5000, FIRST10 = 1800 + CHUNK * 300;
  const at = (k: number) => FIRST10 + k * HOLD;              // the start of the k-th held phase
  const IN_ARRIVE = [...Array.from({ length: CHUNK }, (_, i) => 1800 + (i + 1) * 300 - 300), ...Array(CHUNK).fill(at(3)), ...Array(CHUNK).fill(at(6)), ...Array(4).fill(at(9))];
  const IN_DONE = at(10), IN_CLEAR = at(13), IN_SPAN = at(14);
  const IN_DECODES = [{ a: at(1), b: at(2), from: 0, to: 10 }, { a: at(4), b: at(5), from: 10, to: 20 }, { a: at(7), b: at(8), from: 20, to: 30 }, { a: at(11), b: at(12), from: 30, to: 34 }];
  // the animated steps play a stretch of time (span, in ms of the timeline) at half speed, rest, and loop
  const ANIM: Partial<Record<Scene, [number, number]>> = { gap: [3300, 2], whole: [4000, 2], stream: [4000, 2], inside: [IN_SPAN, 1] };
  const REST = 2500;
  let t = $state(0);
  let lap = $state(0), lapMs = $state(0);           // the looping step's laps, for LoopProgress
  const nextLap = (ms: number) => untrack(() => { lapMs = ms; lap++; });   // untracked, so starting a lap does not re-run the effect
  $effect(() => {
    const anim = ANIM[cur.scene];
    if (!anim) return;
    const [span, SLOW] = anim;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { t = span; return; }
    const lapLen = span * SLOW + REST;
    let raf = 0, t0 = 0;
    const tick = (now: number) => {
      if (!t0 || now - t0 >= lapLen) { t0 = now; nextLap(lapLen); }
      t = Math.min(span, (now - t0) / SLOW);
      raf = requestAnimationFrame(tick);
    };
    t = 0;
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });
  const inStatus = (t: number) => {
    const rec = IN_ARRIVE.filter((a) => a <= t).length;
    const sent = IN_DECODES.filter((d) => d.b <= t).reduce((m, d) => Math.max(m, d.to), 0);
    const k = IN_DECODES.findIndex((d) => t >= d.a && t < d.b);
    if (t >= IN_CLEAR) return 'the request is finished: its state is cleared';
    if (k >= 0) { const d = IN_DECODES[k]; return `window ${k + 1}: decode ${Math.min(LEFT, d.from)} earlier + ${d.to - d.from} new frames, then send the new ${(d.to - d.from) * FRAME_MS} ms`; }
    if (t >= IN_DONE && sent < IN_FRAMES) return `the talker is done: decode the last ${IN_FRAMES - sent}, though fewer than ${CHUNK}`;
    if (rec === 0) return "waiting for the talker's first frame";
    if (sent === IN_FRAMES) return `all ${IN_FRAMES} frames sent as sound, in ${IN_DECODES.length} pieces`;
    if (rec === sent) return `sent ${sent * FRAME_MS} ms of sound so far; waiting for the talker's next frames`;
    if (rec - sent >= CHUNK) return `${rec - sent} new frames are in: enough for a window`;
    return `holding ${rec - sent} new frame${rec - sent === 1 ? '' : 's'}, waiting for ${CHUNK}`;
  };

  // step 5: the first sound waits for one chunk; each window decodes up to 25 earlier frames plus the chunk
  const SIZES = [{ n: 2 }, { n: 4 }, { n: CHUNK, def: true }, { n: 20 }, { n: 4, then: CHUNK }].map((r) => ({ ...r, work: (LEFT + (r.then ?? r.n)) / (r.then ?? r.n) }));


</script>

<figure class="viz">
  <div class="canvas">
    <svg viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Streaming audio decode, step {step + 1}">
      <defs>
        {#each [['sa-arrow', '#b8b4aa'], ['sa-arrow-fg', 'var(--fg)']] as [id, c]}
          <marker {id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={c} />
          </marker>
        {/each}
        <pattern id="sa-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="5" height="5" fill="var(--eos-soft)" /><line x1="0" y1="0" x2="0" y2="5" stroke={RED} stroke-width="1.5" />
        </pattern>
      </defs>

      {#if cur.scene === 'gap'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">the deadline · the player plays chunk after chunk, {CHUNK_MS} ms each</text>
          {#each CASES as c, ci}
            <g>
              <text x="16" y={c.y} class="boxtitle">{c.t}</text>
              <text x="16" y={c.y + 30} class="tag strong">chunk arrives</text>
              <text x="16" y={c.y + 66} class="tag strong">the player plays</text>
              <line x1={TX0} y1={c.y + 26} x2={tx(3300)} y2={c.y + 26} stroke="var(--line)" />
              <line x1={TX0} y1={c.y + 18} x2={TX0} y2={c.y + 34} stroke="var(--fg)" />
              <text x={TX0} y={c.y + 12} text-anchor="middle" class="tag">request</text>
              {#each c.chunks as k, i}
                <g style:opacity={t >= k.a ? 1 : 0} style="transition: opacity 200ms">
                  <path d="M {tx(k.a)} {c.y + 19} V {c.y + 32}" stroke="var(--fg)" stroke-width="2" />
                  <text x={tx(k.a)} y={c.y + 14} text-anchor="middle" class="tag strong">{i + 1}</text>
                  {#if k.s > k.a}<line x1={tx(k.a)} y1={c.y + 26} x2={tx(k.s)} y2={c.y + 50} stroke="var(--faint)" stroke-dasharray="2 2" />{/if}
                  <rect x={tx(k.s) + 1} y={c.y + 50} width={CHUNK_MS * MSPX - 2} height="24" rx="4" fill="white" />
                </g>
                <!-- how much of the chunk has played -->
                <rect x={tx(k.s) + 1} y={c.y + 50} width={clamp(t - k.s, 0, CHUNK_MS) * MSPX - 2 > 0 ? clamp(t - k.s, 0, CHUNK_MS) * MSPX - 2 : 0} height="24" rx="4" fill={PLAYED} />
                <rect x={tx(k.s) + 1} y={c.y + 50} width={CHUNK_MS * MSPX - 2} height="24" rx="4" fill="none" stroke="var(--fg)" style:opacity={t >= k.a ? 1 : 0} style="transition: opacity 200ms" />
                <text x={tx(k.s) + (CHUNK_MS * MSPX) / 2} y={c.y + 66} text-anchor="middle" class="mono strong" style:opacity={t >= k.a ? 1 : 0}>chunk {i + 1}</text>
                {#if k.gap > 0}
                  <rect x={tx(k.s - k.gap)} y={c.y + 50} width={clamp(t - (k.s - k.gap), 0, k.gap) * MSPX} height="24" fill="url(#sa-hatch)" stroke={RED} stroke-width={t > k.s - k.gap ? 1 : 0} />
                  <text x={tx(k.s - k.gap / 2)} y={c.y + 90} text-anchor="middle" class="tag strong" style:fill={RED} style:opacity={t >= k.s ? 1 : 0} style="transition: opacity 200ms">gap · {k.gap} ms of silence</text>
                {/if}
              {/each}
              {#if ci === 0}
                <!-- how long the listener waits for any sound -->
                <path d="M {TX0} {c.y + 40} V {c.y + 44} H {tx(clamp(t, 0, c.chunks[0].a))} V {c.y + 40}" fill="none" stroke={TLK} />
                <text x={TX0 - 4} y={c.y + 90} class="tag strong" style:fill={TLK} style:opacity={t >= c.chunks[0].a ? 1 : 0} style="transition: opacity 200ms">time to first audio</text>
              {/if}
              <!-- now -->
              <line x1={tx(t)} y1={c.y + 16} x2={tx(t)} y2={c.y + 78} stroke="var(--fg)" stroke-width="1" opacity="0.35" />
            </g>
          {/each}
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">{CHUNK_MS} ms: {CHUNK} frames × {FRAME_MS} ms (Ch. {CH_OMNI} Step 3) · arrival times illustrative · dotted: a chunk waiting to play</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">SGLang-Omni's benchmark scores each request by its longest gap and counts how many stay within 50, 100 and 200 ms</text>
        </g>
      {/if}

      {#if cur.scene === 'whole' || cur.scene === 'stream'}
        {@const streaming = cur.scene === 'stream'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">{streaming ? 'streaming · code2wav decodes every ' + CHUNK + ' frames, as they come' : 'without streaming · code2wav waits for the whole answer'}</text>
          <text x="16" y={RY.talker + 17} class="tag strong">talker writes frames</text>
          <text x="16" y={RY.c2w + 17} class="tag strong">code2wav decodes</text>
          <text x="16" y={RY.player + 17} class="tag strong">the player plays</text>
          {#each Object.values(RY) as y}<rect x="150" y={y} width="540" height="26" rx="4" fill="#fbfaf7" stroke="var(--line)" />{/each}
          <!-- the time axis -->
          <line x1="150" y1="282" x2="690" y2="282" stroke="var(--faint)" marker-end="url(#sa-arrow)" />
          {#each [0, 1, 2, 3, 4] as s}<text x={sx(s * 1000)} y="296" text-anchor="middle" class="tag">{s} s</text>{/each}
          <!-- now, drawn first so labels sit over it -->
          <line x1={sx(t)} y1={RY.talker - 2} x2={sx(t)} y2={RY.player + 28} stroke="var(--fg)" opacity="0.35" />

          <!-- the talker: frames appear as they are written, ten to a group -->
          {#each Array.from({ length: GROUPS }) as _, g}
            {@const gr = group(g)}
            {#if gr.a < SPAN}
              <rect x={sx(gr.a)} y={RY.talker + 3} width={clamp(t - gr.a, 0, Math.min(gr.b, SPAN) - gr.a) * PX2} height="20" fill={TLK} opacity={g % 2 ? 0.55 : 0.85} />
            {/if}
          {/each}
          <text x={sx(group(0).a) + (CHUNK * GEN_MS * PX2) / 2} y={RY.talker - 6} text-anchor="middle" class="tag" style:opacity={t >= group(0).b ? 1 : 0}>frames 1–{CHUNK}</text>
          <text x={sx(group(1).a) + (CHUNK * GEN_MS * PX2) / 2} y={RY.talker - 6} text-anchor="middle" class="tag" style:opacity={t >= group(1).b ? 1 : 0}>{CHUNK + 1}–{2 * CHUNK}</text>

          {#if !streaming}
            <rect x={sx(SPAN / 2) - 228} y={RY.c2w + 4} width="456" height="18" fill="#fbfaf7" />
            <text x={sx(SPAN / 2)} y={RY.c2w + 17} text-anchor="middle" class="tag strong">waits for all {ANSWER_FRAMES} frames: at this pace, frame {ANSWER_FRAMES} comes at {fmt((T0 + ANSWER_FRAMES * GEN_MS) / 1000)} s</text>
            <rect x="151" y={RY.player + 1} width={clamp(t, 0, SPAN) * PX2 - 2 > 0 ? clamp(t, 0, SPAN) * PX2 - 2 : 0} height="24" rx="3" fill="url(#sa-hatch)" />
            <text x="150" y={RY.player + 46} class="tag strong" style:fill={RED}>silence, from the request on</text>
            <text x="690" y={RY.player + 46} text-anchor="end" class="tag strong" style:fill={RED} style:opacity={t >= SPAN ? 1 : 0} style="transition: opacity 300ms">first sound at {fmt(WHOLE_FIRST / 1000)} s →</text>
          {:else}
            {#each decodes as d, j}
              <rect x={sx(d.a)} y={RY.c2w + 3} width={clamp(t - d.a, 0, DEC_MS) * PX2 + (t >= d.a ? 2 : 0)} height="20" fill={C2W} />
              {#if j < 3}<text x={sx(d.a) + 3} y={RY.c2w - 6} text-anchor="middle" class="tag" style:opacity={t >= d.a ? 1 : 0}>{j + 1}</text>{/if}
            {/each}
            {#each streamChunks as k, i}
              {@const w = Math.min(k.e, SPAN) - k.s}
              <g style:opacity={t >= k.a ? 1 : 0} style="transition: opacity 200ms">
                <line x1={sx(k.a)} y1={RY.c2w + 24} x2={sx(k.a)} y2={RY.player - 7} stroke="var(--faint)" stroke-dasharray="2 2" />
                <path d="M {sx(k.a) - 4} {RY.player - 7} L {sx(k.a) + 4} {RY.player - 7} L {sx(k.a)} {RY.player - 1} Z" fill="var(--muted)" />
                <rect x={sx(k.s) + 1} y={RY.player + 1} width={w * PX2 - 2} height="24" rx="3" fill="white" />
              </g>
              <rect x={sx(k.s) + 1} y={RY.player + 1} width={Math.max(0, clamp(t - k.s, 0, w) * PX2 - 2)} height="24" rx="3" fill={PLAYED} />
              <rect x={sx(k.s) + 1} y={RY.player + 1} width={w * PX2 - 2} height="24" rx="3" fill="none" stroke="var(--fg)" style:opacity={t >= k.a ? 1 : 0} style="transition: opacity 200ms" />
              {#if w * PX2 > 60}<text x={sx(k.s) + Math.min(w, CHUNK_MS) * PX2 / 2} y={RY.player + 17} text-anchor="middle" class="mono strong" style:opacity={t >= k.a ? 1 : 0}>chunk {i + 1}</text>{/if}
            {/each}
            <!-- chunk 2 is ready before chunk 1 ends -->
            <g style:opacity={t >= streamChunks[1].a ? 1 : 0} style="transition: opacity 300ms">
              <path d="M {sx(streamChunks[1].a)} {RY.player + 31} V {RY.player + 37} H {sx(streamChunks[1].s)} V {RY.player + 31}" fill="none" stroke={TLK} />
              <text x={sx(streamChunks[1].a)} y={RY.player + 51} class="tag strong" style:fill={TLK}>chunk 2 ready {streamChunks[1].s - streamChunks[1].a} ms before chunk 1 ends</text>
            </g>
          {/if}

          <g in:fade={{ delay: 300 }}>
            {#if streaming}
              <text x="18" y="328" class="pt">·</text><text x="28" y="328" class="legend">while one chunk plays, the talker writes the next {CHUNK} frames and code2wav decodes them</text>
              <text x="18" y="345" class="pt">·</text><text x="28" y="345" class="legend">that keeps up while {CHUNK} frames take under {CHUNK_MS} ms: {STEPS} steps a frame, so under {STEP_MS} ms a step</text>
            {:else}
              <text x="16" y="328" class="legend">the listener hears nothing until the last frame is written and decoded</text>
            {/if}
          </g>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">{streaming ? `illustrative pace: a frame every ${GEN_MS} ms, twice real time · blue: frames, ten to a group · dark: a code2wav call · light: played` : `illustrative pace: a frame every ${GEN_MS} ms, twice real time · ${ANSWER_FRAMES} frames: Ch. ${CH_OMNI} Step 4's 20 s answer ÷ ${FRAME_MS} ms`}</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">{streaming ? 'measured: SGLang-Omni made sound in 38% of its playing time (real-time factor 0.38, 16 requests on one H100)' : 'a request that asks for its sound whole gets this: SGLang-Omni decodes as it goes but sends the sound once, at the end'}</text>
        </g>
      {/if}

      {#if cur.scene === 'inside'}
        {@const SX = 176}
        {@const sw = 11}
        {@const rec = IN_ARRIVE.filter((a) => a <= t).length}
        {@const sent = IN_DECODES.filter((d) => d.b <= t).reduce((m, d) => Math.max(m, d.to), 0)}
        {@const act = IN_DECODES.find((d) => t >= d.a && t < d.b)}
        {@const out = IN_DECODES.filter((d) => d.b <= t)}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">inside code2wav's stage · one request through its streaming scheduler (Ch. {CH_STAGES} Steps 7 and 11)</text>
          <!-- the talker hands codes in, a frame at a time at first -->
          <rect x="16" y="100" width="96" height="26" rx="6" fill="var(--accent-soft)" stroke={TLK} />
          <text x="64" y="117" text-anchor="middle" class="mono strong">talker_ar</text>
          <text x="64" y="142" text-anchor="middle" class="tag">edge 8, Ch. {CH_BETWEEN} Step 1</text>
          <line x1="116" y1="113" x2={SX - 8} y2="113" stroke="var(--faint)" stroke-width="1.5" marker-end="url(#sa-arrow)" />
          <text x={(116 + SX - 8) / 2} y="106" text-anchor="middle" class="tag">codes</text>

          <!-- the request's state: its frames so far, and how many have been sent -->
          <text x={SX} y="64" class="boxtitle">this request's state</text>
          <g style:opacity={t >= IN_CLEAR ? 0.25 : 1} style="transition: opacity 300ms">
            {#each Array.from({ length: IN_FRAMES }) as _, i}
              <rect x={SX + i * sw} y="102" width={sw - 2} height="22" rx="2" fill={i < sent ? C2W : i < rec ? TLK : '#fbfaf7'} stroke={i < rec ? 'none' : 'var(--line)'} opacity={i < sent ? 0.85 : 1} />
            {/each}
          </g>
          {#if act}
            {@const r0 = act.from - Math.min(LEFT, act.from)}
            {#if act.from > r0}
              <path d="M {SX + r0 * sw} 96 V 90 H {SX + act.from * sw - 3} V 96" fill="none" stroke="var(--muted)" stroke-dasharray="3 2" />
              <text x={SX + ((r0 + act.from) / 2) * sw} y="85" text-anchor="middle" class="tag">earlier {act.from - r0}</text>
            {/if}
            <path d="M {SX + act.from * sw} 96 V 90 H {SX + act.to * sw - 2} V 96" fill="none" stroke={TLK} />
            <text x={SX + ((act.from + act.to) / 2) * sw} y="85" text-anchor="middle" class="tag strong" style:fill={TLK}>new {act.to - act.from}</text>
          {/if}
          <text x={SX} y="144" class="tag strong">{rec} received · {sent} sent as sound</text>

          <!-- code2wav, busy while a window decodes -->
          <line x1={SX + IN_FRAMES * sw + 4} y1="113" x2="586" y2="113" stroke="var(--faint)" stroke-width="1.5" marker-end="url(#sa-arrow)" />
          <rect x="590" y="100" width="114" height="26" rx="6" fill={act ? C2W : 'white'} stroke={C2W} />
          <text x="647" y="117" text-anchor="middle" class="mono strong" style:fill={act ? 'white' : 'var(--fg)'}>code2wav</text>

          <!-- what it is doing now -->
          <rect x="16" y="166" width="688" height="30" rx="6" fill="#fbfaf7" stroke="var(--line)" />
          <text x="30" y="186" class="legend strong">now: {inStatus(t)}</text>

          <!-- the sound it sends, chunk by chunk -->
          <text x="16" y="242" class="tag strong">sound sent out</text>
          <path d="M 647 128 V 239 H 562" fill="none" stroke="var(--faint)" stroke-width="1.5" stroke-dasharray="3 2" marker-end="url(#sa-arrow)" />
          {#each out as d, k}
            {@const pw = (q: { from: number; to: number }) => Math.max((q.to - q.from) * 9, 50)}
            {@const x0 = SX + IN_DECODES.slice(0, k).reduce((a, q) => a + pw(q) + 4, 0)}
            <g transition:fade={{ duration: 200 }}>
              <rect x={x0} y="228" width={pw(d)} height="22" rx="4" fill="white" stroke="var(--fg)" />
              <text x={x0 + pw(d) / 2} y="243" text-anchor="middle" class="tag strong">{(d.to - d.from) * FRAME_MS} ms</text>
            </g>
          {/each}
          <text x={SX} y="270" class="tag">outbox → coordinator (Ch. {CH_BETWEEN} Step 10) → the client, as stream events (Ch. {CH_PROC} Step 9)</text>

          <g in:fade={{ delay: 400 }}>
            <text x="18" y="312" class="pt">·</text><text x="28" y="312" class="legend">the state is per request, so many requests sit in code2wav at once, each at its own point</text>
            <text x="18" y="329" class="pt">·</text><text x="28" y="329" class="legend">a decode needs {CHUNK} new frames, except the last, which goes out when the talker says it is done</text>
          </g>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">blue: received, not yet sound · dark: sent as sound · bracket: the window being decoded (step 5) · times illustrative</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">SGLang-Omni's Code2WavScheduler, on StreamingVocoderBase: keep frames, decode the new part, send it, flush the rest at the end</text>
        </g>
      {/if}

      {#if cur.scene === 'seam'}
        {@const MID = { a: 136, b: 236 }}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">joining chunks · each window adds the frames before it, up to {LEFT}</text>
          {#each [0, 10, 20] as f}<text x={fx(f)} y="64" text-anchor="middle" class="tag">frame {f}</text>{/each}

          <!-- decoded alone: chunk 2 jumps at the seam -->
          <text x="16" y="88" class="boxtitle">DECODED ALONE</text>
          <text x="16" y="105" class="tag strong">code2wav's input</text>
          <rect x={fx(0) + 1} y="92" width={CHUNK * FPX - 2} height="20" fill={C2W} opacity="0.85" />
          <text x={fx(CHUNK / 2)} y="106" text-anchor="middle" class="steplabel">window 1</text>
          <rect x={fx(CHUNK) + 1} y="92" width={CHUNK * FPX - 2} height="20" fill={C2W} opacity="0.85" />
          <text x={fx(CHUNK * 1.5)} y="106" text-anchor="middle" class="steplabel">window 2: frames 11–20 only</text>
          <text x="16" y={MID.a + 4} class="tag strong">sound sent</text>
          <path d={wavePath(0, CHUNK, MID.a)} fill="none" stroke="var(--fg)" stroke-width="1.6" />
          <path d={wavePath(CHUNK, 2 * CHUNK, MID.a, alone)} fill="none" stroke="var(--fg)" stroke-width="1.6" />
          <circle cx={fx(CHUNK)} cy={MID.a - 11 * (wave(CHUNK) + 0.55)} r="13" fill="none" stroke={RED} stroke-width="1.5" />
          <text x={fx(2 * CHUNK) + 14} y={MID.a + 4} class="tag strong" style:fill={RED}>chunk 2's start</text>
          <text x={fx(2 * CHUNK) + 14} y={MID.a + 17} class="tag strong" style:fill={RED}>misses chunk 1's end</text>

          <!-- with the frames before it: decode both, send only the new part -->
          <text x="16" y="188" class="boxtitle">WITH THE FRAMES BEFORE IT</text>
          <text x="16" y="205" class="tag strong">code2wav's input</text>
          <rect x={fx(0) + 1} y="192" width={CHUNK * FPX - 2} height="20" fill={REST_FILL} stroke="var(--muted)" stroke-dasharray="3 2" />
          <text x={fx(CHUNK / 2)} y="206" text-anchor="middle" class="tag">frames 1–10 again</text>
          <rect x={fx(CHUNK) + 1} y="192" width={CHUNK * FPX - 2} height="20" fill={C2W} opacity="0.85" />
          <text x={fx(CHUNK * 1.5)} y="206" text-anchor="middle" class="steplabel">frames 11–20, new</text>
          <text x="16" y={MID.b + 4} class="tag strong">sound sent</text>
          <path d={wavePath(0, CHUNK, MID.b)} fill="none" stroke="var(--fg)" stroke-width="1.6" />
          <path d={wavePath(CHUNK, 2 * CHUNK, MID.b)} fill="none" stroke={TLK} stroke-width="1.8" />
          <text x={fx(2 * CHUNK) + 14} y={MID.b + 4} class="tag strong" style:fill={TLK}>chunk 2 carries on</text>
          <text x={fx(2 * CHUNK) + 14} y={MID.b + 17} class="tag strong" style:fill={TLK}>from chunk 1</text>

          <!-- how many frames before: all there are, up to 25 -->
          <text x="16" y="282" class="boxtitle">EACH WINDOW</text>
          <text x="150" y="282" class="tag">window: frames before it, up to {LEFT}, + {CHUNK} new = frames decoded</text>
          {#each [1, 2, 3, 4, 5] as k, i}
            {@const earlier = Math.min(LEFT, (k - 1) * CHUNK)}
            {@const x0 = 150 + i * 112}
            <rect x={x0} y="292" width={earlier * 2.4} height="18" fill={REST_FILL} stroke="var(--muted)" stroke-dasharray="3 2" />
            <rect x={x0 + earlier * 2.4} y="292" width={CHUNK * 2.4} height="18" fill={C2W} opacity="0.85" />
            <text x={x0} y="326" class="tag strong">{k}: {earlier} + {CHUNK} = {earlier + CHUNK}</text>
          {/each}
          <text x="16" y="352" class="legend">code2wav keeps nothing from one window to the next, so the frames before have to go in again</text>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">earlier frames, dashed, up to {LEFT}: decoded again, their sound thrown away · dark: new frames, whose sound is sent · waves illustrative</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">code2wav keeps the last {CHUNK} × {fmt(SAMPLES_PER_FRAME)} samples of each window (left_context_size = {LEFT})</text>
        </g>
      {/if}

      {#if cur.scene === 'size'}
        {@const LX = 150}
        {@const RX = 450}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">how big a chunk · a sooner first sound against more work</text>
          <text x={LX} y="78" class="boxtitle">the first sound waits for</text>
          <text x={RX} y="72" class="boxtitle">times each frame is decoded</text>
          <text x={RX} y="85" class="tag">lower is less GPU work · without streaming, once</text>
          <line x1={RX + 13} y1="90" x2={RX + 13} y2="296" stroke="var(--muted)" stroke-dasharray="3 3" />
          <text x={RX + 13} y="306" text-anchor="middle" class="tag">once</text>
          {#each SIZES as r, i}
            {@const y = 92 + i * 40}
            {@const n = r.then ?? r.n}
            <g in:fade={{ delay: 100 + i * 150, duration: 250 }}>
              {#if r.def}<rect x="8" y={y - 6} width="704" height="36" rx="6" fill="#fbfaf7" stroke="var(--line)" />{/if}
              <text x="16" y={y + 13} class="tag strong">{r.then ? `${r.n} first, then ${r.then}` : `chunks of ${r.n}`}</text>
              {#if r.def}<text x="16" y={y + 26} class="tag">SGLang-Omni's default</text>{/if}
              {#if r.then}<text x="16" y={y + 26} class="tag">proposed, PR #2800</text>{/if}
              <rect x={LX} y={y} width={r.n * 8} height="18" rx="3" fill={TLK} opacity="0.8" />
              <text x={LX + r.n * 8 + 8} y={y + 13} class="tag strong">{r.n} frames · {r.n * STEPS} steps</text>
              <rect x={RX} y={y} width={r.work * 13} height="18" rx="3" fill={C2W} opacity="0.8" />
              <text x={RX + r.work * 13 + 8} y={y + 13} class="tag strong">{+r.work.toFixed(2)} times</text>
            </g>
          {/each}
          <g in:fade={{ delay: 900 }}>
            <text x="18" y="322" class="pt">·</text><text x="28" y="322" class="legend">each frame is decoded once as new, then again as context for the next windows (step 5): ({LEFT} + {CHUNK}) ÷ {CHUNK} = {(LEFT + CHUNK) / CHUNK}</text>
            <text x="18" y="339" class="pt">·</text><text x="28" y="339" class="legend">measured, {SMALL_FIRST_N} first then {CHUNK}: first sound p95 0.61 → 0.48 s on one H200, requests per second 12.79 → 12.64</text>
          </g>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">{STEPS} steps a frame (step 3) · times decoded: once {LEFT} earlier frames exist (step 5) · chunks of N: ({LEFT} + N) ÷ N</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">p95: the time 19 in 20 first sounds beat · 16 requests at once, the window change alone (PR #2800, still open)</text>
        </g>
      {/if}

      {#if ANIM[cur.scene]}<LoopProgress ms={lapMs} {lap} />{/if}
    </svg>
  </div>

  <StepControls {step} total={steps.length} caption={cur.caption} {prev} {next} onchange={(s) => (step = s)} />
</figure>
