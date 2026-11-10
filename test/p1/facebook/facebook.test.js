// PRD 6.10 from the outside: a real app, its worker, the database and the Meta simulator. The module's own edges; every FB scenario is covered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FB_APP_SECRET, addShop, addStaff, api, captureLogs, connectPage, hit, hubSignature, linkOf, need, openWorld, unique, useWorld } from '../spec-p1/support.js';

const world = useWorld();

const pageSent = async (pageId, filters = {}) => (await world.meta.get('/sent', { pageId, ...filters })).sent;
const fbFan = () => ({ id: `${Date.now()}${unique()}`.replace(/\D/g, '7'), name: `FB Fan ${unique()}` });
const fbComment = (pageId, postId, from, text = 'price', extra = {}) => world.meta.post('/facebook/comments', { pageId, postId, from, text, ...extra });
const addPost = async (pageId, fields = {}) => {
  const id = fields.id ?? `${pageId}_${unique()}`;
  await world.meta.post('/facebook/posts', { pageId, message: 'A reel', ...fields, id });
  return id;
};

async function crossPosted(shopOptions = {}) {
  const shop = await addShop(world, shopOptions);
  const connected = await connectPage(world, shop);
  const postId = await addPost(connected.pageId, { type: 'reel' });
  const auto = await shop.automate({ linkUrl: shop.siteUrl('/p/cross') });
  need(await shop.api(`/facebook/links/${postId}`, { method: 'PUT', body: { igMediaId: auto.mediaId } }), 200, 'Linking the post');
  return { shop, ...connected, postId, auto };
}

async function consent(shop, nextLogin = {}) {
  await world.meta.post('/facebook/login-next', nextLogin);
  const { authorizeUrl } = await shop.call('/facebook/connect', 200, { method: 'POST', body: {} });
  const answer = await fetch(authorizeUrl, { redirect: 'manual' });
  return new URL(answer.headers.get('location'));
}
const finishConsent = (shop, back) => hit(world, `${back.pathname}${back.search}`, { host: shop.host });
const landedWith = (res) => new URL(res.headers.location, 'http://x').searchParams.get('facebook');

const newPage = async (shop, fields = {}) => {
  const pageId = `102${Date.now()}${unique()}`.replace(/\D/g, '1').slice(0, 18);
  await world.meta.post('/pages', { pageId, name: `${shop.slug} page`, ...fields });
  return pageId;
};

// ---- the flag ----

test('with the flag off nothing Facebook is reachable, and it is off unless asked for', async () => {
  const { config } = await import('../../../src/config.js');
  assert.equal(config.facebookPages, false, 'FACEBOOK_PAGES is unset in tests');
  const w = await openWorld({ overrides: { facebookPages: false } });
  try {
    const shop = await addShop(w);
    assert.deepEqual(await shop.call('/facebook/connection', 200), { enabled: false, status: 'not_connected', pageId: null, pageName: '', tokenExpiresAt: null });
    assert.equal((await shop.api('/facebook/connect', { method: 'POST', body: {} })).status, 409);
    assert.equal((await shop.api('/facebook/links/1_2', { method: 'PUT', body: { igMediaId: '9' } })).status, 409);
    assert.equal((await shop.api('/facebook/links/1_2', { method: 'DELETE' })).status, 409);
    assert.equal((await shop.api('/facebook/connection', { method: 'DELETE' })).status, 204);
    assert.deepEqual((await shop.call('/facebook/posts', 200)).items, []);
    assert.deepEqual((await shop.call('/facebook/links', 200)).items, []);
    assert.deepEqual((await shop.call('/facebook/link-suggestions', 200)).items, []);
    assert.equal((await hit(w, '/oauth/facebook/callback?state=x', { host: shop.host })).status, 404);
    const raw = JSON.stringify({ object: 'page', entry: [{ id: '55', changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'c1', post_id: '55_1', message: 'price', from: { id: '1' } } }] }] });
    assert.equal((await w.webhook(raw, { signature: hubSignature(raw, FB_APP_SECRET) })).status, 200);
    await w.settle();
    assert.deepEqual(await shop.inbound(), []);
    assert.deepEqual(await shop.jobs(), []);
  } finally {
    await w.close();
  }
});

test('with the flag off a Page already in the table is not shown, and a comment on it is not answered', async () => {
  const w = await openWorld({ overrides: { facebookPages: false } });
  try {
    const shop = await addShop(w);
    const auto = await shop.automate();
    const pageId = `10${unique()}`.replace(/\D/g, '1');
    await shop.sql(`INSERT INTO fb_pages (page_id, tenant_id, name, access_token_enc) VALUES ($1, $2, 'Old', $3)`, [pageId, shop.tenantId, w.secrets.encrypt('t')]);
    const postId = `${pageId}_1`;
    await shop.sql(`INSERT INTO fb_post_links (tenant_id, fb_page_id, fb_post_id, ig_media_id, status, confirmed_at) VALUES ($1, $2, $3, $4, 'confirmed', now())`, [shop.tenantId, pageId, postId, auto.mediaId]);
    assert.equal((await shop.call('/facebook/connection', 200)).status, 'not_connected');
    const raw = JSON.stringify({ object: 'page', entry: [{ id: pageId, changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'c1', post_id: postId, message: 'price', from: { id: '1' } } }] }] });
    await w.webhook(raw, { signature: hubSignature(raw, FB_APP_SECRET) });
    await w.settle();
    assert.deepEqual(await shop.jobs(), []);
  } finally {
    await w.close();
  }
});

// ---- connecting ----

test('connecting a Page stores it encrypted, once, with what was granted', async () => {
  const shop = await addShop(world);
  const { pageId, pageToken } = await connectPage(world, shop);
  const [row] = await shop.sql('SELECT * FROM fb_pages WHERE tenant_id = $1', [shop.tenantId]);
  assert.equal(row.page_id, pageId);
  assert.notEqual(row.access_token_enc, pageToken);
  assert.ok(!row.access_token_enc.includes(pageToken));
  assert.equal(row.token_version, 1);
  assert.equal(row.status, 'active');
  assert.equal(row.token_expires_at, null);
  assert.ok(row.subscribed_at, 'The Page is subscribed to webhooks');
  assert.deepEqual([...row.subscribed_fields].sort(), ['feed', 'messages', 'messaging_postbacks']);
  assert.deepEqual(await shop.call('/facebook/connection', 200), { enabled: true, status: 'active', pageId, pageName: `${shop.slug} page`, tokenExpiresAt: null });
});

test('the token is asked for through Facebook Login and sent only as a header', async () => {
  const shop = await addShop(world);
  const { pageId, pageToken } = await connectPage(world, shop);
  const calls = await world.meta.calls({ path: `*/${pageId}/subscribed_apps` });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, `Bearer ${pageToken}`);
  assert.doesNotMatch(JSON.stringify(calls[0].query), new RegExp(pageToken));
});

test('a connect link works once and only for Facebook, and a made-up one changes nothing', async (t) => {
  const logs = captureLogs(t);
  const shop = await addShop(world);
  const pageId = await newPage(shop);
  const back = await consent(shop, { pageIds: [pageId] });
  assert.equal((await hit(world, `/oauth/facebook/callback?state=made-up&code=x`, { host: shop.host })).status, 400);
  assert.equal((await finishConsent(shop, back)).status, 303);
  assert.equal((await finishConsent(shop, back)).status, 400, 'Used twice');
  const { authorizeUrl } = await shop.call('/instagram/connect', 200, { method: 'POST', body: {} });
  const state = new URL(authorizeUrl).searchParams.get('state');
  assert.equal((await hit(world, `/oauth/facebook/callback?state=${state}&code=x`, { host: shop.host })).status, 400, 'An Instagram state');
  assert.doesNotMatch(logs.text(), new RegExp(back.searchParams.get('code')));
});

test('saying no at the consent screen connects nothing, and says so', async () => {
  const shop = await addShop(world);
  const res = await finishConsent(shop, await consent(shop, { deny: true }));
  assert.equal(res.status, 303);
  assert.equal(landedWith(res), 'denied');
  assert.equal((await shop.call('/facebook/connection', 200)).status, 'not_connected');
});

test('a consent that shares no Page says so, and connects nothing', async () => {
  const shop = await addShop(world);
  const res = await finishConsent(shop, await consent(shop, { pageIds: [] }));
  assert.equal(landedWith(res), 'no_page');
  assert.deepEqual(await shop.sql('SELECT 1 FROM fb_pages WHERE tenant_id = $1', [shop.tenantId]), []);
});

test('a consent without the messaging permission is saved, reported, and does not subscribe to messages', async () => {
  const shop = await addShop(world);
  const pageId = await newPage(shop);
  const res = await finishConsent(shop, await consent(shop, { pageIds: [pageId], scopes: ['pages_show_list', 'pages_manage_metadata', 'pages_read_engagement'] }));
  assert.equal(landedWith(res), 'missing_scopes');
  const [row] = await shop.sql('SELECT subscribed_fields FROM fb_pages WHERE page_id = $1', [pageId]);
  assert.deepEqual(row.subscribed_fields, ['feed']);
});

test('of several Pages, the one tied to the business\'s Instagram is the one connected', async () => {
  const shop = await addShop(world);
  const other = await newPage(shop);
  const twin = await newPage(shop, { igUserId: shop.igUserId });
  const res = await finishConsent(shop, await consent(shop, { pageIds: [other, twin] }));
  assert.equal(landedWith(res), 'connected');
  assert.equal((await shop.call('/facebook/connection', 200)).pageId, twin);
  assert.deepEqual((await shop.sql('SELECT page_id FROM fb_pages WHERE tenant_id = $1', [shop.tenantId])).map((r) => r.page_id), [twin]);
});

test('connecting a different Page ends the old one: its token goes and its webhooks stop', async () => {
  const shop = await addShop(world);
  const first = await connectPage(world, shop);
  const second = await connectPage(world, shop);
  assert.equal((await shop.call('/facebook/connection', 200)).pageId, second.pageId);
  const [old] = await shop.sql('SELECT access_token_enc, status_reason FROM fb_pages WHERE page_id = $1', [first.pageId]);
  assert.equal(old.access_token_enc, '');
  assert.equal(old.status_reason, 'owner.disconnected');
  assert.equal((await world.meta.calls({ method: 'DELETE', path: `*/${first.pageId}/subscribed_apps` })).length, 1);
});

test('only a manager can start a connection, and someone demoted before finishing can\'t complete it', async () => {
  const shop = await addShop(world);
  const staff = await addStaff(world, shop, { permissions: ['automations'] });
  assert.equal((await api(world, shop, staff.token, '/facebook/connect', { method: 'POST', body: {} })).status, 403);
  assert.equal((await api(world, shop, staff.token, '/facebook/connection', { method: 'DELETE' })).status, 403);
  assert.equal((await api(world, shop, staff.token, '/facebook/links')).status, 200, 'Staff with automations can see the links');
  const pageId = await newPage(shop);
  const back = await consent(shop, { pageIds: [pageId] });
  await shop.sql(`UPDATE users SET role = 'staff' WHERE tenant_id = $1`, [shop.tenantId]);
  const res = await finishConsent(shop, back);
  assert.equal(landedWith(res), 'forbidden');
  assert.deepEqual(await shop.sql('SELECT 1 FROM fb_pages WHERE tenant_id = $1', [shop.tenantId]), []);
});

test('a suspended business can\'t finish connecting', async () => {
  const shop = await addShop(world);
  const pageId = await newPage(shop);
  const back = await consent(shop, { pageIds: [pageId] });
  await shop.sql(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [shop.tenantId]);
  assert.equal((await finishConsent(shop, back)).status, 400);
  assert.deepEqual(await shop.sql('SELECT 1 FROM fb_pages WHERE tenant_id = $1', [shop.tenantId]), []);
});

test('FB-06: a Page on one business can\'t be taken by another; one its owner disconnected can', async () => {
  const a = await addShop(world);
  const { pageId } = await connectPage(world, a);
  const b = await addShop(world);
  assert.equal(landedWith(await finishConsent(b, await consent(b, { pageIds: [pageId] }))), 'taken');
  assert.deepEqual((await a.sql('SELECT tenant_id FROM fb_pages WHERE page_id = $1', [pageId])).map((r) => r.tenant_id), [a.tenantId]);
  assert.equal((await a.call('/facebook/connection', 200)).status, 'active', 'The first business is untouched');
  assert.equal((await b.call('/facebook/connection', 200)).status, 'not_connected');
  assert.equal((await a.api('/facebook/connection', { method: 'DELETE' })).status, 204);
  assert.equal(landedWith(await finishConsent(b, await consent(b, { pageIds: [pageId] }))), 'connected');
  assert.deepEqual((await a.sql('SELECT tenant_id FROM fb_pages WHERE page_id = $1', [pageId])).map((r) => r.tenant_id), [b.tenantId]);
});

test('FB-06: a business with Instagram only sees an empty Facebook, and Instagram runs as before', async () => {
  const shop = await addShop(world);
  assert.deepEqual(await shop.call('/facebook/connection', 200), { enabled: true, status: 'not_connected', pageId: null, pageName: '', tokenExpiresAt: null });
  for (const path of ['/facebook/posts', '/facebook/links', '/facebook/link-suggestions']) assert.deepEqual((await shop.call(path, 200)).items, []);
  assert.equal((await shop.api('/facebook/links/1_2', { method: 'PUT', body: { igMediaId: '9' } })).status, 404);
  const auto = await shop.automate();
  await shop.comment(auto.mediaId);
  await shop.settle();
  assert.equal((await shop.dms()).length, 1);
  assert.deepEqual(await shop.jobs(`channel = 'facebook'`), []);
});

test('FB-06: disconnecting removes the token, cancels what is waiting, and leaves Instagram alone', async () => {
  const { shop, pageId, postId, auto } = await crossPosted();
  await shop.setState(auto.id, 'paused');
  await fbComment(pageId, postId, fbFan());
  await shop.settle();
  assert.deepEqual((await shop.jobs()).map((j) => j.status), ['held']);
  assert.equal((await shop.api('/facebook/connection', { method: 'DELETE' })).status, 204);
  const [row] = await shop.sql('SELECT * FROM fb_pages WHERE page_id = $1', [pageId]);
  assert.equal(row.access_token_enc, '');
  assert.equal((await shop.call('/facebook/connection', 200)).status, 'not_connected');
  assert.equal((await world.meta.calls({ method: 'DELETE', path: `*/${pageId}/subscribed_apps` })).length, 1);
  assert.deepEqual((await shop.jobs(`status = 'cancelled'`)).map((j) => j.reason), ['cancelled.owner']);
  assert.equal((await shop.account()).status, 'active');
  assert.deepEqual((await shop.call('/facebook/links', 200)).items, []);
  assert.equal((await shop.api('/facebook/connection', { method: 'DELETE' })).status, 204, 'Doing it twice is harmless');
});

// ---- answering a comment ----

test('FB-01: a keyword comment on the linked post gets one Messenger private reply, through the compliance queue', async () => {
  const { shop, pageId, postId, auto } = await crossPosted();
  const person = fbFan();
  const { comment } = await fbComment(pageId, postId, person);
  await shop.settle();
  const sent = await pageSent(pageId);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'private_reply');
  assert.equal(sent[0].commentId, comment.id);
  assert.equal(new URL(linkOf(sent[0])).host, shop.siteHost);
  const [job] = await shop.jobs();
  assert.equal(job.channel, 'facebook');
  assert.equal(job.fb_page_id, pageId);
  assert.equal(job.ig_user_id, null);
  assert.equal(job.automation_id, auto.id);
  assert.equal(job.media_id, postId);
  assert.equal(job.status, 'sent');
  assert.equal((await shop.events(`channel = 'facebook' AND decision = 'sent'`)).length, 1);
  assert.deepEqual(await shop.dms(), [], 'Nothing went out on Instagram');
});

test('FB-01: a post with an automation of its own is answered once, by that automation', async () => {
  const shop = await addShop(world);
  const { pageId } = await connectPage(world, shop);
  const postId = await addPost(pageId);
  const twin = await shop.automate({ linkUrl: shop.siteUrl('/twin') });
  const own = await shop.automate({ triggers: [{ channel: 'facebook', targetType: 'post', mediaId: postId }], linkUrl: shop.siteUrl('/own') });
  need(await shop.api(`/facebook/links/${postId}`, { method: 'PUT', body: { igMediaId: twin.mediaId } }), 200, 'Linking');
  await fbComment(pageId, postId, fbFan());
  await shop.settle();
  const sent = await pageSent(pageId);
  assert.equal(sent.length, 1);
  assert.equal(new URL(linkOf(sent[0])).pathname, '/own');
  assert.deepEqual((await shop.jobs()).map((j) => j.automation_id), [own.id]);
});

test('FB-01: a comment without the keyword gets nothing, and says why', async () => {
  const { shop, pageId, postId } = await crossPosted();
  await fbComment(pageId, postId, fbFan(), 'lovely');
  await shop.settle();
  assert.deepEqual(await pageSent(pageId), []);
  assert.ok((await shop.reasons()).includes('no_keyword'));
});

test('FB-01: the automation\'s state applies to Facebook too: a paused one holds, a draft one doesn\'t answer', async () => {
  const { shop, pageId, postId, auto } = await crossPosted();
  await shop.setState(auto.id, 'paused');
  await fbComment(pageId, postId, fbFan());
  await shop.settle();
  assert.deepEqual(await pageSent(pageId), []);
  assert.deepEqual((await shop.jobs()).map((j) => [j.status, j.reason]), [['held', 'paused.automation']]);
  await shop.setState(auto.id, 'draft');
  await fbComment(pageId, postId, fbFan());
  await shop.settle();
  assert.ok((await shop.reasons()).includes('automation.draft'));
});

test('FB-01: an automation archived after linking stops answering, and a new one on the same reel takes over', async () => {
  const { shop, pageId, postId, auto } = await crossPosted();
  await shop.sql(`UPDATE automations SET state = 'archived', archived_at = now() WHERE id = $1`, [auto.id]);
  await shop.sql('UPDATE automation_triggers SET active = false WHERE automation_id = $1', [auto.id]);
  await fbComment(pageId, postId, fbFan());
  await shop.settle();
  assert.deepEqual(await pageSent(pageId), []);
  const next = await shop.automate({ mediaId: auto.mediaId, linkUrl: shop.siteUrl('/p/next') });
  await fbComment(pageId, postId, fbFan());
  await shop.settle();
  const sent = await pageSent(pageId);
  assert.equal(sent.length, 1);
  assert.equal(new URL(linkOf(sent[0])).pathname, '/p/next');
  assert.equal((await shop.jobs(`automation_id = $2`, [next.id])).length, 1);
});

test('FB-01: a link can be made before the reel has an automation, and starts working when it gets one', async () => {
  const shop = await addShop(world);
  const { pageId } = await connectPage(world, shop);
  const postId = await addPost(pageId);
  const mediaId = await shop.reel();
  need(await shop.api(`/facebook/links/${postId}`, { method: 'PUT', body: { igMediaId: mediaId } }), 200, 'Linking');
  await fbComment(pageId, postId, fbFan());
  await shop.settle();
  assert.deepEqual(await pageSent(pageId), []);
  await shop.automate({ mediaId });
  await fbComment(pageId, postId, fbFan());
  await shop.settle();
  assert.equal((await pageSent(pageId)).length, 1);
});

test('FB-01: the same comment delivered twice, or the worker running it again, is one reply', async () => {
  const { shop, pageId, postId } = await crossPosted();
  await fbComment(pageId, postId, fbFan(), 'price', { duplicates: 3 });
  await shop.settle();
  assert.equal((await pageSent(pageId)).length, 1);
  await shop.sql(`UPDATE inbound_events SET status = 'stored', lease_until = NULL, attempts = 0 WHERE tenant_id = $1 AND field = 'feed'`, [shop.tenantId]);
  await shop.settle();
  assert.equal((await pageSent(pageId)).length, 1);
});

test('FB-01: a Page reply under its own comment, or a reply by the Page, gets no DM', async () => {
  const { shop, pageId, postId } = await crossPosted();
  await fbComment(pageId, postId, { id: pageId, name: 'The Page' });
  await shop.settle();
  assert.deepEqual(await pageSent(pageId), []);
  assert.ok((await shop.reasons()).includes('own_account'));
});

test('FB-01: nothing from a commenter reaches the logs', async (t) => {
  const logs = captureLogs(t);
  const { shop, pageId, postId } = await crossPosted();
  const person = { id: fbFan().id, name: 'Personal Name Here' };
  await fbComment(pageId, postId, person, 'price my number is 98765-43210');
  await shop.settle();
  const text = logs.text();
  assert.doesNotMatch(text, /Personal Name Here/);
  assert.doesNotMatch(text, /98765-43210/);
  assert.equal(text.includes(person.id), false);
});

test('FB-01: a message on Facebook names only the seller', async () => {
  const { shop, pageId, postId } = await crossPosted();
  await fbComment(pageId, postId, fbFan());
  await shop.settle();
  assert.doesNotMatch(JSON.stringify((await pageSent(pageId))[0].message), /bhava/i);
});

test('FB-02: the same person on both platforms gets one DM on each, and each platform counts its own caps', async () => {
  const { shop, pageId, postId, auto } = await crossPosted();
  const fan = world.fan();
  await shop.comment(auto.mediaId, { from: fan });
  await fbComment(pageId, postId, { id: fan.id, name: 'Same id' });
  await shop.settle();
  assert.equal((await shop.dms()).length, 1);
  assert.equal((await pageSent(pageId)).length, 1);
  await fbComment(pageId, postId, { id: fan.id, name: 'Same id' });
  await shop.settle();
  assert.equal((await pageSent(pageId)).length, 1, 'A second comment on the same post is capped');
  const channels = (await shop.sql('SELECT DISTINCT channel FROM cap_claims WHERE tenant_id = $1 ORDER BY channel', [shop.tenantId])).map((r) => r.channel);
  assert.deepEqual(channels, ['facebook', 'instagram']);
  assert.notEqual(await shop.hash(fan.id, 'instagram'), await shop.hash(fan.id, 'facebook'));
});

test('FB-03: a fix made while a comment waits in the queue doesn\'t change what that comment gets', async () => {
  const shop = await addShop(world);
  const { pageId } = await connectPage(world, shop);
  const postId = await addPost(pageId);
  const wrong = await shop.automate({ linkUrl: shop.siteUrl('/wrong') });
  const right = await shop.automate({ linkUrl: shop.siteUrl('/right') });
  await shop.call(`/facebook/links/${postId}`, 200, { method: 'PUT', body: { igMediaId: wrong.mediaId } });
  world.stopWorker();
  await fbComment(pageId, postId, fbFan());
  await shop.call(`/facebook/links/${postId}`, 200, { method: 'PUT', body: { igMediaId: right.mediaId } });
  await fbComment(pageId, postId, fbFan());
  world.startWorker();
  await shop.settle();
  const jobs = await shop.jobs();
  assert.deepEqual(jobs.map((j) => j.automation_id), [wrong.id, right.id]);
  const paths = (await pageSent(pageId)).map((m) => new URL(linkOf(m)).pathname).sort();
  assert.deepEqual(paths, ['/right', '/wrong']);
});

test('FB-03: a comment that arrived before the link existed isn\'t answered', async () => {
  const shop = await addShop(world);
  const { pageId } = await connectPage(world, shop);
  const postId = await addPost(pageId);
  const auto = await shop.automate();
  world.stopWorker();
  await fbComment(pageId, postId, fbFan());
  await shop.call(`/facebook/links/${postId}`, 200, { method: 'PUT', body: { igMediaId: auto.mediaId } });
  world.startWorker();
  await shop.settle();
  assert.deepEqual(await pageSent(pageId), []);
});

test('FB-03: removing a link stops new comments, keeps past DMs, and it can be linked again', async () => {
  const { shop, pageId, postId, auto } = await crossPosted();
  await fbComment(pageId, postId, fbFan());
  await shop.settle();
  assert.equal((await shop.api(`/facebook/links/${postId}`, { method: 'DELETE' })).status, 204);
  assert.deepEqual((await shop.call('/facebook/links', 200)).items, []);
  await fbComment(pageId, postId, fbFan());
  await shop.settle();
  assert.equal((await pageSent(pageId)).length, 1);
  assert.equal((await shop.api(`/facebook/links/${postId}`, { method: 'DELETE' })).status, 404, 'Nothing left to remove');
  need(await shop.api(`/facebook/links/${postId}`, { method: 'PUT', body: { igMediaId: auto.mediaId } }), 200, 'Linking again');
  await fbComment(pageId, postId, fbFan());
  await shop.settle();
  assert.equal((await pageSent(pageId)).length, 2);
});

test('FB-03: the owner\'s changes are audited, with ids only', async () => {
  const { shop, postId, auto } = await crossPosted();
  const rows = await shop.sql(`SELECT action, target, details FROM audit_log WHERE tenant_id = $1 AND action LIKE 'facebook.%' ORDER BY id`, [shop.tenantId]);
  assert.deepEqual(rows.map((r) => r.action), ['facebook.connected', 'facebook.link_saved']);
  assert.equal(rows[1].target, `facebook:${postId}`);
  assert.deepEqual(rows[1].details, { igMediaId: auto.mediaId });
});

test('FB-03: saving the same link again changes nothing, and two saves at once are one link', async () => {
  const { shop, postId, auto } = await crossPosted();
  const body = { method: 'PUT', body: { igMediaId: auto.mediaId } };
  const first = await shop.call(`/facebook/links/${postId}`, 200, body);
  assert.equal(first.status, 'confirmed');
  assert.ok(first.confirmedAt);
  const answers = await Promise.all([shop.api(`/facebook/links/${postId}`, body), shop.api(`/facebook/links/${postId}`, body)]);
  assert.deepEqual(answers.map((r) => r.status), [200, 200]);
  assert.equal((await shop.sql(`SELECT 1 FROM fb_post_links WHERE tenant_id = $1 AND status = 'confirmed'`, [shop.tenantId])).length, 1);
});

test('FB-03: a reel is the twin of one post at a time, until that link is removed', async () => {
  const { shop, pageId, postId, auto } = await crossPosted();
  const other = await addPost(pageId);
  const res = await shop.api(`/facebook/links/${other}`, { method: 'PUT', body: { igMediaId: auto.mediaId } });
  assert.equal(res.status, 409);
  assert.equal((await shop.api(`/facebook/links/${postId}`, { method: 'DELETE' })).status, 204);
  need(await shop.api(`/facebook/links/${other}`, { method: 'PUT', body: { igMediaId: auto.mediaId } }), 200, 'After removing the old link');
});

test('FB-03: linking is only for the business\'s own Page and own Instagram', async () => {
  const a = await crossPosted();
  const b = await addShop(world);
  const theirPage = await connectPage(world, b);
  const theirPost = await addPost(theirPage.pageId);
  const theirs = await b.automate();
  assert.equal((await a.shop.api(`/facebook/links/${theirPost}`, { method: 'PUT', body: { igMediaId: a.auto.mediaId } })).status, 404, 'Another business\'s post');
  assert.equal((await a.shop.api(`/facebook/links/${a.postId}`, { method: 'PUT', body: { igMediaId: theirs.mediaId } })).status, 400, 'Another business\'s reel');
  assert.equal((await a.shop.api(`/facebook/links/${a.postId}`, { method: 'PUT', body: { igMediaId: '99999' } })).status, 400, 'No such reel');
  assert.equal((await b.api(`/facebook/links/${a.postId}`, { method: 'DELETE' })).status, 404);
  assert.deepEqual((await b.call('/facebook/links', 200)).items, []);
  assert.equal((await a.shop.call('/facebook/links', 200)).items.length, 1, 'Still linked');
});

test('FB-03: a reel the business hasn\'t used yet is checked with Instagram, and an Instagram outage isn\'t called a bad reel', async () => {
  const shop = await addShop(world);
  const { pageId } = await connectPage(world, shop);
  const postId = await addPost(pageId);
  const mediaId = await shop.reel();
  await world.meta.fault({ kind: 'server_error', match: { path: `*/${mediaId}` } });
  assert.equal((await shop.api(`/facebook/links/${postId}`, { method: 'PUT', body: { igMediaId: mediaId } })).status, 409);
  need(await shop.api(`/facebook/links/${postId}`, { method: 'PUT', body: { igMediaId: mediaId } }), 200, 'After the outage');
});

test('FB-03: input that isn\'t a post id or a media id is refused', async () => {
  const { shop } = await crossPosted();
  for (const id of ['../x', 'a b', 'x'.repeat(81), `${'%00'}x`]) assert.equal((await shop.api(`/facebook/links/${encodeURIComponent(id)}`, { method: 'PUT', body: { igMediaId: '1' } })).status, 404, id);
  for (const body of [{}, { igMediaId: '' }, { igMediaId: 'x'.repeat(81) }, { igMediaId: 5 }]) assert.equal((await shop.api(`/facebook/links/${shop.tenantId}_1`, { method: 'PUT', body })).status, 400, JSON.stringify(body));
});

// ---- posts and suggestions ----

test('the post list merges posts and reels, marks what is linked, and pages without repeats', async () => {
  const shop = await addShop(world);
  const { pageId } = await connectPage(world, shop);
  const base = Date.now() - 3_600_000;
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await addPost(pageId, { message: `Post ${i}`, at: base + i * 60_000, type: i % 2 ? 'reel' : 'post' }));
  const auto = await shop.automate();
  await shop.call(`/facebook/links/${ids[4]}`, 200, { method: 'PUT', body: { igMediaId: auto.mediaId } });
  const first = await shop.call('/facebook/posts?limit=2', 200);
  assert.deepEqual(first.items.map((p) => p.id), [ids[4], ids[3]]);
  assert.equal(first.items[0].linkedIgMediaId, auto.mediaId);
  assert.equal(first.items[1].linkedIgMediaId, null);
  assert.match(first.items[0].permalink, /^https:\/\//);
  assert.equal(first.items[0].message, 'Post 4');
  assert.ok(first.items[0].postedAt);
  const rest = await shop.call(`/facebook/posts?limit=10&cursor=${first.nextCursor}`, 200);
  assert.deepEqual(rest.items.map((p) => p.id), [ids[2], ids[1], ids[0]]);
  assert.equal(rest.nextCursor, null);
});

test('reading posts with a dead token pauses Facebook once, and only Facebook', async () => {
  const shop = await addShop(world);
  const { pageId, pageToken } = await connectPage(world, shop);
  await world.meta.post('/tokens/expire', { token: pageToken });
  const res = await shop.api('/facebook/posts');
  assert.equal(res.status, 409);
  assert.equal(res.json().reason, 'paused.reconnect');
  const [row] = await shop.sql('SELECT status, status_reason FROM fb_pages WHERE page_id = $1', [pageId]);
  assert.deepEqual([row.status, row.status_reason], ['reconnect_needed', 'token.rejected']);
  assert.equal((await shop.alerts()).filter((a) => a.kind === 'token.rejected').length, 1);
  assert.equal((await shop.api('/facebook/posts')).status, 200, 'With no working token the list is simply empty');
  assert.equal((await shop.alerts()).filter((a) => a.kind === 'token.rejected').length, 1);
  assert.equal((await shop.account()).status, 'active');
});

test('Facebook being down is an answer the seller can act on, not a crash', async () => {
  const shop = await addShop(world);
  const { pageId } = await connectPage(world, shop);
  await world.meta.fault({ kind: 'server_error', match: { path: `*/${pageId}/posts` } });
  const res = await shop.api('/facebook/posts');
  assert.equal(res.status, 409);
  assert.match(res.json().error, /isn’t answering/);
  assert.equal((await shop.call('/facebook/connection', 200)).status, 'active');
});

test('suggestions come from captions and time, and leave what is linked or was removed', async () => {
  const shop = await addShop(world);
  const { pageId } = await connectPage(world, shop);
  const caption = `Festive edit ${unique()} just landed`;
  const mediaId = await shop.reel({ caption });
  const postId = await addPost(pageId, { message: caption });
  const noise = await addPost(pageId, { message: 'Something else entirely' });
  const { items } = await shop.call('/facebook/link-suggestions', 200);
  assert.equal(items.length, 1);
  assert.equal(items[0].fbPostId, postId);
  assert.equal(items[0].igMediaId, mediaId);
  assert.ok(items[0].score > 0.5);
  assert.notEqual(items[0].fbPostId, noise);
  assert.deepEqual((await shop.call('/facebook/links', 200)).items, [], 'A suggestion links nothing');
  await shop.call(`/facebook/links/${postId}`, 200, { method: 'PUT', body: { igMediaId: mediaId } });
  assert.deepEqual((await shop.call('/facebook/link-suggestions', 200)).items, [], 'Once linked it isn\'t offered');
  assert.equal((await shop.api(`/facebook/links/${postId}`, { method: 'DELETE' })).status, 204);
  assert.deepEqual((await shop.call('/facebook/link-suggestions', 200)).items, [], 'Once removed it isn\'t offered again');
});

// ---- when something goes wrong ----

test('FB-04: an expired Page token pauses only Facebook, alerts the owner, and reconnecting sends what waited', async () => {
  const { shop, pageId, pageToken, postId, auto } = await crossPosted();
  await world.meta.post('/tokens/expire', { token: pageToken });
  const first = fbFan();
  await fbComment(pageId, postId, first);
  await shop.settle();
  const [page] = await shop.sql('SELECT status, status_reason FROM fb_pages WHERE page_id = $1', [pageId]);
  assert.deepEqual([page.status, page.status_reason], ['reconnect_needed', 'token.rejected']);
  assert.equal((await shop.call('/facebook/connection', 200)).status, 'reconnect_needed');
  assert.equal((await shop.alerts()).filter((a) => a.kind === 'token.rejected').length, 1);

  await world.switchLag();
  const ig = await shop.comment(auto.mediaId);
  await shop.settle();
  assert.equal((await shop.dms({ commentId: ig.id })).length, 1, 'Instagram is untouched');
  assert.equal((await shop.account()).status, 'active');
  assert.equal((await shop.call('/compliance/status', 200)).reconnectNeeded, false);

  const second = fbFan();
  await fbComment(pageId, postId, second);
  await shop.settle();
  assert.ok((await shop.jobs(`channel = 'facebook'`)).every((j) => j.status === 'held' && j.reason === 'paused.reconnect'));

  assert.equal(landedWith(await finishConsent(shop, await consent(shop, { pageIds: [pageId] }))), 'connected');
  const [back] = await shop.sql('SELECT status, status_reason, token_version FROM fb_pages WHERE page_id = $1', [pageId]);
  assert.deepEqual([back.status, back.status_reason, back.token_version], ['active', '', 2]);
  await world.switchLag();
  await shop.settle();
  assert.equal((await pageSent(pageId, { recipientId: first.id })).length, 1);
  assert.equal((await pageSent(pageId, { recipientId: second.id })).length, 1);
  assert.equal((await shop.sql(`SELECT state FROM breakers WHERE tenant_id = $1 AND channel = 'facebook'`, [shop.tenantId]))[0].state, 'closed');
});

test('FB-04: while a Page is paused no token can be read for it', async () => {
  const shop = await addShop(world);
  const { pageId, pageToken } = await connectPage(world, shop);
  await world.meta.post('/tokens/expire', { token: pageToken });
  await shop.api('/facebook/posts');
  assert.equal((await shop.repos.fbPages.get(pageId)).token, '');
  assert.equal(await shop.repos.fbPages.current(), null);
});

test('FB-04: a broken Facebook doesn\'t stop Instagram, and a broken Instagram doesn\'t stop Facebook', async () => {
  const { shop, pageId, postId } = await crossPosted();
  await world.meta.post('/tokens/revoke', { token: shop.igToken });
  const reel = await shop.reel();
  await shop.automate({ mediaId: reel });
  await shop.comment(reel);
  await shop.settle();
  await world.switchLag();
  await fbComment(pageId, postId, fbFan());
  await shop.settle();
  assert.equal((await pageSent(pageId)).length, 1);
});

test('FB-05: STOP in Messenger stops messages from that business only, and only on Facebook', async () => {
  const a = await crossPosted();
  const b = await crossPosted();
  const person = fbFan();
  await world.meta.post('/facebook/messages', { pageId: a.pageId, from: person, text: 'STOP' });
  await a.shop.settle();
  const [row] = await a.shop.optOuts();
  assert.equal(row.channel, 'facebook');
  assert.equal(row.subject_hash, await a.shop.hash(person.id, 'facebook'));
  const before = (await pageSent(a.pageId, { recipientId: person.id })).length;
  assert.ok(before <= 1);
  await fbComment(a.pageId, a.postId, person);
  await a.shop.settle();
  assert.equal((await pageSent(a.pageId, { recipientId: person.id })).length, before);
  assert.ok((await a.shop.reasons()).includes('optout'));
  await fbComment(b.pageId, b.postId, person);
  await b.shop.settle();
  assert.equal((await pageSent(b.pageId, { recipientId: person.id })).length, 1);
  const fan = world.fan();
  await world.meta.post('/facebook/messages', { pageId: a.pageId, from: { id: fan.id, name: 'Same id' }, text: 'stop' });
  await a.shop.settle();
  const ig = await a.shop.comment(a.auto.mediaId, { from: fan });
  await a.shop.settle();
  assert.equal((await a.shop.dms({ commentId: ig.id })).length, 1);
});

test('the hourly job retries a webhook subscription that failed', async () => {
  const shop = await addShop(world);
  const pageId = await newPage(shop);
  await world.meta.fault({ kind: 'server_error', match: { method: 'POST', path: `*/${pageId}/subscribed_apps` } });
  await finishConsent(shop, await consent(shop, { pageIds: [pageId] }));
  const [before] = await shop.sql('SELECT subscribed_at FROM fb_pages WHERE page_id = $1', [pageId]);
  assert.equal(before.subscribed_at, null);
  await world.tick();
  await shop.settle();
  const [after] = await shop.sql('SELECT subscribed_at, subscribed_fields FROM fb_pages WHERE page_id = $1', [pageId]);
  assert.ok(after.subscribed_at, 'Subscribed on the retry');
  assert.equal(after.subscribed_fields.includes('feed'), true);
});

test('another business can\'t reach a Page\'s data through a repo', async () => {
  const a = await addShop(world);
  const { pageId } = await connectPage(world, a);
  const b = await addShop(world);
  assert.equal(await b.repos.fbPages.get(pageId), null);
  assert.equal(await b.repos.fbPages.detail(pageId), null);
  assert.equal(await b.repos.fbPages.disconnect(pageId, { actor: 'test' }), false);
  assert.equal(await b.repos.fbLinks.remove(`${pageId}_1`, { actor: 'test', at: new Date() }), false);
  await assert.rejects(() => world.platform.fbPages.get(pageId), /tenant|business/i);
});
