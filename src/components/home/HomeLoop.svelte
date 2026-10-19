<script lang="ts">
  // Option A · the loop: forward, pick, append, round and round, the sentence growing above it
  const PROMPT = ['The', 'capital', 'of', 'France', 'is'];
  const OUT = ['Paris', '.', 'It', 'is', 'known'];
  const STAGES = ['forward', 'pick', 'append'];
  let n = $state(0);          // tokens appended so far
  let st = $state(0);         // 0 forward, 1 pick, 2 append
  $effect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { n = OUT.length; return; }
    const timers: ReturnType<typeof setTimeout>[] = [];
    const run = () => {
      n = 0; st = 0;
      let t = 600;
      for (let k = 0; k < OUT.length; k++) {
        [0, 1, 2].forEach((s) => { t += 650; timers.push(setTimeout(() => { st = s; if (s === 2) n = k + 1; }, t)); });
      }
      timers.push(setTimeout(run, t + 2400));
    };
    run();
    return () => timers.forEach(clearTimeout);
  });
  const words = $derived([...PROMPT, ...OUT.slice(0, n)]);
  const CX = 260, CY = 200, R = 92;
  const at = (i: number) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / 3; return [CX + R * Math.cos(a), CY + R * Math.sin(a)]; };
</script>

<svg viewBox="0 0 520 320" role="img" aria-label="The loop every chapter builds on: forward, pick, append">
  <defs>
    {#each [['hl-gen', 'var(--gen)'], ['hl-line', '#d9d5cb']] as [id, c]}
      <marker {id} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill={c} /></marker>
    {/each}
  </defs>
  <!-- the sentence so far -->
  <text x="260" y="34" text-anchor="middle" class="sent">
    {#each words as w, i}<tspan class:new={i >= PROMPT.length}>{(i ? ' ' : '') + w}</tspan>{/each}<tspan class="cursor">▍</tspan>
  </text>
  <text x="260" y="56" text-anchor="middle" class="note">the prompt, then one token per turn of the loop</text>

  <!-- the ring: three arcs, each with its arrow; the one being travelled lights up -->
  {#each STAGES as _, i}
    {@const a0 = -Math.PI / 2 + (i * 2 * Math.PI) / 3 + 0.42}
    {@const a1 = -Math.PI / 2 + ((i + 1) * 2 * Math.PI) / 3 - 0.42}
    {@const on = st === (i + 1) % 3}
    <path d="M {CX + R * Math.cos(a0)} {CY + R * Math.sin(a0)} A {R} {R} 0 0 1 {CX + R * Math.cos(a1)} {CY + R * Math.sin(a1)}"
      fill="none" stroke={on ? 'var(--gen)' : 'var(--line)'} stroke-width="2.5" marker-end={on ? 'url(#hl-gen)' : 'url(#hl-line)'} style="transition: stroke 300ms;" />
  {/each}
  {#each STAGES as s, i}
    {@const [x, y] = at(i)}
    <circle cx={x} cy={y} r="34" fill={st === i ? 'var(--accent)' : 'white'} stroke="var(--accent)" stroke-width="1.5" style="transition: fill 250ms;" />
    <text {x} y={y + 4} text-anchor="middle" class="stop" style:fill={st === i ? 'white' : 'var(--fg)'}>{s}</text>
  {/each}
  <text x={CX} y={CY + 4} text-anchor="middle" class="note">until EOS</text>
</svg>

<style>
  svg { display: block; width: 100%; height: auto; font-family: var(--sans); }
  .sent { font-family: var(--mono); font-size: 15px; fill: var(--fg); }
  .sent .new { fill: var(--gen); font-weight: 600; }
  .cursor { fill: var(--accent); animation: blink 1s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .note { font-size: 11px; fill: var(--muted); }
  .stop { font-size: 12px; font-weight: 600; }
</style>
