// commerce-2 (final review): a prepaid or part-advance order can be paid in the browser (PRD 9.5, 9.6). The payment script
// (PAY_JS) is served at PAY_SCRIPT, the checkout and order pages load it, the checkout opens the gateway when the server
// answers next: 'pay', and those two pages' Content-Security-Policy lets the gateway's script and frame run. Other buyer
// pages do not name the gateway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKOUT_JS } from '../../../src/modules/checkout/assets.js';
import { GATEWAY_ORIGINS, PAY_JS, PAY_SCRIPT } from '../../../src/modules/storefront/views/pay.js';
import { hit, payments, place, placeBody, product, storeApp } from '../../p4/checkout/support.js';

const directive = (policy, name) => (String(policy ?? '').split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '');
const loads = (text, src) => text.includes(`<script src="${src}?v=`) || text.includes(`<script src="${src}"`);

function gatewayAllowed(res, where) {
  const policy = res.headers['content-security-policy'];
  assert.ok(policy, `${where} has no Content-Security-Policy`);
  for (const origin of GATEWAY_ORIGINS.script) assert.ok(directive(policy, 'script-src').split(' ').includes(origin), `${where}: script-src does not allow ${origin}: ${policy}`);
  for (const origin of GATEWAY_ORIGINS.frame) assert.ok(directive(policy, 'frame-src').split(' ').includes(origin), `${where}: frame-src does not allow ${origin}: ${policy}`);
}

test('commerce-2: PAY_JS is served at PAY_SCRIPT', async () => {
  const app = await storeApp();
  try {
    const res = await hit(app, PAY_SCRIPT);
    assert.equal(res.status, 200, `GET ${PAY_SCRIPT} answered ${res.status}`);
    assert.match(String(res.headers['content-type']), /javascript/);
    assert.equal(res.text, PAY_JS);
  } finally {
    app.close();
  }
});

test('commerce-2: the order page of an unpaid prepaid order loads PAY_SCRIPT and its policy allows the gateway', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    const lamp = await product(app, { stock: 3 });
    const placed = await place(app, placeBody(lamp.id));
    assert.equal(placed.status, 201, placed.text);
    assert.equal(placed.json.next, 'pay');
    const page = await hit(app, `/order/${placed.json.token}`);
    assert.equal(page.status, 200, page.text.slice(0, 200));
    assert.match(page.text, /data-pay\b/, 'The order page has no Pay button');
    assert.ok(loads(page.text, PAY_SCRIPT), 'The order page does not load the payment script');
    gatewayAllowed(page, 'The order page');
  } finally {
    app.close();
  }
});

test('commerce-2: the checkout page loads PAY_SCRIPT and allows the gateway; a plain store page does not name it', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    await product(app, { stock: 3 });
    const page = await hit(app, '/checkout');
    assert.equal(page.status, 200, page.text.slice(0, 200));
    assert.ok(loads(page.text, PAY_SCRIPT), 'The checkout page does not load the payment script');
    gatewayAllowed(page, 'The checkout page');
    const shop = await hit(app, '/shop');
    assert.equal(shop.status, 200);
    const policy = String(shop.headers['content-security-policy'] ?? '');
    for (const origin of [...GATEWAY_ORIGINS.script, ...GATEWAY_ORIGINS.frame]) assert.ok(!policy.includes(origin), `A page that takes no payment allows ${origin}`);
  } finally {
    app.close();
  }
});

test('commerce-2: when the server answers next: "pay", the checkout script opens the gateway with the order token', () => {
  const branch = /res\.data\.next === 'pay'[\s\S]{0,400}?StorePay\.open\(res\.data\.gateway, res\.data\.token\)/;
  assert.match(CHECKOUT_JS, branch, 'The checkout script never opens the payment screen');
});
