// Single source of truth for the sidebar. Add a chapter here and an .mdx file in src/pages/ch/.
// Each chapter should end on a question that the next one answers.
export interface Chapter { slug: string; title: string; hook: string; ready: boolean }
export const chapters: Chapter[] = [
  { slug: '01-inference', title: 'Bare-minimum inference', hook: 'One function, called in a loop.', ready: true },
  { slug: '02-attention', title: 'Attention, per decode step', hook: 'What a new token needs from the past.', ready: true },
  { slug: '03-kv-cache', title: 'KV cache', hook: 'Keep k and v. Drop q.', ready: true },
  { slug: '04-prefill-decode', title: 'Prefill vs decode', hook: 'Two very different workloads.', ready: true },
  { slug: '05-batching', title: 'Batching & continuous batching', hook: 'Sharing a GPU between users.', ready: true },
  { slug: '06-scheduler', title: 'The scheduler', hook: 'Two lists, one GPU, one choice per step.', ready: true },
  { slug: '07-kv-memory', title: 'KV memory', hook: 'Pages, and the memory cap.', ready: true },
  { slug: '08-prefix-caching', title: 'Prefix caching', hook: 'Same beginning, one copy.', ready: true },
  { slug: '09-one-request', title: 'One request, end to end', hook: 'From an HTTP POST to the GPU and back.', ready: true },
  { slug: '10-engine', title: "The scheduler's loop", hook: 'One Req through one step.', ready: true },
  { slug: '11-cuda-graphs', title: 'CUDA graphs', hook: 'Launching a thousand kernels as one.', ready: false },
  { slug: '12-tensor-parallel', title: 'Tensor parallelism', hook: 'A model bigger than one GPU.', ready: false },
  { slug: '13-disaggregation', title: 'Prefill-decode disaggregation', hook: 'Two clocks, two machines.', ready: false },
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
