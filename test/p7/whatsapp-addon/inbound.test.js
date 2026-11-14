// The WhatsApp add-on (PRD 6.12) end to end: the WhatsApp simulator delivers signed webhooks to the app, the worker sends
// through the compliance gate, and the simulator records what a shopper would receive. Keyword replies, routing and storing once. Track whatsapp-addon.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hit, json, need, one, openBillingWorld, shopOn, sql, unique } from '../spec-p7/support.js';
import { HOUR, bodyOf, delivery, inbound, keywordsFor, linkSet, post, sentTo, shopper, sign, threadOf, useWorld, waEvents, waShop } from './support.js';

let world;
before(async () => {
  world = await openBillingWorld({ overrides: { whatsappAppId: 'sim-wa-app', whatsappSignupConfigId: 'sim-wa-config' } });
  useWorld(world, { numbers: 6_000_000 });
});
after(async () => {
  await world?.close();
});

test('A-61: a keyword answers with the reel page or the link as a direct link with utm_source=whatsapp, once per message, from the seller only', async () => {
  const shop = await waShop('Haldi House');
  const page = await shop.page();
  const reel = await one(world, 'SELECT slug FROM reels WHERE tenant_id = $1 AND id = $2', [shop.tenantId, page.id]);
  await keywordsFor(shop, [
    { keywords: ['saree', 'sari'], reelId: page.id, linkUrl: '', message: 'Here it is: {link}', active: true },
    linkSet('offer', 'https://haldi-site.example/offer'),
  ]);

  const first = shopper();
  await inbound(shop, first, 'Is the SAREE available?', { duplicates: 3 });
  await shop.settle();
  const sent = await sentTo(first);
  assert.equal(sent.length, 1, `one reply however often it is delivered, got ${sent.length}`);
  const text = sent[0].body.text.body;
  const link = /https:\/\/\S+/.exec(text)?.[0];
  assert.ok(link, text);
  const url = new URL(link);
  assert.equal(url.host, shop.host, 'the seller’s own address');
  assert.equal(url.pathname, `/r/${reel.slug}`, 'the reel’s landing page itself: no hop');
  // The landing page is the destination (BUYER_ROUTES.landing): it answers 200 itself and never redirects.
  const landing = await hit(world, `${url.pathname}${url.search}`, { host: shop.host });
  assert.equal(landing.status, 200, `the landing page answered ${landing.status}`);
  assert.equal(landing.headers.location, undefined);
  assert.equal(url.searchParams.get('utm_source'), 'whatsapp');
  assert.equal(url.searchParams.get('utm_medium'), 'dm');
  assert.ok(text.startsWith('Here it is: https://'), 'the seller’s words, with {link} filled in');
  assert.doesNotMatch(text, /bhava|bit\.ly|\/go\//i);
  assert.equal(sent[0].phoneId, shop.phoneId, 'from the business’s own number');

  const second = shopper();
  await inbound(shop, second, 'offer');
  await shop.settle();
  const [reply] = await sentTo(second);
  const offer = new URL(reply.body.text.body);
  assert.equal(`${offer.origin}${offer.pathname}`, 'https://haldi-site.example/offer');
  assert.equal(offer.searchParams.get('utm_source'), 'whatsapp');

  const quiet = shopper();
  await inbound(shop, quiet, 'good morning');
  await shop.settle();
  assert.equal((await sentTo(quiet)).length, 0, 'no keyword, no reply');

  // Stored once per message id, with nothing personal in the stored event; the repeats are on the log.
  const events = await waEvents(shop);
  assert.equal(events.length, 3);
  assert.ok(events.every((e) => e.status === 'done'), JSON.stringify(events.map((e) => e.status)));
  assert.doesNotMatch(JSON.stringify(events.map((e) => e.payload)), new RegExp(`${first}|${second}|saree|offer|Asha`, 'i'));
  const repeats = await sql(world, `SELECT 1 FROM compliance_events WHERE tenant_id = $1 AND channel = 'whatsapp' AND reason = 'webhook.duplicate'`, [shop.tenantId]);
  assert.equal(repeats.length, 2);

  // The inbox: a WhatsApp thread per shopper, their profile name and no number.
  const threads = json(need(await shop.send('GET', '/inbox/threads?limit=50'), 200, 'Inbox')).items.filter((t) => t.channel === 'whatsapp');
  assert.equal(threads.length, 3);
  assert.ok(threads.every((t) => t.username === 'Asha'));
  assert.doesNotMatch(JSON.stringify(threads), new RegExp(`${first}|${second}|${quiet}`));

  // Pass-through billing counts each message Meta accepted: one per job that ended 'sent', and nothing else. (Under heavy
  // load the simulator can answer after the 10 s timeout; that send is 'unknown', never counted on a guess.)
  // The usage listener runs just after the job is marked sent, so give it a moment to land.
  const jobs = await shop.jobs(`channel = 'whatsapp'`);
  const accepted = jobs.filter((j) => j.status === 'sent').length;
  assert.ok(accepted >= 1, JSON.stringify(jobs.map((j) => [j.status, j.reason])));
  const metered = () => one(world, `SELECT coalesce(sum(used), 0)::int AS used FROM usage_months WHERE tenant_id = $1 AND meter = 'whatsapp_messages'`, [shop.tenantId]);
  let meter = await metered();
  for (let i = 0; i < 50 && meter.used < accepted; i++) meter = await new Promise((resolve) => setTimeout(resolve, 100)).then(metered);
  assert.equal(meter.used, accepted, `every accepted reply counted once: ${JSON.stringify(jobs.map((j) => [j.status, j.reason]))}`);
});

test('A-61: the first active set by position answers; sets are validated, need the add-on, and never point at another business’s reel', async () => {
  const bare = await shopOn(world, 't1');
  assert.equal((await bare.send('PUT', '/whatsapp/keywords', { items: [] })).status, 403, 'the add-on is needed to save');
  assert.equal((await bare.send('GET', '/whatsapp/keywords')).status, 200, 'but reading never needs it');
  const a = await waShop();
  const b = await waShop();
  const bPage = await b.page();
  assert.equal((await a.send('PUT', '/whatsapp/keywords', { items: [{ keywords: ['x'], reelId: bPage.id, linkUrl: '', message: '', active: true }] })).status, 400, 'another business’s reel');
  for (const items of [[linkSet('x', 'http://plain.example/')], [{ ...linkSet('x', 'https://a.example/'), reelId: 1 }], [linkSet('   ', 'https://a.example/')], [linkSet('x', '')]]) {
    assert.equal((await a.send('PUT', '/whatsapp/keywords', { items })).status, 400, JSON.stringify(items));
  }
  const saved = await keywordsFor(a, [linkSet('kurta', 'https://first.example/k'), linkSet('kurta', 'https://second.example/k'), linkSet('dupatta', 'https://off.example/d', { active: false })]);
  assert.deepEqual(saved.items.map((s) => s.linkUrl), ['https://first.example/k', 'https://second.example/k', 'https://off.example/d']);
  const [p1, p2] = [shopper(), shopper()];
  await inbound(a, p1, 'kurta');
  await inbound(a, p2, 'dupatta');
  await a.settle();
  assert.match(bodyOf((await sentTo(p1))[0]), /first\.example/);
  assert.equal((await sentTo(p2)).length, 0, 'an inactive set answers nothing');
  // Saving the list again with one set left out removes it, and an id from elsewhere is refused.
  const kept = await keywordsFor(a, [{ ...saved.items[1], id: saved.items[1].id }]);
  assert.deepEqual(kept.items.map((s) => s.id), [saved.items[1].id]);
  const theirs = await keywordsFor(b, [linkSet('mine', 'https://b.example/')]);
  assert.equal((await a.send('PUT', '/whatsapp/keywords', { items: [{ ...linkSet('steal', 'https://a.example/'), id: theirs.items[0].id }] })).status, 400);
  assert.equal(json(need(await b.send('GET', '/whatsapp/keywords'), 200, 'B')).items[0].keywords[0], 'mine');
});

test('A-65: a webhook for B’s number reaches B only; a body changed to name another number, an unsigned one and an unknown number change nothing', async () => {
  const a = await waShop();
  const b = await waShop();
  await keywordsFor(a, [linkSet('kurta', 'https://a-only.example/kurta')]);
  await keywordsFor(b, [linkSet('kurta', 'https://b-only.example/kurta')]);
  const from = shopper();
  await inbound(b, from, 'kurta');
  await b.settle();
  assert.match(bodyOf((await sentTo(from))[0]), /b-only\.example/);
  assert.equal((await sql(world, `SELECT 1 FROM inbox_threads WHERE tenant_id = $1 AND channel = 'whatsapp'`, [a.tenantId])).length, 0, 'A sees nothing');
  assert.equal((await threadOf(b, from)).wa_phone_number_id, b.phoneId);

  // Signed for A's number, then changed to name B's: the bytes no longer match the signature.
  const victim = shopper();
  const signedForA = delivery(a.phoneId, victim, 'kurta');
  const forged = await post(signedForA.replace(a.phoneId, b.phoneId), sign(signedForA));
  assert.equal(forged.status, 401);
  assert.equal((await post(delivery(b.phoneId, victim, 'kurta'))).status, 401, 'unsigned');
  assert.equal((await post(delivery(b.phoneId, victim, 'kurta'), `sha256=${'0'.repeat(64)}`)).status, 401, 'a made-up signature');
  // The genuine delivery for A goes to A.
  assert.equal((await post(signedForA, sign(signedForA))).status, 200);
  await a.settle();
  await b.settle();
  assert.equal(await threadOf(b, victim), undefined, 'B never saw the forged message');
  assert.ok(await threadOf(a, victim), 'A got its own');
  assert.match(bodyOf((await sentTo(victim))[0]), /a-only\.example/);
  assert.equal((await sentTo(victim)).length, 1);

  // A malformed message beside a good one, and a NUL in the text: the good one is still stored and answered.
  const mixedFrom = shopper();
  const good = JSON.parse(delivery(a.phoneId, mixedFrom, 'kurta\u0000'));
  // (A null message itself is left out: order-alerts' STOP parser, which runs after this handler, cannot read one.)
  good.entry[0].changes[0].value.messages.unshift('junk', { type: 'text' }, [1]);
  good.entry.unshift(null);
  const mixed = JSON.stringify(good);
  assert.equal((await post(mixed, sign(mixed))).status, 200);
  await a.settle();
  assert.ok(await threadOf(a, mixedFrom), 'the good message was stored');
  assert.match(bodyOf((await sentTo(mixedFrom))[0]), /a-only\.example/);

  // A number nobody holds: counted, nothing stored for anyone, nothing sent.
  const before = (await sentTo()).length;
  const nobody = `9${crypto.randomInt(100_000_000, 999_999_999)}`;
  const raw = delivery(nobody, shopper(), 'kurta');
  assert.equal((await post(raw, sign(raw))).status, 200);
  await a.settle();
  assert.equal((await sentTo()).length, before);
  assert.equal((await one(world, `SELECT deliveries FROM inbound_unrouted WHERE channel = 'whatsapp' AND account_id = $1`, [nobody])).deliveries, 1);
  assert.equal((await sql(world, `SELECT 1 FROM inbound_events WHERE channel = 'whatsapp' AND account_id = $1`, [nobody])).length, 0);
});

test('stored before the 200 and run once: out of order, redelivered or swept again, a message is answered once and the window never moves back', async () => {
  const shop = await waShop();
  await keywordsFor(shop, [linkSet('saree', 'https://order.example/saree')]);
  const from = shopper();
  const now = Date.now();
  const older = `wamid.old${unique()}`;
  await inbound(shop, from, 'hello', { messageId: `wamid.new${unique()}`, at: now });
  await inbound(shop, from, 'saree', { messageId: older, at: now - 2 * HOUR });
  await shop.settle();
  const thread = await threadOf(shop, from);
  assert.equal(Math.floor(+new Date(thread.last_user_message_at) / 1000), Math.floor(now / 1000), 'the older message did not move the window back');
  assert.equal(thread.last_message, 'hello', 'nor the preview');
  assert.equal((await sentTo(from)).length, 1, 'the older message, still inside the window, is answered');

  // Meta delivers it again, and a worker finds it again: still one reply.
  await inbound(shop, from, 'saree', { messageId: older, at: now - 2 * HOUR });
  await sql(world, `UPDATE inbound_events SET status = 'pending', lease_until = NULL, received_at = received_at - interval '1 minute' WHERE tenant_id = $1 AND object_id = $2`, [shop.tenantId, older]);
  await shop.settle();
  assert.equal((await one(world, `SELECT status FROM inbound_events WHERE tenant_id = $1 AND object_id = $2`, [shop.tenantId, older])).status, 'done', 'the sweep took it');
  assert.equal((await sentTo(from)).length, 1);
  assert.equal((await waEvents(shop)).length, 2);
  assert.equal((await sql(world, `SELECT 1 FROM inbox_messages WHERE tenant_id = $1 AND mid = $2`, [shop.tenantId, older])).length, 1);
});
