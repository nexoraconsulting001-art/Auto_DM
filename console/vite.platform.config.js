import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * public/ is the seller console's: its service worker, its manifest (scope /admin/) and its app icons. Copied whole into this
 * build they would put the seller's installable app on the platform host, so this build copies no public/ at all and takes
 * only the brand marks the console's own screens draw (asset('logo.svg') and the page icon).
 */
const BRAND_MARKS = ['favicon.svg', 'logo.svg', 'logo-white.svg'];
const brandMarks = () => ({
  name: 'platform-brand-marks',
  generateBundle() {
    for (const fileName of BRAND_MARKS) this.emitFile({ type: 'asset', fileName, source: fs.readFileSync(path.join(here, 'public', fileName)) });
  },
});

/**
 * The Platform Console: the second entry of this project. It shares src/design and src/lib with the seller console and
 * nothing else, and builds into its own folder, so no file of it is ever in the seller bundle (console/dist) or served on
 * a business's address. The server mounts dist-platform at /console on the platform host only (src/modules/platform-console).
 */
export default defineConfig({
  base: '/console/',
  plugins: [react(), brandMarks()],
  publicDir: false,
  resolve: {
    alias: { '@contracts': path.resolve(here, '../src/contracts/api') },
  },
  build: {
    outDir: 'dist-platform',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rollupOptions: { input: path.resolve(here, 'platform.html') },
  },
  server: {
    port: 5174,
    fs: { allow: [path.resolve(here, '..')] },
  },
});
