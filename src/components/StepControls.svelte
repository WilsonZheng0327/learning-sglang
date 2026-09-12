<script lang="ts">
  // Reusable step controller. Every visualization is "a function of a step number";
  // this component owns the number, the caption, playback and keyboard; the viz owns the drawing.
  import type { NavLink } from '../chapters';
  interface Props {
    step: number; total: number; caption: string; onchange: (s: number) => void; interval?: number;
    prev?: NavLink; next?: NavLink;   // neighbouring chapters, offered at the first and last step
  }
  let { step, total, caption, onchange, interval = 2000, prev, next }: Props = $props();
  const atStart = $derived(step === 0);
  const atEnd = $derived(step === total - 1);
  const prevLink = $derived(atStart && prev?.ready ? prev : undefined);
  const nextLink = $derived(atEnd && next?.ready ? next : undefined);

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
  <p class="caption"><span>{@html caption}</span></p>
  <div class="row">
    <div class="buttons">
      <button class="icon" onclick={() => jump(0)} disabled={atStart} title="Reset">↺</button>
      {#if prevLink}
        <a class="chapter" href={prevLink.href}>← {prevLink.title}</a>
      {:else}
        <button class="icon" onclick={() => { stop(); go(-1); }} disabled={atStart} title="Previous">←</button>
      {/if}
      <button class="play" onclick={toggle} title={playing ? 'Pause' : 'Play'}>
        {#if playing}
          <svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.2" y="1.5" width="2.6" height="9" rx="0.7" /><rect x="7.2" y="1.5" width="2.6" height="9" rx="0.7" /></svg>
          <span>Pause</span>
        {:else}
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 1.4v9.2a.5.5 0 0 0 .76.43l7.4-4.6a.5.5 0 0 0 0-.86l-7.4-4.6a.5.5 0 0 0-.76.43z" /></svg>
          <span>Play</span>
        {/if}
      </button>
      {#if nextLink}
        <a class="chapter next" href={nextLink.href}>Next: {nextLink.title} →</a>
      {:else}
        <button class="icon" onclick={() => { stop(); go(1); }} disabled={atEnd} title="Next">→</button>
      {/if}
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
  /* Fixed height (3 lines) so the canvas above never shifts when a caption wraps differently. Keep captions to 3 lines at 60ch. */
  .caption { --lh: 1.45; height: calc(1.3rem * var(--lh) * 3); margin: 0.6rem auto; display: flex; align-items: center; justify-content: center; overflow: hidden; font-size: 1.3rem; line-height: var(--lh); letter-spacing: -0.01em; }
  .caption span { max-width: 60ch; text-align: center; text-wrap: balance; }
  .caption :global(b) { font-weight: 650; }
  .caption :global(code) { font-family: var(--mono); font-size: 0.82em; background: var(--code-bg); padding: 0.1em 0.35em; border-radius: 5px; }
  .row { display: flex; align-items: center; gap: 1rem; }
  .buttons { margin-right: auto; }
  .buttons { display: flex; gap: 0.45rem; }
  button, .chapter { font: inherit; font-size: 0.95rem; height: 40px; display: inline-flex; align-items: center; justify-content: center; line-height: 1; border-radius: 999px; border: 1px solid var(--line); background: white; color: var(--fg); cursor: pointer; transition: border-color 150ms, background 150ms, transform 100ms; }
  button:hover:not(:disabled), .chapter:hover { border-color: var(--faint); }
  button:active:not(:disabled) { transform: translateY(1px); }
  button:disabled { opacity: 0.35; cursor: default; }
  .icon { width: 40px; padding: 0; font-size: 1.05rem; }
  .play { gap: 0.5rem; width: 7.2em; padding: 0; background: var(--accent); color: white; border-color: var(--accent); font-weight: 550; }
  .play:hover:not(:disabled) { border-color: var(--accent); filter: brightness(1.07); }
  .play svg { width: 11px; height: 11px; fill: currentColor; flex: 0 0 auto; }
  .chapter { padding: 0 1rem; font-size: 0.9rem; color: var(--fg); text-decoration: none; white-space: nowrap; }
  .chapter.next { background: var(--accent-soft); border-color: transparent; color: var(--accent); font-weight: 550; }
  .chapter.next:hover { border-color: var(--accent); }
  .progress { display: flex; gap: 5px; }
  .seg { width: 26px; height: 6px; padding: 0; border-radius: 3px; border: 0; background: var(--line); transition: background 200ms; }
  .seg.on { background: var(--accent); opacity: 0.45; }
  .seg.cur { opacity: 1; }
  .seg:hover { opacity: 0.8; background: var(--accent); }
  .counter { font-family: var(--mono); color: var(--muted); font-size: 0.85rem; font-variant-numeric: tabular-nums; }
  .counter em { font-style: normal; color: var(--faint); }
</style>
