import crypto from 'node:crypto';
import { INDIAN_STATES, orderTotal, taxInside } from '../../contracts/orders.js';

/**
 * The demo business's sample, as plain data (PRD 10.6, P-24). buildSample() is a pure function of the day it is built
 * for and a secret, so building it twice for the same day gives the same rows, and fill.js writes exactly what it says.
 *
 * Every person in it is invented and can't be reached:
 *   - phone numbers start 555, which no Indian mobile number does (they start 6 to 9);
 *   - nobody has an email address, so nothing can be mailed;
 *   - Instagram ids begin "sample-", which no Instagram id does, and usernames hold a hyphen, which Instagram doesn't allow;
 *   - addresses are in made-up streets.
 * The shapes are the ones the real flows write: checkout orders with lines, GST and a delivery address, moved through
 * the order state machine; automations with their triggers and message versions; inbox threads as webhook intake
 * stores them; and the insights cache as the poller fills it, with Meta's metric names.
 *
 * Bump SAMPLE_VERSION whenever the sample changes: the worker then rebuilds the demo business when nobody is using it.
 */
export const SAMPLE_VERSION = 1;

/** The business itself. Its name is the seller's brand, the only one a buyer page or DM of it could carry. */
export const DEMO_BUSINESS = Object.freeze({
  slug: 'demo-boutique',
  name: 'Demo Boutique',
  legalName: 'Demo Boutique (sample business)',
  plan: 't5',
  timezone: 'Asia/Kolkata',
  firstOrderNumber: 1001,
});

/** The made-up Instagram account. "sample-" ids are the only ones migration 540 lets a demo business hold. */
export const SAMPLE_ACCOUNT = Object.freeze({ igUserId: 'sample-ig-demo-boutique', username: 'demo-boutique' });
export const SAMPLE_ID_PREFIX = 'sample-';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const IST_OFFSET_MIN = 330;

/** A small seeded generator, so the "random" figures are the same every time. */
function generator(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const isDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
/** The UTC day of a moment, as Meta labels days and as the insights screens count them. */
export const dayOfMs = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (day, n) => dayOfMs(Date.parse(`${day}T00:00:00Z`) + n * DAY);

const PRODUCTS = Object.freeze([
  { key: 'kurta', name: 'Indigo block-print kurta', price: 129900, mrp: 159900, stock: 24, gst: 500, hsn: '6204', tags: ['kurta', 'indigo', 'cotton'], featured: true,
    description: 'Hand block-printed cotton kurta in indigo, with a straight cut and side pockets.' },
  { key: 'dupatta', name: 'Haldi yellow cotton dupatta', price: 54900, mrp: null, stock: 40, gst: 500, hsn: '6214', tags: ['dupatta', 'cotton'], featured: true,
    description: 'Light mul cotton dupatta in a warm haldi yellow, with tasselled ends.' },
  { key: 'tote', name: 'Handloom tote bag', price: 69900, mrp: null, stock: 15, gst: 1200, hsn: '4202', tags: ['bag', 'handloom'], featured: false,
    description: 'Sturdy handloom cotton tote with an inner pocket.' },
  { key: 'earrings', name: 'Terracotta jhumka earrings', price: 34900, mrp: 44900, stock: 60, gst: 300, hsn: '7117', tags: ['jewellery', 'terracotta'], featured: false,
    description: 'Hand-painted terracotta jhumkas on hypoallergenic hooks.' },
  { key: 'coord', name: 'Linen co-ord set', price: 249900, mrp: null, stock: 8, gst: 1200, hsn: '6204', tags: ['co-ord', 'linen'], featured: true,
    description: 'Relaxed linen shirt and trousers in a soft sage green.' },
  { key: 'diya', name: 'Brass diya pair', price: 89900, mrp: null, stock: 12, gst: 1200, hsn: '7418', tags: ['home', 'festive'], featured: false,
    description: 'A pair of polished brass diyas for the festive season.' },
  { key: 'coasters', name: 'Hand-painted coaster set', price: 44900, mrp: null, stock: 30, gst: 1200, hsn: '4419', tags: ['home'], featured: false,
    description: 'Four mango-wood coasters with hand-painted motifs.' },
  { key: 'saree', name: 'Mul cotton saree', price: 319900, mrp: 399900, stock: 5, gst: 500, hsn: '5208', tags: ['saree', 'cotton'], featured: true,
    description: 'Soft mul cotton saree with a woven border, blouse piece included.' },
]);

const PAGES = Object.freeze([
  { mediaId: 'sample-media-reel-festive', slug: 'festive-edit', headline: 'The festive edit', kind: 'reel', mediaType: 'VIDEO', daysAgo: 9, hour: 19,
    caption: 'Our festive edit is here: indigo kurtas, haldi dupattas and brass diyas. Comment PRICE for details.', products: ['kurta', 'dupatta', 'diya'], keywords: ['PRICE', 'LINK'] },
  { mediaId: 'sample-media-reel-linen', slug: 'linen-days', headline: 'Linen days', kind: 'reel', mediaType: 'VIDEO', daysAgo: 4, hour: 18,
    caption: 'Linen co-ords for warm afternoons. Comment LINK and we will send it to you.', products: ['coord', 'tote'], keywords: ['LINK'] },
  { mediaId: 'sample-media-post-saree', slug: 'mul-saree', headline: 'Mul cotton sarees', kind: 'post', mediaType: 'IMAGE', daysAgo: 13, hour: 12,
    caption: 'Five new mul cotton sarees, woven borders and all.', products: ['saree', 'earrings'], keywords: [] },
]);

/** An invented shopper per order. 555 numbers and made-up streets: nobody real is behind any of them. */
const SHOPPERS = Object.freeze([
  { name: 'Asha Verma', line1: '12 Sample Lane, Demo Nagar', city: 'Pune', stateCode: '27', pincode: '411001' },
  { name: 'Rohan Iyer', line1: '4 Example Street, Test Layout', city: 'Bengaluru', stateCode: '29', pincode: '560001' },
  { name: 'Meera Pillai', line1: '9 Placeholder Road', city: 'Chennai', stateCode: '33', pincode: '600001' },
  { name: 'Kabir Shah', line1: '21 Fictional Marg', city: 'Ahmedabad', stateCode: '24', pincode: '380001' },
  { name: 'Ishita Roy', line1: '7 Imaginary Lane', city: 'Kolkata', stateCode: '19', pincode: '700001' },
  { name: 'Arjun Mehra', line1: '15 Make-Believe Avenue', city: 'New Delhi', stateCode: '07', pincode: '110001' },
  { name: 'Nisha Kulkarni', line1: '3 Pretend Colony', city: 'Mumbai', stateCode: '27', pincode: '400001' },
  { name: 'Dev Malhotra', line1: '18 Specimen Road', city: 'Jaipur', stateCode: '08', pincode: '302001' },
  { name: 'Tara Nair', line1: '6 Mock Street', city: 'Kochi', stateCode: '32', pincode: '682001' },
  { name: 'Vikram Rao', line1: '11 Dummy Cross', city: 'Hyderabad', stateCode: '36', pincode: '500001' },
]);

/**
 * The orders, oldest first, as the state machine moves them. `steps` are changeOrder() moves after placing; `paid` and
 * the rest are when the database's own timestamps should read.
 */
const ORDERS = Object.freeze([
  { mode: 'prepaid', daysAgo: 12, hour: 11, lines: [['kurta', 1], ['dupatta', 1]], page: 'festive-edit',
    steps: [{ payment: 'paid', fulfilment: 'new' }, { fulfilment: 'packed', hours: 20 }, { fulfilment: 'shipped', hours: 30 }, { fulfilment: 'delivered', hours: 96 }] },
  { mode: 'cod', daysAgo: 11, hour: 16, lines: [['earrings', 2]], page: 'mul-saree',
    steps: [{ payment: 'cod_due', fulfilment: 'new' }, { fulfilment: 'shipped', hours: 26 }, { fulfilment: 'delivered', hours: 98 }, { payment: 'paid', hours: 98 }] },
  { mode: 'prepaid', daysAgo: 10, hour: 21, lines: [['saree', 1]], page: 'mul-saree',
    steps: [{ fulfilment: 'cancelled', cancelReason: 'shopper', hours: 2 }] },
  { mode: 'prepaid', daysAgo: 6, hour: 10, lines: [['coord', 1]], page: 'linen-days',
    steps: [{ payment: 'paid', fulfilment: 'new' }, { fulfilment: 'packed', hours: 18 }, { fulfilment: 'shipped', hours: 28 }] },
  { mode: 'cod', daysAgo: 5, hour: 13, lines: [['tote', 1], ['coasters', 1]], page: 'linen-days',
    steps: [{ payment: 'cod_due', fulfilment: 'new' }, { fulfilment: 'shipped', hours: 30 }, { fulfilment: 'out_for_delivery', hours: 100 }] },
  { mode: 'prepaid', daysAgo: 3, hour: 20, lines: [['diya', 2]], page: 'festive-edit',
    steps: [{ payment: 'paid', fulfilment: 'new' }, { fulfilment: 'packed', hours: 15 }] },
  { mode: 'prepaid', daysAgo: 2, hour: 12, lines: [['kurta', 2]], page: 'festive-edit',
    steps: [{ payment: 'paid', fulfilment: 'new' }] },
  { mode: 'cod', daysAgo: 1, hour: 9, lines: [['dupatta', 1], ['earrings', 1]], page: 'festive-edit',
    steps: [{ payment: 'cod_due', fulfilment: 'new' }] },
  { mode: 'part_advance', daysAgo: 1, hour: 15, lines: [['saree', 1]], page: 'mul-saree',
    steps: [{ payment: 'advance_paid', fulfilment: 'new' }] },
  { mode: 'prepaid', daysAgo: 1, hour: 22, lines: [['coasters', 2]], page: null, steps: [] },
]);

const FREE_SHIPPING_FROM = 99900;
const SHIPPING_PAISE = 4900;
const COD_FEE_PAISE = 3900;

/** The automations, with the messages they send. No link is set, so no link check ever fetches anything for them. */
const AUTOMATIONS = Object.freeze([
  { slug: 'festive-reel-price', name: 'Price on the festive reel', state: 'live', triggerType: 'comment', matchMode: 'keywords', keywords: ['PRICE', 'LINK', 'DETAILS'],
    publicReply: true, daysAgo: 9, triggers: [{ targetType: 'reel', mediaId: 'sample-media-reel-festive' }],
    variants: [
      { label: 'A', body: 'Hi! Thanks for asking about our festive edit. Tap below and we will send you the link with sizes and prices.', button: 'Send me the link' },
      { label: 'B', body: 'Hello from Demo Boutique! Want the details of what you saw in the reel? Tap below.', button: 'Yes, send it' },
    ],
    linkMessage: 'Here you go: everything from the festive edit, with sizes and prices.' },
  { slug: 'linen-reel-link', name: 'Link on the linen reel', state: 'live', triggerType: 'comment', matchMode: 'keywords', keywords: ['LINK'],
    publicReply: false, daysAgo: 4, triggers: [{ targetType: 'reel', mediaId: 'sample-media-reel-linen' }],
    variants: [{ label: 'A', body: 'Hi! The linen co-ord is a favourite. Tap below for the link.', button: 'Send me the link' }],
    linkMessage: 'Here is the linen co-ord set. It runs true to size.' },
  { slug: 'story-replies', name: 'Story replies', state: 'live', triggerType: 'story_reply', matchMode: 'any', keywords: [],
    publicReply: false, daysAgo: 20, triggers: [{ targetType: 'any_story', mediaId: '' }],
    variants: [{ label: 'A', body: 'Thanks for replying to our story! Want the link to what you saw?', button: 'Send me the link' }],
    linkMessage: 'Here is everything from today’s story.' },
  { slug: 'size-guide', name: 'Size guide on DM', state: 'paused', triggerType: 'dm_keyword', matchMode: 'keywords', keywords: ['SIZE'],
    publicReply: false, daysAgo: 25, triggers: [{ targetType: 'dm', mediaId: '' }],
    variants: [{ label: 'A', body: 'Our kurtas run true to size. Tell us your usual size and we will help you pick.', button: 'See the size guide' }],
    linkMessage: '' },
]);

/** Inbox conversations, as webhook intake stores them: the person's words in, the automation's and the owner's out. */
const THREADS = Object.freeze([
  { person: 'sample-igsid-anya', username: 'sample-anya', status: 'open', messages: [
    { d: 2, h: 18, m: 4, dir: 'in', author: 'person', kind: 'story_reply', text: 'Love this dupatta!' },
    { d: 2, h: 18, m: 5, dir: 'out', author: 'automation', text: 'Thanks for replying to our story! Want the link to what you saw?' },
    { d: 2, h: 18, m: 7, dir: 'in', author: 'person', kind: 'postback', text: 'Send me the link' },
    { d: 2, h: 18, m: 7, dir: 'out', author: 'automation', text: 'Here is everything from today’s story.' },
  ] },
  { person: 'sample-igsid-rohan', username: 'sample-rohan', status: 'open', ownerReplied: true, messages: [
    { d: 1, h: 11, m: 20, dir: 'in', author: 'person', text: 'Do you ship to Bengaluru?' },
    { d: 1, h: 11, m: 42, dir: 'out', author: 'owner', text: 'Yes, we do! Orders reach Bengaluru in 3 to 5 days.' },
    { d: 1, h: 11, m: 45, dir: 'in', author: 'person', text: 'Great, thank you' },
  ] },
  { person: 'sample-igsid-meera', username: 'sample-meera', status: 'needs_human', handoff: true, messages: [
    { d: 1, h: 20, m: 2, dir: 'in', author: 'person', text: 'My order has not arrived yet, can someone help?' },
  ] },
  { person: 'sample-igsid-kabir', username: 'sample-kabir', status: 'open', messages: [
    { d: 4, h: 19, m: 30, dir: 'out', author: 'automation', text: 'Hi! The linen co-ord is a favourite. Tap below for the link.' },
    { d: 4, h: 19, m: 31, dir: 'in', author: 'person', kind: 'postback', text: 'Send me the link' },
    { d: 4, h: 19, m: 31, dir: 'out', author: 'automation', text: 'Here is the linen co-ord set. It runs true to size.' },
    { d: 3, h: 9, m: 15, dir: 'in', author: 'person', text: 'Is the sage green in stock in M?' },
  ] },
]);

const AGE_GROUPS = ['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+'];
const AGE_SHARE = [2, 21, 39, 22, 10, 4, 2];
const CITIES = [['Pune, Maharashtra', 18], ['Mumbai, Maharashtra', 16], ['Bengaluru, Karnataka', 14], ['New Delhi, Delhi', 11], ['Hyderabad, Telangana', 8], ['Chennai, Tamil Nadu', 7], ['Ahmedabad, Gujarat', 6], ['Kolkata, West Bengal', 5]];
const COUNTRIES = [['IN', 91], ['AE', 3], ['US', 2], ['GB', 2], ['SG', 1]];

/** A token nobody can guess, the same for the same order every time this server builds the sample. */
function tokenFor(secret, what) {
  return crypto.createHmac('sha256', String(secret || 'demo-sample')).update(`demo-sample:${what}`).digest('base64url').slice(0, 22);
}

/**
 * The sample for `anchorDay` ('YYYY-MM-DD', the day it is built, in UTC). Every moment in it is before the start of that
 * day, so nothing is in the future whatever the time of the fill. `secret` keys the order tokens.
 */
export function buildSample({ anchorDay, secret = '' }) {
  if (!isDay(anchorDay)) throw new Error('anchorDay must be a YYYY-MM-DD day');
  const anchorMs = Date.parse(`${anchorDay}T00:00:00Z`);
  /** `daysAgo` days before the anchor day, at hour:minute in India. */
  const at = (daysAgo, hour = 12, minute = 0) => new Date(anchorMs - daysAgo * DAY + (hour * 60 + minute - IST_OFFSET_MIN) * MINUTE).toISOString();
  const random = generator(0x5eed + SAMPLE_VERSION);
  const productOf = new Map(PRODUCTS.map((p) => [p.key, p]));

  const products = PRODUCTS.map((p, i) => ({
    key: p.key, name: p.name, slug: p.key === 'coord' ? 'linen-co-ord-set' : p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    description: p.description, pricePaise: p.price, mrpPaise: p.mrp, stock: p.stock, featured: p.featured, tags: p.tags, hsnCode: p.hsn, gstRateBp: p.gst,
    createdAt: at(40 - i, 10),
  }));

  const pages = PAGES.map((p) => ({
    mediaId: p.mediaId, slug: p.slug, headline: p.headline, kind: p.kind, mediaType: p.mediaType, caption: p.caption, keywords: p.keywords,
    productKeys: p.products, postedAt: at(p.daysAgo, p.hour), createdAt: at(p.daysAgo, p.hour, 30),
  }));

  const orders = ORDERS.map((o, i) => {
    const shopper = SHOPPERS[i % SHOPPERS.length];
    const number = DEMO_BUSINESS.firstOrderNumber + i;
    const lines = o.lines.map(([key, qty]) => {
      const p = productOf.get(key);
      const gross = p.price * qty;
      return { productKey: key, name: p.name, pricePaise: p.price, qty, hsnCode: p.hsn, gstRateBp: p.gst, taxPaise: taxInside(gross, p.gst).taxPaise, weightGrams: 400 * qty };
    });
    const subtotalPaise = lines.reduce((sum, l) => sum + l.pricePaise * l.qty, 0);
    const shippingPaise = subtotalPaise >= FREE_SHIPPING_FROM ? 0 : SHIPPING_PAISE;
    const codFeePaise = o.mode === 'cod' ? COD_FEE_PAISE : 0;
    const totalPaise = orderTotal({ subtotalPaise, shippingPaise, codFeePaise });
    const advancePaise = o.mode === 'part_advance' ? Math.round(totalPaise / 5) : 0;
    const balancePaise = o.mode === 'cod' ? totalPaise : o.mode === 'part_advance' ? totalPaise - advancePaise : 0;
    const placedAt = at(o.daysAgo, o.hour, 10 + i);
    const phone = `555${String(1000001 + i).padStart(7, '0')}`;
    let clock = Date.parse(placedAt) + 2 * MINUTE;
    const steps = o.steps.map((s) => {
      if (s.hours) clock = Date.parse(placedAt) + s.hours * HOUR;
      const step = { at: new Date(clock).toISOString() };
      if (s.payment) step.payment = s.payment;
      if (s.fulfilment) step.fulfilment = s.fulfilment;
      if (s.cancelReason) step.cancelReason = s.cancelReason;
      clock += MINUTE;
      return step;
    });
    const paidPaise = steps.some((s) => s.payment === 'paid') ? totalPaise : steps.some((s) => s.payment === 'advance_paid') ? advancePaise : 0;
    return {
      number, orderNumber: `DB-${number}`, token: tokenFor(secret, `order:${number}`), idempotencyKey: `demo-sample-order-${number}`,
      mode: o.mode, pageSlug: o.page, placedAt, customer: { ...shopper, phone, stateName: INDIAN_STATES[shopper.stateCode] ?? '' },
      lines, subtotalPaise, shippingPaise, codFeePaise, taxPaise: lines.reduce((sum, l) => sum + l.taxPaise, 0), totalPaise, advancePaise, balancePaise, paidPaise, steps,
    };
  });

  const automations = AUTOMATIONS.map((a) => ({ ...a, createdAt: at(a.daysAgo, 10), updatedAt: at(Math.max(1, a.daysAgo - 1), 10) }));

  const threads = THREADS.map((t) => ({
    ...t,
    messages: t.messages.map((m, i) => ({ ...m, kind: m.kind ?? 'text', at: at(m.d, m.h, m.m), mid: `sample-mid-${t.person.slice(13)}-${i + 1}` })),
  }));

  // ---- insights: 60 days of account figures, the audience, best times and the posts -----------------------------------
  const daily = [];
  const days = 60;
  let followers = 1720;
  for (let d = days; d >= 1; d--) {
    const day = addDays(anchorDay, -d);
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    const lift = (weekday === 0 || weekday === 6 ? 1.25 : 1) * (1 + (days - d) / 180);
    const reach = Math.round((900 + random() * 500) * lift);
    const views = Math.round(reach * (2.4 + random() * 0.8));
    const likes = Math.round(reach * (0.06 + random() * 0.03));
    const comments = Math.round(likes * (0.12 + random() * 0.08));
    const shares = Math.round(likes * (0.1 + random() * 0.06));
    const saves = Math.round(likes * (0.15 + random() * 0.08));
    const replies = Math.round(4 + random() * 10);
    const reposts = Math.round(random() * 4);
    const interactions = likes + comments + shares + saves + replies + reposts;
    const engaged = Math.round(interactions * (0.7 + random() * 0.2));
    const follows = Math.round(6 + random() * 9);
    const unfollows = Math.round(random() * 4);
    followers += follows - unfollows;
    const figures = { views, reach, accounts_engaged: engaged, total_interactions: interactions, likes, comments, shares, saves, replies, reposts };
    for (const [metric, value] of Object.entries(figures)) daily.push({ day, metric, breakdown: '', breakdownValue: '', value });
    const reelsShare = 0.55 + random() * 0.1;
    const storyShare = 0.15 + random() * 0.05;
    for (const metric of ['views', 'reach']) {
      const total = figures[metric];
      const reels = Math.round(total * reelsShare);
      const story = Math.round(total * storyShare);
      daily.push({ day, metric, breakdown: 'media_product_type', breakdownValue: 'REELS', value: reels });
      daily.push({ day, metric, breakdown: 'media_product_type', breakdownValue: 'STORY', value: story });
      daily.push({ day, metric, breakdown: 'media_product_type', breakdownValue: 'FEED', value: total - reels - story });
    }
    daily.push({ day, metric: 'follows_and_unfollows', breakdown: 'follow_type', breakdownValue: 'FOLLOWER', value: follows });
    daily.push({ day, metric: 'follows_and_unfollows', breakdown: 'follow_type', breakdownValue: 'NON_FOLLOWER', value: unfollows });
    daily.push({ day, metric: 'profile_links_taps', breakdown: 'contact_button_type', breakdownValue: 'TEXT', value: Math.round(3 + random() * 6) });
    daily.push({ day, metric: 'profile_links_taps', breakdown: 'contact_button_type', breakdownValue: 'DIRECTION', value: Math.round(random() * 3) });
    daily.push({ day, metric: 'followers_count', breakdown: '', breakdownValue: '', value: followers });
  }
  const fetchedAt = at(1, 23, 30);

  const share = (total, parts) => {
    const sum = parts.reduce((a, b) => a + b, 0);
    return parts.map((p) => Math.round((total * p) / sum));
  };
  const demographics = [];
  for (const [metric, total] of [['follower_demographics', followers], ['engaged_audience_demographics', Math.round(followers * 0.3)]]) {
    share(total, AGE_SHARE).forEach((value, i) => demographics.push({ metric, timeframe: 'this_month', breakdown: 'age', breakdownValue: AGE_GROUPS[i], value }));
    share(total, [71, 27, 2]).forEach((value, i) => demographics.push({ metric, timeframe: 'this_month', breakdown: 'gender', breakdownValue: ['F', 'M', 'U'][i], value }));
    share(total, CITIES.map((c) => c[1])).forEach((value, i) => demographics.push({ metric, timeframe: 'this_month', breakdown: 'city', breakdownValue: CITIES[i][0], value }));
    share(total, COUNTRIES.map((c) => c[1])).forEach((value, i) => demographics.push({ metric, timeframe: 'this_month', breakdown: 'country', breakdownValue: COUNTRIES[i][0], value }));
  }

  const online = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let hour = 0; hour < 24; hour++) {
      const evening = Math.exp(-((hour - 20) ** 2) / 8) * 1.0 + Math.exp(-((hour - 13) ** 2) / 6) * 0.5;
      online.push({ weekday, hour, value: Math.round(followers * (0.02 + 0.28 * evening) * (weekday === 0 || weekday === 6 ? 1.15 : 1)) });
    }
  }

  const mediaMetrics = (kind, base) => {
    const reach = Math.round(base * (0.9 + random() * 0.3));
    const metrics = {
      views: Math.round(reach * (kind === 'reel' ? 2.6 : 1.4)), reach,
      likes: Math.round(reach * 0.08), comments: Math.round(reach * 0.012), shares: Math.round(reach * 0.01), saved: Math.round(reach * 0.015),
      reposts: Math.round(reach * 0.002), follows: Math.round(reach * 0.004), profile_visits: Math.round(reach * 0.03),
    };
    metrics.total_interactions = metrics.likes + metrics.comments + metrics.shares + metrics.saved + metrics.reposts;
    if (kind === 'reel') Object.assign(metrics, { ig_reels_avg_watch_time: Math.round(6500 + random() * 4000), ig_reels_video_view_total_time: Math.round(metrics.views * 7200), reels_skip_rate: Math.round(25 + random() * 15) });
    return metrics;
  };
  const media = [
    ...pages.map((p, i) => ({ mediaId: p.mediaId, kind: p.kind === 'post' ? 'feed' : 'reel', caption: p.caption, postedAt: p.postedAt, metrics: mediaMetrics(p.kind === 'post' ? 'feed' : 'reel', [5200, 3900, 2100][i]) })),
    { mediaId: 'sample-media-reel-diya', kind: 'reel', caption: 'How we polish our brass diyas, start to finish.', postedAt: at(17, 19), metrics: mediaMetrics('reel', 4600) },
    { mediaId: 'sample-media-carousel-dupatta', kind: 'carousel', caption: 'Five ways to drape a haldi dupatta.', postedAt: at(21, 12), metrics: mediaMetrics('feed', 2800) },
    { mediaId: 'sample-media-post-studio', kind: 'feed', caption: 'A peek into our studio this week.', postedAt: at(27, 11), metrics: mediaMetrics('feed', 1700) },
  ].map((m) => ({ ...m, permalink: '', thumbnailUrl: '', latestAt: fetchedAt }));

  return {
    version: SAMPLE_VERSION,
    anchorDay,
    business: { ...DEMO_BUSINESS, createdAt: at(60, 9) },
    account: { ...SAMPLE_ACCOUNT, connectedAt: at(58, 10), lostAt: at(1, 23) },
    products,
    pages,
    orders,
    automations,
    threads,
    insights: {
      collectingSince: addDays(anchorDay, -days),
      followers,
      lastRefreshAt: fetchedAt,
      fetchedAt,
      daily,
      demographics,
      online,
      media,
    },
  };
}

/** sha256 of the sample: the same sample gives the same digest. */
export const sampleDigest = (sample) => crypto.createHash('sha256').update(JSON.stringify(sample)).digest('hex');
