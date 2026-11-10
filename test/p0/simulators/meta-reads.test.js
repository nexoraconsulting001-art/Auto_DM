import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERRORS, SCOPES } from '../../../tools/sim/meta/index.mjs';
import { ACCOUNT, DAY, OTHER, SUBSCRIBED, T0, addComment, bearer, errorCode, errorSubcode, graphGet, graphPost, graphUrl, privateReply, request, sent, startMeta } from './support.js';

const seedMedia = (meta, id, extra = {}) => meta.post('/media', { igUserId: ACCOUNT.igUserId, id, caption: `Caption ${id}`, ...extra });
const usage = (res) => {
  const header = res.headers.get('x-business-use-case-usage');
  return header ? JSON.parse(header)[ACCOUNT.igUserId][0] : null;
};

test('account read returns the fields asked for, and always id', async (t) => {
  const meta = await startMeta(t);
  await meta.post('/accounts', { igUserId: '777', username: 'fuller', token: 't777', name: 'Fuller Store', followersCount: 12, followsCount: 3, biography: 'Bio', website: 'https://x.example', accountType: 'MEDIA_CREATOR', profilePictureUrl: 'https://cdn.example/p.jpg' });
  await meta.post('/media', { igUserId: '777', caption: 'one' });
  const res = await graphGet(meta, 'me', { token: 't777', query: { fields: 'user_id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count,biography,website' } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { user_id: '777', username: 'fuller', name: 'Fuller Store', account_type: 'MEDIA_CREATOR', profile_picture_url: 'https://cdn.example/p.jpg', followers_count: 12, follows_count: 3, media_count: 1, biography: 'Bio', website: 'https://x.example', id: '9777' });
  assert.deepEqual((await graphGet(meta, 'me', { token: 't777' })).body, { id: '9777' }, 'with no fields, only id');
});

test('an account read by id, and by another business, are told apart', async (t) => {
  const meta = await startMeta(t);
  await meta.post('/accounts', OTHER);
  assert.equal((await graphGet(meta, ACCOUNT.igUserId, { query: { fields: 'username' } })).body.username, ACCOUNT.username);
  const res = await graphGet(meta, OTHER.igUserId, { query: { fields: 'username' } });
  assert.deepEqual([errorCode(res), errorSubcode(res)], [100, 33]);
  assert.doesNotMatch(res.text, /leaf/);
});

test('a field a node does not have is refused, including prototype names', async (t) => {
  const meta = await startMeta(t);
  for (const field of ['nope', 'constructor', '__proto__', 'toString']) {
    const res = await graphGet(meta, 'me', { query: { fields: `username,${field}` } });
    assert.equal(errorCode(res), ERRORS.INVALID_PARAM.code, field);
    assert.match(res.body.error.message, /nonexisting field/);
  }
});

test('media list is newest first and pages with cursors', async (t) => {
  const meta = await startMeta(t);
  for (let i = 1; i <= 5; i++) await seedMedia(meta, `m${i}`, { at: T0 + i });
  const first = await graphGet(meta, `${ACCOUNT.igUserId}/media`, { query: { fields: 'id,caption', limit: '2' } });
  assert.deepEqual(first.body.data.map((m) => m.id), ['m5', 'm4']);
  assert.ok(first.body.paging.cursors.after);
  assert.ok(first.body.paging.next);

  const second = await request(first.body.paging.next, { headers: bearer(ACCOUNT.token) });
  assert.deepEqual(second.body.data.map((m) => m.id), ['m3', 'm2']);
  const last = await request(second.body.paging.next, { headers: bearer(ACCOUNT.token) });
  assert.deepEqual(last.body.data.map((m) => m.id), ['m1']);
  assert.equal(last.body.paging.next, undefined);

  const beyond = await graphGet(meta, 'me/media', { query: { after: last.body.paging.cursors.after } });
  assert.deepEqual(beyond.body, { data: [] });
});

test('media ties on time come back latest-created first', async (t) => {
  const meta = await startMeta(t);
  await seedMedia(meta, 'first');
  await seedMedia(meta, 'second');
  assert.deepEqual((await graphGet(meta, 'me/media')).body.data.map((m) => m.id), ['second', 'first']);
});

test('media paging clamps a silly limit and refuses a bad cursor', async (t) => {
  const meta = await startMeta(t);
  for (let i = 0; i < 3; i++) await seedMedia(meta, `m${i}`);
  assert.equal((await graphGet(meta, 'me/media', { query: { limit: '0' } })).body.data.length, 3);
  assert.equal((await graphGet(meta, 'me/media', { query: { limit: '100000' } })).body.data.length, 3);
  assert.equal((await graphGet(meta, 'me/media', { query: { limit: 'x' } })).body.data.length, 3);
  for (const after of ['%%%', Buffer.from('-1').toString('base64url'), Buffer.from('x').toString('base64url')]) {
    assert.equal(errorCode(await graphGet(meta, 'me/media', { query: { after } })), ERRORS.INVALID_PARAM.code, after);
  }
  assert.equal((await graphGet(meta, 'me/media', { query: { after: '' } })).body.data.length, 3, 'an empty cursor is no cursor');
});

test('a media read returns its fields, and no other business can read it', async (t) => {
  const meta = await startMeta(t);
  await seedMedia(meta, 'm1', { productType: 'REELS', mediaType: 'VIDEO', permalink: 'https://www.instagram.com/reel/x/', likeCount: 4 });
  await addComment(meta, { mediaId: 'm1' });
  const res = await graphGet(meta, 'm1', { query: { fields: 'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,username' } });
  assert.deepEqual(res.body, { id: 'm1', caption: 'Caption m1', media_type: 'VIDEO', media_product_type: 'REELS', permalink: 'https://www.instagram.com/reel/x/', timestamp: '2026-11-01T12:00:00+0000', like_count: 4, comments_count: 1, username: ACCOUNT.username });

  await meta.post('/accounts', OTHER);
  for (const path of ['m1', 'm1/comments', 'm1/insights']) {
    const denied = await graphGet(meta, path, { token: OTHER.token, query: { metric: 'reach' } });
    assert.equal(errorCode(denied), ERRORS.OBJECT_NOT_FOUND.code, path);
  }
  const list = await graphGet(meta, 'me/media', { token: OTHER.token });
  assert.deepEqual(list.body, { data: [] });
});

test('comments can be read, with their time, author and media', async (t) => {
  const meta = await startMeta(t);
  const id = await addComment(meta, { mediaId: 'm1', text: 'LINK please', from: { id: 'u5', username: 'asha' } });
  const res = await graphGet(meta, id, { query: { fields: 'id,text,timestamp,username,from{id,username},media{id},like_count,hidden' } });
  assert.deepEqual(res.body, { id, text: 'LINK please', timestamp: '2026-11-01T12:00:00+0000', username: 'asha', from: { id: 'u5', username: 'asha' }, media: { id: 'm1', media_product_type: 'REELS' }, like_count: 0, hidden: false });
});

test('comments list shows top-level comments; replies shows the thread; deleted ones vanish', async (t) => {
  const meta = await startMeta(t);
  const a = await addComment(meta, { mediaId: 'm1', text: 'first' });
  const b = await addComment(meta, { mediaId: 'm1', text: 'second' });
  const reply = await addComment(meta, { mediaId: 'm1', text: 'threaded', parentId: a });
  assert.deepEqual((await graphGet(meta, 'm1/comments', { query: { fields: 'text' } })).body.data.map((c) => c.id), [b, a]);
  assert.deepEqual((await graphGet(meta, `${a}/replies`)).body.data.map((c) => c.id), [reply]);

  await meta.post('/comments/delete', { id: b });
  assert.deepEqual((await graphGet(meta, 'm1/comments')).body.data.map((c) => c.id), [a]);
  assert.equal(errorCode(await graphGet(meta, b)), ERRORS.OBJECT_NOT_FOUND.code);
});

test('a public reply posts under the comment and is limited to 2200 characters', async (t) => {
  const meta = await startMeta(t);
  const id = await addComment(meta);
  const res = await request(graphUrl(meta, `${id}/replies`, { message: 'Check your DMs' }), { method: 'POST', headers: bearer(ACCOUNT.token) });
  assert.equal(res.status, 200);
  assert.ok(res.body.id);
  const [public1] = await sent(meta, { kind: 'public_reply' });
  assert.deepEqual([public1.commentId, public1.message.text], [id, 'Check your DMs']);
  const thread = await graphGet(meta, `${id}/replies`, { query: { fields: 'text,from' } });
  assert.deepEqual(thread.body.data[0].from, { id: ACCOUNT.igUserId, username: ACCOUNT.username });

  assert.equal((await graphPost(meta, `${id}/replies`, { message: 'y'.repeat(2200) })).status, 200);
  assert.equal(errorCode(await graphPost(meta, `${id}/replies`, { message: 'y'.repeat(2201) })), ERRORS.INVALID_PARAM.code);
  assert.equal(errorCode(await graphPost(meta, `${id}/replies`, {})), ERRORS.INVALID_PARAM.code);
});

test('a public reply does not use up the comment\'s one private reply', async (t) => {
  const meta = await startMeta(t);
  const id = await addComment(meta);
  await graphPost(meta, `${id}/replies`, { message: 'hi' });
  assert.equal((await privateReply(meta, id)).status, 200);
});

test('one business cannot reply publicly on another\'s comment', async (t) => {
  const meta = await startMeta(t);
  await meta.post('/accounts', OTHER);
  const theirs = await addComment(meta, { account: OTHER, mediaId: 'their-reel' });
  assert.equal(errorCode(await graphPost(meta, `${theirs}/replies`, { message: 'hi' })), ERRORS.OBJECT_NOT_FOUND.code);
});

test('reads need the matching permission', async (t) => {
  const meta = await startMeta(t);
  const id = await addComment(meta, { mediaId: 'm1' });
  await meta.post('/tokens', { igUserId: ACCOUNT.igUserId, value: 'basic-only', scopes: [SCOPES.basic] });
  await meta.post('/tokens', { igUserId: ACCOUNT.igUserId, value: 'comments-only', scopes: [SCOPES.comments] });
  const basic = { token: 'basic-only' };
  assert.equal(errorCode(await graphGet(meta, id, basic)), ERRORS.PERMISSION.code);
  assert.equal(errorCode(await graphGet(meta, 'm1/comments', basic)), ERRORS.PERMISSION.code);
  assert.equal(errorCode(await graphGet(meta, `${id}/replies`, basic)), ERRORS.PERMISSION.code);
  assert.equal(errorCode(await graphPost(meta, `${id}/replies`, { message: 'x' }, basic)), ERRORS.PERMISSION.code);
  assert.equal(errorCode(await graphGet(meta, 'me/insights', { ...basic, query: { metric: 'reach' } })), ERRORS.PERMISSION.code);

  const comments = { token: 'comments-only' };
  assert.equal(errorCode(await graphGet(meta, 'me', comments)), ERRORS.PERMISSION.code);
  assert.equal(errorCode(await graphGet(meta, 'me/media', comments)), ERRORS.PERMISSION.code);
  assert.equal(errorCode(await graphGet(meta, 'm1', comments)), ERRORS.PERMISSION.code);
});

test('subscribed_apps: subscribe, read back, replace and clear', async (t) => {
  const meta = await startMeta(t);
  const path = `${ACCOUNT.igUserId}/subscribed_apps`;
  assert.deepEqual((await graphGet(meta, path)).body, { data: [] });

  const res = await request(graphUrl(meta, path, { subscribed_fields: SUBSCRIBED.join(',') }), { method: 'POST', headers: bearer(ACCOUNT.token) });
  assert.deepEqual([res.status, res.body], [200, { success: true }]);
  assert.deepEqual((await graphGet(meta, path)).body.data[0].subscribed_fields, SUBSCRIBED);

  await graphPost(meta, path, { subscribed_fields: ['comments'] });
  assert.deepEqual((await graphGet(meta, path)).body.data[0].subscribed_fields, ['comments'], 'a POST replaces the list');
  await graphPost(meta, 'me/subscribed_apps', { subscribed_fields: '["messages"]' });
  assert.deepEqual((await graphGet(meta, path)).body.data[0].subscribed_fields, ['messages']);

  assert.equal((await request(graphUrl(meta, path), { method: 'DELETE', headers: bearer(ACCOUNT.token) })).status, 200);
  assert.deepEqual((await graphGet(meta, path)).body, { data: [] });
});

test('subscribed_apps refuses an unknown or empty field list and leaves the old one', async (t) => {
  const meta = await startMeta(t);
  const path = `${ACCOUNT.igUserId}/subscribed_apps`;
  await graphPost(meta, path, { subscribed_fields: 'comments' });
  assert.equal(errorCode(await graphPost(meta, path, { subscribed_fields: 'comments,nope' })), ERRORS.INVALID_PARAM.code);
  assert.equal(errorCode(await graphPost(meta, path, { subscribed_fields: '' })), ERRORS.INVALID_PARAM.code);
  assert.equal(errorCode(await graphPost(meta, path, { subscribed_fields: 'constructor' })), ERRORS.INVALID_PARAM.code);
  assert.equal(errorCode(await graphPost(meta, path, {})), ERRORS.INVALID_PARAM.code);
  assert.deepEqual((await graphGet(meta, path)).body.data[0].subscribed_fields, ['comments']);
});

test('subscribing needs the scope behind each field (PRD gate.scope_missing)', async (t) => {
  const meta = await startMeta(t);
  await meta.post('/tokens', { igUserId: ACCOUNT.igUserId, value: 'msgs', scopes: [SCOPES.basic, SCOPES.messages] });
  await meta.post('/tokens', { igUserId: ACCOUNT.igUserId, value: 'cmts', scopes: [SCOPES.basic, SCOPES.comments] });
  assert.equal(errorCode(await graphPost(meta, 'me/subscribed_apps', { subscribed_fields: 'comments' }, { token: 'msgs' })), ERRORS.PERMISSION.code);
  assert.equal(errorCode(await graphPost(meta, 'me/subscribed_apps', { subscribed_fields: 'messages' }, { token: 'cmts' })), ERRORS.PERMISSION.code);
  assert.equal((await graphPost(meta, 'me/subscribed_apps', { subscribed_fields: 'messages' }, { token: 'msgs' })).status, 200);
});

test('one business cannot read or change another\'s subscriptions', async (t) => {
  const meta = await startMeta(t);
  await meta.post('/accounts', OTHER);
  const path = `${OTHER.igUserId}/subscribed_apps`;
  assert.equal(errorCode(await graphGet(meta, path)), ERRORS.OBJECT_NOT_FOUND.code);
  assert.equal(errorCode(await graphPost(meta, path, { subscribed_fields: 'comments' })), ERRORS.OBJECT_NOT_FOUND.code);
  assert.deepEqual((await graphGet(meta, path, { token: OTHER.token })).body, { data: [] });
});

test('insights return seeded values, zero otherwise, for an account or its media', async (t) => {
  const meta = await startMeta(t);
  await seedMedia(meta, 'm1');
  await meta.post('/insights', { id: 'm1', metrics: { reach: 120, shares: 3 } });
  await meta.post('/insights', { id: ACCOUNT.igUserId, metrics: { reach: 900 } });
  const media = await graphGet(meta, 'm1/insights', { query: { metric: 'reach,shares,saved' } });
  assert.deepEqual(media.body.data.map((m) => [m.name, m.values[0].value]), [['reach', 120], ['shares', 3], ['saved', 0]]);
  const account = await graphGet(meta, 'me/insights', { query: { metric: 'reach', period: 'day' } });
  assert.deepEqual([account.body.data[0].period, account.body.data[0].values[0].value], ['day', 900]);
  assert.equal(errorCode(await graphGet(meta, 'm1/insights', { query: { metric: 'nope' } })), ERRORS.INVALID_PARAM.code);
  assert.equal(errorCode(await graphGet(meta, 'm1/insights')), ERRORS.INVALID_PARAM.code);
});

test('every Graph response names the app version and a trace id', async (t) => {
  const meta = await startMeta(t);
  const res = await graphGet(meta, 'me');
  assert.ok(res.headers.get('x-fb-trace-id'));
  assert.ok(res.headers.get('facebook-api-version'));
});

test('an unknown path answers in Graph\'s shape', async (t) => {
  const meta = await startMeta(t);
  const res = await request(`${meta.url}/v23.0/a/b/c`);
  assert.deepEqual([res.status, errorCode(res)], [400, ERRORS.UNKNOWN_PATH.code]);
  assert.equal((await request(`${meta.url}/v23.0`)).status, 400);
});

test('a body Graph cannot parse is a 100', async (t) => {
  const meta = await startMeta(t);
  const res = await request(graphUrl(meta, 'me/messages'), { method: 'POST', headers: { 'content-type': 'application/json', ...bearer(ACCOUNT.token) }, body: '{nope' });
  assert.deepEqual([res.status, errorCode(res)], [400, ERRORS.INVALID_PARAM.code]);
});

test('the usage header counts calls against the account\'s BUC bucket', async (t) => {
  const meta = await startMeta(t, { limits: { bucPerImpression: 10 } });
  assert.deepEqual(usage(await graphGet(meta, 'me')), { type: 'instagram', call_count: 10, total_cputime: 10, total_time: 10, estimated_time_to_regain_access: 0 });
  assert.equal(usage(await graphGet(meta, 'me')).call_count, 20);
});

test('the bucket scales with impressions and the 24 hours roll', async (t) => {
  const meta = await startMeta(t, { limits: { bucPerImpression: 10 } }, { account: { ...ACCOUNT, impressions: 2 } });
  assert.equal(usage(await graphGet(meta, 'me')).call_count, 5);
  await meta.post('/clock', { advanceMs: DAY - 1 });
  assert.equal(usage(await graphGet(meta, 'me')).call_count, 10);
  await meta.post('/clock', { advanceMs: 1 });
  assert.equal(usage(await graphGet(meta, 'me')).call_count, 10, 'the first call has aged out');
});

test('a full bucket answers 80002 with the time to regain access', async (t) => {
  const meta = await startMeta(t, { limits: { bucPerImpression: 2 } });
  await graphGet(meta, 'me');
  await meta.post('/clock', { advanceMs: 3_600_000 });
  await graphGet(meta, 'me');
  const res = await graphGet(meta, 'me');
  assert.deepEqual([res.status, errorCode(res)], [400, ERRORS.BUC_THROTTLED.code]);
  const header = usage(res);
  assert.equal(header.call_count, 100);
  assert.equal(header.estimated_time_to_regain_access, 23 * 60);
});

test('messaging is outside the BUC bucket and keeps working when it is full', async (t) => {
  const meta = await startMeta(t);
  await meta.post('/usage', { igUserId: ACCOUNT.igUserId, percent: 100, regainMinutes: 30 });
  const id = await addComment(meta);
  const reply = await privateReply(meta, id);
  assert.equal(reply.status, 200);
  assert.equal(usage(reply).call_count, 100, 'a BUC header can still appear on a messaging response');
  await meta.post('/messages', { igUserId: ACCOUNT.igUserId, from: 'p', text: 'hi' });
  assert.equal((await graphPost(meta, `${ACCOUNT.igUserId}/messages`, { recipient: { id: 'p' }, message: { text: 'x' } })).status, 200);
});

test('messaging calls do not count towards the bucket', async (t) => {
  const meta = await startMeta(t, { limits: { bucPerImpression: 10 } });
  for (let i = 0; i < 3; i++) await privateReply(meta, await addComment(meta));
  assert.equal(usage(await graphGet(meta, 'me')).call_count, 10);
});

test('a forced usage percent drives the header: 78% and 92% still answer, 100% refuses', async (t) => {
  const meta = await startMeta(t);
  await seedMedia(meta, 'm1');
  await meta.post('/usage', { igUserId: ACCOUNT.igUserId, percent: 78 });
  const at78 = await graphGet(meta, 'm1/insights', { query: { metric: 'reach' } });
  assert.deepEqual([at78.status, usage(at78).call_count, usage(at78).estimated_time_to_regain_access], [200, 78, 0]);

  await meta.post('/usage', { igUserId: ACCOUNT.igUserId, percent: 92 });
  assert.equal(usage(await graphGet(meta, 'me')).total_cputime, 92);

  await meta.post('/usage', { igUserId: ACCOUNT.igUserId, percent: 100, regainMinutes: 12 });
  const full = await graphGet(meta, 'm1/insights', { query: { metric: 'reach' } });
  assert.equal(errorCode(full), ERRORS.BUC_THROTTLED.code);
  assert.equal(usage(full).estimated_time_to_regain_access, 12);

  await meta.post('/usage', { igUserId: ACCOUNT.igUserId, percent: null });
  assert.equal((await graphGet(meta, 'me')).status, 200);
  await assert.rejects(() => meta.post('/usage', { igUserId: ACCOUNT.igUserId, percent: 'most' }), /percent/);
  await assert.rejects(() => meta.post('/usage', { igUserId: ACCOUNT.igUserId, percent: 100, regainMinutes: 'soon' }), /regainMinutes/);
});

test('one account\'s full bucket does not touch another\'s', async (t) => {
  const meta = await startMeta(t);
  await meta.post('/accounts', OTHER);
  await meta.post('/usage', { igUserId: ACCOUNT.igUserId, percent: 100 });
  assert.equal(errorCode(await graphGet(meta, 'me')), ERRORS.BUC_THROTTLED.code);
  assert.equal((await graphGet(meta, 'me', { token: OTHER.token })).status, 200);
});

test('injected rate limits use each of Meta\'s throttle codes', async (t) => {
  const meta = await startMeta(t);
  for (const [code, status] of [[4, undefined], [17, 400], [32, 400], [613, 400]]) {
    await meta.fault({ kind: 'rate_limit', code, ...(status ? { status } : {}), match: { path: '*/me' } });
    const res = await graphGet(meta, 'me');
    assert.equal(res.status, status ?? 429);
    assert.equal(errorCode(res), code);
    assert.equal(res.body.error.type, 'OAuthException');
    assert.match(res.body.error.message, new RegExp(`#${code}`));
  }
});

test('an injected 80002 carries the regain time in the usage header', async (t) => {
  const meta = await startMeta(t);
  await seedMedia(meta, 'm1');
  await meta.fault({ kind: 'rate_limit', code: 80002, status: 400, regainMinutes: 7, match: { path: '*/insights' } });
  const res = await graphGet(meta, 'm1/insights', { query: { metric: 'reach' } });
  assert.equal(errorCode(res), 80002);
  assert.deepEqual([usage(res).call_count, usage(res).estimated_time_to_regain_access], [100, 7]);
});

test('an injected 5xx looks like Graph\'s transient error', async (t) => {
  const meta = await startMeta(t);
  await meta.fault({ kind: 'server_error', status: 502 });
  const res = await graphGet(meta, 'me');
  assert.deepEqual([res.status, errorCode(res), res.body.error.is_transient], [502, 1, true]);
});

test('malformed and dropped responses work on Graph routes', async (t) => {
  const meta = await startMeta(t);
  await meta.fault({ kind: 'malformed', mode: 'html' });
  const html = await graphGet(meta, 'me');
  assert.equal(html.body, null);
  await meta.fault({ kind: 'drop' });
  assert.equal((await graphGet(meta, 'me')).status, null);
});

test('reset returns to the start, keeping the app settings given at creation', async (t) => {
  const meta = await startMeta(t, { app: { secret: 'kept' } });
  await addComment(meta);
  await meta.post('/reset');
  assert.equal(errorCode(await graphGet(meta, 'me')), ERRORS.TOKEN_INVALID.code);
  assert.deepEqual(await sent(meta), []);
  assert.equal((await meta.post('/app', {})).secret, undefined, 'the control response never echoes the secret');
});

test('seeds refuse duplicates and bad references', async (t) => {
  const meta = await startMeta(t);
  await assert.rejects(() => meta.post('/accounts', ACCOUNT), /already exists/);
  await assert.rejects(() => meta.post('/accounts', {}), /igUserId is required/);
  await seedMedia(meta, 'm1');
  await assert.rejects(() => seedMedia(meta, 'm1'), /already exists/);
  await assert.rejects(() => meta.post('/media', { igUserId: 'nobody' }), /No account/);
  await addComment(meta, { id: 'c-dup', mediaId: 'm1' });
  await assert.rejects(() => addComment(meta, { id: 'c-dup', mediaId: 'm1' }), /already exists/);
  await assert.rejects(() => meta.post('/comments', { igUserId: ACCOUNT.igUserId, mediaId: 'm1', from: 'a' }), /text is required/);
  await assert.rejects(() => meta.post('/comments/delete', { id: 'none' }), /No such comment/);
  await assert.rejects(() => meta.post('/oauth/next', { igUserId: 'nobody' }), /No account/);
  await meta.post('/accounts', OTHER);
  await assert.rejects(() => meta.post('/comments', { igUserId: OTHER.igUserId, mediaId: 'm1', from: 'a', text: 'x' }), /belongs to another account/);
});
