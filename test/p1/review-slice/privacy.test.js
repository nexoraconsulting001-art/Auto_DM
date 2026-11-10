import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addBusiness, startSlice } from './support.js';

const open = (slice, host, path = '/privacy') => fetch(`${slice.app.base}${path}`, { headers: { 'x-forwarded-host': host }, redirect: 'manual' });

test('the address registered with Meta shows Bhava\'s public privacy policy, and it explains deletion', async (t) => {
  const slice = await startSlice(t);
  const res = await open(slice, 'connect.bhava.test');
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /html/);
  assert.equal(res.headers.get('set-cookie'), null, 'no session needed');
  assert.equal(res.headers.get('x-robots-tag'), null);
  assert.doesNotMatch(text, /noindex/i);
  assert.match(text, /Bhava/);
  assert.match(text, /How to delete your data/);
  assert.match(text, /within 30 days/);
  assert.match(text, /never sell/i);
  assert.match(text, /<td>7 days<\/td>/);
  assert.match(text, /<td>30 days<\/td>/);
});

test('it is there with no business at all', async (t) => {
  const slice = await startSlice(t, { overrides: { defaultTenant: '' } });
  assert.equal((await open(slice, 'connect.bhava.test')).status, 200);
  assert.equal((await open(slice, 'bhava.test')).status, 200);
  assert.equal((await open(slice, 'nowhere.example')).status, 404);
});

test('a contact address appears when one is set', async (t) => {
  const slice = await startSlice(t, { overrides: { privacyContactEmail: 'privacy@bhava.test' } });
  assert.match(await (await open(slice, 'connect.bhava.test')).text(), /privacy@bhava\.test/);
});

test('on a business\'s address a buyer sees that business\'s policy, with no sign of Bhava', async (t) => {
  const slice = await startSlice(t);
  const business = await addBusiness(slice.app, 'kesar');
  const res = await open(slice, business.host);
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.match(text, /How to delete your data/);
  assert.doesNotMatch(text, /bhava/i);
});

test('with no address of its own for Meta, /privacy is the store\'s', async (t) => {
  const slice = await startSlice(t, { overrides: { metaCallbackBaseUrl: 'https://shop.test', publicBaseUrl: 'https://shop.test' } });
  const text = await (await open(slice, 'shop.test')).text();
  assert.doesNotMatch(text, /bhava/i);
});
