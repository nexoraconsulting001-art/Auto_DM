// The strict parity check (PRD 10.4: P-14, P-15, P-16), as the release leaves it: tools/parity-pending.json empty
// for good, any owner route or console page with no app screen named, no web-only flag of any spelling, and the
// contract's consoleOnly flag the one exemption. auth.login is no owner route: no production server answers it.
import '../../../tools/net-guard.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertStartable, config } from '../../../src/config.js';
import { assertRouteFields, FRESH_ROUTES, routeList } from '../../../src/contracts/api/index.js';
import { NOT_SERVED_IN_PRODUCTION, checkParity, gather, isWebOnlyField, readPending } from '../../../tools/parity-check.mjs';
import { APP_HOST, startApp } from '../../helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const OWNERS = { roles: ['owner', 'manager'] };

/** A small copy of the repository's shape, with the real parity tool, to run the command line on. */
function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-parity-'));
  const base = {
    'src/contracts/api/index.js': "export const routeList = [{ id: 'orders.list', method: 'GET', path: '/orders', access: { roles: ['owner', 'manager', 'staff'] } }];\nexport const CONSOLE_ONLY_ROUTES = [];\n",
    'console/src/features/orders/index.jsx': "export default { name: 'orders', routes: [{ path: 'orders', element: <A /> }] };\n",
    'apps/owner/src/features/index.js': "export const shell = { name: 'shell', routeIds: [] };\n",
    'apps/owner/src/features/orders/index.js': "export default { name: 'orders', routeIds: ['orders.list', 'console:/orders'] };\n",
    'tools/parity-pending.json': '{ "routes": [], "pages": [] }\n',
    'tools/parity-check.mjs': read('tools/parity-check.mjs'),
    'tools/parity-read.cjs': read('tools/parity-read.cjs'),
    'package.json': '{ "type": "module" }\n',
  };
  for (const [rel, text] of Object.entries({ ...base, ...files })) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  const run = () => spawnSync(process.execPath, ['tools/parity-check.mjs'], { cwd: root, encoding: 'utf8' });
  return { root, run, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('P-16: the check passes on the repository, strict, with an empty allowance; the owner inbox and key entry are mapped', async () => {
  const pending = readPending(ROOT);
  assert.deepEqual([pending.routes, pending.pages], [[], []], 'tools/parity-pending.json is empty for good');
  const run = spawnSync(process.execPath, ['tools/parity-check.mjs'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr.slice(0, 800));
  assert.match(run.stdout, /(\d+) routes and pages; \1 mapped to app screens/);
  const input = await gather(ROOT);
  assert.deepEqual(input.readProblems, []);
  const covered = new Set(input.features.flatMap((feature) => feature.routeIds));
  for (const id of ['inbox.threads', 'inbox.thread', 'inbox.reply', 'inbox.needsHuman', 'console:/inbox/needs-human']) assert.ok(covered.has(id), `${id} has no app screen`);
  for (const id of ['settings.updatePayment', 'shippingSettings.update', 'shopify.connect', 'apiKeys.create']) {
    assert.ok(FRESH_ROUTES.includes(id), `${id} is a key entry, behind a fresh check`);
    assert.ok(covered.has(id), `${id} has no app screen`);
  }
});

test('P-14: a seller route at /admin/coupons, or a console page, with no app screen fails the check and is named', async () => {
  const input = await gather(ROOT);
  const route = { id: 'coupons.adminList', method: 'GET', path: '/admin/coupons', access: OWNERS };
  const withRoute = checkParity({ ...input, routes: [...input.routes, route], strict: true });
  assert.equal(withRoute.ok, false);
  assert.deepEqual(withRoute.missing, ['coupons.adminList']);
  assert.ok(withRoute.problems.some((p) => p.includes('route coupons.adminList') && p.includes('apps/owner/src/features')));

  const page = tree({ 'console/src/features/coupons/index.jsx': "export default { name: 'coupons', routes: [{ path: 'coupons', element: <B /> }] };\n" });
  try {
    const run = page.run();
    assert.equal(run.status, 1);
    assert.match(run.stderr, /No app screen for console page \/coupons \(console\/src\/features\/coupons\): add "console:\/coupons"/);
  } finally {
    page.done();
  }
});

test('P-15: a web-only flag is refused, whatever its spelling: on a route by the contract and by the check, on a page or an app feature by the check', () => {
  for (const flag of ['webOnly', 'web_only', 'web-only', 'WebOnly', 'desktopOnly', 'browserOnly', 'noApp', 'no_mobile', 'skipParity', 'parityExempt', 'appHidden']) {
    assert.equal(isWebOnlyField(flag), true, flag);
    assert.throws(() => assertRouteFields('orders.list', { method: 'GET', path: '/orders', access: OWNERS, [flag]: true }), /does not have/, flag);
    const result = checkParity({ routes: [{ id: 'orders.list', access: OWNERS, [flag]: true }], pages: [], features: [{ name: 'orders', routeIds: ['orders.list'] }], strict: true });
    assert.equal(result.ok, false, flag);
    assert.ok(result.problems.some((p) => p.includes(flag) && /no web-only flag/.test(p)), flag);
  }
  for (const field of ['consoleOnly', 'fresh', 'noBusiness', 'access', 'webhook', 'online']) assert.equal(isWebOnlyField(field), false, field);

  for (const [rel, text] of [
    ['console/src/features/orders/index.jsx', "export default { name: 'orders', webOnly: true, routes: [{ path: 'orders', element: <A /> }] };\n"],
    ['apps/owner/src/features/orders/index.js', "export default { name: 'orders', 'skip-parity': true, routeIds: ['orders.list', 'console:/orders'] };\n"],
  ]) {
    const flagged = tree({ [rel]: text });
    try {
      const run = flagged.run();
      assert.equal(run.status, 1, rel);
      assert.match(run.stderr, new RegExp(`${rel.replace(/[./]/g, '\\$&')} has a "(webOnly|skip-parity)" flag: there is no web-only flag`));
    } finally {
      flagged.done();
    }
  }
});

test('consoleOnly is the one exemption: exactly that spelling and exactly true, and CONSOLE_ONLY_ROUTES is the list of them', () => {
  const ops = { id: 'ops.reindex', access: OWNERS, consoleOnly: true };
  const exempt = checkParity({ routes: [ops], pages: [], features: [], strict: true });
  assert.equal(exempt.ok, true);
  assert.deepEqual(exempt.exempt.consoleOnly, ['ops.reindex']);
  for (const route of [{ ...ops, consoleOnly: 'yes' }, { id: 'ops.reindex', access: OWNERS, console_only: true }, { id: 'ops.reindex', access: OWNERS, ConsoleOnly: true }]) {
    const result = checkParity({ routes: [route], pages: [], features: [], strict: true });
    assert.equal(result.ok, false, JSON.stringify(route));
  }
  const mismatch = tree({ 'src/contracts/api/index.js': "export const routeList = [{ id: 'orders.list', method: 'GET', path: '/orders', access: { roles: ['owner'] } }];\nexport const CONSOLE_ONLY_ROUTES = ['orders.list'];\n" });
  try {
    const run = mismatch.run();
    assert.equal(run.status, 1);
    assert.match(run.stderr, /CONSOLE_ONLY_ROUTES is not the list of routes flagged consoleOnly/);
  } finally {
    mismatch.done();
  }
});

test('the allowance file must stay empty: an entry in it fails the check, even one that names a real route', () => {
  const listed = tree({ 'tools/parity-pending.json': '{ "routes": ["orders.list"], "pages": [] }\n' });
  try {
    const run = listed.run();
    assert.equal(run.status, 1);
    assert.match(run.stderr, /tools\/parity-pending\.json lists "orders\.list": the file must be empty/);
  } finally {
    listed.done();
  }
  // --strict is accepted (nothing changes); any other option is refused rather than ignored.
  const strict = spawnSync(process.execPath, ['tools/parity-check.mjs', '--strict'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(strict.status, 0, strict.stderr.slice(0, 400));
  const prune = spawnSync(process.execPath, ['tools/parity-check.mjs', '--prune'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(prune.status, 2);
});

test('auth.login is no owner route: with passwords off, as on every production server, it answers 404, and no app screen may call it', async (t) => {
  assert.deepEqual(Object.keys(NOT_SERVED_IN_PRODUCTION), ['auth.login']);
  assert.ok(routeList.some((route) => route.id === 'auth.login'));
  const app = await startApp({ overrides: { passwordLogin: false } });
  t.after(() => app.close());
  for (const host of [APP_HOST, 'default.bhava.test']) {
    const res = await fetch(`${app.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-host': host }, body: JSON.stringify({ phone: '9000000001', password: 'owner-pass' }) });
    assert.equal(res.status, 404, host);
  }
  assert.throws(() => assertStartable({ ...config, passwordLogin: true }, { NODE_ENV: 'production' }), /PASSWORD_LOGIN is on/);
  assert.doesNotThrow(() => assertStartable({ ...config, passwordLogin: false }, { NODE_ENV: 'production' }));
  const input = await gather(ROOT);
  const listing = checkParity({ ...input, features: [...input.features, { name: 'signup', routeIds: ['auth.login'] }], strict: true });
  assert.ok(listing.problems.some((p) => p.includes('"auth.login", which no production server answers')));
});
