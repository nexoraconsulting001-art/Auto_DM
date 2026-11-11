import { STORE_LIMITS } from '../../contracts/orders.js';

/**
 * The wishlist in the browser (PRD 9.20). A heart on product cards and on the product page saves or unsaves the item. Logged
 * out, saves are kept in this browser (localStorage); once signed in they are merged into the account with one PUT and the
 * browser's copy is cleared (S-84). The page itself never holds a price: what it shows comes from the server.
 *
 * The page tells the script what it needs in <script type="application/json" id="wish-data">: { signedIn, saved }.
 */
export const WISHLIST_SCRIPT = '/store/wishlist.js';
export const WISHLIST_ASSET_VERSION = '2';

export const WISHLIST_CSS = [
  '.wish-card{position:relative;display:flex;flex-direction:column}.wish-card>.tile{flex:1}',
  '.wish{position:absolute;top:14px;right:14px;width:40px;height:40px;border-radius:999px;border:1px solid var(--line-strong,#ccc);background:var(--card,#fff);color:var(--primary,#333);font-size:20px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}',
  '.wish[aria-pressed="true"]{color:var(--accent,#c33)}',
  '.wish.wish-page{position:static;width:auto;height:44px;padding:0 16px;gap:8px;font-size:15px;font-weight:600}',
  '.wish-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px}',
  '.wish-row{display:grid;grid-template-columns:64px 1fr;gap:12px;align-items:center}',
  '.wish-row img,.wish-row .ph{width:64px;height:76px;object-fit:cover;border-radius:8px;background:var(--chip,#eee)}',
  '.wish-row.off{opacity:.65}',
].join('');

export const WISHLIST_JS = `(() => {
  'use strict';
  const KEY = 'store:wish:v1';
  const MAX = ${STORE_LIMITS.wishlistItems};
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const meta = (n) => ($('meta[name="' + n + '"]') || {}).content || '';
  const okId = (n) => Number.isInteger(n) && n > 0 && n <= 2147483647;
  let data = {};
  try { data = JSON.parse(($('#wish-data') || {}).textContent || '{}'); } catch (e) { data = {}; }
  const signedIn = data.signedIn === true;

  function local() {
    try { const v = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(v) ? v.filter(okId).slice(0, MAX) : []; } catch (e) { return []; }
  }
  function keep(ids) {
    try { if (ids.length) localStorage.setItem(KEY, JSON.stringify(ids.slice(0, MAX))); else localStorage.removeItem(KEY); } catch (e) {}
  }
  let saved = new Set(signedIn ? (Array.isArray(data.saved) ? data.saved.filter(okId) : []) : local());

  async function api(method, body) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (meta('csrf-token')) headers['x-csrf-token'] = meta('csrf-token');
    if (meta('shopper-csrf')) headers['x-shopper-csrf'] = meta('shopper-csrf');
    const res = await fetch('/api/store/wishlist', { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
    let out = {};
    try { out = await res.json(); } catch (e) { out = {}; }
    return { ok: res.ok, data: out || {} };
  }

  function note(text) {
    const box = $('[data-wish-note]');
    if (box) { box.textContent = text; box.hidden = !text; }
  }
  function paint() {
    $$('[data-wish-toggle]').forEach((b) => {
      const on = saved.has(Number(b.dataset.wishToggle));
      const what = b.dataset.wishName ? b.dataset.wishName + ' ' : '';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.setAttribute('aria-label', on ? 'Remove ' + what + 'from wishlist' : 'Save ' + what + 'to wishlist');
      b.textContent = b.classList.contains('wish-page') ? (on ? '\\u2665 Saved' : '\\u2661 Save') : (on ? '\\u2665' : '\\u2661');
    });
  }
  function fromAnswer(res) {
    if (res.ok && Array.isArray(res.data.items)) saved = new Set(res.data.items.map((i) => i.productId));
    if (res.ok && Array.isArray(res.data.notices) && res.data.notices.length) note(res.data.notices.join(' '));
    paint();
  }
  async function toggle(id) {
    const on = saved.has(id);
    if (!on && saved.size >= MAX) { note('Your wishlist is full. Remove something to save this.'); return; }
    if (on) saved.delete(id); else saved.add(id);
    paint();
    if (!signedIn) { keep([...saved]); return; }
    const res = await api('PUT', on ? { remove: [id] } : { add: [id] });
    if (!res.ok) {
      if (on) saved.add(id); else saved.delete(id);
      paint();
      note(res.data.error || 'That didn’t save. Please try again.');
      return;
    }
    fromAnswer(res);
  }
  function heart(id, extra, name) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wish' + (extra ? ' ' + extra : '');
    b.dataset.wishToggle = String(id);
    if (name) b.dataset.wishName = name.slice(0, 80);
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggle(id).catch(() => {}); });
    return b;
  }

  $$('a.tile[data-wish]').forEach((tile) => {
    const id = Number(tile.dataset.wish);
    if (!okId(id)) return;
    const wrap = document.createElement('div');
    wrap.className = 'wish-card';
    tile.replaceWith(wrap);
    wrap.append(tile, heart(id, '', ((tile.querySelector('b') || {}).textContent || '').trim()));
  });
  $$('form[data-add-form][data-product]').forEach((form) => {
    const id = Number(form.dataset.product);
    if (okId(id)) form.append(heart(id, 'wish-page'));
  });

  // The account's own list: remove, and add to the bag what can be bought now.
  $$('[data-wish-remove]').forEach((b) => b.addEventListener('click', async () => {
    const id = Number(b.dataset.wishRemove);
    const res = await api('PUT', { remove: [id] });
    if (res.ok) { const row = b.closest('li'); if (row) row.remove(); fromAnswer(res); } else note(res.data.error || 'Please try again.');
  }));
  $$('[data-wish-bag]').forEach((b) => b.addEventListener('click', () => {
    const id = Number(b.dataset.wishBag);
    if (window.StoreBag && okId(id)) { window.StoreBag.add(id, null, 1); note('Added to your bag.'); }
  }));

  // Saved while logged out, then signed in: the browser's saves join the account once (S-84).
  async function merge() {
    if (!signedIn) return;
    const mine = local();
    if (!mine.length) return;
    const res = await api('PUT', { add: mine });
    if (res.ok) { keep([]); fromAnswer(res); if ($('[data-wish-page]')) location.reload(); }
  }

  const money = (p) => '\\u20b9' + (Math.round(p) / 100).toLocaleString('en-IN', { minimumFractionDigits: p % 100 ? 2 : 0, maximumFractionDigits: 2 });
  async function guestPage(root) {
    const list = $('[data-wish-items]', root);
    const empty = $('[data-wish-empty]', root);
    const ids = [...saved];
    if (!ids.length) { empty.hidden = false; return; }
    const found = [];
    for (let i = 0; i < ids.length; i += 50) {
      const res = await fetch('/api/store/products?ids=' + ids.slice(i, i + 50).join(','), { headers: { accept: 'application/json' }, credentials: 'same-origin' });
      if (!res.ok) continue;
      const body = await res.json().catch(() => ({}));
      found.push(...(body.products || []));
    }
    list.replaceChildren(...found.map((p) => {
      const li = document.createElement('li');
      li.className = 'wish-row' + (p.active && !p.soldOut ? '' : ' off');
      const img = document.createElement(p.image ? 'img' : 'span');
      if (p.image) { img.src = p.image; img.alt = ''; img.width = 64; img.height = 76; } else img.className = 'ph';
      const mid = document.createElement('div');
      const name = document.createElement(p.active ? 'a' : 'b');
      name.textContent = p.name || 'Item';
      if (p.active) name.href = '/p/' + encodeURIComponent(p.slug);
      const state = document.createElement('div');
      state.className = 'small';
      state.textContent = !p.active ? 'Unavailable' : p.soldOut ? 'Sold out' : (p.pricePaise === null ? '' : money(p.pricePaise));
      const drop = document.createElement('button');
      drop.type = 'button'; drop.className = 'btn-quiet'; drop.textContent = 'Remove';
      drop.addEventListener('click', () => { saved.delete(p.id); keep([...saved]); li.remove(); if (!saved.size) empty.hidden = false; });
      mid.append(name, state, drop);
      li.append(img, mid);
      return li;
    }));
    if (!found.length) empty.hidden = false;
  }

  paint();
  merge().catch(() => {});
  const page = $('[data-wish-page]');
  if (page && !signedIn) guestPage(page).catch(() => {});
})();
`;
