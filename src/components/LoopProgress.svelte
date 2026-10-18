<script lang="ts">
  // A step animation's progress, in the stage's top right corner: it fills once per lap and restarts with the next.
  // `lap` changes when a lap starts; `ms` is one lap's length; `label` says whether it loops. Drawn inside the stage's SVG.
  let { ms, lap, x = 640, y = 20, label = 'loops' }: { ms: number; lap: number; x?: number; y?: number; label?: string } = $props();
</script>

<g aria-hidden="true">
  <text x={x - 6} y={y + 5} text-anchor="end" class="tag">{label}</text>
  <rect {x} {y} width="64" height="5" rx="2.5" fill="var(--line)" />
  {#key lap}
    <rect {x} {y} width="64" height="5" rx="2.5" fill="var(--muted)" class="lp-fill" style="animation-duration: {ms}ms;" />
  {/key}
</g>

<style>
  .lp-fill { transform-box: fill-box; transform-origin: left; animation-name: lp-fill; animation-timing-function: linear; animation-fill-mode: forwards; }
  @keyframes lp-fill { from { transform: scaleX(0); } to { transform: scaleX(1); } }
</style>
