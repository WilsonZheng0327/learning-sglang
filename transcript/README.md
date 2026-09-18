# Transcript

Plain text of every ready chapter: each step's caption, the text drawn on the stage once it has settled, and the prose under the stage.
Read it to check wording and numbers across chapters without opening the components. It is generated — edit the source, then run
`node scripts/transcript.mjs` against a running dev server (`ONLY=13` for one chapter).

| # | chapter | steps |
|---|---|---|
| 01 | [Bare-minimum inference](01-inference.md) | 12 |
| 02 | [Attention, per decode step](02-attention.md) | 14 |
| 03 | [KV cache](03-kv-cache.md) | 10 |
| 04 | [Prefill vs decode](04-prefill-decode.md) | 10 |
| 05 | [Batching & continuous batching](05-batching.md) | 9 |
| 06 | [The scheduler](06-scheduler.md) | 9 |
| 07 | [KV memory](07-kv-memory.md) | 7 |
| 08 | [Prefix caching](08-prefix-caching.md) | 8 |
| 09 | [One request, end to end](09-one-request.md) | 10 |
| 10 | [The scheduler's loop](10-engine.md) | 10 |
| 11 | [CUDA graphs](11-cuda-graphs.md) | 14 |
| 12 | [Piecewise CUDA graphs](12-piecewise-cuda-graph.md) | 12 |
| 13 | [torch.compile](13-torch-compile.md) | 11 |
