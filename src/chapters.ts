// Single source of truth for the sidebar and home page. Add a chapter here and an .mdx file in src/pages/ch/.
// Numbering is continuous across parts. Each chapter should end on a question that the next one answers.
export interface Part { id: string; title: string; blurb: string }
export const parts: Part[] = [
  { id: 'loop', title: 'The loop', blurb: 'Why every piece of the engine exists.' },
  { id: 'fast', title: 'Making one GPU fast', blurb: 'The loop is correct; now the step is slow for reasons that have nothing to do with the model.' },
  { id: 'scale', title: 'More than one GPU', blurb: 'The model, the cache, or the traffic no longer fits on one card.' },
  { id: 'omni', title: 'Beyond text · SGLang Omni', blurb: 'Speech and vision break the assumptions of Part I, one at a time.' },
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
  { part: 'fast', slug: '14-attention-backends', title: 'Attention backends', hook: 'Why there are five kernels for one equation.', ready: false },
  { part: 'fast', slug: '15-speculative-decoding', title: 'Speculative decoding', hook: 'Guess several tokens, verify in one step.', ready: false },
  { part: 'fast', slug: '16-quantization', title: 'Quantization', hook: 'Shrinking the read every step pays for.', ready: false },
  { part: 'fast', slug: '17-two-batch-overlap', title: 'Two-batch overlap', hook: 'Hiding communication behind compute.', ready: false },

  { part: 'scale', slug: '18-tensor-parallel', title: 'Tensor parallelism', hook: 'A model bigger than one GPU.', ready: false },
  { part: 'scale', slug: '19-pipeline-expert-parallel', title: 'Pipeline & expert parallelism', hook: 'Splitting by layer, and by expert.', ready: false },
  { part: 'scale', slug: '20-dp-attention', title: 'Data-parallel attention', hook: 'Replicate the attention side, share the rest.', ready: false },
  { part: 'scale', slug: '21-hierarchical-kv', title: 'Hierarchical KV cache', hook: 'When 64 GB is not enough.', ready: false },
  { part: 'scale', slug: '22-disaggregation', title: 'Prefill-decode disaggregation', hook: 'Two clocks, two machines.', ready: false },
  { part: 'scale', slug: '23-router', title: 'The router', hook: 'Many engines, one front door.', ready: false },

  { part: 'omni', slug: '24-multimodal-inputs', title: 'Multimodal inputs', hook: 'A stage in front of the loop.', ready: false },
  { part: 'omni', slug: '25-multistage-inference', title: 'Multi-stage inference', hook: 'Thinker, talker, and the pipe between them.', ready: false },
  { part: 'omni', slug: '26-streaming-audio', title: 'Streaming audio decode', hook: 'Output with a real-time deadline.', ready: false },
  { part: 'omni', slug: '27-full-duplex', title: 'Full duplex', hook: 'Listening while speaking.', ready: false },
];

export interface NavLink { title: string; href: string; ready: boolean }
const base = import.meta.env.BASE_URL.replace(/\/$/, '');
export const hrefOf = (slug: string) => `${base}/ch/${slug}/`;

// Previous and next chapter for a slug; used by the header and by the step controls at the first/last step.
export function neighbors(slug: string): { prev?: NavLink; next?: NavLink } {
  const i = chapters.findIndex((c) => c.slug === slug);
  const link = (c?: Chapter) => (c ? { title: c.title, href: hrefOf(c.slug), ready: c.ready } : undefined);
  return { prev: link(chapters[i - 1]), next: link(chapters[i + 1]) };
}
