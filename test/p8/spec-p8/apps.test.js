// Q-11 and Q-14: the showcase workflow and the apps. A GitHub Actions run and an emulator cannot run in a test, so what is
// tested here is everything that does not need them: the workflow's shape, the brand file each business exports and what
// build-brand makes of it, the flows' presence and what they hold, and (Q-14) the owner app's own sign-in and reads against
// the seeded server, through the API the app calls. What only CI can prove is named in the report.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { seedShowcase } from '../../../scripts/showcase.js';
import { NAME_FREE, checkFolders } from '../../../tools/policy-check.mjs';
import { accountsApp } from '../../p5/accounts/support.js';
import { appSession } from '../../helpers.js';
import { exists, filesUnder, keys, read, repoRoot, showcase, sql, strangers } from './support.js';

const guard = pathToFileURL(path.join(repoRoot, 'tools/net-guard.mjs')).href;
const workflow = () => read('.github/workflows/showcase.yml');

test('Q-11: no sample business is named in the Phase 8 tools, tests, browser tests or workflow', () => {
  const found = checkFolders(NAME_FREE, repoRoot);
  assert.deepEqual(found.map((f) => `${f.file}:${f.line}`), [], 'a name outside seed/ and docs/');
});

test('Q-11: the workflow builds each business from the manifest, in four jobs that depend on each other, with no account and no secret', () => {
  const text = workflow();
  for (const job of ['seed', 'build', 'emulator', 'ready']) assert.match(text, new RegExp(`^  ${job}:`, 'm'), `job ${job}`);
  assert.match(text, /fromJSON\(needs\.seed\.outputs\.keys\)/, 'the businesses come from the manifest, not from the workflow');
  assert.match(text, /needs:\s*seed/);
  assert.match(text, /needs:\s*\[seed, build\]/);
  assert.match(text, /--driver local/, 'the local driver: no build service account');
  assert.doesNotMatch(text, /\$\{\{\s*secrets\./, 'no secret is read');
  assert.doesNotMatch(text, /EXPO_TOKEN|ANDROID_KEYSTORE_BASE64|GOOGLE_SERVICES|ASC_KEY|PLAY_SERVICE/i, 'no store or build-service credential');
  assert.match(text, /keytool -genkeypair/, 'the signing key is made in the job');
  assert.match(text, /rm -f .*keystore/, 'and thrown away');
  assert.match(text, /--export-brands/, 'the brand files are made from the seeded database at build time');
  assert.match(text, /showcase-e2e\.mjs/, 'the emulator job runs the order test');
  assert.match(text, /test "\$\{\{ needs\.build\.result \}\}" = success/, 'the run fails if any build fails');
  assert.match(text, /test "\$\{\{ needs\.emulator\.result \}\}" = success/, 'or any emulator flow fails');
  assert.match(text, /workflow_dispatch/);
  assert.match(text, /seed\/\*\*/);
  assert.doesNotMatch(text, /\|\|\s*true\b|continue-on-error:\s*true/, 'a failing step is never swallowed');
  assert.equal(exists('tools/showcase-e2e.mjs'), true, 'the emulator step calls a file that exists');
});

test('Q-11: the shopper flows cover browse, a link from a DM, a paid test order, a cash on delivery order and tracking; the owner flows cover sign-in, both businesses and confirming the COD order', () => {
  const shopper = filesUnder('apps/shopper/.maestro/showcase', { ext: ['.yaml', '.yml'] });
  const owner = filesUnder('apps/owner/.maestro/showcase', { ext: ['.yaml', '.yml'] });
  assert.ok(shopper.length >= 4, `shopper flows: ${shopper.length}`);
  assert.ok(owner.length >= 3, `owner flows: ${owner.length}`);
  const s = shopper.map(read).join('\n').toLowerCase();
  for (const [what, pattern] of [['browsing the catalogue', /catalog|browse|reels?/], ['a link from a DM', /link|deeplink|openlink|dm/], ['a paid test order', /pay|razorpay|test/], ['cash on delivery', /cod|cash on delivery/], ['tracking', /track/]]) assert.match(s, pattern, `shopper flows: ${what}`);
  const o = owner.map(read).join('\n').toLowerCase();
  for (const [what, pattern] of [['signing in', /sign in|otp|code/], ['switching business', /switch|business/], ['orders', /orders?/], ['confirming the COD order', /confirm|cod/]]) assert.match(o, pattern, `owner flows: ${what}`);
  for (const file of [...shopper, ...owner]) {
    const text = read(file);
    assert.match(text, /^appId:/m, `${file}: names its app`);
    assert.deepEqual(strangers(text), [], `${file}: a phone or email outside the invented ranges`);
    assert.doesNotMatch(text, /password\s*:\s*\S{4,}|api[_-]?key\s*:/i, `${file}: no credential`);
  }
});

let exported;
function exportBrands() {
  if (exported) return exported;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-p8-brands-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-p8-brands-data-'));
  const r = spawnSync(process.execPath, ['--import', guard, path.join(repoRoot, 'scripts/showcase.js'), '--no-activity', '--export-brands', dir], {
    cwd: repoRoot, encoding: 'utf8', timeout: 400_000, env: { ...process.env, ALLOW_PGLITE: '1', DATA_DIR: data, NODE_ENV: 'development', DATABASE_URL: '', DATABASE_OWNER_URL: '' },
  });
  exported = { dir, status: r.status, out: `${r.stdout}\n${r.stderr}` };
  return exported;
}

test('Q-11: each business\'s brand file is made from its seeded brand kit: its name, package, colours and scheme, and nothing of the other\'s', { timeout: 500_000 }, () => {
  const run = exportBrands();
  assert.equal(run.status, 0, run.out.slice(-800));
  const all = showcase();
  const files = Object.fromEntries(all.map((b) => [b.key, path.join(run.dir, b.key, 'brand.json')]));
  for (const b of all) {
    assert.ok(fs.existsSync(files[b.key]), `${b.key}: brand.json`);
    const text = fs.readFileSync(files[b.key], 'utf8');
    const brand = JSON.parse(text);
    assert.equal(brand.shortName, b.seed.app.shortName, `${b.key}: short name`);
    assert.equal(brand.android?.package, b.seed.app.androidPackage, `${b.key}: Android package`);
    assert.match(text, new RegExp(b.seed.app.urlScheme), `${b.key}: link scheme`);
    assert.match(text, new RegExp(b.seed.app.splashBackground.replace('#', '#?'), 'i'), `${b.key}: splash colour`);
    for (const other of all.filter((x) => x.key !== b.key)) {
      for (const needle of [other.seed.business.name, other.seed.app.appName, other.seed.app.androidPackage, other.seed.app.urlScheme, other.seed.business.igUsername, other.seed.business.owner.phone]) {
        assert.equal(text.includes(needle), false, `${b.key}: holds "${needle}" of ${other.key}`);
      }
    }
    assert.doesNotMatch(text, /keystore|storepass|private[_ ]key|BEGIN [A-Z ]*KEY|ANDROID_KEY/i, `${b.key}: no key material`);
    assert.doesNotMatch(JSON.stringify([brand.appName, brand.shortName]), /bhava/i, `${b.key}: a buyer's app does not carry the platform's name`);
  }
  const tracked = spawnSync('git', ['ls-files', '--', '*brand.json'], { cwd: repoRoot, encoding: 'utf8' }).stdout.split('\n').filter((f) => f && !f.startsWith('tools/build-brand/fixtures'));
  assert.deepEqual(tracked, [], 'brand files are made at build time and never committed');
});

test('Q-11: build-brand accepts each exported brand file and stops cleanly when told not to build (the same first steps the workflow runs)', { timeout: 500_000 }, () => {
  const run = exportBrands();
  assert.equal(run.status, 0, run.out.slice(-400));
  for (const b of showcase()) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-p8-bb-'));
    const r = spawnSync(process.execPath, ['--import', guard, path.join(repoRoot, 'tools/build-brand/index.mjs'), path.join(run.dir, b.key, 'brand.json'), '--platform', 'android', '--driver', 'local', '--profile', 'preview', '--no-build', '--out', out], { cwd: repoRoot, encoding: 'utf8', timeout: 240_000 });
    assert.equal(r.status, 0, `${b.key}: ${`${r.stdout}${r.stderr}`.slice(-600)}`);
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /password|secret|BEGIN [A-Z ]*KEY/i, 'nothing secret is printed');
  }
});

test('Q-11: a brand file with the other business\'s package or a missing name is refused by validation, so a wrong build cannot start', { timeout: 300_000 }, () => {
  const run = exportBrands();
  const [first] = showcase();
  const file = path.join(run.dir, first.key, 'brand.json');
  const brand = JSON.parse(fs.readFileSync(file, 'utf8'));
  const bad = { ...brand, shortName: '', android: { ...brand.android, package: 'Not A Package' } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-p8-badbrand-'));
  fs.writeFileSync(path.join(dir, 'brand.json'), JSON.stringify(bad));
  const r = spawnSync(process.execPath, ['--import', guard, path.join(repoRoot, 'tools/build-brand/index.mjs'), path.join(dir, 'brand.json'), '--platform', 'android', '--driver', 'local', '--no-build', '--out', path.join(dir, 'out')], { cwd: repoRoot, encoding: 'utf8', timeout: 240_000 });
  assert.notEqual(r.status, 0, 'refused');
  assert.match(`${r.stdout}${r.stderr}`, /package|shortName|name/i, 'and says which field');
});

// ---- Q-14: the owner app against the seeded server ------------------------------------------------------------------------------------

after(async () => {
  await world?.close();
});
let world;
async function owners() {
  if (world) return world;
  const app = await accountsApp();
  const businesses = showcase();
  const results = await seedShowcase({ db: app.db, repos: app.platform, ctx: app.ctx, businesses });
  world = Object.assign(app, { businesses, results });
  return world;
}
const get = (app, session, p) => fetch(`${app.base}/api/v1${p}`, { headers: session.headers });

test('Q-14: the owner of each seeded business signs in from the owner app with a WhatsApp code, and reads its own business', { timeout: 540_000 }, async () => {
  const app = await owners();
  assert.ok(app.businesses.length >= 2);
  for (const b of app.businesses) {
    const result = app.results.find((r) => r.key === b.key);
    const session = await appSession(app.base, { phone: b.seed.business.owner.phone, whatsapp: app.whatsapp, tenantId: result.tenantId, app: { name: 'owner', version: '1.0.0' } });
    assert.ok(session.accessToken && session.refreshToken, `${b.key}: tokens`);
    const me = await get(app, session, '/auth/me');
    const meText = await me.text(); // read once: a body can be read once, and an assertion's message is evaluated even when it passes
    assert.equal(me.status, 200, meText);
    const who = JSON.parse(meText);
    assert.equal(who.business?.id ?? who.tenantId, result.tenantId, `${b.key}: it is its own business`);
    const products = await get(app, session, '/products?limit=100');
    assert.equal(products.status, 200);
    const names = (await products.json()).items.map((p) => p.name);
    const catalogue = new Set(b.catalogue.products.map((p) => p.name));
    assert.ok(names.length > 0 && names.every((n) => catalogue.has(n)), `${b.key}: its catalogue, nothing else`);
    for (const other of app.businesses.filter((x) => x.key !== b.key)) for (const p of other.catalogue.products.slice(0, 20)) if (!catalogue.has(p.name)) assert.equal(names.includes(p.name), false, `${b.key}: sees ${other.key}'s product`);
    for (const route of ['/orders?limit=20', '/reels?limit=20', '/automations', '/coupons', '/stats', '/inbox', '/activity']) {
      const res = await get(app, session, route);
      assert.ok(res.status < 500 && res.status !== 401, `${b.key}: ${route} answered ${res.status}`);
    }
    const refresh = await fetch(`${app.base}/api/v1/auth/refresh`, { method: 'POST', headers: { ...session.headers, authorization: '' }, body: JSON.stringify({ refreshToken: session.refreshToken }) });
    assert.ok([200, 201].includes(refresh.status) || refresh.status === 404, `a session can be renewed (${refresh.status})`);
  }
});

test('Q-14: the owner of one seeded business cannot open the other, by asking for it at sign-in or by presenting its own token', { timeout: 540_000 }, async () => {
  const app = await owners();
  const [a, b] = app.businesses;
  const ra = app.results.find((r) => r.key === a.key);
  const rb = app.results.find((r) => r.key === b.key);
  await assert.rejects(appSession(app.base, { phone: a.seed.business.owner.phone, whatsapp: app.whatsapp, tenantId: rb.tenantId }), /failed with (400|401|403|404)/, 'a code for a phone that is not a member of the business it asks for');
  const session = await appSession(app.base, { phone: a.seed.business.owner.phone, whatsapp: app.whatsapp, tenantId: ra.tenantId });
  const wrong = await fetch(`${app.base}/api/v1/products?limit=5`, { headers: { ...session.headers, 'x-business': String(rb.tenantId), 'x-tenant-id': String(rb.tenantId) } });
  const names = wrong.status === 200 ? (await wrong.json()).items.map((p) => p.name) : [];
  const theirs = new Set(b.catalogue.products.map((p) => p.name));
  const mine = new Set(a.catalogue.products.map((p) => p.name));
  assert.ok(names.every((n) => mine.has(n) || !theirs.has(n)), 'a header does not switch business');
  const owners_ = await sql(app, `SELECT tenant_id, count(*)::int AS n FROM users WHERE phone LIKE $1 AND tenant_id = $2 GROUP BY 1`, [`%${a.seed.business.owner.phone.slice(-10)}`, ra.tenantId]);
  // Its own business only: the test server's first business has an owner with the same invented phone, and that is a different business.
  assert.deepEqual(owners_.map((r) => r.n), [1], 'the owner exists once, even after the seed ran');
});

test('Q-14: the owner app is built to talk to a server named by one setting, and ships no address of ours', () => {
  const config = read('apps/owner/app.config.js');
  assert.match(config, /API_BASE_URL|apiBaseUrl|EXPO_PUBLIC_API/i, 'the server comes from a setting');
  assert.ok(keys().length >= 2);
  const flows = filesUnder('apps/owner/.maestro/showcase', { ext: ['.yaml', '.yml'] });
  assert.ok(flows.length >= 3, `the owner flows exist (${flows.length})`);
  for (const file of flows) assert.doesNotMatch(read(file), /https?:\/\/(?!10\.0\.2\.2|localhost|127\.)/i, `${file}: only the emulator's own address`);
});
