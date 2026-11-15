/* global __BHAVA_SERVICE_WORKER__ */
/**
 * Where the seller console becomes an installable web app (Phase 8, Q-12): the owner app for iPhone users until the iOS
 * app ships. The manifest is public/manifest.webmanifest, linked from index.html. The service worker is public/sw.js,
 * which the track writes; until that file exists the build sets __BHAVA_SERVICE_WORKER__ false and nothing is asked for.
 *
 * What the worker and the screens around it must hold to:
 *   - the worker's scope is the console only (BASE_URL, /admin/): it never handles a buyer page or an API of another host
 *   - nothing a business owns is cached across a switch of business or a sign-out: call clearBusinessCaches() from both,
 *     and name every cache with CACHE_PREFIX so it is found
 *   - API answers are not cached by the worker at all; only the console's own built files are
 */
export const CACHE_PREFIX = 'bhava-console-';
export const SERVICE_WORKER = Object.freeze({ file: 'sw.js' });

const supported = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator;

/** Registers the worker once the page has loaded. Answers the registration, or null when there is no worker to register. */
export async function registerServiceWorker() {
  const built = typeof __BHAVA_SERVICE_WORKER__ !== 'undefined' && __BHAVA_SERVICE_WORKER__;
  if (!built || !supported()) return null;
  const base = import.meta.env.BASE_URL;
  try {
    return await navigator.serviceWorker.register(`${base}${SERVICE_WORKER.file}`, { scope: base });
  } catch {
    return null; // the console works without it
  }
}

/** Deletes every cache the console made. Call it when the person signs out or changes business, before the next screen loads. */
export async function clearBusinessCaches() {
  if (typeof caches === 'undefined') return 0;
  const names = (await caches.keys()).filter((name) => name.startsWith(CACHE_PREFIX));
  await Promise.all(names.map((name) => caches.delete(name)));
  return names.length;
}
