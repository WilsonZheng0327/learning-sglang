<script lang="ts">
  // Reusable step controller. Every visualization is "a function of a step number";
  // this component owns the number, the caption and the keyboard; the viz owns the drawing.
  import type { NavLink } from '../chapters';
  interface Props {
    step: number; total: number; caption: string; onchange: (s: number) => void;
    prev?: NavLink; next?: NavLink;   // neighbouring chapters, offered at the first and last step
  }
  let { step, total, caption, onchange, prev, next }: Props = $props();
  const atStart = $derived(step === 0);
  const atEnd = $derived(step === total - 1);
  const prevLink = $derived(atStart && prev?.ready ? prev : undefined);
  const nextLink = $derived(atEnd && next?.ready ? next : undefined);

  function go(delta: number) {
    const next = Math.min(total - 1, Math.max(0, step + delta));
    if (next !== step) onchange(next);
  }
  function jump(s: number) { if (s !== step) onchange(s); }

  // One viz per page, so the whole window drives it: ← → step.
  function onkey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (t && /^(input|textarea|select)$/i.test(t.tagName)) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
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
        <button class="icon" onclick={() => go(-1)} disabled={atStart} title="Previous">←</button>
      {/if}
      {#if nextLink}
        <a class="chapter next" href={nextLink.href}>Next: {nextLink.title} →</a>
      {:else}
        <button class="icon" onclick={() => go(1)} disabled={atEnd} title="Next">→</button>
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
