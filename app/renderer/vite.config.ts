// Builds the window's UI (React + Tailwind) into app/out/renderer, which the main process loads from disk.
// `pnpm app:renderer` serves it with hot reload instead; start Electron with SERRA_RENDERER_URL pointing at it.
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Relative asset URLs, so the built page works from a file: URL.
  base: './',
  plugins: [tailwindcss()],
  oxc: { jsx: { runtime: 'automatic' } },
  build: {
    outDir: fileURLToPath(new URL('../out/renderer', import.meta.url)),
    emptyOutDir: true,
    // Electron 45's Chromium.
    target: 'chrome140',
    rolldownOptions: {
      // lucide-react marks its modules "use client" for server rendering, which a single-page app has no use for.
      onwarn: (warning, warn) => { if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning); },
      // Libraries in their own chunk, so neither half passes Vite's 500 kB warning. Both load at start, as before;
      // this only splits the file.
      output: { codeSplitting: { groups: [{ name: 'vendor', test: /node_modules/ }] } },
    },
  },
  server: { port: 5173, strictPort: true },
});
