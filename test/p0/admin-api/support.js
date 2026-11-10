import assert from 'node:assert/strict';
import { ErrorBody } from '../../../src/contracts/api/index.js';
import { adminApi } from '../../../src/modules/admin-api/index.js';
import { apiV1 } from '../../../src/modules/api-v1/index.js';
import { MODULES } from '../../../src/modules/index.js';
import { setLogSink } from '../../../src/platform/log.js';
import { bindTenant } from '../../../src/repos/index.js';
import { OWNER, fakeIg, startApp } from '../../helpers.js';

export const bearer = (token) => ({ authorization: `Bearer ${token}` });
export const at = (host) => ({ 'x-forwarded-host': host });
export const jsonRequest = (method, body, headers = {}) => ({
  method,
  headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/** The module list with admin-api where it has to sit: before api-v1, whose catch-all takes every /api/v1 path left over. */
export const adminModules = (extra = []) => [...MODULES.filter((m) => m !== adminApi && m !== apiV1), adminApi, ...extra, apiV1];

/** A test app with the seller API on, signed in as the owner. `api(method, path, body)` calls /api/v1 as the owner. */
export async function adminApp({ extra, ...options } = {}) {
  const app = await startApp({ ig: fakeIg(), ...options, modules: adminModules(extra) });
  const signIn = async (who, headers = {}) => {
    const res = await fetch(`${app.base}/api/v1/auth/login`, jsonRequest('POST', who, headers));
    assert.equal(res.status, 201, 'sign-in failed');
    return (await res.json()).token;
  };
  const as = (token) => (method, path, body) => fetch(`${app.base}/api/v1${path}`, jsonRequest(method, body, bearer(token)));
  const owner = await signIn(OWNER);
  return {
    ...app,
    signIn,
    as,
    owner,
    api: as(owner),
    close: async () => {
      app.close();
      await app.db.close();
    },
  };
}

/** Runs a test body with its own app and always shuts the app down. */
export const withApp = (options, body) => async () => {
  const [opts, run] = body ? [options, body] : [{}, options];
  const app = await adminApp(opts);
  try {
    await run(app);
  } finally {
    await app.close();
  }
};

/** A second business with its own owner, signed in on its own address. */
export async function secondBusiness(app, slug = 'leaf') {
  const tenant = await app.platform.tenants.create({ slug, name: 'Leaf and Clay' });
  const repos = bindTenant(app.platform, tenant);
  const owner = { phone: '9000000009', password: 'leaf-owner' };
  await repos.users.ensureOwner(owner);
  const token = await app.signIn(owner, at(`${slug}.bhava.test`));
  return { tenant, repos, token, api: app.as(token) };
}

export async function ok(res, status = 200) {
  const text = await res.text();
  assert.equal(res.status, status, text);
  return text ? JSON.parse(text) : null;
}

export async function refused(res, status, code) {
  assert.equal(res.status, status);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const body = await res.json();
  assert.equal(ErrorBody.safeParse(body).success, true, JSON.stringify(body));
  assert.equal(body.code, code);
  return body;
}

/** Follows nextCursor to the end. Returns every item and the size of each page. */
export async function walk(api, path, limit = 2) {
  const items = [];
  const sizes = [];
  let cursor = null;
  do {
    const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
    const page = await ok(await api('GET', `${path}${path.includes('?') ? '&' : '?'}${query}`));
    items.push(...page.items);
    sizes.push(page.items.length);
    cursor = page.nextCursor;
  } while (cursor);
  return { items, sizes };
}

export const SHOPPER = { name: 'Asha K', phone: '9876543210', address: '12 MG Road', city: 'Pune', state: 'MH', pincode: '411001' };

/** Places an order the way the checkout does. */
export async function placeOrder(repos, product, { qty = 1, ...fields } = {}) {
  return repos.orders.create({ items: [{ productId: product.id, qty }], customer: SHOPPER, ...fields }, await repos.settings.getAll());
}

/** Log lines written while `fn` runs, as parsed objects. */
export async function capturingLogs(fn) {
  const lines = [];
  setLogSink((line) => lines.push(JSON.parse(line)));
  try {
    await fn(lines);
  } finally {
    setLogSink((line, level) => (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`));
  }
  return lines;
}
