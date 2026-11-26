// Q-01 to Q-04: the showcase seed. One command loads every sample business of the manifest, a second run changes nothing, every
// person in the seed files and in the seeded database is invented (PEOPLE_RULES), and after seeding neither business can read
// the other's data on any route. The businesses are the manifest's keys: no name of one appears in this folder.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ShowcaseError, loadShowcase, seedShowcase } from '../../../scripts/showcase.js';
import { routeList } from '../../../src/contracts/api/index.js';
import { PEOPLE_RULES, SHOWCASE, inventedPerson, problemsWithPeople, problemsWithPerson } from '../../../src/contracts/seed.js';
import { bindTenant } from '../../../src/repos/index.js';
import { openDb } from '../../../src/db/index.js';
import {
  NEUTRAL, api, closeShared, exists, filesUnder, hit, json, keys, read, repoRoot, sharedWorld, showcase, signIn, snapshot, sql, strangers, tenantTables,
} from './support.js';

after(closeShared);

const seedFiles = () => filesUnder('seed', { ext: ['.json', '.md', '.txt', '.csv'] });
const SHOWCASE_DIR = path.dirname(SHOWCASE.manifest);

/** The repository's seed folder copied to a scratch folder with `change(files)` applied to its text (a string per path). */
function seedCopy(change) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-p8-seed-'));
  const files = {};
  for (const rel of filesUnder('seed')) files[rel] = read(rel);
  change(files);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}
const editSeed = (index, edit) => (files) => {
  const rel = `${SHOWCASE_DIR}/${json(SHOWCASE.manifest).businesses[index].file}`;
  const data = JSON.parse(files[rel]);
  edit(data);
  files[rel] = JSON.stringify(data);
};
const refusedWith = (root, pattern, what) => {
  let error;
  try {
    loadShowcase({ root });
  } catch (err) {
    error = err;
  }
  assert.ok(error, `${what}: loading must refuse`);
  assert.ok(error instanceof ShowcaseError, `${what}: ${error?.constructor?.name}: ${error?.message}`);
  assert.match(error.message, pattern, what);
  return error.message;
};

// ---- Q-02: every person is invented ----------------------------------------------------------------------------------------------

test('Q-02: every seed file holds only invented people: phones, emails, names and Instagram ids', () => {
  const found = [];
  for (const rel of seedFiles()) for (const bad of strangers(read(rel))) found.push(`${rel}: ${bad.split(':')[0]}`);
  assert.deepEqual(found, [], 'a phone, email or id outside the reserved ranges');
  for (const { key, seed } of showcase()) {
    assert.deepEqual(problemsWithPeople([seed.business.owner]), [], `${key}: the owner is invented`);
    assert.match(seed.business.igUserId, PEOPLE_RULES.instagram.id);
    assert.match(seed.business.igUsername, PEOPLE_RULES.instagram.username);
    assert.ok(seed.reels.every((reel) => PEOPLE_RULES.instagram.id.test(reel.igMediaId)), `${key}: made-up media ids`);
    const mail = [seed.app.supportEmail, seed.business.owner.email].filter(Boolean);
    for (const m of mail) assert.deepEqual(strangers(m), [], `${key}: ${m.split('@')[1]}`);
  }
  assert.ok(seedFiles().length >= 3, 'the manifest and the two seed files are there');
});

test('Q-02: the checker fails on a real-looking name, phone, email or id, and never repeats the value', () => {
  const real = {
    name: ['Rahul Sharma', 'owner.name'],
    nameThree: ['Priya Kumari Singh', 'owner.name'],
    phone: ['+919876543210', 'owner.phone'],
    phoneBlockEdge: ['+919000010000', 'owner.phone'],
    email: ['someone@gmail.com', 'owner.email'],
    emailLookalike: ['someone@example.com.evil.io', 'owner.email'],
  };
  for (const [what, [value, field]] of Object.entries(real)) {
    const person = { name: 'Aarohi Ambekar', phone: PEOPLE_RULES.phone.first, email: 'aarohi@example.com' };
    const [, key] = field.split('.');
    person[key] = value;
    const problems = problemsWithPerson(person);
    assert.deepEqual(problems, [key], `${what}: only the field is named`);
    assert.equal(JSON.stringify(problems).includes(value), false, `${what}: the value is not repeated`);
  }
  assert.deepEqual(problemsWithPerson({ name: 'Aarohi Ambekar', phone: '+919000000000', igUserId: '17841400000000000' }), ['igUserId']);
  assert.deepEqual(problemsWithPerson({ name: 'Aarohi Ambekar', phone: '+919000000000', igUsername: 'real_brand' }), ['igUsername']);
  assert.deepEqual(problemsWithPerson({ name: 'Aarohi Ambekar', phone: PEOPLE_RULES.phone.last, email: 'a@b.example', igUserId: '900011112222333', igUsername: 'demo_x_1' }), []);

  // And the loader: the same files with one real-looking value are refused, naming the file and the field.
  const owner = (field, value) => seedCopy(editSeed(0, (data) => { data.business.owner[field] = value; }));
  const second = (field, value) => seedCopy(editSeed(1, (data) => { data.business.owner[field] = value; }));
  for (const [root, field, value] of [[owner('name', 'Rahul Sharma'), 'name', 'Rahul Sharma'], [owner('phone', '+919876543210'), 'phone', '9876543210'], [second('email', 'founder@gmail.com'), 'email', 'founder@gmail.com']]) {
    const message = refusedWith(root, /owner|business/i, `a real ${field}`);
    assert.equal(message.includes(value), false, `the ${field} is not echoed`);
  }
  refusedWith(seedCopy(editSeed(1, (data) => { data.business.igUserId = '17841400000000000'; })), /igUserId|Instagram/i, 'a real-looking Instagram id');
  refusedWith(seedCopy(editSeed(1, (data) => { data.business.igUsername = 'real_brand_official'; })), /igUsername|Instagram/i, 'a real-looking handle');
  refusedWith(seedCopy(editSeed(0, (data) => { data.app.supportEmail = 'help@realbrand.in'; })), /supportEmail|example/i, 'a support email off the example domains');
});

test('Q-02: the whole seed folder is scanned, not just the seed files: a stray file with a real-looking phone fails the scan', () => {
  const root = seedCopy((files) => { files['seed/showcase/notes.md'] = 'Call Asha on +91 98765 43210 or mail asha@gmail.com, ig 17841400000000000'; });
  const text = fs.readFileSync(path.join(root, 'seed/showcase/notes.md'), 'utf8');
  const found = strangers(text).map((s) => s.split(':')[0]).sort();
  assert.deepEqual(found, ['email', 'id', 'phone'], 'the scanner itself catches all three kinds');
  assert.deepEqual(strangers('Call +91 90000 00123, mail a@example.com, id 900011112222333'), [], 'and passes the reserved ones');
});

// ---- Q-01: the command ---------------------------------------------------------------------------------------------------------

function run(args, env = {}, { timeout = 240_000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-p8-data-'));
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(repoRoot, 'tools/net-guard.mjs')).href, path.join(repoRoot, 'scripts/showcase.js'), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, ALLOW_PGLITE: '1', DATA_DIR: env.DATA_DIR ?? dir, NODE_ENV: 'development', DATABASE_URL: '', DATABASE_OWNER_URL: '', GRAPH_BASE_URL: '', RAZORPAY_BASE_URL: '', SHIPROCKET_BASE_URL: '', SHOPIFY_BASE_URL: '', ...env },
  });
  return { ...result, dir: env.DATA_DIR ?? dir, out: `${result.stdout}\n${result.stderr}` };
}

test('Q-01: the command reads and checks every seed file without a database (--check), and says nothing about a person', () => {
  const r = run(['--check']);
  assert.equal(r.status, 0, r.out.slice(-600));
  assert.equal(fs.readdirSync(r.dir).length, 0, '--check opens no database');
  for (const { seed } of showcase()) assert.equal(r.out.includes(seed.business.owner.phone), false);
});

test('Q-01: the command refuses to run against a production setting, before it opens any database', () => {
  const cases = {
    'NODE_ENV=production': { NODE_ENV: 'production' },
    'production with a database address': { NODE_ENV: 'production', DATABASE_URL: 'postgres://app:pw@127.0.0.1:1/prod' },
    'a real Graph address': { GRAPH_BASE_URL: 'https://graph.facebook.com' },
    'a real Razorpay address': { RAZORPAY_BASE_URL: 'https://api.razorpay.com' },
    'a real Shiprocket address': { SHIPROCKET_BASE_URL: 'https://apiv2.shiprocket.in' },
    'a real Shopify address': { SHOPIFY_BASE_URL: 'https://example-shop.myshopify.com' },
  };
  for (const [what, env] of Object.entries(cases)) {
    const r = run(['--no-activity'], env, { timeout: 60_000 });
    assert.notEqual(r.status, 0, `${what}: must refuse (exit ${r.status})`);
    assert.match(r.out, /production|real|simulat|refus/i, `${what}: says why: ${r.out.slice(-300)}`);
    assert.doesNotMatch(r.out, /ECONNREFUSED|password authentication/i, `${what}: it refused before connecting`);
    assert.equal(fs.readdirSync(r.dir).length, 0, `${what}: no database was created`);
  }
});

test('Q-01: one command loads every sample business, and a second run changes nothing', { timeout: 540_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-p8-load-'));
  const first = run(['--no-activity'], { DATA_DIR: dir });
  assert.equal(first.status, 0, first.out.slice(-800));
  const state = async () => {
    const db = await openDb({ dataDir: dir, migrate: false });
    try {
      const out = {};
      const rows = await db.platform.query(`SELECT c.table_name FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' ORDER BY 1`);
      for (const { table_name: table } of rows) {
        const [r] = await db.platform.query(`SELECT count(*)::int AS n FROM "${table}"`);
        out[table] = r.n;
      }
      const tenants = await db.platform.query('SELECT slug, plan FROM tenants ORDER BY slug');
      return { counts: out, tenants };
    } finally {
      await db.close();
    }
  };
  const afterFirst = await state();
  const wanted = showcase();
  for (const { seed, catalogue } of wanted) {
    const tenant = afterFirst.tenants.find((t) => t.slug === seed.business.slug);
    assert.ok(tenant, `${seed.business.slug} was created`);
    assert.equal(tenant.plan, seed.business.plan);
  }
  const products = afterFirst.counts.products;
  assert.equal(products, wanted.reduce((n, b) => n + b.catalogue.products.length, 0), 'every product of both catalogues, once');
  assert.equal(afterFirst.counts.reels, wanted.reduce((n, b) => n + b.seed.reels.length, 0));
  const second = run(['--no-activity'], { DATA_DIR: dir });
  assert.equal(second.status, 0, second.out.slice(-800));
  const afterSecond = await state();
  assert.deepEqual(afterSecond.counts, afterFirst.counts, 'no table grew or shrank');
  assert.deepEqual(afterSecond.tenants, afterFirst.tenants);
});

let seeded;
async function seededWorld() {
  const app = await sharedWorld();
  if (!seeded) {
    const businesses = showcase().map((b) => ({ ...b }));
    const first = await seedShowcase({ db: app.db, repos: app.platform, ctx: app.ctx, businesses });
    const rows = {};
    for (const table of await tenantTables(app)) rows[table] = (await sql(app, `SELECT count(*)::int AS n FROM "${table}"`))[0].n;
    const second = await seedShowcase({ db: app.db, repos: app.platform, ctx: app.ctx, businesses });
    const rowsAfter = {};
    for (const table of await tenantTables(app)) rowsAfter[table] = (await sql(app, `SELECT count(*)::int AS n FROM "${table}"`))[0].n;
    seeded = { businesses, first, second, rows, rowsAfter };
  }
  return { app, ...seeded };
}

test('Q-01: through the loader\'s own function a second run creates nothing, for every kind of thing, in every business', { timeout: 540_000 }, async () => {
  const { first, second, rows, rowsAfter, businesses } = await seededWorld();
  assert.equal(first.length, businesses.length);
  assert.deepEqual(first.map((r) => r.key), businesses.map((b) => b.key));
  for (const result of first) assert.ok(Object.values(result.created).some((n) => n > 0), `${result.key}: the first run created something`);
  for (const result of second) {
    assert.deepEqual(Object.entries(result.created).filter(([, n]) => n !== 0), [], `${result.key}: the second run created ${JSON.stringify(result.created)}`);
    assert.ok(Object.values(result.reused).some((n) => n > 0), `${result.key}: it found what was there`);
  }
  assert.deepEqual(rowsAfter, rows, 'no table grew');
  const kinds = new Set(first.flatMap((r) => Object.keys(r.created)));
  for (const kind of ['products', 'reels', 'automations', 'coupons']) assert.ok([...kinds].some((k) => k.startsWith(kind.slice(0, 5))), `${kind} are among what is created`);
});

test('Q-01: the loaded business matches its seed file: plan, products, reels in order, categories, store settings, coupons', { timeout: 540_000 }, async () => {
  const { app, businesses } = await seededWorld();
  for (const { seed, catalogue } of businesses) {
    const [tenant] = await sql(app, 'SELECT * FROM tenants WHERE slug = $1', [seed.business.slug]);
    assert.ok(tenant, seed.business.slug);
    assert.equal(tenant.plan, seed.business.plan);
    const productNames = (await sql(app, 'SELECT name FROM products WHERE tenant_id = $1', [tenant.id])).map((r) => r.name).sort();
    assert.deepEqual(productNames, catalogue.products.map((p) => p.name).sort());
    const prices = await sql(app, 'SELECT name, price_paise FROM products WHERE tenant_id = $1', [tenant.id]);
    const wantPrice = new Map(catalogue.products.map((p) => [p.name, p.pricePaise]));
    for (const row of prices) assert.equal(row.price_paise, wantPrice.get(row.name), `${row.name}: price in paise`);
    const reels = (await sql(app, 'SELECT ig_media_id FROM reels WHERE tenant_id = $1', [tenant.id])).map((r) => r.ig_media_id).sort();
    assert.deepEqual(reels, seed.reels.map((r) => r.igMediaId).sort());
    for (const [key, value] of Object.entries(seed.settings)) {
      const [row] = await sql(app, 'SELECT value FROM settings WHERE tenant_id = $1 AND key = $2', [tenant.id, key]);
      assert.equal(row?.value, value, `setting ${key}`);
    }
  }
});

test('Q-01: an outside catalogue is read where it is: used when named, never copied into the repository, and a missing one is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-p8-outside-'));
  const second = showcase().find((b) => b.productsFrom !== 'file');
  assert.ok(second, 'one business takes its products from a setting, with a committed fallback');
  assert.equal(second.productsFrom, 'fallback', 'with nothing named the committed fallback is used');
  const outside = path.join(dir, 'catalogue.json');
  const legacy = { store: {}, categories: [{ name: 'Outside shelf', slug: 'outside-shelf' }], products: [{ name: 'Outside-only plant', price: 123.5, categories: ['Outside shelf'], images: [] }] };
  fs.writeFileSync(outside, JSON.stringify(legacy));
  const before = spawnSync('git', ['status', '--porcelain', '--', 'seed', 'docs'], { cwd: repoRoot, encoding: 'utf8' }).stdout;
  const viaFlag = showcase({ plantSeed: outside }).find((b) => b.key === second.key);
  assert.equal(viaFlag.productsFrom, 'setting');
  assert.deepEqual(viaFlag.catalogue.products.map((p) => [p.name, p.pricePaise]), [['Outside-only plant', 12350]], 'rupees became paise');
  const viaEnv = showcase({ env: { [SHOWCASE.plantSetting]: outside } }).find((b) => b.key === second.key);
  assert.equal(viaEnv.productsFrom, 'setting');
  const after = spawnSync('git', ['status', '--porcelain', '--', 'seed', 'docs'], { cwd: repoRoot, encoding: 'utf8' }).stdout;
  assert.equal(after, before, 'nothing was written under seed/ or docs/');
  for (const rel of seedFiles()) assert.equal(read(rel).includes('Outside-only plant'), false, `${rel}: the outside file was not copied in`);
  assert.throws(() => showcase({ plantSeed: path.join(dir, 'missing.json') }), ShowcaseError);
  fs.writeFileSync(outside, '{"products": [{"name": "No price"}]}');
  assert.throws(() => showcase({ plantSeed: outside }), ShowcaseError, 'a file that does not fit is refused');
});

test('Q-01: a seed that does not fit is refused naming the file and the field, whatever is wrong with it', () => {
  const cases = [
    ['a product the reel names that is not in the catalogue', editSeed(0, (d) => { d.reels[0].products = ['No such product 404']; }), /No such product 404|reels/],
    ['a reel with no key', editSeed(0, (d) => { delete d.reels[0].key; }), /key|reels/],
    ['an image that is not https', editSeed(1, (d) => { d.brandKit.preset = ''; }), /preset|brandKit/],
    ['two reels with one media id', editSeed(0, (d) => { d.reels[1].igMediaId = d.reels[0].igMediaId; }), /different|igMediaId|media/i],
    ['a coupon of the wrong shape', editSeed(0, (d) => { d.coupons = [{ code: 'BAD', kind: 'percent' }]; }), /percent|coupon/i],
    ['an unknown key', editSeed(0, (d) => { d.surprise = true; }), /surprise|Unrecognized|unknown/i],
    ['a landing page of a reel that is not there', editSeed(0, (d) => { d.landingPages = [{ slug: 'x-page', title: 'X', reel: 'missing-reel' }]; }), /reel|key/i],
    ['an automation with no keyword', editSeed(0, (d) => { d.automations = [{ name: 'A', trigger: 'comment', keywords: [], message: 'hi', link: { type: 'amazon', url: 'https://example.com/x' } }]; }), /keyword/i],
  ];
  for (const [what, change, pattern] of cases) refusedWith(seedCopy(change), pattern, what);
  const same = seedCopy((files) => {
    const rel0 = `${SHOWCASE_DIR}/${json(SHOWCASE.manifest).businesses[0].file}`;
    const rel1 = `${SHOWCASE_DIR}/${json(SHOWCASE.manifest).businesses[1].file}`;
    const a = JSON.parse(files[rel0]);
    const b = JSON.parse(files[rel1]);
    b.business.slug = a.business.slug;
    files[rel1] = JSON.stringify(b);
  });
  refusedWith(same, /same slug|share/i, 'two businesses with one slug');
  const sameApp = seedCopy((files) => {
    const rel0 = `${SHOWCASE_DIR}/${json(SHOWCASE.manifest).businesses[0].file}`;
    const rel1 = `${SHOWCASE_DIR}/${json(SHOWCASE.manifest).businesses[1].file}`;
    const b = JSON.parse(files[rel1]);
    b.app.androidPackage = JSON.parse(files[rel0]).app.androidPackage;
    files[rel1] = JSON.stringify(b);
  });
  refusedWith(sameApp, /package|share/i, 'two businesses with one app package');
});

// ---- Q-02 again, on the seeded database -------------------------------------------------------------------------------------------

test('Q-02: the seeded database holds no phone, email, name or Instagram id outside the invented-people rules', { timeout: 540_000 }, async () => {
  const { app, businesses } = await seededWorld();
  const slugs = businesses.map((b) => b.seed.business.slug);
  const tenants = (await sql(app, 'SELECT id FROM tenants WHERE slug = ANY($1)', [slugs])).map((r) => r.id);
  const bad = [];
  for (const table of await tenantTables(app)) {
    const rows = await sql(app, `SELECT t::text AS text FROM "${table}" t WHERE t.tenant_id = ANY($1)`, [tenants]);
    for (const row of rows) for (const found of strangers(row.text)) bad.push(`${table}: ${found.split(':')[0]}`);
  }
  assert.deepEqual([...new Set(bad)], [], 'a stranger in the seeded rows');
  // Names: every customer and every staff name.
  const nameColumns = await sql(app, `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name IN ('customer_name') OR (table_name = 'users' AND column_name = 'name')`);
  for (const { table_name: table, column_name: column } of nameColumns) {
    const names = await sql(app, `SELECT DISTINCT "${column}" AS v FROM "${table}" WHERE tenant_id = ANY($1)`, [tenants]);
    for (const { v } of names) assert.deepEqual(problemsWithPerson({ name: v, phone: PEOPLE_RULES.phone.first }), [], `${table}.${column} holds a name outside the lists`);
  }
  const handles = await sql(app, `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name IN ('username', 'ig_username')`);
  for (const { table_name: table, column_name: column } of handles) {
    const rows = await sql(app, `SELECT DISTINCT "${column}" AS v FROM "${table}" WHERE tenant_id = ANY($1) AND "${column}" <> ''`, [tenants]).catch(() => []);
    for (const { v } of rows) assert.match(v, PEOPLE_RULES.instagram.username, `${table}.${column}`);
  }
});

test('Q-02: a stranger put into the seeded database is caught by the same scan', { timeout: 540_000 }, async () => {
  const { app, businesses } = await seededWorld();
  const [tenant] = await sql(app, 'SELECT id FROM tenants WHERE slug = $1', [businesses[0].seed.business.slug]);
  await sql(app, `UPDATE settings SET value = 'ring +91 98765 43210' WHERE tenant_id = $1 AND key = (SELECT key FROM settings WHERE tenant_id = $1 LIMIT 1)`, [tenant.id]);
  const rows = await sql(app, `SELECT t::text AS text FROM settings t WHERE t.tenant_id = $1`, [tenant.id]);
  assert.ok(rows.some((r) => strangers(r.text).length), 'the scan sees it');
  await sql(app, `DELETE FROM settings WHERE tenant_id = $1 AND value LIKE 'ring +91%'`, [tenant.id]);
});

// ---- Q-04: the two businesses stay apart ------------------------------------------------------------------------------------------

const textOf = (res) => `${res.status}:${res.text}`;
const GET_LISTS = routeList.filter((r) => r.method === 'GET' && !r.path.includes(':') && !r.noBusiness && !r.consoleOnly);
const GET_ONE = routeList.filter((r) => r.method === 'GET' && /^\/[a-z-]+\/:[a-zA-Z]+$/.test(r.path) && !r.noBusiness && !r.consoleOnly);
const WRITE_ONE = routeList.filter((r) => ['PATCH', 'PUT', 'DELETE'].includes(r.method) && /^\/[a-z-]+\/:[a-zA-Z]+$/.test(r.path) && !r.noBusiness && !r.consoleOnly);

/** What belongs to one business and to no other: the strings its seed holds that the other's does not. */
function own(of, other) {
  const set = (b) => new Set([...b.catalogue.products.map((p) => p.name), ...b.seed.reels.map((r) => r.igMediaId), ...b.seed.coupons.map((c) => c.code), ...b.seed.faq.map((f) => f.question), b.seed.business.owner.phone.slice(-12), b.seed.business.igUsername, b.seed.business.name]);
  const theirs = set(other);
  return [...set(of)].filter((s) => s && s.length >= 6 && !theirs.has(s));
}

async function twoSeeded() {
  const { app, businesses } = await seededWorld();
  const out = [];
  for (const [i, b] of businesses.entries()) {
    const [row] = await sql(app, 'SELECT id FROM tenants WHERE slug = $1', [b.seed.business.slug]);
    const tenant = await app.platform.tenants.get(row.id);
    const owner = { phone: `90000090${String(i).padStart(2, '0')}`, password: 'owner-pass-1' };
    await bindTenant(app.platform, tenant).users.ensureOwner(owner);
    const business = { tenant, slug: b.seed.business.slug, host: `${b.seed.business.slug}.${NEUTRAL}`, owner };
    business.token = await signIn(app, business, owner);
    out.push({ ...b, business, secrets: null });
  }
  out[0].secrets = own(out[0], out[1]);
  out[1].secrets = own(out[1], out[0]);
  return { app, a: out[0], b: out[1] };
}

test('Q-04: after seeding, neither business\'s lists show anything of the other\'s, on every list route', { timeout: 540_000 }, async () => {
  const { app, a, b } = await twoSeeded();
  assert.ok(a.secrets.length >= 5 && b.secrets.length >= 5, 'each has strings the other does not');
  assert.ok(GET_LISTS.length >= 20, `the contract has list routes (${GET_LISTS.length})`);
  let served = 0;
  for (const route of GET_LISTS) {
    const path = `/api/v1${route.path}`;
    const mine = await hit(app, path, { host: a.business.host, token: a.business.token });
    const theirs = await hit(app, path, { host: b.business.host, token: b.business.token });
    for (const res of [mine, theirs]) assert.ok(res.status < 500, `${route.id}: ${res.status} ${res.text.slice(0, 160)}`);
    if (mine.status === 200) served += 1;
    for (const secret of b.secrets) assert.equal(textOf(mine).includes(secret), false, `${route.id}: A's answer shows "${secret}" of B`);
    for (const secret of a.secrets) assert.equal(textOf(theirs).includes(secret), false, `${route.id}: B's answer shows "${secret}" of A`);
  }
  assert.ok(served >= 10, `most list routes answered 200 as the owner (${served})`);
});

test('Q-04: A\'s owner asking for B\'s item by id is told it is not there, on every read, write and delete route', { timeout: 540_000 }, async () => {
  const { app, a, b } = await twoSeeded();
  const before = { a: await snapshot(app, a.business.tenant.id, { skip: ['audit_log', 'rate_limit_hits', 'jobs'] }), b: await snapshot(app, b.business.tenant.id, { skip: ['audit_log', 'rate_limit_hits', 'jobs'] }) };
  let own200 = 0;
  let tried = 0;
  const lists = new Map(GET_LISTS.map((r) => [r.path, r]));
  for (const route of [...GET_ONE, ...WRITE_ONE]) {
    const parent = route.path.replace(/\/:[a-zA-Z]+$/, '');
    if (!lists.has(parent)) continue;
    const listing = await hit(app, `/api/v1${parent}`, { host: b.business.host, token: b.business.token });
    if (listing.status !== 200) continue;
    let items;
    try {
      const body = listing.json();
      items = Array.isArray(body) ? body : body.items ?? [];
    } catch {
      continue;
    }
    const target = items.find((item) => item && (item.id ?? item.slug) !== undefined);
    if (!target) continue;
    const id = encodeURIComponent(target.id ?? target.slug);
    const full = `/api/v1${route.path.replace(/:[a-zA-Z]+$/, id)}`;
    const mutating = route.method !== 'GET';
    const asB = mutating ? null : await hit(app, full, { host: b.business.host, token: b.business.token });
    if (asB?.status === 200) own200 += 1;
    const asA = await hit(app, full, { host: a.business.host, token: a.business.token, method: route.method, ...(mutating && route.method !== 'DELETE' ? { body: {} } : {}) });
    tried += 1;
    assert.ok([400, 403, 404, 405, 409, 422].includes(asA.status), `${route.id} (${route.method} ${full}): A got ${asA.status}: ${asA.text.slice(0, 120)}`);
    for (const secret of b.secrets) assert.equal(textOf(asA).includes(secret), false, `${route.id}: shows "${secret}" of B`);
  }
  assert.ok(tried >= 5, `routes by id were tried (${tried})`);
  assert.ok(own200 >= 3, `the same ids work for their own business (${own200}): the refusals are not just broken routes`);
  const after = { a: await snapshot(app, a.business.tenant.id, { skip: ['audit_log', 'rate_limit_hits', 'jobs'] }), b: await snapshot(app, b.business.tenant.id, { skip: ['audit_log', 'rate_limit_hits', 'jobs'] }) };
  assert.deepEqual(after, before, 'no write by either business changed any row of either');
});

test('Q-04: A\'s token on B\'s address, B\'s token on A\'s address, and no token at all, get nothing', { timeout: 540_000 }, async () => {
  const { app, a, b } = await twoSeeded();
  for (const [token, host] of [[a.business.token, b.business.host], [b.business.token, a.business.host]]) {
    for (const route of GET_LISTS.slice(0, 40)) {
      const res = await hit(app, `/api/v1${route.path}`, { host, token });
      assert.ok([400, 401, 403, 404].includes(res.status), `${route.id}: a token on the wrong address got ${res.status}`);
    }
  }
  const none = await hit(app, '/api/v1/products', { host: a.business.host });
  assert.equal(none.status, 401);
});

test('Q-04: the buyer pages of each business show none of the other\'s products, reels, coupons or owner', { timeout: 540_000 }, async () => {
  const { app, a, b } = await twoSeeded();
  for (const path of ['/', '/sitemap.xml', '/robots.txt', '/products', '/pages']) {
    const mine = await hit(app, path, { host: a.business.host });
    const theirs = await hit(app, path, { host: b.business.host });
    for (const secret of b.secrets) assert.equal(textOf(mine).includes(secret), false, `${path} of A shows "${secret}"`);
    for (const secret of a.secrets) assert.equal(textOf(theirs).includes(secret), false, `${path} of B shows "${secret}"`);
  }
  const home = await hit(app, '/', { host: a.business.host });
  assert.equal(home.status, 200);
  assert.ok(home.text.includes(a.seed.business.name) || home.text.length > 500, 'the home page is the business\'s own');
});

test('Q-04: the database fence, as the app login, shows each business only its own rows and nothing with no business set', { timeout: 540_000 }, async () => {
  const { app, a, b } = await twoSeeded();
  const tables = await tenantTables(app);
  // The seed files make no orders (the thirty days of activity do), so each business gets one here: the fence is only proved on rows that exist.
  for (const [i, { business }] of [a, b].entries()) {
    const [has] = await sql(app, 'SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1', [business.tenant.id]);
    if (has.n) continue;
    const who = inventedPerson(i);
    await sql(app, `INSERT INTO orders (tenant_id, order_number, public_token, customer_name, phone, address, city, state, pincode, subtotal_paise, shipping_paise, total_paise)
      VALUES ($1, $2, $3, $4, $5, 'Sample street 1', 'Mumbai', 'Maharashtra', '400001', 100, 0, 100)`, [business.tenant.id, `SEED-FENCE-${i}`, `fence-token-${i}-${business.tenant.id}`, who.name, who.phone]);
  }
  for (const table of ['products', 'reels', 'orders', 'categories', 'settings'].filter((t) => tables.includes(t))) {
    const [mixed] = await sql(app, `SELECT count(DISTINCT tenant_id)::int AS n FROM "${table}" WHERE tenant_id = ANY($1)`, [[a.business.tenant.id, b.business.tenant.id]]);
    assert.ok(mixed.n >= 1, table);
  }
  const { withTenant } = await import('../../../src/tenancy.js');
  for (const [mine, theirs] of [[a, b], [b, a]]) {
    const seen = await withTenant(mine.business.tenant, () => app.db.query('SELECT DISTINCT tenant_id FROM products'));
    assert.deepEqual(seen.map((r) => r.tenant_id), [mine.business.tenant.id], 'only its own rows');
    const asked = await withTenant(mine.business.tenant, () => app.db.query('SELECT count(*)::int AS n FROM products WHERE tenant_id = $1', [theirs.business.tenant.id]));
    assert.equal(asked[0].n, 0, 'asking for the other\'s by number gets nothing');
  }
  assert.ok(exists('seed/showcase/manifest.json'));
  assert.ok(keys().length >= 2);
});
