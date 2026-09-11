<script lang="ts">
  // Reusable step controller. Every visualization is "a function of a step number";
  // this component owns the number, the caption, playback and keyboard; the viz owns the drawing.
  interface Props { step: number; total: number; caption: string; onchange: (s: number) => void; interval?: number }
  let { step, total, caption, onchange, interval = 2000 }: Props = $props();

  let playing = $state(false);
  let timer: ReturnType<typeof setInterval> | undefined;

  function go(delta: number) {
    const next = Math.min(total - 1, Math.max(0, step + delta));
    if (next !== step) onchange(next);
  }
  function stop() { playing = false; clearInterval(timer); timer = undefined; }
  function play() {
    if (step >= total - 1) onchange(0);
    playing = true;
    timer = setInterval(() => { step >= total - 1 ? stop() : onchange(step + 1); }, interval);
  }
  function toggle() { playing ? stop() : play(); }
  function jump(s: number) { stop(); onchange(s); }
  $effect(() => () => clearInterval(timer));

  // One viz per page, so the whole window drives it: ← → step, space plays.
  function onkey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (t && /^(input|textarea|select)$/i.test(t.tagName)) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); stop(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); stop(); go(-1); }
    else if (e.key === ' ') { e.preventDefault(); toggle(); }
  }
  const pad = (n: number) => String(n).padStart(2, '0');
</script>

<svelte:window onkeydown={onkey} />

<div class="controls">
  <p class="caption">{@html caption}</p>
  <div class="row">
    <div class="buttons">
      <button class="icon" onclick={() => jump(0)} disabled={step === 0} title="Reset">↺</button>
      <button class="icon" onclick={() => { stop(); go(-1); }} disabled={step === 0} title="Previous">←</button>
      <button class="play" onclick={toggle}>{playing ? '❚❚' : '▶'}<span>{playing ? 'Pause' : 'Play'}</span></button>
      <button class="icon" onclick={() => { stop(); go(1); }} disabled={step === total - 1} title="Next">→</button>
    </div>
    <div class="progress" role="tablist">
      {#each Array(total) as _, i}
        <button class="seg" class:on={i <= step} class:cur={i === step} onclick={() => jump(i)} aria-label="step {i + 1}"></button>
      {/each}
    </div>
    <span class="counter">{pad(step + 1)} <em>/</em> {pad(total)}</span>
  </div>
</div>

<style>
  .controls { font-family: var(--sans); flex: 0 0 auto; }
  .caption { min-height: 2.9em; margin: 1rem auto 0.9rem; max-width: 60ch; text-align: center; font-size: 1.3rem; line-height: 1.45; letter-spacing: -0.01em; text-wrap: balance; }
  .caption :global(b) { font-weight: 650; }
  .caption :global(code) { font-family: var(--mono); font-size: 0.82em; background: var(--code-bg); padding: 0.1em 0.35em; border-radius: 5px; }
  .row { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 1.25rem; }
  .buttons { display: flex; gap: 0.45rem; }
  button { font: inherit; font-size: 0.95rem; height: 40px; border-radius: 999px; border: 1px solid var(--line); background: white; color: var(--fg); cursor: pointer; transition: border-color 150ms, background 150ms, transform 100ms; }
  button:hover:not(:disabled) { border-color: var(--faint); }
  button:active:not(:disabled) { transform: translateY(1px); }
  button:disabled { opacity: 0.35; cursor: default; }
  .icon { width: 40px; padding: 0; font-size: 1.05rem; }
  .play { display: inline-flex; align-items: center; gap: 0.55rem; padding: 0 1.15rem 0 1rem; min-width: 7.2em; background: var(--accent); color: white; border-color: var(--accent); font-weight: 550; }
  .play:hover:not(:disabled) { border-color: var(--accent); filter: brightness(1.07); }
  .play span { font-size: 0.95rem; }
  .progress { display: flex; gap: 5px; }
  .seg { width: 26px; height: 6px; padding: 0; border-radius: 3px; border: 0; background: var(--line); transition: background 200ms; }
  .seg.on { background: var(--accent); opacity: 0.45; }
  .seg.cur { opacity: 1; }
  .seg:hover { opacity: 0.8; background: var(--accent); }
  .counter { justify-self: end; font-family: var(--mono); color: var(--muted); font-size: 0.85rem; font-variant-numeric: tabular-nums; }
  .counter em { font-style: normal; color: var(--faint); }
</style>
