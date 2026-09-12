// Single source of truth for the sidebar. Add a chapter here and an .mdx file in src/pages/ch/.
// Each chapter should end on a question that the next one answers.
export interface Chapter { slug: string; title: string; hook: string; ready: boolean }
export const chapters: Chapter[] = [
  { slug: '01-inference', title: 'Bare-minimum inference', hook: 'One function, called in a loop.', ready: true },
  { slug: '02-attention', title: 'Attention, per decode step', hook: 'What a new token needs from the past.', ready: true },
  { slug: '03-kv-cache', title: 'The KV cache', hook: 'Keep k and v. Drop q.', ready: true },
  { slug: '04-prefill-decode', title: 'Prefill vs decode', hook: 'Two very different workloads.', ready: true },
  { slug: '05-batching', title: 'Many requests at once', hook: 'Sharing a GPU between users.', ready: false },
  { slug: '06-engines', title: 'Why engines exist', hook: 'SGLang, from the problems up.', ready: false },
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
