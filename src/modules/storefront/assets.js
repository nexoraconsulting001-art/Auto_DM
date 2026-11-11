import { STORE_LIMITS } from '../../contracts/orders.js';
import { buyerTheme } from '../../views/buyer/index.js';
import { safeHref } from '../../views/buyer/layout.js';

/**
 * What the store's pages load besides themselves (PRD 9.1, 9.2): the bag script, the home-screen app's manifest and its
 * service worker. The manifest and worker are answered on each business's own address, so two stores on one phone are two
 * apps (S-67), and carry the seller's name, icon and colours only.
 */

/**
 * The bag (9.2). It lives in the browser, so it survives the move from Instagram's in-app browser to Chrome; once the shopper
 * is signed in it is mirrored to the server cart. It holds a product, a variant and a quantity per line and never a price:
 * whatever it shows is priced again by the server. 10 per line, 50 lines, the same product and option merged.
 */
export const BAG_JS = `(() => {
  'use strict';
  const KEY = 'store:bag:v2';
  const MAX_QTY = ${STORE_LIMITS.maxQtyPerLine};
  const MAX_LINES = ${STORE_LIMITS.maxCartLines};
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const csrf = () => $('meta[name="csrf-token"]')?.content || '';
  const shopperCsrf = () => $('meta[name="shopper-csrf"]')?.content || '';
  const signedIn = () => $('meta[name="store-shopper"]')?.content === '1';
  const intOr = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);

  function read() {
    try {
      const b = JSON.parse(localStorage.getItem(KEY));
      if (b && Array.isArray(b.lines)) {
        b.lines = b.lines.filter((l) => intOr(l.productId, 0)).map((l) => ({ productId: l.productId, variantId: intOr(l.variantId, null), qty: Math.min(MAX_QTY, intOr(l.qty, 1)) })).slice(0, MAX_LINES);
        b.ref = b.ref && typeof b.ref === 'object' ? b.ref : {};
        return b;
      }
    } catch {}
    return { lines: [], ref: {} };
  }
  function write(bag, { mirror = true } = {}) {
    try { localStorage.setItem(KEY, JSON.stringify(bag)); } catch {}
    count();
    if (mirror && signedIn()) put(bag).catch(() => {});
  }
  const same = (a, b) => a.productId === b.productId && (a.variantId || null) === (b.variantId || null);

  /** Adds to a line, or makes one. Answers whether the quantity was cut to the cap. */
  function add(productId, variantId, qty = 1) {
    const bag = read();
    const want = { productId, variantId: variantId || null };
    const line = bag.lines.find((l) => same(l, want));
    let capped = false;
    if (line) {
      capped = line.qty + qty > MAX_QTY;
      line.qty = Math.min(MAX_QTY, line.qty + qty);
    } else {
      if (bag.lines.length >= MAX_LINES) return { added: false, full: true };
      capped = qty > MAX_QTY;
      bag.lines.push({ ...want, qty: Math.min(MAX_QTY, qty) });
    }
    write(bag);
    return { added: true, capped };
  }
  function set(productId, variantId, qty) {
    const bag = read();
    const want = { productId, variantId: variantId || null };
    bag.lines = qty > 0 ? bag.lines.map((l) => (same(l, want) ? { ...l, qty: Math.min(MAX_QTY, qty) } : l)) : bag.lines.filter((l) => !same(l, want));
    write(bag);
  }
  function clear() { const bag = read(); bag.lines = []; write(bag); }
  function count() {
    const n = read().lines.reduce((s, l) => s + l.qty, 0);
    $$('[data-bag-count]').forEach((el) => { el.textContent = n ? String(n) : ''; });
  }

  async function api(method, path, body) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (csrf()) headers['x-csrf-token'] = csrf();
    if (shopperCsrf()) headers['x-shopper-csrf'] = shopperCsrf();
    const res = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null;
    try { data = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, data: data || {} };
  }
  const put = (bag) => api('PUT', '/api/store/cart', { lines: bag.lines });

  /** Once per visit after sign-in, the server cart and this browser's bag become one (the larger quantity of each line). */
  async function mirror() {
    if (!signedIn()) return;
    try { if (sessionStorage.getItem(KEY + ':synced') === '1') return; } catch {}
    const res = await api('GET', '/api/store/cart');
    if (!res.ok) return;
    const bag = read();
    for (const line of res.data.lines || []) {
      const mine = bag.lines.find((l) => same(l, line));
      if (mine) mine.qty = Math.max(mine.qty, Math.min(MAX_QTY, line.qty));
      else if (bag.lines.length < MAX_LINES) bag.lines.push({ productId: line.productId, variantId: line.variantId || null, qty: Math.min(MAX_QTY, line.qty) });
    }
    write(bag);
    try { sessionStorage.setItem(KEY + ':synced', '1'); } catch {}
    document.dispatchEvent(new CustomEvent('bag:changed'));
  }

  /** Where this visit came from: the landing page and its tags, kept with the bag for the order's source. The server checks them. */
  function remember() {
    const params = new URLSearchParams(location.search);
    const utm = {};
    for (const [k, v] of params) if (/^(utm_[a-z]{1,20}|src)$/.test(k) && Object.keys(utm).length < 8) utm[k] = v.slice(0, 200);
    const page = /^\\/r\\/([^/?#]{1,120})/.exec(location.pathname);
    if (!Object.keys(utm).length && !page) return;
    const bag = read();
    bag.ref = { ...(Object.keys(utm).length ? { utm } : { utm: bag.ref.utm }), ...(page ? { pageSlug: decodeURIComponent(page[1]) } : { pageSlug: bag.ref.pageSlug }) };
    write(bag, { mirror: false });
  }

  // ---- the product page ------------------------------------------------------------------------------------------
  function productForm(form) {
    const productId = Number(form.dataset.product);
    const status = $('[data-added]', form);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const choice = $('input[name="variant"]:checked', form);
      const needs = $$('input[name="variant"]', form).length > 0;
      const error = $('[data-option-error]', form);
      if (needs && !choice) { if (error) error.hidden = false; return; }
      if (error) error.hidden = true;
      const qty = Number($('[name="qty"]', form)?.value || 1);
      const done = add(productId, choice ? Number(choice.value) : null, qty);
      if (status) {
        status.hidden = false;
        $('[data-added-text]', status).textContent = done.full ? 'Your bag is full.' : done.capped ? 'Added. You can buy up to ' + MAX_QTY + ' of one item.' : 'Added to your bag.';
      }
    });
  }

  // ---- the bag page ----------------------------------------------------------------------------------------------
  const money = (p) => '₹' + (Math.round(p) / 100).toLocaleString('en-IN', { minimumFractionDigits: p % 100 ? 2 : 0, maximumFractionDigits: 2 });
  async function cartPage(root) {
    const list = $('[data-lines]', root);
    const empty = $('[data-empty]', root);
    const summary = $('[data-summary]', root);
    const notes = $('[data-notices]', root);
    async function render() {
      const bag = read();
      if (!bag.lines.length) { list.replaceChildren(); empty.hidden = false; summary.hidden = true; notes.hidden = true; return; }
      empty.hidden = true;
      const res = await api('POST', '/api/store/checkout/quote', { lines: bag.lines });
      if (!res.ok) { notes.hidden = false; notes.textContent = res.data.error || 'We couldn’t load your bag. Please try again.'; return; }
      const q = res.data;
      list.replaceChildren(...q.lines.map((l) => lineRow(l)));
      notes.hidden = !q.notices.length;
      notes.textContent = q.notices.join(' ');
      summary.hidden = false;
      $('[data-subtotal]', summary).textContent = money(q.subtotalPaise);
      $('[data-shipping]', summary).textContent = q.shippingPaise ? money(q.shippingPaise) : 'Free';
      $('[data-total]', summary).textContent = money(q.totalPaise);
      const go = $('[data-checkout]', summary);
      const canBuy = q.lines.some((l) => l.state === 'ok' || l.state === 'capped');
      go.toggleAttribute('aria-disabled', !canBuy);
      if (!canBuy) go.removeAttribute('href'); else go.setAttribute('href', '/checkout');
    }
    function lineRow(l) {
      const li = document.createElement('li');
      li.className = 'line' + (l.state === 'ok' || l.state === 'capped' ? '' : ' off');
      const img = document.createElement(l.image ? 'img' : 'span');
      if (l.image) { img.src = l.image; img.alt = ''; img.width = 64; img.height = 76; } else img.className = 'ph';
      const mid = document.createElement('div');
      const name = document.createElement('b'); name.textContent = l.name || 'Item';
      const opt = document.createElement('div'); opt.className = 'muted small'; opt.textContent = l.option;
      const state = document.createElement('div'); state.className = 'small';
      state.textContent = l.state === 'sold_out' ? 'Sold out' : l.state === 'inactive' ? 'No longer available' : money(l.unitPaise) + ' each';
      const qty = document.createElement('div'); qty.className = 'qty';
      const minus = document.createElement('button'); minus.type = 'button'; minus.textContent = '−'; minus.setAttribute('aria-label', 'One fewer');
      const shown = document.createElement('span'); shown.textContent = String(l.qty);
      const plus = document.createElement('button'); plus.type = 'button'; plus.textContent = '+'; plus.setAttribute('aria-label', 'One more');
      const drop = document.createElement('button'); drop.type = 'button'; drop.textContent = 'Remove';
      minus.onclick = () => { set(l.productId, l.variantId, l.qty - 1); render(); };
      plus.onclick = () => { set(l.productId, l.variantId, l.qty + 1); render(); };
      drop.onclick = () => { set(l.productId, l.variantId, 0); render(); };
      if (l.state === 'ok' || l.state === 'capped') qty.append(minus, shown, plus);
      qty.append(drop);
      mid.append(name, opt, state, qty);
      const amount = document.createElement('b'); amount.textContent = l.linePaise ? money(l.linePaise) : '';
      li.append(img, mid, amount);
      return li;
    }
    document.addEventListener('bag:changed', render);
    await render();
  }

  window.StoreBag = { read, write, add, set, clear, api, count, money, csrf };
  count();
  remember();
  mirror().catch(() => {});
  $$('form[data-add-form]').forEach(productForm);
  const cart = $('[data-cart-page]');
  if (cart) cartPage(cart).catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
})();
`;

/** The service worker: the branded offline page when there is no network, and nothing else is kept. */
export const SERVICE_WORKER_JS = `'use strict';
const CACHE = 'store-offline-v1';
self.addEventListener('install', (event) => { event.waitUntil(caches.open(CACHE).then((c) => c.add('/offline')).then(() => self.skipWaiting())); });
self.addEventListener('activate', (event) => { event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => caches.match('/offline')));
});
`;

/** The home-screen app (S-67): the seller's name, icon and colours from the brand kit. No platform name. */
export async function manifestFor(repos) {
  const [settings, kit] = await Promise.all([repos.settings.getAll(), repos.brandKit.get()]);
  const theme = buyerTheme(kit);
  const name = String(settings.store_name ?? '').trim().slice(0, 45) || 'Shop';
  const icon = safeHref(kit?.logoUrl || theme.logoUrl || theme.faviconUrl);
  return {
    id: '/',
    name,
    short_name: name.slice(0, 12),
    description: String(settings.tagline ?? '').slice(0, 200),
    start_url: '/?source=homescreen',
    scope: '/',
    display: 'standalone',
    background_color: theme.colors.ground,
    theme_color: theme.colors.primary,
    icons: icon ? [{ src: icon, sizes: '192x192', purpose: 'any' }, { src: icon, sizes: '512x512', purpose: 'any' }] : [],
  };
}
