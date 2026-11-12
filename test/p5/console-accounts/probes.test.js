// What the console's sign-in page asks the server before it draws (console/src/features/account/options.js and signin.js),
// against the real app: whether the phone-and-password form exists (only while PASSWORD_LOGIN is on), whether Google
// starts on this address (only on the sign-in host), and which ways in app.requirements offers. The questions must
// change nothing: no failed sign-in recorded, no limit used up. P-11 (the console's half).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { googleStartsHere, passwordLoginOn, waysIn } from '../../../console/src/features/account/signin.js';
import { APP_HOST, OWNER, accountsApp, call } from './support.js';

/** A browser's fetch on `host` (null: the default business at 127.0.0.1). */
const on = (app, host) => (path, init = {}) => fetch(`${app.base}${path}`, {
  ...init,
  headers: { ...(init.headers ?? {}), ...(host ? { 'x-forwarded-host': host } : {}), 'x-forwarded-for': '10.77.0.1' },
});

describe('with PASSWORD_LOGIN on (tests and local runs)', () => {
  let app;
  before(async () => {
    app = await accountsApp({ overrides: { passwordLogin: true } });
  });
  after(() => app?.close());

  test('P-11: the sign-in page is told the password form exists on a business\'s own address', async () => {
    assert.equal(await passwordLoginOn(on(app, null)), true);
  });

  test('asking records no failed sign-in and uses up no limit: the right password still opens, a wrong one is still "don’t match"', async () => {
    for (let i = 0; i < 40; i++) assert.equal(await passwordLoginOn(on(app, null)), true);
    const wrong = await call(app, '/api/v1/auth/login', { method: 'POST', host: null, ip: '10.77.0.1', body: { phone: OWNER.phone, password: 'not-it', transport: 'bearer' } });
    assert.equal(wrong.status, 401, wrong.text);
    assert.match(wrong.json.error, /don’t match/);
    const right = await call(app, '/api/v1/auth/login', { method: 'POST', host: null, ip: '10.77.0.1', body: { phone: OWNER.phone, password: OWNER.password, transport: 'bearer' } });
    assert.equal(right.status, 201, right.text);
  });

  test('Google starts on the sign-in host and nowhere else, even where Google is not set up', async () => {
    assert.equal(await googleStartsHere(on(app, APP_HOST)), true);
    assert.equal(await googleStartsHere(on(app, null)), false);
  });

  test('P-11: on the sign-in host the password route exists but the form is not offered, because a password cannot open a session there', async () => {
    const send = on(app, APP_HOST);
    const ways = waysIn({ passwordRoute: await passwordLoginOn(send), requirements: { signIn: { whatsapp: true, google: false } }, signInHost: await googleStartsHere(send) });
    assert.equal(ways.password, false);
    // What the form would have done there: refused, whatever the number and password.
    const tried = await call(app, '/api/v1/auth/login', { method: 'POST', body: { phone: OWNER.phone, password: OWNER.password, transport: 'cookie' } });
    assert.equal(tried.status, 401, tried.text);
    const here = on(app, null);
    assert.equal(waysIn({ passwordRoute: await passwordLoginOn(here), signInHost: await googleStartsHere(here) }).password, true, 'on a business\'s own address it is offered');
  });

  test('app.requirements answers the console, which sends no app headers, with the ways in', async () => {
    const res = await call(app, '/api/v1/app/requirements?platform=android', { host: null });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.signIn, { whatsapp: true, google: false, apple: false });
    const there = await call(app, '/api/v1/app/requirements?platform=android');
    assert.equal(there.status, 200);
  });
});

describe('with PASSWORD_LOGIN off (everywhere else)', () => {
  let app;
  before(async () => {
    app = await accountsApp({ overrides: { passwordLogin: false, sellerGoogleClientId: 'sim-seller-google-client', sellerGoogleClientSecret: 'sim-seller-google-secret' } });
  });
  after(() => app?.close());

  test('P-11: no password form, on a business\'s address or on the sign-in host', async () => {
    assert.equal(await passwordLoginOn(on(app, null)), false);
    assert.equal(await passwordLoginOn(on(app, APP_HOST)), false);
    // The answer comes before the bearer check, so no token, cookie or body changes it.
    const res = await call(app, '/api/v1/auth/login', { method: 'POST', host: null, body: { phone: OWNER.phone, password: OWNER.password } });
    assert.equal(res.status, 404);
  });

  test('Google is offered where it starts: set up on the server, and on the sign-in host', async () => {
    const res = await call(app, '/api/v1/app/requirements?platform=android');
    assert.equal(res.json.signIn.google, true);
    assert.equal(await googleStartsHere(on(app, APP_HOST)), true);
    assert.equal(await googleStartsHere(on(app, null)), false);
  });

  test('a server that cannot be reached is no password form and no Google', async () => {
    const offline = async () => {
      throw new TypeError('fetch failed');
    };
    assert.equal(await passwordLoginOn(offline), false);
    assert.equal(await googleStartsHere(offline), false);
  });
});
