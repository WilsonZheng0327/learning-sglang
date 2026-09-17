`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md`.

## Commands

```sh
npm install
npx astro dev --background     # then: astro dev stop | astro dev status | astro dev logs
npm run build                  # the only check there is
npm run preview
```

Node >= 22.12 (`engines` in package.json). Dev and preview both serve at
`http://localhost:4321/learning-sglang/` — the `base` path, not the root.

There is no test suite and no linter. `npm run build` is the whole gate; type errors
surface only through it, since `@astrojs/check` is not installed.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)

## Conventions for this site

Moved here from the README so the README stays reader-facing.

## Stack

- **Astro + MDX**: each chapter is `src/pages/ch/NN-name.mdx`. Prose is markdown, visualizations are components dropped inline.
- **Svelte 5** for the interactive components (`src/components/`). Transitions and `$derived` state do the animation work.
- **Fonts** are self-hosted via `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono`, imported in the layout.
- **KaTeX** for math via remark-math/rehype-katex. Two things to leave alone: `katex` in package.json is pinned to the same version rehype-katex bundles (a mismatch breaks subscripts, because the CSS class scheme changed in 0.18), and `astro.config.mjs` passes an explicit `unified()` processor because Astro 7 defaults to Sätteri, which would not run the remark/rehype plugins at all.
- Sidebar order, part grouping, and "coming soon" flags live in `src/chapters.ts`. Site name, tagline, author, and repo link live in `src/site.ts`.

## How a page is assembled

- `src/chapters.ts` is the single source of truth for the roster: four `parts` (`loop`, `fast`, `scale`, `omni`) and one `chapters` entry per chapter (`slug`, `title`, `hook`, `part`, `ready`). `neighbors(slug)` reads from it. The README's chapter table is a second, hand-maintained rendering of the same list — update it in the same commit.
- `src/layouts/Chapter.astro` is the only layout. Chapter frontmatter is just `layout` + `slug`; the layout looks the slug up in `chapters.ts` for the title, hook, number, sidebar highlight, and header prev/next. `index.astro` renders through the same layout with **no** slug, which is what selects the `.home` branch instead of the `.stage` branch.
- `src/styles/global.css` is the whole design system — no Tailwind, no per-component palette. Colours are custom properties on `:root` (`--accent`, `--gen`, `--eos`, `--muted`, `--line`, …); use them instead of literals. `.stage` is a flex column and `.viz` is `flex: 1 1 auto; min-height: 0`, which is why every visualization's root element is `class="viz"` — that's the contract that makes it fill the leftover height.

## Layout philosophy

Each chapter is a **stage**: one visualization filling the viewport, captions as the only narration, no scrolling. Prose is reserved for what the picture cannot say, and goes in a collapsed `<details>` under the stage. Every chapter's last step should end on the question the next chapter answers.

Caption voice: short, plain, factual, the way you'd explain it to a friend at a whiteboard. No throat-clearing, no "let's explore".

**No rhetoric — ever.** A caption explains, or it is cut; there is no third job. No hooks, no punchlines, no aphorisms, no sentence whose work is emphasis rather than information. If a line can't be replaced by a number, a name, or a mechanism, delete it. This binds the legend lines drawn on the stage exactly as hard as the captions — both are narration. Two that had to be rewritten, as calibration:

| rhetoric | what replaced it |
|---|---|
| "What it's worth: single digits." | "Fusing that chain removes 470 MB … about 3%, or 140 µs of 4.8 ms." |
| "What is left to win is inside the kernels, and it comes in percent." | "Chapters 11 and 12 removed 4.2 ms of launch overhead … fusing removes 140 µs, about 30× smaller." |

The closing question is held to the same standard: it must name something visible on the stage, not gesture at a theme. "So why is each link in that chain a separate kernel at all?" was too vague (and collided with the chapter's own argument for cutting things apart); "Nothing but `mul` ever reads what `silu` wrote, and it wants it immediately. So why are they two kernels?" is the same question anchored to two boxes the reader can point at.

Captions are HTML strings rendered with `{@html}`, so `<b>` and `<code>` work inside them. `.caption` is pinned to exactly three lines at 60ch so the canvas above never shifts when a caption wraps differently — a caption that overflows is silently clipped, so keep them inside that budget.

## Chapters

One line each; the MDX and the component are the real record. Slug ⇒ component.

1. `01-inference` / `AutoregressiveGen` — tokenize, forward, pick, append, until EOS. Ends on "what is being recomputed?"
2. `02-attention` / `AttentionStep` — q, k, v per token; a decode step recomputing old k/v identically and never using old q. Ends on "why not keep them?"
3. `03-kv-cache` / `KVCache` — the cache box: fill it, then compute one column and read the whole cache. Ends on "two very different jobs".
4. `04-prefill-decode` / `PrefillDecode` — weights streamed from HBM every step, time bars, a roofline with the ~300-token balance point, a chat timeline. Numbers are Llama-3-8B bf16 on one H100. Ends on batching.
5. `05-batching` / `Batching` — B users share one weight read; static vs continuous batching as slots×steps. Chunked prefill and the memory cap were deliberately moved out (to 06 and 07). Ends on "who goes first?"
6. `06-scheduler` / `Scheduler` — waiting and running lists, one batch per step; prefill-first and its freeze; chunked mixed vs not-mixed; the decision loop. Forward references to 08 and 09 are computed from `chapters.ts` rather than hardcoded.
7. `07-kv-memory` / `KVMemory` — the memory cap, naive reservation and its waste, then paging and page tables. Prefix caching is its own chapter.
8. `08-prefix-caching` / `PrefixCaching` — one copy of a shared prefix, the radix tree, partial matches, the chat case, LRU eviction with pinned running paths.
9. `09-one-request` / `OneRequest` — HTTP POST to tokenizer to scheduler to GPU and back as SSE; why three processes (the GIL timeline) and why ZMQ. Arrowheads are per-colour markers, so a focused arrow changes colour and not just width.
10. `10-engine` / `Engine` — inside the scheduler process: the six-stage pipeline, one `Req` pill travelling it, overlap scheduling as two CPU/GPU timelines, and a file-tree map of `sglang/srt` with chapter badges.
11. `11-cuda-graphs` / `CudaGraphs` — a thousand launches versus one; capture per batch size, padding, why only decode is captured. Ends on what breaks capture (chapter 12).

Chapters 12–26 are outlined in `src/chapters.ts` with `ready: false`.

## The visualization pattern

Every viz is a function of a step number. A component:

1. Declares a small **script** (data for each round), e.g. the prompt tokens and per-round distributions in `AutoregressiveGen.svelte`.
2. Expands it into a flat `steps[]` array where each entry is a full **state**: what is on screen plus a caption.
3. Renders the current state as SVG. Svelte's `in:fly`/`transition:fade` handle the motion between states.
4. Hands `step`/`total`/`caption` to `StepControls.svelte`, which owns prev/next/reset, play/pause (space), progress segments, and arrow keys. One viz per page, since the controls listen on the window. Pass `{...neighbors(slug)}` from the MDX so the first step offers the previous chapter and the last step offers the next one. Arrow keys only move within a chapter.

You write states, never keyframes. To add a step, add an entry. `?step=N` in the URL opens a viz at step N (1-based) so prose can deep-link; every component applies it in an `$effect` after hydration, so the server HTML still matches.

For motion *within* one step (07, 08, 09, 10, 11), the component keeps a `phase` state driven by an `$effect` that reads `step`, resets `phase = 0`, schedules a `setTimeout` per phase, and **returns a cleanup that clears them** — see `KVMemory.svelte`. Without that cleanup, stepping fast leaves phases from the old step firing over the new one.

## Checking steps without a browser

`node scripts/shot.mjs <outDir> <waitMs> name=url ...` screenshots pages through headless chromium with a real wall-clock wait, so Svelte transitions finish. Needs `chromium` on PATH and Node 22+ (it drives the DevTools protocol over the built-in WebSocket). Append `|Space` or `|ArrowRight,ArrowRight` to a url to press keys after load; set `CLIP=x,y,w,h` to capture one region at 2x and `SCALE=2` for a full-page 2x. Plain `chromium --screenshot --virtual-time-budget` freezes delayed transitions mid-flight and is not trustworthy for this site.

## Adding a chapter

1. Add the entry to `src/chapters.ts` with its `part` and `ready: true` (or flip `ready` if it's already outlined there).
2. Add `src/pages/ch/NN-slug.mdx` with the frontmatter shown in `01-inference.mdx` — `layout` and `slug` only; title and hook come from `chapters.ts`.
3. Build its viz by copying `AutoregressiveGen.svelte` and replacing the script and the SVG.
4. Add the row to the README's chapter table.

## Deploy to GitHub Pages

`astro.config.mjs` sets `site` to `https://wilsonzheng0327.github.io` and `base` to `/learning-sglang`; every internal link reads `import.meta.env.BASE_URL`, so the site works under that subpath. `.github/workflows/deploy.yml` builds with `withastro/action` on every push to `main` and publishes with `actions/deploy-pages`. One-time setup: the repo must be public (or on a paid plan) and Pages must be set to "GitHub Actions" as its source.
