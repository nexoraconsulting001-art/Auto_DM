/*
 * The seller console's service worker (Phase 8, Q-12). It makes the console open fast and say it is offline instead of
 * going blank, and nothing more:
 *
 *   - It handles only GET requests to this site under the console's own scope (/admin/). Buyer pages, another origin and
 *     every write go straight through.
 *   - It never stores or serves an answer from the API (/api/) or a business's media (/media/), whoever is signed in, so
 *     nothing of one business can appear after a switch of business or a sign-out. The console's data is always live.
 *   - It keeps the app shell (the console page) and the console's own built files: scripts, styles, fonts, icons.
 *     The page is fetched from the network first and the stored copy is only the fallback when the network is down.
 *     Built files carry a hash of their content in the name, so a stored one never goes stale.
 *   - An update replaces the old shell at once: the new worker skips waiting, takes over every open page and deletes
 *     every console cache but its own. Caches of anything else are left alone.
 *
 * Bump VERSION when this file's rules change so every phone fetches it again.
 */
const VERSION = 'v1';
const PREFIX = 'bhava-console-';
const CACHE = `${PREFIX}shell-${VERSION}`;
const SCOPE_PATH = '/admin/';
const absolute = (path) => new URL(path, self.location.origin).href;
const SHELL = absolute(SCOPE_PATH);
const PRECACHE = [SHELL, `${SCOPE_PATH}manifest.webmanifest`, `${SCOPE_PATH}favicon.svg`, `${SCOPE_PATH}icons/icon-192.png`, `${SCOPE_PATH}icons/apple-touch-icon.png`];
const STATIC_FILE = /\.(?:js|css|svg|png|jpe?g|webp|woff2?|webmanifest|ico)$/i;
const NEVER = /(?:^|\/)(?:api|media)(?:\/|$)/;

const OFFLINE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bhava for Business</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F6F5F1;color:#16152B;font-family:system-ui,sans-serif;text-align:center;padding:24px}
main{max-width:22rem}h1{font-size:1.4rem;margin:0 0 .5rem}p{margin:0 0 1.25rem;line-height:1.5}
button{background:#3B2FC9;color:#fff;border:0;border-radius:12px;padding:.8rem 1.4rem;font-size:1rem;min-height:44px}</style></head>
<body><main><h1>You are offline</h1><p>Bhava needs a connection to show your business. Check your internet connection and try again. Nothing is lost.</p>
<button type="button" onclick="location.reload()">Try again</button></main></body></html>`;

const offlineResponse = () => new Response(OFFLINE_PAGE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

/** True for a request this worker may answer: a GET of this site, inside the console, that is not an API or media call. */
function mine(request) {
  if (request.method !== 'GET') return false;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.origin !== self.location.origin) return false;
  if (url.pathname !== '/admin' && !url.pathname.startsWith(SCOPE_PATH)) return false;
  if (NEVER.test(url.pathname) || url.pathname.endsWith('/sw.js')) return false;
  if (request.headers.get('authorization')) return false;
  return true;
}

const isNavigation = (request) => request.mode === 'navigate' || request.destination === 'document';

async function precache() {
  const cache = await caches.open(CACHE);
  for (const path of PRECACHE) {
    try {
      const response = await self.fetch(absolute(path), { cache: 'reload' });
      if (response && response.ok) await cache.put(absolute(path), response);
    } catch {
      // The shell is stored later, the first time it is opened.
    }
  }
}

/** Deletes every console cache but the current one, and anything that is not a shell or a built file from the current one. */
async function cleanUp() {
  for (const name of await caches.keys()) {
    if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
  }
  if (!(await caches.has(CACHE))) return;
  const cache = await caches.open(CACHE);
  for (const request of await cache.keys()) {
    if (NEVER.test(new URL(request.url).pathname)) await cache.delete(request);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(cleanUp().then(() => self.clients.claim()));
});

async function navigation(request) {
  try {
    const response = await self.fetch(request);
    const type = response.headers.get('content-type') || '';
    if (response.ok && !response.redirected && type.includes('text/html')) {
      const cache = await caches.open(CACHE);
      await cache.put(SHELL, response.clone());
    }
    return response;
  } catch {
    const shell = await caches.open(CACHE).then((cache) => cache.match(SHELL));
    return shell || offlineResponse();
  }
}

/** Built files (/assets/, named by a hash of their content) never change: the stored copy is used first. The few others (icons, manifest) are fetched first so they never go stale. */
async function builtFile(request) {
  const cache = await caches.open(CACHE);
  const hashed = new URL(request.url).pathname.startsWith(`${SCOPE_PATH}assets/`);
  const stored = await cache.match(request);
  if (stored && hashed) return stored;
  try {
    const response = await self.fetch(request);
    if (response.ok && response.type !== 'opaque') await cache.put(request, response.clone());
    return response;
  } catch (error) {
    if (stored) return stored;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!mine(request)) return;
  if (isNavigation(request)) {
    event.respondWith(navigation(request));
    return;
  }
  if (STATIC_FILE.test(new URL(request.url).pathname)) event.respondWith(builtFile(request).catch(() => Response.error()));
});
