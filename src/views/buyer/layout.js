import { esc, html, raw } from '../html.js';
import { FLOURISH_PATHS, SEAL_ICON_PATHS, themeCss, themeFontsHref } from './theme.js';

/**
 * The one buyer page layout (PRD 5.18): every buyer surface (landing pages, categories, the Reels tab, the creator page, the lead
 * form and its thank-you page, the branded 404, and later the store) is this document with sections from the helpers below. It is
 * ported from the "Reel page template" design: header, hero with the reel frame, pinned price tags and seal, the ticker band,
 * sections with a heading flourish, product cards, a strip of more reels, a trust row and the footer.
 *
 * It wears the seller's brand only. Nothing here writes the platform's name, logo or link, in the HTML or in a header (K-34,
 * K-52); a test renders every preset and checks. Every interpolated value is escaped, every link is checked to be a direct web
 * link or a path on this host, and the stylesheet is built from validated tokens (theme.js). No outside script is loaded.
 *
 *   const theme = buyerTheme(await repos.brandKit.get());
 *   res.type('html').send(buyerPage({ theme, business: { name }, meta: { title, url, ... }, main: html`${hero(...)}${...}` }));
 */

/** A link a buyer page may render: https, http, a wa.me link, or a path on this host (never //host, never javascript:). '' otherwise. */
export function safeHref(value) {
  const link = String(value ?? '').trim();
  if (/^\/(?!\/)[^\s"'<>\\]*$/.test(link)) return link;
  if (/^https?:\/\/[^\s"'<>\\]+$/i.test(link)) return link;
  return '';
}

/** Two letters for a business with no logo: "Zari and Co" is ZC. */
export function initials(name) {
  const words = String(name ?? '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w && !/^(and|of|the|&)$/i.test(w));
  return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] ?? '').slice(0, 2)).toUpperCase();
}

/**
 * The <head> tags for sharing (8.12), early in the document: og:url (no query string), og:title, og:description, a sized og:image,
 * og:type and twitter:card, plus the canonical link and robots. `indexable` false (the default) is noindex.
 */
function headTags(meta) {
  const url = safeHref(meta.url);
  const ogUrl = url ? url.split(/[?#]/)[0] : '';
  const canonical = safeHref(meta.canonical ?? ogUrl);
  const image = meta.image && safeHref(meta.image.url) ? meta.image : null;
  return html`<title>${meta.title}</title>
<meta name="description" content="${meta.description ?? ''}">
${ogUrl ? html`<meta property="og:url" content="${ogUrl}">` : ''}
<meta property="og:title" content="${meta.ogTitle ?? meta.title}">
<meta property="og:description" content="${meta.description ?? ''}">
${image ? html`<meta property="og:image" content="${safeHref(image.url)}">${image.width ? html`<meta property="og:image:width" content="${Number(image.width)}">` : ''}${image.height ? html`<meta property="og:image:height" content="${Number(image.height)}">` : ''}${image.alt ? html`<meta property="og:image:alt" content="${image.alt}">` : ''}` : ''}
<meta property="og:type" content="${meta.type === 'product' ? 'product' : 'website'}">
${meta.siteName ? html`<meta property="og:site_name" content="${meta.siteName}">` : ''}
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
${canonical ? html`<link rel="canonical" href="${canonical}">` : ''}
<meta name="robots" content="${meta.indexable ? 'index,follow' : 'noindex,follow'}">`;
}

/**
 * The whole document. `business` is { name, logoUrl? } (the logo defaults to the theme's), `meta` the head tags above, `main` the
 * page's sections, `headerEnd` what sits at the header's right (a chip, a bag), `footer` { note?, whatsappHref?, whatsappLabel?, links? }.
 * Send it with sendBuyerPage (index.js), which also tells the traffic counter what kind of page it is.
 */
export function buyerPage({ theme, business = {}, meta = {}, main = '', headerEnd = '', footer = {}, bodyClass = '' }) {
  const name = String(business.name ?? '').trim() || 'Shop';
  const logo = safeHref(business.logoUrl || theme.logoUrl);
  const favicon = safeHref(theme.faviconUrl || logo);
  return html`<!doctype html>
<html lang="${meta.lang === 'hi' ? 'hi' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${headTags({ siteName: name, ...meta })}
<meta name="theme-color" content="${theme.colors.ground}">
${favicon ? html`<link rel="icon" href="${favicon}">` : ''}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${themeFontsHref(theme)}">
<style>${raw(themeCss(theme))}</style>
</head>
<body${bodyClass ? html` class="${bodyClass}"` : ''}>
<a class="skip" href="#main">Skip to content</a>
<div class="ground" aria-hidden="true"></div>
<div class="page">
<header class="site-header">
<a class="brand" href="/">${logo ? html`<span class="logo"><img src="${logo}" alt="" width="38" height="38"></span>` : html`<span class="logo" aria-hidden="true">${initials(name)}</span>`}<span class="brand-name">${name}</span></a>
${headerEnd}
</header>
<main id="main">
${main}
</main>
${siteFooter(footer)}
</div>
</body>
</html>`;
}

function siteFooter({ note = '', whatsappHref = '', whatsappLabel = 'Chat with us on WhatsApp', links = [], extra = '' } = {}) {
  const wa = safeHref(whatsappHref);
  const items = links.map((l) => ({ href: safeHref(l.href), label: l.label })).filter((l) => l.href);
  return html`<footer class="site-footer">
${note ? html`<span>${note}</span>` : ''}
${wa ? html`<a class="outline-btn" href="${wa}"${wa.startsWith('http') ? raw(' rel="noopener"') : ''}>${icon('chat', 18)}${whatsappLabel}</a>` : ''}
${items.length ? html`<nav aria-label="More">${items.map((l) => html`<a href="${l.href}">${l.label}</a> `)}</nav>` : ''}
${extra}
</footer>`;
}

/**
 * The hero: eyebrow, the headline with its highlighted words, and the reel frame with the media, up to two pinned price tags and
 * the seal. `media` { imageUrl, videoUrl, linkUrl, alt, width, height }: the image is the page's largest paint, so it loads first.
 */
export function hero({ theme, eyebrow = '', title = '', highlight = '', media = {}, tags = [], seal = true, id = 'hero-title' }) {
  const image = safeHref(media.imageUrl);
  const video = safeHref(media.videoUrl);
  const link = safeHref(media.linkUrl);
  const play = html`<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="${theme.colors.primary}"></path></svg>`;
  return html`<section class="hero" aria-labelledby="${id}">
<div>${eyebrow ? html`<span class="eyebrow">${eyebrow}</span>` : ''}
<h1 id="${id}">${title}${highlight ? html` <span class="hl">${highlight}</span>` : ''}</h1></div>
<div class="stage">
<div class="frame">
${video ? html`<video src="${video}"${image ? html` poster="${image}"` : ''} controls playsinline preload="none" aria-label="${media.alt ?? title}"></video>`
    : image ? html`<img src="${image}" alt="${media.alt ?? ''}" width="${Number(media.width) || 290}" height="${Number(media.height) || 380}" fetchpriority="high" decoding="async">` : ''}
${!video && link ? html`<a class="play" href="${link}" rel="noopener" aria-label="Watch the reel">${play}</a>` : ''}
</div>
${tags.slice(0, 2).map((t) => html`<span class="tag"><b></b><span>${t.text}</span></span>`)}
${seal ? sealBadge(theme) : ''}
</div>
</section>`;
}

/** The round seal with its text around the edge (5.19). The seller can edit the words (F-106). */
export function sealBadge(theme) {
  const text = String(theme.slots.sealText ?? '').trim();
  if (!text) return '';
  const path = Object.hasOwn(SEAL_ICON_PATHS, theme.slots.sealIcon) ? SEAL_ICON_PATHS[theme.slots.sealIcon] : SEAL_ICON_PATHS.star;
  return html`<svg class="seal" viewBox="0 0 104 104" aria-hidden="true"><defs><path id="seal-path" d="M52 52 m-38 0 a38 38 0 1 1 76 0 a38 38 0 1 1 -76 0"></path></defs>
<circle cx="52" cy="52" r="50"></circle><text><textPath href="#seal-path">${text} · ${text} · </textPath></text><path d="${path}"></path></svg>`;
}

/** The band of selling points (5.19), shown twice so it fills the width. Decorative: screen readers skip it. */
export function ticker(theme, items = theme.slots.tickerItems) {
  const list = (items ?? []).filter(Boolean).slice(0, 8);
  if (!list.length) return '';
  return html`<div class="ticker" aria-hidden="true"><div>${[...list, ...list].map((item) => html`<span>${item}<i></i></span>`)}</div></div>`;
}

/** A section with its kicker, heading and the theme's heading flourish. `body` is the section's content. */
export function section({ theme, id, kicker = '', title, body = '' }) {
  const flourish = Object.hasOwn(FLOURISH_PATHS, theme.slots.flourish) ? FLOURISH_PATHS[theme.slots.flourish] : FLOURISH_PATHS.line;
  return html`<section class="section" aria-labelledby="${id}">
<div>${kicker ? html`<span class="kicker">${kicker}</span>` : ''}
<h2 id="${id}">${title}</h2>
<svg width="140" height="14" viewBox="0 0 140 14" aria-hidden="true"><path class="flourish" d="${flourish}"></path></svg></div>
${body}
</section>`;
}

/**
 * One product card. `price` is displayPrice()'s answer formatted by the caller: { now, was, off } as text, or soldOut. `href` is the
 * product's own page or the seller's site, opened directly (no redirect); `productId` lets the click beacon count the tap once.
 * `actions` replaces the default button (a WhatsApp button beside it, say).
 */
export function productCard({ name, imageUrl = '', imageAlt = '', number = '', price = {}, href = '', buttonText = 'Visit website', productId = null, eager = false, actions = null }) {
  const link = safeHref(href);
  const image = safeHref(imageUrl);
  const outside = /^https?:/i.test(link);
  const dataProduct = Number.isInteger(productId) && productId > 0 ? raw(` data-product="${productId}"`) : '';
  return html`<article class="card${price.soldOut ? ' is-sold' : ''}">
<span class="photo">${image ? html`<img src="${image}" alt="${imageAlt}" width="96" height="116"${eager ? '' : raw(' loading="lazy"')} decoding="async">` : ''}${number !== '' ? html`<span class="num">${number}</span>` : ''}</span>
<div class="card-body">
<h3>${name}</h3>
<div class="prices">${price.soldOut ? html`<span class="sold">Sold out</span>` : ''}${price.now ? html`<span class="price">${price.now}</span>` : ''}${price.was ? html`<span class="mrp">${price.was}</span>` : ''}${price.off ? html`<span class="off">${price.off}</span>` : ''}</div>
${actions ?? (link ? html`<a class="btn" href="${link}"${outside ? raw(' rel="noopener"') : ''}${dataProduct} aria-label="${buttonText}, ${name}">${buttonText}</a>` : '')}
</div>
</article>`;
}

/** A strip of round tiles: more reels, categories. Each opens its own page directly. */
export function tileStrip({ items = [] }) {
  const tiles = items.map((t) => ({ ...t, href: safeHref(t.href), image: safeHref(t.imageUrl) })).filter((t) => t.href);
  if (!tiles.length) return '';
  return html`<div class="strip">${tiles.map((t) => html`<a href="${t.href}"><span class="thumb">${t.image ? html`<img src="${t.image}" alt="" width="66" height="66" loading="lazy" decoding="async">` : ''}</span>${t.label}</a>`)}</div>`;
}

const ICONS = Object.freeze({
  truck: 'M2 6h11v8H2zM13 9h4l3 3v2h-7M5 17a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM16 17a1.5 1.5 0 100-3 1.5 1.5 0 000 3z',
  cash: 'M3 6h16v10H3zM11 13a2 2 0 100-4 2 2 0 000 4z',
  returns: 'M5 8a7 7 0 1 1-1 5M5 3v5h5',
  shield: 'M11 2l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V5z',
  star: 'M11 2l2.6 5.6 6 .7-4.5 4.1 1.2 6-5.3-3-5.3 3 1.2-6L2.4 8.3l6-.7z',
  chat: 'M3 15l1-3.2A6.5 6.5 0 1115 9a6.5 6.5 0 01-9.4 5.8z',
  bag: 'M4 7h12l-1 10H5zM7 7V5a3 3 0 016 0v2',
  search: 'M9 15a6 6 0 100-12 6 6 0 000 12zM13.5 13.5L18 18',
});
export const ICON_NAMES = Object.freeze(Object.keys(ICONS));

/** A line icon from the fixed set, in the theme's ink or primary through CSS. */
export function icon(name, size = 22) {
  const d = Object.hasOwn(ICONS, name) ? ICONS[name] : ICONS.star;
  return html`<svg width="${size}" height="${size}" viewBox="0 0 22 22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"></path></svg>`;
}

/** The trust row: up to three { label, icon } the seller actually offers. Shows nothing when given nothing. */
export function trustRow(items = []) {
  const list = items.filter((i) => i?.label).slice(0, 3);
  if (!list.length) return '';
  return html`<section class="trust" aria-label="Why shop with us">${list.map((i) => html`<div>${icon(i.icon)}${i.label}</div>`)}</section>`;
}

/** The branded 404 (K-33, K-59): the seller's look and name, and a way back to their home page. */
export function notFoundPage({ theme, business, message = 'This page isn’t available.' }) {
  return buyerPage({
    theme,
    business,
    meta: { title: `Not found · ${String(business?.name ?? '').trim() || 'Shop'}`, description: message, indexable: false },
    main: html`<section class="notice"><h1>Not found</h1><p>${message}</p><a class="btn" href="/">Go to the home page</a></section>`,
  });
}

/** Escapes text for an attribute or text node outside the html`` template. */
export const escapeText = esc;
