// PRD 5.13: everything a buyer sees carries the seller's brand and never Bhava's, even now that Bhava has its own
// WhatsApp number and email sender for sellers. Links in buyer messages open seller-branded pages on the seller's own
// address, tracking included, with no Bhava redirect, no shortener and no courier page. F-87, F-89.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLATFORM_EMAIL, PLATFORM_PHONE_ID, address, addP4Shop, buyer, codOrder, hit, newPhone, noPlatformName, unique, useP5World } from './kit.js';

const world = useP5World();
const line = (product, qty = 1) => ({ productId: product.id, variantId: null, qty });
const addressOf = (from) => String(from ?? '').replace(/^.*</, '').replace(/>.*$/, '').trim().toLowerCase();
const urlsIn = (text) => [...String(text).matchAll(/https?:\/\/[^\s"'<>\\)]+/g)].map((m) => m[0].replace(/&amp;/g, '&'));

/** The shopper's WhatsApp messages and emails, read from the simulators. */
async function shopperMessages(phone, email) {
  const wa = await world.allMessagesTo(phone);
  const mails = (await world.mail.get('/sent')).sent.filter((m) => m.to.includes(email));
  return { wa, mails };
}

test('F-87: a shopper\'s order confirmation by WhatsApp and email carries the seller\'s name, logo and colours, and never Bhava', async () => {
  const shop = await addP4Shop(world, { name: 'Marigold Weaves' });
  const logoUrl = await shop.upload('#AA3355');
  const kit = await shop.send('PATCH', '/brand-kit', { logoUrl, colors: { primary: '#234D33' } });
  assert.equal(kit.status, 200, `Saving the brand kit: ${kit.status} ${kit.text.slice(0, 200)}`);
  const product = await shop.item({ name: 'Ikat stole', pricePaise: 89900 });
  const phone = newPhone();
  const email = `meera${unique()}@mail.example`;
  const row = await buyer(world, shop).buy({ lines: [line(product)], address: address({ phone }), email });
  await world.waitFor(async () => (await shop.alertsOf(row.id, 'paid')).filter((a) => a.status === 'sent').length >= 2, 15_000);
  const { wa, mails } = await shopperMessages(phone, email);

  assert.ok(wa.length >= 1, 'No WhatsApp order confirmation reached the shopper');
  for (const m of wa) {
    assert.notEqual(m.phoneId, PLATFORM_PHONE_ID, 'A shopper got a message from Bhava\'s own WhatsApp number');
    assert.equal(m.phoneId, shop.waPhoneId, 'The confirmation did not come from the seller\'s own number');
    noPlatformName('The WhatsApp confirmation', m.body);
  }
  assert.ok(mails.length >= 1, 'No order confirmation email reached the shopper');
  for (const m of mails) {
    assert.notEqual(addressOf(m.from), PLATFORM_EMAIL, 'A shopper got an email from Bhava\'s sender');
    noPlatformName('The order confirmation email', { from: m.from, subject: m.subject, html: m.html, text: m.text, headers: m.headers, replyTo: m.replyTo });
    assert.match(`${m.from} ${m.subject} ${m.html}`, /Marigold Weaves/, 'The email does not carry the seller\'s name');
    assert.ok(m.html.includes(logoUrl.split('/').pop()), 'The email does not carry the seller\'s logo');
    assert.match(m.html, /#234D33/i, 'The email does not carry the seller\'s colour');
    assert.ok(m.html.includes(row.order_number) || m.text.includes(row.order_number));
    for (const url of urlsIn(m.html)) assert.doesNotMatch(url, /bhava/i, `A link in the shopper's email goes to ${url}`);
  }
});

test('F-87: no message to a shopper ever leaves through Bhava\'s own WhatsApp number or sender', async () => {
  const shop = await addP4Shop(world, { name: 'Peacock Prints' });
  await shop.codOn();
  const product = await shop.item({ pricePaise: 45900, stock: 5 });
  const email = `ira${unique()}@mail.example`;
  const { phone } = await codOrder(world, shop, [line(product)], { email });
  await world.waitFor(() => false, 3000);
  const { wa, mails } = await shopperMessages(phone, email);
  assert.ok(wa.length >= 1, 'The shopper\'s sign-in code did not reach them');
  assert.ok(wa.every((m) => m.phoneId !== PLATFORM_PHONE_ID), 'A shopper\'s login or COD code came from Bhava\'s number');
  assert.ok(mails.every((m) => addressOf(m.from) !== PLATFORM_EMAIL));
  for (const m of wa) noPlatformName('A message to a shopper', m.body);
});

test('F-89: the tracking link in a shipping update opens the seller\'s own tracking page on the seller\'s address, not the courier\'s', async () => {
  const shop = await addP4Shop(world, { name: 'Banyan Basket' });
  const product = await shop.item({ pricePaise: 59900 });
  const phone = newPhone();
  const email = `tara${unique()}@mail.example`;
  const row = await buyer(world, shop).buy({ lines: [line(product)], address: address({ phone }), email });
  const shipment = await shop.ship(row);
  await shop.track(shipment.awb, 'PICKED UP');
  await world.waitFor(async () => (await shop.alertsOf(row.id, 'shipped')).filter((a) => a.status === 'sent').length >= 1, 15_000);
  const { wa, mails } = await shopperMessages(phone, email);
  const shipped = [...wa.map((m) => JSON.stringify(m.body)), ...mails.filter((m) => /ship|track|on its way|dispatched/i.test(`${m.subject} ${m.html}`)).map((m) => m.html)];
  const links = shipped.flatMap(urlsIn).filter((u) => /track|order|ship/i.test(u));
  assert.ok(links.length >= 1, 'No tracking link in the shipping update');
  for (const link of links) {
    const url = new URL(link);
    assert.doesNotMatch(url.host, /shiprocket|bhava/i, `The tracking link goes to ${url.host}`);
    assert.equal(url.host, shop.host, `The tracking link is on ${url.host}, not ${shop.host}`);
    assert.doesNotMatch(url.pathname, /^\/(l|r|go|s|redirect|out)\//, `The tracking link is a redirect: ${url.pathname}`);
    const page = await hit(world, `${url.pathname}${url.search}`, { host: url.host, headers: { accept: 'text/html' } });
    assert.equal(page.status, 200, `The tracking page answered ${page.status}`);
    assert.ok(!page.headers.location, 'The tracking page redirects');
    noPlatformName('The tracking page', page.text);
    assert.match(page.text, /Banyan Basket/, 'The tracking page does not carry the seller\'s name');
    assert.ok(page.text.includes(shipment.awb) || page.text.includes(row.order_number), 'The tracking page shows neither the AWB nor the order');
    for (const href of urlsIn(page.text)) assert.doesNotMatch(href, /shiprocket\.(co|in)\/track|bhava/i, `The tracking page sends the shopper to ${href}`);
  }
});
