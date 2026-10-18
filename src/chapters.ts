// Single source of truth for the sidebar and home page. Add a chapter here and an .mdx file in src/pages/ch/.
// Numbering is continuous across parts. Each chapter should end on a question that the next one answers.
export interface Part { id: string; title: string; blurb: string }
export const parts: Part[] = [
  { id: 'loop', title: 'The loop', blurb: 'Why every piece of the engine exists.' },
  { id: 'fast', title: 'Making one GPU fast', blurb: 'The loop is correct; now the step is slow for reasons that have nothing to do with the model.' },
  { id: 'omni', title: 'Beyond text · SGLang Omni', blurb: 'Speech and vision break the assumptions of Part I, one at a time.' },
  { id: 'faster', title: 'More from one GPU', blurb: 'The step is now mostly the weight read: get more tokens out of it, or make it smaller.' },
  { id: 'scale', title: 'More than one GPU', blurb: 'The model, the cache, or the traffic no longer fits on one card.' },
];

export interface Chapter { slug: string; title: string; hook: string; ready: boolean; part: string }
export const chapters: Chapter[] = [
  { part: 'loop', slug: '01-inference', title: 'Bare-minimum inference', hook: 'One function, called in a loop.', ready: true },
  { part: 'loop', slug: '02-attention', title: 'Attention, per decode step', hook: 'What a new token needs from the past.', ready: true },
  { part: 'loop', slug: '03-kv-cache', title: 'KV cache', hook: 'Keep k and v. Drop q.', ready: true },
  { part: 'loop', slug: '04-prefill-decode', title: 'Prefill vs decode', hook: 'Two very different workloads.', ready: true },
  { part: 'loop', slug: '05-batching', title: 'Batching & continuous batching', hook: 'Sharing a GPU between users.', ready: true },
  { part: 'loop', slug: '06-scheduler', title: 'The scheduler', hook: 'Two lists, one GPU, one choice per step.', ready: true },
  { part: 'loop', slug: '07-kv-memory', title: 'KV memory', hook: 'Pages, and the memory cap.', ready: true },
  { part: 'loop', slug: '08-prefix-caching', title: 'Prefix caching', hook: 'Same beginning, one copy.', ready: true },
  { part: 'loop', slug: '09-one-request', title: 'One request, end to end', hook: 'From an HTTP POST to the GPU and back.', ready: true },
  { part: 'loop', slug: '10-engine', title: "The scheduler's loop", hook: 'One Req through one step.', ready: true },

  { part: 'fast', slug: '11-cuda-graphs', title: 'CUDA graphs', hook: 'Launching a thousand kernels as one.', ready: true },
  { part: 'fast', slug: '12-piecewise-cuda-graph', title: 'Piecewise CUDA graphs', hook: 'When the graph has to break.', ready: true },
  { part: 'fast', slug: '13-torch-compile', title: 'torch.compile', hook: 'Fusing the kernels you were about to launch.', ready: true },
  { part: 'fast', slug: '14-attention-backends', title: 'Attention backends', hook: 'Why there are five kernels for one equation.', ready: true },

  { part: 'omni', slug: '15-omni-models', title: 'Omni models', hook: 'Pixels and speech in, speech out.', ready: true },
  { part: 'omni', slug: '16-stages-and-schedulers', title: 'Stages and schedulers', hook: 'Seven stages, three kinds of scheduler.', ready: true },
  { part: 'omni', slug: '17-between-stages', title: 'Between stages', hook: 'Eight edges, four ways to cross them.', ready: true },
  { part: 'omni', slug: '18-sharing-gpus', title: 'Sharing GPUs', hook: 'Several models, one card.', ready: false },
  { part: 'omni', slug: '19-streaming-audio', title: 'Streaming audio decode', hook: 'Output with a real-time deadline.', ready: false },
  { part: 'omni', slug: '20-full-duplex', title: 'Full duplex', hook: 'Listening while speaking.', ready: false },

  { part: 'faster', slug: '21-speculative-decoding', title: 'Speculative decoding', hook: 'Guess several tokens, verify in one step.', ready: true },
  { part: 'faster', slug: '22-quantization', title: 'Quantization', hook: 'Shrinking the read every step pays for.', ready: false },
  { part: 'faster', slug: '23-two-batch-overlap', title: 'Two-batch overlap', hook: 'Hiding communication behind compute.', ready: false },

  { part: 'scale', slug: '24-tensor-parallel', title: 'Tensor parallelism', hook: 'A model bigger than one GPU.', ready: false },
  { part: 'scale', slug: '25-pipeline-expert-parallel', title: 'Pipeline & expert parallelism', hook: 'Splitting by layer, and by expert.', ready: false },
  { part: 'scale', slug: '26-dp-attention', title: 'Data-parallel attention', hook: 'Replicate the attention side, share the rest.', ready: false },
  { part: 'scale', slug: '27-hierarchical-kv', title: 'Hierarchical KV cache', hook: 'When 64 GB is not enough.', ready: false },
  { part: 'scale', slug: '28-disaggregation', title: 'Prefill-decode disaggregation', hook: 'Two clocks, two machines.', ready: false },
  { part: 'scale', slug: '29-router', title: 'The router', hook: 'Many engines, one front door.', ready: false },
];

export interface NavLink { title: string; href: string; ready: boolean }
const base = import.meta.env.BASE_URL.replace(/\/$/, '');
export const hrefOf = (slug: string) => `${base}/ch/${slug}/`;
export const chapterNumber = (slug: string) => chapters.findIndex((c) => c.slug === slug) + 1;

// Previous and next chapter for a slug; used by the header and by the step controls at the first/last step.
export function neighbors(slug: string): { prev?: NavLink; next?: NavLink } {
  const i = chapters.findIndex((c) => c.slug === slug);
  const link = (c?: Chapter) => (c ? { title: c.title, href: hrefOf(c.slug), ready: c.ready } : undefined);
  return { prev: link(chapters[i - 1]), next: link(chapters[i + 1]) };
}
