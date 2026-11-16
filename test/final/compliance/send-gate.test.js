// The compliance gate at send (PRD 4.10 to 4.13): compliance-5 (links without https://), D-8 (a host blocked a moment ago),
// compliance-6 (WhatsApp's own byte limit) and compliance-10 (the breaker alert names the channel that tripped).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WHATSAPP_LIMITS } from '../../../src/contracts/addons.js';
import { createWhatsApp } from '../../../src/adapters/whatsapp/index.js';
import { whatsappChannel } from '../../../src/modules/whatsapp-automation/channel.js';
import { createSecrets } from '../../../src/platform/secrets.js';
import { createWhatsApp as createWhatsAppSim } from '../../../tools/sim/whatsapp/index.mjs';
import { TEST_DATA_KEY } from '../../helpers.js';
import { HOUR, dm, privateReply, uid, world } from '../../p1/compliance/support.js';

const enqueue = (w, action, options) => w.inBusiness(() => w.compliance.enqueue(action, options));
const outcome = (job) => [job.status, job.reason];
const block = (w, host, category = 'phishing') => w.db.platform.query('INSERT INTO link_blocked_hosts (host, category) VALUES ($1, $2) ON CONFLICT DO NOTHING', [host, category]);

test('compliance-5: a shortener, a blocked host or another WhatsApp number written without https:// is stopped at send', async () => {
  const w = await world();
  const host = `bare-${uid('h').toLowerCase()}.example`;
  await block(w, host);
  const cases = [
    ['Buy here bit.ly/x', 'link.shortener'],
    ['Buy at www.bit.ly/x today', 'link.shortener'],
    [`Offer on ${host}/deal`, 'link.blocked'],
    ['Chat on wa.me/911111111111', 'link.not_allowlisted'],
    ['Buy here ｂｉｔ．ｌｙ/x', 'link.shortener'],
  ];
  for (const [text] of cases) await enqueue(w, privateReply(w, { personId: uid('p'), message: { text } }));
  await w.settle();
  assert.equal(w.ig.calls.length, 0, 'nothing reached Instagram');
  assert.deepEqual((await w.jobs()).map(outcome), cases.map(([, reason]) => ['failed', reason]));
});

test('compliance-5: ordinary text with dots and an email address still goes', async () => {
  const w = await world();
  await enqueue(w, privateReply(w, { message: { text: 'Rs.499 only, 2.5kg. Mail a@shop.example or see www.shop.example/p' } }));
  await w.settle();
  assert.equal(w.ig.calls.length, 1);
});

test('D-8: a host blocked after a message to it went out is refused on the very next send, with the clock standing still', async () => {
  const w = await world();
  const host = `later-${uid('h').toLowerCase()}.example`;
  await enqueue(w, privateReply(w, { message: { text: `See https://${host}/a` } }));
  await w.settle();
  assert.equal(w.ig.calls.length, 1, 'allowed before it was blocked');

  await block(w, host);
  await enqueue(w, privateReply(w, { personId: uid('p'), message: { text: `See https://${host}/b` } }));
  await enqueue(w, privateReply(w, { personId: uid('p'), message: { text: `See https://www.${host}/c` } }));
  await w.settle();
  assert.equal(w.ig.calls.length, 1, 'nothing more went to the blocked host');
  assert.deepEqual((await w.jobs()).slice(1).map(outcome), [['failed', 'link.blocked'], ['failed', 'link.blocked']]);
});

/** A business with a WhatsApp number on the real channel over the simulator, and a person who wrote a minute ago. */
async function whatsappWorld(t) {
  const sim = await createWhatsAppSim().start();
  t.after(() => sim.close());
  const w = await world({ fresh: true });
  const secrets = createSecrets({ dataKey: TEST_DATA_KEY });
  const phoneId = `55501${Math.floor(Math.random() * 90000 + 10000)}`;
  await w.db.platform.query(`INSERT INTO whatsapp_accounts (tenant_id, waba_id, phone_number_id, access_token_enc) VALUES ($1, 'WABA-1', $2, $3)`, [w.tenant.id, phoneId, secrets.encrypt('sim-whatsapp-token')]);
  const providers = { whatsapp: createWhatsApp({ whatsappBaseUrl: sim.url, whatsappAppId: 'app-1', whatsappAppSecret: sim.appSecret }, { env: {} }) };
  w.compliance.registerChannel('whatsapp', whatsappChannel({ db: w.db, platform: { secrets }, providers }));
  const person = '919876543210';
  const subject = await w.hash(person, 'whatsapp');
  await w.inTenant(
    `INSERT INTO inbox_threads (tenant_id, channel, wa_phone_number_id, subject_hash, recipient_id, last_user_message_at) VALUES ($1, 'whatsapp', $2, $3, $4, $5::timestamptz)`,
    [w.tenant.id, phoneId, subject, person, new Date(w.clock.t - 60_000)],
  );
  await sim.post('/clock', { now: w.clock.t - 60_000, freeze: true });
  await sim.post('/inbound', { phoneId, from: person, text: 'saree' });
  await sim.post('/clock', { now: w.clock.t, freeze: true });
  const message = (text) => dm(w, { channel: 'whatsapp', accountId: phoneId, recipientId: person, personId: person, idempotencyKey: `dm_reply:${uid('wamid')}`, expiresAt: new Date(w.clock.t + 23 * HOUR), message: { text } });
  return { ...w, sim, message, sent: async () => (await sim.get('/sent')).sent };
}

test('compliance-6: a WhatsApp reply over Instagram\'s 1,000 bytes but inside WhatsApp\'s 4,096 is sent; over 4,096 it is content.too_long', async (t) => {
  const w = await whatsappWorld(t);
  const hindi = `${'साड़ी'.repeat(80)} https://shop.example/r/saree`; // 400 Devanagari characters, about 1,200 bytes
  assert.ok(Buffer.byteLength(hindi) > 1000 && Buffer.byteLength(hindi) <= WHATSAPP_LIMITS.textBytes);
  await enqueue(w, w.message(hindi), { inReplyTo: 'wamid.in1' });
  await w.settle();
  assert.deepEqual((await w.jobs()).map(outcome), [['sent', '']]);
  assert.equal((await w.sent())[0].body.text.body, hindi);

  await enqueue(w, w.message('क'.repeat(1400)), { inReplyTo: 'wamid.in2' }); // 4,200 bytes
  await w.settle();
  assert.deepEqual(outcome((await w.jobs()).at(-1)), ['failed', 'content.too_long']);
  assert.equal((await w.sent()).length, 1);
});

test('compliance-6: an Instagram DM is still held to 1,000 bytes', async () => {
  const w = await world();
  await enqueue(w, privateReply(w, { message: { text: 'साड़ी'.repeat(80) } }));
  await w.settle();
  assert.deepEqual((await w.jobs()).map(outcome), [['failed', 'content.too_long']]);
});

test('compliance-10: a tripped WhatsApp breaker tells the seller WhatsApp is paused, not Instagram', async () => {
  const w = await world();
  for (const channel of ['whatsapp', 'facebook', 'instagram']) await w.inBusiness(() => w.compliance.breaker.trip(channel, 'test'));
  const messages = Object.fromEntries((await w.alerts()).map((a) => [a.target, a.message]));
  assert.match(messages.whatsapp, /^Sending on WhatsApp is paused/);
  assert.match(messages.facebook, /^Sending on Facebook is paused/);
  assert.match(messages.instagram, /^Sending on Instagram is paused/);
});
