import { PRICE_BANDS, discountPercent, formatMoney } from '../util.js';
import { ORDER_STATUSES } from '../repos/orders.js';
import { SORTS } from '../repos/products.js';
import { asset } from './assets.js';
import { html, jsonScript, raw } from './html.js';
import { brandCss, brandFontsHref } from '../modules/brand/theme.js';

export const HOME_PAGE_SIZE = 24;

const ICONS = raw(`<svg width="0" height="0" style="position:absolute" aria-hidden="true">
<symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="m16 16 4.5 4.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></symbol>
<symbol id="i-bag" viewBox="0 0 24 24"><path d="M5 8h14l-1.1 12.1H6.1L5 8Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 10V7a3 3 0 0 1 6 0v3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
<symbol id="i-home" viewBox="0 0 24 24"><path d="M4 11 12 4l8 7v9h-5v-6H9v6H4v-9Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></symbol>
<symbol id="i-grid" viewBox="0 0 24 24"><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/></symbol>
<symbol id="i-reels" viewBox="0 0 24 24"><rect x="4" y="3.5" width="16" height="17" rx="3.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m10 9 5 3-5 3V9Z" fill="currentColor"/></symbol>
<symbol id="i-user" viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
<symbol id="i-play" viewBox="0 0 24 24"><path d="M6 4v16l14-8L6 4Z" fill="currentColor"/></symbol>
<symbol id="i-truck" viewBox="0 0 24 24"><path d="M3 6h11v10H3zM14 9h4l3 3.5V16h-7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="7" cy="17.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="17.5" cy="17.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.7"/></symbol>
<symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 3 5 6v5.5c0 4.3 3 7.8 7 9.5 4-1.7 7-5.2 7-9.5V6l-7-3Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="m9 12 2.2 2.2L15.5 10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-chat" viewBox="0 0 24 24"><path d="M5 18.5 4 21l3.2-1.2A8 8 0 1 0 5 18.5Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></symbol>
<symbol id="i-gift" viewBox="0 0 24 24"><rect x="4" y="9" width="16" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M3 9h18M12 9v11M12 9S10.5 4 8 4.5 7.5 9 12 9Zm0 0s1.5-5 4-4.5S16.5 9 12 9Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></symbol>
<symbol id="i-users" viewBox="0 0 24 24"><circle cx="9" cy="8.5" r="3.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M3.5 19c.6-3.3 2.8-5 5.5-5s4.9 1.7 5.5 5M15.5 5.6a3.2 3.2 0 0 1 0 6M17 14.2c1.9.5 3.1 2 3.5 4.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></symbol>
<symbol id="i-filter" viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h2M10 17h10" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="16" cy="7" r="2.2" fill="none" stroke="currentColor" stroke-width="1.9"/><circle cx="8" cy="17" r="2.2" fill="none" stroke="currentColor" stroke-width="1.9"/></symbol>
<symbol id="i-upi" viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M3 10h18" stroke="currentColor" stroke-width="1.7"/></symbol>
<symbol id="i-sound-off" viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4v-5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="m16 9.5 5 5m0-5-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
<symbol id="i-sound-on" viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4v-5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
<symbol id="i-share" viewBox="0 0 24 24"><path d="M12 4v11M8 8l4-4 4 4M6 13v6h12v-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-back" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
</svg>`);

const icon = (name) => raw(`<svg aria-hidden="true"><use href="#i-${name}"/></svg>`);
const trustIcons = ['truck', 'shield', 'chat', 'users', 'gift'];
const waLink = (n, text = '') => `https://wa.me/${String(n).replace(/\D/g, '')}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
const igLink = (h) => `https://instagram.com/${String(h).replace(/^@/, '')}`;

/**
 * Page shell. nav: 'home' | 'shop' | 'reels' | 'account' | null. owner: the logged-in admin's
 * "Edit this page" target ({ href, label }) — the owner bar only renders for owners. settings.brand is the
 * business's brand kit, which sets the colours, fonts, logo and favicon.
 */
export function storeLayout({ settings, user, title, body, pageData = {}, nav = null, edit = null, tabs = true, bodyClass = '', escape = false }) {
  const isAdmin = user?.role === 'owner';
  const kit = settings.brand;
  const data = {
    shippingFee: Number(settings.shipping_fee_paise) || 0,
    freeShippingAbove: Number(settings.free_shipping_above_paise) || 0,
    ...pageData,
  };
  const current = (key) => (nav === key ? raw('aria-current="page"') : '');
  const accountHref = isAdmin ? '/admin' : user ? '/account' : '/login';
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="icon" href="${kit.faviconUrl || 'data:,'}">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title ? `${title} | ${settings.store_name}` : settings.store_name}</title>
<meta name="theme-color" content="${kit.colors.ground}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${brandFontsHref(kit)}">
<link rel="stylesheet" href="${asset('store.css')}">
<style>${raw(brandCss(kit))}</style>
</head>
<body class="${[bodyClass, tabs ? '' : 'no-tabs'].filter(Boolean).join(' ')}">
${ICONS}
${isAdmin ? html`<div class="owner-bar" role="navigation" aria-label="Owner tools">
  <span class="owner-tag">Owner view</span>
  <a href="/admin">Dashboard</a><a href="/admin/orders">Orders</a><a class="owner-more" href="/admin/products">Products</a><a class="owner-more" href="/admin/reels">Reels</a>
  ${edit ? html`<a class="owner-edit" href="${edit.href}">${edit.label || 'Edit this page'}</a>` : ''}
</div>` : ''}
${bodyClass.includes('reels-body') ? '' : html`<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/">${kit.logoUrl ? html`<img src="${kit.logoUrl}" alt="">` : ''}<span>${settings.store_name}</span></a>
    <nav class="desk-nav" aria-label="Store"><a href="/shop" ${current('shop')}>Shop</a><a href="/reels" ${current('reels')}>Reels</a><a href="/about" ${current('about')}>About</a></nav>
    <form class="desk-search" action="/shop" role="search">${icon('search')}<input name="q" placeholder="Search products" aria-label="Search products"></form>
    <a class="ico hide-desk" href="/shop#search" aria-label="Search">${icon('search')}</a>
    <a class="ico" href="${accountHref}" aria-label="${isAdmin ? 'Store admin' : user ? 'My account' : 'Log in'}">${icon('user')}</a>
    <button class="ico" type="button" data-open-bag aria-label="Open bag">${icon('bag')}<span class="badge" data-bag-count hidden>0</span></button>
  </div>
</header>`}
<main>${body}
${escape ? html`<section class="escape" data-escape hidden>
  <p class="escape-title">Shop the full store in your browser</p>
  <p class="escape-text">See every product, and your bag comes with you.</p>
  <a class="escape-btn" href="/shop" data-escape-link>Open full store in Chrome</a>
  <p class="escape-tip" data-escape-tip hidden>If nothing happens, tap ⋯ at the top and choose “Open in external browser”.</p>
</section>` : ''}</main>
${bodyClass.includes('reels-body') ? '' : footer(settings)}
${tabs ? html`<nav class="tabbar" aria-label="Store sections">
  <a class="tab" href="/" ${current('home')}>${icon('home')}Home</a>
  <a class="tab" href="/shop" ${current('shop')}>${icon('grid')}Shop</a>
  <a class="tab" href="/reels" ${current('reels')}>${icon('reels')}Reels</a>
  <button class="tab" type="button" data-open-bag>${icon('bag')}<span class="badge" data-bag-count hidden>0</span>Bag</button>
</nav>` : ''}
${bagDrawer()}
<script>window.STORE = ${jsonScript(data)};</script>
<script src="${asset('cart.js')}" defer></script>
${bodyClass.includes('reels-body') ? html`<script src="${asset('reels.js')}" defer></script>` : ''}
</body>
</html>`;
}

function footer(settings) {
  return html`<footer class="site-foot">
  <nav aria-label="Store information">
    <a href="/about">About</a><a href="/shop">Shop</a><a href="/reels">Reels</a>
    ${settings.support_whatsapp ? html`<a href="${waLink(settings.support_whatsapp)}">WhatsApp</a>` : ''}
    ${settings.support_email ? html`<a href="mailto:${settings.support_email}">Email</a>` : ''}
    ${settings.instagram_handle ? html`<a href="${igLink(settings.instagram_handle)}">Instagram</a>` : ''}
  </nav>
  <span>© ${settings.store_name}${settings.gstin ? `. GSTIN ${settings.gstin}` : ''}</span>
</footer>`;
}

function bagDrawer() {
  return html`
<div class="scrim" data-scrim hidden></div>
<aside class="bag" data-bag aria-label="Your bag" aria-hidden="true">
  <div class="bag-head"><h2>Your bag</h2><button type="button" class="icon-btn" data-close-bag aria-label="Close bag">✕</button></div>
  <div class="bag-items" data-bag-items></div>
  <div class="bag-foot" data-bag-foot></div>
</aside>
<div class="sheet" data-sheet aria-hidden="true"></div>`;
}

/** Product data the browser needs for the bag (prices are re-checked on the server at checkout). */
export const productForClient = (p, reelSlug = '') => ({
  id: p.id,
  slug: p.slug,
  name: p.name,
  price: p.price_paise,
  mrp: p.mrp_paise,
  image: p.images[0] || '',
  optionLabel: p.option_label,
  options: p.option_values,
  soldOut: p.stock === 0,
  reelSlug,
});

function priceLine(p, { badge = false } = {}) {
  const off = discountPercent(p.price_paise, p.mrp_paise);
  return html`<b>${formatMoney(p.price_paise)}</b>${off ? html`<s>${formatMoney(p.mrp_paise)}</s>${off >= 5 ? (badge ? html`<span class="off-badge">${off}% off</span>` : html`<span class="off">${off}% off</span>`) : ''}` : ''}`;
}

const productImage = (p) =>
  p.images[0] ? html`<img src="${p.images[0]}" alt="${p.name}" loading="lazy">` : html`<span class="noimg" aria-hidden="true">${p.name.slice(0, 1)}</span>`;

function productCard(p, { href = `/p/${p.slug}`, seq = null, admin = false } = {}) {
  return html`<li class="card ${p.stock === 0 ? 'is-soldout' : ''}">
    <a class="card-img" href="${href}">${productImage(p)}${seq ? html`<span class="seq" title="Appears ${seq} in the reel">${seq}</span>` : ''}</a>
    ${admin ? html`<a class="edit-chip" href="/admin/products/${p.id}">Edit</a>` : ''}
    <a class="card-name" href="${href}">${p.name}</a>
    <div class="price">${priceLine(p)}</div>
    ${p.stock === 0 ? html`<span class="soldout">Sold out</span>` : html`<button type="button" class="add-btn" data-add="${p.id}">Add to bag</button>`}
  </li>`;
}

function reelCard(r) {
  return html`<div class="reel-card">
    <a class="reel-media" href="/reels#${r.slug}" aria-label="Watch ${r.headline || 'reel'}">
      ${r.thumbnail_url ? html`<img src="${r.thumbnail_url}" alt="" loading="lazy">` : html`<span class="ph"></span>`}
      <span class="play">${icon('play')}</span>
      <span class="reel-count">${r.product_count} ${r.product_count === 1 ? 'item' : 'items'}</span>
      <span class="reel-name">${r.headline || 'Shop the reel'}</span>
    </a>
    <a class="btn btn-gold" href="/r/${r.slug}">Shop now</a>
  </div>`;
}

const catImage = (c) => (c.image_url ? html`<img src="${c.image_url}" alt="" loading="lazy">` : html`<span class="cat-ph" aria-hidden="true">${c.name.slice(0, 1)}</span>`);

function trustStrip(settings) {
  const points = String(settings.trust_points || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 5);
  if (!points.length) return '';
  return html`<section class="trust" style="--n:${points.length}" aria-label="Why shop with us">
    ${points.map((t, i) => html`<div>${icon(trustIcons[i % trustIcons.length])}<span>${t}</span></div>`)}
  </section>`;
}

// ---------------------------------------------------------------- home
export function homePage({ settings, user, categories, reels, deals }) {
  const top = deals[0];
  const admin = user?.role === 'owner';
  const body = html`
<section class="hero">
  <div class="hero-copy">
    ${settings.hero_kicker ? html`<span class="hero-kicker">${settings.hero_kicker}</span>` : ''}
    <h1>${settings.hero_title || settings.store_name}</h1>
    ${settings.hero_subtitle ? html`<p>${settings.hero_subtitle}</p>` : ''}
    <div class="hero-btns"><a class="btn btn-gold btn-lg" href="/shop?sort=discount">Shop deals</a>${reels.length ? html`<a class="btn btn-line btn-lg" href="/reels">Watch reels</a>` : ''}</div>
    ${top ? html`<a class="deal-card" href="/p/${top.slug}">${productImage(top)}<div><small>Today's top deal</small><b>${top.name}</b><div class="price">${priceLine(top)}</div></div></a>` : ''}
  </div>
  ${deals.length >= 4 ? html`<div class="collage">${deals.slice(0, 4).map((p) => html`<a href="/p/${p.slug}">${productImage(p)}<span>${formatMoney(p.price_paise)}${discountPercent(p.price_paise, p.mrp_paise) >= 5 ? html`<em>${discountPercent(p.price_paise, p.mrp_paise)}% off</em>` : ''}</span></a>`)}</div>` : ''}
</section>

${categories.length ? html`<section class="section cats-wrap">
  <div class="row-head"><h2>Shop by category</h2><a class="link" href="/shop">See all</a></div>
  <div class="hscroll">${categories.map((c) => html`<a class="cat" href="/c/${c.slug}">${catImage(c)}${c.name}</a>`)}</div>
</section>` : ''}

<section class="section">
  <div class="row-head"><h2>Shop by price</h2></div>
  <div class="hscroll">${PRICE_BANDS.map((b) => html`<a class="price-chip" href="/shop?price=${b.key}"><small>${b.small}</small><b>${b.big}</b></a>`)}</div>
</section>

${reels.length ? html`<section class="section">
  <div class="row-head"><h2>From our reels</h2><a class="link" href="/reels">Watch all</a></div>
  <div class="hscroll">${reels.map(reelCard)}</div>
</section>` : ''}

${deals.length ? html`<section class="section">
  <div class="row-head"><h2>Today's best deals</h2><a class="link" href="/shop?sort=discount">See all</a></div>
  <ul class="grid">${deals.slice(0, 8).map((p) => productCard(p, { admin }))}</ul>
</section>` : html`<p class="empty">New pieces are on the way.</p>`}

${trustStrip(settings)}
${settings.support_whatsapp ? html`<section class="bulk">
  <b>${settings.bulk_title}</b>
  <p>${settings.bulk_text}</p>
  <a class="btn btn-gold" href="${waLink(settings.support_whatsapp, `Hi ${settings.store_name}, I'd like to place a bulk order.`)}">Chat on WhatsApp</a>
</section>` : ''}`;
  return storeLayout({
    settings, user, body, nav: 'home', escape: true,
    edit: admin ? { href: '/admin/settings', label: 'Edit home page' } : null,
    pageData: { products: deals.map((p) => productForClient(p)) },
  });
}

// ---------------------------------------------------------------- shop & category
export function shopPage({ settings, user, categories, category, products, total, filters, shown }) {
  const admin = user?.role === 'owner';
  const base = category ? `/c/${category.slug}` : '/shop';
  const qs = (over) => {
    const p = new URLSearchParams();
    const f = { ...filters, ...over };
    if (f.q) p.set('q', f.q);
    if (f.price) p.set('price', f.price);
    if (f.sort && f.sort !== 'popular') p.set('sort', f.sort);
    if (f.show) p.set('show', f.show);
    const s = p.toString();
    return s ? `?${s}` : '';
  };
  const band = PRICE_BANDS.find((b) => b.key === filters.price);
  const filterCount = (band ? 1 : 0) + (filters.sort && filters.sort !== 'popular' ? 1 : 0);
  const body = html`
${category ? html`<header class="cat-head">${catImage(category)}<div><h1>${category.name}</h1>${category.description ? html`<p>${category.description}</p>` : html`<p>${category.product_count} products</p>`}</div></header>`
    : html`<header class="page-head"><h1>Shop</h1></header>`}
<form class="shop-search" action="${base}" role="search" id="search">
  ${icon('search')}<input type="search" name="q" value="${filters.q}" placeholder="Search ${category ? category.name : `${total} products`}" aria-label="Search products" data-autofocus-hash="search">
  ${filters.price ? html`<input type="hidden" name="price" value="${filters.price}">` : ''}
  ${filters.sort && filters.sort !== 'popular' ? html`<input type="hidden" name="sort" value="${filters.sort}">` : ''}
</form>
<nav class="hscroll chips-row" aria-label="Categories">
  <a class="chip" href="/shop${qs({ show: '' })}" ${!category ? raw('aria-current="true"') : ''}>All</a>
  ${categories.map((c) => html`<a class="chip" href="/c/${c.slug}${qs({ show: '' })}" ${category?.id === c.id ? raw('aria-current="true"') : ''}>${c.name}</a>`)}
</nav>
<div class="toolbar">
  <span>${total === 1 ? '1 product' : `${total} products`}${filters.q ? ` for “${filters.q}”` : ''}</span>
  <button type="button" class="filter-btn" data-open-filters>${icon('filter')}Filter &amp; sort${filterCount ? html`<span class="dot" aria-label="${filterCount} active"></span>` : ''}</button>
</div>
${band || filters.q ? html`<div class="active-filters">
  ${filters.q ? html`<a href="${base}${qs({ q: '', show: '' })}" aria-label="Remove search">“${filters.q}” ✕</a>` : ''}
  ${band ? html`<a href="${base}${qs({ price: '', show: '' })}" aria-label="Remove price filter">${band.label} ✕</a>` : ''}
</div>` : ''}
${products.length ? html`<ul class="grid">${products.map((p) => productCard(p, { admin }))}</ul>
  ${shown < total ? html`<a class="more-btn" href="${base}${qs({ show: String(shown + HOME_PAGE_SIZE) })}">Show more (${total - shown} more)</a>` : ''}`
    : html`<div class="empty-page"><h1>No products found</h1><p class="muted">Try another search or remove a filter.</p><a class="btn btn-line" href="/shop">See all products</a></div>`}

<template data-filters-template>
  <form class="sheet-inner" action="${base}" method="get">
    <span class="grab"></span>
    <div class="sheet-head"><h2>Filter &amp; sort</h2><a class="link" href="${base}${filters.q ? `?q=${encodeURIComponent(filters.q)}` : ''}">Clear all</a></div>
    ${filters.q ? html`<input type="hidden" name="q" value="${filters.q}">` : ''}
    <div><h3>Price</h3><fieldset class="chip-group"><legend class="sr" hidden>Price</legend>
      <label><input type="radio" name="price" value="" ${!band ? raw('checked') : ''}><span>Any price</span></label>
      ${PRICE_BANDS.map((b) => html`<label><input type="radio" name="price" value="${b.key}" ${band?.key === b.key ? raw('checked') : ''}><span>${b.label}</span></label>`)}
    </fieldset></div>
    <div><h3>Sort by</h3><div class="radio-list">
      ${Object.entries(SORTS).map(([k, s]) => html`<label><input type="radio" name="sort" value="${k}" ${(filters.sort || 'popular') === k ? raw('checked') : ''}>${s.label}</label>`)}
    </div></div>
    <button class="btn btn-gold btn-wide btn-lg" type="submit">Show products</button>
  </form>
</template>`;
  return storeLayout({
    settings, user, body, nav: 'shop', title: category ? category.name : 'Shop', escape: true,
    edit: admin ? (category ? { href: `/admin/categories/${category.id}`, label: 'Edit category' } : { href: '/admin/products', label: 'Manage products' }) : null,
    pageData: { products: products.map((p) => productForClient(p)) },
  });
}

// ---------------------------------------------------------------- product
export function productPage({ settings, user, product: p, reel, categories, related }) {
  const admin = user?.role === 'owner';
  const off = discountPercent(p.price_paise, p.mrp_paise);
  const free = Number(settings.free_shipping_above_paise) || 0;
  const body = html`
<nav class="crumb" aria-label="Breadcrumb">
  ${reel ? html`<a href="/r/${reel.slug}">${reel.headline || 'Back to the reel'}</a>` : html`<a href="/shop">Shop</a>${categories[0] ? html`<span>/</span><a href="/c/${categories[0].slug}">${categories[0].name}</a>` : ''}`}
</nav>
<article class="pdp">
  <div class="gallery-wrap">
    <div class="gallery" data-gallery>${p.images.length ? p.images.map((src, i) => html`<img src="${src}" alt="${p.name}${i ? ` (${i + 1})` : ''}" ${i ? raw('loading="lazy"') : ''}>`) : html`<span class="noimg">${p.name.slice(0, 1)}</span>`}</div>
    ${p.images.length > 1 ? html`<div class="dots" data-dots>${p.images.map((_, i) => html`<i class="${i ? '' : 'on'}"></i>`)}</div>` : ''}
  </div>
  <div class="pdp-info">
    <h1>${p.name}</h1>
    <div class="price pdp-price">${priceLine(p, { badge: true })}</div>
    <span class="tax">Inclusive of all taxes</span>
    ${p.stock != null && p.stock > 0 && p.stock <= 5 ? html`<p class="low">Only ${p.stock} left</p>` : ''}
    <form class="pdp-form" data-pdp-form="${p.id}" id="pdp-form">
      ${p.option_values.length ? html`<fieldset class="chips-opt"><legend>${p.option_label}</legend>
        ${p.option_values.map((v) => html`<label><input type="radio" name="option" value="${v}" required><span>${v}</span></label>`)}</fieldset>` : ''}
      <div class="qty-row"><span class="qty-label" id="qty-label">Quantity</span>
        <div class="stepper" role="group" aria-labelledby="qty-label">
          <button type="button" data-step="-1" aria-label="Decrease quantity">−</button>
          <input name="qty" type="number" min="1" max="10" value="1" inputmode="numeric" aria-labelledby="qty-label">
          <button type="button" data-step="1" aria-label="Increase quantity">+</button>
        </div></div>
      ${p.stock === 0 ? html`<button type="button" class="btn btn-line btn-wide btn-lg" disabled>Sold out</button>` : html`<button type="submit" class="btn btn-gold btn-wide btn-lg add-main">Add to bag</button>`}
    </form>
    <div class="facts">
      ${free ? html`<div>${icon('truck')}Free delivery on orders above ${formatMoney(free)}</div>` : html`<div>${icon('truck')}Ships across India</div>`}
      <div>${icon('upi')}Pay with any UPI app</div>
      ${settings.support_whatsapp ? html`<div>${icon('chat')}Questions? <a class="link" href="${waLink(settings.support_whatsapp, `Hi, I have a question about ${p.name}`)}">Ask on WhatsApp</a></div>` : ''}
    </div>
    ${p.description ? html`<div class="desc">${p.description.split(/\n{2,}/).map((para) => html`<p>${para}</p>`)}</div>` : ''}
  </div>
</article>
${related.length ? html`<section class="section"><div class="row-head"><h2>You may also like</h2></div><ul class="grid">${related.slice(0, 4).map((x) => productCard(x, { admin }))}</ul></section>` : ''}
${p.stock === 0 ? '' : html`<div class="buybar"><div class="price"><b>${formatMoney(p.price_paise)}</b>${off >= 5 ? html`<span class="off">${off}% off</span>` : ''}</div><button class="btn btn-gold" type="submit" form="pdp-form">Add to bag</button></div>`}`;
  return storeLayout({
    settings, user, body, title: p.name, nav: 'shop', bodyClass: 'has-buybar', escape: true,
    edit: admin ? { href: `/admin/products/${p.id}`, label: 'Edit product' } : null,
    pageData: { reelSlug: reel?.slug || '', products: [productForClient(p, reel?.slug || ''), ...related.map((x) => productForClient(x))] },
  });
}

// ---------------------------------------------------------------- reel store (DM landing)
export function reelStorePage({ settings, user, reel, moreReels }) {
  const admin = user?.role === 'owner';
  const products = reel.products;
  const total = products.reduce((s, p) => s + p.price_paise, 0);
  const body = html`
<section class="reel-hero">
  <a class="reel-frame" href="/reels#${reel.slug}" aria-label="Watch the reel">
    ${reel.thumbnail_url ? html`<img src="${reel.thumbnail_url}" alt="">` : ''}
    <span class="play">${icon('play')}</span><span class="reel-frame-label">Watch the reel</span>
  </a>
  <div class="reel-intro">
    <h1>${reel.headline || 'Shop the reel'}</h1>
    <p>${products.length === 1 ? '1 piece' : `${products.length} pieces`} from this reel, in the order they appear.</p>
    ${products.length > 1 ? html`<p>Everything together: <strong>${formatMoney(total)}</strong></p>` : ''}
  </div>
</section>
<ol class="grid" aria-label="Products in this reel">${products.map((p, i) => productCard(p, { href: `/r/${reel.slug}/p/${p.slug}`, seq: i + 1, admin }))}</ol>
${products.length ? '' : html`<p class="empty">Nothing here right now. Check back soon.</p>`}
${moreReels.length ? html`<section class="section"><div class="row-head"><h2>More reels</h2><a class="link" href="/reels">Watch all</a></div><div class="hscroll">${moreReels.map(reelCard)}</div></section>` : ''}`;
  return storeLayout({
    settings, user, body, title: reel.headline || 'Shop the reel', nav: 'reels', escape: true,
    edit: admin ? { href: `/admin/reels/${reel.ig_media_id}`, label: 'Edit reel store' } : null,
    pageData: { reelSlug: reel.slug, products: products.map((p) => productForClient(p, reel.slug)) },
  });
}

// ---------------------------------------------------------------- reels feed
/** Shape sent to the browser for one reel slide. */
export const reelForClient = (r) => ({
  id: r.ig_media_id,
  slug: r.slug,
  headline: r.headline || 'Shop the reel',
  video: r.video_url || '',
  thumb: r.thumbnail_url || '',
  permalink: r.permalink || '',
  count: r.product_count,
  products: (r.preview || []).map((p) => ({ name: p.name, slug: p.slug, price: formatMoney(p.price_paise), image: p.images[0] || '' })),
});

export function reelsFeedPage({ settings, user, feed }) {
  const admin = user?.role === 'owner';
  const body = html`
<div class="feed-top"><a class="round" href="/" aria-label="Back to the store">${icon('back')}</a><h1>Reels</h1>${admin ? html`<a class="btn btn-gold" href="/admin/reels" style="min-height:36px">Manage reels</a>` : html`<span style="width:46px"></span>`}</div>
<div class="feed" data-feed aria-label="Reels">
  <noscript><p style="color:#fff;padding:80px 20px">Turn on JavaScript to watch reels, or <a href="/shop" style="color:#e3ae2c">browse the shop</a>.</p></noscript>
</div>
<template data-end-template>
  <section class="feed-end"><div>
    <h2>You're all caught up</h2>
    <p>New reels drop on our Instagram first.</p>
    <a class="btn btn-gold btn-wide" href="/shop">Shop all products</a>
    ${settings.instagram_handle ? html`<a class="btn btn-line btn-wide" style="border-color:#fff;color:#fff" href="${igLink(settings.instagram_handle)}">Follow @${settings.instagram_handle.replace(/^@/, '')}</a>` : ''}
  </div></section>
</template>`;
  return storeLayout({
    settings, user, body, title: 'Reels', nav: 'reels', bodyClass: 'reels-body',
    pageData: { reels: feed.reels.map(reelForClient), nextCursor: feed.nextCursor, isAdmin: admin },
  });
}

// ---------------------------------------------------------------- about
export function aboutPage({ settings, user }) {
  const admin = user?.role === 'owner';
  const body = html`
<section class="about">
  <h1>About ${settings.store_name}</h1>
  ${settings.hero_subtitle ? html`<p class="lead">${settings.hero_subtitle}</p>` : ''}
  ${settings.about_text ? html`<div class="about-text">${settings.about_text.split(/\n{2,}/).map((p) => html`<p>${p}</p>`)}</div>` : ''}
  ${trustStrip(settings)}
  <div class="panel">
    <h2>Get in touch</h2>
    ${settings.support_whatsapp ? html`<p style="margin:0">WhatsApp: <a class="link" href="${waLink(settings.support_whatsapp)}">+${settings.support_whatsapp}</a></p>` : ''}
    ${settings.support_email ? html`<p style="margin:0">Email: <a class="link" href="mailto:${settings.support_email}">${settings.support_email}</a></p>` : ''}
    ${settings.instagram_handle ? html`<p style="margin:0">Instagram: <a class="link" href="${igLink(settings.instagram_handle)}">@${settings.instagram_handle.replace(/^@/, '')}</a></p>` : ''}
    ${settings.gstin ? html`<p class="muted" style="margin:0">GSTIN ${settings.gstin}</p>` : ''}
  </div>
</section>`;
  return storeLayout({ settings, user, body, title: 'About', nav: 'about', edit: admin ? { href: '/admin/settings', label: 'Edit About page' } : null });
}

// ---------------------------------------------------------------- checkout & order
export function checkoutPage({ settings, user, csrf = '' }) {
  const a = user?.address || {};
  const v = (k, fallback = '') => a[k] ?? fallback;
  const body = html`
<section class="checkout">
  <h1>Checkout</h1>
  <div class="checkout-grid">
    <form class="form" data-checkout data-csrf="${csrf}" novalidate>
      <p class="signed-in">Ordering as <strong>${user.name}</strong> (${user.phone}).${user.address ? ' Your details are filled in from your last order.' : ''}</p>
      <h2>Delivery details</h2>
      <label>Full name<input name="name" autocomplete="name" required maxlength="80" value="${v('name', user?.name || '')}"></label>
      <label>Mobile number<input name="phone" type="tel" inputmode="numeric" autocomplete="tel-national" required placeholder="10-digit number" value="${v('phone', user?.phone || '')}"></label>
      <label><span>Email <span class="opt">(optional)</span></span><input name="email" type="email" autocomplete="email" value="${v('email', user?.email || '')}"></label>
      <label>Address<textarea name="address" rows="3" autocomplete="street-address" required placeholder="House no., street, area, landmark">${v('address')}</textarea></label>
      <div class="row3">
        <label>PIN code<input name="pincode" inputmode="numeric" maxlength="6" autocomplete="postal-code" required value="${v('pincode')}"></label>
        <label>City<input name="city" autocomplete="address-level2" required value="${v('city')}"></label>
        <label>State<input name="state" autocomplete="address-level1" required value="${v('state')}"></label>
      </div>
      <p class="form-error" data-form-error role="alert" hidden></p>
      <button type="submit" class="btn btn-gold btn-wide btn-lg" data-place-order>Place order</button>
      <p class="fine" style="text-align:center">You'll pay on the next screen with any UPI app.</p>
    </form>
    <aside class="summary" data-summary aria-label="Order summary"></aside>
  </div>
</section>`;
  return storeLayout({ settings, user, title: 'Checkout', body, tabs: false, pageData: { page: 'checkout' } });
}

const STEPS = ['awaiting_payment', 'payment_submitted', 'paid', 'shipped', 'delivered'];
const STEP_TEXT = { awaiting_payment: 'Order placed', payment_submitted: 'Payment sent', paid: 'Payment confirmed', shipped: 'Shipped', delivered: 'Delivered' };

export function orderPage({ settings, user, csrf = '', order, qrSvg, upiLink }) {
  const current = STEPS.indexOf(order.status);
  const cancelled = order.status === 'cancelled';
  const body = html`
<section class="order">
  <p class="order-no">Order ${order.order_number}</p>
  <h1>${cancelled ? 'This order was cancelled' : order.status === 'awaiting_payment' ? 'Complete your payment' : `Thanks, ${order.customer_name.split(' ')[0]}!`}</h1>
  ${cancelled ? '' : html`<ol class="steps" aria-label="Order progress">${STEPS.map((s, i) => html`<li class="${i < current ? 'done' : i === current ? 'now' : ''}" ${i === current ? raw('aria-current="step"') : ''}>${STEP_TEXT[s]}</li>`)}</ol>`}
  ${order.status === 'awaiting_payment' ? html`
  <div class="pay">
    <div class="demo-note" role="note"><strong>Demo payment.</strong> Payments aren't connected to a real account yet, so no money will move. Tap “I've paid” to continue.</div>
    <a class="btn btn-gold btn-wide btn-lg" href="${upiLink}">Pay ${formatMoney(order.total_paise)} with UPI app</a>
    <p class="pay-or">Paying from another phone? Scan this code with any UPI app.</p>
    <div class="pay-card"><div class="qr">${raw(qrSvg)}</div>
      <div class="pay-meta"><p class="pay-amount">${formatMoney(order.total_paise)}</p><p class="upi">UPI ID: <span>${settings.upi_id}</span></p></div></div>
    <form method="post" action="/order/${order.public_token}/paid">${csrf ? html`<input type="hidden" name="_csrf" value="${csrf}">` : ''}<button class="btn btn-line btn-wide" type="submit">I've paid ${formatMoney(order.total_paise)}</button></form>
  </div>` : ''}
  ${order.status === 'payment_submitted' ? html`<p class="status-note">We're checking your payment. You'll get a confirmation soon.</p>` : ''}
  ${['paid', 'shipped', 'delivered'].includes(order.status) ? html`<p class="status-note">${ORDER_STATUSES[order.status]}.</p>` : ''}
  <div class="order-detail">
    <h2>Items</h2>
    <ul class="lines">${order.items.map((it) => html`<li>
      ${it.image ? html`<img src="${it.image}" alt="">` : html`<span class="noimg" aria-hidden="true">${it.name.slice(0, 1)}</span>`}
      <span class="line-name">${it.name}${it.option_value ? html`<small>${it.option_value}</small>` : ''}<small>Qty ${it.qty}</small></span>
      <span>${formatMoney(it.price_paise * it.qty)}</span></li>`)}</ul>
    <dl class="totals">
      <div><dt>Subtotal</dt><dd>${formatMoney(order.subtotal_paise)}</dd></div>
      <div><dt>Delivery</dt><dd>${order.shipping_paise ? formatMoney(order.shipping_paise) : 'Free'}</dd></div>
      <div class="grand"><dt>Total</dt><dd>${formatMoney(order.total_paise)}</dd></div>
    </dl>
    <h2>Delivering to</h2>
    <p class="addr">${order.customer_name}<br>${order.address}<br>${order.city}, ${order.state} ${order.pincode}<br>${order.phone}</p>
    ${user ? html`<p><a class="link" href="/account">See all your orders</a></p>` : ''}
  </div>
</section>`;
  return storeLayout({ settings, user, title: `Order ${order.order_number}`, body, tabs: false, pageData: { page: 'order' } });
}

// ---------------------------------------------------------------- accounts
export function loginPage({ settings, error = '', next = '/', phone = '' }) {
  const body = html`
<section class="auth">
  <h1>Log in</h1>
  ${next === '/checkout' ? html`<p class="muted" style="margin:-6px 0 0">Log in or create an account to place your order. Your bag is saved.</p>` : ''}
  <form class="form" method="post" action="/login">
    <input type="hidden" name="next" value="${next}">
    <label>Mobile number<input name="phone" type="tel" inputmode="numeric" autocomplete="tel-national" required value="${phone}" placeholder="10-digit number"></label>
    <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
    ${error ? html`<p class="form-error" role="alert">${error}</p>` : ''}
    <button class="btn btn-gold btn-wide btn-lg" type="submit">Log in</button>
  </form>
  <p class="switch">New here? <a class="link" href="/signup${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}">Create an account</a></p>
  <p class="fine" style="text-align:center">Forgot your password? ${settings.support_whatsapp ? html`<a class="link" href="${waLink(settings.support_whatsapp, 'Hi, I need help resetting my password.')}">Message us on WhatsApp</a> and we'll reset it.` : 'Contact the store and they will reset it.'}</p>
</section>`;
  return storeLayout({ settings, user: null, title: 'Log in', body, nav: 'account' });
}

export function signupPage({ settings, error = '', next = '/', values = {} }) {
  const body = html`
<section class="auth">
  <h1>Create your account</h1>
  <p class="muted" style="margin:-6px 0 0">${next === '/checkout' ? 'One quick step before you place your order. Your bag is saved.' : 'Track your orders and check out faster next time.'}</p>
  <form class="form" method="post" action="/signup">
    <input type="hidden" name="next" value="${next}">
    <label>Your name<input name="name" autocomplete="name" required maxlength="80" value="${values.name || ''}"></label>
    <label>Mobile number<input name="phone" type="tel" inputmode="numeric" autocomplete="tel-national" required value="${values.phone || ''}" placeholder="10-digit number"></label>
    <label>Password<input name="password" type="password" autocomplete="new-password" required minlength="6" placeholder="At least 6 characters"></label>
    ${error ? html`<p class="form-error" role="alert">${error}</p>` : ''}
    <button class="btn btn-gold btn-wide btn-lg" type="submit">Create account</button>
  </form>
  <p class="switch">Already have an account? <a class="link" href="/login${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}">Log in</a></p>
</section>`;
  return storeLayout({ settings, user: null, title: 'Create account', body, nav: 'account' });
}

export function accountPage({ settings, user, isEnvOwner = false, csrf, orders, flash = '' }) {
  const a = user.address;
  const body = html`
<section class="account">
  <div class="account-head">
    <h1>Hi, ${user.name.split(' ')[0]}</h1>
    <form method="post" action="/logout"><input type="hidden" name="_csrf" value="${csrf}"><button class="btn btn-line" type="submit">Log out</button></form>
  </div>
  ${flash ? html`<p class="form-ok" role="status">${flash}</p>` : ''}
  ${user.role === 'owner' ? html`<div class="panel"><h2>You're the store owner</h2><p style="margin:0">Manage products, reels and orders in the admin panel.</p><a class="btn btn-gold" href="/admin">Open admin</a></div>` : ''}
  <div class="panel">
    <h2>Your orders</h2>
    ${orders.length ? orders.map((o) => html`<a class="order-row" href="/order/${o.public_token}">
      <strong>${o.order_number}</strong><span class="status status-${o.status}">${ORDER_STATUSES[o.status]}</span>
      <small>${new Date(o.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}, ${o.items.reduce((n, i) => n + i.qty, 0)} items, ${formatMoney(o.total_paise)}</small>
    </a>`) : html`<p class="muted" style="margin:0">No orders yet. <a class="link" href="/shop">Start shopping</a></p>`}
  </div>
  <div class="panel">
    <h2>Saved address</h2>
    ${a ? html`<p class="addr">${a.name}<br>${a.address}<br>${a.city}, ${a.state} ${a.pincode}<br>${a.phone}</p><p class="fine">This is filled in at checkout. It updates every time you order.</p>`
      : html`<p class="muted" style="margin:0">Your address is saved when you place your first order.</p>`}
  </div>
  ${isEnvOwner ? html`<div class="panel"><h2>Your password</h2><p class="muted" style="margin:0">As the owner, your password is ADMIN_PASSWORD in the server's .env file. Change it there and restart the app.</p></div>` : html`<div class="panel">
    <h2>Change password</h2>
    <form class="form" method="post" action="/account/password">
      <input type="hidden" name="_csrf" value="${csrf}">
      <label>Current password<input name="current" type="password" autocomplete="current-password" required></label>
      <label>New password<input name="password" type="password" autocomplete="new-password" required minlength="6"></label>
      <button class="btn btn-ink" type="submit">Update password</button>
    </form>
  </div>`}
</section>`;
  return storeLayout({ settings, user, title: 'My account', body, nav: 'account' });
}

export function notFoundPage({ settings, user = null, message = 'This page doesn’t exist.' }) {
  return storeLayout({
    settings, user, title: 'Not found',
    body: html`<section class="empty-page"><h1>Nothing here</h1><p class="muted">${message}</p><a class="btn btn-gold" href="/shop">Go to the shop</a></section>`,
  });
}
