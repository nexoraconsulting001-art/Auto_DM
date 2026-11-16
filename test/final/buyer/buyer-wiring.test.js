// Final review, buyer findings buyer-1 and buyer-2: the parts of the buyer's journey that exist on their own but were never
// joined up in the running app. Each test drives the real app (every module set up as the server sets it up), never a stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { address, addP4Shop, buyer, newPhone, ok, useP4World } from '../../p4/spec-p4/kit.js';
import { GATEWAY_ORIGINS, PAY_JS, PAY_SCRIPT } from '../../../src/modules/storefront/views/pay.js';

const world = useP4World();
const line = (product, qty = 1) => ({ productId: product.id, variantId: null, qty });

/** A Content-Security-Policy header as { directive: [sources] }. */
function policy(header) {
  assert.ok(header, 'The page has no Content-Security-Policy');
  return Object.fromEntries(String(header).split(';').map((part) => part.trim().split(/\s+/)).filter((p) => p[0]).map(([name, ...sources]) => [name, sources]));
}
const loadsScript = (html, src) => new RegExp(`<script[^>]+src="${src.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(\\?[^"]*)?"`).test(String(html));

/** The page lets the gateway's checkout load its script, open its frame and talk to its own servers. */
function assertGatewayAllowed(header, what) {
  const p = policy(header);
  for (const origin of GATEWAY_ORIGINS.script) assert.ok(p['script-src']?.includes(origin), `${what}: script-src does not allow ${origin}: ${header}`);
  assert.ok(p['frame-src'], `${what}: no frame-src, so the gateway's frame falls back to default-src 'self' and is blocked: ${header}`);
  for (const origin of GATEWAY_ORIGINS.frame) assert.ok(p['frame-src'].includes(origin), `${what}: frame-src does not allow ${origin}: ${header}`);
  for (const origin of GATEWAY_ORIGINS.connect) assert.ok(p['connect-src']?.includes(origin), `${what}: connect-src does not allow ${origin}: ${header}`);
}

test('buyer-1: the order page of an unpaid online order loads the payment script, the store serves it, and the policy lets the gateway open', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item({ pricePaise: 54800, stock: 3 });
  const b = buyer(world, shop);
  const placed = ok(await b.place(b.checkoutBody({ lines: [line(product)], paymentMode: 'prepaid' })), 'Placing an online order');
  assert.equal(placed.data.next, 'pay');
  assert.ok(placed.data.gateway?.gatewayOrderId, 'Placing gave no gateway order to open');

  const page = await b.open(`/order/${placed.data.token}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-pay\b/, 'The unpaid order shows no Pay button');
  assert.ok(loadsScript(page.text, PAY_SCRIPT), `The order page does not load ${PAY_SCRIPT}, so window.StorePay never exists and Pay always fails`);
  assertGatewayAllowed(page.headers['content-security-policy'], 'The order page');

  const script = await b.open(PAY_SCRIPT);
  assert.equal(script.status, 200, `${PAY_SCRIPT} is not served`);
  assert.match(String(script.headers['content-type']), /javascript/);
  assert.equal(script.text, PAY_JS);
});

test('buyer-1: the checkout page loads the payment script and allows the gateway, so an online order opens payment straight after placing', async () => {
  const shop = await addP4Shop(world);
  await shop.item({ pricePaise: 25000, stock: 3 });
  const b = buyer(world, shop);
  const page = await b.open('/checkout');
  assert.equal(page.status, 200);
  assert.ok(loadsScript(page.text, PAY_SCRIPT), `The checkout page does not load ${PAY_SCRIPT}`);
  assertGatewayAllowed(page.headers['content-security-policy'], 'The checkout page');
});

test('buyer-1: a page that takes no payment does not name the gateway in its policy', async () => {
  const shop = await addP4Shop(world);
  const b = buyer(world, shop);
  const page = await b.open('/shop');
  assert.equal(page.status, 200);
  const header = String(page.headers['content-security-policy'] ?? '');
  for (const origin of [...GATEWAY_ORIGINS.script, ...GATEWAY_ORIGINS.frame, ...GATEWAY_ORIGINS.connect]) assert.ok(!header.includes(origin), `The shop page allows ${origin}: ${header}`);
  assert.ok(!loadsScript(page.text, PAY_SCRIPT), 'The shop page loads the payment script');
});

test('buyer-2: a signed-in shopper who ticks "save my details" finds the new address saved after placing', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item({ pricePaise: 30000, stock: 3 });
  const b = buyer(world, shop);
  await b.signIn();
  const me = await b.me();
  const fresh = address({ phone: newPhone(), line1: '7 Banyan Street', city: 'Nashik' });
  ok(await b.place(b.checkoutBody({ lines: [line(product)], paymentMode: 'prepaid', address: fresh, saveDetails: true })), 'Placing with save my details');
  const saved = await shop.sql('SELECT line1, city, is_default FROM shopper_addresses WHERE tenant_id = $1 AND shopper_id = $2', [shop.tenantId, me.id]);
  assert.equal(saved.length, 1, 'The ticked "save my details" saved no address');
  assert.equal(saved[0].line1, '7 Banyan Street');
  assert.equal(saved[0].city, 'Nashik');

  ok(await b.place(b.checkoutBody({ lines: [line(product)], paymentMode: 'prepaid', address: address({ line1: '9 Other Road' }) })), 'Placing without the box ticked');
  const after = await shop.sql('SELECT count(*)::int AS n FROM shopper_addresses WHERE tenant_id = $1 AND shopper_id = $2', [shop.tenantId, me.id]);
  assert.equal(after[0].n, 1, 'An address was saved without the box ticked');
});

test('buyer-2: a guest who enters the right cash-on-delivery code gets the order placed, through the real shopper service', async () => {
  const shop = await addP4Shop(world);
  await shop.codOn();
  const product = await shop.item({ pricePaise: 45000, stock: 3 });
  const b = buyer(world, shop);
  const phone = newPhone();
  const body = b.checkoutBody({ lines: [line(product)], paymentMode: 'cod', address: address({ phone }) });
  assert.equal(ok(await b.place(body), 'COD as a guest').data.next, 'verify_phone');
  ok(await b.sendCode(phone, 'cod', { checkoutKey: body.idempotencyKey }), 'Asking for the COD code');
  ok(await b.verifyCode(phone, await world.codeFor(phone), 'cod', { checkoutKey: body.idempotencyKey }), 'The right code');
  const placed = ok(await b.place(body), 'Placing after the code');
  assert.equal(placed.data.next, 'done', 'The right COD code still answered verify_phone');
  assert.equal((await shop.orders()).length, 1);
});
