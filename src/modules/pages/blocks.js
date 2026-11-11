import { z } from 'zod';
import { ApiError } from '../../contracts/api/index.js';
import { BUYER_BLOCKS } from '../../contracts/buyer-pages.js';
import { ICON_NAMES, icon, safeHref, section, ticker, trustRow } from '../../views/buyer/index.js';
import { html, raw } from '../../views/html.js';

/**
 * The block library (PRD 5.18 level 3): one piece of code per block, shared by every business. A business chooses which blocks a
 * surface shows and in what order (page_blocks); each block's settings are plain values checked here before they are saved, so
 * no block can carry markup, CSS or script onto a buyer page. A fix here reaches every business using the block (F-99).
 *
 * Blocks that need a page's own data (hero, products, more_reels, shelves, lead_form) are drawn by the surface that owns that
 * data; the rest are drawn by renderSharedBlock for any surface.
 */

const plain = (max) => z.string().trim().min(1).max(max).regex(/^[^<>{}\0]*$/, 'Use plain words only');
const webLink = z.string().trim().max(1000).regex(/^https:\/\/[^\s"'<>\\]+$/i, 'Use a web link starting with https://');
const pageLink = z.string().trim().max(1000).regex(/^(https:\/\/[^\s"'<>\\]+|\/(?!\/)[^\s"'<>\\]*)$/i, 'Use a web link or a page of your shop');
const imageLink = z.string().trim().max(1000).regex(/^(https:\/\/[^\s"'<>\\]+|\/media\/[\w-]+)$/i, 'Use an uploaded image or a web link');
const none = z.object({}).strict();

/** Each block's settings. Unknown keys are refused; a block with no settings takes none. */
export const BLOCK_SETTINGS = Object.freeze({
  hero: none,
  ticker: none,
  products: none,
  more_reels: none,
  shelves: none,
  lead_form: none,
  whatsapp: none,
  trust: z.object({ items: z.array(z.object({ label: plain(40), icon: z.enum(ICON_NAMES).default('star') }).strict()).min(1).max(3) }).partial().strict(),
  banner: z.object({ text: plain(120), imageUrl: imageLink.optional(), linkUrl: pageLink.optional() }).strict(),
  countdown: z.object({ text: plain(80), endsAt: z.iso.datetime({ offset: true }) }).strict(),
  testimonials: z.object({ items: z.array(z.object({ quote: plain(300), name: plain(60) }).strict()).min(1).max(6) }).strict(),
  faq: z.object({ items: z.array(z.object({ q: plain(150), a: plain(600) }).strict()).min(1).max(10) }).strict(),
  video: z.object({ url: webLink }).strict(),
  bulk_order: z.object({ text: plain(200) }).strict(),
});

/**
 * A surface's blocks as they may be saved: each allowed on that surface, each with valid settings, and the blocks that are
 * the page itself (one hero, one list of products) at most once. Throws a 400 naming the block that is wrong.
 */
export function checkBlocks(surface, blocks) {
  const fields = {};
  const once = new Set(['hero', 'products', 'more_reels', 'shelves', 'lead_form', 'whatsapp', 'ticker']);
  const seen = new Set();
  const clean = blocks.map((b, i) => {
    const spec = Object.hasOwn(BUYER_BLOCKS, b.block) ? BUYER_BLOCKS[b.block] : null;
    if (!spec || !spec.surfaces.includes(surface)) {
      fields[`blocks.${i}.block`] = 'That block can’t go on this page';
      return b;
    }
    if (once.has(b.block) && seen.has(b.block)) fields[`blocks.${i}.block`] = 'This block can be used once on a page';
    seen.add(b.block);
    const parsed = BLOCK_SETTINGS[b.block].safeParse(b.settings ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      fields[`blocks.${i}.settings${issue?.path?.length ? `.${issue.path.join('.')}` : ''}`] = issue?.message ?? 'Check this block’s settings';
      return b;
    }
    return { block: b.block, visible: b.visible !== false, settings: parsed.data };
  });
  if (Object.keys(fields).length) throw new ApiError('validation_failed', Object.values(fields)[0], { fields });
  return clean;
}

/** Settings as stored, checked again before they are drawn: a row that no longer fits its block draws nothing. */
function settingsOf(block) {
  const schema = Object.hasOwn(BLOCK_SETTINGS, block.block) ? BLOCK_SETTINGS[block.block] : null;
  const parsed = schema?.safeParse(block.settings ?? {});
  return parsed?.success ? parsed.data : null;
}

// Styles for the library's own blocks, on top of the shared layout's. Fixed text: nothing a seller typed is in here.
export const BLOCK_CSS = [
  // A tilted ticker and the pinned tags may reach past a narrow phone's edge: they are cut there, never scrolled to.
  '.page{overflow-x:hidden;overflow-x:clip}',
  '.lede{margin:0;padding:14px 20px 0;color:var(--muted);font-size:15px}',
  '.banner{margin:28px 20px 0;display:block;border-radius:var(--r-btn);overflow:hidden;background:var(--primary);color:var(--on-primary);text-decoration:none}',
  '.banner img{width:100%;height:auto;aspect-ratio:2/1;object-fit:cover}',
  '.banner span{display:block;padding:14px 16px;font-weight:700}',
  '.countdown{margin:28px 20px 0;padding:14px 16px;border-radius:12px;background:var(--accent);color:var(--on-accent);font-weight:700;display:flex;flex-direction:column;gap:2px}',
  '.countdown time{font-weight:600;font-size:14px}',
  '.faq details{border-bottom:1px solid var(--line);padding:4px 0}',
  '.faq summary{min-height:44px;display:flex;align-items:center;font-weight:600;cursor:pointer}',
  '.faq p{margin:0 0 12px;color:var(--muted)}',
  '.quotes{display:flex;flex-direction:column;gap:12px}',
  '.quotes figure{margin:0;padding:14px;background:var(--card);border:1px solid var(--line);border-radius:12px}',
  '.quotes blockquote{margin:0 0 8px}',
  '.quotes figcaption{font-size:14px;font-weight:600;color:var(--muted)}',
  '.clip{margin:0 20px;border-radius:12px;overflow:hidden;background:var(--frame-bg)}',
  '.clip video{width:100%;aspect-ratio:16/9}',
  '.bulk{display:flex;flex-direction:column;gap:12px}',
  '.bulk p{margin:0}',
  '.actions{display:flex;flex-wrap:wrap;gap:8px}',
  '.btn-wa{min-height:44px;display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:0 14px;border-radius:var(--r-btn);border:1.5px solid var(--ink);color:var(--ink);font-size:14px;font-weight:700;text-decoration:none}',
].join('');
export const blockStyles = () => html`<style>${raw(BLOCK_CSS)}</style>`;

const DATE = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });

/**
 * Draws a block that needs nothing but its settings and the business: ticker, trust, banner, countdown, testimonials, faq, video,
 * bulk_order. Returns '' for a block it doesn't draw, for one whose settings no longer fit, and for a countdown that has ended.
 * `context` is { theme, whatsappNumber?, trustItems?, now? }.
 */
export function renderSharedBlock(block, { theme, whatsappNumber = '', trustItems = [], now = new Date() } = {}) {
  const settings = settingsOf(block);
  if (!settings) return '';
  switch (block.block) {
    case 'ticker':
      return ticker(theme);
    case 'trust':
      return trustRow(settings.items?.length ? settings.items : trustItems);
    case 'banner': {
      const link = safeHref(settings.linkUrl);
      const image = safeHref(settings.imageUrl);
      const body = html`${image ? html`<img src="${image}" alt="" width="520" height="260" loading="lazy" decoding="async">` : ''}<span>${settings.text}</span>`;
      return link ? html`<a class="banner" href="${link}"${/^https?:/i.test(link) ? raw(' rel="noopener"') : ''}>${body}</a>` : html`<div class="banner">${body}</div>`;
    }
    case 'countdown': {
      const ends = new Date(settings.endsAt);
      if (!(ends > now)) return '';
      return html`<p class="countdown"><span>${settings.text}</span><time datetime="${ends.toISOString()}">Ends ${DATE.format(ends)}</time></p>`;
    }
    case 'testimonials':
      return section({ theme, id: 'said-h', title: 'What customers say', body: html`<div class="quotes">${settings.items.map((t) => html`<figure><blockquote>${t.quote}</blockquote><figcaption>${t.name}</figcaption></figure>`)}</div>` });
    case 'faq':
      return section({ theme, id: 'faq-h', title: 'Questions', body: html`<div class="faq">${settings.items.map((f) => html`<details><summary>${f.q}</summary><p>${f.a}</p></details>`)}</div>` });
    case 'video': {
      const url = safeHref(settings.url);
      return url ? html`<div class="clip"><video src="${url}" controls playsinline preload="none" aria-label="Video"></video></div>` : '';
    }
    case 'bulk_order': {
      const wa = whatsappNumber ? `https://wa.me/${whatsappNumber}?text=${encodeURIComponent('Hi, I would like to place a bulk order.')}` : '';
      return section({ theme, id: 'bulk-h', title: 'Buying in bulk?', body: html`<div class="bulk"><p>${settings.text}</p>${wa ? html`<a class="btn" href="${wa}" rel="noopener">${icon('chat', 18)}Ask on WhatsApp</a>` : ''}</div>` });
    }
    default:
      return '';
  }
}
