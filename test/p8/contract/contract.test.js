// The Phase 8 contract (hardening and the showcase kit): what the tracks build against. Requirement ids, the seed
// format and the invented-people rules, migrations 800 and 810, the feedback routes, the importer's interface, the tools'
// interfaces and budgets, the web-app hooks of the seller console, and the showcase workflow. Nothing here stands for a
// requirement: the tracks' tests carry the ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadShowcase, parseArgs as showcaseArgs, seedShowcase, ShowcaseError } from '../../../scripts/showcase.js';
import { parseArgs as migrateArgs, readSource } from '../../../scripts/migrate-business.js';
import { platformRoutesSource } from '../../../scripts/gen-platform-routes.mjs';
import { PLATFORM_ROUTES } from '../../../shared/api-client/platform-routes.js';
import { FEEDBACK_PLATFORM_OWNERS, FEEDBACK_STATES, FeedbackCreate, FeedbackUpdate, platformRoutes } from '../../../src/contracts/api/platform.js';
import { CONFLICT_KINDS, LEGACY_TABLES, MIGRATION_STRIPS, MigrationOptions, MigrationReport, MigrationSource, countsBalance, nextOrderNumber } from '../../../src/contracts/migration.js';
import { PEOPLE_RULES, SHOWCASE, SeedCatalogue, ShowcaseSeed, fromLegacyCatalogue, inventedPerson, problemsWithPeople, problemsWithPerson } from '../../../src/contracts/seed.js';
import { MODULES } from '../../../src/modules/index.js';
import { createMigration } from '../../../src/modules/migration/index.js';
import { withTenant } from '../../../src/tenancy.js';
import { BAD_BACKUPS, DRILL_STEPS, checksumSql, parseArgs as drillArgs, run as runDrill } from '../../../tools/drill/index.mjs';
import { checkRequirements, phaseFileHashes, repoRoot } from '../../../tools/gate-lib.mjs';
import { PARTS, PART_REQUIREMENTS, loadBudgets, nodeFlags, parseArgs as loadArgs, postgresFlags, rssMb, run as runLoad, writeReport } from '../../../tools/load/index.mjs';
import { NAME_FREE, checkFolders } from '../../../tools/policy-check.mjs';
import { ACTIVITY_KINDS, createClock, createRng, digestOf, run as runActivity, runOptions } from '../../../tools/sim/activity/index.mjs';
import { CONSOLE_HOST, addBusiness, consoleUser, hit, onConsole, startWorld } from '../../p0/spec-p0/support.js';
import { refusal } from '../../p4/contract/support.js';

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));
const DENIED = /42501|permission denied/;
/** A sample business's name, put together here so this file holds none. */
const SAMPLE_NAME = ['Meh', 'ta Mart'].join('');

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-p8-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof text === 'string' ? text : JSON.stringify(text));
  }
  return root;
}

/** The repository's showcase seed, copied to a scratch folder with one change. */
function showcaseCopy(change) {
  const files = {};
  for (const entry of fs.readdirSync(path.join(repoRoot, 'seed'), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const rel = path.relative(repoRoot, path.join(entry.parentPath, entry.name)).split(path.sep).join('/');
    files[rel] = read(rel);
  }
  change(files);
  return tree(files);
}
const secondFile = () => `seed/showcase/${json(SHOWCASE.manifest).businesses[1].file}`;

test('the requirement list: twenty ids, short titles, none listed by an earlier phase, and the gate counts them', () => {
  const list = json('requirements/p8.json');
  assert.deepEqual(list.map((r) => r.id), ['F-68', 'F-69', 'F-70', 'F-71', 'F-72', 'F-73', ...Array.from({ length: 14 }, (_, i) => `Q-${String(i + 1).padStart(2, '0')}`)]);
  assert.ok(list.every((r) => r.title.length <= 90));
  const earlier = new Set(fs.readdirSync(path.join(repoRoot, 'requirements')).filter((f) => f !== 'p8.json').flatMap((f) => json(`requirements/${f}`).map((r) => r.id)));
  assert.deepEqual(list.filter((r) => earlier.has(r.id)), []);
  assert.equal(checkFolders(['requirements'], repoRoot).length, 0);
  assert.equal(new RegExp(SAMPLE_NAME, 'i').test(read('requirements/p8.json')), false, 'a title names no sample business');

  const all = Array.from({ length: 9 }, (_, k) => json(`requirements/p${k}.json`)).flat();
  const checked = checkRequirements(repoRoot, 8, all.map((r) => `${r.id} stand-in`));
  // Only this phase's list is judged here: an earlier phase's list is that phase's to keep.
  assert.deepEqual(checked.problems.filter((problem) => !(problem.startsWith("requirements/p") && !problem.startsWith("requirements/p8") && problem.includes("has an invalid entry"))), []);
  assert.equal(checked.byPhase[8], 20);
  assert.deepEqual(checkRequirements(repoRoot, 8, []).missing.slice(-20), list.map((r) => r.id), 'with no test, all twenty are missing');
});

test('the gate refuses an id that an earlier phase already lists, and freezes the seed files with phase 8', () => {
  const root = tree({ 'requirements/p0.json': [{ id: 'F-1', title: 'a' }], 'requirements/p1.json': [{ id: 'F-1', title: 'again' }, { id: 'Q-01', title: 'b' }] });
  const { problems, byPhase } = checkRequirements(root, 1, ['F-1 x', 'Q-01 y']);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /p1\.json lists F-1, which requirements\/p0\.json already lists/);
  assert.deepEqual(byPhase, { 0: 1, 1: 2 });
  const locked = Object.keys(phaseFileHashes(repoRoot, 8));
  for (const file of ['requirements/p8.json', SHOWCASE.manifest, 'test/p8/contract/contract.test.js']) assert.ok(locked.includes(file), file);
  assert.ok(locked.some((file) => file.startsWith('seed/') && !file.startsWith('seed/showcase/')), 'the product file of the first business too');
  assert.equal(Object.keys(phaseFileHashes(repoRoot, 7)).some((f) => f.startsWith('seed/')), false);
});

test('invented people: the fixed lists and ranges pass, anything else fails, and a problem names the field only', () => {
  const people = Array.from({ length: 480 }, (_, n) => inventedPerson(n));
  assert.deepEqual(problemsWithPeople(people), []);
  assert.equal(new Set(people.map((p) => p.name)).size, 480);
  assert.equal(new Set(people.map((p) => p.phone)).size, 480);
  assert.deepEqual(inventedPerson(7), inventedPerson(7));
  assert.equal(PEOPLE_RULES.phone.pattern.test(PEOPLE_RULES.phone.first) && PEOPLE_RULES.phone.pattern.test(PEOPLE_RULES.phone.last), true);

  const ok = inventedPerson(3);
  assert.deepEqual(problemsWithPerson({ ...ok, phone: '+919876543210' }), ['phone']);
  assert.deepEqual(problemsWithPerson({ ...ok, phone: '9000000003' }), ['phone'], 'the full number, with its country code');
  assert.deepEqual(problemsWithPerson({ ...ok, name: 'Asha Rao' }), ['name']);
  assert.deepEqual(problemsWithPerson({ ...ok, name: `${PEOPLE_RULES.names.first[0]}  ${PEOPLE_RULES.names.last[0]}` }), ['name']);
  assert.deepEqual(problemsWithPerson({ ...ok, email: 'someone@gmail.com' }), ['email']);
  assert.deepEqual(problemsWithPerson({ ...ok, email: 'someone@example.com.evil.io' }), ['email']);
  assert.deepEqual(problemsWithPerson({ ...ok, email: 'help@shop.example' }), []);
  assert.deepEqual(problemsWithPerson({ ...ok, igUserId: '17841400000000000' }), ['igUserId']);
  assert.deepEqual(problemsWithPerson({ ...ok, igUsername: 'real_handle' }), ['igUsername']);
  assert.deepEqual(problemsWithPerson({}), ['name', 'phone']);
  assert.deepEqual(problemsWithPeople([ok, { ...ok, phone: '+14155550100' }]), [{ index: 1, fields: ['phone'] }]);
});

test('the seed files: both businesses load from the manifest, fit the schema, and share nothing that identifies one', () => {
  const loaded = loadShowcase({ env: {} });
  assert.deepEqual(loaded.map((b) => b.key), json(SHOWCASE.manifest).businesses.map((b) => b.key));
  assert.equal(loaded.length, 2);
  assert.deepEqual(loaded.map((b) => b.productsFrom), ['file', 'fallback']);
  for (const b of loaded) {
    assert.equal(ShowcaseSeed.safeParse(json(`seed/showcase/${b.file}`)).success, true, b.key);
    assert.equal(SeedCatalogue.safeParse(b.catalogue).success, true, b.key);
    assert.ok(b.catalogue.products.length >= 10 && b.catalogue.products.every((p) => Number.isInteger(p.pricePaise)), 'money is whole paise');
    assert.deepEqual(problemsWithPerson(b.seed.business.owner), []);
    assert.ok(b.seed.reels.length >= 2 && b.seed.automations.length >= 2 && b.seed.faq.length >= 1 && b.seed.coupons.length >= 1);
    assert.ok(b.seed.reels.every((r) => PEOPLE_RULES.instagram.id.test(r.igMediaId)), 'every Instagram id is made up');
    assert.equal(/gmail|yahoo|outlook/i.test(JSON.stringify(b.seed)), false);
  }
  assert.equal(loaded[1].catalogue.products.some((p) => p.variants.length > 0 && p.options.length > 0), true, 'options and variants are part of the format');
  assert.deepEqual(loadShowcase({ env: {}, only: loaded[1].key }).map((b) => b.key), [loaded[1].key]);
  assert.throws(() => loadShowcase({ env: {}, only: 'nobody' }), ShowcaseError);
});

test('a seed that breaks a rule is refused with the file and the field: a real-looking owner, a dangling product, a shared id', () => {
  const edit = (file, change) => (files) => {
    const data = JSON.parse(files[file]);
    change(data);
    files[file] = JSON.stringify(data);
  };
  const fails = (change, pattern) => assert.throws(() => loadShowcase({ root: showcaseCopy(change), env: {} }), (err) => err instanceof ShowcaseError && pattern.test(err.message), String(pattern));
  fails(edit(secondFile(), (seed) => { seed.business.owner.phone = '+919876543210'; }), /business\.owner/);
  fails(edit(secondFile(), (seed) => { seed.business.igUserId = '17841400000000000'; }), /business\.igUserId/);
  fails(edit(secondFile(), (seed) => { seed.app.supportEmail = 'shop@gmail.com'; }), /app\.supportEmail/);
  fails(edit(secondFile(), (seed) => { seed.reels[0].products = ['No such plant']; }), /reels\[0\]\.products names/);
  fails(edit(secondFile(), (seed) => { seed.automations[0].link.page = 'missing-page'; }), /automations\.0\.link\.page/);
  fails(edit(secondFile(), (seed) => { seed.surprise = true; }), /Seed "/);
  fails((files) => {
    const first = `seed/showcase/${JSON.parse(files[SHOWCASE.manifest]).businesses[0].file}`;
    edit(secondFile(), (seed) => { seed.business.igUserId = JSON.parse(files[first]).business.igUserId; })(files);
  }, /share the same Instagram id/);
  fails(edit(SHOWCASE.manifest, (manifest) => { manifest.businesses[1].file = '../outside.json'; }), /manifest/);
});

test('the second business takes its products from a file outside the repository when one is given, and from the committed catalogue when not', () => {
  const outside = tree({ 'demo.json': { store: { store_name: 'x' }, products: [{ name: 'Outside Fern', price: 199.5, mrp: 249, images: ['https://cdn.example/fern.jpg', 'http://plain.example/x.jpg'], categories: ['Ferns'] }, { name: 'Outside Palm', price: 300, mrp: 100 }], categories: [{ name: 'Ferns', slug: 'ferns' }] } });
  const file = path.join(outside, 'demo.json');
  const byFlag = loadShowcase({ env: {}, plantSeed: file })[1];
  assert.equal(byFlag.productsFrom, 'setting');
  assert.deepEqual(byFlag.catalogue.products.map((p) => [p.name, p.pricePaise, p.mrpPaise, p.images.length]), [['Outside Fern', 19950, 24900, 1], ['Outside Palm', 30000, null, 0]]);
  assert.equal(loadShowcase({ env: { [SHOWCASE.plantSetting]: file } })[1].catalogue.products.length, 2, 'the setting does the same as the flag');
  assert.throws(() => loadShowcase({ env: {}, plantSeed: path.join(outside, 'missing.json') }), /cannot be read/);
  assert.equal(fs.existsSync(path.join(repoRoot, 'seed', 'showcase', 'demo.json')), false, 'the outside file is never copied in');
  assert.throws(() => fromLegacyCatalogue({ products: [] }));

  assert.deepEqual(showcaseArgs(['--check', SHOWCASE.plantFlag, 'x.json', '--only', 'first', '--no-activity'], {}), { check: true, plantSeed: 'x.json', only: 'first', activity: false, exportBrands: '', days: 30, randomSeed: SHOWCASE.randomSeed });
  assert.throws(() => showcaseArgs(['--days', '400'], {}), ShowcaseError);
  assert.throws(() => showcaseArgs(['--wat'], {}), ShowcaseError);
});

test('a sample business is named only under seed/ and docs/: the policy check reads the showcase folders, comments and all', () => {
  for (const entry of ['tools/sim/activity', 'tools/load', 'tools/drill', 'scripts/showcase.js', 'src/modules/migration', 'src/modules/feedback', 'test/p8', '.github/workflows/showcase.yml']) assert.ok(NAME_FREE.includes(entry), entry);
  assert.deepEqual(checkFolders([...NAME_FREE], repoRoot), [], 'the contract itself names none');

  const root = tree({
    'tools/load/run.mjs': `// loads ${SAMPLE_NAME} first\nexport const a = 1;\n`,
    'tools/drill/notes.md': `Restore ${SAMPLE_NAME.toLowerCase().replace(' ', '')} here\n`,
    'test/p8/x.test.js': `const who = '${SAMPLE_NAME}';\nconst same = tenant.slug === 'x';\n`,
    '.github/workflows/showcase.yml': `name: ${SAMPLE_NAME}\n`,
    'seed/showcase/a.json': `{"name":"${SAMPLE_NAME}"}`,
    'tools/other/free.mjs': `// ${SAMPLE_NAME} in a comment of a tool outside the showcase\n`,
  });
  const found = checkFolders([...NAME_FREE, 'seed', 'tools/other'], root);
  assert.deepEqual(found.map((f) => `${f.file}:${f.line}`).sort(), ['.github/workflows/showcase.yml:1', 'test/p8/x.test.js:1', 'tools/drill/notes.md:1', 'tools/load/run.mjs:1']);
  assert.ok(found.every((f) => f.rule === 'business-name-outside-seed'));
});

test('migrations 800 and 810: the three tables are the platform’s, fenced and out of reach of business code, and hold their rules', async (t) => {
  const app = await startWorld(t);
  const shop = await addBusiness(app, { slug: 'lamps', name: 'Lamp House' });
  const other = await addBusiness(app, { slug: 'pots', name: 'Pot House' });
  const sql = (text, params) => app.db.platform.query(text, params);
  const one = async (text, params) => (await sql(text, params))[0];
  for (const table of ['migration_runs', 'migration_id_map', 'feedback_items']) {
    assert.equal((await one(`SELECT is_nullable FROM information_schema.columns WHERE table_name = $1 AND column_name = 'tenant_id'`, [table]))?.is_nullable, 'NO', table);
    assert.ok(await one(`SELECT 1 AS ok FROM pg_policies WHERE tablename = $1 AND policyname = 'tenant_fence'`, [table]), `${table} has the fence`);
    assert.deepEqual(await sql(`SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'bhava_app' AND table_name = $1`, [table]), [], `${table}: no grant to the app role`);
    assert.match(String(await refusal(withTenant(shop.tenant, () => app.db.query(`SELECT * FROM ${table} LIMIT 1`)))), DENIED, `${table} is out of reach of business code`);
  }

  // Runs: a mode and a status from the lists, a finished run has its time, and one finished real run per export per business.
  const hash = 'a'.repeat(64);
  const run = (over = {}) => {
    const row = { tenant_id: shop.tenant.id, source: 'old-shop.json', source_hash: hash, mode: 'real', status: 'done', finished_at: new Date(), ...over };
    const columns = Object.keys(row);
    return one(`INSERT INTO migration_runs (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, counts, conflicts`, Object.values(row));
  };
  const first = await run();
  assert.deepEqual([first.counts, first.conflicts], [{}, []]);
  assert.equal(await refusal(run()), 'migration_runs_once_idx', 'the same export is not imported twice');
  await run({ mode: 'dry' });
  await run({ status: 'failed' });
  await run({ tenant_id: other.tenant.id });
  assert.match(String(await refusal(run({ mode: 'trial' }))), /migration_runs_mode_check/);
  assert.match(String(await refusal(run({ status: 'running' }))), /migration_runs_check/, 'a running run has no finish time');
  assert.match(String(await refusal(run({ source_hash: 'nope' }))), /source_hash/);

  // The id map: one new id per old id per business, and only against a run of that same business.
  const map = (tenantId, runId, oldId = '41') => sql(`INSERT INTO migration_id_map (tenant_id, run_id, table_name, old_id, new_id) VALUES ($1, $2, 'products', $3, '7')`, [tenantId, runId, oldId]);
  await map(shop.tenant.id, first.id);
  assert.match(String(await refusal(map(shop.tenant.id, first.id))), /migration_id_map_pkey/);
  assert.match(String(await refusal(map(other.tenant.id, first.id, '42'))), /migration_id_map_tenant_id_run_id_fkey/, 'a run of another business');

  // Feedback: the four states, `fixed` exactly when it says what fixed it, and it goes with its business.
  const item = (over = {}) => {
    const row = { tenant_id: shop.tenant.id, said_by: 'The owner', area: 'Orders', body: 'The packed filter is hard to find', ...over };
    const columns = Object.keys(row);
    return one(`INSERT INTO feedback_items (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, severity, state, fixed_in`, Object.values(row));
  };
  assert.deepEqual(await item().then(({ severity, state, fixed_in }) => [severity, state, fixed_in]), ['medium', 'new', '']);
  await item({ state: 'fixed', fixed_in: 'd690d18' });
  assert.match(String(await refusal(item({ state: 'fixed' }))), /feedback_items_check/);
  assert.match(String(await refusal(item({ state: 'planned', fixed_in: 'd690d18' }))), /feedback_items_check/);
  assert.match(String(await refusal(item({ state: 'done' }))), /feedback_items_state_check/);
  assert.match(String(await refusal(item({ severity: 'urgent' }))), /feedback_items_severity_check/);
  assert.match(String(await refusal(item({ body: '   ' }))), /feedback_items_body_check/);
  await sql('DELETE FROM tenants WHERE id = $1', [other.tenant.id]);
  assert.equal((await one('SELECT count(*)::int AS n FROM migration_runs WHERE tenant_id = $1', [other.tenant.id])).n, 0, 'a closed business takes its runs with it');
});

test('the feedback routes: three Platform Console routes owned by the feedback module, refused to nobody signed in, 501 until built', async (t) => {
  const ids = ['platform.feedback', 'platform.createFeedback', 'platform.updateFeedback'];
  assert.deepEqual(FEEDBACK_PLATFORM_OWNERS, { feedback: ids });
  assert.deepEqual(ids.map((id) => [platformRoutes[id].method, platformRoutes[id].path, platformRoutes[id].status ?? 200]), [['GET', '/feedback', 200], ['POST', '/tenants/:id/feedback', 201], ['PATCH', '/feedback/:id', 200]]);
  for (const id of ids) assert.deepEqual([...platformRoutes[id].platformRoles], ['super_admin', 'support'], id);
  assert.equal(read('shared/api-client/platform-routes.js'), platformRoutesSource(), 'run npm run gen:platform-routes');
  for (const id of ids) assert.equal(PLATFORM_ROUTES[id].path, platformRoutes[id].path);
  assert.deepEqual(MODULES.find((m) => m.name === 'feedback').owns, { migrations: ['810_feedback.sql'], tables: ['feedback_items'], api: [], store: [], platform: ids, jobs: [] });

  assert.deepEqual(FEEDBACK_STATES, ['new', 'planned', 'fixed', 'declined']);
  assert.equal(FeedbackCreate.parse({ saidBy: 'The owner', area: 'Orders', text: 'Hard to find' }).severity, 'medium');
  assert.equal(FeedbackCreate.safeParse({ saidBy: 'The owner', area: 'Orders', text: '  ' }).success, false);
  assert.equal(FeedbackUpdate.safeParse({ state: 'fixed' }).success, false, 'fixed says what fixed it');
  assert.equal(FeedbackUpdate.safeParse({ state: 'fixed', fixedIn: 'd690d18' }).success, true);
  assert.equal(FeedbackUpdate.safeParse({ state: 'planned', fixedIn: 'd690d18' }).success, false);
  assert.equal(FeedbackUpdate.safeParse({}).success, false);
  assert.equal(platformRoutes['platform.feedback'].query.parse({}).state, 'all');

  const app = await startWorld(t);
  const admin = await consoleUser(app);
  const calls = [['/feedback', 'GET'], ['/tenants/1/feedback', 'POST'], ['/feedback/1', 'PATCH']];
  for (const [url, method] of calls) {
    const body = method === 'GET' ? undefined : {};
    assert.equal((await hit(app, url, { host: CONSOLE_HOST, method, body })).status, 401, `${method} ${url} with nobody signed in`);
    const res = await onConsole(app, admin, url, { method, body });
    assert.equal(res.status, 501, `${method} ${url}`);
    assert.equal(res.json().code, 'not_implemented');
  }
  const onboarder = await consoleUser(app, 'onboarding');
  assert.equal((await onConsole(app, onboarder, '/feedback')).status, 403);
});

test('the importer: listed with the platform’s modules, its rules are data, and plan and run exist', async () => {
  const names = MODULES.map((m) => m.name);
  assert.deepEqual(names.slice(names.indexOf('tenant-health'), names.indexOf('tenant-health') + 3), ['tenant-health', 'feedback', 'migration']);
  assert.deepEqual(MODULES.find((m) => m.name === 'migration').owns, { migrations: ['800_migration.sql'], tables: ['migration_runs', 'migration_id_map'], api: [], store: [], platform: [], jobs: [] });
  const importer = createMigration({});
  assert.deepEqual(Object.keys(importer), ['plan', 'run']);

  const source = { format: 'bhava-legacy-export', version: 1, label: 'old shop', tables: { orders: [{ id: 1, order_number: 4210 }], products: [] } };
  assert.equal(MigrationSource.safeParse(source).success, true);
  assert.equal(MigrationSource.safeParse({ ...source, version: 2 }).success, false);
  assert.equal(MigrationSource.safeParse({ ...source, tables: { 'Bad Name': [] } }).success, false);
  assert.deepEqual(MigrationOptions.parse({ tenantId: 3 }), { tenantId: 3, startedBy: null });
  assert.equal(MigrationOptions.safeParse({ tenantId: 3, reels: 'keep' }).success, false);
  assert.equal(nextOrderNumber(4210), 4211);
  assert.equal(nextOrderNumber(0, 1), 1);
  assert.equal(nextOrderNumber(10, 50), 50, 'the counter never moves back');
  assert.ok(LEGACY_TABLES.indexOf('products') < LEGACY_TABLES.indexOf('reel_products') && LEGACY_TABLES.indexOf('orders') < LEGACY_TABLES.indexOf('order_items'), 'a parent before its children');
  assert.ok(MIGRATION_STRIPS.activity.includes('username') && MIGRATION_STRIPS.activity.includes('comment_text'));
  assert.equal(CONFLICT_KINDS.reel_on_other_account.blocking, true);
  assert.equal(countsBalance({ products: { source: 5, imported: 3, skipped: 2 } }), true);
  assert.equal(countsBalance({ products: { source: 5, imported: 3, skipped: 1 } }), false);
  const report = { mode: 'dry', tenantId: 3, sourceHash: 'b'.repeat(64), counts: { products: { source: 1, imported: 1, skipped: 0 } }, conflicts: [{ kind: 'slug_taken', table: 'products', oldId: '9', blocking: true }], blocked: true, alreadyImported: false, runId: null, nextOrderNumber: null };
  assert.equal(MigrationReport.safeParse(report).success, true);
  assert.equal(MigrationReport.safeParse({ ...report, conflicts: [{ ...report.conflicts[0], username: 'someone' }] }).success, false, 'a conflict carries ids and codes only');

  assert.deepEqual(migrateArgs(['--source', 'x.json', '--tenant', 'lamps']), { source: 'x.json', tenant: 'lamps', run: false, reels: undefined });
  assert.equal(migrateArgs(['--source', 'x.json', '--tenant', 'lamps', '--run', '--reels', 'drop']).run, true);
  assert.throws(() => migrateArgs(['--tenant', 'lamps']), /--source/);
  assert.throws(() => migrateArgs(['--source', 'x.json', '--tenant', 'lamps', '--reels', 'keep']), /--reels/);
  const dir = tree({ 'good.json': source, 'bad.json': { ...source, format: 'other' } });
  assert.equal(readSource(path.join(dir, 'good.json')).label, 'old shop');
  assert.throws(() => readSource(path.join(dir, 'bad.json')), /does not fit: format/);
  assert.throws(() => readSource(path.join(dir, 'none.json')), /no such file/);
});

test('the budgets are the QA server’s: memory and Postgres settings match the compose file, the mix adds to 100, every class has a target', () => {
  const budgets = loadBudgets();
  const compose = read('deploy/bhava/compose.yaml');
  const service = (name) => compose.slice(compose.indexOf(`\n  ${name}:`), compose.indexOf('\n\n', compose.indexOf(`\n  ${name}:`)));
  for (const role of ['web', 'worker', 'postgres']) assert.equal(Number(/mem_limit: (\d+)m/.exec(service(role))[1]), budgets.memoryMb[role], role);
  assert.deepEqual(budgets.memoryMb, { web: 512, worker: 384, postgres: 512 });
  assert.equal(Number(/shared_buffers=(\d+)MB/.exec(compose)[1]), budgets.postgres.sharedBuffersMb);
  assert.equal(Number(/max_connections=(\d+)/.exec(compose)[1]), budgets.postgres.maxConnections);
  assert.deepEqual(postgresFlags(budgets), ['-c', 'listen_addresses=127.0.0.1', '-c', 'shared_buffers=128MB', '-c', 'max_connections=40']);
  assert.deepEqual(nodeFlags(512), ['--max-old-space-size=384']);
  assert.equal(budgets.businesses, 10);
  assert.equal(budgets.failedRequests, 0);
  assert.deepEqual([budgets.restart.lostWebhooks, budgets.restart.duplicateSends], [0, 0]);
  assert.deepEqual(budgets.mix.map((m) => m.class).sort(), Object.keys(budgets.p95Ms).sort());
  assert.ok(Object.values(budgets.p95Ms).every((ms) => ms > 0 && ms < 2500), 'server time leaves room in the page budget');
  const bad = tree({ 'b.json': { ...budgets, mix: budgets.mix.slice(1) } });
  assert.throws(() => loadBudgets(path.join(bad, 'b.json')), /adds up to/);
});

test('the load and drill tools: their parts, their options, the shared report writer, and run answers not built', async () => {
  assert.deepEqual(PARTS, ['mix', 'storm', 'restart']);
  assert.deepEqual(PART_REQUIREMENTS, { mix: 'Q-05', storm: 'Q-06', restart: 'Q-07' });
  assert.deepEqual(loadArgs([]), { parts: ['mix', 'storm', 'restart'], seconds: null, out: 'load' });
  assert.deepEqual(loadArgs(['--part', 'storm', '--seconds', '30']), { parts: ['storm'], seconds: 30, out: 'load' });
  assert.throws(() => loadArgs(['--part', 'everything']), /--part/);
  assert.throws(() => loadArgs(['--seconds', '9999']), /--seconds/);
  await assert.rejects(runLoad({}), /not built/);

  assert.deepEqual(DRILL_STEPS, ['seed', 'backup', 'restore', 'compare', 'fence', 'logins', 'start', 'refuse']);
  assert.deepEqual(Object.keys(BAD_BACKUPS), ['truncated', 'corrupted', 'wrong_version']);
  assert.deepEqual(drillArgs(['--only', 'refuse']), { only: ['refuse'], out: 'drill' });
  assert.throws(() => drillArgs(['--only', 'half']), /--only/);
  await assert.rejects(runDrill({}), /not built/);
  assert.equal(checksumSql('orders', ['id'], { tenantColumn: 'tenant_id' }), `SELECT count(*)::int AS rows, COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') AS checksum FROM orders t WHERE t.tenant_id = $1`);
  assert.equal(checksumSql('plans', ['code']).includes('WHERE'), false);
  assert.throws(() => checksumSql('orders; DROP TABLE x', ['id']), /not a table or column name/);
  assert.throws(() => checksumSql('orders', []), /order by/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-p8-report-'));
  const report = { title: 'Load test', ok: false, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:02:00Z', summary: [['Businesses', 10]], checks: [{ id: 'Q-05', name: 'failed requests', ok: true, measured: 0, limit: 0 }, { name: 'web memory | peak', ok: false, measured: '600 MB', limit: '512 MB' }], notes: ['A short run'] };
  const files = writeReport('load', report, { root });
  assert.deepEqual([path.relative(root, files.json), path.relative(root, files.md)].map((f) => f.replaceAll('\\', '/')), ['test-results/load/report.json', 'test-results/load/report.md']);
  assert.deepEqual(JSON.parse(fs.readFileSync(files.json, 'utf8')), report);
  const md = fs.readFileSync(files.md, 'utf8');
  assert.match(md, /^# Load test\n\nResult: \*\*FAIL\*\*/);
  assert.match(md, /\| Q-05 failed requests \| pass \| 0 \| 0 \|/);
  assert.match(md, /\| web memory \\\| peak \| FAIL \| 600 MB \| 512 MB \|/);
  assert.throws(() => writeReport('../escape', report, { root }), /report name/);
  assert.ok(read('.gitignore').split('\n').includes('test-results/'), 'reports are never committed');
  const mine = rssMb(process.pid);
  assert.ok(mine === null || (mine > 5 && mine < 8192), `resident memory of this process: ${mine}`);
  assert.equal(rssMb(2 ** 30), null, 'a process that is not there has no reading, never 0');
});

test('the activity generator: a seeded generator and a clock that only moves when told, so two runs agree; run answers not built', async () => {
  const draw = (seed) => { const rng = createRng(seed); return [rng.next(), rng.int(1, 6), rng.pick(['a', 'b', 'c']), rng.chance(0.5), rng.fork('first').int(0, 1000), rng.fork('second').int(0, 1000)]; };
  assert.deepEqual(draw(SHOWCASE.randomSeed), draw(SHOWCASE.randomSeed));
  assert.notDeepEqual(draw(1), draw(2));
  const rng = createRng(7);
  const rolls = Array.from({ length: 2000 }, () => rng.int(1, 6));
  assert.deepEqual([...new Set(rolls)].sort(), [1, 2, 3, 4, 5, 6]);
  assert.ok(Array.from({ length: 2000 }, () => rng.next()).every((n) => n >= 0 && n < 1));
  assert.throws(() => createRng(-1));
  assert.throws(() => createRng(1.5));

  const clock = createClock('2026-03-01T00:00:00Z');
  assert.equal(clock.now().toISOString(), '2026-03-01T00:00:00.000Z');
  assert.equal(clock.advance(86_400_000).toISOString(), '2026-03-02T00:00:00.000Z');
  assert.equal(clock.now().toISOString(), '2026-03-02T00:00:00.000Z');
  assert.throws(() => createClock('not a date'));

  const events = [[1, 'first', 'comment', 0], [1, 'first', 'dm', 0], [2, 'second', 'checkout', 4]];
  assert.equal(digestOf(events), digestOf(events.map((e) => [...e])));
  assert.notEqual(digestOf(events), digestOf([...events].reverse()), 'order is part of the proof');
  assert.throws(() => digestOf([[1, 'first', 'teleport', 0]]));
  for (const kind of ['comment', 'dm', 'story_reply', 'mention', 'insights', 'visit', 'checkout', 'payment', 'shipment', 'return', 'review']) assert.ok(ACTIVITY_KINDS.includes(kind), kind);

  const given = runOptions({ businesses: [{ key: 'first' }], clock });
  assert.deepEqual([given.days, given.seed], [SHOWCASE.days, SHOWCASE.randomSeed]);
  assert.throws(() => runOptions({ businesses: [], clock }), /businesses/);
  assert.throws(() => runOptions({ businesses: [{ key: 'first' }] }), /clock/);
  await assert.rejects(runActivity({ businesses: [{ key: 'first' }], clock }), /not built/);
  await assert.rejects(seedShowcase({}), /not built/);
  const source = read('tools/sim/activity/index.mjs').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/Math\.random|Date\.now|new Date\(\)/.test(source), false, 'no choice and no time comes from outside the seed and the clock');
});

test('the commands, the web-app hooks of the seller console, and the showcase workflow are in place', () => {
  const pkg = json('package.json');
  assert.deepEqual(['showcase', 'load', 'drill', 'migrate-business'].map((name) => pkg.scripts[name]), ['node scripts/showcase.js', 'node tools/load/index.mjs', 'node tools/drill/index.mjs', 'node scripts/migrate-business.js']);
  assert.ok(pkg.devDependencies.autocannon, 'autocannon is a dev dependency');
  assert.equal(pkg.dependencies.autocannon, undefined);

  // The seller console: a manifest for the console only, and a place where the worker registers once the track writes it.
  assert.match(read('console/index.html'), /<link rel="manifest" href="\/manifest\.webmanifest" \/>/);
  const manifest = json('console/public/manifest.webmanifest');
  assert.deepEqual([manifest.start_url, manifest.scope, manifest.display], ['/admin/', '/admin/', 'standalone']);
  assert.equal(manifest.name, 'Bhava for Business');
  assert.match(read('console/vite.config.js'), /__BHAVA_SERVICE_WORKER__: JSON\.stringify\(hasServiceWorker\)/);
  assert.match(read('console/src/main.jsx'), /registerServiceWorker\(\);/);
  const register = read('console/src/pwa/register.js');
  assert.match(register, /export async function registerServiceWorker\(/);
  assert.match(register, /export async function clearBusinessCaches\(/);
  assert.equal(read('console/platform.html').includes('manifest'), false, 'the Platform Console is not an installable app');

  // The workflow: by hand, and on a push that touches the seed or the build tool; the four jobs in order; no business named.
  const workflow = read('.github/workflows/showcase.yml');
  assert.match(workflow, /\non:\n  workflow_dispatch:\n  push:\n    paths:\n      - 'seed\/\*\*'\n      - 'tools\/build-brand\/\*\*'/);
  for (const job of ['seed', 'build', 'emulator', 'ready']) assert.match(workflow, new RegExp(`\\n  ${job}:\\n`), job);
  assert.match(workflow, /needs: seed\n/);
  assert.match(workflow, /needs: \[seed, build\]\n/);
  assert.match(workflow, /npm run showcase -- --check/);
  assert.match(workflow, /--export-brands/);
  assert.match(workflow, /npm run build-brand -- .*--driver local/);
  assert.match(workflow, /android-emulator-runner/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.equal(/secrets\./.test(workflow), false, 'no secret is used');
});
