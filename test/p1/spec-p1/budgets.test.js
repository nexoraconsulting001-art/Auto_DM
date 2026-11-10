// PRD 4.3: budgets and throttling. C-09 to C-13. C-47 from 4.13.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPLIANCE_LIMITS, HOUR, MINUTE, SECOND, addShop, assertReason, commentPayload, need, pause, savePublicReplies, secondsBetween, useWorld } from './support.js';

const world = useWorld();
const HALF = COMPLIANCE_LIMITS.reducedBudgetMultiplier;

const rateState = async (shop) => (await shop.sql('SELECT * FROM account_rate_state WHERE tenant_id = $1 AND account_id = $2', [shop.tenantId, shop.igUserId]))[0];
const mediaCalls = (shop) => world.meta.calls({ method: 'GET', path: `*/${shop.igUserId}/media` });
const readMedia = (shop) => shop.api('/instagram/media');
const clearFaults = () => world.meta.delete('/faults');

/** One batch of `n` keyword comments on one reel. The comments exist at Meta, so private replies are real. */
async function commentBurst(shop, mediaId, n) {
  const entries = [];
  for (let i = 0; i < n; i++) {
    const from = world.fan();
    const { comment } = await world.meta.post('/comments', { igUserId: shop.igUserId, mediaId, from, text: 'price', deliver: false });
    entries.push(commentPayload(shop, { id: comment.id, mediaId, from }).entry[0]);
  }
  for (let i = 0; i < entries.length; i += 1000) need(await world.webhook({ object: 'instagram', entry: entries.slice(i, i + 1000) }), 200, 'A batch of comments');
}

test('C-09: 3,000 keyword comments in an hour never exceed 600 sends per rolling hour, and all drain in about 5 hours', { timeout: 280_000 }, async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await commentBurst(shop, reel.mediaId, 3000);
  await shop.settle({ ms: 60_000, roundMs: 2000 });
  const perMinute = [];
  let seen = 0;
  for (let minute = 0; minute < 330 && seen < 3000; minute++) {
    await shop.settle({ ms: 1500, roundMs: 500 });
    const now = (await shop.dms()).length;
    perMinute.push(now - seen);
    seen = now;
    await world.travel(MINUTE);
  }
  for (let start = 0; start < perMinute.length; start++) {
    const hour = perMinute.slice(start, start + 60).reduce((a, b) => a + b, 0);
    assert.ok(hour <= COMPLIANCE_LIMITS.privateRepliesPerHour, `Minutes ${start} to ${start + 60} sent ${hour}`);
  }
  assert.equal(seen, 3000, 'Everyone is served');
  const dms = await shop.dms();
  assert.equal(new Set(dms.map((m) => m.commentId)).size, 3000, 'Nobody twice');
  assert.ok(perMinute.length >= 240, `Took ${perMinute.length} simulated minutes`);
});

test('C-09: every job carries a unique idempotency key and an expiry', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const a = await shop.comment(reel.mediaId);
  const b = await shop.comment(reel.mediaId);
  await shop.settle();
  const jobs = await shop.jobs();
  assert.deepEqual(jobs.map((j) => j.idempotency_key).sort(), [`private_reply:${a.id}`, `private_reply:${b.id}`].sort());
  assert.ok(jobs.every((j) => j.expires_at instanceof Date || j.expires_at));
});

test('C-09: every Graph call is bounded: a Meta that never answers ends as unknown, inside the timeout', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await shop.fault({ kind: 'timeout', match: { method: 'POST', path: `*/${shop.igUserId}/messages` }, times: 'forever' });
  try {
    await shop.comment(reel.mediaId);
    await shop.settle({ ms: 6000 });
  } finally {
    await clearFaults();
  }
  const [job] = await shop.jobs();
  assert.equal(job.status, 'unknown');
  assert.equal(job.reason, 'send.unknown_outcome');
  assert.equal((await shop.sendCalls()).length, 1, 'An unknown outcome is never resent');
});

for (const [label, fault] of [
  ['a 500', { kind: 'server_error', status: 500 }],
  ['a 503', { kind: 'server_error', status: 503 }],
  ['a dropped connection', { kind: 'drop' }],
  ['a body cut off halfway', { kind: 'malformed', mode: 'aborted' }],
  ['an HTML error page with a 200', { kind: 'malformed', mode: 'html' }],
  ['delivered, then a 500', { kind: 'partial', then: 'server_error' }],
  ['delivered, then a dropped connection', { kind: 'partial', then: 'drop' }],
]) {
  test(`C-09: ${label} on a send is an unknown outcome, never resent, and goes to Needs a human`, async () => {
    const shop = await addShop(world);
    const reel = await shop.automate();
    await shop.fault({ ...fault, match: { method: 'POST', path: `*/${shop.igUserId}/messages` } });
    await shop.comment(reel.mediaId);
    await world.travel(HOUR);
    await shop.settle({ ms: 5000 });
    const [job] = await shop.jobs();
    assert.equal(job.status, 'unknown');
    assert.equal(job.reason, 'send.unknown_outcome');
    assert.equal((await shop.sendCalls()).length, 1);
    assert.deepEqual((await shop.needsHuman()).map((i) => i.kind), ['unknown_outcome']);
  });
}

for (const [label, fault] of [
  ['code 4', { code: 4 }],
  ['code 17', { code: 17 }],
  ['code 32', { code: 32 }],
  ['code 613', { code: 613 }],
  ['a plain HTTP 429', { }],
]) {
  test(`C-10: messaging answered with ${label} pauses messaging for the account, and the job waits`, async () => {
    const shop = await addShop(world);
    const reel = await shop.automate();
    await shop.fault({ kind: 'rate_limit', ...fault, match: { method: 'POST', path: `*/${shop.igUserId}/messages` } });
    await shop.comment(reel.mediaId);
    await shop.settle();
    const [job] = await shop.jobs();
    assert.equal(job.status, 'queued', 'Throttled, not failed');
    assert.ok(new Date(job.run_at) > new Date());
    assert.ok(new Date((await rateState(shop)).messaging_paused_until) > new Date());
    await assertReason(shop, 'rate.throttled');
    await shop.comment(reel.mediaId);
    await shop.settle();
    assert.equal((await shop.sendCalls()).length, 1, 'No further send while paused');
  });
}

test('C-10: messaging pauses until the regain time Meta gave', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await shop.fault({ kind: 'rate_limit', code: 613, regainMinutes: 17, match: { method: 'POST', path: `*/${shop.igUserId}/messages` } });
  await shop.comment(reel.mediaId);
  await shop.settle();
  const until = new Date((await rateState(shop)).messaging_paused_until).getTime();
  assert.ok(Math.abs(until - Date.now() - 17 * MINUTE) < MINUTE, `Paused for ${(until - Date.now()) / MINUTE} min`);
});

test('C-10: with no regain time the pause is between 1 and 60 minutes', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await shop.fault({ kind: 'rate_limit', code: 613, match: { method: 'POST', path: `*/${shop.igUserId}/messages` } });
  await shop.comment(reel.mediaId);
  await shop.settle();
  const minutes = (new Date((await rateState(shop)).messaging_paused_until).getTime() - Date.now()) / MINUTE;
  assert.ok(minutes > 0.5 && minutes <= 60, `${minutes} min`);
});

test('C-10: a messaging throttle leaves reads alone', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await shop.reel();
  await shop.fault({ kind: 'rate_limit', code: 613, match: { method: 'POST', path: `*/${shop.igUserId}/messages` } });
  await shop.comment(reel.mediaId);
  await shop.settle();
  assert.equal((await rateState(shop)).other_paused_until, null, 'Only messaging pauses');
  need(await readMedia(shop), 200, 'The media list');
  assert.equal((await mediaCalls(shop)).length, 1);
});

test('C-10: after the pause the waiting job sends once', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await shop.fault({ kind: 'rate_limit', code: 613, regainMinutes: 5, match: { method: 'POST', path: `*/${shop.igUserId}/messages` } });
  await shop.comment(reel.mediaId);
  await shop.settle();
  await world.travel(6 * MINUTE);
  await shop.settle();
  assert.equal((await shop.dms()).length, 1);
  assert.equal((await shop.jobs())[0].status, 'sent');
});

test('C-10: a throttled job that passes its expiry during the pause drops, unsent', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await shop.fault({ kind: 'rate_limit', code: 613, regainMinutes: 5, match: { method: 'POST', path: `*/${shop.igUserId}/messages` } });
  await shop.comment(reel.mediaId, { at: Date.now() - COMPLIANCE_LIMITS.privateReplyExpiryMs + 2 * MINUTE });
  await shop.settle();
  await world.travel(6 * MINUTE);
  await shop.settle();
  const [job] = await shop.jobs();
  assert.equal(job.status, 'expired');
  assert.equal(job.reason, 'expired.7d');
  assert.equal((await shop.dms()).length, 0);
});

test('C-10: one account\'s throttle is never another business\'s', async () => {
  const hot = await addShop(world);
  const cool = await addShop(world);
  const hotReel = await hot.automate();
  const coolReel = await cool.automate();
  await hot.fault({ kind: 'rate_limit', code: 613, match: { method: 'POST', path: `*/${hot.igUserId}/messages` } });
  await hot.comment(hotReel.mediaId);
  await hot.settle();
  await cool.comment(coolReel.mediaId);
  await cool.settle();
  assert.equal((await cool.dms()).length, 1);
  assert.equal(await rateState(cool).then((r) => r?.messaging_paused_until ?? null), null);
});

test('C-10: a junk usage header on a messaging response is ignored, and the DM still counts as sent', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await shop.fault({ kind: 'partial', status: 200, headers: { 'x-business-use-case-usage': '{not json' }, match: { method: 'POST', path: `*/${shop.igUserId}/messages` } });
  await shop.comment(reel.mediaId);
  await shop.settle();
  const [job] = await shop.jobs();
  assert.equal(job.status, 'sent');
  assert.equal((await shop.dms()).length, 1);
});

async function trip80002(shop, regainMinutes = 30) {
  await shop.fault({ kind: 'rate_limit', status: 400, code: 80002, regainMinutes, match: { method: 'GET', path: `*/${shop.igUserId}/media` } });
  const res = await readMedia(shop);
  assert.ok(res.status < 500 || res.status === 503, `Reading media under 80002 answered ${res.status}`);
  await shop.settle();
}

test('C-11: 80002 pauses reads until the regain time, and slow mode runs until 60 minutes after it', async () => {
  const shop = await addShop(world);
  await trip80002(shop, 30);
  const state = await rateState(shop);
  assert.ok(Math.abs(new Date(state.other_paused_until).getTime() - Date.now() - 30 * MINUTE) < MINUTE);
  assert.ok(Math.abs(new Date(state.slow_mode_until).getTime() - Date.now() - 90 * MINUTE) < 2 * MINUTE);
  assert.equal(state.slow_mode_trigger, 'buc_80002');
  await assertReason(shop, 'rate.usage_header');
  const before = (await mediaCalls(shop)).length;
  await readMedia(shop);
  assert.equal((await mediaCalls(shop)).length, before, 'No read reaches Meta during the pause');
});

test('C-11: under 80002 DMs continue, and the console says slow mode is on', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await trip80002(shop);
  await world.switchLag();
  const status = await shop.call('/compliance/status', 200);
  assert.equal(status.slowMode.active, true);
  await shop.comment(reel.mediaId);
  await shop.settle();
  assert.equal((await shop.dms()).length, 1, 'A live automation keeps sending in slow mode');
});

test('C-11: in slow mode two DMs on one media stay at least 2 minutes apart', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await trip80002(shop);
  await world.switchLag();
  await shop.comment(reel.mediaId);
  await shop.comment(reel.mediaId);
  await shop.settle({ ms: 4000 });
  assert.equal((await shop.dms()).length, 1, 'The second waits');
  await world.travel(2 * MINUTE - 30 * SECOND);
  await shop.settle({ ms: 3000 });
  assert.equal((await shop.dms()).length, 1, 'Still waiting just inside 2 minutes');
  await world.travel(31 * SECOND);
  await shop.settle({ ms: 3000 });
  assert.equal((await shop.dms()).length, 2);
});

test('C-11: public replies pause under 80002, even for a DM that went out', async () => {
  const shop = await addShop(world);
  await savePublicReplies(shop);
  const reel = await shop.automate({ publicReplyEnabled: true });
  await trip80002(shop);
  await world.switchLag();
  await shop.comment(reel.mediaId);
  await shop.settle();
  await world.travel(2 * MINUTE);
  await shop.settle();
  assert.equal((await shop.dms()).length, 1);
  assert.equal((await shop.publicReplies()).length, 0);
});

test('C-11: slow mode halves the private-reply budget to 300 an hour, and a second reduction doesn\'t halve it again', { timeout: 280_000 }, async () => {
  assert.equal(HALF, 0.5);
  const shop = await addShop(world);
  await shop.settingsRow({ score_review_needed: true });
  const media = [];
  for (let n = 0; n < 7; n++) {
    const ids = [];
    for (let i = 0; i < 50; i++) ids.push(await shop.reel());
    await shop.automate({ triggers: ids.map((mediaId) => ({ channel: 'instagram', targetType: 'reel', mediaId })) });
    media.push(...ids);
  }
  await trip80002(shop);
  await shop.sql(`UPDATE account_rate_state SET slow_mode_until = now() + interval '10 hours' WHERE tenant_id = $1`, [shop.tenantId]);
  await world.switchLag();
  const entries = [];
  for (const mediaId of media) {
    const from = world.fan();
    const { comment } = await world.meta.post('/comments', { igUserId: shop.igUserId, mediaId, from, text: 'price', deliver: false });
    entries.push(commentPayload(shop, { id: comment.id, mediaId, from }).entry[0]);
  }
  need(await world.webhook({ object: 'instagram', entry: entries }), 200, 'One comment on each of 350 reels');
  await shop.settle({ ms: 40_000, roundMs: 2000 });
  for (let minute = 0; minute < 59; minute++) {
    await world.travel(MINUTE);
    await shop.settle({ ms: 1500, roundMs: 500 });
  }
  const sent = (await shop.dms()).length;
  assert.ok(sent <= COMPLIANCE_LIMITS.privateRepliesPerHour * HALF, `Sent ${sent} in the hour at x0.5`);
  assert.ok(sent >= 200, `The multipliers don't stack, but it sent only ${sent}`);
});

test('C-11: a business with an 80002 does not slow another down', async () => {
  const hot = await addShop(world);
  const cool = await addShop(world);
  await trip80002(hot);
  assert.equal((await cool.call('/compliance/status', 200)).slowMode.active, false);
  need(await readMedia(cool), 200, 'The other business\'s media list');
});

const setUsage = (shop, percent) => world.meta.post('/usage', { igUserId: shop.igUserId, percent });
/** One read records the usage header; what the next read does shows what the header did. */
async function secondReadReachesMeta(shop) {
  await readMedia(shop);
  await shop.settle({ ms: 1500 });
  const before = (await mediaCalls(shop)).length;
  await readMedia(shop);
  return (await mediaCalls(shop)).length > before;
}

test('C-12: a usage header at 78% pauses the media list and leaves DMs unchanged', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await setUsage(shop, 78);
  assert.equal(await secondReadReachesMeta(shop), false);
  assert.equal((await rateState(shop)).usage_percent, 78);
  await shop.comment(reel.mediaId);
  await shop.settle();
  assert.equal((await shop.dms()).length, 1);
  assert.equal((await shop.call('/compliance/status', 200)).slowMode.active, false, '78% is not slow mode');
  await assertReason(shop, 'rate.usage_header');
});

for (const [percent, reaches] of [[74, true], [75, false], [89, false]]) {
  test(`C-12: at exactly ${percent}% the media list ${reaches ? 'still runs' : 'stops'}`, async () => {
    const shop = await addShop(world);
    await setUsage(shop, percent);
    assert.equal(await secondReadReachesMeta(shop), reaches);
  });
}

test('C-12: at 75% public replies stop, and DMs do not', async () => {
  const shop = await addShop(world);
  await savePublicReplies(shop);
  const reel = await shop.automate({ publicReplyEnabled: true });
  await setUsage(shop, 80);
  await readMedia(shop);
  await shop.settle({ ms: 1500 });
  await shop.comment(reel.mediaId);
  await shop.settle();
  await world.travel(2 * MINUTE);
  await shop.settle();
  assert.equal((await shop.dms()).length, 1);
  assert.equal((await shop.publicReplies()).length, 0);
});

for (const junk of ['{not json', '', '[]', '{"123":"x"}', '{"123":[{"call_count":"lots"}]}', 'null']) {
  test(`C-12: a junk usage header (${junk || 'empty'}) is ignored and the read still answers`, async () => {
    const shop = await addShop(world);
    await shop.reel();
    await shop.fault({ kind: 'partial', status: 200, headers: { 'x-business-use-case-usage': junk }, match: { method: 'GET', path: `*/${shop.igUserId}/media` } });
    need(await readMedia(shop), 200, 'The media list');
    assert.equal(await rateState(shop).then((r) => r?.other_paused_until ?? null), null);
  });
}

test('C-13: at 92% reads stop and the token refresh still runs', async () => {
  const shop = await addShop(world);
  await setUsage(shop, 92);
  assert.equal(await secondReadReachesMeta(shop), false);
  await assertReason(shop, 'rate.usage_header');
  await shop.sql(`UPDATE ig_accounts SET token_issued_at = now() - interval '40 days', token_expires_at = now() + interval '20 days', next_refresh_at = now() - interval '1 hour' WHERE tenant_id = $1`, [shop.tenantId]);
  await shop.settle();
  assert.equal((await world.meta.calls({ path: '*/refresh_access_token' })).filter((c) => (c.query?.access_token ?? c.headers.authorization ?? '').includes(shop.igToken)).length, 1);
});

for (const [percent, slow] of [[89, false], [90, true]]) {
  test(`C-13: a usage header at ${percent}% on a messaging response ${slow ? 'starts' : 'does not start'} slow mode`, async () => {
    const shop = await addShop(world);
    const reel = await shop.automate();
    await setUsage(shop, percent);
    await shop.comment(reel.mediaId);
    await shop.settle();
    assert.equal((await shop.dms()).length, 1, 'The DM itself went');
    assert.equal(Boolean((await rateState(shop))?.slow_mode_until), slow);
  });
}

test('C-13: at 92% a comment timestamp is not fetched, and its expiry uses the received-at rule', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await setUsage(shop, 92);
  await readMedia(shop);
  await shop.settle({ ms: 1500 });
  const comment = await shop.comment(reel.mediaId);
  await shop.settle();
  assert.equal((await world.meta.calls({ method: 'GET', path: `*/${comment.id}` })).length, 0, 'No comment timestamp read');
  const [job] = await shop.jobs();
  const [event] = await shop.inbound('object_id = $2', [comment.id]);
  const lifeMs = new Date(job.expires_at) - new Date(event.received_at);
  assert.ok(Math.abs(lifeMs - COMPLIANCE_LIMITS.privateReplyNoTimestampExpiryMs) < MINUTE, `Job lives ${lifeMs / HOUR} h from receipt`);
});

test('C-47: with 2,400 jobs queued for one business, another\'s send is not delayed', { timeout: 120_000 }, async () => {
  const busy = await addShop(world);
  const quiet = await addShop(world);
  const busyReel = await busy.automate();
  const quietReel = await quiet.automate();
  await busy.refuseSends({ code: 613, status: 429 });
  await busy.comment(busyReel.mediaId);
  await busy.settle();
  const [seed] = await busy.jobs();
  assert.equal(seed.status, 'queued', 'One real queued job to copy');
  await busy.sql(
    `INSERT INTO outbound_jobs (tenant_id, channel, ig_user_id, kind, purpose, idempotency_key, status, automation_id, variant_id, media_id, comment_id, recipient_id, subject_hash, payload, expires_at, run_at)
     SELECT tenant_id, channel, ig_user_id, kind, purpose, idempotency_key || ':' || n, 'queued', automation_id, variant_id, media_id, comment_id || n, recipient_id || n, subject_hash, payload, expires_at, now() - interval '1 minute'
     FROM outbound_jobs CROSS JOIN generate_series(1, 2399) AS n WHERE id = $1`,
    [seed.id],
  );
  assert.equal((await busy.jobs(`status = 'queued'`)).length, 2400);
  const started = Date.now();
  const comment = await quiet.comment(quietReel.mediaId);
  let delivered = 0;
  while (Date.now() - started < 10_000 && !delivered) {
    await world.tick();
    delivered = (await quiet.dms({ commentId: comment.id })).length;
    await pause(25);
  }
  assert.equal(delivered, 1, 'The quiet business\'s DM went out');
  assert.ok(Date.now() - started < 8_000, `It took ${Date.now() - started} ms behind the other business's queue`);
});

test('C-47: when one business has spent its hour\'s budget, another still has all of its own', async () => {
  const spent = await addShop(world);
  const fresh = await addShop(world);
  const reelA = await spent.automate();
  const reelB = await fresh.automate();
  await spent.sql(`INSERT INTO send_budgets (tenant_id, channel, account_id, budget, tokens, refilled_at) VALUES ($1, 'instagram', $2, 'private_reply', 0, now()) ON CONFLICT (tenant_id, channel, account_id, budget) DO UPDATE SET tokens = 0, refilled_at = now()`, [spent.tenantId, spent.igUserId]);
  await spent.comment(reelA.mediaId);
  await fresh.comment(reelB.mediaId);
  await spent.settle({ ms: 3000 });
  await fresh.settle({ ms: 3000 });
  assert.equal((await spent.dms()).length, 0);
  assert.equal((await fresh.dms()).length, 1);
  assert.equal((await fresh.sql('SELECT tenant_id FROM send_budgets WHERE tenant_id <> $1 AND account_id = $2', [fresh.tenantId, fresh.igUserId])).length, 0, 'Nobody else holds a bucket for this account');
});

test('C-47: a send\'s delay is measured in seconds, not in other people\'s jobs', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const started = new Date();
  await shop.comment(reel.mediaId);
  await shop.settle();
  const [job] = await shop.jobs();
  assert.ok(secondsBetween(job.sent_at, started) < 10, `Took ${secondsBetween(job.sent_at, started)} s`);
});
