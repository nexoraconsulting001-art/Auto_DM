import { clearBusinessCaches } from '../../pwa/register.js';
import { HINT_KEY, INSTALL_PATH, isStandalone, shouldShowHint } from './rules.js';
import './install.css';

/**
 * The installed console's part of the page (Phase 8, Q-12), started when the console loads:
 *
 *   - It clears the console's caches when the person signs out and when the console starts showing another business. The
 *     worker never stores an API answer, so this is a second lock: whatever an older version left behind goes too.
 *   - It says so when the phone is offline, with a Try again button, so an opened-but-empty shell never looks broken.
 *   - On an iPhone in Safari it shows a small hint, once, on how to add the console to the home screen.
 *
 * The page's fetch is wrapped as the business switcher wraps it (features/account/workspace.js); the two do not depend
 * on which was wrapped first.
 */
const API_PREFIX = '/api/v1/';
let started = false;
/** The business the last session answer named. A different one means a switch of business (or a new sign-in). */
let lastBusiness = null;
let installPrompt = null;

const subscribers = new Set();
const tell = () => subscribers.forEach((fn) => fn());
/** For the install page: re-render when the browser offers the install prompt. */
export const onInstallChange = (fn) => {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
};
export const canPromptInstall = () => installPrompt !== null;
export async function promptInstall() {
  const event = installPrompt;
  if (!event) return 'unavailable';
  installPrompt = null;
  tell();
  await event.prompt();
  const choice = await event.userChoice.catch(() => null);
  return choice?.outcome ?? 'dismissed';
}

function apiPath(input) {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    const url = new URL(raw, globalThis.location.href);
    if (url.origin !== globalThis.location.origin || !url.pathname.startsWith(API_PREFIX)) return null;
    return url.pathname.slice(API_PREFIX.length - 1);
  } catch {
    return null;
  }
}

function watchSessions() {
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init = {}) => {
    const path = apiPath(input);
    if (path === null) return original(input, init);
    const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
    const response = await original(input, init);
    if (path === '/auth/logout' && method === 'POST') {
      lastBusiness = null;
      await clearBusinessCaches(); // sign-out: nothing of this business stays on the phone
    } else if (path === '/auth/me' && method === 'GET') {
      if (response.status === 401) {
        lastBusiness = null;
        await clearBusinessCaches();
      } else if (response.ok) {
        const body = await response.clone().json().catch(() => null);
        const id = body?.business?.id ?? null;
        if (id !== null && lastBusiness !== null && id !== lastBusiness) await clearBusinessCaches(); // switch of business
        if (id !== null) lastBusiness = id;
      }
    }
    return response;
  };
}

function button(label, onClick, className = 'install-btn') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function bar(className, text, ...controls) {
  const el = document.createElement('div');
  el.className = `install-bar ${className}`;
  el.setAttribute('role', 'status');
  const words = document.createElement('span');
  words.textContent = text;
  el.append(words, ...controls);
  return el;
}

function watchConnection() {
  let offline = null;
  const sync = () => {
    const down = navigator.onLine === false;
    if (down && !offline) {
      offline = bar('install-offline', 'You are offline. Your business shows again when you are connected.', button('Try again', () => location.reload()));
      document.body.append(offline);
    } else if (!down && offline) {
      offline.remove();
      offline = null;
    }
  };
  addEventListener('online', sync);
  addEventListener('offline', sync);
  sync();
}

function showHint() {
  let dismissed = false;
  try {
    dismissed = localStorage.getItem(HINT_KEY) === 'dismissed';
  } catch {
    // no storage: the hint shows each visit
  }
  if (!shouldShowHint({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints, standalone: isStandalone(), dismissed })) return;
  const el = bar('install-hint', 'Add Bhava to your home screen to open it like an app.');
  const how = document.createElement('a');
  how.className = 'install-btn';
  how.href = INSTALL_PATH;
  how.textContent = 'How';
  el.append(how, button('Not now', () => {
    try {
      localStorage.setItem(HINT_KEY, 'dismissed');
    } catch {
      // nothing to remember it in
    }
    el.remove();
  }, 'install-btn install-btn-quiet'));
  document.body.append(el);
}

/**
 * The worker's scope is /admin/, so a page opened as /admin (no slash) is outside it and would run without the worker. Say
 * /admin/ in the address bar before the router starts; the console's own routes are the same either way.
 */
function stayInScope() {
  try {
    const { pathname, search, hash } = globalThis.location;
    const base = import.meta.env.BASE_URL.replace(/\/$/, '');
    if (base && pathname === base) globalThis.history.replaceState(globalThis.history.state, '', `${base}/${search}${hash}`);
  } catch {
    // the address stays as it was
  }
}

export function startInstallLive() {
  if (started || typeof document === 'undefined') return;
  started = true;
  stayInScope();
  watchSessions();
  addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    tell();
  });
  addEventListener('appinstalled', () => {
    installPrompt = null;
    tell();
  });
  const run = () => {
    watchConnection();
    showHint();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
  else run();
}

startInstallLive();
