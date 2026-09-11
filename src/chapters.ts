// Single source of truth for the sidebar. Add a chapter here and an .mdx file in src/pages/ch/.
// Each chapter should end on a question that the next one answers.
export const chapters = [
  { slug: '01-inference', title: 'Bare-minimum inference', hook: 'One function, called in a loop.', ready: true },
  { slug: '02-attention', title: 'Attention, per decode step', hook: 'What a new token needs from the past.', ready: true },
  { slug: '03-kv-cache', title: 'The KV cache', hook: 'Keep k and v. Drop q.', ready: true },
  { slug: '04-prefill-decode', title: 'Prefill vs decode', hook: 'Two very different workloads.', ready: false },
  { slug: '05-batching', title: 'Many requests at once', hook: 'Sharing a GPU between users.', ready: false },
  { slug: '06-engines', title: 'Why engines exist', hook: 'SGLang, from the problems up.', ready: false },
];
