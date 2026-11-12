/**
 * What the browsing screens read from the store, made safe to draw. The server's answers are the truth: a price is whole
 * paise it worked out, stock is its word, and what a seller wrote is text and addresses, never markup. Nothing here
 * works out a price, and nothing is added that the server did not send.
 *
 *   const browse = createBrowse(client);
 *   const home = await browse.home();                          // { blocks, categories, reels, products }
 *   const page = await browse.catalog({ q: 'pot', sort: 'newest', cursor });   // { items, nextCursor }
 *   const product = await browse.product('blue-pot');          // StoreError not_found when it is gone
 *
 *   formatPaise(129900)  // '₹1,299'      formatPaise(129950) // '₹1,299.50'
 *   safeUrl(origin, value)  // an https address, or the store's own path made absolute, or ''
 *   plainText('<b>Hi</b>')  // 'Hi'
 *   pinnedFirst(reels)      // pinned reels first, every group in the seller's order
 */

/** Whole paise as rupees with Indian digit grouping. Anything that is not whole paise is not shown as a price. */
export function formatPaise(paise, { symbol = '₹' } = {}) {
  if (!Number.isSafeInteger(paise)) return '';
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const rupees = String(Math.trunc(abs / 100));
  const rest = rupees.length > 3 ? `${rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${rupees.slice(-3)}` : rupees;
  const paisa = abs % 100;
  return `${sign}${symbol}${rest}${paisa ? `.${String(paisa).padStart(2, '0')}` : ''}`;
}

/** The share taken off, as a whole percent, for display only. null when there is no real discount. */
export function percentOff(pricePaise, comparePaise) {
  if (!Number.isSafeInteger(pricePaise) || !Number.isSafeInteger(comparePaise) || comparePaise <= pricePaise || pricePaise < 0) return null;
  const pct = Math.floor(((comparePaise - pricePaise) * 100) / comparePaise);
  return pct >= 1 ? pct : null;
}

/**
 * An address an image or video may be loaded from: https (http only when the store itself is http, as in tests), or a
 * path on the store's own address. javascript:, data:, file: and anything else give ''.
 */
export function safeUrl(origin, value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || /[\s<>"'`\\]/.test(text)) return '';
  if (text.startsWith('/') && !text.startsWith('//')) return `${String(origin ?? '').replace(/\/+$/, '')}${text}`;
  const match = /^(https?):\/\/([^/?#]+)/i.exec(text);
  if (!match) return '';
  if (match[1].toLowerCase() === 'http' && !/^http:/i.test(String(origin ?? ''))) return '';
  return text;
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };

/** Text a seller wrote, as plain text: tags and scripts are taken out, not run, and common entities read. */
export function plainText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (whole) => ENTITIES[whole] ?? whole)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const whole = (value) => (Number.isSafeInteger(value) ? value : null);

/** Pinned first, each group in the order the seller set (stable). */
export function pinnedFirst(reels) {
  const list = Array.isArray(reels) ? reels : [];
  return [...list.filter((reel) => reel.pinned), ...list.filter((reel) => !reel.pinned)];
}

export function cardOf(origin, raw) {
  const price = whole(raw?.pricePaise);
  return {
    id: raw?.id ?? null,
    slug: String(raw?.slug ?? ''),
    name: plainText(raw?.name),
    pricePaise: price,
    comparePaise: whole(raw?.comparePaise) !== null && price !== null && raw.comparePaise > price ? raw.comparePaise : null,
    image: safeUrl(origin, raw?.image),
    inStock: raw?.inStock === true,
    rating: typeof raw?.rating === 'number' ? raw.rating : null,
    ratingCount: whole(raw?.ratingCount) ?? 0,
  };
}

export function reelOf(origin, raw) {
  return {
    slug: String(raw?.slug ?? ''),
    title: plainText(raw?.title),
    image: safeUrl(origin, raw?.image),
    videoUrl: safeUrl(origin, raw?.videoUrl),
    pinned: raw?.pinned === true,
    productCount: whole(raw?.productCount) ?? 0,
  };
}

export const categoryOf = (origin, raw) => ({ slug: String(raw?.slug ?? ''), name: plainText(raw?.name), image: safeUrl(origin, raw?.image) });

const list = (value) => (Array.isArray(value) ? value : []);
const usable = (entry) => entry.slug !== '';
const pageOf = (raw, map) => ({ items: list(raw?.items).map(map).filter(usable), nextCursor: typeof raw?.nextCursor === 'string' && raw.nextCursor ? raw.nextCursor : null });

/** Block settings are the seller's own words and addresses; only strings and the lists of strings the blocks use survive. */
function settingsOf(origin, raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const items = list(s.items).map((item) => (typeof item === 'string'
    ? { text: plainText(item) }
    : { title: plainText(item?.title ?? item?.q ?? item?.name), text: plainText(item?.text ?? item?.a ?? item?.body ?? item?.quote) })).filter((item) => item.text || item.title);
  return { text: plainText(s.text), imageUrl: safeUrl(origin, s.imageUrl), linkUrl: typeof s.linkUrl === 'string' ? s.linkUrl.trim() : '', endsAt: typeof s.endsAt === 'string' ? s.endsAt : '', url: safeUrl(origin, s.url), items };
}

export function createBrowse(client) {
  const { origin } = client;
  const call = (id, options) => client.call(id, options);
  return Object.freeze({
    origin,
    bootstrap: () => call('appBootstrap'),
    async home() {
      const raw = (await call('appHome')) ?? {};
      return {
        blocks: list(raw.blocks).filter((block) => typeof block?.type === 'string').map((block) => ({ type: block.type, settings: settingsOf(origin, block.settings) })),
        categories: list(raw.categories).map((c) => categoryOf(origin, c)).filter(usable),
        reels: pinnedFirst(list(raw.reels).map((r) => reelOf(origin, r)).filter(usable)),
        products: list(raw.products).map((p) => cardOf(origin, p)).filter(usable),
      };
    },
    async catalog({ q, category, sort, cursor, limit } = {}) {
      return pageOf(await call('appCatalog', { query: { q: q?.trim() || undefined, category, sort, cursor, limit } }), (p) => cardOf(origin, p));
    },
    async categories() {
      return list((await call('appCategories'))?.items).map((c) => categoryOf(origin, c)).filter(usable);
    },
    async category(slug, { cursor, limit } = {}) {
      const raw = (await call('appCategory', { params: { slug }, query: { cursor, limit } })) ?? {};
      return { category: categoryOf(origin, raw.category), reels: pinnedFirst(list(raw.reels).map((r) => reelOf(origin, r)).filter(usable)), products: pageOf(raw.products, (p) => cardOf(origin, p)) };
    },
    async reels({ category, cursor, limit } = {}) {
      const raw = (await call('appReels', { query: { category, cursor, limit } })) ?? {};
      return { chips: list(raw.chips).map((c) => categoryOf(origin, c)).filter(usable), ...pageOf(raw, (r) => reelOf(origin, r)) };
    },
    async landing(slug) {
      const raw = (await call('appLanding', { params: { slug } })) ?? {};
      const media = raw.media ?? {};
      return {
        slug: String(raw.slug ?? slug),
        title: plainText(raw.title),
        media: { kind: media.kind === 'video' ? 'video' : 'image', url: safeUrl(origin, media.url), poster: safeUrl(origin, media.poster) },
        products: list(raw.products).map((p) => cardOf(origin, p)).filter(usable),
        moreReels: pinnedFirst(list(raw.moreReels).map((r) => reelOf(origin, r)).filter(usable)),
      };
    },
    async product(slug) {
      const raw = await call('appProduct', { params: { slug } });
      if (!raw || typeof raw !== 'object') return null;
      return {
        ...cardOf(origin, raw),
        description: plainText(raw.description),
        images: list(raw.images).map((u) => safeUrl(origin, u)).filter(Boolean),
        options: list(raw.options).map((o) => ({ name: plainText(o?.name), values: list(o?.values).map(plainText).filter(Boolean) })).filter((o) => o.name && o.values.length),
        variants: list(raw.variants).map((v) => ({ id: v?.id ?? null, option: plainText(v?.option), pricePaise: whole(v?.pricePaise), inStock: v?.inStock === true, image: safeUrl(origin, v?.image) })),
        maxQty: Math.max(1, whole(raw.maxQty) ?? 1),
        reels: pinnedFirst(list(raw.reels).map((r) => reelOf(origin, r)).filter(usable)),
      };
    },
    async policy(kind) {
      const raw = await call('appPolicy', { params: { kind } });
      return { kind, title: plainText(raw?.title), body: plainText(raw?.body), updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null };
    },
  });
}
