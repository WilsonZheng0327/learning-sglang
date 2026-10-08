<script lang="ts">
  import { fade } from 'svelte/transition';
  import StepControls from '../StepControls.svelte';
  import type { NavLink } from '../../chapters';
  import { SPEECH_IN_HZ, SPEECH_OUT_HZ, VISION_PATCH, VISION_MERGE, AUDIO_FRAMES_PER_SEC, AUDIO_POS_PER_100, CODES_PER_FRAME, CODE_VALUES, SAMPLES_PER_FRAME } from '../../numbers';
  let { prev, next }: { prev?: NavLink; next?: NavLink } = $props();

  // ---- The request every Omni chapter follows: a photo and a spoken question in, a spoken answer out ----------
  const PHOTO = 896;                                 // pixels a side
  const PHOTO_VALUES = PHOTO * PHOTO * 3;            // red, green, blue per pixel
  const Q_SEC = 10, A_SEC = 20;                      // the spoken question and the spoken answer
  const Q_VALUES = Q_SEC * SPEECH_IN_HZ;
  const A_VALUES = A_SEC * SPEECH_OUT_HZ;
  const fmt = (n: number) => n.toLocaleString('en-US');
  const PX_POS = VISION_PATCH * VISION_MERGE;        // 32 pixels a side per prompt position
  const IMG_POS = (PHOTO / PX_POS) ** 2;             // 784
  const AUD_POS = (Q_SEC * AUDIO_FRAMES_PER_SEC / 100) * AUDIO_POS_PER_100;   // 130
  const FRAME_MS = (SAMPLES_PER_FRAME / SPEECH_OUT_HZ) * 1000;                 // 80
  const FRAMES = (A_SEC * 1000) / FRAME_MS;                                    // 250 in the answer
  const CHUNK = 10;                                  // frames code2wav turns into sound per pass (SGLang-Omni's default)

  type Scene = 'request' | 'encoders' | 'speech' | 'map' | 'waits' | 'gpu';
  const steps: { scene: Scene; caption: string }[] = [
    { scene: 'request', caption: `Text gets a tokenizer in front of the engine and a detokenizer after it (chapter 1). An omni request needs a converter on each side too: a photo and a spoken question in, a spoken answer out.` },
    { scene: 'encoders', caption: `The left box is an encoder per input: a vision model turns the photo into ${fmt(IMG_POS)} prompt positions, an audio model turns the question into ${AUD_POS}. They join the prompt, and the engine prefills it as before.` },
    { scene: 'speech', caption: `Each token also goes to three more models. The talker writes a frame's code 0, the code predictor its codes 1–${CODES_PER_FRAME - 1}, then the next frame; every ${CHUNK} frames, code2wav turns them into sound.` },
    { scene: 'map', caption: `The whole request is six models of two kinds. Three read their input and are done; three are loops like chapter 1's, where each step waits for the one before it.` },
    { scene: 'waits', caption: `The engine pauses only when its own scheduler runs something else. The talker pauses because its token isn't written yet, a check SGLang's scheduler never makes.` },
    { scene: 'gpu', caption: `Alone, the talker leaves its GPU nearly idle; shared, its step can land behind a long prefill, and neither loop sees the other. What decides how they share it, and how do tokens get across?` },
  ];

  let step = $state(0);
  $effect(() => {
    const q = Number(new URLSearchParams(window.location.search).get('step'));
    if (q >= 1 && q <= steps.length) step = q - 1;
  });
  const cur = $derived(steps[step]);
  // step 3's loop: frame by frame, code 0 from the talker, then codes 1–15 from the code predictor;
  // after the 10th frame code2wav turns the chunk into sound
  let written = $state(0);                        // codes written so far, frame by frame
  let writer = $state<'' | 'talker' | 'predictor'>('');
  let c2w = $state(0);                            // 0 waiting, 1 running, 2 sound out
  $effect(() => {
    if (cur.scene !== 'speech') return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const run = () => {
      written = 0; writer = ''; c2w = 0;
      let t = 0;
      const at = (dt: number, f: () => void) => { t += dt; timers.push(setTimeout(f, t)); };
      at(900, () => (writer = 'talker'));
      for (let f = 0; f < CHUNK; f++) {
        const [t0, tc] = f === 0 ? [900, 140] : [160, 22];
        at(t0, () => { written++; writer = 'predictor'; });
        for (let c = 1; c < CODES_PER_FRAME; c++) at(tc, () => { written++; if (c === CODES_PER_FRAME - 1) writer = f < CHUNK - 1 ? 'talker' : ''; });
      }
      at(300, () => (c2w = 1));
      at(1200, () => (c2w = 2));
      at(3000, run);
    };
    run();
    return () => timers.forEach(clearTimeout);
  });
  // step 5's loop: the two requests' iterations appear one at a time, then hold and start again
  const ITERS = 16;
  let iter = $state(ITERS - 1);
  $effect(() => {
    if (cur.scene !== 'waits') return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const run = () => {
      iter = -1;
      for (let i = 0; i < ITERS; i++) timers.push(setTimeout(() => (iter = i), 700 + i * 450));
      timers.push(setTimeout(run, 700 + ITERS * 450 + 2600));
    };
    run();
    return () => timers.forEach(clearTimeout);
  });
  const W = 720, H = 400;
  const RED = 'var(--eos)';

  // a speech-like waveform: bursts of oscillation, deterministic so the server and the browser draw the same thing
  const wave = (x0: number, x1: number, cy: number, amp: number, seed: number) => {
    let d = '';
    for (let x = x0; x <= x1; x += 1.5) {
      const t = (x - x0) / 6;
      const env = 0.15 + 0.85 * Math.abs(Math.sin(t * 0.21 + seed)) * (0.6 + 0.4 * Math.sin(t * 0.047 + seed * 2));
      const y = cy + amp * env * Math.sin(t * 2.3 + seed) * Math.cos(t * 0.9 + seed * 3);
      d += `${d ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)} `;
    }
    return d;
  };
  // the photo as a 6 × 6 mosaic: sky, a sun, hills
  const tile = (r: number, c: number) =>
    r === 1 && c === 4 ? ['var(--gen)', 0.95] : r < 3 ? ['var(--accent)', 0.25 + 0.08 * r] : ['#16a34a', r + c > 7 ? 0.75 : 0.5];
  const pill = (s: string) => 10 + s.length * 6;
</script>

<figure class="viz">
  <div class="canvas">
    <svg viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Omni models, step {step + 1}">
      <defs>
        <marker id="om-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#b8b4aa" />
        </marker>
        <marker id="om-arrow-red" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--eos)" />
        </marker>
      </defs>

      <!-- 1: the request, next to the text request chapters 1–14 served: the same engine, a converter needed on each side -->
      {#if cur.scene === 'request'}
        {@const TK = 238}
        {@const TKW = 68}
        {@const EX = 358}
        {@const EW = 100}
        {@const DT = 510}
        {@const DTW = 78}
        {@const OUT = 606}
        {@const CX = EX + EW / 2}
        {@const YA = 110}
        {@const YB = 270}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">one omni request, next to the text request chapters 1–14 served</text>
          <text x="30" y="80" class="boxtitle">text · chapters 1–14</text>
          <text x="30" y="222" class="boxtitle">omni · this part</text>

          <!-- the engine, one for both -->
          <g in:fade={{ delay: 100, duration: 250 }}>
            <rect x={EX} y="92" width={EW} height="206" rx="12" fill="#fbfaf7" stroke="var(--fg)" />
            <text x={CX} y="180" text-anchor="middle" class="slab strong small">the engine</text>
            <text x={CX} y="196" text-anchor="middle" class="tag">one model</text>
            <text x={CX} y="210" text-anchor="middle" class="tag">one loop</text>
          </g>

          <!-- text: a converter on each side -->
          <g in:fade={{ delay: 400, duration: 250 }}>
            <rect x="24" y={YA - 13} width="166" height="26" rx="6" fill="white" stroke="var(--line)" />
            <text x="107" y={YA + 4} text-anchor="middle" class="mono">The capital of France is</text>
            <path d="M 194 {YA} H {TK - 4}" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#om-arrow)" />
            <rect x={TK} y={YA - 16} width={TKW} height="32" rx="8" fill="white" stroke="var(--accent)" />
            <text x={TK + TKW / 2} y={YA + 4} text-anchor="middle" class="tag strong">tokenizer</text>
            <path d="M {TK + TKW + 4} {YA} H {EX - 4}" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#om-arrow)" />
            <text x={(TK + TKW + EX) / 2} y={YA - 8} text-anchor="middle" class="tag">token ids</text>
            <path d="M {EX + EW + 4} {YA} H {DT - 4}" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#om-arrow)" />
            <text x={(EX + EW + DT) / 2} y={YA - 8} text-anchor="middle" class="tag">token ids</text>
            <rect x={DT} y={YA - 16} width={DTW} height="32" rx="8" fill="white" stroke="var(--accent)" />
            <text x={DT + DTW / 2} y={YA + 4} text-anchor="middle" class="tag strong">detokenizer</text>
            <path d="M {DT + DTW + 4} {YA} H {OUT - 6}" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#om-arrow)" />
            <text x={OUT} y={YA + 4} class="mono">Paris</text>
            <text x={TK + TKW / 2} y={YA + 32} text-anchor="middle" class="tag">chapter 1</text>
            <text x={DT + DTW / 2} y={YA + 32} text-anchor="middle" class="tag">chapter 1</text>
          </g>

          <!-- omni: the same engine, and a box on each side still to be filled -->
          <g in:fade={{ delay: 800, duration: 250 }}>
            {#each Array(6) as _, r}{#each Array(6) as _, c}
              {@const [fill, op] = tile(r, c)}
              <rect x={30 + c * 8} y={232 + r * 8} width="7" height="7" fill={fill} opacity={op} />
            {/each}{/each}
            <text x="88" y="244" class="slab strong small">a photo</text>
            <text x="88" y="258" class="tag">{PHOTO} × {PHOTO} × 3 colours</text>
            <text x="88" y="272" class="tag strong">= {fmt(PHOTO_VALUES)} values</text>
            <path d={wave(30, 150, 300, 9, 1.3)} fill="none" stroke="var(--fg)" stroke-width="1.2" opacity="0.8" />
            <text x="30" y="324" class="slab strong small">a spoken question</text>
            <text x="30" y="338" class="tag">{Q_SEC} s × {fmt(SPEECH_IN_HZ)} = <tspan class="strong">{fmt(Q_VALUES)} samples</tspan></text>

            <path d="M 200 264 C 216 264, 218 {YB - 8}, {TK - 4} {YB - 8}" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#om-arrow)" />
            <path d="M 156 300 C 200 300, 204 {YB + 8}, {TK - 4} {YB + 8}" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#om-arrow)" />
            {#each [TK, DT] as bx, i}
              {@const bw = i ? DTW : TKW}
              <rect x={bx} y={YB - 20} width={bw} height="40" rx="8" fill="white" stroke="var(--faint)" stroke-width="1.5" stroke-dasharray="4 3" />
              <text x={bx + bw / 2} y={YB + 6} text-anchor="middle" class="slab strong" style:fill="var(--muted)">?</text>
            {/each}
            <path d="M {TK + TKW + 4} {YB} H {EX - 4}" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#om-arrow)" />
            <path d="M {EX + EW + 4} {YB} H {DT - 4}" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#om-arrow)" />
            <path d="M {DT + DTW + 4} {YB} H {OUT - 6}" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#om-arrow)" />
            <path d={wave(OUT, 690, YB, 9, 4.1)} fill="none" stroke="var(--fg)" stroke-width="1.2" opacity="0.8" />
            <text x="690" y={YB + 36} text-anchor="end" class="slab strong small">a spoken answer</text>
            <text x="690" y={YB + 50} text-anchor="end" class="tag">{A_SEC} s × {fmt(SPEECH_OUT_HZ)} = <tspan class="strong">{fmt(A_VALUES)} samples</tspan></text>
          </g>

          <text x="16" y="368" class="legend" in:fade={{ delay: 1300 }}>text has a converter on each side of the engine; the omni request needs one on each side too, marked ?</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">a sample is one reading of the sound wave's height · rates as SGLang-Omni serves Qwen3-Omni: {fmt(SPEECH_IN_HZ)} a second in, {fmt(SPEECH_OUT_HZ)} out</text>
        </g>
      {/if}

      <!-- 2: the left ? opened up · an encoder per input turns it into prompt positions -->
      {#if cur.scene === 'encoders'}
        {@const PS = 3}
        {@const SIDE = PHOTO / PX_POS}
        {@const EB = 352}
        {@const EBW = 100}
        {@const S = 150 / IMG_POS}
        {@const IX = 506}
        {@const AX = IX + IMG_POS * S + 2}
        {@const HR = 4}
        {@const HC = 24}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">the left ? of step 1, opened up · each input has its own encoder, a model that runs on the GPU</text>

          <!-- the photo: one prompt position per 32 × 32 pixels -->
          <g in:fade={{ delay: 100, duration: 250 }}>
            {#each Array(SIDE) as _, r}{#each Array(SIDE) as _, c}
              {@const [fill, op] = tile(Math.floor((r * 6) / SIDE), Math.floor((c * 6) / SIDE))}
              <rect x={30 + c * PS} y={66 + r * PS} width={PS - 0.4} height={PS - 0.4} fill={fill} opacity={op} />
            {/each}{/each}
            <rect x={30 + HC * PS - 0.5} y={66 + HR * PS - 0.5} width={PS + 0.6} height={PS + 0.6} fill="none" stroke="var(--fg)" stroke-width="1" />
            <path d="M {30 + HC * PS + PS + 1} {66 + HR * PS + 1} L 128 76" fill="none" stroke="var(--fg)" stroke-width="0.8" />
            {#each [[0, 0], [0, 1], [1, 0], [1, 1]] as [r, c]}
              <rect x={128 + c * 18} y={76 + r * 18} width="17" height="17" fill="var(--accent)" opacity="0.3" stroke="var(--fg)" stroke-width="0.8" />
            {/each}
            <text x="172" y="84" class="tag strong">one position</text>
            <text x="172" y="98" class="tag">= {PX_POS} × {PX_POS} pixels</text>
            <text x="172" y="112" class="tag">= {VISION_MERGE} × {VISION_MERGE} patches of {VISION_PATCH}</text>
            <text x="30" y="168" class="tag">{PHOTO} ÷ {PX_POS} = {SIDE} positions a side</text>
            <text x="30" y="182" class="tag strong">{SIDE} × {SIDE} = {fmt(IMG_POS)} positions</text>
          </g>

          <!-- the voice: 13 prompt positions per second -->
          <g in:fade={{ delay: 400, duration: 250 }}>
            <path d={wave(30, 230, 214, 10, 1.3)} fill="none" stroke="var(--fg)" stroke-width="1.2" opacity="0.8" />
            {#each Array(Q_SEC + 1) as _, i}
              <line x1={30 + i * 20} y1="228" x2={30 + i * 20} y2="233" stroke="var(--faint)" />
            {/each}
            <text x="30" y="250" class="tag">{Q_SEC} s × {AUDIO_FRAMES_PER_SEC} feature frames a second</text>
            <text x="30" y="264" class="tag strong">{AUDIO_POS_PER_100} positions per 100 frames: {Q_SEC} × {AUDIO_POS_PER_100} = {AUD_POS}</text>
          </g>

          <!-- the two encoders -->
          <g in:fade={{ delay: 700, duration: 250 }}>
            {#each [{ y: 92, n: 'vision encoder', from: 290, fy: 106, to: IX - 4, ty: 113 }, { y: 196, n: 'audio encoder', from: 240, fy: 214, to: AX - 4, ty: 217 }] as e}
              <path d="M {e.from} {e.fy} H {EB - 4}" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#om-arrow)" />
              <rect x={EB} y={e.y} width={EBW} height="36" rx="8" fill="white" stroke="var(--accent)" />
              <text x={EB + EBW / 2} y={e.y + 22} text-anchor="middle" class="tag strong">{e.n}</text>
              <text x={EB + EBW / 2} y={e.y + 50} text-anchor="middle" class="tag">a model, on the GPU</text>
              <path d="M {EB + EBW + 4} {e.ty} H {e.to}" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#om-arrow)" />
            {/each}
          </g>

          <!-- what they hand over, and where it goes: the prompt, at one scale -->
          <g in:fade={{ delay: 1000, duration: 250 }}>
            <text x={IX} y="100" class="tag strong">{fmt(IMG_POS)} embeddings</text>
            {#each Array(SIDE) as _, i}
              <rect x={IX + (i * IMG_POS * S) / SIDE} y="106" width={(IMG_POS * S) / SIDE - 1} height="14" fill="var(--accent)" opacity="0.7" />
            {/each}
            <text x="690" y="204" text-anchor="end" class="tag strong">{AUD_POS} embeddings</text>
            <rect x={AX} y="210" width={AUD_POS * S} height="14" fill="var(--gen)" opacity="0.8" />
          </g>
          <g in:fade={{ delay: 1300, duration: 250 }}>
            {#each Array(6) as _, i}<rect x={480 + i * 4} y="272" width="3" height="14" fill="#d9d5cb" />{/each}
            <rect x={IX} y="272" width={IMG_POS * S} height="14" fill="var(--accent)" opacity="0.7" />
            <rect x={AX} y="272" width={AUD_POS * S} height="14" fill="var(--gen)" opacity="0.8" />
            <text x="480" y="302" class="tag strong">the prompt: template tokens + {fmt(IMG_POS)} + {AUD_POS}</text>
            <text x="480" y="316" class="tag">prefilled in one pass, as in chapter 4</text>
          </g>

          <g in:fade={{ delay: 1700 }}>
            <text x="18" y="346" class="pt">·</text><text x="28" y="346" class="legend">a tokenizer looks each id up in a table; an encoder is a model that runs on the GPU and hands over embeddings</text>
            <text x="18" y="364" class="pt">·</text><text x="28" y="364" class="legend">SGLang does this today: the encoders run inside the prefill step, and a photo seen before is found by its hash</text>
          </g>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">Qwen3-Omni: {VISION_PATCH}-pixel patches, merged {VISION_MERGE} × {VISION_MERGE} · audio: {AUDIO_FRAMES_PER_SEC} feature frames a second, {AUDIO_POS_PER_100} positions per 100</text>
        </g>
      {/if}
      <!-- 3: the right ? opened up · each token goes to the detokenizer and to three more models, which write codes frame by frame -->
      {#if cur.scene === 'speech'}
        {@const NF = CHUNK}
        {@const GX = 312}
        {@const GY = 140}
        {@const CW = 16}
        {@const RH = 7}
        {@const R1 = GY + 11}
        {@const GB = R1 + (CODES_PER_FRAME - 1) * RH}
        {@const BX = 160}
        {@const BW = 88}
        {@const RX = 556}
        {@const SB = 136}
        {@const CY = GB + 20}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">the right ? of step 1, opened up · each token the engine picks now goes two ways</text>

          <!-- the engine; each token goes to the detokenizer and to the talker, down arrows of one length -->
          <g in:fade={{ delay: 100, duration: 250 }}>
            <rect x="16" y="55" width="72" height="189" rx="10" fill="#fbfaf7" stroke="var(--fg)" />
            <text x="52" y="170" text-anchor="middle" class="slab strong small">the engine</text>
            <text x="52" y="186" text-anchor="middle" class="tag">one model</text>
            <text x="52" y="200" text-anchor="middle" class="tag">one loop</text>
            {#each [72, 144] as y}
              <path d="M 92 {y} H {BX - 4}" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#om-arrow)" />
              <text x="112" y={y - 7} text-anchor="middle" class="tag">tokens</text>
            {/each}
            <rect x={BX} y="55" width="112" height="34" rx="8" fill="white" stroke="var(--accent)" />
            <text x={BX + 56} y="69" text-anchor="middle" class="tag strong">detokenizer</text>
            <text x={BX + 56} y="82" text-anchor="middle" class="tag">a table, on the CPU</text>
            <path d="M {BX + 116} 72 H {BX + 140}" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#om-arrow)" />
            <text x={BX + 146} y="76" class="tag">the answer as text, as in chapters 1–14</text>

            <rect x={SB} y="100" width={704 - SB} height="256" rx="10" fill="none" stroke="var(--faint)" stroke-dasharray="4 3" />
            <text x={SB + 12} y="115" class="tag strong">speech · beside the detokenizer, three more models, on the GPU</text>
          </g>

          <!-- the two models that write codes: each box lights while it is the one writing -->
          <g in:fade={{ delay: 300, duration: 250 }}>
            <rect x={BX} y="122" width={BW} height="44" rx="8" fill={writer === 'talker' ? 'var(--accent-soft)' : 'white'} stroke="var(--accent)" stroke-width={writer === 'talker' ? 2 : 1} />
            <text x={BX + BW / 2} y="136" text-anchor="middle" class="tag strong">talker</text>
            <text x={BX + BW / 2} y="149" text-anchor="middle" class="tag">a model</text>
            <text x={BX + BW / 2} y="161" text-anchor="middle" class="tag">1 step a frame</text>
            <path d="M {BX + BW + 4} {GY + 3} H {GX - 4}" fill="none" stroke="var(--accent)" stroke-width="1.5" marker-end="url(#om-arrow)" />
            <text x={(BX + BW + GX) / 2} y={GY - 4} text-anchor="middle" class="tag">code 0</text>
            <path d="M {BX + BW / 2} 170 V 184" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#om-arrow)" />
            <rect x={BX} y="188" width={BW} height="44" rx="8" fill={writer === 'predictor' ? 'var(--gen-soft)' : 'white'} stroke="var(--gen)" stroke-width={writer === 'predictor' ? 2 : 1} />
            <text x={BX + BW / 2} y="202" text-anchor="middle" class="tag strong">code predictor</text>
            <text x={BX + BW / 2} y="215" text-anchor="middle" class="tag">a model</text>
            <text x={BX + BW / 2} y="227" text-anchor="middle" class="tag">{CODES_PER_FRAME - 1} steps a frame</text>
            <path d="M {BX + BW + 4} 206 H {GX - 4}" fill="none" stroke="var(--gen)" stroke-width="1.5" marker-end="url(#om-arrow)" />
            <text x={(BX + BW + GX) / 2} y="199" text-anchor="middle" class="tag">codes 1–{CODES_PER_FRAME - 1}</text>
          </g>

          <!-- the codes, a column per frame, filled in the order they are written; the next one outlined -->
          <g in:fade={{ delay: 500, duration: 250 }}>
            <text x={GX} y={GY - 10} class="tag">frames →, {fmt(SAMPLES_PER_FRAME)} samples ÷ {fmt(SPEECH_OUT_HZ)} = {FRAME_MS} ms each</text>
            {#each Array(NF) as _, c}
              {#each Array(CODES_PER_FRAME) as _, r}
                {@const i = c * CODES_PER_FRAME + r}
                {@const y = r ? R1 + (r - 1) * RH : GY}
                <rect x={GX + c * CW} y={y} width={CW - 2} height={RH - 1}
                  fill={i < written ? (r ? 'var(--gen)' : 'var(--accent)') : 'none'}
                  opacity={i < written ? (r ? 0.3 + 0.3 * Math.abs(Math.sin(c * 2.3 + r * 1.1)) : 0.6 + 0.25 * Math.abs(Math.sin(c * 1.7))) : 1}
                  stroke={i < written ? 'none' : 'var(--line)'} stroke-width="0.8" />
              {/each}
            {/each}
            {#if writer}
              {@const c = Math.floor(written / CODES_PER_FRAME)}
              {@const r = written % CODES_PER_FRAME}
              <rect x={GX + c * CW - 1} y={(r ? R1 + (r - 1) * RH : GY) - 1} width={CW} height={RH + 1} fill="none" stroke="var(--fg)" stroke-width="1.2" />
            {/if}
            <path d="M {GX + NF * CW + 2} {GY} h 4 V {GB - 1} h -4" fill="none" stroke="var(--faint)" />
            <text x={GX + NF * CW + 12} y={(GY + GB) / 2 - 2} class="tag strong">{CODES_PER_FRAME} codes</text>
            <text x={GX + NF * CW + 12} y={(GY + GB) / 2 + 12} class="tag">a frame</text>
          </g>

          <!-- code2wav: one pass over each 10 frames, running while the talker writes the next frame -->
          <g in:fade={{ delay: 700, duration: 250 }}>
            <path d="M {GX + (CHUNK * CW) / 2} {GB + 4} V {CY - 4}" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#om-arrow)" />
            <rect x={GX} y={CY} width={CHUNK * CW - 2} height="24" rx="6" fill={c2w === 1 ? 'var(--panel)' : 'white'} stroke="var(--fg)" stroke-width={c2w === 1 ? 2 : 1} />
            <text x={GX + (CHUNK * CW) / 2} y={CY + 16} text-anchor="middle" class="tag strong">code2wav · a model</text>
            <path d="M {GX + (CHUNK * CW) / 2} {CY + 28} V {CY + 40}" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#om-arrow)" />
            {#if c2w === 2}
              <path d={wave(GX, GX + CHUNK * CW - 2, CY + 54, 9, 4.1)} fill="none" stroke="var(--fg)" stroke-width="1.2" opacity="0.8" transition:fade={{ duration: 400 }} />
            {:else}
              <text x={GX + (CHUNK * CW) / 2} y={CY + 58} text-anchor="middle" class="tag" transition:fade={{ duration: 250 }}>waiting for {CHUNK} frames</text>
            {/if}
            <text x={GX + CHUNK * CW + 10} y={CY + 58} class="tag">{CHUNK} × {FRAME_MS} ms = {CHUNK * FRAME_MS} ms of sound</text>
          </g>

          <!-- what a code is, and the 20 s answer counted -->
          <g in:fade={{ delay: 900, duration: 250 }}>
            <text x={RX} y={GY + 4} class="tag strong">a code: one of {fmt(CODE_VALUES)} values,</text>
            <text x={RX} y={GY + 18} class="tag">picked the way a token id is</text>
            <text x={RX} y="190" class="slab strong small">the {A_SEC} s answer</text>
            <text x={RX} y="206" class="tag">{A_SEC} s ÷ {FRAME_MS} ms = <tspan class="strong">{FRAMES} frames</tspan></text>
            <text x={RX} y="226" class="tag strong">talker</text>
            <text x={RX} y="239" class="tag">{FRAMES} steps</text>
            <text x={RX} y="257" class="tag strong">code predictor</text>
            <text x={RX} y="270" class="tag">{FRAMES} × {CODES_PER_FRAME - 1} = {fmt(FRAMES * (CODES_PER_FRAME - 1))} steps</text>
            <text x={RX} y="288" class="tag strong">code2wav</text>
            <text x={RX} y="301" class="tag">{FRAMES} ÷ {CHUNK} = {FRAMES / CHUNK} passes</text>
          </g>

          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">each talker step reads the next token and the frame just written, so the next frame waits for it</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">SGLang-Omni's settings for Qwen3-Omni: {CHUNK} frames per code2wav pass, each pass rereading up to 25 earlier frames</text>
        </g>
      {/if}
      <!-- 4: the map · every model the request runs, of two kinds, and what passes between them -->
      {#if cur.scene === 'map'}
        {@const VY = 112}
        {@const AY = 232}
        {@const BH = 44}
        {@const EX = 212}
        {@const TX = 352}
        {@const CX = 500}
        {@const BW = 90}
        {@const one = { fill: 'white', stroke: 'var(--fg)' }}
        {@const loop = { fill: 'var(--accent-soft)', stroke: 'var(--accent)' }}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">the whole request, as the models it runs · six, of two kinds</text>
          <g in:fade={{ delay: 1500, duration: 250 }}>
            <rect x="18" y="300" width="16" height="11" rx="3" fill={one.fill} stroke={one.stroke} />
            <text x="42" y="310" class="legend"><tspan class="strong">one pass:</tspan> reads its input, writes its output, and is done</text>
            <rect x="18" y="322" width="16" height="11" rx="3" fill={loop.fill} stroke={loop.stroke} />
            <text x="42" y="332" class="legend"><tspan class="strong">a loop:</tspan> forward, pick, append, as in chapter 1, each step waiting for the one before</text>
          </g>

          <!-- the inputs and the encoders -->
          <g in:fade={{ delay: 300, duration: 250 }}>
            {#each Array(6) as _, r}{#each Array(6) as _, c}
              {@const [fill, op] = tile(r, c)}
              <rect x={18 + c * 7} y={VY - 21 + r * 7} width="6" height="6" fill={fill} opacity={op} />
            {/each}{/each}
            <path d={wave(16, 60, AY, 8, 1.3)} fill="none" stroke="var(--fg)" stroke-width="1.2" opacity="0.8" />
            {#each [{ y: VY, n: 'vision encoder', out: fmt(IMG_POS) }, { y: AY, n: 'audio encoder', out: AUD_POS }] as e}
              <path d="M 64 {e.y} H 76" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#om-arrow)" />
              <rect x="80" y={e.y - BH / 2} width={BW} height={BH} rx="8" fill={one.fill} stroke={one.stroke} />
              <text x={80 + BW / 2} y={e.y - 3} text-anchor="middle" class="tag strong">{e.n}</text>
              <text x={80 + BW / 2} y={e.y + 11} text-anchor="middle" class="tag">1 pass</text>
              <path d="M 174 {e.y} H {EX - 4}" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#om-arrow)" />
              <text x={(170 + EX) / 2} y={e.y - 7} text-anchor="middle" class="tag">{e.out}</text>
            {/each}
          </g>

          <!-- the engine -->
          <g in:fade={{ delay: 600, duration: 250 }}>
            <rect x={EX} y={VY - BH / 2} width={BW} height={AY - VY + BH} rx="10" fill={loop.fill} stroke={loop.stroke} />
            <text x={EX + BW / 2} y={(VY + AY) / 2 - 18} text-anchor="middle" class="tag strong">the engine</text>
            <text x={EX + BW / 2} y={(VY + AY) / 2 - 2} text-anchor="middle" class="tag">prefill: 1 pass,</text>
            <text x={EX + BW / 2} y={(VY + AY) / 2 + 12} text-anchor="middle" class="tag">then a step</text>
            <text x={EX + BW / 2} y={(VY + AY) / 2 + 26} text-anchor="middle" class="tag">per text token</text>
            <path d="M {EX + BW + 4} {VY} H {TX - 4}" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#om-arrow)" />
            <text x={(EX + BW + TX) / 2} y={VY - 7} text-anchor="middle" class="tag">tokens</text>
          </g>

          <!-- talker and code predictor: a frame goes down as code 0 and comes back as 16 codes -->
          <g in:fade={{ delay: 900, duration: 250 }}>
            <rect x={TX} y={VY - BH / 2} width={BW} height={BH} rx="8" fill={loop.fill} stroke={loop.stroke} />
            <text x={TX + BW / 2} y={VY - 3} text-anchor="middle" class="tag strong">talker</text>
            <text x={TX + BW / 2} y={VY + 11} text-anchor="middle" class="tag">{FRAMES} steps</text>
            <rect x={TX} y={AY - BH / 2} width={BW} height={BH} rx="8" fill={loop.fill} stroke={loop.stroke} />
            <text x={TX + BW / 2} y={AY - 3} text-anchor="middle" class="tag strong">code predictor</text>
            <text x={TX + BW / 2} y={AY + 11} text-anchor="middle" class="tag">{fmt(FRAMES * (CODES_PER_FRAME - 1))} steps</text>
            <path d="M {TX + 30} {VY + BH / 2 + 4} V {AY - BH / 2 - 4}" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#om-arrow)" />
            <text x={TX + 24} y={(VY + AY) / 2 + 4} text-anchor="end" class="tag">code 0</text>
            <path d="M {TX + 60} {AY - BH / 2 - 4} V {VY + BH / 2 + 4}" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#om-arrow)" />
            <text x={TX + 66} y={(VY + AY) / 2 - 3} class="tag">the</text>
            <text x={TX + 66} y={(VY + AY) / 2 + 11} class="tag">frame</text>
          </g>

          <!-- code2wav, and the sound -->
          <g in:fade={{ delay: 1200, duration: 250 }}>
            <path d="M {TX + BW + 4} {AY} H {CX - 4}" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#om-arrow)" />
            <text x={(TX + BW + CX) / 2} y={AY - 7} text-anchor="middle" class="tag">{CHUNK} frames</text>
            <rect x={CX} y={AY - BH / 2} width={BW} height={BH} rx="8" fill={one.fill} stroke={one.stroke} />
            <text x={CX + BW / 2} y={AY - 3} text-anchor="middle" class="tag strong">code2wav</text>
            <text x={CX + BW / 2} y={AY + 11} text-anchor="middle" class="tag">{FRAMES / CHUNK} passes</text>
            <path d="M {CX + BW + 4} {AY} H {CX + BW + 16}" fill="none" stroke="#b8b4aa" stroke-width="1.5" marker-end="url(#om-arrow)" />
            <path d={wave(CX + BW + 20, 702, AY, 8, 4.1)} fill="none" stroke="var(--fg)" stroke-width="1.2" opacity="0.8" />
            <text x={CX + BW + 16} y={AY - 16} class="tag">{CHUNK * FRAME_MS} ms of sound each</text>
          </g>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">counts for this request: the {PHOTO} × {PHOTO} photo, the {Q_SEC} s question and the {A_SEC} s answer (steps 2 and 3)</text>
        </g>
      {/if}
      <!-- 5: inside the talker box · the engine's row as in chapters 1–14, the talker's row reading what it writes -->
      {#if cur.scene === 'waits'}
        {@const C0 = 150}
        {@const CW = 34}
        {@const cx = (c: number) => C0 + c * CW}
        {@const mid = (c: number) => cx(c) + (CW - 4) / 2}
        {@const EY = 96}
        {@const TY = 180}
        {@const ENGINE = [null, 'P', '2', '3', null, null, null, '4', '5', '6', null, null, '7', '8', '9', '10']}
        {@const writes = (k: number) => (k === 1 ? 1 : ENGINE.indexOf(String(k)))}
        {@const talker = (() => { const out = [{ c: 2, label: 'P' }]; let c = 2; for (let k = 1; ; k++) { const w = writes(k); if (w < 0) break; c = Math.max(c + 1, w + 1); if (c >= ITERS) break; out.push({ c, label: String(k) }); } return out; })()}
        {@const waits = Array.from({ length: ITERS }, (_, c) => c).filter((c) => c > 2 && !talker.some((t) => t.c === c))}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">can the talker take its next step? · only once the engine has written its token</text>

          <g in:fade={{ delay: 100, duration: 250 }}>
            <text x="16" y={EY + 12} class="tag strong">engine</text>
            <text x="16" y={EY + 25} class="tag">a request as in</text>
            <text x="16" y={EY + 37} class="tag">chapters 1–14</text>
            <text x="16" y={TY + 12} class="tag strong">talker</text>
            <text x="16" y={TY + 25} class="tag">reads what the</text>
            <text x="16" y={TY + 37} class="tag">engine writes</text>
            <rect x={cx(0) - 16} y={EY} width={CW + 12} height="28" rx="4" fill="#ece9e1" stroke="var(--faint)" />
            <text x={cx(0) + 7} y={EY + 18} text-anchor="middle" class="tag strong">prompt</text>
          </g>

          <!-- the engine: its prefill writes token 1, then a token per step; busy where its scheduler runs other requests -->
          {#each ENGINE as e, c}
            {#if c >= 1 && c <= iter}
              {#if e}
                <rect x={cx(c)} y={EY} width={CW - 4} height="28" rx="4" fill="var(--gen-soft)" stroke="var(--gen)" transition:fade={{ duration: 150 }} />
                <text x={mid(c)} y={EY + 18} text-anchor="middle" class="tag strong" transition:fade={{ duration: 150 }}>{e}</text>
              {:else}
                <rect x={cx(c)} y={EY} width={CW - 4} height="28" rx="4" fill="#f3f1eb" stroke="var(--faint)" stroke-dasharray="3 2" transition:fade={{ duration: 150 }} />
                <text x={mid(c)} y={EY + 18} text-anchor="middle" class="tag" transition:fade={{ duration: 150 }}>busy</text>
              {/if}
            {/if}
          {/each}

          <!-- the talker: each step runs the iteration after the engine step that wrote its input -->
          {#each talker as t}
            {#if t.c <= iter}
              <rect x={cx(t.c)} y={TY} width={CW - 4} height="28" rx="4" fill="var(--accent-soft)" stroke="var(--accent)" transition:fade={{ duration: 150 }} />
              <text x={mid(t.c)} y={TY + 18} text-anchor="middle" class="tag strong" transition:fade={{ duration: 150 }}>{t.label}</text>
            {/if}
          {/each}
          {#each waits as c}
            {#if c <= iter}
              <rect x={cx(c)} y={TY} width={CW - 4} height="28" rx="4" fill="var(--eos-soft)" stroke={RED} stroke-dasharray="3 2" transition:fade={{ duration: 150 }} />
              <text x={mid(c)} y={TY + 18} text-anchor="middle" class="tag strong" style:fill={RED} transition:fade={{ duration: 150 }}>wait</text>
            {/if}
          {/each}

          <!-- one axis: iterations, with a dashed line between each so the two rows line up -->
          <g in:fade={{ delay: 300, duration: 250 }}>
            {#each Array(ITERS) as _, c}
              <line x1={cx(c + 1) - 2} y1={EY - 8} x2={cx(c + 1) - 2} y2="258" stroke="var(--line)" stroke-dasharray="3 3" />
            {/each}
            <line x1={cx(0) - 16} y1="258" x2={cx(ITERS)} y2="258" stroke="var(--faint)" />
            {#each Array(ITERS) as _, c}
              <text x={c ? mid(c) : cx(0) + 7} y="272" text-anchor="middle" class="tag">{c ? c : 'arrives'}</text>
            {/each}
            <text x={cx(0) - 16} y="290" class="tag">iterations →</text>
            <text x={cx(ITERS)} y="290" text-anchor="end" class="tag">P = prefill · the engine's prefill also writes token 1 (chapter 1)</text>
            <text x={cx(ITERS)} y="304" text-anchor="end" class="tag">a number: the token that step writes (engine) or reads (talker)</text>
          </g>
          <g in:fade={{ delay: 700 }}>
            <rect x="30" y="321" width="660" height="28" rx="14" fill="var(--accent-soft)" stroke="var(--accent)" />
            <text x={W / 2} y="340" text-anchor="middle" class="need"><tspan class="strong">needed:</tspan> each token handed over as it is written, and a talker loop that checks it has arrived</text>
          </g>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">busy: the engine runs other requests that iteration, such as a prefill (chapter 6) · the talker's frame comes from its own step</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">SGLang-Omni adds the talker's wait: talker_scheduler.py holds a decode batch until every request in it has its next token</text>
        </g>
      {/if}
      <!-- 6: where the talker runs · alone it barely uses a GPU; shared, it and the engine can want the GPU at the same moment -->
      {#if cur.scene === 'gpu'}
        {@const X0 = 130}
        {@const X1 = 700}
        {@const TW = 3}
        {@const engineRun = (x0: number, x1: number, seed: number) => { const out: { x: number; w: number; prefill: boolean }[] = []; let x = x0, i = 0; while (x < x1) { const prefill = i % 7 === 4; const w = Math.min(prefill ? 70 : 20 + ((i * 37 + seed) % 15), x1 - x); out.push({ x, w, prefill }); x += w + 3; i++; } return out; }}
        {@const ticks = (x0: number, x1: number, n: number) => Array.from({ length: n }, (_, i) => x0 + ((i + 0.5) * (x1 - x0)) / n)}
        {@const shared = (() => { const out: { x: number; w: number; talker: boolean; prefill: boolean }[] = []; let x = X0, i = 0, next = X0 + 30; while (x < 430) { if (x >= next) { out.push({ x, w: TW, talker: true, prefill: false }); x += TW + 2; next += 63; continue; } const prefill = i === 4; const w = prefill ? 70 : 20 + ((i * 37 + 7) % 15); out.push({ x, w, talker: false, prefill }); x += w + 2; i++; } return out; })()}
        {@const D = shared[shared.length - 1].x + shared[shared.length - 1].w + 8}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">who gets the GPU? · alone the talker barely uses one; shared, two loops compete for it</text>

          <!-- each model on its own GPU -->
          <g in:fade={{ delay: 100, duration: 250 }}>
            <text x="16" y="72" class="boxtitle">the talker on its own GPU</text>
            <text x="16" y="96" class="tag strong">GPU 0 · engine</text>
            <text x="16" y="124" class="tag strong">GPU 1 · talker</text>
            {#each engineRun(X0, X1, 3) as b}
              <rect x={b.x} y="82" width={b.w} height="20" rx="3" fill="var(--gen)" opacity={b.prefill ? 0.75 : 0.45} />
            {/each}
            <rect x={X0} y="110" width={X1 - X0} height="20" rx="3" fill="#f6f4ee" stroke="var(--line)" />
            {#each ticks(X0, X1, 9) as x}
              <rect x={x} y="110" width={TW} height="20" fill="var(--accent)" />
            {/each}
            <text x={X0} y="148" class="tag strong">the talker's GPU: under 2% utilization over time</text>
          </g>

          <!-- both on one GPU: up to the marked moment, then two pieces of work ready at once -->
          <g in:fade={{ delay: 600, duration: 250 }}>
            <text x="16" y="186" class="boxtitle">the talker and the engine on one GPU</text>
            <text x="16" y="212" class="tag strong">GPU 0 · both</text>
            {#each shared as b}
              <rect x={b.x} y="196" width={b.w} height="22" rx={b.talker ? 1 : 3} fill={b.talker ? 'var(--accent)' : 'var(--gen)'} opacity={b.talker ? 0.9 : b.prefill ? 0.75 : 0.45} />
            {/each}
            <line x1={D} y1="190" x2={D} y2="224" stroke="var(--fg)" stroke-dasharray="3 2" />
            <text x={D} y="238" text-anchor="middle" class="tag strong">now</text>
          </g>
          <g in:fade={{ delay: 1000, duration: 250 }}>
            <rect x={D + 14} y="182" width={TW} height="22" fill="var(--accent)" />
            <text x={D + 26} y="197" class="tag strong">A's next frame · one talker step</text>
            <rect x={D + 14} y="210" width="70" height="22" rx="3" fill="var(--gen)" opacity="0.75" />
            <text x={D + 92} y="225" class="tag strong">C's prefill · the engine</text>
            <text x={D + 14} y="250" class="tag">both ready at once: which goes first?</text>
          </g>

          <g in:fade={{ delay: 1500 }}>
            <text x="16" y="288" class="legend">inside one engine, chapter 6's scheduler made this call; here each model has its own loop, and neither sees the other's queue</text>
          </g>
          <g in:fade={{ delay: 700 }}>
            <rect x="30" y="313" width="660" height="28" rx="14" fill="var(--accent-soft)" stroke="var(--accent)" />
            <text x={W / 2} y="332" text-anchor="middle" class="need"><tspan class="strong">needed:</tspan> a way for two loops to share one GPU, its memory and its time</text>
          </g>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">amber: the engine's work, darker for a prefill · blue: the talker's steps · time runs left to right, not to scale</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">SGLang-Omni's design notes: a talker alone on an H200 sat at under 2% utilization, so stages may now share GPUs</text>
        </g>
      {/if}
    </svg>
  </div>

  <StepControls {step} total={steps.length} caption={cur.caption} {prev} {next} onchange={(s) => (step = s)} />
</figure>
