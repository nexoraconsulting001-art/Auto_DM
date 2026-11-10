// The builder, testers, ice breakers and the inbox through the seller API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMeta } from '../../../tools/sim/meta/index.mjs';
import { createMetaClient } from '../../../src/adapters/meta/index.js';
import { ApiError } from '../../../src/contracts/api/index.js';
import { ok, refused, secondBusiness, walk, withApp } from '../../p0/admin-api/support.js';
import { IG_ACCOUNT } from '../../helpers.js';

const HOUR = 3_600_000;
const body = (extra = {}) => ({ name: 'Diwali reel', triggerType: 'comment', keywords: ['price'], linkUrl: 'https://seller.test/p', triggers: [{ targetType: 'reel', mediaId: 'R1' }], variants: [{ label: 'A', body: 'Here it is' }], ...extra });
const setPlan = (app, plan, tenant = app.tenant) => app.db.platform.query('UPDATE tenants SET plan = $1 WHERE id = $2', [plan, tenant.id]);
const save = async (app, extra) => ok(await app.api('POST', '/automations', body(extra)), 201);
const paidApp = (run) => withApp(async (app) => {
  await setPlan(app, 't3');
  await run(app);
});

/** What the compliance worker writes when someone sends a DM. */
async function openThread(app, { person = 'P1', at = new Date(), text = 'hello' } = {}) {
  const subject = await app.repos.compliance.subjectHash('instagram', person);
  const [thread] = await app.db.platform.query(
    `INSERT INTO inbox_threads (tenant_id, channel, ig_user_id, subject_hash, recipient_id, username, last_message, last_message_at, last_user_message_at)
     VALUES ($1, 'instagram', $2, $3, $4, 'asha', $5, $6, $6) RETURNING *`,
    [app.tenant.id, IG_ACCOUNT.igUserId, subject, person, text, at],
  );
  await app.db.platform.query(`INSERT INTO inbox_messages (tenant_id, thread_id, direction, author, text, mid, created_at) VALUES ($1, $2, 'in', 'person', $3, $4, $5)`, [app.tenant.id, thread.id, text, `m-${person}-${at.getTime()}`, at]);
  return thread;
}

const needsHuman = async (app, threadId) => (await app.db.platform.query(
  `INSERT INTO needs_human_items (tenant_id, channel, thread_id, kind, reason, text) VALUES ($1, 'instagram', $2, 'handoff', 'thread.handoff', 'human') RETURNING id`,
  [app.tenant.id, threadId],
))[0];

test('A-44: an automation saves with a keyword, a message, a link and no products', withApp(async (app) => {
  await setPlan(app, 't1');
  const saved = await save(app);
  assert.equal(saved.state, 'draft');
  assert.equal(saved.slug, 'diwali-reel');
  assert.equal(saved.finalUrl, 'https://seller.test/p');
  assert.equal(saved.linkMode, 'two_tap');
  assert.deepEqual(saved.triggers.map((t) => [t.channel, t.targetType, t.mediaId]), [['instagram', 'reel', 'R1']]);
  assert.deepEqual(saved.variants.map((v) => [v.label, v.body, v.weight]), [['A', 'Here it is', 1]]);
  assert.deepEqual(saved.warnings.map((w) => w.code), ['single_variant']);
  assert.deepEqual(await ok(await app.api('GET', `/automations/${saved.id}`)), saved);
}));

test('A-45: no keyword and not any-comment mode is refused', withApp(async (app) => {
  const res = await refused(await app.api('POST', '/automations', body({ keywords: [] })), 400, 'validation_failed');
  assert.equal(res.error, 'Add at least one keyword');
  assert.equal(res.reason, 'no_keyword');
}));

test('any-comment mode needs the warning acknowledged once, and shows it', withApp(async (app) => {
  const res = await refused(await app.api('POST', '/automations', body({ keywords: [], matchMode: 'any' })), 400, 'validation_failed');
  assert.ok(res.fields.anyModeAcknowledged);
  const saved = await save(app, { keywords: [], matchMode: 'any', anyModeAcknowledged: true });
  assert.ok(saved.warnings.some((w) => w.code === 'any_mode'));
  await ok(await app.api('PATCH', `/automations/${saved.id}`, { name: 'Renamed' }));
}));

test('A-46: public replies need at least 5 variants in the brand kit', withApp(async (app) => {
  const res = await refused(await app.api('POST', '/automations', body({ publicReplyEnabled: true })), 400, 'validation_failed');
  assert.equal(res.error, 'Add at least 5 replies');
  await app.repos.brandKit.save({ publicReplyVariants: ['Sent you a DM!', 'Check your DMs', 'Just messaged you', 'Look in your inbox', 'DM sent!'] });
  await save(app, { publicReplyEnabled: true });
}));

test('A-27: a template using {username} is refused', withApp(async (app) => {
  const res = await refused(await app.api('POST', '/automations', body({ variants: [{ label: 'A', body: 'Hi {username}' }] })), 400, 'validation_failed');
  assert.equal(res.reason, 'content.bad_variable');
  assert.ok(res.fields['variants.0.body']);
}));

test('a message that is nothing without the name is refused', withApp(async (app) => {
  const res = await refused(await app.api('POST', '/automations', body({ variants: [{ label: 'A', body: '{first_name}' }] })), 400, 'validation_failed');
  assert.equal(res.reason, 'content.bad_variable');
}));

test('A-36: one tap on the free plan is refused and two taps stay on', withApp(async (app) => {
  const res = await refused(await app.api('POST', '/automations', body({ linkMode: 'one_tap' })), 400, 'validation_failed');
  assert.equal(res.error, 'One tap needs a paid plan');
  const saved = await save(app);
  await refused(await app.api('PATCH', `/automations/${saved.id}`, { linkMode: 'one_tap' }), 400, 'validation_failed');
  assert.equal((await ok(await app.api('GET', `/automations/${saved.id}`))).linkMode, 'two_tap');
  await setPlan(app, 't1');
  assert.equal((await ok(await app.api('PATCH', `/automations/${saved.id}`, { linkMode: 'one_tap' }))).linkMode, 'one_tap');
}));

test('story and DM automations need a plan that includes them', withApp(async (app) => {
  const story = { triggerType: 'story_reply', keywords: [], triggers: [{ targetType: 'any_story' }] };
  await refused(await app.api('POST', '/automations', body(story)), 400, 'validation_failed');
  await setPlan(app, 't3');
  await save(app, story);
}));

test('the free plan stops at 3 automations, counted without archived ones', withApp(async (app) => {
  const made = [];
  for (let i = 0; i < 3; i++) made.push(await save(app, { name: `A${i}`, triggers: [{ targetType: 'reel', mediaId: `R${i}` }] }));
  await refused(await app.api('POST', '/automations', body({ name: 'A3', triggers: [{ targetType: 'reel', mediaId: 'R9' }] })), 400, 'validation_failed');
  await ok(await app.api('POST', `/automations/${made[0].id}/state`, { state: 'archived' }));
  await save(app, { name: 'A3', triggers: [{ targetType: 'reel', mediaId: 'R9' }] });
}));

test('the free plan\'s limit holds when the saves arrive together', withApp(async (app) => {
  const saves = await Promise.all(Array.from({ length: 6 }, (_, i) => app.api('POST', '/automations', body({ name: `A${i}`, triggers: [{ targetType: 'reel', mediaId: `R${i}` }] }))));
  assert.deepEqual(saves.map((r) => r.status).sort(), [201, 201, 201, 400, 400, 400]);
}));

test('two automations can\'t use one reel, and archiving frees it', paidApp(async (app) => {
  const first = await save(app);
  const res = await refused(await app.api('POST', '/automations', body({ name: 'Second' })), 409, 'conflict');
  assert.match(res.error, /already uses/);
  await ok(await app.api('POST', `/automations/${first.id}/state`, { state: 'archived' }));
  await save(app, { name: 'Second' });
}));

test('slugs stay unique and valid, including names with no latin letters', paidApp(async (app) => {
  const a = await save(app, { name: 'Same', triggers: [] });
  const b = await save(app, { name: 'Same', triggers: [] });
  const c = await save(app, { name: 'दिवाली', triggers: [] });
  assert.deepEqual([a.slug, b.slug, c.slug], ['same', 'same-2', 'automation']);
}));

test('a trigger of the wrong kind is refused, and a story mention takes no media', paidApp(async (app) => {
  await refused(await app.api('POST', '/automations', body({ triggers: [{ targetType: 'story', mediaId: 'S1' }] })), 400, 'validation_failed');
  await refused(await app.api('POST', '/automations', body({ triggers: [{ targetType: 'reel' }] })), 400, 'validation_failed');
  await refused(await app.api('POST', '/automations', body({ triggers: [{ targetType: 'reel', mediaId: 'R' }, { targetType: 'post', mediaId: 'R' }] })), 400, 'validation_failed');
  const mention = await save(app, { triggerType: 'story_mention', keywords: [], triggers: [{ targetType: 'dm' }] });
  assert.deepEqual(mention.triggers.map((t) => [t.targetType, t.mediaId]), [['dm', '']]);
}));

test('the schedule\'s times have to make sense', withApp(async (app) => {
  const schedule = (s) => body({ schedule: { startsAt: null, endsAt: null, dailyStart: null, dailyEnd: null, outsideHours: 'hold', ...s } });
  await refused(await app.api('POST', '/automations', schedule({ startsAt: '2026-12-02T00:00:00Z', endsAt: '2026-12-01T00:00:00Z' })), 400, 'validation_failed');
  await refused(await app.api('POST', '/automations', schedule({ dailyStart: '09:00' })), 400, 'validation_failed');
  await refused(await app.api('POST', '/automations', schedule({ dailyStart: '09:00', dailyEnd: '09:00' })), 400, 'validation_failed');
  const saved = await save(app, { schedule: { startsAt: null, endsAt: null, dailyStart: '09:00', dailyEnd: '21:00', outsideHours: 'skip' } });
  assert.deepEqual([saved.schedule.dailyStart, saved.schedule.dailyEnd, saved.schedule.outsideHours], ['09:00', '21:00', 'skip']);
}));

test('going live needs a link and a target, and states change only as allowed', withApp(async (app) => {
  const noLink = await save(app, { linkUrl: '' });
  const res = await refused(await app.api('POST', `/automations/${noLink.id}/state`, { state: 'live' }), 400, 'validation_failed');
  assert.equal(res.error, 'Add the link people will get.');

  const noTarget = await save(app, { name: 'No target', triggers: [] });
  await refused(await app.api('POST', `/automations/${noTarget.id}/state`, { state: 'test' }), 400, 'validation_failed');

  const good = await save(app, { name: 'Good', triggers: [{ targetType: 'reel', mediaId: 'R2' }] });
  const state = async (s) => (await ok(await app.api('POST', `/automations/${good.id}/state`, { state: s }))).state;
  assert.equal(await state('test'), 'test');
  assert.equal(await state('live'), 'live');
  assert.equal(await state('paused'), 'paused');
  assert.equal(await state('live'), 'live');
  assert.equal(await state('archived'), 'archived');
  await refused(await app.api('POST', `/automations/${good.id}/state`, { state: 'live' }), 409, 'conflict');
  await refused(await app.api('PATCH', `/automations/${good.id}`, { name: 'x' }), 409, 'conflict');
  assert.equal(await state('draft'), 'draft');
}));

test('another module can refuse an automation going live, and it stays where it was', () => {
  const refusal = { name: 'probe', beforeAutomationLaunch(automation) {
    if (automation.name === 'Bad link') throw new ApiError('validation_failed', 'That link failed its check.', { reason: 'link.redirect' });
  } };
  return withApp({ extra: [refusal] }, async (app) => {
    const bad = await save(app, { name: 'Bad link' });
    const res = await refused(await app.api('POST', `/automations/${bad.id}/state`, { state: 'live' }), 400, 'validation_failed');
    assert.equal(res.reason, 'link.redirect');
    assert.equal((await ok(await app.api('GET', `/automations/${bad.id}`))).state, 'draft');
    const good = await save(app, { name: 'Good link', triggers: [{ targetType: 'reel', mediaId: 'R2' }] });
    assert.equal((await ok(await app.api('POST', `/automations/${good.id}/state`, { state: 'live' }))).state, 'live');
  })();
});

test('A live automation can\'t be edited into one that couldn\'t go live', withApp(async (app) => {
  const saved = await save(app);
  await ok(await app.api('POST', `/automations/${saved.id}/state`, { state: 'live' }));
  await refused(await app.api('PATCH', `/automations/${saved.id}`, { linkUrl: '' }), 400, 'validation_failed');
}));

test('deleting removes an unused automation and archives one with history', paidApp(async (app) => {
  const unused = await save(app, { name: 'Unused', triggers: [] });
  assert.equal((await app.api('DELETE', `/automations/${unused.id}`)).status, 204);
  await refused(await app.api('GET', `/automations/${unused.id}`), 404, 'not_found');

  const used = await save(app);
  await app.db.platform.query(
    `INSERT INTO outbound_jobs (tenant_id, channel, ig_user_id, kind, idempotency_key, status, automation_id, comment_id, expires_at) VALUES ($1, 'instagram', $2, 'private_reply', 'k1', 'sent', $3, 'c1', now() + interval '1 day')`,
    [app.tenant.id, IG_ACCOUNT.igUserId, used.id],
  );
  assert.equal((await app.api('DELETE', `/automations/${used.id}`)).status, 204);
  assert.equal((await ok(await app.api('GET', `/automations/${used.id}`))).state, 'archived');
}));

test('a version taken away stops being used and keeps its row, and loses a winner\'s place', paidApp(async (app) => {
  const saved = await save(app, { variants: [{ label: 'A', body: 'One' }, { label: 'B', body: 'Two' }] });
  const b = saved.variants.find((v) => v.label === 'B');
  assert.equal((await ok(await app.api('POST', `/automations/${saved.id}/winner`, { variantId: b.id }))).winnerVariantId, b.id);
  const after = await ok(await app.api('PATCH', `/automations/${saved.id}`, { variants: [{ label: 'A', body: 'One edited' }] }));
  assert.deepEqual(after.variants.map((v) => [v.label, v.body]), [['A', 'One edited']]);
  assert.equal(after.winnerVariantId, null);
  assert.equal((await app.db.platform.query('SELECT 1 FROM template_variants WHERE id = $1', [b.id])).length, 1);
  await refused(await app.api('POST', `/automations/${saved.id}/winner`, { variantId: b.id }), 400, 'validation_failed');
}));

test('a winner has to be one of this automation\'s versions', paidApp(async (app) => {
  const one = await save(app, { name: 'One', triggers: [] });
  const two = await save(app, { name: 'Two', triggers: [] });
  await refused(await app.api('POST', `/automations/${one.id}/winner`, { variantId: two.variants[0].id }), 400, 'validation_failed');
}));

test('the follow-up and link messages are saved and cleared with the automation', paidApp(async (app) => {
  await refused(await app.api('POST', '/automations', body({ followupEnabled: true })), 400, 'validation_failed');
  const saved = await save(app, { followupEnabled: true, followupText: 'Still keen?', linkMessage: 'Here is your link' });
  assert.deepEqual([saved.followupText, saved.linkMessage], ['Still keen?', 'Here is your link']);
  const after = await ok(await app.api('PATCH', `/automations/${saved.id}`, { followupEnabled: false, followupText: '', linkMessage: '' }));
  assert.deepEqual([after.followupText, after.linkMessage], ['', '']);
}));

test('A-29: stats show sends and taps per version, leave out tests, and name a leader only after 100 sends each', paidApp(async (app) => {
  const saved = await save(app, { variants: [{ label: 'A', body: 'One' }, { label: 'B', body: 'Two' }] });
  const [a, b] = saved.variants;
  const send = (variant, n, test = false) => app.db.platform.query(
    `INSERT INTO outbound_jobs (tenant_id, channel, ig_user_id, kind, idempotency_key, status, automation_id, variant_id, comment_id, expires_at, is_test)
     SELECT $1, 'instagram', $2, 'private_reply', 'k' || $3::int || '-' || $6::text || '-' || g, 'sent', $4, $3::int, 'c', now() + interval '1 day', $5 FROM generate_series(1, $7::int) g`,
    [app.tenant.id, IG_ACCOUNT.igUserId, variant.id, saved.id, test, String(test), n],
  );
  const tap = (variant, n) => app.db.platform.query(
    `INSERT INTO link_taps (tenant_id, automation_id, channel, media_id, subject_hash, variant_id) SELECT $1, $2, 'instagram', 'R1', 's' || $3::int || '-' || g, $3::int FROM generate_series(1, $4::int) g`,
    [app.tenant.id, saved.id, variant.id, n],
  );
  await send(a, 50);
  await send(b, 50);
  await send(a, 30, true);
  await tap(a, 10);
  await tap(b, 20);
  let stats = await ok(await app.api('GET', `/automations/${saved.id}/stats`));
  assert.equal(stats.sends, 100);
  assert.equal(stats.taps, 30);
  assert.deepEqual(stats.variants.map((v) => [v.label, v.sends, v.taps, v.leader]), [['A', 50, 10, false], ['B', 50, 20, false]]);
  assert.equal(stats.variants[0].rate, 0.2);

  await app.db.platform.query(`DELETE FROM outbound_jobs WHERE is_test`);
  await app.db.platform.query(`INSERT INTO outbound_jobs (tenant_id, channel, ig_user_id, kind, idempotency_key, status, automation_id, variant_id, comment_id, expires_at)
    SELECT $1, 'instagram', $2, 'private_reply', 'more-' || v || '-' || g, 'sent', $3, v, 'c', now() + interval '1 day' FROM generate_series(1, 60) g, unnest($4::int[]) v`, [app.tenant.id, IG_ACCOUNT.igUserId, saved.id, [a.id, b.id]]);
  stats = await ok(await app.api('GET', `/automations/${saved.id}/stats`));
  assert.deepEqual(stats.variants.map((v) => [v.label, v.sends >= 100, v.leader]), [['A', true, false], ['B', true, true]]);
}));

test('a one-tap automation has no tap counts to show', paidApp(async (app) => {
  const saved = await save(app, { linkMode: 'one_tap' });
  const stats = await ok(await app.api('GET', `/automations/${saved.id}/stats`));
  assert.equal(stats.taps, null);
  assert.equal(stats.variants[0].rate, null);
}));

test('the list pages through automations, filters by state and counts media and sends', paidApp(async (app) => {
  for (let i = 0; i < 5; i++) await save(app, { name: `A${i}`, triggers: [{ targetType: 'reel', mediaId: `R${i}` }] });
  const { items, sizes } = await walk(app.api, '/automations', 2);
  assert.deepEqual(sizes, [2, 2, 1]);
  assert.deepEqual(items.map((a) => a.name), ['A4', 'A3', 'A2', 'A1', 'A0']);
  assert.equal(items[0].mediaCount, 1);
  await ok(await app.api('POST', `/automations/${items[0].id}/state`, { state: 'live' }));
  assert.deepEqual((await ok(await app.api('GET', '/automations?state=live'))).items.map((a) => a.id), [items[0].id]);
  await refused(await app.api('GET', '/automations?cursor=bad-cursor'), 400, 'validation_failed');
}));

test('A-28: the preview shows the message filled in and with the name empty, with its problems', withApp(async (app) => {
  const preview = await ok(await app.api('POST', '/automations/preview', { body: 'Hi {first_name}, see {url}', linkUrl: 'https://s.test/p' }));
  assert.equal(preview.filled, 'Hi Asha, see https://s.test/p');
  assert.equal(preview.withoutName, 'Hi, see https://s.test/p');
  assert.equal(preview.bytes, Buffer.byteLength(preview.filled));
  assert.equal(preview.maxBytes, 1000);
  assert.deepEqual(preview.problems, []);
  const bad = await ok(await app.api('POST', '/automations/preview', { body: 'Hi {username}' }));
  assert.deepEqual(bad.problems.map((p) => p.reason), ['content.bad_variable']);
}));

test('audit rows are written for what the owner changes', paidApp(async (app) => {
  const saved = await save(app);
  await ok(await app.api('POST', `/automations/${saved.id}/state`, { state: 'live' }));
  const actions = (await app.db.platform.query('SELECT action, actor FROM audit_log WHERE tenant_id = $1', [app.tenant.id])).map((r) => r.action);
  assert.deepEqual(actions, ['automation.create', 'automation.state']);
}));

test('nobody can see or change another business\'s automations, testers or threads', paidApp(async (app) => {
  const other = await secondBusiness(app);
  const theirs = await save(app);
  const person = await openThread(app);
  await app.platform.tenants.linkIgAccount(other.tenant.id, 'IG-OTHER', 'other');
  await refused(await other.api('GET', `/automations/${theirs.id}`), 404, 'not_found');
  await refused(await other.api('PATCH', `/automations/${theirs.id}`, { name: 'Hacked' }), 404, 'not_found');
  await refused(await other.api('DELETE', `/automations/${theirs.id}`), 404, 'not_found');
  await refused(await other.api('POST', `/automations/${theirs.id}/state`, { state: 'live' }), 404, 'not_found');
  await refused(await other.api('POST', `/automations/${theirs.id}/winner`, { variantId: theirs.variants[0].id }), 404, 'not_found');
  await refused(await other.api('GET', `/automations/${theirs.id}/stats`), 404, 'not_found');
  await refused(await other.api('POST', `/automations/${theirs.id}/send-test`, { testerId: 1 }), 404, 'not_found');
  await refused(await other.api('GET', `/inbox/threads/${person.id}`), 404, 'not_found');
  await refused(await other.api('POST', `/inbox/threads/${person.id}/reply`, { text: 'hello' }), 404, 'not_found');
  assert.deepEqual((await ok(await other.api('GET', '/automations'))).items, []);
  assert.deepEqual((await ok(await other.api('GET', '/inbox/threads'))).items, []);
  assert.equal((await ok(await app.api('GET', `/automations/${theirs.id}`))).name, 'Diwali reel');
}));

test('staff reach automations and the inbox only through their permissions', paidApp(async (app) => {
  const { id } = await app.repos.users.create({ name: 'Ravi S', phone: '9123456780', password: 'secret1', role: 'staff' });
  const api = app.as(await app.signIn({ phone: '9123456780', password: 'secret1' }));
  await refused(await api('GET', '/automations'), 403, 'forbidden');
  await refused(await api('GET', '/inbox/threads'), 403, 'forbidden');
  await app.repos.users.setPermissions(id, ['inbox']);
  await ok(await api('GET', '/inbox/threads'));
  await refused(await api('GET', '/automations'), 403, 'forbidden');
  await refused(await api('POST', '/testers/codes', {}), 403, 'forbidden');
}));

test('tester codes come from the API once, and testers can be listed and removed', paidApp(async (app) => {
  const { code, expiresAt } = await ok(await app.api('POST', '/testers/codes', { label: 'Priya' }), 201);
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(new Date(expiresAt).getTime() > Date.now() + 14 * 60_000);
  const subject = await app.repos.compliance.subjectHash('instagram', 'P-T');
  const tester = await app.repos.testers.redeem({ channel: 'instagram', subject, recipientId: 'P-T', text: code });
  assert.equal(tester.label, 'Priya');
  const { items } = await ok(await app.api('GET', '/testers'));
  assert.deepEqual(items.map((t) => [t.id, t.label, t.windowOpen]), [[tester.id, 'Priya', false]]);
  assert.equal((await app.api('DELETE', `/testers/${tester.id}`)).status, 204);
  await refused(await app.api('DELETE', `/testers/${tester.id}`), 404, 'not_found');
}));

test('Send test needs a real tester and an open window', paidApp(async (app) => {
  const saved = await save(app, { linkMode: 'one_tap' });
  await refused(await app.api('POST', `/automations/${saved.id}/send-test`, { testerId: 9999 }), 404, 'not_found');
  const { code } = await ok(await app.api('POST', '/testers/codes', {}), 201);
  const subject = await app.repos.compliance.subjectHash('instagram', 'P-T');
  const tester = await app.repos.testers.redeem({ channel: 'instagram', subject, recipientId: 'P-T', text: code });
  assert.deepEqual(await ok(await app.api('POST', `/automations/${saved.id}/send-test`, { testerId: tester.id })), { outcome: 'skipped', reason: 'window.closed' });
  await openThread(app, { person: 'P-T' });
  assert.deepEqual(await ok(await app.api('POST', `/automations/${saved.id}/send-test`, { testerId: tester.id, variantLabel: 'A' })), { outcome: 'sent', reason: '' });
  await refused(await app.api('POST', `/automations/${saved.id}/send-test`, { testerId: tester.id, variantLabel: 'C' }), 400, 'validation_failed');
  assert.deepEqual(app.ig.calls.at(-1)[1], { id: 'P-T' });
}));

test('A-37: the inbox lists threads with their last message and status, newest first, in pages', withApp(async (app) => {
  for (let i = 0; i < 3; i++) await openThread(app, { person: `P${i}`, text: `message ${i}`, at: new Date(Date.now() - (3 - i) * HOUR) });
  const { items, sizes } = await walk(app.api, '/inbox/threads', 2);
  assert.deepEqual(sizes, [2, 1]);
  assert.deepEqual(items.map((t) => t.lastMessage), ['message 2', 'message 1', 'message 0']);
  assert.equal(items[0].status, 'open');
  assert.equal(items[0].username, 'asha');
  assert.equal(items[0].canReply, true);
  const detail = await ok(await app.api('GET', `/inbox/threads/${items[0].id}`));
  assert.deepEqual(detail.messages.map((m) => [m.direction, m.author, m.text]), [['in', 'person', 'message 2']]);
  assert.equal(JSON.stringify(detail).includes('P2'), false, 'a shopper\'s id never leaves the server');
  assert.equal((await ok(await app.api('GET', '/inbox/threads?status=closed'))).items.length, 0);
}));

test('A-39: a manual reply 23h55m after the last message is refused', withApp(async (app) => {
  const thread = await openThread(app, { at: new Date(Date.now() - (23 * HOUR + 55 * 60_000)) });
  const res = await refused(await app.api('POST', `/inbox/threads/${thread.id}/reply`, { text: 'Sorry for the wait' }), 409, 'conflict');
  assert.equal(res.error, 'Reply in the Instagram app');
  assert.equal(res.reason, 'window.closed');
  assert.deepEqual(app.ig.calls, []);
  assert.equal((await ok(await app.api('GET', `/inbox/threads/${thread.id}`))).canReply, false);
}));

test('A-40: a manual reply 2h after the last message goes, and pauses automation for 12h', withApp(async (app) => {
  const thread = await openThread(app, { at: new Date(Date.now() - 2 * HOUR) });
  const res = await ok(await app.api('POST', `/inbox/threads/${thread.id}/reply`, { text: 'It is ₹499' }));
  assert.deepEqual([res.outcome, res.reason], ['sent', '']);
  assert.ok(Math.abs(new Date(res.automationPausedUntil).getTime() - (Date.now() + 12 * HOUR)) < 5000);
  assert.deepEqual(app.ig.calls.map((c) => c[0]), ['message']);
  const detail = await ok(await app.api('GET', `/inbox/threads/${thread.id}`));
  assert.equal(detail.pauseReason, 'thread.owner_replied');
  assert.deepEqual(detail.messages.at(-1).author, 'owner');
  assert.equal(detail.lastMessage, 'It is ₹499');
}));

test('a reply the gate refuses is reported and pauses nothing', paidApp(async (app) => {
  const thread = await openThread(app);
  await app.db.platform.query('UPDATE ig_accounts SET access_token_enc = $1 WHERE tenant_id = $2', ['', app.tenant.id]);
  const res = await ok(await app.api('POST', `/inbox/threads/${thread.id}/reply`, { text: 'hello' }));
  assert.deepEqual([res.outcome, res.reason, res.automationPausedUntil], ['held', 'paused.reconnect', null]);
  assert.equal((await ok(await app.api('GET', `/inbox/threads/${thread.id}`))).messages.length, 1);
}));

test('A-42: someone who opted out can still get a manual reply inside the window', withApp(async (app) => {
  const thread = await openThread(app, { person: 'P-OUT' });
  const subject = await app.repos.compliance.subjectHash('instagram', 'P-OUT');
  await app.db.platform.query(`INSERT INTO opt_outs (tenant_id, channel, subject_hash, source) VALUES ($1, 'instagram', $2, 'dm')`, [app.tenant.id, subject]);
  assert.equal((await ok(await app.api('POST', `/inbox/threads/${thread.id}/reply`, { text: 'Understood' }))).outcome, 'sent');
}));

test('a thread with two open items stays with a person until both are resolved', withApp(async (app) => {
  const thread = await openThread(app);
  await app.db.platform.query(`UPDATE inbox_threads SET status = 'needs_human' WHERE id = $1`, [thread.id]);
  const [first, second] = [await needsHuman(app, thread.id), await needsHuman(app, thread.id)];
  await ok(await app.api('POST', `/inbox/needs-human/${first.id}/resolve`));
  assert.equal((await ok(await app.api('GET', `/inbox/threads/${thread.id}`))).status, 'needs_human');
  await ok(await app.api('POST', `/inbox/needs-human/${second.id}/resolve`));
  assert.equal((await ok(await app.api('GET', `/inbox/threads/${thread.id}`))).status, 'open');
}));

test('Needs a human lists what is open and resolving one puts the thread back', withApp(async (app) => {
  const thread = await openThread(app);
  await app.db.platform.query(`UPDATE inbox_threads SET status = 'needs_human', pause_reason = 'thread.handoff', automation_paused_until = now() + interval '1 hour' WHERE id = $1`, [thread.id]);
  const item = await needsHuman(app, thread.id);
  assert.deepEqual((await ok(await app.api('GET', '/inbox/needs-human'))).items.map((i) => i.id), [item.id]);
  assert.equal((await ok(await app.api('GET', `/inbox/threads/${thread.id}`))).status, 'needs_human');
  assert.equal((await ok(await app.api('POST', `/inbox/needs-human/${item.id}/resolve`))).status, 'resolved');
  assert.deepEqual((await ok(await app.api('GET', '/inbox/needs-human'))).items, []);
  assert.equal((await ok(await app.api('GET', '/inbox/needs-human?status=resolved'))).items.length, 1);
  assert.equal((await ok(await app.api('GET', `/inbox/threads/${thread.id}`))).status, 'open');
  await refused(await app.api('POST', '/inbox/needs-human/99999/resolve'), 404, 'not_found');
}));

async function withMeta(run) {
  const meta = createMeta();
  await meta.start();
  try {
    await meta.post('/accounts', { igUserId: IG_ACCOUNT.igUserId, username: 'shop', token: IG_ACCOUNT.token });
    await withApp({ overrides: { graphBaseUrl: meta.url } }, (app) => run(app, meta))();
  } finally {
    await meta.close();
  }
}

test('ice breakers are saved, set on the account and read back; more than four is refused', () => withMeta(async (app, meta) => {
  const items = [{ question: 'Do you ship?', templateBody: 'Yes, all over India' }, { question: 'What sizes?', templateBody: 'S to XL' }];
  assert.deepEqual(await ok(await app.api('PUT', '/ice-breakers', { items })), { items });
  assert.deepEqual(await ok(await app.api('GET', '/ice-breakers')), { items });
  const onAccount = await createMetaClient({ graphBaseUrl: meta.url }).forAccount(IG_ACCOUNT).iceBreakers();
  assert.deepEqual(onAccount.data[0].ice_breakers[0].call_to_actions, [{ question: 'Do you ship?', payload: 'faq:1' }, { question: 'What sizes?', payload: 'faq:2' }]);

  await refused(await app.api('PUT', '/ice-breakers', { items: Array.from({ length: 5 }, (_, i) => ({ question: `Q${i}`, templateBody: 'A' })) }), 400, 'validation_failed');
  const replaced = [{ question: 'Only one', templateBody: 'Answer' }];
  assert.deepEqual(await ok(await app.api('PUT', '/ice-breakers', { items: replaced })), { items: replaced });
  assert.equal((await app.db.platform.query(`SELECT 1 FROM message_templates WHERE role = 'faq_answer'`)).length, 1, 'old answers are gone');
  assert.deepEqual(await ok(await app.api('PUT', '/ice-breakers', { items: [] })), { items: [] });
}));

test('ice breakers saved with an expired token are kept and ask for a reconnect', () => withMeta(async (app, meta) => {
  await meta.post('/tokens/expire', { token: IG_ACCOUNT.token });
  const items = [{ question: 'Do you ship?', templateBody: 'Yes' }];
  const res = await refused(await app.api('PUT', '/ice-breakers', { items }), 409, 'conflict');
  assert.match(res.error, /Reconnect Instagram/);
  assert.equal(res.reason, 'paused.reconnect');
  assert.deepEqual(await ok(await app.api('GET', '/ice-breakers')), { items });
}));
