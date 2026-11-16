// Regression tests for the other places that shared a root cause with a final compliance attack finding (see docs rca-log):
// lossy numeric ids, account-blind deletion, text compared without folding what the reader can't see, link and public-reply rules
// kept as separate copies, and a WhatsApp sender that skipped the breaker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExternalId, externalId } from '../../../src/contracts/api/common.js';
import { MessagingEvent, SignedRequestPayload, WebhookEntry } from '../../../src/contracts/api/provider.js';
import { createFacebookLogin, createInstagramLogin, createUnifiedLogin } from '../../../src/adapters/meta/index.js';
import { createInsightsReader } from '../../../src/adapters/meta/insights.js';
import { parseMessages, parseStatuses } from '../../../src/adapters/whatsapp/index.js';
import { ProviderError } from '../../../src/adapters/http.js';
import { idOf } from '../../../src/modules/shopify-sync/products.js';
import { matchesKeywords } from '../../../src/modules/automations/match.js';
import { hasNegativeIntent, isOptOut, isStart, wantsHuman } from '../../../src/modules/compliance/words.js';
import { checkContent, checkPublicReply, linksIn } from '../../../src/modules/compliance/content.js';
import { checkDraft } from '../../../src/modules/ai-replies/rules.js';
import { brandKitRepo } from '../../../src/modules/brand/repo.js';
import { ValidationError } from '../../../src/util.js';
import { createShopperMessages } from '../../../src/modules/shopper-messages/index.js';
import { createSecrets } from '../../../src/platform/secrets.js';
import { TEST_DATA_KEY } from '../../helpers.js';
import { world } from '../../p1/compliance/support.js';
import { IG_A, IG_B, connected, consent, seedIg, startSlice, until } from '../../p1/review-slice/support.js';

/** A's id as a JSON number: JSON.parse rounds it onto B's. */
const A = '17841400000000011';
const ROUNDED = String(JSON.parse(A));

/** Answers every fetch from a table of path endings to raw JSON text, so an answer can carry a bare number past 2^53. */
async function withRawFetch(answers, run) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    const key = Object.keys(answers).sort((x, y) => y.length - x.length).find((end) => path.endsWith(end));
    if (!key) throw new Error(`unexpected call to ${path}`);
    return new Response(answers[key], { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

// ---- ids past 2^53 -------------------------------------------------------------------------------------------------

test('same cause: ExternalId keeps text and exact numbers and refuses a number JSON has rounded', () => {
  assert.equal(ROUNDED !== A, true, 'the premise');
  assert.equal(ExternalId.parse(A), A);
  assert.equal(ExternalId.parse(1784), '1784');
  for (const bad of [JSON.parse(A), 2 ** 53, 1.5, -1, '', NaN]) assert.equal(externalId(bad), null, String(bad));
  assert.equal(WebhookEntry.safeParse(JSON.parse(`{"id":${A}}`)).success, false);
  assert.equal(SignedRequestPayload.safeParse(JSON.parse(`{"algorithm":"HMAC-SHA256","user_id":${A}}`)).success, false);
  assert.equal(MessagingEvent.safeParse(JSON.parse(`{"sender":{"id":${A}},"recipient":{"id":"1"},"timestamp":1}`)).success, false);
});

test('same cause: an Instagram Login answer whose user_id is a bare number past 2^53 never connects the rounded account', async () => {
  const login = createInstagramLogin({ graphBaseUrl: 'http://127.0.0.1:9', igAppId: 'app', appSecret: 'secret' });
  const answers = (userId) => ({
    '/oauth/access_token': `{"access_token":"short","user_id":${userId},"permissions":"instagram_business_basic"}`,
    '/access_token': '{"access_token":"long","expires_in":5000}',
    '/me': `{"id":"9","user_id":${userId},"username":"shop"}`,
  });
  await withRawFetch(answers(A), () => assert.rejects(() => login.connect({ code: 'c', redirectUri: 'http://127.0.0.1:9/cb' }), (err) => err.kind === 'malformed'));
  const exact = await withRawFetch(answers(`"${A}"`), () => login.connect({ code: 'c', redirectUri: 'http://127.0.0.1:9/cb' }));
  assert.equal(exact.igUserId, A, 'an id sent as text is kept exactly');
});

test('same cause: Unified Login and Facebook Pages never take a Page\'s Instagram id that JSON has rounded', async () => {
  const config = { graphBaseUrl: 'http://127.0.0.1:9', fbAppId: 'fb', fbAppSecret: 'secret', metaLogin: 'unified' };
  const answers = {
    '/oauth/access_token': '{"access_token":"user","expires_in":5000}',
    '/me/accounts': `{"data":[{"id":"page-1","name":"Shop","access_token":"pt","instagram_business_account":{"id":${A},"username":"shop"}}]}`,
    '/me/permissions': '{"data":[]}',
  };
  await withRawFetch(answers, () => assert.rejects(() => createUnifiedLogin(config).connect({ code: 'c', redirectUri: 'http://127.0.0.1:9/cb' }), /No Facebook Page/));
  const fb = await withRawFetch(answers, () => createFacebookLogin(config).connect({ code: 'c', redirectUri: 'http://127.0.0.1:9/cb' }));
  assert.deepEqual(fb.pages.map((p) => p.igUserId), [''], 'the Page is listed with no Instagram account rather than the rounded one');
});

test('same cause: a WhatsApp delivery whose phone_number_id or sender is a bare number past 2^53 is routed nowhere', () => {
  const body = JSON.parse(`{"entry":[{"changes":[{"value":{"metadata":{"phone_number_id":${A}},"messages":[{"id":"wamid.1","from":"919876543210","type":"text","text":{"body":"hi"},"timestamp":"1"}],"statuses":[{"id":"wamid.2","status":"sent","timestamp":"1"}]}}]}]}`);
  assert.deepEqual(parseMessages(body), [], 'no message for the business whose number it rounds to');
  assert.deepEqual(parseStatuses(body).map((s) => s.phoneNumberId), ['']);
  const exact = JSON.parse(`{"entry":[{"changes":[{"value":{"metadata":{"phone_number_id":"${A}"},"messages":[{"id":"wamid.1","from":"919876543210","type":"text","text":{"body":"hi"},"timestamp":"1"}]}}]}]}`);
  assert.deepEqual(parseMessages(exact).map((m) => m.phoneNumberId), [A]);
});

test('same cause: Shopify ids and Instagram media ids past 2^53 are refused, not rounded onto a neighbour', async () => {
  assert.equal(idOf(JSON.parse(A)), null);
  assert.equal(idOf(A), A);
  assert.equal(idOf(8_123_456_789_012), '8123456789012');
  const graph = async () => ({ data: JSON.parse(`{"data":[{"id":${A},"media_type":"VIDEO"},{"id":"1790","media_type":"IMAGE"}]}`), usage: null });
  const reader = createInsightsReader({ owner: 'me', graph }, { check: async () => ({ allow: true }), observe: async () => {} });
  assert.deepEqual((await reader.mediaPage()).items.map((m) => m.id), ['1790']);
});

// ---- deletion: only the deleted account stops ---------------------------------------------------------------------

test('same cause: a deletion request for the account a business switched away from leaves the live account\'s automations running', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice, IG_A);
  await seedIg(slice.sim, IG_B);
  assert.equal((await consent(slice, business, { igUserId: IG_B })).outcome, 'connected');
  const tenant = business.tenant.id;
  const [automation] = await slice.q(`INSERT INTO automations (tenant_id, name, slug, state, trigger_type) VALUES ($1, 'B reel', 'b-reel-2', 'live', 'comment') RETURNING id`, [tenant]);
  await slice.q(`INSERT INTO automation_triggers (tenant_id, automation_id, channel, target_type, media_id) VALUES ($1, $2, 'instagram', 'reel', 'media-of-b')`, [tenant, automation.id]);

  await slice.sim.post('/deletion', { igUserId: IG_A });
  await until(async () => (await slice.q('SELECT status FROM data_deletion_requests'))[0]?.status === 'completed');

  const [state] = await slice.q('SELECT state FROM automations WHERE id = $1', [automation.id]);
  assert.equal(state.state, 'live', 'a deletion for the old account paused the live account\'s automation');
  const [b] = await slice.q('SELECT access_token_enc <> \'\' AS has_token FROM ig_accounts WHERE tenant_id = $1 AND ig_user_id = $2', [tenant, IG_B]);
  assert.equal(b.has_token, true, 'the live account keeps its token');
  assert.deepEqual(await slice.q('SELECT ig_user_id FROM ig_accounts WHERE tenant_id = $1 AND ig_user_id = $2', [tenant, IG_A]), [], 'the deleted account is gone');
});

// ---- what the reader sees -----------------------------------------------------------------------------------------

test('same cause: keywords, negative words, handoff and START read text as the reader sees it; punctuation still counts', () => {
  assert.equal(matchesKeywords('ＬＩＮＫ please', ['link']), true, 'full-width keyword');
  assert.equal(matchesKeywords('LI​NK', ['link']), true, 'zero-width space inside a keyword');
  assert.equal(hasNegativeIntent('I want a re​fund'), true);
  assert.equal(hasNegativeIntent('‏ｓｃａｍ'), true);
  assert.equal(wantsHuman('ｈｕｍａｎ'), true);
  assert.equal(isStart('ＳＴＡＲＴ​'), true);
  assert.equal(isOptOut('stop.'), false, 'punctuation still makes it a sentence, not the word');
  assert.equal(isOptOut('please stop'), false);
  assert.equal(matchesKeywords('❤️', ['❤']), true, 'emoji style selectors still never decide a match');
});

// ---- one link rule, one public-reply rule ----------------------------------------------------------------------------

test('same cause: a host right after a colon is a link everywhere links are read', () => {
  assert.deepEqual(linksIn('Link:bit.ly/x'), ['https://bit.ly/x']);
  assert.deepEqual(linksIn('Shop now:bit.ly/sale'), ['https://bit.ly/sale']);
  assert.deepEqual(linksIn('mailto:a@shop.example'), [], 'an email address is still not a link');
  assert.deepEqual(linksIn('Time:10.30 pm, Rs.499'), []);
});

test('same cause: an AI draft can\'t carry a host with an ending the old list did not know', () => {
  const draft = { draft: 'Delivery in 3 to 5 days. See myshop.club/deal', sources: ['faq:1'], confidence: 0.95, usage: { units: 1 }, model: 'm' };
  const verdict = checkDraft(draft, { faq: [{ id: 1, question: 'How long does delivery take?', answer: 'Delivery in 3 to 5 days.' }], products: [], question: 'delivery?', models: ['m'] });
  assert.equal(verdict.ok ? 'ok' : verdict.why, 'link');
});

test('same cause: brand phrases are refused in DMs; the Hinglish price "bhava" is not (C-61)', () => {
  for (const text of ['Shop at Bhava today', 'Our Bhava-powered store is live', 'Follow #BhavaApp for more', 'Get it at bhava dot app', 'bhava(dot)in', '#getbhava']) {
    assert.deepEqual(checkContent({ text }).map((p) => p.reason), ['content.bhava_promo'], text);
  }
  for (const text of ['sahi bhava pe milega', 'is bhava mein nahi milega', 'mandi ke bhava se sasta']) assert.deepEqual(checkContent({ text }), [], text);
});

test('same cause: the brand kit refuses at save every public reply the send path refuses', async () => {
  const w = await world();
  const fine = ['Thank you!', 'Sent you a DM', 'Check your messages', 'Glad you like it', 'Love this!'];
  const repo = brandKitRepo(w.db.platform);
  for (const bad of ['Sale on myshop.xyz/sale', 'Call ९८७६५४३२१० now', 'Just 499 rupees today', 'Price: 499 only', 'Link:bit.ly/x', 'Shop at Bhava today']) {
    assert.ok(checkPublicReply(bad).length, `send path lets through: ${bad}`);
    await assert.rejects(() => w.inBusiness(() => repo.save({ publicReplyVariants: [...fine, bad] })), (err) => err instanceof ValidationError && /public reply/i.test(err.message), `saved: ${bad}`);
  }
  for (const ok of fine) assert.deepEqual(checkPublicReply(ok), [], ok);
});

// ---- the WhatsApp breaker closes again on a shopper message's probe ---------------------------------------------------------

test('same cause: once the WhatsApp breaker\'s wait is over, one order update goes as its probe and closes it; a failed probe keeps it open', async () => {
  const w = await world({ fresh: true });
  const secrets = createSecrets({ dataKey: TEST_DATA_KEY });
  const sends = [];
  let fail = false;
  const whatsapp = {
    sendTemplate: async (account, message) => {
      if (fail) throw new ProviderError({ provider: 'whatsapp', kind: 'server', status: 500, delivery: 'none' });
      sends.push(message);
      return { messageId: `wamid.${sends.length}` };
    },
  };
  const gate = createShopperMessages({ db: w.db, platform: { consent: { allows: async () => ({ granted: true }) }, secrets }, providers: { whatsapp }, config: {}, compliance: w.compliance });
  await w.db.platform.query(`INSERT INTO whatsapp_accounts (tenant_id, waba_id, phone_number_id, access_token_enc) VALUES ($1, 'WABA-P', $2, $3)`, [w.tenant.id, `8${w.tenant.id}00003`, secrets.encrypt('t')]);
  await w.inTenant(`INSERT INTO whatsapp_templates (tenant_id, purpose, category, name, status) VALUES ($1, 'order_shipped', 'utility', 'order_shipped', 'approved')`, [w.tenant.id]);
  const update = { channel: 'whatsapp', purpose: 'order_update', to: { phone: '+91 98765 43210' }, template: { purpose: 'order_shipped', params: ['#1001'] } };
  const breakerState = async () => (await w.db.platform.query(`SELECT state FROM breakers WHERE tenant_id = $1 AND channel = 'whatsapp'`, [w.tenant.id]))[0]?.state;
  const send = async () => {
    w.compliance.invalidateSwitches();
    return w.inBusiness(() => gate.send(update));
  };

  await w.inBusiness(() => w.compliance.breaker.trip('whatsapp', 'policy'));
  assert.equal((await send()).reason, 'paused.breaker');
  assert.equal((await w.inBusiness(() => gate.check(update))).reason, 'paused.breaker', 'check() never takes the probe');

  w.clock.advance(31 * 60_000);
  fail = true;
  assert.equal((await send()).outcome, 'failed', 'the probe went and failed');
  assert.equal(await breakerState(), 'open', 'a failed probe reopens the breaker');
  assert.equal((await send()).reason, 'paused.breaker', 'and the next update waits again');

  w.clock.advance(61 * 60_000);
  fail = false;
  assert.equal((await send()).outcome, 'sent', 'the probe after the doubled wait');
  assert.equal(await breakerState(), 'closed', 'a delivered probe closes the breaker');
  assert.equal((await send()).outcome, 'sent');
  assert.equal(sends.length, 2);
});
