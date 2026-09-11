// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import svelte from '@astrojs/svelte';
import { unified } from '@astrojs/markdown-remark';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

// https://astro.build/config
export default defineConfig({
  // For GitHub Pages under a repo, set: site: 'https://<user>.github.io', base: '/learning-sglang'
  integrations: [mdx(), svelte()],
  markdown: {
    // Astro 7 defaults to the Sätteri processor; we use unified so remark/rehype plugins (KaTeX) work.
    processor: unified({ remarkPlugins: [remarkMath], rehypePlugins: [rehypeKatex] }),
    shikiConfig: { theme: 'github-light' },
  },
});
