import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY, IG_A, IG_B, accountRow, addBusiness, addJob, connected, jobStatus, startSlice, subscribedOnMeta } from './support.js';

test('a business with nothing connected says so', async (t) => {
  const slice = await startSlice(t);
  const business = await addBusiness(slice.app);
  const { status, body } = await business.api('GET', '/instagram/connection');
  assert.equal(status, 200);
  assert.deepEqual(body.status, 'not_connected');
  assert.equal(body.igUserId, null);
  assert.equal(body.health, 'none');
  assert.equal(body.missingScopes.length, 4);
});

test('an account that is only linked, with no token, is not connected', async (t) => {
  const slice = await startSlice(t);
  const business = await addBusiness(slice.app);
  await slice.app.platform.tenants.linkIgAccount(business.tenant.id, 'IG-LINKED', 'linked');
  assert.equal((await business.api('GET', '/instagram/connection')).body.status, 'not_connected');
});

test('the connection turns amber at 14 days and red at 3', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice);
  const expiresIn = (days) => slice.q('UPDATE ig_accounts SET token_expires_at = $1 WHERE ig_user_id = $2', [new Date(Date.now() + days * DAY), IG_A]);
  const health = async () => (await business.api('GET', '/instagram/connection')).body.health;

  assert.equal(await health(), 'ok');
  await expiresIn(13);
  assert.equal(await health(), 'amber');
  await expiresIn(2);
  assert.equal(await health(), 'red');
});

test('disconnecting removes the token, tells Meta, and stops what was waiting', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice);
  const { token } = await business.repos.igAccounts.get(IG_A);
  const job = await addJob(slice, business.tenant.id, IG_A);

  const res = await business.api('DELETE', '/instagram/connection');
  assert.equal(res.status, 204);
  assert.equal((await accountRow(slice, IG_A)).access_token_enc, '');
  assert.deepEqual(await jobStatus(slice, job), { status: 'cancelled', reason: 'cancelled.owner' });
  assert.deepEqual(await subscribedOnMeta(slice.sim, IG_A, token), []);
  const view = (await business.api('GET', '/instagram/connection')).body;
  assert.deepEqual([view.status, view.igUserId], ['not_connected', null]);
  assert.equal((await business.api('DELETE', '/instagram/connection')).status, 204, 'nothing to disconnect is still fine');
});

test('disconnecting works even when Meta does not answer', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice);
  await slice.sim.post('/faults', { kind: 'server_error', match: { method: 'DELETE', path: '*/subscribed_apps' } });
  assert.equal((await business.api('DELETE', '/instagram/connection')).status, 204);
  assert.equal((await accountRow(slice, IG_A)).access_token_enc, '');
});

test('one business cannot disconnect or read another\'s account', async (t) => {
  const slice = await startSlice(t);
  const one = await connected(slice, IG_A);
  const two = await addBusiness(slice.app);
  assert.equal((await two.api('DELETE', '/instagram/connection')).status, 204);
  assert.ok((await one.business.repos.igAccounts.current()).token);
  assert.equal((await two.api('GET', '/instagram/connection')).body.status, 'not_connected');
});

test('the media grid lists reels and posts, with no token in the answer', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice);
  await slice.sim.post('/media', { igUserId: IG_A, id: 'reel-1', productType: 'REELS', caption: 'A reel' });
  await slice.sim.post('/media', { igUserId: IG_A, id: 'post-1', productType: 'FEED', mediaType: 'IMAGE', caption: 'A post' });
  const { status, body } = await business.api('GET', '/instagram/media?type=all');
  assert.equal(status, 200);
  assert.deepEqual(body.items.map((i) => i.type).sort(), ['post', 'reel']);
  const reel = body.items.find((i) => i.id === 'reel-1');
  assert.equal(reel.caption, 'A reel');
  assert.ok(reel.permalink && reel.thumbnailUrl && reel.postedAt);
  assert.equal(reel.automationId, null);
  assert.equal(JSON.stringify(body).includes('IGAAsim'), false);
});

test('the media grid filters by type, and includes stories', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice);
  await slice.sim.post('/media', { igUserId: IG_A, id: 'reel-1', productType: 'REELS' });
  await slice.sim.post('/media', { igUserId: IG_A, id: 'post-1', productType: 'FEED' });
  await slice.sim.post('/media', { igUserId: IG_A, id: 'story-1', productType: 'STORY' });
  const ids = async (type) => (await business.api('GET', `/instagram/media?type=${type}`)).body.items.map((i) => i.id);
  assert.deepEqual(await ids('reel'), ['reel-1']);
  assert.deepEqual(await ids('post'), ['post-1']);
  assert.deepEqual(await ids('story'), ['story-1']);
  assert.deepEqual((await ids('all')).sort(), ['post-1', 'reel-1', 'story-1']);
});

test('the media grid pages through, and marks media that already has an automation', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice);
  for (let i = 1; i <= 3; i++) await slice.sim.post('/media', { igUserId: IG_A, id: `reel-${i}`, productType: 'REELS' });
  const tenant = business.tenant.id;
  const [automation] = await slice.q(`INSERT INTO automations (tenant_id, name, slug, trigger_type) VALUES ($1, 'A', 'a', 'comment') RETURNING id`, [tenant]);
  await slice.q(`INSERT INTO automation_triggers (tenant_id, automation_id, channel, target_type, media_id) VALUES ($1, $2, 'instagram', 'reel', 'reel-3')`, [tenant, automation.id]);

  const first = (await business.api('GET', '/instagram/media?type=reel&limit=2')).body;
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  assert.equal(first.items.find((i) => i.id === 'reel-3')?.automationId, automation.id);
  const second = (await business.api('GET', `/instagram/media?type=reel&limit=2&cursor=${first.nextCursor}`)).body;
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, null);
});

test('no connection means an empty grid', async (t) => {
  const slice = await startSlice(t);
  const business = await addBusiness(slice.app);
  assert.deepEqual((await business.api('GET', '/instagram/media')).body, { items: [], nextCursor: null });
});

test('a refused token, found while reading media, ends the connection and asks for a reconnect', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice);
  await slice.sim.post('/tokens/revoke', { igUserId: IG_A });
  const { status, body } = await business.api('GET', '/instagram/media');
  assert.equal(status, 409);
  assert.equal(body.reason, 'paused.reconnect');
  assert.equal((await accountRow(slice, IG_A)).status, 'reconnect_needed');
});

test('Meta being down is a plain refusal, and the connection stands', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice);
  await slice.sim.post('/faults', { kind: 'server_error', match: { path: `/v23.0/${IG_A}/media` } });
  assert.equal((await business.api('GET', '/instagram/media?type=reel')).status, 409);
  assert.equal((await accountRow(slice, IG_A)).status, 'active');
});

test('each business\'s media call uses its own token', async (t) => {
  const slice = await startSlice(t);
  const one = await connected(slice, IG_A);
  const two = await connected(slice, IG_B);
  await one.business.api('GET', '/instagram/media?type=reel');
  const own = (await one.business.repos.igAccounts.get(IG_A)).token;
  const other = (await two.business.repos.igAccounts.get(IG_B)).token;
  const mediaCalls = (await slice.sim.calls()).filter((c) => c.path === `/v23.0/${IG_A}/media`);
  assert.ok(mediaCalls.length >= 1);
  assert.ok(mediaCalls.every((c) => c.headers.authorization === `Bearer ${own}`));
  assert.ok(mediaCalls.every((c) => c.headers.authorization !== `Bearer ${other}`));
});
