// Final attack pass on the compliance area (PRD 4.1 to 4.16): real HTTP against the real app, the Meta simulator for the
// outside world, real concurrency and hostile input. A failing test here is a bug; a passing one stays as hardening.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createCompliance } from '../../../src/modules/compliance/index.js';
import { createShopperMessages } from '../../../src/modules/shopper-messages/index.js';
import { createSecrets } from '../../../src/platform/secrets.js';
import { withTenant } from '../../../src/tenancy.js';
import { TEST_DATA_KEY, startApp } from '../../helpers.js';
import { HOUR, comment, inMessage, privateReply, scriptedIg, uid, world } from '../../p1/compliance/support.js';
import { IG_A, IG_B, addJob, connected, consent, seedIg, startSlice, until } from '../../p1/review-slice/support.js';

const SECRET = 'secret'; // the app secret startApp configures
const sign = (raw, secret = SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
const postRaw = (app, raw, headers = {}) => fetch(`${app.base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw), ...headers }, body: raw });
/** Meta's signed_request over the exact JSON text given, so a test can put a bare number where Meta would put an id. */
const signedRaw = (json, secret = SECRET) => {
  const encoded = Buffer.from(json, 'utf8').toString('base64url');
  return `${crypto.createHmac('sha256', secret).update(encoded).digest('base64url')}.${encoded}`;
};
const postForm = (app, path, fields) => fetch(`${app.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
const enqueue = (w, action, options) => w.inBusiness(() => w.compliance.enqueue(action, options));
const deliver = async (w, body) => {
  await w.compliance.storeDelivery(body);
  return w.compliance.drainInbound();
};

/** Two businesses on one app whose Instagram ids differ only past 2^53, so a lossy number lands on the other one. */
async function twoNeighbours(app) {
  const ids = { a: '17841400000000011', b: '17841400000000012' };
  assert.equal(String(JSON.parse(ids.a)), ids.b, 'the premise: as a JSON number, A\'s id reads as B\'s');
  const out = {};
  for (const [key, igUserId] of Object.entries(ids)) {
    const tenant = await app.platform.tenants.create({ slug: `nb-${key}-${process.pid}`, name: `Neighbour ${key}` });
    await app.platform.tenants.linkIgAccount(tenant.id, igUserId, `nb${key}`);
    await withTenant(tenant, () => app.platform.igAccounts.setToken(igUserId, `token-${key}`));
    out[key] = { tenant, igUserId };
  }
  return out;
}

// ---- tenancy: ids past 2^53 ----------------------------------------------------------------------------------------

test('atk: a signed delivery whose entry.id is a bare number past 2^53 is never routed to the business whose id it rounds to', async () => {
  const app = await startApp({ ig: scriptedIg(), overrides: { complianceInline: false } });
  try {
    const { a, b } = await twoNeighbours(app);
    const raw = `{"object":"instagram","entry":[{"id":${a.igUserId},"time":1,"changes":[{"field":"comments","value":{"id":"c-num-1","text":"LINK","from":{"id":"p-num"},"media":{"id":"M1"}}}]}]}`;
    const res = await postRaw(app, raw);
    assert.ok([200, 400].includes(res.status), `answered ${res.status}`);
    const rows = await app.db.platform.query(`SELECT tenant_id, account_id FROM inbound_events WHERE object_id = 'c-num-1'`);
    assert.deepEqual(rows.filter((r) => Number(r.tenant_id) === Number(b.tenant.id)), [], `A's comment was stored for business B: ${JSON.stringify(rows)}`);
  } finally {
    app.close();
  }
});

test('atk: a signed deletion request whose user_id is a bare number past 2^53 never deletes the neighbouring business\'s token', async () => {
  const app = await startApp({ ig: scriptedIg(), overrides: { complianceInline: false } });
  try {
    const { a, b } = await twoNeighbours(app);
    const res = await postForm(app, '/meta/deletion', { signed_request: signedRaw(`{"algorithm":"HMAC-SHA256","issued_at":1700000000,"user_id":${a.igUserId}}`) });
    assert.ok([200, 400].includes(res.status), `answered ${res.status}`);
    const [row] = await app.db.platform.query('SELECT access_token_enc, status FROM ig_accounts WHERE ig_user_id = $1', [b.igUserId]);
    assert.ok(row?.access_token_enc, `business B lost its Instagram token to a request about A: ${JSON.stringify({ status: row?.status })}`);
  } finally {
    app.close();
  }
});

test('atk: hostile deletion and deauthorize bodies are a 400 and change nothing', async () => {
  const app = await startApp({ ig: scriptedIg(), overrides: { complianceInline: false } });
  try {
    const { a } = await twoNeighbours(app);
    const good = signedRaw(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: a.igUserId }));
    const bodies = [
      'signed_request=',
      `signed_request=${'x'.repeat(200_000)}`,
      `signed_request=${encodeURIComponent(`${good}\0`)}`,
      `signed_request[]=${encodeURIComponent(good)}&signed_request[]=x`,
      `signed_request=${encodeURIComponent(signedRaw(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: a.igUserId }), 'wrong'))}`,
      `signed_request=${encodeURIComponent(signedRaw(JSON.stringify({ algorithm: 'none', user_id: a.igUserId })))}`,
      `signed_request=${encodeURIComponent(signedRaw(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: '' })))}`,
      `signed_request=${encodeURIComponent(signedRaw(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: { $ne: '' } })))}`,
    ];
    for (const path of ['/meta/deauthorize', '/meta/deletion']) {
      for (const body of bodies) {
        const res = await fetch(`${app.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
        assert.ok(res.status >= 400 && res.status < 500, `${path} answered ${res.status} to a hostile body of ${body.length} bytes`);
      }
    }
    const [row] = await app.db.platform.query('SELECT access_token_enc FROM ig_accounts WHERE ig_user_id = $1', [a.igUserId]);
    assert.ok(row.access_token_enc, 'the token survived');
    assert.deepEqual(await app.db.platform.query('SELECT id FROM data_deletion_requests'), []);
  } finally {
    app.close();
  }
});

// ---- deletion: one account's request must not wipe another account's compliance state ---------------------------

test('atk: a deletion request for the account a business switched away from leaves the live account\'s caps and triggers alone', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice, IG_A);
  await seedIg(slice.sim, IG_B);
  const switched = await consent(slice, business, { igUserId: IG_B });
  assert.equal(switched.outcome, 'connected', 'the business now runs on account B');
  const tenant = business.tenant.id;
  const [live] = await slice.q('SELECT ig_user_id, access_token_enc <> \'\' AS has_token FROM ig_accounts WHERE tenant_id = $1 ORDER BY ig_user_id', [tenant]);
  assert.ok(live, 'accounts are there');

  // Account B's own history: a live automation on B's reel and the per-media cap a DM to a person on it claimed.
  const [automation] = await slice.q(`INSERT INTO automations (tenant_id, name, slug, state, trigger_type) VALUES ($1, 'B reel', 'b-reel', 'live', 'comment') RETURNING id`, [tenant]);
  await slice.q(`INSERT INTO automation_triggers (tenant_id, automation_id, channel, target_type, media_id) VALUES ($1, $2, 'instagram', 'reel', 'media-of-b')`, [tenant, automation.id]);
  const jobOfB = await addJob(slice, tenant, IG_B, { status: 'sent' });
  await slice.q(`INSERT INTO cap_claims (tenant_id, channel, cap, subject_hash, scope_key, automation_id, job_id) VALUES ($1, 'instagram', 'cap.per_media', 'subject-b', $2, $3, $4)`, [tenant, `${automation.id}:media-of-b`, automation.id, jobOfB]);

  await slice.sim.post('/deletion', { igUserId: IG_A });
  await until(async () => (await slice.q('SELECT status FROM data_deletion_requests'))[0]?.status === 'completed');

  const caps = await slice.q(`SELECT cap FROM cap_claims WHERE tenant_id = $1 AND job_id = $2`, [tenant, jobOfB]);
  assert.equal(caps.length, 1, 'account B\'s cap.per_media claim was wiped by a deletion for account A: the same person can now be DMed again on B\'s reel');
  const triggers = await slice.q(`SELECT media_id FROM automation_triggers WHERE tenant_id = $1 AND media_id = 'media-of-b'`, [tenant]);
  assert.equal(triggers.length, 1, 'account B\'s reel trigger was deleted by a deletion for account A');
});

// ---- opt-out: what the person sees is STOP --------------------------------------------------------------------

test('atk: a STOP that only differs by invisible marks or full-width letters is still an opt-out', async () => {
  const w = await world();
  const cases = {
    fullwidth: 'ＳＴＯＰ',
    zeroWidthSpace: 'STOP​',
    rightToLeftMark: '‏STOP',
    hindiWithJoiner: 'बंद करो‍',
  };
  const missed = [];
  for (const [name, text] of Object.entries(cases)) {
    const person = uid(`p-${name}`);
    await deliver(w, inMessage(w, { from: person, text }));
    const subject = await w.hash(person);
    if (!(await w.inBusiness(() => w.platform.compliance.isOptedOut('instagram', subject)))) missed.push(name);
  }
  assert.deepEqual(missed, [], `these opt-outs were ignored: ${missed.join(', ')}`);
});

// ---- content and links ------------------------------------------------------------------------------------------

test('atk: a shortener written right after a colon ("Link:bit.ly/x") is still stopped at send', async () => {
  const w = await world();
  await enqueue(w, privateReply(w, { personId: uid('p'), message: { text: 'Link:bit.ly/x' } }));
  await enqueue(w, privateReply(w, { personId: uid('p'), message: { text: 'Shop now:bit.ly/sale' } }));
  await w.settle();
  assert.deepEqual((await w.jobs()).map((j) => [j.status, j.reason]), [['failed', 'link.shortener'], ['failed', 'link.shortener']]);
  assert.equal(w.ig.calls.length, 0, 'a hidden shortener reached Instagram');
});

test('atk: plain brand phrases for the platform never reach a buyer\'s DM', async () => {
  const w = await world();
  const texts = ['Shop at Bhava today', 'Our Bhava-powered store is live', 'Follow #BhavaApp for more', 'Get it at bhava dot app'];
  for (const text of texts) await enqueue(w, privateReply(w, { personId: uid('p'), message: { text } }));
  await w.settle();
  const outcomes = (await w.jobs()).map((j, i) => `${texts[i]} => ${j.status}/${j.reason}`);
  assert.equal(w.ig.calls.length, 0, `platform promotion went out:\n${outcomes.join('\n')}`);
});

// ---- races ----------------------------------------------------------------------------------------------------

test('atk: one comment delivered ten times at once over HTTP is one stored event', async () => {
  const app = await startApp({ ig: scriptedIg(), overrides: { complianceInline: false } });
  try {
    const raw = JSON.stringify({ object: 'instagram', entry: [{ id: 'ME', time: 1, changes: [{ field: 'comments', value: { id: 'c-race-1', text: 'LINK', from: { id: 'p-race' }, media: { id: 'M1' } } }] }] });
    const answers = await Promise.all(Array.from({ length: 10 }, () => postRaw(app, raw)));
    assert.deepEqual([...new Set(answers.map((r) => r.status))], [200]);
    const rows = await app.db.platform.query(`SELECT id FROM inbound_events WHERE object_id = 'c-race-1'`);
    assert.equal(rows.length, 1);
  } finally {
    app.close();
  }
});

test('atk: two inbound workers on one stored comment hand it to the automations once', async () => {
  const w = await world();
  const second = createCompliance({ db: w.db, repos: w.platform, ig: w.ig, config: { complianceNow: w.clock.now, complianceInline: false }, platform: { metrics: { inc() {} } } });
  const seen = [];
  for (const c of [w.compliance, second]) c.onInbound(async (event) => { seen.push(event.commentId); return true; });
  await w.compliance.storeDelivery(w.delivery(comment({ id: 'c-two-workers', text: 'LINK', from: uid('p') })));
  await Promise.all([w.compliance.drainInbound(), second.drainInbound(), w.compliance.drainInbound(), second.drainInbound()]);
  assert.deepEqual(seen, ['c-two-workers']);
});

test('atk: two workers whose clocks disagree by a minute can\'t spend more private replies than any honest minute allows', async () => {
  const w = await world({ fresh: true });
  const behind = createCompliance({
    db: w.db, repos: w.platform, ig: w.ig,
    config: { complianceNow: () => new Date(w.clock.t - 60_000), complianceRandom: () => 0.5, complianceInline: false },
    platform: { metrics: { inc() {} } },
  });
  const runAt = new Date(w.clock.t - 10 * 60_000);
  for (let i = 0; i < 120; i++) await enqueue(w, privateReply(w, { personId: `skew-${i}` }), { runAt });
  // Neither clock moves. Seen from either worker, at most a burst plus a minute of refill may go: 10 + 60 s x 590/3600.
  for (let i = 0; i < 12; i++) {
    await w.compliance.drainOutbound();
    await behind.drainOutbound();
  }
  const sent = w.ig.calls.length;
  assert.ok(sent <= 20, `${sent} private replies went in what is at most one minute of budget (600 an hour allows about 20)`);
});

// ---- the WhatsApp breaker -------------------------------------------------------------------------------------

test('atk: with the business\'s WhatsApp breaker open, no order update goes out on that number', async () => {
  const w = await world({ fresh: true });
  const secrets = createSecrets({ dataKey: TEST_DATA_KEY });
  const sends = [];
  const whatsapp = { sendTemplate: async (account, message) => { sends.push(message); return { messageId: `wamid.${sends.length}` }; } };
  const gate = createShopperMessages({ db: w.db, platform: { consent: { allows: async () => ({ granted: true }) }, secrets }, providers: { whatsapp }, config: {}, compliance: w.compliance });
  await w.db.platform.query(`INSERT INTO whatsapp_accounts (tenant_id, waba_id, phone_number_id, access_token_enc) VALUES ($1, 'WABA-B', $2, $3)`, [w.tenant.id, `8${w.tenant.id}00002`, secrets.encrypt('t')]);
  await w.inTenant(`INSERT INTO whatsapp_templates (tenant_id, purpose, category, name, status) VALUES ($1, 'order_shipped', 'utility', 'order_shipped', 'approved')`, [w.tenant.id]);
  const update = { channel: 'whatsapp', purpose: 'order_update', to: { phone: '+91 98765 43210' }, template: { purpose: 'order_shipped', params: ['#1001'] } };

  assert.equal((await w.inBusiness(() => gate.send(update))).outcome, 'sent', 'the setup sends while the breaker is closed');
  await w.inBusiness(() => w.compliance.breaker.trip('whatsapp', 'policy'));
  w.compliance.invalidateSwitches();
  const answer = await w.inBusiness(() => gate.send(update));
  assert.equal(sends.length, 1, `a message went out on WhatsApp with its breaker open: ${JSON.stringify(answer)}`);
});

// ---- the 24-hour window and expiry under hostile timing ------------------------------------------------------

test('atk: a DM to someone whose last message is exactly 23h50m old is refused, and one second earlier it goes', async () => {
  const w = await world();
  const fresh = uid('p');
  const stale = uid('p');
  await w.messaged(stale, w.clock.t - (23 * HOUR + 50 * 60_000));
  await w.messaged(fresh, w.clock.t - (23 * HOUR + 50 * 60_000) + 1000);
  const dm = (person) => ({ kind: 'dm', accountId: w.igUserId, recipientId: person, personId: person, idempotencyKey: uid('dm'), expiresAt: new Date(w.clock.t + HOUR), message: { text: 'hello' } });
  await enqueue(w, dm(stale));
  await enqueue(w, dm(fresh));
  await w.settle();
  const outcomes = (await w.jobs()).map((j) => [j.recipient_id === stale ? 'stale' : 'fresh', j.status, j.reason]);
  assert.deepEqual(outcomes.sort(), [['fresh', 'sent', ''], ['stale', 'skipped', 'window.closed']].sort());
});

test('atk: an opt-out racing a waiting private reply: it either went before the STOP or was stopped, and one confirmation at most', async () => {
  const w = await world();
  const person = uid('p');
  await w.messaged(person);
  await enqueue(w, privateReply(w, { personId: person }));
  await Promise.all([deliver(w, inMessage(w, { from: person, text: 'STOP' })), w.compliance.drainOutbound()]);
  await w.settle();
  const toPerson = w.ig.calls.filter((c) => c.args[0]?.commentId);
  const jobs = await w.jobs();
  // Either the reply raced out before the STOP was stored (then it was legally sent) or it was cancelled; never both a cancel and a send.
  const reply = jobs.find((j) => j.kind === 'private_reply');
  if (toPerson.length) assert.equal(reply.status, 'sent');
  else assert.ok(['cancelled', 'skipped'].includes(reply.status), JSON.stringify(reply));
  const confirmations = w.ig.calls.filter((c) => c.args[0]?.id === person);
  assert.ok(confirmations.length <= 1, 'one opt-out confirmation at most');
});

// ---- public replies: no links, phone numbers or prices (PRD 4.9) ---------------------------------------------

test('atk: a public reply with a link, a phone number or a price is never posted, whatever its spelling', async () => {
  const w = await world();
  const texts = ['Grab it at amzn.to/deal', 'Sale on myshop.xyz/sale', 'Call ९८७६५४३२१० now', 'Just 499 rupees today', 'See ｂｉｔ．ｌｙ/x'];
  for (const text of texts) {
    const commentId = uid('c');
    await enqueue(w, { kind: 'public_reply', accountId: w.igUserId, commentId, personId: uid('p'), idempotencyKey: `public_reply:${commentId}`, expiresAt: new Date(w.clock.t + HOUR), message: { text } });
  }
  await w.settle();
  const posted = w.ig.calls.filter((c) => c.kind === 'reply').map((c) => c.args[1]);
  assert.deepEqual(posted, [], `posted publicly under a comment: ${JSON.stringify(posted)}`);
});
