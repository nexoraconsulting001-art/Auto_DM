import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

// The service worker is console/public/sw.js (Phase 8, Q-12). Until that file exists nothing registers one: the page
// asks for it only in a build that has it (see src/pwa/register.js).
const hasServiceWorker = fs.existsSync(path.resolve(here, 'public/sw.js'));

export default defineConfig({
  base: '/admin/',
  define: { __BHAVA_SERVICE_WORKER__: JSON.stringify(hasServiceWorker) },
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
