// The WhatsApp add-on's sends go only through the compliance gate (PRD 6.12): a template needs a live opt-in for its
// purpose (wa.no_optin), free-form needs the 24 hour window (window.closed), an opt-out stops either, and with the add-on
// off nothing goes. The app runs without a worker, so compliance.send() decides and sends inline. Track whatsapp-addon.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { whatsappRoutes } from '../../../src/contracts/api/addons.js';
import { withTenant } from '../../../src/tenancy.js';
import { createWhatsApp } from '../../../tools/sim/whatsapp/index.mjs';
import { startApp } from '../../helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
let wa;
let app;
let phoneId;
let serial = 0;

before(async () => {
  wa = createWhatsApp();
  await wa.start();
  app = await startApp({ overrides: { whatsappBaseUrl: wa.url, whatsappAppSecret: wa.appSecret } });
  phoneId = `7${crypto.randomInt(100_000_000, 999_999_999)}`;
  await app.db.platform.query(`INSERT INTO whatsapp_accounts (tenant_id, waba_id, phone_number_id, display_number, access_token_enc, status, display_name) VALUES ($1, 'waba1', $2, '+919800000000', $3, 'active', 'Test store')`, [app.tenant.id, phoneId, app.ctx.platform.secrets.encrypt('sim-whatsapp-token')]);
  await setFeature(true);
});
after(async () => {
  app?.close();
  await wa?.close();
});

const setFeature = (enabled) => app.db.platform.query(`INSERT INTO tenant_features (tenant_id, feature, enabled, limit_value) VALUES ($1, 'whatsapp_automation', $2, NULL) ON CONFLICT (tenant_id, feature) DO UPDATE SET enabled = EXCLUDED.enabled`, [app.tenant.id, enabled]);
const number = () => `9198${String(1_000_000 + ++serial).padStart(8, '0')}`;
const hashOf = (to) => withTenant(app.tenant, () => app.platform.compliance.subjectHash('whatsapp', to));
const run = (action) => withTenant(app.tenant, () => app.ctx.compliance.send(action));
const sentTo = async (to) => (await wa.get('/sent')).sent.filter((m) => m.to === to);
const action = (to, message) => ({ channel: 'whatsapp', kind: 'dm', accountId: phoneId, recipientId: to, personId: to, idempotencyKey: `wa:${crypto.randomUUID()}`, expiresAt: new Date(Date.now() + 3_600_000), message });
const template = (to, purpose = 'marketing') => action(to, { text: 'New arrivals this week', template: { name: 'new_arrivals', language: 'en', params: [], purpose } });
const optIn = async (to, purpose, withdrawn = false) => app.db.platform.query(`INSERT INTO whatsapp_optins (tenant_id, phone_hash, purpose, source, withdrawn_at) VALUES ($1, $2, $3, 'checkout', $4)`, [app.tenant.id, await hashOf(to), purpose, withdrawn ? new Date() : null]);
async function openWindow(to, at = new Date()) {
  await app.db.platform.query(
    `INSERT INTO inbox_threads (tenant_id, channel, wa_phone_number_id, subject_hash, recipient_id, last_user_message_at, last_message_at) VALUES ($1, 'whatsapp', $2, $3, $4, $5::timestamptz, $5::timestamptz)
     ON CONFLICT (tenant_id, channel, subject_hash) DO UPDATE SET last_user_message_at = EXCLUDED.last_user_message_at`,
    [app.tenant.id, phoneId, await hashOf(to), to, at],
  );
}

test('A-62: a template the business starts goes only to a number with a live opt-in for that purpose, at this business', async () => {
  const to = number();
  assert.equal((await run(template(to))).reason, 'wa.no_optin', 'no opt-in at all');
  await optIn(to, 'order_updates');
  assert.equal((await run(template(to))).reason, 'wa.no_optin', 'an order-updates opt-in is not a marketing one');
  const other = await app.platform.tenants.create({ slug: `wa-other-${crypto.randomUUID().slice(0, 8)}`, name: 'Other', plan: 't1' });
  const foreign = await withTenant(other, () => app.platform.compliance.subjectHash('whatsapp', to));
  await app.db.platform.query(`INSERT INTO whatsapp_optins (tenant_id, phone_hash, purpose, source) VALUES ($1, $2, 'marketing', 'checkout')`, [other.id, foreign]);
  assert.equal((await run(template(to))).reason, 'wa.no_optin', 'another business’s opt-in');
  assert.deepEqual(await sentTo(to), [], 'nothing was sent');

  const yes = number();
  await optIn(yes, 'marketing');
  const sent = await run(template(yes));
  assert.equal(sent.outcome, 'sent', JSON.stringify(sent));
  const [message] = await sentTo(yes);
  assert.equal(message.body.type, 'template');
  assert.equal(message.body.template.name, 'new_arrivals');
  // An order update needs its own opt-in, and a withdrawn marketing one counts for nothing.
  assert.equal((await run(template(yes, 'order_updates'))).reason, 'wa.no_optin');
  const withdrawn = number();
  await optIn(withdrawn, 'marketing', true);
  assert.equal((await run(template(withdrawn))).reason, 'wa.no_optin');
});

test('an opt-out stops a template even with a live opt-in, and free-form text needs the 24 hour window', async () => {
  const to = number();
  await optIn(to, 'marketing');
  await app.db.platform.query(`INSERT INTO opt_outs (tenant_id, channel, subject_hash, source) VALUES ($1, 'whatsapp', $2, 'dm')`, [app.tenant.id, await hashOf(to)]);
  assert.equal((await run(template(to))).reason, 'optout');

  const quiet = number();
  assert.equal((await run(action(quiet, { text: 'Hello again' }))).reason, 'window.closed', 'never wrote');
  await openWindow(quiet, new Date(Date.now() - 25 * 3_600_000));
  assert.equal((await run(action(quiet, { text: 'Hello again' }))).reason, 'window.closed', 'wrote 25 hours ago');
  assert.deepEqual(await sentTo(quiet), []);
  await openWindow(quiet, new Date(Date.now() - 3_600_000));
  const inside = await run(action(quiet, { text: 'Here is the link: https://shop.example/p/1' }));
  assert.equal(inside.outcome, 'sent', JSON.stringify(inside));
  const [message] = await sentTo(quiet);
  assert.equal(message.body.type, 'text');
  assert.equal(message.phoneId, phoneId);
});

test('with the add-on off nothing goes on WhatsApp: a send is held, as for a number that needs reconnecting', async () => {
  const to = number();
  await openWindow(to);
  await setFeature(false);
  try {
    const held = await run(action(to, { text: 'Hello' }));
    assert.deepEqual([held.outcome, held.reason], ['held', 'paused.reconnect']);
    assert.deepEqual(await sentTo(to), []);
  } finally {
    await setFeature(true);
  }
});

test('there is no broadcast path: no console route sends, and only the gate’s channel calls the WhatsApp send functions', async () => {
  assert.deepEqual(Object.keys(whatsappRoutes).sort(), ['whatsapp.connectFinish', 'whatsapp.connectStart', 'whatsapp.disconnect', 'whatsapp.keywords', 'whatsapp.optins', 'whatsapp.saveKeywords', 'whatsapp.status']);
  const dir = path.join(ROOT, 'src/modules/whatsapp-automation');
  for (const file of fs.readdirSync(dir)) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    const calls = /\.(sendText|sendTemplate)\(/.test(source);
    assert.equal(calls, file === 'channel.js', `${file} ${calls ? 'calls' : 'does not call'} the WhatsApp send API`);
    if (file !== 'channel.js') assert.doesNotMatch(source, /providers\.whatsapp\.platform/, `${file} must not use Bhava’s own number`);
  }
});
