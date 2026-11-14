import { icon, initials, safeHref } from '../../views/buyer/index.js';
import { html, raw } from '../../views/html.js';

/**
 * How the creator page looks (PRD 8.14): a link-in-bio page for a phone held in one hand. A cover band in the brand's colour,
 * the photo (or initials) sitting half over it, the name and the about line, then two wide buttons, the search field, link
 * blocks, and the shelves of reel tiles. It is the shared buyer layout with these rules on top, so it follows every preset:
 * buttons, cards, fonts and colours come from the theme's stylesheet, and the few shapes this page adds (the photo, the tiles)
 * are picked from the fixed tables below by the preset's slot names. A preset is data; nothing a seller types reaches this CSS.
 *
 * The page's own header is the profile, so the layout's small logo-and-name bar is not shown here.
 */

// The photo follows the preset's logo shape.
const PHOTO = {
  arch: 'border-radius:60px 60px 16px 16px',
  circle: 'border-radius:999px',
  brutal: 'border-radius:30px;border:3px solid var(--ink);box-shadow:5px 5px 0 var(--ink)',
  square: 'border-radius:28px',
  leaf: 'border-radius:60px 18px 60px 18px',
};
// The reel tiles follow the preset's card style.
const TILE = {
  framed: 'border-radius:8px;box-shadow:0 0 0 1px var(--accent)',
  floating: 'border-radius:22px;box-shadow:0 14px 24px -18px var(--shadow)',
  brutalist: 'border-radius:16px;border:2px solid var(--ink);box-shadow:3px 3px 0 var(--ink)',
  panel: 'border-radius:14px;box-shadow:0 0 0 1px var(--line)',
  stitched: 'border-radius:16px',
  plain: 'border-radius:12px',
};
const COVER = {
  brutalist: 'border-bottom:3px solid var(--ink);border-radius:0',
  framed: 'border-radius:0 0 4px 4px;border-bottom:3px double var(--accent)',
};
const pick = (table, name, fallback) => (Object.hasOwn(table, name) ? table[name] : fallback);

const BASE = [
  '.creator .site-header{display:none}',
  '.creator-cover{height:124px;border-radius:0 0 28px 28px;background:radial-gradient(circle at 86% 20%,var(--accent) 0 30px,transparent 31px),radial-gradient(circle at 10% 125%,var(--glow) 0 112px,transparent 113px),radial-gradient(circle at 58% -34%,var(--glow) 0 92px,transparent 93px),var(--primary)}',
  '.creator-head{margin-top:-64px;padding:0 20px;display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center}',
  '.creator-photo{width:120px;height:120px;flex:none;overflow:hidden;display:flex;align-items:center;justify-content:center;background:var(--accent);color:var(--on-accent);font-family:var(--display);font-weight:var(--display-weight);font-size:40px;letter-spacing:.02em;border:4px solid var(--ground);box-shadow:0 12px 26px -16px rgba(0,0,0,.55)}',
  '.creator-photo img{width:100%;height:100%;object-fit:cover;background:var(--card)}',
  '.creator-head h1{margin-top:4px;font-family:var(--display);font-weight:var(--display-weight);font-size:clamp(26px,7.6vw,34px);line-height:1.1;letter-spacing:-.02em;overflow-wrap:anywhere}',
  '.creator-head p{margin:0;font-size:15px;line-height:1.5;color:var(--muted);max-width:38ch;overflow-wrap:anywhere}',
  '.creator-links{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:10px;width:100%;margin-top:10px}',
  '.creator-links a{align-self:auto;min-height:52px;padding:0 12px}',
  '.creator-links .outline-btn{background:var(--card)}',
  '.creator-search{position:relative;display:flex;margin:24px 20px 0}',
  '.creator-search input{flex:1;min-width:0;height:54px;padding:0 62px 0 20px;border:1.5px solid var(--line-strong);border-radius:999px;background:var(--card);color:var(--ink);font:inherit;-webkit-appearance:none;appearance:none}',
  '.creator-search input::placeholder{color:var(--muted);opacity:1}',
  '.creator-search button{position:absolute;right:5px;top:5px;width:44px;height:44px;min-height:0;padding:0;border-radius:999px;box-shadow:none;letter-spacing:0}',
  '.chips{padding:14px 20px 4px}',
  '.creator .section{padding-top:34px}',
  '.creator .chips+.section,.creator .creator-search+.section{padding-top:22px}',
  '.creator-link{margin:16px 20px 0;align-items:center;min-height:68px;text-decoration:none;font-weight:700;font-size:16px;line-height:1.3}',
  '.creator-link img{flex:none;width:52px;height:52px;object-fit:cover;border-radius:12px}',
  '.creator-link span{flex:1;min-width:0;overflow-wrap:anywhere}',
  '.creator-link svg{flex:none;color:var(--primary)}',
  '.creator .section h2 a{display:inline-flex;align-items:center;gap:10px;min-height:44px;text-decoration:none}',
  '.creator .section h2 a::after{content:"";flex:none;width:9px;height:9px;border-top:2.5px solid var(--primary);border-right:2.5px solid var(--primary);transform:rotate(45deg)}',
  '.creator .reel-grid{gap:10px}',
  '.creator .reel-tile::before{content:"";position:absolute;top:8px;right:8px;width:24px;height:24px;border-radius:999px;background:rgba(0,0,0,.5)}',
  '.creator .reel-tile::after{content:"";position:absolute;top:15px;right:15px;border-left:8px solid #FFFFFF;border-top:5px solid transparent;border-bottom:5px solid transparent}',
  '.creator .more-tiles{padding-top:8px}',
  '.creator .more-tiles .btn-quiet{align-self:center;padding:0 20px;border-radius:999px;background:var(--chip);font-size:14px;text-decoration:none}',
  '.shelf-link{display:inline-flex;align-items:center;min-height:44px;font-size:14px;font-weight:600}',
  '.creator .site-footer{align-items:center;text-align:center;margin-top:40px}',
  '.made-with{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0 16px;border-radius:999px;background:var(--card);border:1px solid var(--line);color:var(--ink);font-size:13px;font-weight:600;text-decoration:none}',
  '.made-with svg{color:var(--primary)}',
].join('');

/** The page's own rules for this theme, to go after the layout's stylesheet. */
export function creatorCss(theme) {
  const slots = theme?.slots ?? {};
  const cover = pick(COVER, slots.cardStyle, '');
  return [
    BASE,
    `.creator-photo{${pick(PHOTO, slots.logoShape, PHOTO.circle)}}`,
    `.creator .reel-tile{${pick(TILE, slots.cardStyle, TILE.plain)}}`,
    cover ? `.creator-cover{${cover}}` : '',
  ].join('');
}

/** The class the layout's <body> takes on every view of the creator page. */
export const CREATOR_BODY = 'creator';

const chevron = raw('<svg width="20" height="20" viewBox="0 0 22 22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4l7 7-7 7"></path></svg>');
const spark = raw('<svg width="14" height="14" viewBox="0 0 22 22" aria-hidden="true" fill="currentColor"><path d="M11 1l2.6 7.4L21 11l-7.4 2.6L11 21l-2.6-7.4L1 11l7.4-2.6z"></path></svg>');

/**
 * The profile header: the cover, the photo or the name's initials, the name, the about line, and up to two buttons (the
 * website, WhatsApp). `photo`, `website` and `whatsapp` are links already checked by the caller; '' leaves each out.
 */
export function profileHead({ name, bio = '', photo = '', website = '', whatsapp = '' }) {
  const picture = safeHref(photo);
  const site = safeHref(website);
  const wa = safeHref(whatsapp);
  return html`<div class="creator-cover" aria-hidden="true"></div>
<section class="creator-head" aria-labelledby="creator-name">
<span class="creator-photo">${picture ? html`<img src="${picture}" alt="" width="120" height="120" decoding="async">` : html`<span aria-hidden="true">${initials(name)}</span>`}</span>
<h1 id="creator-name">${name}</h1>
${bio ? html`<p>${bio}</p>` : ''}
${site || wa ? html`<div class="creator-links">
${site ? html`<a class="btn" href="${site}" rel="noopener">Visit website</a>` : ''}
${wa ? html`<a class="outline-btn" href="${wa}" rel="noopener">${icon('chat', 18)}WhatsApp</a>` : ''}
</div>` : ''}
</section>`;
}

/**
 * A link block (the `banner` block): a wide, tappable card with an optional small picture, the words and an arrow. With no
 * link it is a notice in the same card. A block always has words (the API refuses one without), so one without shows nothing.
 */
export function linkBlock({ text = '', imageUrl = '', linkUrl = '' }) {
  const words = String(text ?? '').trim().slice(0, 160);
  const image = safeHref(imageUrl);
  const link = safeHref(linkUrl);
  if (!words) return '';
  const inner = html`${image ? html`<img src="${image}" alt="" width="52" height="52" loading="lazy" decoding="async">` : ''}<span>${words}</span>${link ? chevron : ''}`;
  if (!link) return html`<div class="card creator-link">${inner}</div>`;
  return html`<a class="card creator-link" href="${link}"${/^https?:/i.test(link) ? raw(' rel="noopener"') : ''}>${inner}</a>`;
}

/** The search field: this page's reels and products only (K-60). */
export function searchBox(slug, q = '') {
  return html`<form class="creator-search" method="get" action="/${slug}" role="search">
<input type="search" name="q" value="${q}" maxlength="80" placeholder="Search reels and products" aria-label="Search reels and products" enterkeyhint="search">
<button class="btn" type="submit" aria-label="Search">${icon('search', 20)}</button></form>`;
}

/**
 * The Free plan's footer badge (K-64): the one place the platform is named on a buyer page. `link` is the sign-up page with
 * this business's referral code (5.20); without one the badge is words only.
 */
export function madeWithBadge(link = '') {
  const href = /^https:\/\//i.test(link) ? safeHref(link) : '';
  return href ? html`<a class="made-with" href="${href}" rel="noopener">${spark}Made with Bhava</a>` : html`<span class="made-with">${spark}Made with Bhava</span>`;
}
