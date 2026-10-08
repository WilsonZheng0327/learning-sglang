`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md`.

## Commands

```sh
npm install
npx astro dev --background     # then: astro dev stop | astro dev status | astro dev logs
npm run build                  # the type check
npm run preview
npm run transcript             # with the dev server up: transcripts + layout checks (ONLY=N for one chapter)
npm run shot -- <outDir> <waitMs> 'name=url' ...   # screenshots
```

Node >= 22.12 (`engines` in package.json). Dev and preview both serve at
`http://localhost:4321/learning-sglang/` — the `base` path, not the root.

There is no test suite and no linter. `npm run build` is the type gate (type errors surface only
through it, since `@astrojs/check` is not installed); `npm run transcript` is the layout gate.

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
- **Svelte 5** for the interactive components. One visualization per chapter in `src/components/viz/`; `src/components/StepControls.svelte` is the one component they share. Transitions and `$derived` state do the animation work.
- **Fonts** are self-hosted via `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono`, imported in the layout.
- **KaTeX** for math via remark-math/rehype-katex. Two things to leave alone: `katex` in package.json is pinned to the same version rehype-katex bundles (a mismatch breaks subscripts, because the CSS class scheme changed in 0.18), and `astro.config.mjs` passes an explicit `unified()` processor because Astro 7 defaults to Sätteri, which would not run the remark/rehype plugins at all.
- Sidebar order, part grouping, and "coming soon" flags live in `src/chapters.ts`. Site name, tagline, author, and repo link live in `src/site.ts`. The book's running numbers (the H100 and Llama-3-8B constants) live in `src/numbers.ts`.
- `scripts/` holds the checking tools (below); `scripts/lib/browser.mjs` is the headless Chrome they share. `transcript/` is their generated output.

## How a page is assembled

- `src/chapters.ts` is the single source of truth for the roster: five `parts`, in reading order (`loop`, `fast`, `omni`, `faster`, `scale`) and one `chapters` entry per chapter (`slug`, `title`, `hook`, `part`, `ready`). `neighbors(slug)` reads from it. The README's chapter table is a second, hand-maintained rendering of the same list — update it in the same commit.
- `src/layouts/Chapter.astro` is the only layout. Chapter frontmatter is just `layout` + `slug`; the layout looks the slug up in `chapters.ts` for the title, hook, number, sidebar highlight, and header prev/next. `index.astro` renders through the same layout with **no** slug, which is what selects the `.home` branch instead of the `.stage` branch.
- `src/styles/global.css` is the design system for the page — no Tailwind, no per-component palette. Colours are custom properties on `:root` (`--accent`, `--gen`, `--eos`, `--muted`, `--line`, …); use them instead of literals. `.stage` is a flex column and `.viz` is `flex: 1 1 auto; min-height: 0`, which is why every visualization's root element is `class="viz"` — that's the contract that makes it fill the leftover height.
- `src/styles/stage.css` is the design system for the stage: the `.viz` / `.canvas` frame and the SVG text classes every chapter uses (`.rowlabel`, `.boxtitle`, `.tag`, `.mono`, `.kname`, `.steplabel`, `.slab`, `.legend`, `.footnote`, `.pt`). Its rules sit inside `:where(.viz)`, so a component's own scoped rule for a class overrides it; a component restyles a class only where it means to differ, and does not copy the shared rule.

## Layout philosophy

Each chapter is a **stage**: one visualization filling the viewport, captions as the only narration, no scrolling. Prose is reserved for what the picture cannot say, and goes in a collapsed `<details>` under the stage. Every chapter's last step should end on the question the next chapter answers.

Caption voice: short, plain, factual, the way you'd explain it to a friend at a whiteboard. No throat-clearing, no "let's explore".

**No rhetoric — ever.** A caption explains, or it is cut; there is no third job. No hooks, no punchlines, no aphorisms, no sentence whose work is emphasis rather than information. If a line can't be replaced by a number, a name, or a mechanism, delete it. This binds the legend lines drawn on the stage exactly as hard as the captions — both are narration. Two that had to be rewritten, as calibration:

| rhetoric | what replaced it |
|---|---|
| "What it's worth: single digits." | "Fusing that chain removes 470 MB … about 3%, or 140 µs of 4.8 ms." |
| "What is left to win is inside the kernels, and it comes in percent." | "Chapters 11 and 12 removed 4.2 ms of launch overhead … fusing removes 140 µs, about 30× smaller." |

The closing question is held to the same standard: it must name something visible on the stage, not gesture at a theme. "So why is each link in that chain a separate kernel at all?" was too vague (and collided with the chapter's own argument for cutting things apart); "Nothing but `mul` ever reads what `silu` wrote, and it wants it immediately. So why are they two kernels?" is the same question anchored to two boxes the reader can point at.

## Designing a chapter

These are the author's rules, gathered from chapter reviews. A chapter that breaks one comes back.

**Motivation first.** Open with the cost or the problem, in numbers the reader can check against earlier chapters, before any mechanism. Chapter 14 opens with the bytes attention reads against the 16 GB weight read; chapter 13 opens with the silu→mul intermediate's 28 KB. The first step of a chapter is the reason the chapter exists.

**Nothing assumed.** Every term, name and number is either explained on the step where it appears or was explained on a step the reader has already passed. A reader has only what the chapters have shown so far. Standard jargon is not exempt: warp, SM, extend, un-project, flops per byte each had to be glossed or cut.

**Build it for a reader who knows nothing, and interrogate every mark while you build.** The stage has to stand on its own: if the author needs outside context to follow a step, the step has failed, however correct it is. While building, keep asking the reader's questions of every element on the stage, and answer each one there:

- *Where did this number come from?* Put the arithmetic beside it, or name the step that derived it: `8,192 × 128 × k, v × 2 B = 4.2 MB`, `16 is the most with 8 × 16 ≤ 132`. A number with no visible source is decoration.
- *What is this thing, and what is it doing here?* Every noun (block, SM, tile, chunk) is defined on this step or one the reader passed, in words that say what it does in this picture: "each walks its head's 8,192 keys", not just "8 blocks".
- *What does each colour and shade mean?* One meaning per colour per step, shown with a swatch. Two greys need two labels. A status colour (busy SMs) must not reuse the colour of the thing being animated (keys being read).
- *What is being compared?* A before/after or with/without is labelled as one on the stage (`WITHOUT THE SPLIT` / `WITH THE SPLIT`), in the same layout and scale, with the changed quantity computed on both sides.
- *What are the axes?* Name the rows and columns of any grid (`keys →`, `queries`), and tie a mark that stands for an idea (an outlined column: one key's K/V used by 4 queries) to the line that states it.

Calibration: chapter 14's split-KV step first showed 8 blocks racing 128 with no word on what a block was, what each walked, where 8,192 came from, or what an SM was, and its SM grid was the same red as the animation. Its prefill grid had two greys and one label.

**One picture per step, and the picture carries the point.** Text is for what the picture cannot say. Start from the visualization, not the caption; if a step is mostly text, redesign it. When a step's picture is the previous step's picture with one thing changed (three kernels, then the same box with S and P gone), keep the layout identical so the change is the only difference on screen.

**Before and after.** When a step claims something was reduced, draw both states on the same scale, with the quantity that changed labelled on each. Chapter 14's closing has one bar per state; chapter 13's step 9 has bytes above time.

**Enumerations need a map.** When a chapter walks through several parallel things, add a step that names them, says what kind of thing each is, and says how they relate (alternatives, axes, layers), then head each following step with its place in that map (`what forces a new kernel · 2 of 4`). Without this the steps read as a flat list and the reader cannot tell whether items are alternatives or orthogonal; that was the failure of chapter 14's first draft.

**Steps chain.** Each step should follow from the one before, and the last step ends on the question the next chapter answers, anchored to something visible on the stage.

**Depth is a choice, stated.** Some mechanisms are deliberately not explained (chapter 14 shows only the rescaling identity behind online softmax, and its prose says the rest of FlashAttention's design is not covered; its split-KV timings say they assume an even share of bandwidth per SM). Say what is skipped rather than hand-waving it.

**Work one step at a time.** When a design is in question, build one step, screenshot it, show it, and wait; do not rebuild the whole chapter on a guess. The author reviews step by step and iterates.

**Numbers stay consistent across chapters.** Llama-3-8B bf16 on one H100: 16 GB of weights, 3.35 TB/s, 4.8 ms per weight read, 989 TFLOP/s, 0.016 ms of math per token, 128 KB of KV per token, 300-token balance point, 9.0 ms eager step, 4.2 ms of launches removed by chapters 11–12. Import them from `src/numbers.ts` and derive every number in the component from them rather than typing results, so a change propagates. When a chapter measures a step, say what it is measured against (the weight read, the step's total) and what is left out.

## Reviewing a step

Run this on every step before calling a chapter done. It is how the author reviews, and a step that fails it comes back.

**Every point on the stage.** For each claim, name, number, or term: is it explained on this step, or on an earlier step or chapter that the reader has passed? If not, do one of three things: explain it in one tag, simplify it until it needs no explanation, or delete it. "Warps", "SM", "extend", "un-project", "flops per byte" have each slipped through once; a term the reader has not met is a hole, however standard it is. A forward reference to a library or flag that only appears later is a hole too.

**Every visualization.** Does it convey one point on its own? Does reading it need context that is not on the same step? A picture that needs the caption to be decoded has failed; a picture whose point is stated only in a legend line beneath it is halfway. Numbers a reader cannot check (a "134 MB" with no arithmetic beside it) are decoration, not evidence.

**Layout.** Every component needs margin around it so it reads as a distinct thing: no label touching a neighbour's box, no arrow crossing text, no two labels within a few pixels of each other. SVG text does not wrap: a line that is too long must be split by hand into two `<text>` elements, never left to run past the stage. Budget at 10px tags is about 4.9 px per character, at 11.5px legend lines about 5.6, at 11px mono row labels about 6.6; the stage is 720 wide. `npm run transcript` measures every `<text>` and reports text that runs past the stage, text that overlaps other text, captions over three lines, and breaks of the text rules below; a chapter is not finished while it reports anything.

Stage text comes in three kinds, and each has one treatment across the whole site:

- **Footnotes.** Grey text of footnote nature — a source, a flag or code name (`SGLang: --enable-torch-compile`), an assumption or simplification, a forward reference, an aside — is a `.footnote`: centred at the bottom of the stage (`x={W / 2} y={H - 10} text-anchor="middle"`; a second one goes at `H - 26`), never marked. Grey is only for footnotes: a grey line that carries the step's point is regular text.
- **Several statements.** When two or more separate statements are stacked, each gets the small centre dot: `<text x="18" y=… class="pt">·</text>` just left of the line, with the line at x=28 (or dot 10 left of wherever the line starts). A statement that runs onto a second line gets no dot on the continuation, so a dot always means a new statement. No round bullets.
- **One statement.** A lone line gets no dot; it is just the line.

A hyphenated name in a caption (`FlashAttention-3`) goes through `nb()` so it cannot break at the hyphen.

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
12. `12-piecewise-cuda-graph` / `PiecewiseGraphs` — prefill is launch-bound below ~560 tokens; padding fixes the total but not the sequence boundaries, and only attention reads those; cut at every attention, 33 pieces, replay them around eager attention; token-count rungs; `torch.compile` as the tracer that cuts. Ends on the two pointwise kernels the tracer handed back untouched (chapter 13).
13. `13-torch-compile` / `TorchCompile` — the silu→mul intermediate that never needed HBM; why eager materialises it; Inductor writes Triton kernels for pointwise and reduction chains and picks library matmuls; tiles, and autotuning at batch 16 where a square tile is mostly padding; the worth (140 µs of 4.8 ms, against the weight read, shown as a loop between two states: the piece in red, then gone and left as a dashed outline, crossfading) and the startup bill as a grid. Ends on attention, the one kernel none of 11–13 touched (chapter 14).
14. `14-attention-backends` / `AttentionBackends` — what attention reads (batch × context × 128 KB, passing the weights at ~480 tokens at batch 256); attention as three kernels over one HBM box, with S and P defined (KaTeX in a `foreignObject`) and then costed (34 MB per head, 35 GB per 2,000-token prompt); FlashAttention as the same picture with S and P gone, a looping chunk walk, and only the rescaling identity shown; then a map of the four things that force a different kernel in two columns, inside every backend (how many queries, where K/V sit) and picking the backend (head layout, GPU); one step each with a `k of 4` header, heads first so "uses per K/V byte" (MHA 1, GQA 4, MLA 128) is defined before prefill's 512 is set against chapter 4's ~300; decode's split-KV as its own step (`WITHOUT` / `WITH THE SPLIT` panels in one layout: a looping race of 8 blocks against 128, SMs in their own dark colour, every number derived beside it, at an even 1/132 of bandwidth per SM, stated as a simplification); pages as without/with (packed consecutive rows whose address the kernel computes, against a pool read through `kv_indices`, with `kv_indptr` pointing at its boundaries); the GPU step as a table of what each generation added, with FlashAttention-2 against FlashAttention-3 on one H100 (35% and 75% of peak) as the evidence; then three steps that each open with the question they answer: the `AttentionBackend` interface as the map's inside column in code (the model calling one interface, the slots tagged with their map rows and steps, the backends that fill them); the backend table, numbered columns matching the map, defaults from `get_default_attn_backend`, the book's setup (fa3) highlighted; and a closing step for one request decoding alone (its next token against its next 5 consecutive positions in one pass), hidden from `ORDER` until speculative decoding follows this chapter again, so the chapter ends at the backend table. Stage step numbers come from `at(scene)`, so reordering `ORDER` keeps them right.

15. `15-omni-models` / `OmniModels` — the first Omni chapter, following Qwen3-Omni as SGLang-Omni serves it (constants in `src/numbers.ts`). A photo and a spoken question in, a spoken answer out, set beside chapter 1's text request with a `?` converter on each side; the left `?` opened (an encoder per input: 896 ÷ 32 = 28, 28 × 28 = 784 positions; 10 × 13 = 130), which SGLang already does inside prefill; the right `?` opened as a looping animation of the write order (each token goes to the detokenizer and to the talker; code 0 from the talker, codes 1–15 from the code predictor, frame by frame; code2wav turns each 10 frames into 800 ms of sound); a map of the six models in two kinds (one pass, a loop) with this request's counts; the talker's input still being written while it runs (an engine row with prefill and busy iterations, a talker row that waits); and the talker's GPU (under 2% utilization alone, per SGLang-Omni's notes; shared, a small talker step can land behind a long prefill). Steps 5 and 6 each state their need in a `needed:` pill; the last asks what decides how the loops share a GPU and how tokens cross (chapter 16).

Chapters 16–29 are outlined in `src/chapters.ts` with `ready: false`: the rest of SGLang Omni (16–20: stages and schedulers, between stages, sharing GPUs, streaming audio, full duplex) comes straight after chapter 15, then the rest of the single-GPU chapters (21–23) and multi-GPU (24–29). A slug's number is its position, so reordering the roster means renaming slugs and every `chNum('NN-…')` forward reference to them.

## The visualization pattern

Every viz is a function of a step number. A component:

1. Declares a small **script** (data for each round), e.g. the prompt tokens and per-round distributions in `AutoregressiveGen.svelte`.
2. Expands it into a flat `steps[]` array where each entry is a full **state**: what is on screen plus a caption.
3. Renders the current state as SVG. Svelte's `in:fly`/`transition:fade` handle the motion between states.
4. Hands `step`/`total`/`caption` to `StepControls.svelte`, which owns prev/next/reset, progress segments, and arrow keys. One viz per page, since the controls listen on the window. Pass `{...neighbors(slug)}` from the MDX so the first step offers the previous chapter and the last step offers the next one. Arrow keys only move within a chapter.

You write states, never keyframes. To add a step, add an entry. `?step=N` in the URL opens a viz at step N (1-based) so prose can deep-link; every component applies it in an `$effect` after hydration, so the server HTML still matches.

For motion *within* one step (07, 08, 09, 10, 11, 13, 14), the component keeps a `phase` state driven by an `$effect` that reads `step`, resets `phase = 0`, schedules a `setTimeout` per phase, and **returns a cleanup that clears them** — see `KVMemory.svelte`. Without that cleanup, stepping fast leaves phases from the old step firing over the new one.

A phased animation that a reader needs to follow should **loop** rather than run once: schedule the cycle to repeat with a pause at the start (chapter 14's chunk walk: four chunks at 1.4 s each, the finished state, a 2.6 s rest, then again). A one-shot sequence is missed if the reader looks away, and the controls give no way to replay it short of leaving and re-entering the step. Do not add a second level of stepping inside a step; the arrow keys and progress bar are one-step-per-chapter-step across the site.

Typeset math on the stage goes through KaTeX inside a `<foreignObject>` (`katex.renderToString`, see `AttentionBackends.svelte`); SVG `<text>` cannot draw a fraction or a sum legibly.

## Checking steps without a browser

`npm run shot -- <outDir> <waitMs> name=url ...` (`scripts/shot.mjs`) screenshots pages through headless Chrome with a real wall-clock wait, so Svelte transitions finish. Needs Node 22+; it finds Chrome itself (`$CHROME`, then `chromium` or `google-chrome` on PATH, then the macOS app). Quote each `name=url` in zsh, where an unquoted `?step=` is a glob. Append `|ArrowRight,ArrowRight` to a url to press keys after load; set `CLIP=x,y,w,h` to capture one region at 2x and `SCALE=2` for a full-page 2x. Plain `chromium --screenshot --virtual-time-budget` freezes delayed transitions mid-flight and is not trustworthy for this site. Chrome throttles background tabs, which stalls Svelte transitions (old scenes linger, new text never fades in); `scripts/lib/browser.mjs` launches with that throttling off, so any script that drives more than one tab must go through it.

`npm run transcript` (`scripts/transcript.mjs`; same requirements, plus a running dev server) writes `transcript/NN-slug.md` for every ready chapter: each step's caption, every piece of text on the stage once its phases have settled (a dot shows as `·`, a footnote as `_footnote:_`), and the chapter's prose. Read those to check wording and numbers across chapters instead of opening the components; `ONLY=13` regenerates one chapter. It also checks every step and flags, in the file and on stdout: captions over three lines, text past the stage's edge, text overlapping text, a footnote not centred at the bottom or sitting on a drawn shape, a leftover grey `.legend.muted` line, a lone dot, and a round bullet. The files are generated — edit the component or MDX, then rerun, and commit the regenerated transcript with the change.

The loop that works: edit the component → `npm run build` (the only type check) → `npm run shot` for the steps you touched → look at every screenshot, not just the last one → `ONLY=N npm run transcript` for the checks → fix → repeat until the check is silent and the screenshots have no collisions. Within-step animations (phases) need screenshots at more than one delay to be judged. Never call a step done from the code alone.

## Adding a chapter

1. Add the entry to `src/chapters.ts` with its `part` and `ready: true` (or flip `ready` if it's already outlined there).
2. Add `src/pages/ch/NN-slug.mdx` with the frontmatter shown in `01-inference.mdx` — `layout` and `slug` only; title and hook come from `chapters.ts`.
3. Build its viz in `src/components/viz/` by copying `AutoregressiveGen.svelte` and replacing the script and the SVG. Take its numbers from `src/numbers.ts` and its text classes from `src/styles/stage.css`.
4. Add the row to the README's chapter table.

## Deploy to GitHub Pages

`astro.config.mjs` sets `site` to `https://wilsonzheng0327.github.io` and `base` to `/learning-sglang`; every internal link reads `import.meta.env.BASE_URL`, so the site works under that subpath. `.github/workflows/deploy.yml` builds with `withastro/action` on every push to `main` and publishes with `actions/deploy-pages`. One-time setup: the repo must be public (or on a paid plan) and Pages must be set to "GitHub Actions" as its source.
