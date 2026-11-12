import { defineConfig } from 'vitest/config';

// Wrangler imports .html files as text; do the same in tests so the whole Worker can be loaded.
export default defineConfig({
  plugins: [
    {
      name: 'html-as-text',
      enforce: 'pre',
      transform(code, id) {
        if (id.endsWith('.html')) return { code: `export default ${JSON.stringify(code)};`, map: null };
      },
    },
  ],
});
