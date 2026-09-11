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


## The visualization pattern

Every viz is a function of a step number. A component:

1. Declares a small **script** (data for each round), e.g. the prompt tokens and per-round distributions in `AutoregressiveGen.svelte`.
2. Expands it into a flat `steps[]` array where each entry is a full **state**: what is on screen plus a caption.
3. Renders the current state as SVG. Svelte's `in:fly`/`transition:fade` handle the motion between states.
4. Hands `step`/`total`/`caption` to `StepControls.svelte`, which owns prev/next/reset, play/pause (space), step dots, and arrow keys. One viz per page, since the controls listen on the window.

You write states, never keyframes. To add a step, add an entry. `?step=N` in the URL opens a viz at step N (1-based) so prose can deep-link.

## Adding a chapter

1. Add `src/pages/ch/NN-slug.mdx` with the frontmatter shown in `01-inference.mdx`.
2. Flip `ready: true` for it in `src/chapters.ts`.
3. Build its viz by copying `AutoregressiveGen.svelte` and replacing the script and the SVG.

## Deploy to GitHub Pages

Set `site` and `base` in `astro.config.mjs`, then publish `dist/`.
