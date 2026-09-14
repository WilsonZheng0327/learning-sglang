## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

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
5. `05-batching` / `Batching.svelte`: B users share one weight read (stat tiles), the ~300 sweet spot, a ragged request timeline, static batching defined, the slots×steps grid for static vs continuous batching with prefill columns drawn wider and marked ⫽, and the closing "who goes first? a scheduler's job". Chunked prefill and the memory cap were deliberately moved out: chunked prefill belongs to 06 (scheduler), the memory cap to 07 (KV memory).
6. `06-scheduler` / `Scheduler.svelte`: opens on chapter 5's stretched step; two lists (waiting, running) and one batch per step; the two shapes (show, don't tell) and why they get separate batches, with forward references to 08 (disaggregation) and 09 (CUDA graphs) computed from `chapters.ts`; prefill-first and its freeze; batched prefill; chunked not-mixed vs chunked mixed, with a step-type strip under every timeline; the three-policy comparison; the decision loop.
7. `07-kv-memory` / `KVMemory.svelte`: room for KV cache with total/in-use/empty brackets; the cap as three bars (4k/8k/32k); naive reservation (waste, then fragmentation); animated paging: a newcomer's block splits into pages that fly into free slots and its page table appears; a request finishing returns its pages; the next newcomer takes them; the closing count (free ≥ needed) with retraction as the fallback. Prefix caching is its own chapter (08). Within-step animations use a `phase` state advanced by timeouts, replayed on every step change.
8. `08-prefix-caching` / `PrefixCaching.svelte`: two requests with the same first 512 tokens paged twice, then B's table pointing at A's pages; why only a prefix can be shared; the radix tree; a newcomer matching 812 of 992; the chat case (each turn = previous turn + question); LRU eviction with pinned running paths; the waiting list under FCFS vs longest-prefix-match.
9. `09-one-request` / `OneRequest.svelte`: launch the server; a JSON POST arrives; tokenization; why one process can't host the GPU loop (GIL timeline with idle gaps); three processes on three cores; ZMQ first as an animated queue between two processes (put and move on; take all at the top of a step), then why ZMQ rather than a pipe or HTTP; the request becoming a `Req` inside the scheduler; the request through the scheduler; streaming back as server-sent events; thousands of clients with real numbers (open connections vs running vs waiting, what one step carries, backpressure). Arrowheads are per-colour markers so a focused arrow changes colour, not just width. The scheduler's internals are chapter 10.
10. `10-engine` / `Engine.svelte` ("The scheduler's loop"): inside the scheduler process. Left: inbox, waiting_queue, running_batch, outbox. Middle: the six-stage pipeline (recv_requests, get_next_batch_to_run, ScheduleBatch → tensors, ModelRunner.forward, Sampler, process_batch_result). Right: RadixCache, TokenToKVPool, GPU. One red `Req` pill travels through the stages with a CSS transform transition. Then overlap scheduling as two CPU/GPU timelines (plan t+1 starts right after launching t; results t processed during t+1), a step on the future-token placeholder that makes it possible, and a file-tree map of sglang/srt with chapter badges.


## The visualization pattern

Every viz is a function of a step number. A component:

1. Declares a small **script** (data for each round), e.g. the prompt tokens and per-round distributions in `AutoregressiveGen.svelte`.
2. Expands it into a flat `steps[]` array where each entry is a full **state**: what is on screen plus a caption.
3. Renders the current state as SVG. Svelte's `in:fly`/`transition:fade` handle the motion between states.
4. Hands `step`/`total`/`caption` to `StepControls.svelte`, which owns prev/next/reset, play/pause (space), progress segments, and arrow keys. One viz per page, since the controls listen on the window. Pass `{...neighbors(slug)}` from the MDX so the first step offers the previous chapter and the last step offers the next one. Arrow keys only move within a chapter.

You write states, never keyframes. To add a step, add an entry. `?step=N` in the URL opens a viz at step N (1-based) so prose can deep-link.

## Checking steps without a browser

`node scripts/shot.mjs <outDir> <waitMs> name=url ...` screenshots pages through headless chromium with a real wall-clock wait, so Svelte transitions finish. Append `|Space` or `|ArrowRight,ArrowRight` to a url to press keys after load; set `CLIP=x,y,w,h` to capture one region at 2x and `SCALE=2` for a full-page 2x. Plain `chromium --screenshot --virtual-time-budget` freezes delayed transitions mid-flight and is not trustworthy for this site.

## Adding a chapter

1. Add `src/pages/ch/NN-slug.mdx` with the frontmatter shown in `01-inference.mdx`.
2. Flip `ready: true` for it in `src/chapters.ts`.
3. Build its viz by copying `AutoregressiveGen.svelte` and replacing the script and the SVG.

## Deploy to GitHub Pages

`astro.config.mjs` sets `site` to `https://wilsonzheng0327.github.io` and `base` to `/learning-sglang`; every internal link reads `import.meta.env.BASE_URL`, so the site works under that subpath. `.github/workflows/deploy.yml` builds with `withastro/action` on every push to `main` and publishes with `actions/deploy-pages`. One-time setup: the repo must be public (or on a paid plan) and Pages must be set to "GitHub Actions" as its source. Locally the dev and preview servers now serve at `http://localhost:4321/learning-sglang/`.
