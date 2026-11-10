// Image upload through /api/v1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediaUploaded } from '../../../src/contracts/api/index.js';
import { at, bearer, ok, refused, secondBusiness, withApp } from './support.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const upload = (app, token, blob = new Blob([PNG], { type: 'image/png' }), name = 'a.png') => {
  const form = new FormData();
  form.append('file', blob, name);
  return fetch(`${app.base}/api/v1/media`, { method: 'POST', headers: bearer(token), body: form });
};

test('an uploaded image comes back from the store, and can be used on a product', withApp(async (app) => {
  const uploaded = await ok(await upload(app, app.owner), 201);
  assert.equal(MediaUploaded.safeParse(uploaded).success, true);
  assert.equal(uploaded.url, `/media/${uploaded.id}`);
  const served = await fetch(`${app.base}${uploaded.url}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);
  const product = await ok(await app.api('POST', '/products', { name: 'Pot', pricePaise: 100, images: [uploaded.url] }), 201);
  assert.deepEqual(product.images, [uploaded.url]);
}));

test('F-06: another business\'s media id is a 404 on this business\'s address', withApp(async (app) => {
  const leaf = await secondBusiness(app);
  const theirs = await ok(await upload(app, leaf.token), 201);
  assert.equal((await fetch(`${app.base}${theirs.url}`, { headers: at('leaf.bhava.test') })).status, 200);
  assert.equal((await fetch(`${app.base}${theirs.url}`)).status, 404);
}));

test('wrong types, oversized files and shoppers are all refused', withApp(async (app) => {
  await refused(await upload(app, app.owner, new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'a.svg'), 415, 'unsupported_media_type');
  await refused(await upload(app, app.owner, new Blob([Buffer.alloc(5 * 1024 * 1024 + 1)], { type: 'image/png' })), 413, 'payload_too_large');
  const shopper = { name: 'Asha K', phone: '9876543210', password: 'secret1' };
  await app.repos.users.create(shopper);
  await refused(await upload(app, await app.signIn(shopper)), 403, 'forbidden');
}));
