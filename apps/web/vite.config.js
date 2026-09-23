import { defineConfig } from 'vite';

export default defineConfig({
  // The automatic JSX runtime: esbuild imports what JSX needs, so no file has to import React
  // just to use JSX. Without this Vite emits React.createElement and the page dies on a global
  // that nobody defined.
  esbuild: { jsx: 'automatic' },

  server: {
    // The dashboard talks to the settlement service; in development they are two processes.
    proxy: { '/api': 'http://127.0.0.1:3100' },
  },

  build: { outDir: 'dist' },
});
