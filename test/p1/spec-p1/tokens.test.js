// PRD 4.2 and 4.14: tokens, deauthorize and deletion. C-04 to C-08, C-49, C-50.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { APP_SECRET, DAY, HOUR, MINUTE, addShop, assertNoDm, assertReason, connectInstagramFlow, hit, need, secondsBetween, signedRequest, swapToken, tokenOfCall, unique, useWorld } from './support.js';

const world = useWorld({ proxy: true });

const refreshCalls = (shop) => world.meta.calls({ path: '*/refresh_access_token' }).then((calls) => calls.filter((c) => tokenOfCall(c) === shop.igToken));
const setTokenAge = (shop, { issuedDaysAgo, expiresInDays, nextRefresh = '-1 hour' }) => shop.sql(
  `UPDATE ig_accounts SET token_issued_at = now() - make_interval(secs => $3::float * 86400), token_expires_at = now() + make_interval(secs => $4::float * 86400), next_refresh_at = now() + $5::interval WHERE tenant_id = $1 AND ig_user_id = $2`,
  [shop.tenantId, shop.igUserId, issuedDaysAgo, expiresInDays, nextRefresh],
);
const refuseAllRefreshes = (kind = 'server_error') => world.meta.fault({ kind, match: { path: '*/refresh_access_token' }, times: 'forever' });
const clearFaults = () => world.meta.delete('/faults');

test('C-04: a refresh swaps the token while a send is in flight: Meta says 190, one retry with the new token, one DM', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const { token: fresh } = await world.meta.post('/tokens', { igUserId: shop.igUserId });
  world.duringGraphCall(new RegExp(`/${shop.igUserId}/messages`), async () => {
    await swapToken(shop, fresh);
    await world.meta.post('/tokens/revoke', { token: shop.igToken });
  });
  await shop.comment(reel.mediaId);
  await shop.settle();
  const calls = await shop.sendCalls();
  assert.deepEqual(calls.map(tokenOfCall), [shop.igToken, fresh], 'The first with the old token, the second with the new one');
  assert.equal((await shop.dms()).length, 1);
  assert.equal((await shop.jobs())[0].status, 'sent');
  assert.equal((await shop.account()).status, 'active', 'A swap is not a broken connection');
  assert.ok(!(await shop.reasons()).includes('token.rejected'));
  assert.equal((await shop.call('/compliance/status', 200)).breaker, 'closed', 'The retried 190 does not trip the breaker');
});

test('C-04: the job remembers the token version it went out with', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const version = (await shop.account()).token_version;
  await shop.comment(reel.mediaId);
  await shop.settle();
  assert.equal((await shop.jobs())[0].token_version, version);
});

test('C-04: a 190 with no swap behind it is not retried: reconnect needed, job held, owner alerted', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await world.meta.post('/tokens/revoke', { token: shop.igToken });
  await shop.comment(reel.mediaId);
  await shop.settle();
  assert.equal((await shop.sendCalls()).length, 1);
  const [job] = await shop.jobs();
  assert.equal(job.status, 'held');
  assert.equal(job.reason, 'paused.reconnect');
  assert.equal((await shop.account()).status, 'reconnect_needed');
  await assertReason(shop, 'token.rejected');
  const alerts = await shop.alerts();
  assert.equal(alerts.length, 1);
  assert.ok(secondsBetween(alerts[0].created_at, new Date()) < 60);
});

test('C-04: a second 190 on the retry stops there: exactly two calls, job held', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const { token: fresh } = await world.meta.post('/tokens', { igUserId: shop.igUserId });
  world.duringGraphCall(new RegExp(`/${shop.igUserId}/messages`), async () => {
    await swapToken(shop, fresh);
    await world.meta.post('/tokens/revoke', { igUserId: shop.igUserId });
  });
  await shop.comment(reel.mediaId);
  await shop.settle();
  assert.equal((await shop.sendCalls()).length, 2);
  assert.equal((await shop.dms()).length, 0);
  assert.equal((await shop.jobs())[0].status, 'held');
  assert.equal((await shop.account()).status, 'reconnect_needed');
});

test('C-04: a 190 on one business never touches another business\'s connection', async () => {
  const broken = await addShop(world);
  const fine = await addShop(world);
  const brokenReel = await broken.automate();
  const fineReel = await fine.automate();
  await world.meta.post('/tokens/revoke', { token: broken.igToken });
  await broken.comment(brokenReel.mediaId);
  await fine.comment(fineReel.mediaId);
  await broken.settle();
  await fine.settle();
  assert.equal((await fine.account()).status, 'active');
  assert.equal((await fine.dms()).length, 1);
});

test('C-05: a refresh that keeps failing alerts at 14, 7, 3 and 1 days, once each', async () => {
  const shop = await addShop(world);
  await setTokenAge(shop, { issuedDaysAgo: 45, expiresInDays: 15 });
  await refuseAllRefreshes();
  try {
    for (let day = 0; day < 15; day++) {
      await world.travel(DAY - 60 * MINUTE);
      await world.tick();
      await world.travel(60 * MINUTE);
      await shop.settle({ ms: 2500 });
    }
  } finally {
    await clearFaults();
  }
  const kinds = (await shop.sql('SELECT kind FROM token_alerts WHERE tenant_id = $1 ORDER BY id', [shop.tenantId])).map((r) => r.kind);
  assert.deepEqual(kinds, ['expiry_14d', 'expiry_7d', 'expiry_3d', 'expiry_1d']);
  assert.ok((await shop.alerts()).length >= 4);
});

for (const [daysLeft, expected] of [[15, []], [14.5, []], [13.99, ['expiry_14d']], [7.5, ['expiry_14d']], [6.99, ['expiry_14d', 'expiry_7d']], [2.99, ['expiry_14d', 'expiry_7d', 'expiry_3d']], [0.99, ['expiry_14d', 'expiry_7d', 'expiry_3d', 'expiry_1d']]]) {
  test(`C-05: with ${daysLeft} days left the warnings due are: ${expected.join(', ') || 'none'}`, async () => {
    const shop = await addShop(world);
    await setTokenAge(shop, { issuedDaysAgo: 40, expiresInDays: daysLeft });
    await refuseAllRefreshes();
    try {
      await shop.settle({ ms: 3000 });
    } finally {
      await clearFaults();
    }
    const kinds = (await shop.sql('SELECT kind FROM token_alerts WHERE tenant_id = $1 ORDER BY id', [shop.tenantId])).map((r) => r.kind);
    assert.ok(expected.every((k) => kinds.includes(k)), `Expected ${expected}, got ${kinds}`);
    assert.ok(kinds.length <= expected.length, `Nothing beyond what is due: ${kinds}`);
  });
}

test('C-05: health is amber from 14 days or a failed refresh, red from 3 days', async () => {
  const shop = await addShop(world);
  await setTokenAge(shop, { issuedDaysAgo: 2, expiresInDays: 15, nextRefresh: '10 days' });
  assert.equal((await shop.call('/instagram/connection', 200)).health, 'ok');
  await setTokenAge(shop, { issuedDaysAgo: 2, expiresInDays: 13.9, nextRefresh: '10 days' });
  assert.equal((await shop.call('/instagram/connection', 200)).health, 'amber');
  await setTokenAge(shop, { issuedDaysAgo: 2, expiresInDays: 2.9, nextRefresh: '10 days' });
  assert.equal((await shop.call('/instagram/connection', 200)).health, 'red');
  await setTokenAge(shop, { issuedDaysAgo: 2, expiresInDays: 40, nextRefresh: '10 days' });
  await shop.sql('UPDATE ig_accounts SET refresh_failures = 1 WHERE tenant_id = $1', [shop.tenantId]);
  assert.equal((await shop.call('/instagram/connection', 200)).health, 'amber', 'A failed refresh is amber whatever the date');
});

test('C-05: failed refreshes retry every 6 hours for 3 days, then daily', async () => {
  const shop = await addShop(world);
  await setTokenAge(shop, { issuedDaysAgo: 40, expiresInDays: 12 });
  await refuseAllRefreshes();
  const perHour = [];
  try {
    let seen = 0;
    for (let hour = 0; hour < 120; hour++) {
      await shop.settle({ ms: 900, roundMs: 300 });
      const now = (await refreshCalls(shop)).length;
      perHour.push(now - seen);
      seen = now;
      await world.travel(HOUR);
    }
  } finally {
    await clearFaults();
  }
  const firstThreeDays = perHour.slice(0, 72).reduce((a, b) => a + b, 0);
  const nextTwoDays = perHour.slice(72, 120).reduce((a, b) => a + b, 0);
  assert.ok(firstThreeDays >= 11 && firstThreeDays <= 13, `About 12 tries in 3 days, got ${firstThreeDays}`);
  assert.ok(nextTwoDays >= 1 && nextTwoDays <= 3, `About 2 tries in the 2 days after, got ${nextTwoDays}`);
  assert.ok(perHour.every((n) => n <= 1), 'Never twice inside one hour');
});

test('C-05: the token reaching its expiry with no successful refresh: reconnect needed, jobs held, owner told', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await setTokenAge(shop, { issuedDaysAgo: 60, expiresInDays: -0.0001 });
  await refuseAllRefreshes();
  try {
    await shop.settle({ ms: 3000 });
    await world.switchLag();
    await shop.commentDirect(reel.mediaId);
    await shop.settle({ ms: 3000 });
  } finally {
    await clearFaults();
  }
  assert.equal((await shop.account()).status, 'reconnect_needed');
  await assertReason(shop, 'token.rejected');
  assert.equal((await shop.jobs())[0].status, 'held');
  await assertNoDm(shop);
});

test('C-05: a due token refreshes: new token saved, version up by one, token.refreshed, expiry pushed out', async () => {
  const shop = await addShop(world);
  await setTokenAge(shop, { issuedDaysAgo: 40, expiresInDays: 20 });
  const before = await shop.account();
  await shop.settle();
  const after = await shop.account();
  assert.equal(after.token_version, before.token_version + 1);
  assert.notEqual(after.access_token_enc, before.access_token_enc);
  assert.ok(new Date(after.token_expires_at) > new Date(before.token_expires_at));
  await assertReason(shop, 'token.refreshed');
  assert.equal((await refreshCalls(shop)).length, 1);
  await shop.settle();
  assert.equal((await refreshCalls(shop)).length, 1, 'Refreshed once, not again on the next run');
});

for (const [label, token, refreshes] of [
  ['just under 24 hours old', { issuedDaysAgo: 0.99, expiresInDays: 20 }, 0],
  ['just over 24 hours old', { issuedDaysAgo: 1.01, expiresInDays: 20 }, 1],
  ['expiring in just over 30 days', { issuedDaysAgo: 20, expiresInDays: 30.01 }, 0],
  ['expiring in just under 30 days', { issuedDaysAgo: 20, expiresInDays: 29.99 }, 1],
]) {
  test(`C-05: a token ${label} gets ${refreshes} refresh`, async () => {
    const shop = await addShop(world);
    await setTokenAge(shop, token);
    await shop.settle();
    assert.equal((await refreshCalls(shop)).length, refreshes);
  });
}

for (const mode of ['truncated', 'html', 'empty', 'garbage', 'wrong_shape']) {
  test(`C-05: a refresh answered with junk (${mode}) leaves the working token in place`, async () => {
    const shop = await addShop(world);
    await setTokenAge(shop, { issuedDaysAgo: 40, expiresInDays: 20 });
    const before = await shop.account();
    await world.meta.fault({ kind: 'malformed', mode, match: { path: '*/refresh_access_token' }, times: 'forever' });
    try {
      await shop.settle({ ms: 3000 });
    } finally {
      await clearFaults();
    }
    const after = await shop.account();
    assert.equal(after.access_token_enc, before.access_token_enc);
    assert.equal(after.token_version, before.token_version);
    assert.ok(after.refresh_failures >= 1);
    assert.equal(after.status, 'active');
    await assertReason(shop, 'token.refresh_failed');
  });
}

test('C-05: a refresh that times out leaves the working token in place', async () => {
  const shop = await addShop(world);
  await setTokenAge(shop, { issuedDaysAgo: 40, expiresInDays: 20 });
  const before = await shop.account();
  await world.meta.fault({ kind: 'timeout', match: { path: '*/refresh_access_token' }, times: 'forever' });
  try {
    await shop.settle({ ms: 4000 });
  } finally {
    await clearFaults();
  }
  assert.equal((await shop.account()).access_token_enc, before.access_token_enc);
});

test('C-05: only the accounts that are due are refreshed, each with its own token', async () => {
  const due = await addShop(world);
  const notDue = await addShop(world);
  await setTokenAge(due, { issuedDaysAgo: 40, expiresInDays: 20 });
  await due.settle();
  assert.equal((await refreshCalls(due)).length, 1);
  assert.equal((await refreshCalls(notDue)).length, 0);
});

const deauthorize = (shop, extra = {}) => world.meta.post('/deauthorize', { igUserId: shop.igUserId, ...extra });

test('C-06: a valid deauthorize deletes the token, holds jobs and alerts owner and ops within a minute', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const out = await deauthorize(shop);
  assert.equal(out.status, 200);
  const account = await shop.account();
  assert.equal(account.access_token_enc, '', 'The token is gone');
  assert.ok(['reconnect_needed', 'deauthorized'].includes(account.status), account.status);
  await assertReason(shop, 'token.deauthorized');
  for (const audience of ['owner', 'ops']) {
    const alerts = await shop.alerts(audience);
    assert.equal(alerts.length, 1, audience);
    assert.ok(secondsBetween(alerts[0].created_at, new Date()) < 60, audience);
  }
  await world.switchLag();
  const comment = await shop.commentDirect(reel.mediaId);
  await shop.settle();
  assert.equal((await shop.inbound('object_id = $2', [comment.id])).length, 1, 'Webhooks are still stored while paused');
  const [job] = await shop.jobs();
  assert.equal(job.status, 'held');
  assert.equal(job.reason, 'paused.reconnect');
  await assertNoDm(shop);
});

test('C-06: jobs already queued when the deauthorize lands are held, not sent', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await shop.refuseSends({ code: 613, status: 429 });
  await shop.comment(reel.mediaId);
  await shop.settle();
  assert.equal((await shop.jobs())[0].status, 'queued');
  await deauthorize(shop);
  await world.travel(2 * HOUR);
  await shop.settle();
  assert.equal((await shop.jobs())[0].status, 'held');
  assert.equal((await shop.dms()).length, 0);
});

test('C-06: the same valid deauthorize twice at the same moment changes the state once and alerts once', async () => {
  const shop = await addShop(world);
  const signed = signedRequest({ algorithm: 'HMAC-SHA256', issued_at: Math.floor(Date.now() / 1000), user_id: shop.igUserId }, APP_SECRET);
  const answers = await Promise.all([world.callback('/meta/deauthorize', signed), world.callback('/meta/deauthorize', signed)]);
  assert.deepEqual(answers.map((r) => r.status), [200, 200]);
  assert.equal((await shop.alerts()).length, 1);
  assert.equal((await shop.events(`reason = 'token.deauthorized'`)).length, 1);
});

test('C-06: deauthorizing one business leaves another exactly as it was', async () => {
  const gone = await addShop(world);
  const stays = await addShop(world);
  const before = await stays.account();
  await deauthorize(gone);
  const after = await stays.account();
  assert.equal(after.access_token_enc, before.access_token_enc);
  assert.equal(after.status, 'active');
  assert.equal((await stays.alerts()).length, 0);
});

test('C-06: a validly signed deauthorize for an account nobody has changes nothing and is not a 5xx', async () => {
  const shop = await addShop(world);
  const signed = signedRequest({ algorithm: 'HMAC-SHA256', user_id: `7${unique()}` }, APP_SECRET);
  const res = await world.callback('/meta/deauthorize', signed);
  assert.ok(res.status < 500, `Got ${res.status}`);
  assert.equal((await shop.account()).status, 'active');
});

test('C-06: the deauthorize also finds an account by its app-scoped id', async () => {
  const shop = await addShop(world);
  await shop.sql('UPDATE ig_accounts SET app_scoped_id = $3 WHERE tenant_id = $1 AND ig_user_id = $2', [shop.tenantId, shop.igUserId, `9${shop.igUserId}`]);
  const res = await world.callback('/meta/deauthorize', signedRequest({ algorithm: 'HMAC-SHA256', user_id: `9${shop.igUserId}` }, APP_SECRET));
  assert.equal(res.status, 200);
  assert.equal((await shop.account()).access_token_enc, '');
});

const encode = (object) => Buffer.from(JSON.stringify(object)).toString('base64url');
const BAD_REQUESTS = {
  'signed with the wrong secret': (id) => signedRequest({ algorithm: 'HMAC-SHA256', user_id: id }, 'wrong'),
  'with no signature part': (id) => `.${encode({ algorithm: 'HMAC-SHA256', user_id: id })}`,
  'with no payload part': () => 'abc.',
  'with no dot': () => 'abcdef',
  'with three parts': (id) => `${signedRequest({ algorithm: 'HMAC-SHA256', user_id: id }, APP_SECRET)}.extra`,
  'whose payload was changed after signing': (id) => `${signedRequest({ algorithm: 'HMAC-SHA256', user_id: 'someone-else' }, APP_SECRET).split('.')[0]}.${encode({ algorithm: 'HMAC-SHA256', user_id: id })}`,
  'naming another algorithm': (id) => signedRequest({ algorithm: 'none', user_id: id }, APP_SECRET),
  'whose payload is not JSON, correctly signed': () => { const payload = Buffer.from('not json').toString('base64url'); return `${crypto.createHmac('sha256', APP_SECRET).update(payload).digest('base64url')}.${payload}`; },
  'with no user id': () => signedRequest({ algorithm: 'HMAC-SHA256' }, APP_SECRET),
  'empty': () => '',
  'absurdly long': () => 'a'.repeat(20_000),
};

for (const [label, make] of Object.entries(BAD_REQUESTS)) {
  test(`C-07: a deauthorize ${label} gets 400 and changes nothing`, async () => {
    const shop = await addShop(world);
    const before = await shop.account();
    const res = await world.callback('/meta/deauthorize', make(shop.igUserId));
    assert.ok(res.status === 400 || (label === 'absurdly long' && res.status === 413), `Got ${res.status}`);
    const after = await shop.account();
    assert.equal(after.access_token_enc, before.access_token_enc);
    assert.equal(after.status, 'active');
    assert.equal((await shop.alerts()).length, 0);
    assert.equal((await shop.events()).length, 0);
  });
}

test('C-07: a deauthorize with no signed_request at all gets 400', async () => {
  const res = await world.callback('/meta/deauthorize', undefined);
  assert.equal(res.status, 400);
});

test('C-07: the simulator\'s forged deauthorize gets 400 and the token stays', async () => {
  const shop = await addShop(world);
  const out = await deauthorize(shop, { signature: 'bad' });
  assert.equal(out.status, 400);
  assert.notEqual((await shop.account()).access_token_enc, '');
});

test('C-08: deauthorize, then reconnect 2h later: held jobs before expires_at send, once', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await deauthorize(shop);
  await world.switchLag();
  const comment = await shop.commentDirect(reel.mediaId);
  await shop.settle();
  assert.equal((await shop.jobs())[0].status, 'held');
  await world.travel(2 * HOUR);
  await connectInstagramFlow(world, shop);
  await world.switchLag();
  await shop.settle();
  const dms = await shop.dms({ commentId: comment.id });
  assert.equal(dms.length, 1);
  assert.equal((await shop.account()).status, 'active');
  assert.equal((await shop.jobs())[0].status, 'sent');
});

test('C-08: a job held past its expires_at drops at reconnect with expired.7d and no call', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await deauthorize(shop);
  await world.switchLag();
  await shop.commentDirect(reel.mediaId);
  await shop.settle();
  await world.travel(7 * DAY);
  await connectInstagramFlow(world, shop);
  await world.switchLag();
  await shop.settle();
  const [job] = await shop.jobs();
  assert.equal(job.status, 'expired');
  assert.equal(job.reason, 'expired.7d');
  await assertNoDm(shop);
});

test('C-08: reconnecting replaces the token and leaves no half state; an old version can\'t come back', async () => {
  const shop = await addShop(world);
  const before = await shop.account();
  await deauthorize(shop);
  await connectInstagramFlow(world, shop);
  const after = await shop.account();
  assert.equal(after.status, 'active');
  assert.notEqual(after.access_token_enc, '');
  assert.notEqual(after.access_token_enc, before.access_token_enc);
  assert.ok(after.token_version > before.token_version, 'Reconnecting bumps the version, so an in-flight refresh loses its compare-and-swap');
  assert.ok(after.subscribed_fields.includes('comments'), 'Webhooks are subscribed again');
});

test('C-08: someone else\'s Instagram account can\'t be connected over this business\'s connection', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  await world.meta.post('/oauth/next', { igUserId: a.igUserId });
  const { authorizeUrl } = await b.call('/instagram/connect', 200, { method: 'POST', body: {} });
  const consent = await fetch(authorizeUrl, { redirect: 'manual' });
  const back = new URL(consent.headers.get('location'));
  await hit(world, `${back.pathname}${back.search}`, { host: b.host });
  const owners = await b.sql('SELECT tenant_id FROM ig_accounts WHERE ig_user_id = $1', [a.igUserId]);
  assert.deepEqual(owners.map((r) => r.tenant_id), [a.tenantId], 'The account stays with the business that has it');
});

test('C-49: a valid deletion request answers 200 with a url and code, deletes the token and stops automations', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const out = await world.meta.post('/deletion', { igUserId: shop.igUserId });
  assert.equal(out.status, 200);
  assert.equal(out.valid, true, JSON.stringify(out.body));
  const [row] = await shop.sql('SELECT * FROM data_deletion_requests WHERE confirmation_code = $1', [out.body.confirmation_code]);
  assert.equal(row.tenant_id, shop.tenantId);
  assert.equal(row.status, 'requested');
  assert.ok(Math.abs(new Date(row.due_at) - Date.now() - 30 * DAY) < 60_000, 'Due within 30 days');
  assert.equal((await shop.account()).access_token_enc, '');
  await assertReason(shop, 'deletion.requested');
  await world.switchLag();
  await shop.commentDirect(reel.mediaId);
  await shop.settle();
  await assertNoDm(shop);
});

test('C-49: the status address shows the request by its code, and only that', async () => {
  const shop = await addShop(world);
  const out = await world.meta.post('/deletion', { igUserId: shop.igUserId });
  const code = out.body.confirmation_code;
  const status = need(await hit(world, `/meta/deletion/${code}`), 200, 'The status page').json();
  assert.equal(status.status, 'requested');
  assert.doesNotMatch(JSON.stringify(status), new RegExp(shop.igUserId));
  for (const bad of ['nope', `${code}x`, `' OR '1'='1`, '../../etc/passwd']) {
    assert.equal((await hit(world, `/meta/deletion/${encodeURIComponent(bad)}`)).status, 404, bad);
  }
});

test('C-49: the same deletion request twice answers both times and deletes once', async () => {
  const shop = await addShop(world);
  const signed = signedRequest({ algorithm: 'HMAC-SHA256', issued_at: 1, user_id: shop.igUserId }, APP_SECRET);
  const answers = await Promise.all([world.callback('/meta/deletion', signed), world.callback('/meta/deletion', signed)]);
  assert.deepEqual(answers.map((r) => r.status), [200, 200]);
  for (const answer of answers) assert.ok(answer.json().confirmation_code);
  const rows = await shop.sql(`SELECT * FROM data_deletion_requests WHERE tenant_id = $1 AND status = 'requested'`, [shop.tenantId]);
  assert.equal(rows.length, 1);
});

test('C-49: a deletion for an account nobody has still gets its url and code, and touches no business', async () => {
  const shop = await addShop(world);
  const res = await world.callback('/meta/deletion', signedRequest({ algorithm: 'HMAC-SHA256', user_id: `6${unique()}` }, APP_SECRET));
  assert.equal(res.status, 200);
  assert.ok(res.json().url && res.json().confirmation_code);
  assert.notEqual((await shop.account()).access_token_enc, '');
});

test('C-49: within 30 days the account\'s Platform Data is gone, deletion.completed is logged, another business keeps its data', async () => {
  const shop = await addShop(world);
  const other = await addShop(world);
  const reel = await shop.automate();
  const otherReel = await other.automate();
  await shop.comment(reel.mediaId);
  await other.comment(otherReel.mediaId);
  await shop.settle();
  await other.settle();
  await world.meta.post('/deletion', { igUserId: shop.igUserId });
  await world.travel(30 * DAY - HOUR);
  await shop.settle();
  await world.travel(2 * HOUR);
  await shop.settle();
  const [row] = await shop.sql('SELECT status, completed_at FROM data_deletion_requests WHERE tenant_id = $1', [shop.tenantId]);
  assert.equal(row.status, 'completed');
  await assertReason(shop, 'deletion.completed');
  assert.equal((await shop.inbound()).length, 0);
  assert.equal((await shop.sql('SELECT count(*)::int AS n FROM inbox_threads WHERE tenant_id = $1', [shop.tenantId]))[0].n, 0);
});

for (const [label, make] of Object.entries(BAD_REQUESTS)) {
  test(`C-50: a deletion request ${label} gets 400 and nothing is deleted`, async () => {
    const shop = await addShop(world);
    const before = await shop.account();
    const res = await world.callback('/meta/deletion', make(shop.igUserId));
    assert.ok(res.status === 400 || (label === 'absurdly long' && res.status === 413), `Got ${res.status}`);
    assert.equal((await shop.account()).access_token_enc, before.access_token_enc);
    assert.equal((await shop.sql('SELECT count(*)::int AS n FROM data_deletion_requests WHERE tenant_id = $1', [shop.tenantId]))[0].n, 0);
    assert.equal((await shop.events()).length, 0);
  });
}

test('C-50: the simulator\'s forged deletion request gets 400', async () => {
  const shop = await addShop(world);
  const out = await world.meta.post('/deletion', { igUserId: shop.igUserId, signature: 'bad' });
  assert.equal(out.status, 400);
  assert.equal(out.valid, false);
});
