import { whatsappDigits, whatsappOrderLink } from '../../contracts/catalog.js';
import { buyerPage, hero, icon, priceText, productCard, safeHref, section, tileStrip } from '../../views/buyer/index.js';
import { html, raw } from '../../views/html.js';
import { directLink } from '../links/rules.js';
import { blockStyles, renderSharedBlock } from './blocks.js';
import { heroMedia } from './media.js';
import { sized } from './variants.js';

/**
 * The landing page (PRD 8.10): the reel, post or story at the top, then its products in the owner's order as numbered cards,
 * each opening the product directly. Its sections are the business's blocks for the "landing" surface, in the business's order
 * (5.18); the look is the theme. Every preset draws the same sections in the same order (F-105), and nothing here names the
 * platform.
 */

const KIND_WORD = { reel: 'reel', post: 'post', story: 'story' };

/** "The Banarasi Edit" is drawn as "The Banarasi" with "Edit" highlighted, the way every preset's headline is. */
function splitHeadline(text) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return { title: words.join(' '), highlight: '' };
  return { title: words.slice(0, -1).join(' '), highlight: words.at(-1) };
}

/** A product's name cut at a word to at most `max` characters, for a small tag. */
function shortName(name, max = 12) {
  const words = String(name).trim().split(/\s+/);
  let out = words[0].slice(0, max);
  for (const word of words.slice(1)) {
    if (out.length + 1 + word.length > max) break;
    out += ` ${word}`;
  }
  return out;
}

/** A linked product whose page gave no price is stored at zero and shows none (K-23). */
const pricePaiseOf = (product) => (!product.shown.pricePaise && product.external_url ? null : product.shown.pricePaise);

function cardPrice(product) {
  return priceText({ pricePaise: pricePaiseOf(product), mrpPaise: product.shown.mrpPaise, soldOut: product.shown.soldOut });
}

/**
 * Where a product's button goes, straight there with no hop in between (K-32): the seller's or another site's own address with
 * the tags of 6.6, or this page's product page when the product is sold here.
 */
export function productHref(product, page, { utmEnabled = true, campaign = '' } = {}) {
  if (product.external_url) {
    return directLink({ url: product.external_url, linkType: 'seller_site', channel: page.channel, automationSlug: campaign || page.slug, mediaId: page.ig_media_id, utmEnabled });
  }
  return `/r/${encodeURIComponent(page.slug)}/p/${encodeURIComponent(product.slug)}`;
}

function productsBlock({ theme, page, products, links, whatsapp }) {
  if (!products.length) return '';
  const cards = products.map((product, index) => {
    const href = safeHref(productHref(product, page, links));
    const outside = /^https?:/i.test(href);
    const buttonText = product.external_url ? 'Visit website' : 'View product';
    const wa = whatsapp.forProduct(product);
    const actions = html`<div class="actions">
${href ? html`<a class="btn" href="${href}"${outside ? raw(' rel="noopener"') : ''} data-product="${product.id}" aria-label="${buttonText}, ${product.name}">${buttonText}</a>` : ''}
${wa ? html`<a class="btn-wa" href="${wa}" rel="noopener" data-product="${product.id}" aria-label="Order on WhatsApp, ${product.name}">${icon('chat', 18)}Order on WhatsApp</a>` : ''}
</div>`;
    // Every card photo is lazy and small, so the picture at the top of the page has the connection to itself first (8.12).
    return productCard({ name: product.name, imageUrl: sized(product.image_url, 'card'), imageAlt: product.name, number: index + 1, price: cardPrice(product), productId: product.id, actions });
  });
  const word = KIND_WORD[page.kind] ?? 'reel';
  return section({ theme, id: 'products-h', kicker: `${products.length} ${products.length === 1 ? 'product' : 'products'}`, title: `Shop the ${word}`, body: cards });
}

function moreReelsBlock({ theme, more }) {
  if (!more?.items?.length) return '';
  const items = more.items.map((r) => ({ href: `/r/${encodeURIComponent(r.slug)}`, label: r.headline || 'Watch', imageUrl: sized(r.tile_image, 'tile') }));
  return section({ theme, id: 'more-h', title: more.categoryName ? `More from ${more.categoryName}` : 'More reels', body: tileStrip({ items }) });
}

/**
 * The whole page as HTML.
 *   page       the landing page with its live products (repos.landingPages.getBySlug)
 *   layout     { theme, business, settings } from loadBuyerLayout
 *   blocks     the "landing" layout's blocks, in order
 *   pageUrl    this page's own address, with no query string
 *   preview    { url, width, height } of the share image, or null
 *   options    { settings: page settings, whatsappAllowed, utmEnabled, campaign, more, extraBlocks: { lead_form: html }, trustItems, now }
 */
export function landingPageView({ page, layout, blocks, pageUrl, preview = null, options = {} }) {
  const { theme, business, settings } = layout;
  const { settings: pageSettings, whatsappAllowed = false, utmEnabled = true, campaign = '', more = null, extraBlocks = {}, trustItems = [], now = new Date() } = options;
  const products = page.products;
  const number = whatsappDigits(settings.support_whatsapp);
  const whatsapp = {
    forProduct(product) {
      if (!whatsappAllowed || !number) return '';
      if (!(product.whatsapp_order ?? pageSettings.whatsapp_order)) return '';
      return whatsappOrderLink({ number, template: pageSettings.whatsapp_template, productName: product.name, pricePaise: pricePaiseOf(product), url: pageUrl }) ?? '';
    },
  };

  const headline = page.headline || page.caption?.split('\n')[0]?.slice(0, 80) || business.name;
  const { title, highlight } = splitHeadline(headline);
  const media = heroMedia(page, now);
  // The two pinned tags sit over the picture, so they carry a short name: the first words of the product's, and its price.
  const tags = products.slice(0, 2).map((p) => ({ text: [shortName(p.name), cardPrice(p).now].filter(Boolean).join(' · ') }));
  const word = KIND_WORD[page.kind] ?? 'reel';

  const draw = {
    hero: () => html`${hero({ theme, eyebrow: `From the ${word}`, title, highlight, media: { ...media, imageUrl: sized(media.imageUrl, 'hero'), alt: headline, width: 290, height: 380 }, tags })}${page.description ? html`<p class="lede">${page.description}</p>` : ''}`,
    products: () => productsBlock({ theme, page, products, links: { utmEnabled, campaign }, whatsapp }),
    more_reels: () => (pageSettings.more_reels ? moreReelsBlock({ theme, more }) : ''),
    lead_form: () => extraBlocks.lead_form ?? '',
    whatsapp: () => '', // the chat button sits in the footer, below
  };
  const visible = blocks.filter((b) => b.visible !== false);
  const main = html`${blockStyles()}${visible.map((b) => (Object.hasOwn(draw, b.block) ? draw[b.block]() : renderSharedBlock(b, { theme, whatsappNumber: number ?? '', trustItems, now })))}`;
  const chat = number && visible.some((b) => b.block === 'whatsapp') ? `https://wa.me/${number}` : '';

  const description = page.description || `${products.length} ${products.length === 1 ? 'product' : 'products'} from ${business.name}`;
  return buyerPage({
    theme,
    business,
    meta: {
      title: `${headline} · ${business.name}`,
      ogTitle: headline,
      description,
      url: pageUrl,
      image: preview ? { url: preview.url, width: preview.width, height: preview.height, alt: headline } : null,
      indexable: !pageSettings.landing_noindex,
    },
    main,
    footer: { whatsappHref: chat },
  });
}
