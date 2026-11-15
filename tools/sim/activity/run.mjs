/**
 * The activity generator's run() (Phase 8, Q-03). See index.mjs for what it promises. Everything here goes in through a door
 * a real event uses: a signed Meta webhook, a shopper's browser, the seller's console API, a courier's or the gateway's webhook.
 * No table is written. Time passes by world.travel(): each day is four slots; between slots everything stored becomes six
 * hours older, so the last slot is "now" and the first is thirty days back.
 *
 * What it asks of a business (what seedBusiness answers): key, slug, host, tenantId, igUserId, seed, catalogue, productIds
 * (Map name -> { id, pricePaise, plain, variants: [{ id, pricePaise }] }), reels ([{ mediaId, kind, slug, url }]), keywords (Map mediaId -> words that fire a
 * live automation), api (a seller session) and owner ({ password }).
 */
import { SHOWCASE, inventedPerson } from '../../../src/contracts/seed.js';
import { ACTIVITY_KINDS, ActivityError, digestOf, runOptions } from './index.mjs';

const DAY_MS = 86_400_000;
const SLOTS = 4;
const SLOT_MS = DAY_MS / SLOTS;
const SLOT_SHARE = [0.18, 0.3, 0.32, 0.2];
/** How many invented shoppers a business has: some come back, so a few customers have several orders. */
const SHOPPERS = 90;
const CHATTER = ['love this 😍', 'where is this from?', 'so nice!', '🔥🔥🔥', 'need this', 'amazing find', 'is this available?', 'how much for two?'];
const DM_TEXTS = ['hi', 'Hello, is this in stock?', 'Do you deliver to Pune?', 'Can I get a bulk price?', 'What is the return policy?', 'link please', 'thanks!'];
const STORY_TEXTS = ['❤️', 'need this!', 'is it available?', 'love the colour', 'price?'];
const WA_TEXTS = ['Where is my order?', 'Can I change my address?', 'Thank you!', 'When will it reach me?'];
const PLACES = [
  { city: 'Pune', stateCode: '27', pincode: '411001' }, { city: 'Mumbai', stateCode: '27', pincode: '400001' }, { city: 'Nagpur', stateCode: '27', pincode: '440001' },
  { city: 'Bengaluru', stateCode: '29', pincode: '560001' }, { city: 'Ahmedabad', stateCode: '24', pincode: '380001' }, { city: 'Hyderabad', stateCode: '36', pincode: '500001' },
  { city: 'Jaipur', stateCode: '08', pincode: '302001' }, { city: 'Indore', stateCode: '23', pincode: '452001' },
];
const STREETS = ['Lake Road', 'Station Road', 'Garden Lane', 'Temple Street', 'Market Road', 'Hill View Road'];
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/** Mean events per day for volume 1, before the growth over the month and the weekday. */
const RATES = { comment: 4, dm: 1.6, story_reply: 0.9, mention: 0.4, visit: 5, cart: 0.8, order: 1.3 };

/** A whole number near `mean`, chosen by the generator (random rounding), so the same seed gives the same count. */
const around = (rng, mean) => Math.floor(mean + rng.next());

/** Busier later in the month and on some weekdays, quieter at the start: a business that is growing. */
const growth = (day, days) => (0.55 + 0.9 * (days > 1 ? day / (days - 1) : 1)) * [0.9, 1, 1, 1.05, 1.15, 1.3, 1.1][day % 7];

class Session {
  constructor(world, host, { ua, ip }) {
    this.world = world;
    this.host = host;
    this.ua = ua;
    this.ip = ip;
    this.jar = {};
    this.csrf = '';
    this.tab = `t${Math.abs(hash(ip + host)) % 1e9}`;
  }

  cookie() {
    return Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(res) {
    for (const line of [res.headers['set-cookie'] ?? []].flat()) {
      const [pair] = line.split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      if (value === '' || /max-age=0/i.test(line)) delete this.jar[name];
      else this.jar[name] = value;
    }
    return res;
  }

  async send(method, path, { body, headers = {} } = {}) {
    const res = await this.world.hit(path, {
      host: this.host,
      method,
      body,
      headers: { 'user-agent': this.ua, 'x-forwarded-for': this.ip, accept: method === 'GET' ? 'text/html' : 'application/json', origin: `https://${this.host}`, ...(this.csrf && method !== 'GET' ? { 'x-csrf-token': this.csrf } : {}), ...(this.cookie() ? { cookie: this.cookie() } : {}), ...headers },
    });
    this.absorb(res);
    if (res.data?.csrf) this.csrf = res.data.csrf;
    if (res.data?.csrfToken) this.csrf = res.data.csrfToken;
    return res;
  }

  page(path, referrer = '') {
    return this.send('GET', path, { headers: referrer ? { referer: referrer } : {} });
  }

  /** What the page's script reports from the browser. */
  beacon(body) {
    return this.send('POST', `/_t/e?v=${this.tab}`, { body: { path: '/', pageKind: 'other', pageRef: '', referrer: '', src: '', utm: { source: '', medium: '', campaign: '', content: '' }, ...body } });
  }
}

function hash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return h;
}

/** Fails with what was being done and what answered, never with a name, phone or message. */
function must(res, what, ok = [200, 201, 202, 204]) {
  if (!ok.includes(res.status)) throw new ActivityError(`${what} answered ${res.status}: ${String(res.data?.error ?? res.text).replace(/\s+/g, ' ').slice(0, 160)}`);
  return res;
}

export async function run(options) {
  const { businesses, days, seed, clock, world, rng } = runOptions(options);
  if (typeof world?.hit !== 'function' || !world?.sims?.meta || typeof world?.settle !== 'function' || typeof world?.travel !== 'function') {
    throw new ActivityError('Give the world the activity runs in (openShowcaseWorld): the app, its worker and the simulators.');
  }
  for (const b of businesses) {
    for (const need of ['host', 'api', 'productIds', 'reels', 'keywords', 'igUserId', 'tenantId']) if (b[need] === undefined) throw new ActivityError(`The business "${b.key}" is not loaded: ${need} is missing. Load it with seedBusiness first.`);
  }
  const log = options.log ?? (() => {});
  const volume = options.volume ?? 1;
  const meta = world.sims.meta;
  const startAt = clock.now().getTime();
  const events = [];
  const counts = Object.fromEntries(businesses.map((b) => [b.key, Object.fromEntries(ACTIVITY_KINDS.map((k) => [k, 0]))]));
  const state = new Map(businesses.map((b, index) => [b.key, { index, orders: [], sentSeen: 0, taps: new Set(), lastOrderShopper: -1, who: new Map(), ordinal: 0 }]));
  const note = (day, b, kind, subject) => {
    events.push([day, b.key, kind, subject]);
    counts[b.key][kind] += 1;
  };

  const shopperOf = (b, rngS) => {
    const st = state.get(b.key);
    const k = Math.min(rngS.int(0, SHOPPERS - 1), rngS.int(0, SHOPPERS - 1));
    const n = st.index * SHOPPERS + k;
    const person = inventedPerson(n);
    st.who.set(person.igUserId, { n, person });
    return { n, person };
  };
  /** Instagram knows who a shopper is: the simulator is told their invented name and handle, as Instagram's profile lookup would answer. */
  const introduced = new Set();
  async function known(b, person) {
    const key = `${b.igUserId}:${person.igUserId}`;
    if (introduced.has(key)) return;
    introduced.add(key);
    await meta.post('/people', { igUserId: b.igUserId, id: person.igUserId, name: person.name, username: person.igUsername });
  }
  const from = (person) => ({ id: person.igUserId, username: person.igUsername });
  const ipOf = (n) => `203.0.113.${(n % 250) + 1}`;
  const uaOf = (n) => (n % 3 === 0 ? IOS_UA : PHONE_UA);

  // ---- Instagram: comments, DMs, story replies, mentions ----
  async function inbound(b, rngS, day, mean) {
    const st = state.get(b.key);
    const live = b.reels.filter((r) => (b.keywords.get(r.mediaId) ?? []).length && r.kind !== 'story');
    const stories = b.reels.filter((r) => r.kind === 'story');
    for (let i = around(rngS, mean.comment); i > 0; i--) {
      const { n, person } = shopperOf(b, rngS);
      await known(b, person);
      const reel = live.length ? rngS.pick(live) : rngS.pick(b.reels);
      const words = b.keywords.get(reel.mediaId) ?? [];
      const text = words.length && rngS.chance(0.8) ? `${rngS.pick(words)}${rngS.pick(['', ' please', ' pls', '!', ' 🙏'])}` : rngS.pick(CHATTER);
      const out = await meta.post('/comments', { igUserId: b.igUserId, mediaId: reel.mediaId, from: from(person), text });
      if (!out.delivery?.delivered) throw new ActivityError(`A comment was not delivered to the app (${out.delivery?.reason ?? out.delivery?.status})`);
      note(day, b, 'comment', n);
    }
    for (let i = around(rngS, mean.dm); i > 0; i--) {
      const { n, person } = shopperOf(b, rngS);
      await known(b, person);
      const out = await meta.post('/messages', { igUserId: b.igUserId, from: from(person), text: rngS.pick(DM_TEXTS) });
      if (!out.delivery?.delivered) throw new ActivityError(`A DM was not delivered to the app (${out.delivery?.reason ?? out.delivery?.status})`);
      note(day, b, 'dm', n);
    }
    for (let i = around(rngS, mean.story_reply); i > 0; i--) {
      const { n, person } = shopperOf(b, rngS);
      await known(b, person);
      const story = stories.length ? rngS.pick(stories).mediaId : undefined;
      const out = await meta.post('/story-replies', { igUserId: b.igUserId, from: from(person), text: rngS.pick(STORY_TEXTS), ...(story ? { storyId: story } : {}) });
      if (!out.delivery?.delivered) throw new ActivityError(`A story reply was not delivered to the app (${out.delivery?.reason ?? out.delivery?.status})`);
      note(day, b, 'story_reply', n);
    }
    for (let i = around(rngS, mean.mention); i > 0; i--) {
      const { n, person } = shopperOf(b, rngS);
      await known(b, person);
      const out = await meta.post('/mentions', { igUserId: b.igUserId, from: from(person) });
      if (!out.delivery?.delivered) throw new ActivityError(`A mention was not delivered to the app (${out.delivery?.reason ?? out.delivery?.status})`);
      note(day, b, 'mention', n);
    }
    void st;
  }

  /** The shopper taps the button of a DM the business sent, and opens the link of the next one: both read from what the simulator received. */
  async function react(b, rngS, day) {
    const st = state.get(b.key);
    const { sent } = await meta.get('/sent', { igUserId: b.igUserId });
    const fresh = sent.slice(st.sentSeen);
    st.sentSeen = sent.length;
    for (const dm of fresh) {
      const who = st.who.get(dm.recipientId);
      if (!who) continue;
      const buttons = dm.message?.attachment?.payload?.buttons ?? [];
      const postback = buttons.find((x) => x.type === 'postback');
      const link = buttons.find((x) => x.type === 'web_url');
      if (postback && rngS.chance(0.7)) {
        const out = await meta.post('/postbacks', { igUserId: b.igUserId, from: from(who.person), payload: postback.payload, title: postback.title });
        if (!out.delivery?.delivered) throw new ActivityError('A button tap was not delivered to the app');
        note(day, b, 'dm', who.n);
      }
      if (link && rngS.chance(0.65)) {
        const target = new URL(link.url);
        if (target.host === b.host) await visit(b, rngS, day, { who, path: `${target.pathname}${target.search}`, referrer: 'https://l.instagram.com/' });
      }
    }
  }

  // ---- the shop: visits, carts, orders ----
  async function visit(b, rngS, day, { who, path, referrer = '' }) {
    const { n } = who ?? shopperOf(b, rngS);
    const browser = new Session(world, b.host, { ua: uaOf(n), ip: ipOf(n) });
    const landing = b.reels.find((r) => path.startsWith(`/r/${r.slug}`));
    must(await browser.page(path, referrer), 'A page visit');
    const utm = { source: referrer ? 'instagram' : '', medium: referrer ? 'dm' : '', campaign: '', content: landing?.mediaId ?? '' };
    await browser.beacon({ name: 'page_view', path, pageKind: landing ? 'landing' : 'store', pageRef: landing?.slug ?? '', referrer, utm, mediaId: landing?.mediaId ?? '' });
    if (landing) await browser.beacon({ name: 'landing_view', path, pageKind: 'landing', pageRef: landing.slug, referrer, utm, mediaId: landing.mediaId });
    note(day, b, 'visit', n);
    return browser;
  }

  const catalogue = (b) => [...b.productIds.entries()].filter(([, p]) => p.plain || p.variants.length).map(([name, p]) => ({ name, ...p }));

  function linesFor(b, rngS) {
    const pool = catalogue(b);
    if (!pool.length) throw new ActivityError(`The business "${b.key}" has no product a shopper can buy as it is`);
    const chosen = [];
    for (let i = rngS.chance(0.35) ? 2 : 1; i > 0; i--) {
      const product = rngS.pick(pool);
      if (chosen.some((c) => c.productId === product.id)) continue;
      const variant = product.variants?.length ? rngS.pick(product.variants) : null;
      chosen.push({ productId: product.id, ...(variant ? { variantId: variant.id } : {}), qty: rngS.chance(0.2) ? 2 : 1 });
    }
    return chosen;
  }

  async function cart(b, rngS, day) {
    const { n } = shopperOf(b, rngS);
    const browser = await visit(b, rngS, day, { who: { n }, path: '/' });
    const lines = linesFor(b, rngS);
    // A guest's bag lives in the browser; what the server sees is the price check the page asks for.
    must(await browser.send('POST', '/api/store/checkout/quote', { body: { lines } }), 'Pricing a bag');
    await browser.beacon({ name: 'add_to_cart', path: '/', pageKind: 'store', productId: lines[0].productId });
    note(day, b, 'cart', n);
  }

  async function codeFor(phone) {
    const digits = String(phone).replace(/\D/g, '');
    const { sent } = await world.sims.whatsapp.get('/sent');
    for (const m of [...sent].reverse().filter((x) => String(x.to).replace(/\D/g, '') === digits)) {
      const code = /(?<![0-9])[0-9]{6}(?![0-9])/.exec(JSON.stringify(m.body?.template ?? m.body?.text ?? {}))?.[0];
      if (code) return code;
    }
    throw new ActivityError('No sign-in code reached the shopper');
  }

  async function order(b, rngS, day) {
    const st = state.get(b.key);
    const { n, person } = shopperOf(b, rngS);
      await known(b, person);
    const browser = await visit(b, rngS, day, { who: { n }, path: rngS.chance(0.7) && b.reels.length ? `/r/${rngS.pick(b.reels).slug}` : '/' });
    const lines = linesFor(b, rngS);
    const place = rngS.pick(PLACES);
    const mode = rngS.chance(0.28) ? 'cod' : 'prepaid';
    const coupon = b.seed.coupons.length && rngS.chance(0.2) ? rngS.pick(b.seed.coupons).code : '';
    st.ordinal += 1;
    const body = {
      lines,
      paymentMode: mode,
      address: { name: person.name, phone: person.phone, line1: `${rngS.int(2, 98)} ${rngS.pick(STREETS)}`, line2: '', landmark: '', city: place.city, stateCode: place.stateCode, pincode: place.pincode },
      idempotencyKey: `sc-${b.slug}-${seed}-${day}-${st.ordinal}`.slice(0, 80),
      acceptTerms: true,
      consent: { noticeVersion: 1, orderUpdates: { whatsapp: true, email: false }, marketing: { whatsapp: rngS.chance(0.3), email: false } },
      ...(coupon ? { couponCode: coupon } : {}),
    };
    await browser.beacon({ name: 'checkout_started', path: '/checkout', pageKind: 'checkout' });
    let placed = await browser.send('POST', '/api/store/checkout', { body });
    if (placed.status >= 400 && placed.status < 500 && coupon) {
      // A coupon whose rules this basket does not meet is refused: the shopper tries again without it.
      body.couponCode = '';
      body.idempotencyKey = `${body.idempotencyKey}-b`.slice(0, 80);
      placed = await browser.send('POST', '/api/store/checkout', { body });
    }
    must(placed, 'Placing an order');
    if (placed.data.next === 'verify_phone') {
      must(await browser.send('POST', '/api/store/otp/send', { body: { phone: person.phone, purpose: 'cod', checkoutKey: body.idempotencyKey } }), 'Asking for a cash-on-delivery code');
      await world.until(async () => { try { await codeFor(person.phone); return true; } catch { return false; } }, 6000);
      must(await browser.send('POST', '/api/store/otp/verify', { body: { phone: person.phone, purpose: 'cod', code: await codeFor(person.phone), checkoutKey: body.idempotencyKey } }), 'Entering the cash-on-delivery code');
      placed = must(await browser.send('POST', '/api/store/checkout', { body }), 'Placing the order after the code');
    }
    note(day, b, 'checkout', n);
    const record = { orderNumber: placed.data.orderNumber, stage: 'placed', mode, n, token: placed.data.token };
    if (mode === 'prepaid') {
      const abandoned = rngS.chance(0.1);
      if (!abandoned) {
        const comesBack = rngS.chance(0.75);
        const paid = await world.sims.razorpay.post('/pay', { orderId: placed.data.gateway.gatewayOrderId, webhook: !comesBack || rngS.chance(0.3) });
        if (comesBack) {
          must(await browser.send('POST', '/api/store/payments/return', { body: { orderToken: placed.data.token, gatewayOrderId: placed.data.gateway.gatewayOrderId, gatewayPaymentId: paid.payment.id, signature: paid.signature } }), 'Coming back from the payment page');
        }
        note(day, b, 'payment', n);
        record.stage = 'paid';
      } else record.stage = 'abandoned';
    } else record.stage = 'paid';
    st.orders.push(record);
  }

  // ---- the seller's side: pack, ship, deliver, refund; the courier's tracking; the shopper's WhatsApp ----
  async function orderId(b, record) {
    if (!record.id) {
      const [row] = await world.sql('SELECT id FROM orders WHERE tenant_id = $1 AND order_number = $2', [b.tenantId, record.orderNumber]);
      record.id = row?.id ?? null;
    }
    return record.id;
  }

  async function fulfil(b, rngS, day) {
    for (const record of state.get(b.key).orders) {
      if (record.stage === 'abandoned' || record.stage === 'done') continue;
      const id = await orderId(b, record);
      if (!id) continue;
      const [now] = await world.sql('SELECT payment_status FROM orders WHERE tenant_id = $1 AND id = $2', [b.tenantId, id]);
      if (record.stage === 'paid' && !['paid', 'advance_paid', 'cod_due'].includes(now?.payment_status)) continue;
      if (record.stage === 'paid' && rngS.chance(0.7)) {
        must(await b.api.post(`/orders/${id}/advance`, { to: 'packed' }), 'Packing an order');
        record.stage = 'packed';
      } else if (record.stage === 'packed' && rngS.chance(0.65)) {
        const made = must(await b.api.post(`/orders/${id}/shipments`, { weightGrams: 500, lengthCm: 12, breadthCm: 10, heightCm: 8 }), 'Handing an order to the courier');
        record.awb = made.data.awb;
        record.stage = 'shipped';
        note(day, b, 'shipment', record.n);
        await world.sims.shiprocket.post('/track', { awb: record.awb, status: 'PICKED UP' });
      } else if (record.stage === 'shipped' && record.awb && rngS.chance(0.6)) {
        if (rngS.chance(0.06)) {
          await world.sims.shiprocket.post('/track', { awb: record.awb, status: 'RTO INITIATED' });
          note(day, b, 'return', record.n);
          record.stage = 'done';
        } else {
          await world.sims.shiprocket.post('/track', { awb: record.awb, status: 'IN TRANSIT' });
          await world.sims.shiprocket.post('/track', { awb: record.awb, status: 'OUT FOR DELIVERY' });
          await world.sims.shiprocket.post('/track', { awb: record.awb, status: 'DELIVERED' });
          note(day, b, 'delivery', record.n);
          record.stage = 'delivered';
        }
      } else if (record.stage === 'delivered' && rngS.chance(0.5)) {
        if (rngS.chance(0.14) && record.mode === 'prepaid') {
          const [row] = await world.sql('SELECT total_paise FROM orders WHERE tenant_id = $1 AND id = $2', [b.tenantId, id]);
          const amountPaise = Math.max(100, Math.floor(Number(row.total_paise) * rngS.pick([0.25, 0.5, 1])));
          const refund = await b.api.post(`/orders/${id}/refunds`, { amountPaise, reason: 'Item damaged on arrival', idempotencyKey: `sc-refund-${b.slug}-${id}`, password: b.owner.password }, { allow: [400, 409] });
          if (refund.status === 201) note(day, b, 'refund', record.n);
        }
        record.stage = 'done';
      }
    }
  }

  async function chat(b, rngS, day) {
    const st = state.get(b.key);
    const delivered = st.orders.filter((o) => o.stage === 'delivered' || o.stage === 'done');
    if (!delivered.length || !rngS.chance(0.35)) return;
    const record = rngS.pick(delivered);
    const person = inventedPerson(record.n);
    const [account] = await world.sql('SELECT phone_number_id FROM whatsapp_accounts WHERE tenant_id = $1', [b.tenantId]);
    if (!account) return;
    await world.sims.whatsapp.post('/inbound', { phoneId: account.phone_number_id, from: person.phone.replace(/\D/g, ''), text: rngS.pick(WA_TEXTS), name: person.name });
    note(day, b, 'whatsapp', record.n);
  }

  // ---- the days ----
  for (let day = 0; day < days; day++) {
    const factor = growth(day, days) * volume;
    for (let slot = 0; slot < SLOTS; slot++) {
      const share = SLOT_SHARE[slot] * factor;
      const mean = Object.fromEntries(Object.entries(RATES).map(([kind, rate]) => [kind, rate * share]));
      const rngs = new Map(businesses.map((b) => [b.key, rng.fork(`${b.key}:${day}:${slot}`)]));
      for (const b of businesses) await fulfil(b, rngs.get(b.key), day);
      for (const b of businesses) await inbound(b, rngs.get(b.key), day, mean);
      await world.settle();
      for (const b of businesses) await react(b, rngs.get(b.key), day);
      for (const b of businesses) {
        const r = rngs.get(b.key);
        for (let i = around(r, mean.visit); i > 0; i--) await visit(b, r, day, { path: r.chance(0.6) ? '/' : `/r/${r.pick(b.reels).slug}`, referrer: r.chance(0.5) ? 'https://l.instagram.com/' : '' });
        for (let i = around(r, mean.cart); i > 0; i--) await cart(b, r, day);
        for (let i = around(r, mean.order); i > 0; i--) await order(b, r, day);
      }
      await world.settle();
      for (const b of businesses) await chat(b, rngs.get(b.key), day);
      await world.settle();
      if (!(day === days - 1 && slot === SLOTS - 1)) {
        clock.advance(SLOT_MS);
        await world.travel(SLOT_MS);
      }
    }
    log(`day ${day + 1} of ${days}: ${events.length} events`);
  }

  await insights({ world, businesses, days, rng, note, log, startAt });
  await world.settle();
  return { days, seed, events: events.length, counts, digest: digestOf(events) };
}

/**
 * What Instagram says about each account over the month, read by the app's own refresh: the simulator is given a daily series
 * shaped by the activity (more comments, more reach) and the app's insights refresh pulls it. One per business per day.
 */
async function insights({ world, businesses, days, rng, note, log, startAt }) {
  const meta = world.sims.meta;
  for (const b of businesses) {
    const r = rng.fork(`${b.key}:insights`);
    const points = { reach: [], views: [], accounts_engaged: [] };
    for (let d = 0; d < days; d++) {
      const day = new Date(startAt + (d + 1) * DAY_MS - 1).toISOString().slice(0, 10);
      const lift = growth(d, days);
      const reach = Math.round((600 + r.int(0, 500)) * lift);
      points.reach.push({ day, value: reach });
      points.views.push({ day, value: Math.round(reach * (1.6 + r.next())) });
      points.accounts_engaged.push({ day, value: Math.round(reach * (0.05 + r.next() * 0.04)) });
      note(d, b, 'insights', d);
    }
    for (const [metric, list] of Object.entries(points)) await meta.post('/insights/daily', { igUserId: b.igUserId, metric, points: list });
    const refreshed = await b.api.post('/insights/refresh', {}, { allow: [400, 409, 429] });
    if (![200, 201, 202, 204].includes(refreshed.status)) log(`insights refresh answered ${refreshed.status} for ${b.key}`);
  }
}

export { SHOWCASE };
