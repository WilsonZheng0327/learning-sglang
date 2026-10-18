<script lang="ts">
  import { fade } from 'svelte/transition';
  import StepControls from '../StepControls.svelte';
  import { chapterNumber as chNum, type NavLink } from '../../chapters';
  import { W_GB, BW, GFLOP_PER_TOKEN, TFLOPS, LAYERS } from '../../numbers';
  let { prev, next }: { prev?: NavLink; next?: NavLink } = $props();

  const CH_QUANT = chNum('22-quantization');

  // ---- one request decoding alone, Llama-3-8B on one H100 (Ch. 4 Steps 3 and 5) ----
  const T_READ = (W_GB / (BW * 1000)) * 1000;          // 4.8 ms: the weight read
  const T_TOK = GFLOP_PER_TOKEN / TFLOPS;              // 0.016 ms of math per position
  const fmt1 = (ms: number) => ms.toFixed(1);
  const N = 4;                                          // tokens the example writes
  const T_PLAIN = N * T_READ;                           // 19.1 ms without speculation
  const T_VERIFY = T_READ + (N + 1) * T_TOK;            // 4.9 ms: one pass over 5 positions

  // the running example: chapter 1's prompt, the target's continuation, and a draft that misses on the 4th token
  const CTX = 'The capital of France is';
  const TARGET = [' Paris', '.', ' It', ' is'];
  const DRAFT = [' Paris', '.', ' It', ' has'];
  const KEPT = DRAFT.findIndex((t, i) => t !== TARGET[i]);   // 3 kept, then the target's own token

  // DSpark's Table 1, Qwen3-8B target, accepted length per round (counting the target's own token)
  const TABLE = [
    { d: 'GSM8K · math', v: [5.30, 5.33, 6.17] },
    { d: 'HumanEval · code', v: [4.33, 4.64, 5.52] },
    { d: 'MT-Bench · chat', v: [2.66, 3.11, 3.72] },
  ];

  type Scene = 'before' | 'after' | 'map' | 'eagle' | 'dflash' | 'dspark' | 'compare';
  const steps: { scene: Scene; caption: string }[] = [
    { scene: 'before', caption: `One request decoding alone reads all ${W_GB} GB of weights for every token, ${fmt1(T_READ)} ms each. The same read could check several positions at once, as prefill does with a prompt (Ch. 4 Step 3), if the next tokens were known.` },
    { scene: 'after', caption: `So guess them. A small draft model proposes ${N} tokens, and the target checks all of them in one pass. It keeps the guesses it agrees with and adds its own token at the first miss, here ${KEPT + 1} tokens for one read.` },
    { scene: 'map', caption: `The speedup is tokens kept per round against the time to draft and verify them. EAGLE, DFlash and DSpark are three ways to draft, each from the target's own hidden states.` },
    { scene: 'eagle', caption: `EAGLE drafts with one extra layer on top of the target's hidden states, one token per pass. To guess more in the same time it branches into a tree, and the target checks the whole tree in one pass.` },
    { scene: 'dflash', caption: `DFlash drafts a whole block in one pass: an anchor token and 15 blanks go in, 16 guesses come out. Drafting costs about the same however long the block is, but each guess is made without seeing the others.` },
    { scene: 'dspark', caption: `DSpark keeps DFlash's one-pass block and adds a small sequential head, so each guess sees the one before it. A confidence head then trims guesses unlikely to survive before the target spends a pass on them.` },
    { scene: 'compare', caption: `Retrained on the same data and drafting 7 tokens, DSpark keeps the most per round in every domain. Every round still reads the target's ${W_GB} GB once. What if that read were smaller?` },
  ];

  let step = $state(0);
  $effect(() => {
    const q = Number(new URLSearchParams(window.location.search).get('step'));
    if (q >= 1 && q <= steps.length) step = q - 1;
  });
  const cur = $derived(steps[step]);
  const W = 720, H = 400;
  const RED = 'var(--eos)', GREEN = '#16a34a', DRAFT_C = 'var(--gen)', TARGET_C = 'var(--accent)';

  // the shared time axis of steps 1 and 2
  const X0 = 130, PX_MS = 24;
  const tx = (ms: number) => X0 + ms * PX_MS;
  const T_DRAFT_DRAWN = 0.8;                            // nominal: the draft's cost is steps 4–6's subject
</script>

<figure class="viz">
  <div class="canvas">
    <svg viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Speculative decoding, step {step + 1}">
      <defs>
        {#each [['sd-arrow', '#b8b4aa'], ['sd-arrow-gen', 'var(--gen)'], ['sd-arrow-acc', 'var(--accent)'], ['sd-arrow-fg', 'var(--fg)']] as [id, c]}
          <marker {id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={c} />
          </marker>
        {/each}
      </defs>

      <!-- the time axis steps 1 and 2 share -->
      {#snippet axis(y: number)}
        <line x1={tx(0)} y1={y} x2={tx(20)} y2={y} stroke="var(--faint)" />
        {#each [0, 5, 10, 15, 20] as t}
          <line x1={tx(t)} y1={y} x2={tx(t)} y2={y + 4} stroke="var(--faint)" />
          <text x={tx(t)} y={y + 16} text-anchor="middle" class="tag">{t} ms</text>
        {/each}
      {/snippet}

      <!-- 1: before · one weight read per token -->
      {#if cur.scene === 'before'}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">one request decoding alone · Llama-3-8B on one H100 · one token per step</text>
          <g in:fade={{ delay: 100, duration: 250 }}>
            <rect x="16" y="62" width="166" height="24" rx="6" fill="white" stroke="var(--line)" />
            <text x="99" y="78" text-anchor="middle" class="mono">{CTX}</text>
            <text x="16" y="138" class="tag strong">the target</text>
            <text x="16" y="151" class="tag">one pass a token</text>
            {#each TARGET as t, i}
              <rect x={tx(i * T_READ)} y="126" width={T_READ * PX_MS - 3} height="28" rx="4" fill="#5b5b5b" />
              <text x={tx(i * T_READ) + (T_READ * PX_MS) / 2} y="144" text-anchor="middle" class="tag onbox">reads {W_GB} GB</text>
              <rect x={tx(i * T_READ) + 20} y="98" width={T_READ * PX_MS - 43} height="20" rx="5" fill="var(--accent-soft)" stroke={TARGET_C} />
              <text x={tx(i * T_READ) + (T_READ * PX_MS) / 2 - 1} y="112" text-anchor="middle" class="mono strong">{t.trim() || t}</text>
            {/each}
            <text x={tx(T_PLAIN) + 8} y="144" class="tag strong">{N} tokens · {fmt1(T_PLAIN)} ms</text>
            {@render axis(166)}
          </g>
          <g in:fade={{ delay: 600, duration: 250 }}>
            <text x="16" y="222" class="tag strong">one pass over</text>
            <text x="16" y="235" class="tag strong">5 positions</text>
            <rect x={tx(0)} y="210" width={T_VERIFY * PX_MS - 3} height="28" rx="4" fill="#5b5b5b" />
            <text x={tx(0) + (T_VERIFY * PX_MS) / 2} y="228" text-anchor="middle" class="tag onbox">reads {W_GB} GB</text>
            <text x={tx(T_VERIFY) + 8} y="222" class="tag strong">{fmt1(T_READ)} + 5 × {T_TOK.toFixed(3)} = {fmt1(T_VERIFY)} ms</text>
            <text x={tx(T_VERIFY) + 8} y="236" class="tag">the read is shared; only the math grows (Ch. 4 Step 3)</text>
          </g>
          <g in:fade={{ delay: 1000 }}>
            <text x="18" y="290" class="pt">·</text><text x="28" y="290" class="legend">each step writes one token because the next position needs the token before it (Ch. 1 Step 11)</text>
            <text x="18" y="307" class="pt">·</text><text x="28" y="307" class="legend">a step is the {W_GB} GB read, {fmt1(T_READ)} ms; one token's math is {T_TOK.toFixed(3)} ms of it (Ch. 4 Step 5)</text>
            <text x="18" y="324" class="pt">·</text><text x="28" y="324" class="legend">so if the next 4 tokens were known, one pass could check all of them for about the price of one</text>
          </g>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">batch 1 · the KV cache read is left out, small at this length (Ch. 4 Step 6)</text>
        </g>
      {/if}

      <!-- 2: after · draft 4, verify in one pass, keep the agreed prefix plus the target's own token -->
      {#if cur.scene === 'after'}
        {@const CX = 160}
        {@const CW = 84}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">draft, then verify · the same 4 tokens, one target pass</text>
          <g in:fade={{ delay: 100, duration: 250 }}>
            <text x="16" y="80" class="tag strong" style:fill={DRAFT_C}>① the draft guesses</text>
            <text x="16" y="112" class="tag strong" style:fill={TARGET_C}>② the target, one pass</text>
            <text x="16" y="164" class="tag strong">③ kept</text>
            {#each DRAFT as t, i}
              {@const ok = i < KEPT}
              <rect x={CX + i * CW} y="66" width={CW - 10} height="22" rx="5" fill="var(--gen-soft)" stroke={DRAFT_C} />
              <text x={CX + i * CW + (CW - 10) / 2} y="81" text-anchor="middle" class="mono strong">{t.trim()}</text>
            {/each}
          </g>
          <g in:fade={{ delay: 400, duration: 250 }}>
            {#each TARGET as t, i}
              {@const ok = i < KEPT}
              <rect x={CX + i * CW} y="98" width={CW - 10} height="22" rx="5" fill="var(--accent-soft)" stroke={TARGET_C} />
              <text x={CX + i * CW + (CW - 10) / 2} y="113" text-anchor="middle" class="mono strong">{t.trim()}</text>
              <text x={CX + i * CW + (CW - 10) / 2} y="134" text-anchor="middle" class="tag strong" style:fill={ok ? GREEN : RED}>{ok ? '✓ agrees' : '✗ differs'}</text>
            {/each}
          </g>
          <g in:fade={{ delay: 700, duration: 250 }}>
            {#each TARGET as t, i}
              <rect x={CX + i * CW} y="150" width={CW - 10} height="22" rx="5" fill={i < KEPT ? '#dcfce7' : 'var(--accent-soft)'} stroke={i < KEPT ? GREEN : TARGET_C} />
              <text x={CX + i * CW + (CW - 10) / 2} y="165" text-anchor="middle" class="mono strong">{t.trim()}</text>
            {/each}
            <text x={CX + N * CW + 4} y="158" class="tag">{KEPT} agreed, then the</text>
            <text x={CX + N * CW + 4} y="171" class="tag">target's own at the miss</text>
          </g>

          <g in:fade={{ delay: 1000, duration: 250 }}>
            <text x="16" y="207" class="tag strong">without</text>
            {#each TARGET as _, i}
              <rect x={tx(i * T_READ)} y="194" width={T_READ * PX_MS - 3} height="22" rx="4" fill="#5b5b5b" />
            {/each}
            <text x={tx(T_PLAIN) + 8} y="209" class="tag strong">{N} tokens · {fmt1(T_PLAIN)} ms</text>
            <text x="16" y="239" class="tag strong">with</text>
            <rect x={tx(0)} y="226" width={T_DRAFT_DRAWN * PX_MS - 2} height="22" rx="4" fill={DRAFT_C} opacity="0.8" />
            <rect x={tx(T_DRAFT_DRAWN)} y="226" width={T_VERIFY * PX_MS - 3} height="22" rx="4" fill="#5b5b5b" />
            <text x={tx(T_DRAFT_DRAWN) + (T_VERIFY * PX_MS) / 2} y="241" text-anchor="middle" class="tag onbox">verify · {fmt1(T_VERIFY)} ms</text>
            <text x={tx(T_DRAFT_DRAWN + T_VERIFY) + 8} y="241" class="tag strong">{KEPT + 1} tokens · draft + {fmt1(T_VERIFY)} ms</text>
            {@render axis(258)}
          </g>

          <g in:fade={{ delay: 1400, duration: 250 }}>
            <rect x="30" y="296" width="660" height="28" rx="14" fill="var(--accent-soft)" stroke="var(--accent)" />
            <text x={W / 2} y="315" text-anchor="middle" class="need"><tspan class="strong">time per token</tspan> = (draft + verify) ÷ tokens kept per round</text>
            <text x={W / 2} y="344" text-anchor="middle" class="legend">the output is the target's own: a guess survives only where the target would have written it</text>
          </g>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">amber: the draft, drawn at a nominal length · its real cost is what steps 4–6 are about</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">with sampling, an acceptance test keeps the output's distribution the target's exactly (prose below)</text>
        </g>
      {/if}

      <!-- 3: the map · three drafters, the lever each pulls -->
      {#if cur.scene === 'map'}
        {@const CW = 220}
        {@const CX = [16, 250, 484]}
        {@const cards = [
          { n: 'EAGLE', how: ['one extra layer on the target\'s', 'hidden states, one token a pass'], cost: 'grows with every token drafted', gain: ['a tree of guesses, checked', 'in one target pass'], flag: 'EAGLE3' },
          { n: 'DFlash', how: ['5 layers, a whole block of', '16 guesses in one pass'], cost: 'about flat in the block length', gain: ['long blocks for the', 'cost of one pass'], flag: 'DFLASH' },
          { n: 'DSpark', how: ["DFlash's block pass, plus a", 'small sequential head'], cost: "DFlash's, plus a little", gain: ['later guesses that fit together,', 'and only likely ones verified'], flag: 'DFlash family' },
        ]}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">three drafters · each takes the target's hidden states, not a separate small model</text>
          {#each cards as c, i}
            {@const x = CX[i]}
            <g in:fade={{ delay: 100 + i * 400, duration: 250 }}>
              <rect {x} y="56" width={CW} height="252" rx="12" fill="#fbfaf7" stroke="var(--line)" />
              <text x={x + 14} y="76" class="boxtitle">{i + 1} of 3</text>
              <text x={x + 14} y="96" class="slab strong small">{c.n}</text>
              <!-- how it drafts: passes over time -->
              {#if i === 0}
                {#each Array(5) as _, j}
                  <rect x={x + 14 + j * 38} y="112" width="32" height="20" rx="4" fill={DRAFT_C} opacity="0.8" />
                  <text x={x + 30 + j * 38} y="126" text-anchor="middle" class="tag onbox">{j + 1}</text>
                {/each}
                <text x={x + 14} y="148" class="tag">5 passes, one after another</text>
              {:else}
                <rect x={x + 14} y="112" width="64" height="20" rx="4" fill={DRAFT_C} opacity="0.8" />
                <text x={x + 46} y="126" text-anchor="middle" class="tag onbox">1 pass</text>
                {#if i === 2}
                  {#each Array(4) as _, j}
                    <rect x={x + 86 + j * 14} y="116" width="10" height="12" rx="2" fill={DRAFT_C} opacity="0.45" />
                  {/each}
                  <text x={x + 146} y="126" class="tag">+ head</text>
                {/if}
                <text x={x + 14} y="148" class="tag">{i === 1 ? 'all 16 guesses at once' : 'guesses at once, then linked'}</text>
              {/if}
              <text x={x + 14} y="176" class="tag strong">how it drafts</text>
              {#each c.how as l, j}<text x={x + 14} y={190 + j * 13} class="tag">{l}</text>{/each}
              <text x={x + 14} y="228" class="tag strong">drafting cost</text>
              <text x={x + 14} y="242" class="tag">{c.cost}</text>
              <text x={x + 14} y="266" class="tag strong">what it buys</text>
              {#each c.gain as l, j}<text x={x + 14} y={280 + j * 13} class="tag">{l}</text>{/each}
            </g>
          {/each}
          <text x={W / 2} y="338" text-anchor="middle" class="legend" in:fade={{ delay: 1500 }}>the three levers: draft faster (DFlash), keep more per round (all three), verify less (DSpark)</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">SGLang: --speculative-algorithm EAGLE3 or DFLASH; DSpark runs under the same block flags as DFLASH</text>
        </g>
      {/if}

      <!-- 4: 1 of 3, EAGLE · a one-layer head on the target's features, drafting a tree -->
      {#if cur.scene === 'eagle'}
        {@const SX = 24}
        {@const LH = 5}
        {@const ly = (l: number) => 74 + (LAYERS - 1 - l) * LH}
        {@const TAPS = [3, 16, 29]}
        {@const HX = 150}
        {@const tree = [
          { l: 1, n: 4, keep: 3 }, { l: 2, n: 4, keep: 2 }, { l: 3, n: 4, keep: 1 }, { l: 4, n: 4, keep: 1 }, { l: 5, n: 4, keep: 1 },
        ]}
        {@const TX0 = 440}
        {@const NODES = [
              { id: 'a1', x: 0, y: 0, p: 'r' }, { id: 'a2', x: 0, y: 1, p: 'r' }, { id: 'a3', x: 0, y: 2, p: 'r' },
              { id: 'b1', x: 1, y: 0, p: 'a1' }, { id: 'b2', x: 1, y: 1, p: 'a2' },
              { id: 'c1', x: 2, y: 0, p: 'b1' }, { id: 'd1', x: 3, y: 0, p: 'c1' }, { id: 'e1', x: 4, y: 0, p: 'd1' },
            ]}
        {@const ACC = ['a1', 'b1', 'c1']}
        {@const nx = (c: number) => TX0 + 50 + c * 48}
        {@const ny = (r: number) => 100 + r * 46}
        {@const pos = (id: string) => (id === 'r' ? [TX0 + 6, ny(0)] : (([n]) => [nx(n.x), ny(n.y)])(NODES.filter((n) => n.id === id)))}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">1 of 3 · EAGLE · one extra layer reading the target's hidden states</text>
          <!-- the target's 32 layers, three of them tapped -->
          <g in:fade={{ delay: 100, duration: 250 }}>
            <text x={SX} y="66" class="tag strong">the target · {LAYERS} layers</text>
            {#each Array(LAYERS) as _, l}
              <rect x={SX} y={ly(l)} width="60" height={LH - 1.5} rx="1" fill={TAPS.includes(l) ? TARGET_C : 'var(--line)'} />
            {/each}
            {#each TAPS as l, k}
              <path d="M {SX + 64} {ly(l) + 2} C {SX + 90} {ly(l) + 2}, {HX - 30} 150, {HX - 6} 150" fill="none" stroke={TARGET_C} stroke-width="1.2" marker-end="url(#sd-arrow-acc)" />
              <text x={SX + 66} y={ly(l) - 4} class="tag">{['low', 'middle', 'high'][k]}</text>
            {/each}
          </g>
          <!-- the draft head and its loop -->
          <g in:fade={{ delay: 400, duration: 250 }}>
            <rect x={HX} y="130" width="110" height="40" rx="8" fill="var(--gen-soft)" stroke={DRAFT_C} />
            <text x={HX + 55} y="147" text-anchor="middle" class="tag strong">draft head</text>
            <text x={HX + 55} y="160" text-anchor="middle" class="tag">1 layer</text>
            <path d="M {HX + 114} 150 H {HX + 140}" fill="none" stroke={DRAFT_C} stroke-width="1.4" marker-end="url(#sd-arrow-gen)" />
            <text x={HX + 146} y="146" class="tag strong">a guess</text>
            <text x={HX + 146} y="159" class="tag">fed back in</text>
            <path d="M {HX + 170} 166 V 196 H {HX + 55} V 174" fill="none" stroke={DRAFT_C} stroke-width="1.2" stroke-dasharray="3 2" marker-end="url(#sd-arrow-gen)" />
            <text x={HX + 112} y="210" text-anchor="middle" class="tag">one pass per guess</text>
          </g>
          <!-- the tree: the 8 likeliest guesses sent, a real tree; the path the target accepts in green -->
          <g in:fade={{ delay: 800, duration: 250 }}>
            <text x={TX0} y="66" class="tag strong">8 guesses sent, as a tree</text>
            {#each NODES as n}
              {@const [px, py] = pos(n.p)}
              {@const ok = ACC.includes(n.id)}
              <path d="M {px + 7} {py} L {nx(n.x) - 7} {ny(n.y)}" fill="none" stroke={ok ? GREEN : DRAFT_C} stroke-width={ok ? 2.4 : 1.2} />
            {/each}
            <circle cx={TX0 + 6} cy={ny(0)} r="7" fill={TARGET_C} />
            {#each NODES as n}
              {@const ok = ACC.includes(n.id)}
              <circle cx={nx(n.x)} cy={ny(n.y)} r="7" fill={ok ? GREEN : DRAFT_C} opacity="0.9" />
            {/each}
            <text x={nx(3) - 7} y={ny(0) + 22} class="tag strong" style:fill={RED}>✗ here</text>
            {#each [1, 2, 3, 4, 5] as d, k}
              <text x={nx(k)} y="244" text-anchor="middle" class="tag">step {d}</text>
            {/each}
            <text x={TX0} y="214" class="tag">blue: the last kept token</text>
            <text x={TX0} y="227" class="tag">✗: the target differs and adds its own</text>
          </g>
          <g in:fade={{ delay: 1200 }}>
            <text x="18" y="290" class="pt">·</text><text x="28" y="290" class="legend">the head reads the target's own hidden states, so it starts from what the target already worked out</text>
            <text x="18" y="307" class="pt">·</text><text x="28" y="307" class="legend">each step keeps the likeliest of 4 candidates per branch; the 8 best go to the target in one pass</text>
            <text x="18" y="324" class="pt">·</text><text x="28" y="324" class="legend">green: the longest path the target agrees with · drafting 5 deep takes 5 passes, one after another</text>
          </g>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">EAGLE-3 fuses a low, a middle and a high layer and trains on its own drafts · layer positions drawn for illustration</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">SGLang's defaults for Llama: --speculative-num-steps 5, --speculative-eagle-topk 4, --speculative-num-draft-tokens 8</text>
        </g>
      {/if}

      <!-- 5: 2 of 3, DFlash · one pass over an anchor and 15 blanks; the target's context in every layer's K and V -->
      {#if cur.scene === 'dflash'}
        {@const SX = 24}
        {@const LH = 5}
        {@const ly = (l: number) => 74 + (LAYERS - 1 - l) * LH}
        {@const TAPS = [2, 9, 15, 22, 29]}
        {@const DX = 220}
        {@const DW = 300}
        {@const BLOCK = 16}
        {@const cw = DW / BLOCK}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">2 of 3 · DFlash · a whole block of guesses in one pass</text>
          <g in:fade={{ delay: 100, duration: 250 }}>
            <text x={SX} y="66" class="tag strong">the target</text>
            {#each Array(LAYERS) as _, l}
              <rect x={SX} y={ly(l)} width="50" height={LH - 1.5} rx="1" fill={TAPS.includes(l) ? TARGET_C : 'var(--line)'} />
            {/each}
            {#each TAPS as l}
              <path d="M {SX + 54} {ly(l) + 2} C {SX + 76} {ly(l) + 2}, 96 150, 112 150" fill="none" stroke={TARGET_C} stroke-width="1" />
            {/each}
            <rect x="114" y="132" width="76" height="36" rx="7" fill="var(--accent-soft)" stroke={TARGET_C} />
            <text x="152" y="147" text-anchor="middle" class="tag strong">context</text>
            <text x="152" y="160" text-anchor="middle" class="tag">5 layers, joined</text>
          </g>
          <!-- the drafter: 5 layers, each fed the context through its keys and values -->
          <g in:fade={{ delay: 400, duration: 250 }}>
            {#each Array(5) as _, k}
              {@const y = 104 + k * 18}
              <rect x={DX} {y} width={DW} height="14" rx="3" fill="var(--gen-soft)" stroke={DRAFT_C} />
              <path d="M 192 150 C 204 150, 204 {y + 7}, {DX - 4} {y + 7}" fill="none" stroke={TARGET_C} stroke-width="0.9" marker-end="url(#sd-arrow-acc)" />
            {/each}
            <text x={DX + DW / 2} y="98" text-anchor="middle" class="tag strong">drafter · 5 layers · the context enters every layer's K and V</text>
            <!-- in: the anchor and 15 blanks -->
            {#each Array(BLOCK) as _, j}
              <rect x={DX + j * cw + 1} y="204" width={cw - 2} height="16" rx="2" fill={j ? 'white' : 'var(--accent-soft)'} stroke={j ? 'var(--faint)' : TARGET_C} stroke-dasharray={j ? '2 2' : 'none'} />
            {/each}
            <text x={DX} y="236" class="tag"><tspan class="strong">in:</tspan> the last kept token, then 15 blanks</text>
          </g>
          <g in:fade={{ delay: 800, duration: 250 }}>
            <!-- out: 16 guesses at once -->
            {#each Array(BLOCK) as _, j}
              <rect x={DX + j * cw + 1} y="66" width={cw - 2} height="16" rx="2" fill={DRAFT_C} opacity="0.8" />
            {/each}
            <text x={DX + DW + 8} y="78" class="tag strong">out: 16 guesses,</text>
            <text x={DX + DW + 8} y="91" class="tag strong">one pass</text>
          </g>
          <!-- the cost: passes against block length -->
          <g in:fade={{ delay: 1100, duration: 250 }}>
            <text x={DX + DW + 8} y="140" class="tag strong">passes to draft 7</text>
            <text x={DX + DW + 8} y="160" class="tag">EAGLE</text>
            {#each Array(7) as _, j}
              <rect x={DX + DW + 50 + j * 13} y="151" width="10" height="12" rx="2" fill={DRAFT_C} opacity="0.8" />
            {/each}
            <text x={DX + DW + 8} y="182" class="tag">DFlash</text>
            <rect x={DX + DW + 50} y="173" width="10" height="12" rx="2" fill={DRAFT_C} opacity="0.8" />
          </g>
          <g in:fade={{ delay: 1400 }}>
            <text x="18" y="276" class="pt">·</text><text x="28" y="276" class="legend">one pass makes all 16, so a longer block costs about the same to draft</text>
            <text x="18" y="293" class="pt">·</text><text x="28" y="293" class="legend">each guess is made without seeing the guesses before it, so later ones miss more:</text>
            <text x="28" y="310" class="legend">on chat, 72% of first guesses survive, and 63% by the 7th, given the ones before survived</text>
            <text x="18" y="327" class="pt">·</text><text x="28" y="327" class="legend">5 layers draw a better first guess than EAGLE's 1: 72% against 53% on the same chat test</text>
          </g>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">DFlash: Chen, Liang, Liu (ICML 2026) · tapped layer positions drawn for illustration · block of 16, drafted in one denoising pass</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">the survival rates: DSpark's paper, Qwen3-4B target, drafting 7 at temperature 1 (step 7's setup)</text>
        </g>
      {/if}

      <!-- 6: 3 of 3, DSpark · DFlash's block, a sequential head, then a confidence-scheduled trim before verifying -->
      {#if cur.scene === 'dspark'}
        {@const BX = 120}
        {@const BW2 = 64}
        {@const G = ['.', ' It', ' is', ' a']}
        {@const CONF = [0.95, 0.9, 0.8, 0.3]}
        {@const SURV = CONF.map((_, k) => CONF.slice(0, k + 1).reduce((a, c) => a * c, 1))}
        {@const KEEP = 3}
        {@const gx = (k: number) => BX + k * (BW2 + 12)}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">3 of 3 · DSpark · DFlash's block, a sequential head, and a trim before verifying</text>
          <!-- the parallel block: anchor + blanks in, base guesses out -->
          <g in:fade={{ delay: 100, duration: 250 }}>
            <text x="16" y="252" class="tag strong">in</text>
            <text x="16" y="200" class="tag strong">① parallel</text>
            <text x="16" y="213" class="tag">DFlash, one pass</text>
            {#each Array(4) as _, k}
              <rect x={gx(k)} y="240" width={BW2} height="20" rx="5" fill={k ? 'white' : 'var(--accent-soft)'} stroke={k ? 'var(--faint)' : TARGET_C} stroke-dasharray={k ? '3 2' : 'none'} />
              <text x={gx(k) + BW2 / 2} y="254" text-anchor="middle" class={k ? 'tag' : 'mono strong'}>{k ? 'blank' : 'Paris'}</text>
              <path d="M {gx(k) + BW2 / 2} 236 V 222" fill="none" stroke="#b8b4aa" stroke-width="1.2" marker-end="url(#sd-arrow)" />
            {/each}
            <rect x={gx(0)} y="186" width={gx(3) + BW2 - gx(0)} height="32" rx="8" fill="var(--gen-soft)" stroke={DRAFT_C} />
            <text x={(gx(0) + gx(3) + BW2) / 2} y="206" text-anchor="middle" class="tag strong">base guesses for all 4 positions, at once</text>
          </g>
          <!-- the sequential head: each position nudged by the guess before it -->
          <g in:fade={{ delay: 500, duration: 250 }}>
            <text x="16" y="150" class="tag strong">② sequential</text>
            <text x="16" y="163" class="tag">a small head</text>
            {#each G as t, k}
              <path d="M {gx(k) + BW2 / 2} 182 V 168" fill="none" stroke="#b8b4aa" stroke-width="1.2" marker-end="url(#sd-arrow)" />
              <rect x={gx(k)} y="144" width={BW2} height="20" rx="5" fill={DRAFT_C} opacity="0.85" />
              <text x={gx(k) + BW2 / 2} y="158" text-anchor="middle" class="mono strong" style="fill: white;">{t.trim()}</text>
              {#if k < 3}
                <path d="M {gx(k) + BW2 + 2} 154 H {gx(k + 1) - 2}" fill="none" stroke={DRAFT_C} stroke-width="1.4" marker-end="url(#sd-arrow-gen)" />
              {/if}
            {/each}
          </g>
          <!-- the confidence head and the trim -->
          <g in:fade={{ delay: 900, duration: 250 }}>
            <text x="16" y="104" class="tag strong">③ confidence</text>
            <text x="16" y="117" class="tag">chance to survive</text>
            {#each SURV as a, k}
              <text x={gx(k) + BW2 / 2} y="110" text-anchor="middle" class="tag strong" style:fill={k < KEEP ? 'var(--fg)' : RED}>{a.toFixed(2)}</text>
              <rect x={gx(k)} y="116" width={BW2 * a} height="6" rx="3" fill={k < KEEP ? GREEN : RED} opacity="0.7" />
            {/each}
            <path d="M {gx(KEEP) - 6} 92 V 170" fill="none" stroke={RED} stroke-width="1.4" stroke-dasharray="4 3" />
            <text x={gx(KEEP) + BW2 + 10} y="148" class="tag strong" style:fill={RED}>dropped:</text>
            <text x={gx(KEEP) + BW2 + 10} y="161" class="tag">not worth a</text>
            <text x={gx(KEEP) + BW2 + 10} y="174" class="tag">verify slot</text>
          </g>
          <!-- verification of the kept 3 -->
          <g in:fade={{ delay: 1300, duration: 250 }}>
            <text x="16" y="72" class="tag strong">④ the target</text>
            <text x="16" y="85" class="tag">checks 3, adds 1</text>
            {#each ['.', ' It', ' is', ' known'] as t, k}
              <rect x={gx(k)} y="60" width={BW2} height="20" rx="5" fill={k < KEEP ? '#dcfce7' : 'var(--accent-soft)'} stroke={k < KEEP ? GREEN : TARGET_C} />
              <text x={gx(k) + BW2 / 2} y="74" text-anchor="middle" class="mono strong">{t.trim()}</text>
            {/each}
            <text x={gx(3) + BW2 + 10} y="74" class="tag">the target's own</text>
          </g>
          <!-- why the sequential head: the collision a parallel drafter makes -->
          <g in:fade={{ delay: 1700, duration: 250 }}>
            <rect x="452" y="186" width="252" height="76" rx="8" fill="#fbfaf7" stroke="var(--line)" />
            <text x="464" y="204" class="tag strong">why link the guesses</text>
            <text x="464" y="220" class="tag">both "of course" and "no problem" fit;</text>
            <text x="464" y="234" class="tag">guessed apart: <tspan class="mono strong" style:fill={RED}>of problem</tspan></text>
            <text x="464" y="248" class="tag">linked, "of" pulls <tspan class="mono strong" style:fill={GREEN}>course</tspan> after it</text>
          </g>
          <g in:fade={{ delay: 2000 }}>
            <text x="18" y="296" class="pt">·</text><text x="28" y="296" class="legend">the head is cheap: a bias from the previous guess, so drafting stays about one pass</text>
            <text x="18" y="313" class="pt">·</text><text x="28" y="313" class="legend">a guess survives only if every guess before it does, so the chances multiply along the block</text>
            <text x="18" y="330" class="pt">·</text><text x="28" y="330" class="legend">how many to keep depends on load: in a full batch, every slot spent on a likely miss slows other requests</text>
          </g>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">a block of 4 and its confidences are illustrative · the sequential head here is DSpark's Markov head (rank 256)</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">DSpark: DeepSeek-AI and Peking University (2026) · its scheduler picks each request's length from a profile of the engine's speed</text>
        </g>
      {/if}

      <!-- 7: the comparison · accepted length per round, same training, same draft length -->
      {#if cur.scene === 'compare'}
        {@const GX0 = 90}
        {@const GW = 190}
        {@const YB = 270}
        {@const SC = 26}
        {@const COLS = ['#9ca3af', DRAFT_C, GREEN]}
        <g transition:fade={{ duration: 250 }}>
          <text x="16" y="42" class="rowlabel">tokens kept per round · Qwen3-8B target · each drafter retrained on the same data, drafting 7</text>
          <g in:fade={{ delay: 100, duration: 250 }}>
            {#each ['EAGLE-3', 'DFlash', 'DSpark'] as n, i}
              <rect x={GX0 + i * 110} y="58" width="14" height="10" rx="2" fill={COLS[i]} />
              <text x={GX0 + 20 + i * 110} y="67" class="tag strong">{n}</text>
            {/each}
            {#each [0, 2, 4, 6] as v}
              <line x1={GX0 - 10} y1={YB - v * SC} x2={GX0 + 3 * GW - 20} y2={YB - v * SC} stroke="var(--line)" />
              <text x={GX0 - 16} y={YB - v * SC + 3} text-anchor="end" class="tag">{v}</text>
            {/each}
          </g>
          {#each TABLE as g, gi}
            <g in:fade={{ delay: 300 + gi * 300, duration: 250 }}>
              {#each g.v as v, i}
                {@const x = GX0 + gi * GW + 20 + i * 46}
                <rect {x} y={YB - v * SC} width="38" height={v * SC} rx="3" fill={COLS[i]} opacity="0.85" />
                <text x={x + 19} y={YB - v * SC - 5} text-anchor="middle" class="tag strong">{v.toFixed(2)}</text>
              {/each}
              <text x={GX0 + gi * GW + 20 + 69} y={YB + 16} text-anchor="middle" class="tag strong">{g.d}</text>
            </g>
          {/each}
          <g in:fade={{ delay: 1300 }}>
            <text x="18" y="314" class="pt">·</text><text x="28" y="314" class="legend">chat is harder to guess than math or code for all three; the order holds in every domain</text>
            <text x="18" y="331" class="pt">·</text><text x="28" y="331" class="legend">every round, guesses or not, the target still reads its {W_GB} GB of weights once</text>
          </g>
          <text x={W / 2} y={H - 26} text-anchor="middle" class="footnote">DSpark's Table 1 · chain drafting, temperature 1 · a round's count includes the target's own token</text>
          <text x={W / 2} y={H - 10} text-anchor="middle" class="footnote">making that read smaller: chapter {CH_QUANT}</text>
        </g>
      {/if}
    </svg>
  </div>

  <StepControls {step} total={steps.length} caption={cur.caption} {prev} {next} onchange={(s) => (step = s)} />
</figure>
