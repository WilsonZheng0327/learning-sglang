# Learning SGLang

A motivation-driven, visualization-heavy walkthrough of LLM inference, ending at why engines like SGLang exist.

## Run

```sh
npm install
npm run dev        # http://localhost:4321
npm run build      # static site in dist/
```

## Stack

- **Astro + MDX**: each chapter is `src/pages/ch/NN-name.mdx`. Prose is markdown, visualizations are components dropped inline.
- **Svelte 5** for the interactive components (`src/components/`). Transitions and `$derived` state do the animation work.
- **Fonts** are self-hosted via `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono`, imported in the layout.
- **KaTeX** for math via remark-math/rehype-katex. `katex` in package.json is pinned to the same version rehype-katex bundles; a mismatch breaks subscripts because the CSS class scheme changed in 0.18.
- Sidebar order and "coming soon" flags live in `src/chapters.ts`.

## Layout philosophy

Each chapter is a **stage**: one visualization filling the viewport, captions as the only narration, no scrolling. Prose is reserved for what the picture cannot say, and goes in a collapsed `<details>` under the stage. Every chapter's last step should end on the question the next chapter answers.

Caption voice: short, plain, factual, the way you'd explain it to a friend at a whiteboard. No throat-clearing, no "let's explore".

Chapters so far:

1. `01-inference` / `AutoregressiveGen.svelte`: tokenize, forward, pick, append, until EOS. Ends on "what is being recomputed?"
2. `02-attention` / `AttentionStep.svelte`: q, k, v per token, one token attending, then a decode step showing old k/v recomputed identically and old q unused. Ends on "why not keep them?"
3. `03-kv-cache` / `KVCache.svelte`: the same grid plus a cache box. The first step fills it, decode steps compute one column and read the whole cache, q is shown as never read again, then the per-token cost. Ends on "two very different jobs" (prefill vs decode).
4. `04-prefill-decode` / `PrefillDecode.svelte`: names the two step types, then one step on the GPU: weights streamed from HBM every step, n tokens riding that read, time bars (memory vs compute), the KV-cache read, a roofline-style chart with the ~300-token balance point, a chat timeline (time to first token vs per-token), and the idle-compute closer. Numbers are Llama-3-8B bf16 on one H100. Ends on "what if it weren't one person?" (batching).


## The visualization pattern

Every viz is a function of a step number. A component:

1. Declares a small **script** (data for each round), e.g. the prompt tokens and per-round distributions in `AutoregressiveGen.svelte`.
2. Expands it into a flat `steps[]` array where each entry is a full **state**: what is on screen plus a caption.
3. Renders the current state as SVG. Svelte's `in:fly`/`transition:fade` handle the motion between states.
4. Hands `step`/`total`/`caption` to `StepControls.svelte`, which owns prev/next/reset, play/pause (space), progress segments, and arrow keys. One viz per page, since the controls listen on the window. Pass `{...neighbors(slug)}` from the MDX so the first step offers the previous chapter and the last step offers the next one (arrow keys follow suit).

You write states, never keyframes. To add a step, add an entry. `?step=N` in the URL opens a viz at step N (1-based) so prose can deep-link.

## Checking steps without a browser

`node scripts/shot.mjs <outDir> <waitMs> name=url ...` screenshots pages through headless chromium with a real wall-clock wait, so Svelte transitions finish. Append `|Space` or `|ArrowRight,ArrowRight` to a url to press keys after load; set `CLIP=x,y,w,h` to capture one region at 2x and `SCALE=2` for a full-page 2x. Plain `chromium --screenshot --virtual-time-budget` freezes delayed transitions mid-flight and is not trustworthy for this site.

## Adding a chapter

1. Add `src/pages/ch/NN-slug.mdx` with the frontmatter shown in `01-inference.mdx`.
2. Flip `ready: true` for it in `src/chapters.ts`.
3. Build its viz by copying `AutoregressiveGen.svelte` and replacing the script and the SVG.

## Deploy to GitHub Pages

Set `site` and `base` in `astro.config.mjs`, then publish `dist/`.
