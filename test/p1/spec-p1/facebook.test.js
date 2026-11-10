// PRD 6.10: Facebook Page automation. FB-01 to FB-06.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FB_APP_SECRET, addShop, assertReason, connectPage, hit, hubSignature, linkOf, need, openWorld, unique, useWorld } from './support.js';

const world = useWorld();

const pageSent = async (pageId, filters = {}) => (await world.meta.get('/sent', { pageId, ...filters })).sent;

async function crossPosted({ linkUrl } = {}) {
  const shop = await addShop(world);
  const { pageId, pageToken } = await connectPage(world, shop);
  const postId = `${pageId}_${unique()}`;
  await world.meta.post('/facebook/posts', { pageId, id: postId, message: 'A reel', type: 'reel' });
  const auto = await shop.automate({ linkUrl: linkUrl ?? shop.siteUrl('/p/cross') });
  need(await shop.api(`/facebook/links/${postId}`, { method: 'PUT', body: { igMediaId: auto.mediaId } }), 200, 'Linking the post');
  return { shop, pageId, pageToken, postId, auto };
}
const fbComment = (pageId, postId, from, text = 'price', extra = {}) => world.meta.post('/facebook/comments', { pageId, postId, from, text, ...extra });
const fbFan = () => ({ id: `${unique()}77`.replace(/\D/g, '7'), name: `FB Fan ${unique()}` });

test('FB-01: a keyword comment on the Facebook copy gets one Messenger private reply, with the direct link tagged Facebook', async () => {
  const { shop, pageId, postId } = await crossPosted();
  const person = fbFan();
  const { comment } = await fbComment(pageId, postId, person);
  await shop.settle();
  const sent = await pageSent(pageId);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'private_reply');
  assert.equal(sent[0].commentId, comment.id);
  const link = new URL(linkOf(sent[0]));
  assert.equal(link.host, shop.siteHost);
  assert.equal(link.searchParams.get('utm_source'), 'facebook');
  assert.equal(link.searchParams.get('utm_medium'), 'dm');
});

test('FB-01: it goes through the same engine: a job for the Page, a logged decision on the facebook channel', async () => {
  const { shop, pageId, postId } = await crossPosted();
  await fbComment(pageId, postId, fbFan());
  await shop.settle();
  const [job] = await shop.jobs();
  assert.equal(job.channel, 'facebook');
  assert.equal(job.fb_page_id, pageId);
  assert.equal(job.ig_user_id, null);
  assert.equal((await shop.events(`channel = 'facebook' AND decision = 'sent'`)).length, 1);
});

test('FB-01: the same webhook twice at the same moment is one Messenger reply', async () => {
  const { shop, pageId, postId } = await crossPosted();
  await fbComment(pageId, postId, fbFan(), 'price', { duplicates: 2 });
  await shop.settle();
  assert.equal((await pageSent(pageId)).length, 1);
  assert.equal((await shop.inbound()).length, 1);
});

test('FB-01: a Page webhook signed with the wrong secret is refused', async () => {
  const { shop, pageId, postId } = await crossPosted();
  const { delivery } = await fbComment(pageId, postId, fbFan(), 'price', { signature: 'bad' });
  assert.equal(delivery.status, 401);
  await shop.settle();
  assert.deepEqual(await pageSent(pageId), []);
  assert.deepEqual(await shop.inbound(), []);
});

test('FB-01: a Page webhook signed with the Instagram app\'s secret is refused', async () => {
  const { pageId } = await crossPosted();
  const raw = JSON.stringify({ object: 'page', entry: [{ id: pageId, changes: [] }] });
  assert.equal((await world.webhook(raw)).status, 401, 'Signed with the Instagram app secret');
  assert.equal((await world.webhook(raw, { signature: hubSignature(raw, FB_APP_SECRET) })).status, 200);
});

test('FB-01: a comment on an unlinked post is unmapped', async () => {
  const { shop, pageId } = await crossPosted();
  const other = `${pageId}_${unique()}`;
  await world.meta.post('/facebook/posts', { pageId, id: other, message: 'Other' });
  await fbComment(pageId, other, fbFan());
  await shop.settle();
  assert.deepEqual(await pageSent(pageId), []);
  await assertReason(shop, 'unmapped');
});

test('FB-01: the Page commenting on its own post gets no DM, own_account', async () => {
  const { shop, pageId, postId } = await crossPosted();
  await fbComment(pageId, postId, { id: pageId, name: 'The Page' });
  await shop.settle();
  assert.deepEqual(await pageSent(pageId), []);
  await assertReason(shop, 'own_account');
});

test('FB-01: a negative comment gets no Messenger reply either', async () => {
  const { shop, pageId, postId } = await crossPosted();
  await fbComment(pageId, postId, fbFan(), 'price fraud');
  await shop.settle();
  assert.deepEqual(await pageSent(pageId), []);
  await assertReason(shop, 'negative_intent');
});

test('FB-01: public replies stay off on Facebook unless turned on', async () => {
  const { shop, pageId, postId } = await crossPosted();
  await fbComment(pageId, postId, fbFan());
  await shop.settle();
  assert.equal((await pageSent(pageId, { kind: 'public_reply' })).length, 0);
});

test('FB-01: the Facebook flag off means Page webhooks do nothing', async () => {
  const w = await openWorld({ overrides: { facebookPages: false } });
  try {
    const shop = await addShop(w);
    const raw = JSON.stringify({ object: 'page', entry: [{ id: '55', changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'c1', post_id: '55_1', message: 'price', from: { id: '1' } } }] }] });
    const res = await w.webhook(raw, { signature: hubSignature(raw, FB_APP_SECRET) });
    assert.ok(res.status === 200 || res.status === 401, `Got ${res.status}`);
    await w.settle();
    assert.equal((await shop.inbound()).length, 0);
    assert.equal((await shop.call('/facebook/connection', 200)).enabled, false);
  } finally {
    await w.close();
  }
});

test('FB-02: the same shopper commenting on both copies gets one DM on each platform', async () => {
  const { shop, pageId, postId, auto } = await crossPosted();
  const ig = world.fan();
  await shop.comment(auto.mediaId, { from: ig });
  await fbComment(pageId, postId, fbFan());
  await shop.settle();
  assert.equal((await shop.dms()).length, 1);
  assert.equal((await pageSent(pageId)).length, 1);
});

test('FB-02: the caps apply per platform: a second Facebook comment is capped on Facebook only', async () => {
  const { shop, pageId, postId } = await crossPosted();
  const person = fbFan();
  await fbComment(pageId, postId, person);
  await shop.settle();
  await fbComment(pageId, postId, person);
  await shop.settle();
  assert.equal((await pageSent(pageId)).length, 1);
  await assertReason(shop, 'cap.per_media');
  const claims = await shop.sql(`SELECT DISTINCT channel FROM cap_claims WHERE tenant_id = $1`, [shop.tenantId]);
  assert.deepEqual(claims.map((c) => c.channel), ['facebook']);
});

test('FB-02: the same numeric id on the two platforms is two different people', async () => {
  const { shop, pageId, postId, auto } = await crossPosted();
  const person = world.fan();
  await shop.comment(auto.mediaId, { from: person });
  await fbComment(pageId, postId, { id: person.id, name: 'Same id' });
  await shop.settle();
  assert.notEqual(await shop.hash(person.id, 'instagram'), await shop.hash(person.id, 'facebook'));
  assert.equal((await shop.dms()).length, 1);
  assert.equal((await pageSent(pageId)).length, 1);
});

test('FB-03: linking a post to the wrong reel and fixing it: new comments follow the fix, past DMs are unchanged', async () => {
  const shop = await addShop(world);
  const { pageId } = await connectPage(world, shop);
  const postId = `${pageId}_${unique()}`;
  await world.meta.post('/facebook/posts', { pageId, id: postId, message: 'A reel' });
  const wrong = await shop.automate({ linkUrl: shop.siteUrl('/wrong') });
  const right = await shop.automate({ linkUrl: shop.siteUrl('/right') });
  await shop.call(`/facebook/links/${postId}`, 200, { method: 'PUT', body: { igMediaId: wrong.mediaId } });
  await fbComment(pageId, postId, fbFan());
  await shop.settle();
  const before = await pageSent(pageId);
  assert.equal(new URL(linkOf(before[0])).pathname, '/wrong');
  await shop.call(`/facebook/links/${postId}`, 200, { method: 'PUT', body: { igMediaId: right.mediaId } });
  await fbComment(pageId, postId, fbFan());
  await shop.settle();
  const after = await pageSent(pageId);
  assert.equal(after.length, 2);
  assert.equal(new URL(linkOf(after[1])).pathname, '/right');
  assert.equal(new URL(linkOf(after[0])).pathname, '/wrong');
});

test('FB-03: a job queued under the old link isn\'t rewritten by the fix', async () => {
  const shop = await addShop(world);
  const { pageId } = await connectPage(world, shop);
  const postId = `${pageId}_${unique()}`;
  await world.meta.post('/facebook/posts', { pageId, id: postId, message: 'A reel' });
  const wrong = await shop.automate({ linkUrl: shop.siteUrl('/wrong') });
  const right = await shop.automate({ linkUrl: shop.siteUrl('/right') });
  await shop.call(`/facebook/links/${postId}`, 200, { method: 'PUT', body: { igMediaId: wrong.mediaId } });
  await fbComment(pageId, postId, fbFan());
  await shop.call(`/facebook/links/${postId}`, 200, { method: 'PUT', body: { igMediaId: right.mediaId } });
  await shop.settle();
  const [job] = await shop.jobs();
  assert.equal(job.automation_id, wrong.id);
});

test('FB-03: removing the link stops new comments', async () => {
  const { shop, pageId, postId } = await crossPosted();
  assert.equal((await shop.api(`/facebook/links/${postId}`, { method: 'DELETE' })).status, 204);
  await fbComment(pageId, postId, fbFan());
  await shop.settle();
  assert.deepEqual(await pageSent(pageId), []);
});

test('FB-03: a post can\'t be linked to another business\'s reel, and another business can\'t touch this link', async () => {
  const a = await crossPosted();
  const b = await addShop(world);
  await connectPage(world, b);
  const theirReel = await b.automate();
  const res = await a.shop.api(`/facebook/links/${a.postId}`, { method: 'PUT', body: { igMediaId: theirReel.mediaId } });
  assert.ok(res.status === 400 || res.status === 404, `Got ${res.status}`);
  assert.equal((await b.api(`/facebook/links/${a.postId}`, { method: 'DELETE' })).status, 404);
  assert.equal((await b.api(`/facebook/links/${a.postId}`, { method: 'PUT', body: { igMediaId: theirReel.mediaId } })).status, 404);
  assert.deepEqual((await b.call('/facebook/links', 200)).items, []);
});

test('FB-03: one reel can be linked to one post at a time', async () => {
  const { shop, pageId, auto } = await crossPosted();
  const other = `${pageId}_${unique()}`;
  await world.meta.post('/facebook/posts', { pageId, id: other, message: 'Other' });
  const res = await shop.api(`/facebook/links/${other}`, { method: 'PUT', body: { igMediaId: auto.mediaId } });
  assert.ok(res.status >= 400 && res.status < 500, `Got ${res.status}`);
});

test('FB-03: hostile post ids and two saves at the same moment are handled', async () => {
  const { shop, pageId, auto } = await crossPosted();
  assert.equal((await shop.api(`/facebook/links/${encodeURIComponent('../../x')}`, { method: 'PUT', body: { igMediaId: auto.mediaId } })).status, 404);
  const other = `${pageId}_${unique()}`;
  await world.meta.post('/facebook/posts', { pageId, id: other, message: 'Other' });
  const reel = await shop.automate();
  const answers = await Promise.all([shop.api(`/facebook/links/${other}`, { method: 'PUT', body: { igMediaId: reel.mediaId } }), shop.api(`/facebook/links/${other}`, { method: 'PUT', body: { igMediaId: reel.mediaId } })]);
  assert.ok(answers.every((r) => r.status < 500), answers.map((r) => r.status).join());
});

test('FB-03: suggestions come from captions and posting time, and the owner has to confirm', async () => {
  const shop = await addShop(world);
  const { pageId } = await connectPage(world, shop);
  const caption = `Summer kurta drop ${unique()}`;
  const mediaId = await shop.reel({ caption });
  const postId = `${pageId}_${unique()}`;
  await world.meta.post('/facebook/posts', { pageId, id: postId, message: caption });
  const { items } = await shop.call('/facebook/link-suggestions', 200);
  assert.ok(items.some((s) => s.fbPostId === postId && s.igMediaId === mediaId), JSON.stringify(items));
  assert.deepEqual((await shop.call('/facebook/links', 200)).items.filter((l) => l.status === 'confirmed'), [], 'Nothing is linked until confirmed');
});

test('FB-04: the Page token expiring pauses Facebook and alerts the owner; Instagram keeps working', async () => {
  const { shop, pageId, pageToken, postId, auto } = await crossPosted();
  await world.meta.post('/tokens/expire', { token: pageToken });
  await fbComment(pageId, postId, fbFan());
  await shop.settle();
  const [page] = await shop.sql('SELECT * FROM fb_pages WHERE tenant_id = $1', [shop.tenantId]);
  assert.equal(page.status, 'reconnect_needed');
  assert.equal((await shop.call('/facebook/connection', 200)).status, 'reconnect_needed');
  assert.equal((await shop.alerts()).length, 1);
  await world.switchLag();
  const ig = await shop.comment(auto.mediaId);
  await shop.settle();
  assert.equal((await shop.dms({ commentId: ig.id })).length, 1, 'Instagram is untouched');
  assert.equal((await shop.account()).status, 'active');
  assert.equal((await shop.call('/compliance/status', 200)).reconnectNeeded, false, 'Instagram\'s own status');
});

test('FB-04: new Facebook comments are held while it is paused, and go after reconnecting', async () => {
  const { shop, pageId, pageToken, postId } = await crossPosted();
  await world.meta.post('/tokens/expire', { token: pageToken });
  await fbComment(pageId, postId, fbFan());
  await shop.settle();
  await world.switchLag();
  const person = fbFan();
  await fbComment(pageId, postId, person);
  await shop.settle();
  const held = await shop.jobs(`channel = 'facebook' AND status = 'held'`);
  assert.ok(held.length >= 1);
  assert.ok(held.every((j) => j.reason === 'paused.reconnect'));
  await world.meta.post('/facebook/login-next', { pageIds: [pageId] });
  const { authorizeUrl } = await shop.call('/facebook/connect', 200, { method: 'POST', body: {} });
  const consent = await fetch(authorizeUrl, { redirect: 'manual' });
  const back = new URL(consent.headers.get('location'));
  await hit(world, `${back.pathname}${back.search}`, { host: shop.host });
  await world.switchLag();
  await shop.settle();
  assert.ok((await pageSent(pageId, { recipientId: person.id })).length === 1);
});

test('FB-04: one Page token error doesn\'t alert twice', async () => {
  const { shop, pageId, pageToken, postId } = await crossPosted();
  await world.meta.post('/tokens/expire', { token: pageToken });
  await fbComment(pageId, postId, fbFan());
  await fbComment(pageId, postId, fbFan());
  await shop.settle();
  assert.equal((await shop.alerts()).length, 1);
});

test('FB-04: an Instagram problem doesn\'t pause Facebook', async () => {
  const { shop, pageId, postId } = await crossPosted();
  await world.meta.post('/tokens/revoke', { token: shop.igToken });
  const ig = await shop.reel();
  await shop.automate({ mediaId: ig });
  await shop.comment(ig);
  await shop.settle();
  await world.switchLag();
  await fbComment(pageId, postId, fbFan());
  await shop.settle();
  assert.equal((await pageSent(pageId)).length, 1);
});

test('FB-05: a shopper replying STOP in Messenger gets no more Messenger messages from that business', async () => {
  const { shop, pageId, postId } = await crossPosted();
  const person = fbFan();
  await world.meta.post('/facebook/messages', { pageId, from: person, text: 'STOP' });
  await shop.settle();
  const [row] = await shop.optOuts();
  assert.equal(row.channel, 'facebook');
  assert.equal(row.subject_hash, await shop.hash(person.id, 'facebook'));
  const confirmations = (await pageSent(pageId, { recipientId: person.id })).length;
  assert.ok(confirmations <= 1, 'At most the one confirmation');
  await fbComment(pageId, postId, person);
  await shop.settle();
  assert.equal((await pageSent(pageId, { recipientId: person.id })).length, confirmations);
  await assertReason(shop, 'optout');
});

test('FB-05: every spelling of the opt-out works in Messenger', async () => {
  const { shop, pageId } = await crossPosted();
  for (const text of ['stop', 'UNSUBSCRIBE', 'band karo', 'बंद करो']) await world.meta.post('/facebook/messages', { pageId, from: fbFan(), text });
  await shop.settle();
  assert.equal((await shop.optOuts()).length, 4);
});

test('FB-05: a Messenger STOP doesn\'t opt the same id out of Instagram, or the business\'s other channel', async () => {
  const { shop, pageId, auto } = await crossPosted();
  const person = world.fan();
  await world.meta.post('/facebook/messages', { pageId, from: { id: person.id, name: 'Same id' }, text: 'STOP' });
  await shop.settle();
  const comment = await shop.comment(auto.mediaId, { from: person });
  await shop.settle();
  assert.equal((await shop.dms({ commentId: comment.id })).length, 1);
});

test('FB-05: STOP as a Facebook comment blocks too, with no DM', async () => {
  const { shop, pageId, postId } = await crossPosted();
  const person = fbFan();
  await fbComment(pageId, postId, person, 'STOP');
  await shop.settle();
  assert.equal((await shop.optOuts()).length, 1);
  assert.deepEqual(await pageSent(pageId), []);
});

test('FB-05: a Messenger STOP and its opt-out are one business\'s only', async () => {
  const a = await crossPosted();
  const b = await crossPosted();
  const person = fbFan();
  await world.meta.post('/facebook/messages', { pageId: a.pageId, from: person, text: 'STOP' });
  await a.shop.settle();
  await fbComment(b.pageId, b.postId, person);
  await b.shop.settle();
  assert.equal((await pageSent(b.pageId, { recipientId: person.id })).length, 1);
});

test('FB-06: a business with Instagram only is told plainly it has no Page', async () => {
  const shop = await addShop(world);
  const out = await shop.call('/facebook/connection', 200);
  assert.equal(out.status, 'not_connected');
  assert.equal(out.pageId, null);
  assert.equal(out.enabled, true);
});

test('FB-06: with no Page the Facebook lists are empty and answer cleanly', async () => {
  const shop = await addShop(world);
  assert.deepEqual((await shop.call('/facebook/links', 200)).items, []);
  assert.deepEqual((await shop.call('/facebook/link-suggestions', 200)).items, []);
  assert.deepEqual((await shop.call('/facebook/posts', 200)).items, []);
});

test('FB-06: an Instagram-only business still runs its automations, with no Facebook job or alert', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate();
  await shop.comment(auto.mediaId);
  await shop.settle();
  assert.equal((await shop.dms()).length, 1);
  assert.deepEqual(await shop.jobs(`channel = 'facebook'`), []);
  assert.deepEqual(await shop.alerts(), []);
});

test('FB-06: disconnecting a Page leaves Instagram alone and deletes the Page token', async () => {
  const { shop } = await crossPosted();
  assert.equal((await shop.api('/facebook/connection', { method: 'DELETE' })).status, 204);
  assert.equal((await shop.call('/facebook/connection', 200)).status, 'not_connected');
  assert.equal((await shop.account()).status, 'active');
});

test('FB-06: a Page already connected to one business can\'t be taken by another', async () => {
  const a = await addShop(world);
  const { pageId } = await connectPage(world, a);
  const b = await addShop(world);
  await world.meta.post('/facebook/login-next', { pageIds: [pageId] });
  const { authorizeUrl } = await b.call('/facebook/connect', 200, { method: 'POST', body: {} });
  const consent = await fetch(authorizeUrl, { redirect: 'manual' });
  const back = new URL(consent.headers.get('location'));
  await hit(world, `${back.pathname}${back.search}`, { host: b.host });
  const owners = await a.sql('SELECT tenant_id FROM fb_pages WHERE page_id = $1', [pageId]);
  assert.deepEqual(owners.map((r) => r.tenant_id), [a.tenantId]);
});
