// compliance-6: a WhatsApp keyword set is checked when it is saved, as the gate checks it again at send (PRD 4.10, 4.11), and a reply
// that saves is not then refused at send for Instagram's 1,000-byte limit: WhatsApp takes 4,096.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { json, openBillingWorld } from '../../p7/spec-p7/support.js';
import { inbound, keywordsFor, linkSet, sentTo, shopper, useWorld, waShop } from '../../p7/whatsapp-addon/support.js';

let world;
before(async () => {
  world = await openBillingWorld({ overrides: { whatsappAppId: 'sim-wa-app', whatsappSignupConfigId: 'sim-wa-config' } });
  useWorld(world, { numbers: 7_100_000 });
});
after(async () => {
  await world?.close();
});

const save = (shop, items) => shop.send('PUT', '/whatsapp/keywords', { items });
async function refused(shop, set, reason, field) {
  const res = await save(shop, [set]);
  assert.equal(res.status, 400, `${JSON.stringify(set)} should be refused, got ${res.status}`);
  const body = json(res);
  assert.equal(body.code, 'validation_failed');
  assert.equal(body.reason, reason, JSON.stringify(body));
  if (field) assert.ok(Object.keys(body.fields ?? {}).includes(field), JSON.stringify(body.fields));
}

test('compliance-6: a keyword set that would fail at send is refused at save, with the reason code', async () => {
  const shop = await waShop();
  await refused(shop, linkSet('saree', 'https://bit.ly/x'), 'link.shortener', 'items.0.linkUrl');
  await refused(shop, linkSet('saree', 'https://bhava.app/x'), 'content.bhava_promo', 'items.0.linkUrl');
  await refused(shop, linkSet('saree', 'https://shop.example/p', { message: 'Shop on Bhava! {link}' }), 'content.bhava_promo', 'items.0.message');
  await refused(shop, linkSet('saree', 'https://shop.example/p', { message: 'Get yours on Bha​va {link}' }), 'content.bhava_promo', 'items.0.message');
  await refused(shop, linkSet('saree', 'https://shop.example/p', { message: 'Send your OTP to confirm {link}' }), 'content.financial_request', 'items.0.message');
  await refused(shop, linkSet('saree', 'https://shop.example/p', { message: 'Also at tinyurl.com/abc {link}' }), 'link.shortener', 'items.0.message');
  await refused(shop, linkSet('saree', 'https://shop.example/p', { message: 'Or https://bit.ly/y' }), 'link.shortener', 'items.0.message');
  await refused(shop, linkSet('saree', 'https://shop.example/p', { message: 'Chat on wa.me/911111111111 {link}' }), 'link.not_allowlisted', 'items.0.message');
  assert.deepEqual(json(await shop.send('GET', '/whatsapp/keywords')).items, [], 'nothing was saved');
});

test('compliance-6: a Hindi reply over 1,000 bytes saves, and is delivered rather than refused at send', async () => {
  const shop = await waShop();
  const message = `${'साड़ी'.repeat(80)} {link}`; // 400 Devanagari characters, about 1,200 bytes
  assert.ok(Buffer.byteLength(message) > 1000);
  await keywordsFor(shop, [linkSet('saree', 'https://hindi.example/saree', { message })]);
  const from = shopper();
  await inbound(shop, from, 'saree');
  await shop.settle();
  const sent = await sentTo(from);
  assert.equal(sent.length, 1, 'the reply went');
  assert.match(sent[0].body.text.body, /^(साड़ी){80} https:\/\/hindi\.example\/saree/);
  const [job] = await shop.jobs(`channel = 'whatsapp'`);
  assert.deepEqual([job.status, job.reason], ['sent', '']);
});
