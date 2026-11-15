// D-4 (PRD 4.2; p1-known-problems): connecting Instagram finishes only in the session of the person who started it. A
// seller who passes the authorize address to someone else cannot put that person's Instagram on the seller's business:
// the browser that finishes Meta's consent is not signed in as the seller, so nothing is connected, and it is audited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../../src/tenancy.js';
import { IG_A, IG_B, accountRow, addBusiness, seedIg, startSlice } from '../../p1/review-slice/support.js';

const VICTIM = IG_B;

/** The owner's console session on the business's own host: its cookie and CSRF token. */
async function consoleSession(app, business) {
  const owner = await business.repos.users.findByPhone(business.phone);
  const token = await withTenant(business.tenant, () => app.platform.sessions.create(owner.id, 1, 'cookie'));
  const cookie = `sid=${token}`;
  const me = await fetch(`${app.base}/api/v1/auth/me`, { headers: { cookie, 'x-forwarded-host': business.host } });
  assert.equal(me.status, 200, 'the console session works');
  return { cookie, csrf: (await me.json()).csrf, ownerId: owner.id };
}

/** Meta's consent in some browser, and that browser arriving at the registered callback. Returns where it is sent next. */
async function consentAndReturn(app, authorizeUrl) {
  const dialog = await fetch(authorizeUrl, { redirect: 'manual' });
  assert.equal(dialog.status, 302, await dialog.text());
  const back = new URL(dialog.headers.get('location'));
  const done = await fetch(`${app.base}${back.pathname}${back.search}`, { redirect: 'manual', headers: { 'x-forwarded-host': back.host } });
  assert.equal(done.status, 303, `the callback answered ${done.status}`);
  return new URL(done.headers.get('location'), 'http://relative.invalid');
}

const follow = (app, next, headers = {}) => fetch(`${app.base}${next.pathname}${next.search}`, { redirect: 'manual', headers: { 'x-forwarded-host': next.host, ...headers } });

test('D-4: an authorize address the seller started, finished in someone else\'s browser, connects nothing and is audited', async (t) => {
  const slice = await startSlice(t);
  const { app, sim } = slice;
  const seller = await addBusiness(app);
  const session = await consoleSession(app, seller);
  await seedIg(sim, VICTIM);
  await sim.post('/oauth/next', { igUserId: VICTIM });
  const started = await fetch(`${app.base}/api/v1/instagram/connect`, { method: 'POST', headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, 'x-forwarded-host': seller.host, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(started.status, 200, await started.clone().text());
  const { authorizeUrl } = await started.json();

  // The victim opens the address, logs in to Instagram and consents, in their own browser (no Bhava session).
  const next = await consentAndReturn(app, authorizeUrl);
  const finished = await follow(app, next);
  assert.ok(finished.status >= 400 || !/instagram=connected/.test(finished.headers.get('location') ?? ''), `the victim's browser finished the connect: ${finished.status} ${finished.headers.get('location')}`);
  assert.equal(await accountRow(slice, VICTIM), null, 'the victim\'s Instagram was put on the seller\'s business');
  const audit = await slice.q(`SELECT details FROM audit_log WHERE tenant_id = $1 AND action = 'instagram.connect_refused'`, [seller.tenant.id]);
  assert.equal(audit.length, 1, 'the refused finish is on the audit log');

  // The seller cannot pick it up afterwards either: the finish token is spent.
  const again = await follow(app, next, { cookie: session.cookie });
  assert.equal(again.status, 400);
  assert.equal(await accountRow(slice, VICTIM), null);
});

test('D-4: the console\'s own browser, signed in as who started it, finishes the connect', async (t) => {
  const slice = await startSlice(t);
  const { app, sim } = slice;
  const seller = await addBusiness(app);
  const session = await consoleSession(app, seller);
  await seedIg(sim, IG_A);
  await sim.post('/oauth/next', { igUserId: IG_A });
  const started = await fetch(`${app.base}/api/v1/instagram/connect`, { method: 'POST', headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, 'x-forwarded-host': seller.host, 'content-type': 'application/json' }, body: '{}' });
  const { authorizeUrl } = await started.json();
  const next = await consentAndReturn(app, authorizeUrl);
  assert.equal(next.host, seller.host, 'the finish step is on the host the console started from');
  const finished = await follow(app, next, { cookie: session.cookie });
  assert.equal(finished.status, 303, await finished.clone().text());
  assert.equal(new URL(finished.headers.get('location'), 'http://relative.invalid').searchParams.get('instagram'), 'connected');
  assert.equal(Number((await accountRow(slice, IG_A)).tenant_id), Number(seller.tenant.id));
});

test('D-4: the owner app finishes with its own token; nobody else\'s token can', async (t) => {
  const slice = await startSlice(t);
  const { app, sim } = slice;
  const seller = await addBusiness(app);
  const other = await addBusiness(app);
  await seedIg(sim, IG_A);
  await sim.post('/oauth/next', { igUserId: IG_A });
  const started = await seller.api('POST', '/instagram/connect', {});
  assert.equal(started.status, 200);
  const next = await consentAndReturn(app, started.body.authorizeUrl);
  assert.equal(next.protocol, 'bhavabusiness:', 'Meta\'s answer goes back to the owner app');
  const finishToken = next.searchParams.get('f');
  assert.ok(finishToken);
  assert.equal(await accountRow(slice, IG_A), null, 'nothing is connected before the app finishes');

  // Another business's owner holding the token cannot finish it, in their business or this one.
  const stolen = await other.api('POST', '/instagram/connect/finish', { finishToken });
  assert.ok([403, 404].includes(stolen.status) || stolen.body?.outcome === 'expired', `another business finished it: ${stolen.status} ${JSON.stringify(stolen.body)}`);
  assert.equal(await accountRow(slice, IG_A), null);
});

test('D-4: the owner app, signed in as who started it, finishes the connect', async (t) => {
  const slice = await startSlice(t);
  const { app, sim } = slice;
  const seller = await addBusiness(app);
  await seedIg(sim, IG_A);
  await sim.post('/oauth/next', { igUserId: IG_A });
  const started = await seller.api('POST', '/instagram/connect', {});
  const next = await consentAndReturn(app, started.body.authorizeUrl);
  const done = await seller.api('POST', '/instagram/connect/finish', { finishToken: next.searchParams.get('f') });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.outcome, 'connected');
  assert.equal(Number((await accountRow(slice, IG_A)).tenant_id), Number(seller.tenant.id));
  const twice = await seller.api('POST', '/instagram/connect/finish', { finishToken: next.searchParams.get('f') });
  assert.equal(twice.body?.outcome, 'expired', 'a finish token works once');
});
