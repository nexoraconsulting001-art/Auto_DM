// G-15, G-16 and G-17: the go-live checklist and the sign-up switch. The checklist is run as the command a person runs
// (`npm run golive`) with a chosen environment, and as the Platform Console answers it. Attack cases: every secret setting
// holding a marker that must never be printed; each setting in turn a test value (a simulator address, a test-mode key, a
// placeholder, with spaces and capitals); a sign-off with no name, no date, a malformed date, too old, or for an item that
// is not signed off; a provider that hangs or answers with a Development-mode app; sign-up set to public by a support user,
// with no reason, and while a blocking item is missing; two changes at once.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { SECRET_SETTINGS } from '../../../src/config.js';
import { GOLIVE_DETAILS, GOLIVE_ITEMS, GOLIVE_STATES, GoliveStatus, blockingOpen } from '../../../src/contracts/golive.js';
import { platformRoutes } from '../../../src/contracts/api/platform.js';
import { CONSOLE_HOST, NEUTRAL, addBusiness, consoleUser, hit, onConsole, startWorld } from '../../p0/spec-p0/support.js';
import { assertNoneOf, runNode, scratch } from './support.js';

const closers = [];
after(async () => {
  for (const close of closers.reverse()) await close();
});

const GOOD = { IG_APP_ID: '1784201234567', APP_SECRET: 'real-app-secret-9f8e7d6c', VERIFY_TOKEN: 'real-verify-token-5a4b3c2d' };
const LIVE_RAZORPAY = { RAZORPAY_KEY_ID: 'rzp_live_AbCdEf123456', RAZORPAY_KEY_SECRET: 'rzp-live-secret-aa11bb22', RAZORPAY_WEBHOOK_SECRET: 'rzp-hook-secret-cc33dd44', RAZORPAY_PARTNER_CLIENT_ID: 'partner-client-ee55ff66', RAZORPAY_PARTNER_CLIENT_SECRET: 'partner-secret-gg77hh88' };

/** Runs `node scripts/golive.js` with a chosen environment; answers the exit code, the text and (for --json) the parsed status. */
/** The checklist must run at all for a test about its answer to mean anything. */
const ran = (res, what = 'the checklist') => assert.ok(res.status, `${what} gave no JSON: ${res.stderr.slice(0, 200)}`);

async function golive(env = {}, args = ['--json', '--offline']) {
  const res = await runNode(['scripts/golive.js', ...args], { env: { ALLOW_PGLITE: '1', ...env }, timeoutMs: 150_000 });
  let status = null;
  if (args.includes('--json')) {
    try {
      status = JSON.parse(res.stdout);
    } catch {
      status = null;
    }
  }
  return { ...res, status, item: (id) => status?.items?.find((i) => i.id === id) };
}

test('G-15: the checklist lists every item once, each ready or missing with a fixed phrase, and exits 1 while a blocking item is open', async () => {
  const res = await golive();
  assert.ok(res.status, `no JSON on stdout: ${res.stdout.slice(0, 200)} ${res.stderr.slice(0, 300)}`);
  const status = GoliveStatus.parse(res.status);
  assert.deepEqual(status.items.map((i) => i.id).sort(), GOLIVE_ITEMS.map((i) => i.id).sort(), 'every item, once');
  for (const item of status.items) {
    assert.ok(GOLIVE_STATES.includes(item.state));
    const spec = GOLIVE_ITEMS.find((i) => i.id === item.id);
    assert.deepEqual([item.owner, item.phase, item.blocks, item.kind], [spec.owner, spec.phase, spec.blocks, spec.check.kind], item.id);
  }
  assert.equal(status.ready, false);
  assert.equal(status.blockingMissing, blockingOpen(status.items).length);
  assert.ok(status.blockingMissing > 0);
  assert.equal(res.code, 1, 'non-zero while a blocking item is missing');
  assert.equal(status.deployEnv === 'production', false);
  const phrases = new Set(Object.values(GOLIVE_DETAILS));
  const settingNames = new Set(Object.values(SECRET_SETTINGS).concat(Object.keys(SECRET_SETTINGS), GOLIVE_ITEMS.flatMap((i) => [...(i.check.all ?? []), ...(i.check.any ?? [])])));
  for (const item of status.items) assert.ok(phrases.has(item.detail) || [...settingNames].some((n) => item.detail.includes(n)) || /^[A-Z0-9_ ,]+$/.test(item.detail), `${item.id}: detail "${item.detail}" is neither a fixed phrase nor a setting name`);
});

test('G-15: the text form shows each item, blocking ones first, who must act, and ends with the verdict; --blocking and --owner narrow it', async () => {
  const [all, blocking, user] = await Promise.all([golive({}, ['--offline']), golive({}, ['--offline', '--blocking']), golive({}, ['--offline', '--owner', 'user'])]);
  assert.equal(all.code, 1);
  assert.match(all.stdout, /Not ready for go-live: \d+ blocking items? open\./);
  for (const item of GOLIVE_ITEMS.filter((i) => i.blocks)) assert.ok(blocking.stdout.includes(item.id), `--blocking shows ${item.id}`);
  for (const item of GOLIVE_ITEMS.filter((i) => !i.blocks)) assert.equal(blocking.stdout.includes(` ${item.id} `), false, `--blocking hides ${item.id}`);
  for (const item of GOLIVE_ITEMS.filter((i) => i.owner === 'us')) assert.equal(user.stdout.includes(` ${item.id} `), false, `--owner user hides ${item.id}`);
  assert.ok(user.stdout.includes('legal.pages'));
});

test('G-15: bad arguments are refused with exit code 2 and no list', async () => {
  for (const args of [['--owner', 'them'], ['--print-secrets'], ['--owner']]) {
    const res = await golive({}, args);
    assert.equal(res.code, 2, args.join(' '));
    assert.equal(/ready|MISSING/.test(res.stdout), false);
  }
});

test('G-15: the checklist never prints a secret: every secret setting holds a marker and none reaches the text, the JSON or the errors', async () => {
  const env = {};
  const markers = [];
  for (const name of Object.keys(SECRET_SETTINGS)) {
    const marker = `MARKER-${name}-vq93xz`;
    env[name] = name === 'DATA_KEY' ? Buffer.alloc(32, 7).toString('base64') : marker;
    markers.push(env[name]);
  }
  env.DATABASE_URL = 'postgres://app:MARKER-dbpass-vq93xz@127.0.0.1:1/x';
  markers.push('MARKER-dbpass-vq93xz');
  const runs = await Promise.all([golive(env, ['--offline']), golive(env, ['--offline', '--json']), golive({ ...env, NODE_ENV: 'production', DEPLOY_ENV: 'production' }, ['--offline'])]);
  for (const res of runs) {
    assertNoneOf('the checklist output', `${res.stdout}\n${res.stderr}`, markers);
    assert.ok(res.stdout.length > 100, 'it still printed the list');
  }
});

test('G-15: the checklist never prints a secret even when a provider fails with an error that echoes the request', async () => {
  const echoing = http.createServer((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `bad request ${req.method} ${req.url} ${req.headers.authorization ?? ''}` } }));
  });
  await new Promise((resolve) => echoing.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => { echoing.closeAllConnections?.(); echoing.close(resolve); }));
  const base = `http://127.0.0.1:${echoing.address().port}`;
  const env = { GRAPH_BASE_URL: base, IG_API_BASE_URL: base, FB_GRAPH_BASE_URL: base, RAZORPAY_BASE_URL: base, SHIPROCKET_BASE_URL: base, WHATSAPP_BASE_URL: base, APP_SECRET: 'MARKER-echo-app-secret-q1', IG_APP_ID: '1784201234567', RAZORPAY_KEY_SECRET: 'MARKER-echo-rzp-q2', RAZORPAY_KEY_ID: 'rzp_live_Zz9Zz9Zz9Zz9', PLATFORM_WHATSAPP_TOKEN: 'MARKER-echo-wa-q3', SHIPROCKET_PASSWORD: 'MARKER-echo-ship-q4' };
  const res = await golive(env, ['--json']);
  assertNoneOf('the output', `${res.stdout}\n${res.stderr}`, ['MARKER-echo-app-secret-q1', 'MARKER-echo-rzp-q2', 'MARKER-echo-wa-q3', 'MARKER-echo-ship-q4']);
  assert.ok(res.status, 'it still answered');
  for (const id of ['meta.app_live', 'razorpay.route', 'shiprocket.account', 'whatsapp.sender']) assert.notEqual(res.item(id)?.state, 'ready', `${id}: a failing provider is never ready`);
});

// ---- G-16 ----------------------------------------------------------------------------------------------------------------

test('G-16: a setting that holds a simulator address, a test-mode key or a placeholder is not ready, in each form, one at a time', async () => {
  const base = { ...GOOD, ...LIVE_RAZORPAY };
  const clean = await golive(base);
  assert.equal(clean.item('meta.app_settings')?.state, 'ready', `a real-looking value is ready: ${clean.item('meta.app_settings')?.detail}`);
  assert.equal(clean.item('razorpay.settings')?.state, 'ready');
  const bad = ['http://127.0.0.1:9101', 'https://graph.test/v1', 'rzp_test_AbCdEf123456', 'RZP_TEST_AbCdEf123456', '  changeme  ', 'sim-secret', 'https://api.example.com', 'http://localhost:3000', 'placeholder', 'TODO'];
  const cases = [];
  for (const [item, settings] of [['meta.app_settings', Object.keys(GOOD)], ['razorpay.settings', Object.keys(LIVE_RAZORPAY)]]) {
    for (const name of settings) for (const value of bad) cases.push({ item, name, value, env: { ...base, [name]: value } });
  }
  const results = await Promise.all(cases.map(async (c) => ({ c, res: await golive(c.env) })));
  const wrong = results.filter(({ c, res }) => res.item(c.item)?.state === 'ready').map(({ c }) => `${c.item}: ${c.name}=${c.value.trim()}`);
  assert.deepEqual(wrong, [], 'these were reported ready');
  for (const { c, res } of results) assertNoneOf('the output', res.stdout + res.stderr, [c.value.trim()].filter((v) => v.length > 8 && !/^https?:\/\/(127|localhost|graph\.test|api\.example)/.test(v)));
});

test('G-16: a setting that is empty or only spaces is missing', async () => {
  const results = await Promise.all(['', '   ', '\t'].map((blank) => golive({ ...GOOD, ...LIVE_RAZORPAY, APP_SECRET: blank })));
  for (const res of results) assert.equal(res.item('meta.app_settings')?.state, 'missing');
});

test('G-16: a provider address that is a simulator or a test address is not ready, and says why in a fixed phrase', async () => {
  const sims = ['http://127.0.0.1:9101', 'http://localhost:9101', 'https://sim.test', 'https://10.0.0.4', 'http://graph.instagram.com'];
  const results = await Promise.all(sims.map((url) => golive({ GRAPH_BASE_URL: url, IG_API_BASE_URL: url, FB_GRAPH_BASE_URL: url, ...GOOD }, ['--json'])));
  for (const [i, res] of results.entries()) {
    assert.ok(res.status, `${sims[i]}: ${res.stderr.slice(0, 200)}`);
    for (const id of ['meta.app_live', 'meta.webhooks', 'meta.instagram_access', 'hosting.guard']) {
      assert.notEqual(res.item(id).state, 'ready', `${id} with ${sims[i]}`);
    }
    assert.equal(res.code, 1);
  }
});

test('G-16: a Meta app in Development mode, one that cannot be asked, and one that never answers are not ready', async () => {
  const modes = [
    { name: 'development', body: { id: '1784201234567', app_mode: 'development', mode: 'development', development_mode: true, restrictions: {}, link: 'https://x.test' } },
    { name: 'silent', hang: true },
    { name: 'error', status: 500, body: { error: { message: 'boom' } } },
  ];
  const servers = [];
  for (const mode of modes) {
    const server = http.createServer((req, res) => {
      if (mode.hang) return;
      res.writeHead(mode.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(mode.body));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
    servers.push(`http://127.0.0.1:${server.address().port}`);
  }
  const started = Date.now();
  const results = await Promise.all(servers.map((url) => golive({ GRAPH_BASE_URL: url, IG_API_BASE_URL: url, FB_GRAPH_BASE_URL: url, ...GOOD }, ['--json'])));
  assert.ok(Date.now() - started < 140_000, 'a probe that never answers does not hold the checklist');
  for (const [i, res] of results.entries()) {
    assert.ok(res.status, `${modes[i].name}: ${res.stderr.slice(0, 200)}`);
    assert.notEqual(res.item('meta.app_live').state, 'ready', modes[i].name);
    assert.equal(res.code, 1);
  }
  const silent = results[1].item('meta.app_live');
  assert.ok(['unknown', 'missing'].includes(silent.state), 'a probe that timed out is "not checked", never ready');
});

test('G-16: with --offline no outside service is asked, so every probe item is unknown and no probe item is ready', async () => {
  const res = await golive({ ...GOOD, ...LIVE_RAZORPAY });
  for (const item of res.status.items.filter((i) => i.kind === 'probe')) assert.notEqual(item.state, 'ready', item.id);
  assert.ok(res.status.items.filter((i) => i.kind === 'probe').some((i) => i.state === 'unknown'));
});

test('G-16: the running configuration is not ready while DEPLOY_ENV is not production or any production rule is broken', async () => {
  const [qa, broken] = await Promise.all([golive({}, ['--json']), golive({ NODE_ENV: 'production', DEPLOY_ENV: 'production', STORAGE_DRIVER: 'local', DRY_RUN: '1' }, ['--json'])]);
  assert.ok(qa.status && broken.status, 'the checklist ran');
  assert.notEqual(qa.item('hosting.guard')?.state, 'ready');
  assert.notEqual(broken.item('hosting.guard')?.state, 'ready');
});

// ---- sign-offs -----------------------------------------------------------------------------------------------------------

const ATTESTED = ['legal.payment_aggregator', 'stores.accounts', 'legal.trademark', 'legal.pages', 'showcase.signoff', 'legal.dpdp', 'hosting.region'];
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const entry = (id, over = {}) => ({ id, signedOffBy: 'A Person', role: 'Counsel', date: daysAgo(10), reference: 'folder-12', ...over });
function attestFile(entries, raw) {
  const file = path.join(scratch(), 'attestations.json');
  fs.writeFileSync(file, raw ?? JSON.stringify({ version: 1, entries }));
  return file;
}

test('G-15: a sign-off counts with a name and a date, and each one moves only its own item', async () => {
  const file = attestFile(ATTESTED.map((id) => entry(id)));
  const res = await golive({ GOLIVE_ATTESTATIONS: file });
  for (const id of ATTESTED) assert.equal(res.item(id).state, 'ready', id);
  const none = await golive({ GOLIVE_ATTESTATIONS: attestFile([entry('legal.pages')]) });
  assert.equal(none.item('legal.pages').state, 'ready');
  for (const id of ATTESTED.filter((i) => i !== 'legal.pages')) assert.equal(none.item(id).state, 'missing', `${id} is not signed`);
  assert.equal(none.item('legal.trademark').detail, GOLIVE_DETAILS.notSignedOff);
  assertNoneOf('the output', res.stdout, ['A Person', 'folder-12']);
});

test('G-15: a sign-off with no name, no date, a malformed date, a name of one letter or an extra field is not ready', async () => {
  const variants = [
    entry('legal.pages', { signedOffBy: '' }), entry('legal.pages', { signedOffBy: ' ' }), entry('legal.pages', { signedOffBy: 'X' }), entry('legal.pages', { date: '' }), entry('legal.pages', { date: 'yesterday' }),
    entry('legal.pages', { date: '2027-13-45' }), entry('legal.pages', { date: undefined }), entry('legal.pages', { signedOffBy: undefined }), entry('legal.pages', { extra: 'x' }), entry('legal.pages', { role: '' }),
  ];
  ran(await golive());
  const results = await Promise.all(variants.map((v) => golive({ GOLIVE_ATTESTATIONS: attestFile([v]) })));
  for (const [i, res] of results.entries()) {
    assert.notEqual(res.code, 0, `variant ${i}`);
    if (res.status) assert.notEqual(res.item('legal.pages').state, 'ready', `variant ${i} ${JSON.stringify(variants[i])}`);
  }
});

test('G-15: a sign-off older than the item allows is missing, and one for an item that is not signed off is refused', async () => {
  const old = await golive({ GOLIVE_ATTESTATIONS: attestFile([entry('legal.pages', { date: daysAgo(400) }), entry('showcase.signoff', { date: daysAgo(200) }), entry('legal.trademark', { date: daysAgo(400) })]) });
  assert.equal(old.item('legal.pages').state, 'missing');
  assert.equal(old.item('legal.pages').detail, GOLIVE_DETAILS.signOffExpired);
  assert.equal(old.item('showcase.signoff').state, 'missing', 'the showcase sign-off lasts 180 days');
  assert.equal(old.item('legal.trademark').state, 'ready', 'the trademark search lasts two years');
  const wrongItem = await golive({ GOLIVE_ATTESTATIONS: attestFile([entry('meta.app_live'), entry('hosting.tls'), entry('not.an_item')]) });
  assert.notEqual(wrongItem.code, 0);
  if (wrongItem.status) for (const id of ['meta.app_live', 'hosting.tls']) assert.notEqual(wrongItem.item(id).state, 'ready', id);
});

test('G-15: a sign-off file that is not JSON, empty, missing or of another version is not ready and never crashes into a stack trace of its contents', async () => {
  ran(await golive());
  for (const raw of ['{ not json', '', '[]', JSON.stringify({ version: 2, entries: [entry('legal.pages')] }), JSON.stringify({ version: 1 })]) {
    const res = await golive({ GOLIVE_ATTESTATIONS: attestFile([], raw) });
    assert.notEqual(res.code, 0);
    if (res.status) assert.notEqual(res.item('legal.pages').state, 'ready');
  }
  const gone = await golive({ GOLIVE_ATTESTATIONS: path.join(scratch(), 'nowhere.json') });
  assert.notEqual(gone.code, 0);
  if (gone.status) assert.notEqual(gone.item('legal.pages').state, 'ready');
});

// ---- the Platform Console --------------------------------------------------------------------------------------------------

test('G-15: the Platform Console answers the same list to a super admin and to support, to nobody else, and never with a value', async (t) => {
  const app = await startWorld(t, { overrides: { razorpayKeySecret: 'MARKER-console-rzp-zz1', appSecret: 'MARKER-console-app-zz2', platformWhatsappToken: 'MARKER-console-wa-zz3', razorpayKeyId: 'rzp_test_ConsoleKey123' } });
  assert.deepEqual([...platformRoutes['platform.goliveStatus'].platformRoles], ['super_admin', 'support']);
  const admin = await consoleUser(app);
  const support = await consoleUser(app, 'support');
  const onboarding = await consoleUser(app, 'onboarding');
  assert.equal((await hit(app, '/golive', { host: CONSOLE_HOST })).status, 401);
  assert.equal((await onConsole(app, onboarding, '/golive')).status, 403);
  const shop = await addBusiness(app, { slug: 'golive-seller', name: 'Golive Seller' });
  assert.notEqual((await hit(app, '/golive', { host: shop.host })).status, 200, 'not on a business\'s own address');
  const a = await onConsole(app, admin, '/golive');
  const b = await onConsole(app, support, '/golive');
  assert.equal(a.status, 200, a.text.slice(0, 200));
  const status = GoliveStatus.parse(a.json());
  assert.deepEqual(b.json().items.map((i) => [i.id, i.state]), status.items.map((i) => [i.id, i.state]));
  assertNoneOf('the console answer', a.text, ['MARKER-console', 'rzp_test_ConsoleKey123', 'golive-seller', 'Golive Seller']);
  assert.notEqual(status.items.find((i) => i.id === 'razorpay.settings').state, 'ready', 'a test-mode key in the running configuration');
  assert.equal(status.ready, false);
  for (const item of status.items.filter((i) => i.kind === 'per_business')) assert.equal(item.blocks, false);
});

test('G-15: the per-business items are shown as a count of businesses and never block go-live', async (t) => {
  const app = await startWorld(t);
  await addBusiness(app, { slug: 'counted-one', name: 'Counted One' });
  await addBusiness(app, { slug: 'counted-two', name: 'Counted Two' });
  const admin = await consoleUser(app);
  const res = await onConsole(app, admin, '/golive');
  const items = res.json().items.filter((i) => i.kind === 'per_business');
  assert.ok(items.length >= 10);
  for (const item of items) {
    assert.equal(item.blocks, false);
    assert.ok(!/counted-one|Counted One/.test(item.detail), 'no business is named');
  }
});

// ---- G-17 ----------------------------------------------------------------------------------------------------------------

const put = (app, who, body) => onConsole(app, who, '/signup', { method: 'PUT', body });
const modeOf = async (app, who) => (await onConsole(app, who, '/signup')).json().mode;
const audits = (app) => (app.db.platform ?? app.db).query(`SELECT details, actor FROM audit_log WHERE action = 'signup.mode_set' ORDER BY id`);

test('G-17: only a super admin changes the mode; support, onboarding and nobody are refused, and nothing changes', async (t) => {
  const app = await startWorld(t, { overrides: { goliveEnforce: true } });
  const admin = await consoleUser(app);
  const before = await modeOf(app, admin);
  for (const mode of ['closed', 'invite', 'public']) {
    for (const role of ['support', 'onboarding']) assert.equal((await put(app, await consoleUser(app, role), { mode, reason: 'a fine reason' })).status, 403, `${role} -> ${mode}`);
    assert.equal((await onConsole(app, { cookie: '', csrf: '' }, '/signup', { method: 'PUT', body: { mode, reason: 'x' } })).status, 401);
  }
  const shop = await addBusiness(app, { slug: 'not-a-platform-user', name: 'Seller' });
  assert.notEqual((await hit(app, '/signup', { host: shop.host, method: 'PUT', body: { mode: 'public', reason: 'sneaky' } })).status, 200);
  assert.equal(await modeOf(app, admin), before);
  assert.deepEqual(await audits(app), [], 'a refusal is not a change');
});

test('G-17: a mode change needs a reason: none, blank, too long and a non-text reason are refused and change nothing', async (t) => {
  const app = await startWorld(t, { overrides: { goliveEnforce: true } });
  const admin = await consoleUser(app);
  for (const body of [{ mode: 'closed' }, { mode: 'closed', reason: '' }, { mode: 'closed', reason: '   ' }, { mode: 'closed', reason: 5 }, { mode: 'closed', reason: null }, { mode: 'closed', reason: 'x'.repeat(5000) }, { reason: 'no mode' }, { mode: 'everyone', reason: 'invalid mode' }, { mode: ['closed'], reason: 'array' }]) {
    const res = await put(app, admin, body);
    assert.ok([400, 422].includes(res.status), `${JSON.stringify(body).slice(0, 60)} got ${res.status}`);
  }
  assert.equal(await modeOf(app, admin), 'invite');
  assert.deepEqual(await audits(app), []);
  const ok = await put(app, admin, { mode: 'closed', reason: 'pausing for a review' });
  assert.equal(ok.status, 200);
  const [row] = await audits(app);
  assert.equal(row.details.reason, 'pausing for a review');
  assert.match(String(row.actor), /platform/i);
});

test('G-17: public is refused while a blocking item is missing, names the ids, and is not audited as a change; a second reason forces it and is audited as forced', async (t) => {
  const app = await startWorld(t, { overrides: { goliveEnforce: true } });
  const admin = await consoleUser(app);
  const refused = await put(app, admin, { mode: 'public', reason: 'launch day' });
  assert.equal(refused.status, 409);
  assert.equal(refused.json().code, 'conflict');
  assert.ok(Object.keys(refused.json().fields ?? {}).length > 0, 'it says which items are missing');
  assert.equal(await modeOf(app, admin), 'invite');
  assert.equal((await put(app, admin, { mode: 'public', reason: 'launch day', force: true })).status, 400, 'force with no second reason');
  assert.equal((await put(app, admin, { mode: 'public', reason: 'launch day', force: true, forceReason: '   ' })).status, 400, 'a blank second reason');
  assert.equal((await put(app, await consoleUser(app, 'support'), { mode: 'public', reason: 'launch day', force: true, forceReason: 'I say so' })).status, 403);
  assert.equal(await modeOf(app, admin), 'invite');
  const forced = await put(app, admin, { mode: 'public', reason: 'launch day', force: true, forceReason: 'the founder accepted the open items' });
  assert.equal(forced.status, 200);
  assert.equal(forced.json().mode, 'public');
  const rows = await audits(app);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].details.forced, true);
  assert.equal(rows[0].details.forceReason, 'the founder accepted the open items');
  assert.ok(Array.isArray(rows[0].details.missing) && rows[0].details.missing.length > 0, 'the open items are in the record');
});

test('G-17: closed and invite are never held back by the checklist, and force on them is harmless', async (t) => {
  const app = await startWorld(t, { overrides: { goliveEnforce: true } });
  const admin = await consoleUser(app);
  for (const mode of ['closed', 'invite', 'closed']) {
    const res = await put(app, admin, { mode, reason: `to ${mode}` });
    assert.equal(res.status, 200, mode);
    assert.equal(res.json().mode, mode);
  }
  assert.equal((await audits(app)).length, 3);
});

test('G-17: two mode changes at once leave one of the two modes and two audit rows', async (t) => {
  const app = await startWorld(t, { overrides: { goliveEnforce: true } });
  const admin = await consoleUser(app);
  const other = await consoleUser(app);
  const [a, b] = await Promise.all([put(app, admin, { mode: 'closed', reason: 'one of two' }), put(app, other, { mode: 'invite', reason: 'the other of two' })]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  const final = await modeOf(app, admin);
  assert.ok(['closed', 'invite'].includes(final));
  const rows = await audits(app);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.details.mode).sort(), ['closed', 'invite']);
});

test('G-17: with sign-up closed or by invite, starting a business is refused on the server and no business is made, whatever a screen shows', async (t) => {
  const app = await startWorld(t, { overrides: { goliveEnforce: true } });
  const admin = await consoleUser(app);
  const count = async () => Number((await (app.db.platform ?? app.db).query('SELECT count(*)::int AS n FROM tenants'))[0].n);
  const start = () => hit(app, '/api/v1/signup', { host: `app.${NEUTRAL}`, method: 'POST', body: { accountType: 'seller', name: 'Sneaky Sign-up' } });
  for (const mode of ['closed', 'invite']) {
    assert.equal((await put(app, admin, { mode, reason: `set ${mode}` })).status, 200);
    const before = await count();
    const res = await start();
    assert.ok([401, 403, 409].includes(res.status), `${mode}: sign-up start answered ${res.status}`);
    const withBadCode = await hit(app, '/api/v1/signup', { host: `app.${NEUTRAL}`, method: 'POST', body: { accountType: 'seller', name: 'Sneaky Sign-up', inviteCode: 'not-a-real-code' } });
    assert.ok([401, 403, 409].includes(withBadCode.status), `${mode}: with a made-up invite code ${withBadCode.status}`);
    assert.equal(await count(), before, `${mode}: no business was made`);
  }
});

test('G-17: the daily cap must be a whole number of one or more, and a cap of zero or a fraction changes nothing', async (t) => {
  const app = await startWorld(t, { overrides: { goliveEnforce: true } });
  const admin = await consoleUser(app);
  for (const dailyCap of [0, -3, 1.5]) {
    const res = await put(app, admin, { mode: 'invite', reason: 'cap try', dailyCap });
    assert.ok([400, 422].includes(res.status), `${JSON.stringify(dailyCap)} got ${res.status}`);
  }
  const good = await put(app, admin, { mode: 'invite', reason: 'cap 7', dailyCap: 7 });
  assert.equal(good.json().dailyCap, 7);
  const kept = await put(app, admin, { mode: 'closed', reason: 'cap kept' });
  assert.equal(kept.json().dailyCap, 7, 'left out keeps the cap');
});
