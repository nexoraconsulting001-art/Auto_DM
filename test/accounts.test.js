import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER, login, seedReel, startApp } from './helpers.js';
import { withConsoleApi } from './p0/console-port/support/console-api.js';

const form = (o) => new URLSearchParams(o);
const customer = { name: 'Asha K', phone: '9876543210', address: '12 MG Road', city: 'Pune', state: 'MH', pincode: '411001' };

test('shoppers sign up, log in, and are kept out of the admin panel', async () => {
  const app = await startApp();
  try {
    const signup = await fetch(`${app.base}/signup`, { method: 'POST', body: form({ name: 'Asha K', phone: '98765 43210', password: 'secret1' }), redirect: 'manual' });
    assert.equal(signup.status, 303);
    assert.equal(signup.headers.get('location'), '/account');
    const cookie = signup.headers.get('set-cookie').split(';')[0];

    const account = await (await fetch(`${app.base}/account`, { headers: { cookie } })).text();
    assert.match(account, /Hi, Asha/);
    assert.match(account, /No orders yet/);

    // The console's page is open to anyone; the seller API behind it is what keeps a shopper out.
    assert.equal((await fetch(`${app.base}/api/v1/products`, { headers: { cookie } })).status, 403);

    const dup = await fetch(`${app.base}/signup`, { method: 'POST', body: form({ name: 'Other', phone: '9876543210', password: 'secret2' }) });
    assert.equal(dup.status, 400);
    assert.match(await dup.text(), /already exists/);

    const short = await fetch(`${app.base}/signup`, { method: 'POST', body: form({ name: 'New', phone: '9876500000', password: '123' }) });
    assert.equal(short.status, 400);

    const again = await login(app.base, { phone: '9876543210', password: 'secret1' });
    assert.equal(again.location, '/account');
  } finally {
    app.close();
  }
});

test('the owner from .env is an owner, and logins are rate limited', async () => {
  const app = await startApp();
  try {
    const owner = await app.repos.users.findByPhone(OWNER.phone);
    assert.equal(owner.role, 'owner');
    // Running ensureOwner again (every start) keeps one account.
    await app.repos.users.ensureOwner(OWNER);
    assert.equal((await app.repos.users.listCustomers()).length, 1);

    for (let i = 0; i < 10; i++) {
      await fetch(`${app.base}/login`, { method: 'POST', body: form({ phone: OWNER.phone, password: 'wrong' }) });
    }
    const locked = await fetch(`${app.base}/login`, { method: 'POST', body: form(OWNER) });
    assert.equal(locked.status, 429);
  } finally {
    app.close();
  }
});

test('login forms from another site are refused', async () => {
  const app = await startApp();
  try {
    const res = await fetch(`${app.base}/login`, { method: 'POST', headers: { origin: 'https://evil.test' }, body: form(OWNER) });
    assert.equal(res.status, 403);
  } finally {
    app.close();
  }
});

test('checkout needs a login; orders show on My account and the address is saved', async () => {
  const app = await startApp();
  try {
    const { products } = await seedReel(app.repos, { n: 1 });
    const order = (headers, body) =>
      fetch(`${app.base}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const body = { items: [{ productId: products[0].id, qty: 2 }], customer };

    // Guests can browse but not order.
    assert.equal((await fetch(`${app.base}/r/brunch-edit`)).status, 200);
    const page = await fetch(`${app.base}/checkout`, { redirect: 'manual' });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/login?next=%2Fcheckout');
    const guest = await order({}, body);
    assert.equal(guest.status, 401);
    assert.match((await guest.json()).error, /log in/);
    assert.match(await (await fetch(`${app.base}/login?next=/checkout`)).text(), /create an account to place your order/);

    await app.repos.users.create({ name: 'Asha K', phone: customer.phone, password: 'secret1' });
    const { cookie, csrf } = await login(app.base, { phone: customer.phone, password: 'secret1', csrfPage: '/checkout' });
    assert.ok(csrf);
    assert.equal((await order({ cookie }, body)).status, 403); // the CSRF token is required
    assert.equal((await order({ cookie, 'x-csrf-token': csrf }, body)).status, 201);

    const user = await app.repos.users.findByPhone(customer.phone);
    assert.equal(user.address.pincode, '411001');
    assert.match(await (await fetch(`${app.base}/checkout`, { headers: { cookie } })).text(), /value="411001"/);
    const account = await (await fetch(`${app.base}/account`, { headers: { cookie } })).text();
    assert.equal((account.match(/class="order-row"/g) || []).length, 1);
  } finally {
    app.close();
  }
});

test('owner rights come only from the role command; signups are customers', async () => {
  const { changeRole } = await import('../scripts/role.js');
  const app = await startApp({ modules: withConsoleApi() });
  const sellerApi = (cookie) => fetch(`${app.base}/api/v1/settings`, { headers: { cookie } });
  try {
    // A signup form can't ask for owner rights.
    const signup = await fetch(`${app.base}/signup`, { method: 'POST', body: form({ name: 'Meera', phone: '9988776655', password: 'secret1', role: 'owner' }), redirect: 'manual' });
    const cookie = signup.headers.get('set-cookie').split(';')[0];
    assert.equal((await app.repos.users.findByPhone('9988776655')).role, 'customer');
    assert.equal((await sellerApi(cookie)).status, 403);

    assert.match(await changeRole(app.repos, { phone: '9988776655', role: 'owner', ownerPhone: OWNER.phone }), /is now an owner/);
    assert.equal((await sellerApi(cookie)).status, 200);
    // Owners other than the .env owner manage their own password.
    assert.match(await (await fetch(`${app.base}/account`, { headers: { cookie } })).text(), /Change password/);

    assert.match(await changeRole(app.repos, { phone: '9988776655', role: 'customer', ownerPhone: OWNER.phone }), /is now a customer/);
    assert.equal((await sellerApi(cookie)).status, 403);

    await assert.rejects(changeRole(app.repos, { phone: OWNER.phone, role: 'customer', ownerPhone: OWNER.phone }), /ADMIN_PHONE/);
    await assert.rejects(changeRole(app.repos, { phone: '9000011111', role: 'owner' }), /sign up on the website first/);
    await assert.rejects(changeRole(app.repos, { phone: '9988776655', role: 'boss' }), /"owner", "staff" or "customer"/);
  } finally {
    app.close();
  }
});

test('customers change their password; the owner can reset a forgotten one', async () => {
  const app = await startApp({ modules: withConsoleApi() });
  try {
    const shopper = await app.repos.users.create({ name: 'Ravi', phone: '9123456780', password: 'first1' });
    const s = await login(app.base, { phone: '9123456780', password: 'first1' });
    const bad = await fetch(`${app.base}/account/password`, { method: 'POST', headers: { cookie: s.cookie }, body: form({ _csrf: s.csrf, current: 'nope', password: 'second2' }) });
    assert.equal(bad.status, 400);
    const ok = await fetch(`${app.base}/account/password`, { method: 'POST', headers: { cookie: s.cookie }, body: form({ _csrf: s.csrf, current: 'first1', password: 'second2' }), redirect: 'manual' });
    assert.equal(ok.status, 303);
    assert.ok(await app.repos.users.verify('9123456780', 'second2'));

    const o = await login(app.base);
    const reset = await fetch(`${app.base}/api/v1/customers/${shopper.id}/reset-password`, { method: 'POST', headers: { cookie: o.cookie, 'x-csrf-token': o.csrf } });
    assert.equal(reset.status, 200);
    const fresh = (await reset.json()).temporaryPassword;
    assert.ok(await app.repos.users.verify('9123456780', fresh));
  } finally {
    app.close();
  }
});

test('owners see the owner bar and Edit buttons on the storefront; shoppers do not', async () => {
  const app = await startApp();
  try {
    const { products } = await seedReel(app.repos, { n: 1 });
    const anon = await (await fetch(`${app.base}/p/${products[0].slug}`)).text();
    assert.doesNotMatch(anon, /owner-bar/);
    const { cookie } = await login(app.base);
    const owner = await (await fetch(`${app.base}/p/${products[0].slug}`, { headers: { cookie } })).text();
    assert.match(owner, /class="owner-bar"/);
    assert.match(owner, new RegExp(`href="/admin/products/${products[0].id}">Edit product`));
  } finally {
    app.close();
  }
});
