// Everything a buyer can see carries the seller's brand and never the platform's (PRD 9.1, 5.18; HANDOFF "Rules that never
// bend"): every buyer page of the store and of Phase 3, as a guest and signed in, in every state an order goes through; the
// scripts, styles and app manifest those pages load; their response headers and cookies; the JSON the pages read; the
// payment screen's display options; the invoice PDF; and the WhatsApp messages and emails the shopper gets, whose links go
// straight to the store. The one page allowed to name the platform is the shared-profile consent screen (S-101).
//
// Every page route in the contract (STORE_ROUTES and BUYER_ROUTES) must have a sample here, so a new buyer page is checked
// as soon as it is listed.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { TRAFFIC_PATHS } from '../../../src/contracts/analytics.js';
import { POLICY_KINDS } from '../../../src/contracts/api/store.js';
import { BUYER_ROUTES } from '../../../src/contracts/buyer-pages.js';
import { STORE_ROUTES } from '../../../src/contracts/store-routes.js';
import { creatorPage } from '../spec-p4/kit.js';
import { AGGREGATOR_NAME, PLATFORM_NAME, SHOP_NAME, buyer, getBytes, linksIn, messageText, newPhone, openStore, pathOf, pdfText, png, readAs } from './support.js';

let store;
let s; // everything made in before()
before(async () => {
  store = await openStore();
  const { world, shop, plant, pot, size, reel } = store;
  const category = await shop.category('Indoor plants');
  await shop.must('PATCH', `/products/${plant.id}`, { categoryIds: [category.id] }, 200, 'Putting the plant in a category');
  const creator = await creatorPage(shop);

  const b = buyer(world, shop);
  const phone = await b.signIn(newPhone());
  const email = `asha.${Date.now()}@mail.example`;
  const consent = { orderUpdates: { whatsapp: true, email: true }, marketing: { whatsapp: false, email: false } };
  const addr = { name: 'Asha Rao', phone, line1: '12 Lake Road', line2: '', landmark: '', city: 'Pune', stateCode: '27', pincode: '411001' };
  const delivered = await b.delivered({ lines: [{ productId: plant.id, variantId: size.M, qty: 1 }], address: addr, email, consent });
  const shipped = await b.buy({ lines: [{ productId: pot.id, variantId: null, qty: 1 }], address: addr, email, consent });
  const shipment = await shop.ship(shipped);
  await shop.track(shipment.awb, 'OUT FOR DELIVERY', { location: 'Pune hub' });
  const waiting = await b.order({ lines: [{ productId: pot.id, variantId: null, qty: 2 }], address: addr, email, consent });
  const proof = { field: 'proof', filename: 'leaf.png', type: 'image/png', data: png({ width: 64, height: 64, color: '#3B7A57' }) };
  const items = await shop.orderItems(delivered.id);
  const asked = await b.askReturn(delivered.order_number, { fields: { items: [{ orderItemId: items[0].id, qty: 1 }], reason: 'A leaf arrived torn.', resolution: 'refund' }, files: [proof] });
  assert.ok(asked.status < 300, `The return was refused: ${asked.status} ${asked.text.slice(0, 200)}`);
  const reviewed = await b.review({ orderNumber: delivered.order_number, productId: plant.id, rating: 5, body: 'Healthy plant, lovely pot.' });
  assert.ok(reviewed.status < 300, `The review was refused: ${reviewed.status} ${reviewed.text.slice(0, 200)}`);
  await b.api('PUT', '/api/store/wishlist', { add: [pot.id] });
  await world.quiet(1500);
  const [invoice] = await shop.invoices(delivered.id);
  assert.ok(invoice, 'The delivered order has an invoice');
  s = { world, shop, plant, pot, reel, category, creator, b, phone, email, delivered, shipped, shipment, waiting, invoice };
});
after(async () => {
  await store?.world.close();
});

/** A sample address for every buyer page in the contract, by route id. */
function samples() {
  const { plant, reel, category, creator, delivered, shipment, waiting, invoice } = s;
  const n = encodeURIComponent(delivered.order_number);
  return {
    // STORE_ROUTES
    home: ['/'],
    shop: ['/shop', '/shop?sort=price-asc&price=under-499'],
    product: [`/p/${plant.slug}`],
    search: ['/search', '/search?q=monstera', '/search?q=nothing-like-this'],
    about: ['/about'],
    offline: ['/offline'],
    cartPage: ['/cart'],
    cartRestore: ['/cart/restore/not-a-real-token-0000000000'],
    signIn: ['/login', '/login?next=%2Fcheckout'],
    googleStart: ['/auth/google'],
    googleCallback: ['/auth/google/callback?code=x&state=y'],
    account: ['/account'],
    accountOrders: ['/account/orders'],
    accountOrder: [`/account/orders/${n}`],
    sharedConsent: ['/account/shared-profile'],
    checkout: ['/checkout'],
    order: [`/order/${delivered.placed.token}`, `/order/${waiting.token}`, `/order/${s.shipped.placed.token}`, '/order/not-a-real-order-token-00'],
    invoiceFile: [`/order/${delivered.placed.token}/invoice/${encodeURIComponent(invoice.number)}`],
    tracking: [pathOf(shipment.trackingUrl), '/track/1.not-a-real-token-000000'],
    points: ['/account/points'],
    referralLanding: ['/refer/NOSUCHCODE'],
    returnStart: [`/account/orders/${n}/return`],
    policy: POLICY_KINDS.map((k) => `/policies/${k}`),
    unsubscribe: ['/unsubscribe/not-a-real-token-0000000000'],
    wishlistPage: ['/wishlist'],
    // BUYER_ROUTES (Phase 3)
    landing: [`/r/${reel.slug}`],
    landingProduct: [`/r/${reel.slug}/p/${plant.slug}`],
    category: [`/c/${category.slug}`],
    reels: ['/reels'],
    creator: [`/${creator.slug}`],
    creatorShelf: [`/${creator.slug}/${category.slug}`],
    creatorTiles: [`/${creator.slug}/_tiles`],
    leadThanks: ['/lead/thanks'],
    leadOptOut: ['/lead/opt-out'],
    robots: ['/robots.txt'],
    // and what no route answers: the store's own 404
    notFound: ['/no-such-page'],
  };
}

const pageRoutes = () => ({
  ...Object.fromEntries(Object.entries(STORE_ROUTES).filter(([, r]) => r.kind === 'page' && r.method === 'GET')),
  ...Object.fromEntries(Object.entries(BUYER_ROUTES).filter(([, r]) => r.method === 'GET')),
});
const platformNamed = (id) => Boolean(STORE_ROUTES[id]?.platformNamed);

/** Where the platform's name shows in a text: a few characters either side, or null. */
function nameIn(text) {
  const m = PLATFORM_NAME.exec(String(text));
  return m ? String(text).slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ') : null;
}
const headerText = (headers) => Object.entries(headers).map(([k, v]) => `${k}: ${[v].flat().join(', ')}`).join('\n');

/** The same-origin scripts, styles, icons and manifest a page loads. */
function assetsOf(html) {
  const out = new Set();
  for (const m of String(html).matchAll(/<(?:script|link|img)\b[^>]*?\s(?:src|href)="(\/[^"/][^"]*)"/gi)) out.add(m[1].replace(/&amp;/g, '&'));
  return [...out];
}

test('every buyer page in the contract has a sample here, so each is checked', () => {
  const missing = Object.keys(pageRoutes()).filter((id) => !samples()[id]);
  assert.deepEqual(missing, [], 'A buyer page route has no sample address in brand.test.js');
});

test('no buyer page names the platform, as a guest or signed in, in its body, headers or cookies', async () => {
  const { world, shop, b } = s;
  const found = [];
  const crashed = [];
  for (const [id, paths] of Object.entries(samples())) {
    for (const path of paths) {
      for (const [who, as] of [['guest', buyer(world, shop)], ['shopper', b]]) {
        const res = await as.open(path);
        if (res.status >= 500) crashed.push(`${who} ${path}: ${res.status}`);
        const body = res.headers['content-type']?.includes('pdf') ? pdfText((await getBytes(world, shop.host, path, as.cookie ? { cookie: as.cookie } : {})).body) : res.text;
        if (!platformNamed(id) && nameIn(body)) found.push(`${who} ${path} (${res.status}) body: …${nameIn(body)}…`);
        if (nameIn(headerText(res.headers))) found.push(`${who} ${path} headers: …${nameIn(headerText(res.headers))}…`);
      }
    }
  }
  assert.deepEqual(crashed, [], 'A buyer page failed with a server error');
  assert.deepEqual(found, [], 'The platform’s name reaches a buyer');
});

test('the shared-profile consent screen, the one page allowed to name the platform, names the seller too', async () => {
  const res = await s.b.open('/account/shared-profile');
  assert.equal(res.status, 200);
  assert.ok(res.text.includes(SHOP_NAME), 'The consent screen still wears the seller’s brand');
});

test('every script, style, icon and manifest a buyer page loads is free of the platform’s name', async () => {
  const { b } = s;
  const assets = new Set(['/manifest.webmanifest', '/sw.js', TRAFFIC_PATHS.script]);
  for (const [id, paths] of Object.entries(samples())) {
    if (platformNamed(id)) continue;
    for (const path of paths) {
      const res = await b.open(path);
      if ((res.headers['content-type'] ?? '').includes('html')) for (const a of assetsOf(res.text)) assets.add(a);
    }
  }
  const found = [];
  const broken = [];
  for (const path of assets) {
    if (/^\/media\//.test(path)) continue; // the seller's own uploads
    const res = await b.open(path, { accept: '*/*' });
    if (res.status >= 400) broken.push(`${path}: ${res.status}`);
    if (nameIn(res.text)) found.push(`${path}: …${nameIn(res.text)}…`);
    if (nameIn(headerText(res.headers))) found.push(`${path} headers: …${nameIn(headerText(res.headers))}…`);
  }
  assert.ok(assets.size > 5, `Too few assets found to mean anything: ${[...assets].join(', ')}`);
  assert.deepEqual(broken, [], 'A buyer page loads a file that isn’t there');
  assert.deepEqual(found, [], 'A file a buyer’s browser loads names the platform');
});

test('the home-screen app is the seller’s: its name, and no platform name (S-67)', async () => {
  const res = await s.b.open('/manifest.webmanifest', { accept: 'application/manifest+json' });
  assert.equal(res.status, 200);
  const manifest = JSON.parse(res.text);
  assert.equal(manifest.name, SHOP_NAME);
  assert.equal(nameIn(res.text), null);
});

test('the JSON a buyer’s pages read carries no platform name', async () => {
  const { b, plant, pot, shop, world } = s;
  const calls = [
    ['GET', '/api/store/cart'],
    ['GET', `/api/store/products?ids=${plant.id},${pot.id},999999`],
    ['GET', '/api/store/addresses'],
    ['GET', '/api/store/consent'],
    ['GET', '/api/store/wishlist'],
    ['GET', `/api/store/products/${plant.id}/reviews`],
    ['GET', '/api/store/serviceability?pincode=411001'],
    ['POST', '/api/store/checkout/quote', { lines: [{ productId: plant.id, variantId: null, qty: 1 }] }],
    ['POST', '/api/store/checkout/quote', { lines: [{ productId: pot.id, variantId: null, qty: 1 }], price: 1 }],
    ['POST', '/api/store/coupons/check', { code: 'NOPE' }],
    ['POST', `/api/store/orders/${encodeURIComponent(s.waiting.token)}/retry`, {}],
    ['GET', '/api/store/nothing-here'],
  ];
  const found = [];
  for (const [who, as] of [['guest', buyer(world, shop)], ['shopper', b]]) {
    for (const [method, path, body] of calls) {
      const res = await as.api(method, path, body);
      assert.ok(res.status < 500, `${who} ${method} ${path}: ${res.status} ${res.text.slice(0, 200)}`);
      if (nameIn(res.text)) found.push(`${who} ${method} ${path}: …${nameIn(res.text)}…`);
    }
  }
  assert.deepEqual(found, []);
});

test('the payment screen is opened with the seller’s name and colours, never the platform’s (S-71)', async () => {
  const { b, pot } = s;
  const placed = await b.order({ lines: [{ productId: pot.id, variantId: null, qty: 1 }] });
  assert.equal(placed.next, 'pay');
  assert.equal(placed.gateway?.display?.name, SHOP_NAME);
  assert.match(placed.gateway.display.color, /^#[0-9A-Fa-f]{6}$/);
  assert.equal(nameIn(JSON.stringify(placed.gateway)), null);
});

test('the invoice PDF names the seller and never the platform, in its text or its document details', async () => {
  const { world, shop, b, delivered, invoice } = s;
  const res = await getBytes(world, shop.host, `/order/${delivered.placed.token}/invoice/${encodeURIComponent(invoice.number)}`, { cookie: b.cookie, accept: 'application/pdf' });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /pdf/);
  assert.equal(res.body.subarray(0, 5).toString(), '%PDF-');
  const words = pdfText(res.body);
  assert.ok(words.includes(SHOP_NAME), 'The invoice’s text could be read and names the seller');
  assert.equal(nameIn(words), null);
});

test('WhatsApp messages and emails to the shopper carry the seller’s brand and direct links to the store only', async () => {
  const { world, phone, email, shipment } = s;
  const whatsapp = await world.whatsappTo(phone);
  const mails = await world.emailsTo(email);
  assert.ok(whatsapp.length >= 3, `The shopper got only ${whatsapp.length} WhatsApp messages (code, order updates)`);
  assert.ok(mails.length >= 1, 'The shopper got no email about their orders');
  const storeHost = new URL(shipment.trackingUrl).hostname;
  const found = [];
  const links = [];
  for (const m of [...whatsapp, ...mails]) {
    // A template message is read as WhatsApp shows it: the approved body with the values put in.
    const text = `${messageText(m)}\n${readAs(m)}`;
    if (nameIn(text)) found.push(`…${nameIn(text)}…`);
    for (const link of linksIn(text)) if (new URL(link).hostname !== storeHost) links.push(link);
  }
  assert.deepEqual(found, [], 'A message to the shopper names the platform');
  assert.deepEqual(links, [], 'A message link goes somewhere other than the store’s own address');
  for (const m of mails) {
    assert.ok(String(m.from).startsWith(`${SHOP_NAME} <`), `An email’s sender isn’t the seller by name: ${m.from}`);
    assert.equal(nameIn(m.from), null, `An email is sent from the platform’s name or address: ${m.from}`);
    assert.ok(String(m.subject).includes(SHOP_NAME), `An email’s subject doesn’t name the seller: ${m.subject}`);
  }
  assert.ok(whatsapp.some((m) => readAs(m).includes(SHOP_NAME)), 'No order update on WhatsApp names the seller');
});

test('the "on its way" message links to the parcel’s tracking page on the seller’s domain (S-78, 9.10)', async () => {
  const { world, phone, shipment, shipped: order } = s;
  const shipped = (await world.whatsappTo(phone)).filter((m) => m.body?.template?.name === 'order_shipped' && readAs(m).includes(order.order_number));
  assert.equal(shipped.length, 1, 'The shopper got one "on its way" message for the order the courier has');
  const link = linksIn(readAs(shipped[0]))[0];
  assert.ok(link, 'The "on its way" message has a link');
  assert.equal(pathOf(link), pathOf(shipment.trackingUrl), `"Follow it here" opens ${pathOf(link)}, not the tracking page`);
});

test('the tracking page names the courier’s scans and the seller, never the courier aggregator or the platform (S-78)', async () => {
  const { b, shipment } = s;
  const res = await b.open(pathOf(shipment.trackingUrl));
  assert.equal(res.status, 200);
  assert.ok(res.text.includes(SHOP_NAME));
  assert.ok(res.text.includes(shipment.awb));
  assert.equal(AGGREGATOR_NAME.test(res.text), false, 'The tracking page names the courier aggregator');
  assert.equal(nameIn(res.text), null);
});

test('every buyer page has one main heading (h1), so a screen reader can find what the page is', async () => {
  const { b } = s;
  const without = [];
  for (const [id, paths] of Object.entries(samples())) {
    if (['robots', 'creatorTiles', 'googleStart', 'googleCallback', 'invoiceFile', 'cartRestore'].includes(id)) continue; // not pages a shopper reads
    for (const path of paths) {
      const res = await b.open(path);
      if (!(res.headers['content-type'] ?? '').includes('html') || res.status >= 300 && res.status < 400) continue;
      const count = (res.text.match(/<h1\b/gi) ?? []).length;
      if (count !== 1) without.push(`${path} (${res.status}): ${count} h1`);
    }
  }
  assert.deepEqual(without, []);
});
