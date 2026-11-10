import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  resolve: {
    // The API contract is plain JS, so screens can reuse its schemas and access rules: @contracts/index.js, @contracts/access.js.
    alias: { '@contracts': path.resolve(here, '../src/contracts/api') },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0, // every asset a real file, so the page's content security policy stays strict
  },
  server: {
    port: 5173,
    fs: { allow: [path.resolve(here, '..')] },
    proxy: { '/api': 'http://localhost:3000', '/media': 'http://localhost:3000' },
  },
});
