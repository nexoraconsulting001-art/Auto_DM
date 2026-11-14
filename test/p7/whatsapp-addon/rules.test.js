// The WhatsApp add-on (PRD 6.12) end to end: the WhatsApp simulator delivers signed webhooks to the app, the worker sends
// through the compliance gate, and the simulator records what a shopper would receive. The window, opt-outs, the add-on switch, signup and pauses. Track whatsapp-addon.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { json, need, one, openBillingWorld, shopOn, sql, unique } from '../spec-p7/support.js';
import { HOUR, bodyOf, delivery, feature, hash, inbound, keywordsFor, linkSet, post, sentTo, shopper, threadOf, useWorld, waShop } from './support.js';

let world;
before(async () => {
  world = await openBillingWorld({ overrides: { whatsappAppId: 'sim-wa-app', whatsappSignupConfigId: 'sim-wa-config' } });
  useWorld(world, { numbers: 4_000_000 });
});
after(async () => {
  await world?.close();
});

test('A-63: outside the 24 hour window nothing free-form goes: a late delivery and a reply that waited 30 hours both end in window.closed', async () => {
  const shop = await waShop();
  await keywordsFor(shop, [linkSet('saree', 'https://late.example/saree')]);
  const late = shopper();
  await inbound(shop, late, 'saree', { at: Date.now() - 25 * HOUR });
  await shop.settle();
  assert.equal((await sentTo(late)).length, 0, 'a message 25 hours old gets no free-form reply');
  assert.ok((await sql(world, `SELECT 1 FROM compliance_events WHERE tenant_id = $1 AND channel = 'whatsapp' AND reason = 'window.closed' AND subject = $2`, [shop.tenantId, await hash(shop, late)])).length >= 1);

  const waited = shopper();
  world.stopWorker();
  try {
    await inbound(shop, waited, 'saree');
    await world.travel(30 * HOUR);
  } finally {
    world.startWorker();
  }
  await shop.settle();
  assert.equal((await sentTo(waited)).length, 0);
  const jobs = await shop.jobs(`channel = 'whatsapp' AND subject_hash = $2`, [await hash(shop, waited)]);
  assert.deepEqual(jobs.map((j) => j.reason), ['window.closed']);
});

test('A-64: STOP and the other opt-out words stop marketing at once, once; order-update opt-ins stay; START brings the person back', async () => {
  const shop = await waShop();
  await keywordsFor(shop, [linkSet('saree', 'https://stop.example/saree')]);
  const from = shopper();
  const subject = await hash(shop, from);
  await sql(world, `INSERT INTO whatsapp_optins (tenant_id, phone_hash, purpose, source) VALUES ($1, $2, 'marketing', 'checkout'), ($1, $2, 'order_updates', 'checkout')`, [shop.tenantId, subject]);
  await inbound(shop, from, 'Nonstop saree offers please');
  await shop.settle();
  assert.equal((await sql(world, `SELECT 1 FROM opt_outs WHERE tenant_id = $1 AND channel = 'whatsapp'`, [shop.tenantId])).length, 0, 'a word inside a sentence is not STOP');
  assert.equal((await sentTo(from)).length, 1, 'that was a keyword');

  for (const text of ['STOP', ' Stop. ', 'unsubscribe']) await inbound(shop, from, text);
  await shop.settle();
  assert.equal((await sql(world, `SELECT 1 FROM opt_outs WHERE tenant_id = $1 AND channel = 'whatsapp' AND subject_hash = $2`, [shop.tenantId, subject])).length, 1);
  const rows = await sql(world, `SELECT purpose, withdrawn_at FROM whatsapp_optins WHERE tenant_id = $1 AND phone_hash = $2 ORDER BY purpose`, [shop.tenantId, subject]);
  assert.deepEqual(rows.map((r) => [r.purpose, Boolean(r.withdrawn_at)]), [['marketing', true], ['order_updates', false]]);
  const after = await sentTo(from);
  assert.equal(after.length, 2, 'one confirmation, however many times they said it');
  assert.doesNotMatch(bodyOf(after[1]), /bhava/i);

  await inbound(shop, from, 'saree');
  await shop.settle();
  assert.equal((await sentTo(from)).length, 2, 'nothing more after STOP');
  const list = json(need(await shop.send('GET', '/whatsapp/optins?purpose=marketing'), 200, 'Opt-ins'));
  assert.equal(list.items.length, 1);
  assert.ok(list.items[0].withdrawnAt);
  assert.doesNotMatch(JSON.stringify(list), new RegExp(`${from}|${subject}`));

  await inbound(shop, from, 'start');
  await shop.settle();
  assert.equal((await sql(world, `SELECT 1 FROM opt_outs WHERE tenant_id = $1 AND channel = 'whatsapp' AND subject_hash = $2`, [shop.tenantId, subject])).length, 0);
  assert.equal((await one(world, `SELECT withdrawn_at FROM whatsapp_optins WHERE tenant_id = $1 AND phone_hash = $2 AND purpose = 'marketing'`, [shop.tenantId, subject])).withdrawn_at, null);
  await inbound(shop, from, 'saree');
  await shop.settle();
  assert.equal((await sentTo(from)).length, 3, 'answered again');
  // The opt-in list pages without losing anyone.
  const more = await waShop();
  for (let i = 0; i < 3; i++) await sql(world, `INSERT INTO whatsapp_optins (tenant_id, phone_hash, purpose, source, opted_in_at) VALUES ($1, $2, 'marketing', 'import', '2026-01-01T00:00:00Z')`, [more.tenantId, crypto.randomBytes(32).toString('hex')]);
  const p1 = json(need(await more.send('GET', '/whatsapp/optins?limit=2'), 200, 'Page 1'));
  const p2 = json(need(await more.send('GET', `/whatsapp/optins?limit=2&cursor=${p1.nextCursor}`), 200, 'Page 2'));
  assert.equal(new Set([...p1.items, ...p2.items].map((i) => i.id)).size, 3);
  assert.equal(p2.nextCursor, null);
});

test('with the add-on off, messages are stored for the inbox and nothing is sent; a reply queued before it lapsed is held', async () => {
  const shop = await waShop();
  await keywordsFor(shop, [linkSet('saree', 'https://off.example/saree')]);
  await feature(shop, false);
  const from = shopper();
  await inbound(shop, from, 'saree');
  await inbound(shop, from, 'STOP');
  await shop.settle();
  assert.ok(await threadOf(shop, from), 'in the inbox');
  assert.equal((await sentTo(from)).length, 0, 'no reply and no confirmation');
  assert.equal((await shop.jobs(`channel = 'whatsapp'`)).length, 0);
  assert.equal((await sql(world, `SELECT 1 FROM opt_outs WHERE tenant_id = $1 AND channel = 'whatsapp'`, [shop.tenantId])).length, 1, 'the opt-out still counts');

  await feature(shop, true);
  const queued = shopper();
  world.stopWorker();
  try {
    await inbound(shop, queued, 'saree');
    await feature(shop, false);
  } finally {
    world.startWorker();
  }
  await shop.settle();
  assert.equal((await sentTo(queued)).length, 0);
  const [job] = await shop.jobs(`channel = 'whatsapp' AND subject_hash = $2`, [await hash(shop, queued)]);
  assert.deepEqual([job.status, job.reason], ['held', 'paused.reconnect']);
});

test('A-66: embedded signup takes the owner, the add-on and a state that works once; the seller’s name shows and no token or number id ever does', async () => {
  const shop = await shopOn(world, 't1');
  assert.equal((await shop.send('POST', '/whatsapp/connect')).status, 403, 'not bought');
  await feature(shop);
  const start = json(need(await shop.send('POST', '/whatsapp/connect'), 200, 'Starting'));
  assert.deepEqual([start.appId, start.configId], ['sim-wa-app', 'sim-wa-config']);
  const phoneNumberId = `55${crypto.randomInt(10_000_000, 99_999_999)}`;
  await world.wa.post('/numbers', { phoneId: phoneNumberId, displayName: 'Kesar Silks', displayNumber: '+91 98111 22233' });
  await world.wa.post('/signup/codes', { code: 'code-good-1', token: `tok-${unique()}` });
  const body = { code: 'code-good-1', state: start.state, wabaId: '123456789', phoneNumberId };

  const other = await shopOn(world, 't1');
  await feature(other);
  assert.equal((await other.send('POST', '/whatsapp/connect/finish', body)).status, 400, 'another business’s state');
  const done = json(need(await shop.send('POST', '/whatsapp/connect/finish', body), 200, 'Finishing'));
  assert.deepEqual([done.connected, done.status, done.displayName, done.displayNumber, done.signupReady], [true, 'active', 'Kesar Silks', '+91 98111 22233', true]);
  assert.doesNotMatch(JSON.stringify(done), new RegExp(`${phoneNumberId}|tok-|token|bhava`, 'i'));
  const row = await one(world, 'SELECT * FROM whatsapp_accounts WHERE tenant_id = $1', [shop.tenantId]);
  assert.equal(row.phone_number_id, phoneNumberId);
  assert.doesNotMatch(row.access_token_enc, /tok-/, 'the token is stored encrypted');

  assert.equal((await shop.send('POST', '/whatsapp/connect/finish', body)).status, 400, 'the state works once');
  const again = json(need(await shop.send('POST', '/whatsapp/connect'), 200, 'Again'));
  assert.equal((await shop.send('POST', '/whatsapp/connect/finish', { ...body, state: again.state, code: 'made-up' })).status, 400, 'a made-up code');
  // The same number for a second business is refused.
  const third = json(need(await other.send('POST', '/whatsapp/connect'), 200, 'Other start'));
  await world.wa.post('/signup/codes', { code: 'code-good-2', token: `tok-${unique()}` });
  assert.equal((await other.send('POST', '/whatsapp/connect/finish', { ...body, state: third.state, code: 'code-good-2' })).status, 409);

  // The shopper sees the seller's name; disconnecting stops replies but keeps the inbox.
  shop.phoneId = phoneNumberId;
  await keywordsFor(shop, [linkSet('hi', 'https://kesar.example/new', { message: 'Welcome' })]);
  const from = shopper();
  await inbound(shop, from, 'hi');
  await shop.settle();
  assert.equal((await sentTo(from)).length, 1);
  const profile = await world.wa.get(`/v21.0/${phoneNumberId}`).catch(() => null);
  if (profile) assert.equal(profile.verified_name, 'Kesar Silks');
  need(await shop.send('DELETE', '/whatsapp'), 204, 'Disconnecting');
  const status = json(need(await shop.send('GET', '/whatsapp'), 200, 'Status'));
  assert.deepEqual([status.connected, status.status], [false, 'disabled']);
  await inbound(shop, from, 'hi');
  await shop.settle();
  assert.equal((await sentTo(from)).length, 1, 'a disconnected number answers nothing');
  assert.equal((await sql(world, `SELECT 1 FROM inbox_messages m JOIN inbox_threads t ON t.tenant_id = m.tenant_id AND t.id = m.thread_id WHERE t.tenant_id = $1 AND t.channel = 'whatsapp' AND m.direction = 'in'`, [shop.tenantId])).length, 2, 'the inbox keeps both of the shopper’s messages');
});

test('pauses and the kill switch stop WhatsApp sends like any other', async () => {
  const shop = await waShop();
  await keywordsFor(shop, [linkSet('saree', 'https://pause.example/saree')]);
  await sql(world, `INSERT INTO compliance_settings (tenant_id, subject_salt) VALUES ($1, $2) ON CONFLICT (tenant_id) DO NOTHING`, [shop.tenantId, crypto.randomBytes(24).toString('hex')]);
  await sql(world, `UPDATE compliance_settings SET paused = true WHERE tenant_id = $1`, [shop.tenantId]);
  await world.switchLag();
  const paused = shopper();
  await inbound(shop, paused, 'saree');
  await shop.settle();
  assert.equal((await sentTo(paused)).length, 0);
  assert.deepEqual((await shop.jobs(`channel = 'whatsapp'`)).map((j) => [j.status, j.reason]), [['held', 'paused.tenant']]);

  await sql(world, `UPDATE compliance_settings SET paused = false WHERE tenant_id = $1`, [shop.tenantId]);
  await sql(world, `INSERT INTO platform_switches (key, engaged, reason, engaged_by, engaged_at) VALUES ('global_kill', true, 'test', 'test', now()) ON CONFLICT (key) DO UPDATE SET engaged = true`);
  try {
    await world.switchLag();
    const killed = shopper();
    await inbound(shop, killed, 'saree');
    await shop.settle();
    assert.equal((await sentTo(killed)).length, 0);
    const [job] = await shop.jobs(`channel = 'whatsapp' AND subject_hash = $2`, [await hash(shop, killed)]);
    assert.deepEqual([job.status, job.reason], ['held', 'paused.global']);
  } finally {
    await sql(world, `UPDATE platform_switches SET engaged = false WHERE key = 'global_kill'`);
  }
});
