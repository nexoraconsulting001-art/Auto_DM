import path from 'node:path';
import express from 'express';
import { log } from '../../platform/log.js';

// Product and reel images come from the seller's own uploads and from web links, so images may load from any https address.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "img-src 'self' https: data: blob:",
  "media-src 'self' https: blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');
const SHELL_HEADERS = { 'Cache-Control': 'no-cache', 'Content-Security-Policy': CONTENT_SECURITY_POLICY };

/**
 * The seller console: the React app built into console/dist, at /admin on every business's own address.
 * The page itself holds no business data, so anyone may load it; the data comes from /api/v1, which checks
 * who is asking. Any path that isn't a file is a page of the app, so deep links and reloads work.
 *
 * ADMIN_UI=console mounts it here; for any other value src/routes/admin.js mounts the same app, so /admin is the console either way.
 */
export const adminConsole = {
  name: 'admin-console',
  routes(app, { config }) {
    if (config.adminUi !== 'console') return;
    const root = config.consoleDir;
    const r = express.Router();

    // Vite puts a hash of the content in these names, so a file never changes.
    r.use('/assets', express.static(path.join(root, 'assets'), { index: false, redirect: false, immutable: true, maxAge: '1y' }));
    r.use(express.static(root, {
      index: false,
      redirect: false,
      maxAge: '1h',
      setHeaders: (res, file) => {
        if (file.endsWith('.html')) res.set(SHELL_HEADERS);
      },
    }));

    r.get(/.*/, (req, res) => {
      if (path.extname(req.path)) return res.status(404).type('text').send('Not found.');
      res.sendFile('index.html', { root, cacheControl: false, headers: SHELL_HEADERS }, (err) => {
        if (!err || res.headersSent) return;
        log.error('admin_console.not_built');
        res.status(503).type('text').send('The console isn’t available right now.');
      });
    });

    app.use('/admin', r);
  },
};
