// The console's business switcher and session watch (console/src/features/account/workspace.js): first on their own, with a
// stand-in page, then against the real app through the console's own API client. P-09, P-10, P-08, F-47 (the console's half).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/react-query';
import { createWorkspace, WORKSPACE_KEY } from '../../../console/src/features/account/workspace.js';
import { bindTenant } from '../../../src/repos/index.js';
import { OWNER, accountsApp, call, codeSignIn, consoleOn, freshCodes, memoryStorage, otherBusiness, testDevice, typedAccount } from './support.js';

const SESSION = ['session'];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A page whose fetch answers from `answer(path, headers, init)` and records every call. */
function page({ answer = () => json({}), origin = 'https://app.bhava.example' } = {}) {
  const calls = [];
  const listeners = {};
  const doc = { visibilityState: 'visible', addEventListener: (t, fn) => { listeners[`doc:${t}`] = fn; }, removeEventListener() {} };
  const target = {
    location: { href: `${origin}/admin/orders`, origin },
    document: doc,
    addEventListener: (t, fn) => { listeners[t] = fn; },
    removeEventListener() {},
    async fetch(input, init = {}) {
      const url = new URL(input, origin);
      const headers = new Headers(init.headers ?? {});
      calls.push({ href: url.href, path: url.pathname, method: init.method ?? 'GET', tenant: headers.get('x-tenant-id') });
      return answer(url.pathname, headers, init);
    },
  };
  return { target, calls, listeners, doc };
}

describe('on its own', () => {
  test('a chosen business rides on every same-site /api/v1 call, and on nothing else', async () => {
    const queries = new QueryClient();
    const { target, calls } = page({ answer: (path) => json(path === '/api/v1/auth/me' ? { user: { id: 2 }, business: { id: 7 } } : {}) });
    const storage = memoryStorage();
    const ws = createWorkspace({ target, storage, queries, sessionKey: SESSION });
    await target.fetch('/api/v1/orders');
    assert.equal(calls.at(-1).tenant, null, 'nothing chosen: the session\'s own business');

    await ws.choose(7, () => target.fetch('/api/v1/auth/me').then((r) => r.json()));
    assert.equal(ws.current(), '7');
    assert.equal(storage.getItem(WORKSPACE_KEY), '7', 'kept for this tab');
    await target.fetch('/api/v1/orders?limit=5');
    assert.equal(calls.at(-1).tenant, '7');
    await target.fetch('https://app.bhava.example/api/v1/products');
    assert.equal(calls.at(-1).tenant, '7', 'the same site, written out in full');
    await target.fetch('https://elsewhere.example/api/v1/orders');
    assert.equal(calls.at(-1).tenant, null, 'another site never learns the business');
    await target.fetch('/media/abc');
    assert.equal(calls.at(-1).tenant, null, 'only the API');
    await target.fetch('/api/v1/orders', { headers: { 'x-tenant-id': '9' } });
    assert.equal(calls.at(-1).tenant, '9', 'a call that names its own business keeps it');
    ws.stop();
    assert.notEqual(target.fetch.name, 'fetchInWorkspace', 'stopping puts the page\'s fetch back');
  });

  test('a tab opened again keeps its business; a value that is no business is ignored', () => {
    const queries = new QueryClient();
    const storage = memoryStorage();
    storage.setItem(WORKSPACE_KEY, '12');
    assert.equal(createWorkspace({ target: page().target, storage, queries }).current(), '12');
    for (const bad of ['0', '-1', 'abc', '1; drop', '99999999999']) {
      storage.setItem(WORKSPACE_KEY, bad);
      assert.equal(createWorkspace({ target: page().target, storage, queries }).current(), '', bad);
    }
  });

  test('P-10: switching drops every cached answer before the session is read again, so no row of the old business is shown', async () => {
    const queries = new QueryClient();
    queries.setQueryData(SESSION, { user: { id: 1 }, business: { id: 1, name: 'First' } });
    queries.setQueryData(['orders', 'list', {}], { pages: [{ items: [{ id: 'first-business-order' }] }] });
    queries.setQueryData(['stats'], { orders: 3 });
    const { target } = page();
    const ws = createWorkspace({ target, storage: memoryStorage(), queries, sessionKey: SESSION });
    let cachedWhenAsked;
    const session = await ws.choose(2, async () => {
      cachedWhenAsked = queries.getQueryData(['orders', 'list', {}]);
      return { user: { id: 5 }, business: { id: 2, name: 'Second' } };
    });
    assert.equal(cachedWhenAsked, undefined, 'the old business\'s orders were gone before the new session was read');
    assert.equal(queries.getQueryData(['stats']), undefined);
    assert.equal(session.business.id, 2);
    assert.equal(queries.getQueryData(SESSION).business.name, 'Second');
    await assert.rejects(() => ws.choose('2; x', async () => ({})), /Not a business/);
  });

  test('no longer at the chosen business: who-am-I is asked again without it, and the old answers are dropped', async () => {
    const queries = new QueryClient();
    queries.setQueryData(SESSION, { user: { id: 5 }, business: { id: 2 } });
    queries.setQueryData(['orders', 'list', {}], { items: ['second-business'] });
    const { target, calls } = page({
      answer: (path, headers) => {
        if (path === '/api/v1/auth/me') return headers.get('x-tenant-id') ? json({ error: 'You don’t have access to this.', code: 'forbidden' }, 403) : json({ user: { id: 1 }, business: { id: 1 } });
        return json({});
      },
    });
    const storage = memoryStorage();
    storage.setItem(WORKSPACE_KEY, '2');
    const ws = createWorkspace({ target, storage, queries, sessionKey: SESSION });
    const res = await target.fetch('/api/v1/auth/me');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).business.id, 1);
    assert.deepEqual(calls.map((c) => c.tenant), ['2', null]);
    assert.equal(ws.current(), '');
    assert.equal(storage.getItem(WORKSPACE_KEY), null);
    assert.equal(queries.getQueryData(['orders', 'list', {}]), undefined);
  });

  test('a refusal that is about a permission keeps the business, and looks again at once', async () => {
    const queries = new QueryClient();
    let me = 0;
    await queries.fetchQuery({ queryKey: SESSION, queryFn: async () => { me++; return { user: { id: 5 }, business: { id: 2 } }; } });
    const { target } = page({ answer: (path) => (path === '/api/v1/orders' ? json({ error: 'Owner only.', code: 'forbidden' }, 403) : json({})) });
    const storage = memoryStorage();
    storage.setItem(WORKSPACE_KEY, '2');
    const ws = createWorkspace({ target, storage, queries, sessionKey: SESSION });
    const res = await target.fetch('/api/v1/orders');
    assert.equal(res.status, 403, 'the screen still gets the refusal to show');
    assert.equal(ws.current(), '2');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(me, 2, 'who-am-I was asked again');
  });

  test('a session that ends without a sign-out here is "ended elsewhere"; signing out here is not', async () => {
    const queries = new QueryClient();
    queries.setQueryData(SESSION, { user: { id: 1 }, business: { id: 1 } });
    const { target } = page({ answer: () => new Response(null, { status: 204 }) });
    const storage = memoryStorage();
    storage.setItem(WORKSPACE_KEY, '3');
    const ws = createWorkspace({ target, storage, queries, sessionKey: SESSION });
    queries.setQueryData(SESSION, null);
    assert.equal(ws.endedBecause(), 'elsewhere');
    assert.equal(ws.current(), '', 'a business chosen in a session that ended is forgotten');

    queries.setQueryData(SESSION, { user: { id: 1 }, business: { id: 1 } });
    assert.equal(ws.endedBecause(), '', 'a new sign-in starts clean');
    await target.fetch('/api/v1/auth/logout', { method: 'POST' });
    queries.setQueryData(SESSION, null);
    assert.equal(ws.endedBecause(), '');

    queries.setQueryData(SESSION, { user: { id: 1 }, business: { id: 1 } });
    queries.setQueryData(['orders'], ['x']);
    ws.deleted();
    assert.equal(ws.endedBecause(), 'deleted');
    assert.equal(queries.getQueryData(SESSION), null);
    assert.equal(queries.getQueryData(['orders']), undefined);
  });

  test('the watch asks who is signed in while the tab is in view, not more than once in 3 s, and never while hidden', async () => {
    let clock = 1_000_000;
    const queries = new QueryClient();
    let asked = 0;
    let alive = true;
    await queries.fetchQuery({ queryKey: SESSION, queryFn: async () => { asked++; return alive ? { user: { id: 1 }, business: { id: 1 } } : null; } });
    const { target, listeners, doc } = page();
    const ws = createWorkspace({ target, storage: memoryStorage(), queries, sessionKey: SESSION, pollMs: 50, now: () => clock });
    await ws.check();
    assert.equal(asked, 2);
    await ws.check();
    assert.equal(asked, 2, 'twice inside 3 s is once');
    clock += 3001;
    doc.visibilityState = 'hidden';
    await ws.check();
    assert.equal(asked, 2, 'a hidden tab asks nothing');
    doc.visibilityState = 'visible';
    ws.start();
    assert.equal(typeof listeners.focus, 'function');
    assert.equal(typeof listeners.online, 'function');
    assert.equal(typeof listeners['doc:visibilitychange'], 'function');
    alive = false;
    listeners.focus();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(asked, 3, 'coming back into view asks at once');
    assert.equal(queries.getQueryData(SESSION), null);
    assert.equal(ws.endedBecause(), 'elsewhere');
    clock += 5000;
    await ws.check();
    assert.equal(asked, 3, 'nobody signed in: nothing to watch');
    ws.stop();
  });
});

describe('against the app', () => {
  let app;
  let second;
  let decoy;
  before(async () => {
    app = await accountsApp();
    second = await otherBusiness(app, 'Second Shop');
    decoy = await otherBusiness(app, 'Not Theirs');
    await typedAccount(app, second, { name: 'Owner There', phone: OWNER.phone, role: 'manager' });
    await typedAccount(app, decoy, { name: 'Someone Else', phone: '9811122233', role: 'owner' });
    const products = (tenant, name) => bindTenant(app.platform, tenant).products.create({ name, price: '100', stock: '', active: 'on' });
    await products(app.tenant, 'Only in the first business');
    await products(second, 'Only in the second business');
    await products(decoy, 'Only in the decoy business');
  });
  after(() => app?.close());

  test('P-09: the switcher lists exactly the person\'s businesses; P-10: switching shows only the new one\'s products', async () => {
    await freshCodes(app);
    const session = await codeSignIn(app, { transport: 'cookie', device: { ...testDevice('Laptop'), platform: 'web' } });
    const tab = await consoleOn(app, session);
    try {
      const { businesses } = await tab.api.auth.businesses();
      assert.deepEqual(businesses.map((b) => b.id).sort((a, b) => a - b), [app.tenant.id, second.id].sort((a, b) => a - b));
      assert.ok(!businesses.some((b) => b.id === decoy.id));

      const names = async () => (await tab.api.products.list({ limit: 50 })).items.map((p) => p.name);
      assert.deepEqual(await names(), ['Only in the first business']);
      tab.queries.setQueryData(['products', 'list', {}], { items: await names() });

      const now = await tab.workspace.choose(second.id, tab.api.auth.me);
      assert.equal(now.business.id, second.id);
      assert.equal(now.user.role, 'manager', 'the person\'s account there, with its own role');
      assert.equal(tab.queries.getQueryData(['products', 'list', {}]), undefined);
      assert.deepEqual(await names(), ['Only in the second business']);
      assert.ok(tab.seen.filter((s) => s.path.startsWith('/api/v1/products')).at(-1).tenant === String(second.id));

      // A business they are not in is refused by the server, whatever a tab sends.
      const refused = await call(app, '/api/v1/products', { headers: { cookie: session.cookie, 'x-tenant-id': String(decoy.id) } });
      assert.equal(refused.status, 403);

      // Removed from the second business while working there: the tab goes back to its own business and says nothing stale.
      await app.db.platform.query('UPDATE users SET removed_at = now() WHERE tenant_id = $1 AND phone = $2', [second.id, OWNER.phone]);
      await app.db.platform.query('DELETE FROM memberships WHERE tenant_id = $1 OR member_tenant_id = $1', [second.id]);
      const back = await tab.api.auth.me();
      assert.equal(back.business.id, app.tenant.id);
      assert.equal(tab.workspace.current(), '');
      assert.deepEqual(await names(), ['Only in the first business']);
    } finally {
      tab.close();
    }
  });

  test('P-08: a browser signed out under Devices is signed out in its open tab at the next look, without a reload', async () => {
    await freshCodes(app);
    const laptop = await codeSignIn(app, { transport: 'cookie', device: { ...testDevice('Laptop P-08'), platform: 'web' } });
    await freshCodes(app);
    const phone = await codeSignIn(app, { transport: 'cookie', device: { ...testDevice('Other browser'), platform: 'web' } });
    const here = await consoleOn(app, laptop);
    const there = await consoleOn(app, phone);
    try {
      const { devices } = await here.api.auth.devices();
      const other = devices.find((d) => d.name === 'Other browser');
      assert.ok(other && !other.current, JSON.stringify(devices));
      assert.ok(devices.find((d) => d.name === 'Laptop P-08').current);
      await here.api.auth.revokeDevice(other.id);

      await there.workspace.check();
      assert.equal(there.queries.getQueryData(['session']), null);
      assert.equal(there.workspace.endedBecause(), 'elsewhere');
      await here.workspace.check();
      assert.ok(here.queries.getQueryData(['session']), 'the browser that did it stays signed in');
    } finally {
      here.close();
      there.close();
    }
  });

  test('F-47: someone removed from the team is signed out in their open tab at the next look, without a reload', async () => {
    const staffPhone = '9822233344';
    await typedAccount(app, app.tenant, { name: 'Ravi', phone: staffPhone, role: 'staff', permissions: ['orders'] });
    await freshCodes(app);
    const staff = await codeSignIn(app, { phone: staffPhone, transport: 'cookie', device: { ...testDevice('Staff browser'), platform: 'web' } });
    const tab = await consoleOn(app, staff);
    try {
      assert.equal(tab.queries.getQueryData(['session']).user.role, 'staff');
      await freshCodes(app);
      const owner = await codeSignIn(app, { device: testDevice('Owner phone') });
      const removed = await call(app, `/api/v1/team/${staff.user.id}`, { method: 'DELETE', headers: owner.auth });
      assert.equal(removed.status, 204, removed.text);
      await tab.workspace.check();
      assert.equal(tab.queries.getQueryData(['session']), null);
      assert.equal(tab.workspace.endedBecause(), 'elsewhere');
    } finally {
      tab.close();
    }
  });

  test('signing out from the tab itself is not "signed out elsewhere", and forgets the business it chose', async () => {
    await freshCodes(app);
    const session = await codeSignIn(app, { transport: 'cookie', device: { ...testDevice('Laptop again'), platform: 'web' } });
    const tab = await consoleOn(app, session);
    try {
      tab.storage.setItem(WORKSPACE_KEY, String(app.tenant.id));
      await tab.api.auth.logout();
      tab.queries.setQueryData(['session'], null);
      assert.equal(tab.workspace.endedBecause(), '');
      assert.equal(tab.workspace.current(), '');
      const after = await call(app, '/api/v1/auth/me', { headers: { cookie: session.cookie } });
      assert.equal(after.status, 401);
    } finally {
      tab.close();
    }
  });

});
