// D-11 (PRD 6.1, 8.10): a reel is its landing page; the DM a comment gets is an automation's, made in Automations where the
// plan's limits and the message and link checks apply. The seller API no longer takes the Phase 0 keyword DM fields, so a new
// reel can't answer comments by itself. A Phase 0 reel that already had a keyword DM keeps it, unchanged by a save.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { IG_ACCOUNT, REEL_ID, seedReel } from '../../helpers.js';
import { ok, refused, withApp } from '../../p0/admin-api/support.js';

const NEW_REEL = '18475694065119999';

function comment(app, mediaId, text = 'LINK') {
  const body = JSON.stringify({ entry: [{ id: IG_ACCOUNT.igUserId, changes: [{ field: 'comments', value: { id: `c-${crypto.randomUUID()}`, text, media: { id: mediaId }, from: { id: 'u1', username: 'bob' } } }] }] });
  const sig = `sha256=${crypto.createHmac('sha256', 'secret').update(body).digest('hex')}`;
  return fetch(`${app.base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body });
}
const settle = async (app, want, ms = 1500) => {
  for (let waited = 0; waited < ms && app.ig.calls.length < want; waited += 25) await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 150));
};

test('D-11: reels.save refuses keyword DM fields; a new reel has none and its comments get no DM of its own', withApp(async (app) => {
  const { api } = app;
  const product = await ok(await api('POST', '/products', { name: 'Lamp', pricePaise: 49900 }), 201);
  for (const field of [{ keywords: ['LINK'] }, { dmMessage: 'Hi' }, { buttonText: 'Shop' }, { publicReply: 'Sent!' }]) {
    const res = await refused(await api('PUT', `/reels/${NEW_REEL}`, { headline: 'Lamp edit', productIds: [product.id], ...field }), 400, 'validation_failed');
    assert.match(res.fields[Object.keys(field)[0]], /Automations/);
  }
  const reel = await ok(await api('PUT', `/reels/${NEW_REEL}`, { headline: 'Lamp edit', productIds: [product.id] }));
  assert.deepEqual(reel.keywords, []);
  assert.match(reel.storeUrl, /\/r\/lamp-edit/);

  await comment(app, NEW_REEL);
  await settle(app, 1);
  assert.equal(app.ig.calls.length, 0, 'a reel without an automation sends nothing');
}));

test('D-11: a Phase 0 reel keeps its keyword DM when its store is saved again through the API', withApp(async (app) => {
  const { api } = app;
  const { products } = await seedReel(app.repos);
  const saved = await ok(await api('PUT', `/reels/${REEL_ID}`, { headline: 'Brunch edit, new', productIds: products.map((p) => p.id) }));
  assert.equal(saved.headline, 'Brunch edit, new');
  assert.deepEqual(saved.keywords, ['LINK']);
  await comment(app, REEL_ID);
  await settle(app, 1);
  assert.equal(app.ig.calls.length, 1, 'the existing reel still answers until it is moved to an automation');
}));
