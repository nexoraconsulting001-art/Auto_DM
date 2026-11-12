// "My app" in the console and the owner app (PRD 10.7 to 10.14): the rules both carry (console/src/features/app-publishing/rules.js and its copy
// in the owner app) must say what the server says, name the field in every message, and never ask for a store password.
import '../../../tools/net-guard.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as server from '../../../src/contracts/apps.js';
import { AppConfigUpdate, PushCampaignSend, StoreAccessUpdate, StoreListingUpdate } from '../../../src/contracts/api/apps.js';
import * as rules from '../../../console/src/features/app-publishing/rules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const CONSOLE_DIR = 'console/src/features/app-publishing';
const OWNER_DIR = 'apps/owner/src/features/app-publishing';

const FINGERPRINT = Array.from({ length: 32 }, (_, i) => ((i * 7 + 16) % 256).toString(16).toUpperCase().padStart(2, '0')).join(':');
const PEM = `-----BEGIN PRIVATE KEY-----\n${'MIGTAgEAMBMGByqGSM49AgEG'.repeat(6)}\n-----END PRIVATE KEY-----`; // secret-scan:allow

test('the console and the owner app carry the same rules file', () => {
  assert.equal(read(`${OWNER_DIR}/rules.js`), read(`${CONSOLE_DIR}/rules.js`));
});

test('store limits, labels and required fields are the server’s (P-48)', () => {
  assert.deepEqual(rules.LISTING_LIMITS.android, server.listingLimits('android'));
  assert.deepEqual(rules.LISTING_LIMITS.ios, server.listingLimits('ios'));
  assert.deepEqual(rules.PUSH_LIMITS.titleMax, server.SHOPPER_PUSH_RULES.titleMax);
  assert.deepEqual(rules.PUSH_LIMITS.bodyMax, server.SHOPPER_PUSH_RULES.bodyMax);
  assert.equal(rules.PUSH_LIMITS.weeklyCap, server.SHOPPER_PUSH_RULES.weeklyCap);
  assert.deepEqual(rules.PLATFORM_FEATURES, { android: server.APP_ENTITLEMENTS.android, ios: server.APP_ENTITLEMENTS.ios });
  assert.equal(rules.CLOSED_TEST.testers, 12);
  assert.equal(rules.CLOSED_TEST.days, 14);
});

test('a listing is judged the way the server judges it, field by field, with its message', () => {
  const samples = [
    ['android', { title: 'A'.repeat(31), shortDescription: '', fullDescription: 'ok', whatsNew: 'x'.repeat(501) }],
    ['android', { title: 'Kesar', shortDescription: 'x'.repeat(92), fullDescription: 'Spices', whatsNew: '' }],
    ['android', { title: 'Bhava shop', shortDescription: 'a', fullDescription: 'b' }],
    ['ios', { title: 'Kesar Kitchen', shortDescription: 'x'.repeat(31), fullDescription: '', keywords: 'k'.repeat(101) }],
    ['ios', { title: 'Kesar', shortDescription: 'Spices', fullDescription: 'Fresh', keywords: 'spice,tea', whatsNew: 'Hello' }],
    ['ios', { title: 'नमस्ते'.repeat(5), fullDescription: 'x' }],
  ];
  for (const [platform, listing] of samples) {
    const ours = rules.listingProblems(platform, listing);
    const theirs = Object.fromEntries(server.listingProblems(platform, listing).map((p) => [p.field, p.message]));
    assert.deepEqual(ours, theirs, `${platform} ${JSON.stringify(listing)}`);
  }
  const field = rules.listingField('android', 'shortDescription', 'x'.repeat(92));
  assert.equal(field.over, true);
  assert.equal(field.left, -12);
  assert.equal(field.problem, 'Short description is 92 characters. Google Play allows 80.');
  assert.equal(rules.listingField('ios', 'shortDescription', 'x'.repeat(31)).problem, 'Subtitle is 31 characters. The App Store allows 30.');
  assert.equal(rules.listingField('ios', 'title', 'x'.repeat(10)).left, 20, 'characters left show as you type');
});

test('a listing body passes the server’s schema and only carries this store’s fields', () => {
  const ok = rules.formToListing('ios', { title: 'Kesar', shortDescription: 'Spices', fullDescription: 'Fresh', keywords: 'tea', whatsNew: 'Hi' });
  assert.ok(ok.body);
  assert.deepEqual(Object.keys(ok.body).sort(), ['fullDescription', 'keywords', 'shortDescription', 'title', 'whatsNew']);
  assert.ok(StoreListingUpdate.safeParse(ok.body).success);
  const play = rules.formToListing('android', { title: 'Kesar', shortDescription: 'Spices', fullDescription: 'Fresh', keywords: 'ignored' });
  assert.equal('keywords' in play.body, false);
  const bad = rules.formToListing('android', { title: '', shortDescription: '', fullDescription: '' });
  assert.equal(bad.body, null);
  assert.deepEqual(Object.keys(bad.errors).sort(), ['fullDescription', 'shortDescription', 'title']);
});

test('P-33: every app field’s message names the field, and what passes our check passes the server’s', () => {
  const bad = {
    appName: 'N'.repeat(31), shortName: 'S'.repeat(13), shopDomain: 'https://shop.kesar.in', supportEmail: 'not-an-email', privacyUrl: 'http://kesar.in/privacy',
    urlScheme: 'Kesar!', androidPackage: 'Kesar', playAccountId: 'abc', playSigningSha256: 'AA:BB', iosBundleId: '9bad', appleTeamId: 'abc', splashBackground: 'green',
  };
  for (const [name, value] of Object.entries(bad)) {
    const message = rules.appFieldProblem(name, value);
    assert.ok(message, `${name} should be refused`);
    assert.ok(message.includes(rules.APP_FIELDS[name].label), `${name}: "${message}" does not name the field`);
    const partial = AppConfigUpdate.safeParse({ [name]: name === 'playSigningSha256' ? rules.fingerprintLines(value) : value });
    assert.equal(partial.success, false, `${name} = ${value} passes the server's schema but not ours`);
  }
  const good = {
    appName: 'Kesar Kitchen', shortName: 'Kesar', shopDomain: 'shop.kesar.in', supportEmail: 'hello@kesar.in', privacyUrl: 'https://kesar.in/privacy', urlScheme: 'kesar',
    androidPackage: 'in.kesar.shop', playAccountId: '1234567890', playSigningSha256: FINGERPRINT, iosBundleId: 'in.kesar.shop', appleTeamId: 'ABCDE12345', splashBackground: '#234D33',
  };
  for (const [name, value] of Object.entries(good)) assert.equal(rules.appFieldProblem(name, value), '', name);
  const update = rules.formToUpdate(good, {});
  assert.deepEqual(update.errors, {});
  assert.ok(AppConfigUpdate.safeParse(update.body).success, JSON.stringify(AppConfigUpdate.safeParse(update.body).error?.issues));
  assert.deepEqual(update.body.playSigningSha256, [FINGERPRINT]);
  assert.match(rules.appFieldProblem('appName', 'Bhava Foods'), /App name/, 'the platform’s name is refused, naming the field');
});

test('a save sends only what changed, and empties a nullable field as null', () => {
  const config = { appName: 'Kesar', shortName: 'Kesar', androidPackage: 'in.kesar.shop', iosBundleId: null, urlScheme: 'kesar', playSigningSha256: [FINGERPRINT], supportEmail: '', privacyUrl: '', shopDomain: '', appleTeamId: '', playAccountId: '', splashBackground: '' };
  const form = rules.configToForm(config);
  assert.deepEqual(rules.formToUpdate(form, config).body, {});
  assert.deepEqual(rules.formToUpdate({ ...form, appName: 'Kesar Kitchen', androidPackage: '' }, config).body, { appName: 'Kesar Kitchen', androidPackage: null });
  assert.deepEqual(rules.formToUpdate({ ...form, shopDomain: 'Shop.Kesar.In' }, config).body, { shopDomain: 'shop.kesar.in' });
  const oversize = rules.formToUpdate({ ...form, appName: 'x'.repeat(40) }, config);
  assert.deepEqual(Object.keys(oversize.errors), ['appName']);
  assert.deepEqual(oversize.body, {});
});

test('P-59: an offer is judged the way the server judges it, with the cap and lengths shown', () => {
  const samples = [
    { title: 'Diwali sale', body: 'Flat 20% off sweets', linkPath: '/c/sale' },
    { title: '', body: 'x' },
    { title: 'x'.repeat(66), body: 'ok' },
    { title: 'Hi', body: 'y'.repeat(179) },
    { title: 'Call 9876543210', body: 'now' },
    { title: 'Mail', body: 'write to a@b.com' },
    { title: 'Sale', body: 'to 400001 only' },
    { title: 'Bhava sale', body: 'now' },
    { title: 'Sale', body: 'ok', linkPath: '/admin' },
    { title: 'Sale', body: 'ok', linkPath: 'sale' },
    { title: 'Sale', body: 'ok', linkPath: '/checkout' },
  ];
  for (const sample of samples) {
    const ours = rules.offerProblems(sample);
    const link = (sample.linkPath ?? '/').trim() || '/';
    const reason = server.shopperPushProblem({ title: sample.title, body: sample.body, data: { link } });
    assert.equal(Object.keys(ours).length > 0, reason !== null, `${JSON.stringify(sample)}: ours ${JSON.stringify(ours)} server ${reason}`);
  }
  assert.equal(rules.offerProblems({ title: 'x'.repeat(66), body: 'ok' }).title, 'Title is 66 characters. The most is 65.');
  assert.match(rules.offerProblems({ title: 'Call 9876543210', body: 'now' }).title, /phone number/);
  assert.ok(PushCampaignSend.safeParse({ title: 'Diwali sale', body: 'Flat 20% off', linkPath: '/c/sale', requestKey: rules.newRequestKey() }).success, 'the request key is one the server accepts');
  assert.notEqual(rules.newRequestKey(), rules.newRequestKey());
});

test('P-56: a rejection’s playbook has plain advice, and every playbook the server has is covered', () => {
  for (const code of Object.keys(server.PLAYBOOKS)) assert.ok(rules.PLAYBOOK_ADVICE[code], `no advice for playbook ${code}`);
  for (const code of Object.keys(rules.PLAYBOOK_ADVICE)) assert.ok(server.PLAYBOOKS[code], `advice for a playbook the server lacks: ${code}`);
  assert.equal(rules.adviceFor('nope'), rules.PLAYBOOK_ADVICE.unknown);
  assert.deepEqual(Object.keys(rules.SUBMISSION_STATE).sort(), [...server.SUBMISSION_STATES].sort());
  assert.deepEqual(Object.keys(rules.BUILD_STATUS).sort(), [...server.BUILD_STATUSES].sort());
  assert.deepEqual(Object.keys(rules.BUILD_STEP_LABELS).sort(), [...server.BUILD_STEPS].sort());
});

test('the link rules are the server’s', () => {
  for (const p of ['/', '/shop', '/c/sale', '/p/12', '/track/abc', '/admin', '/checkout', '/api/x', '//evil', '/a/../b', 'sale', '/c/', '/lead', '/c/a b']) {
    assert.equal(rules.isAppLinkPath(p), server.isAppLinkPath(p), p);
  }
});

test('P-40: nothing asks for a store password; a key box refuses one, and a body with one is refused by the server', () => {
  const asc = rules.ascKeyProblems({ keyId: 'ABCDE12345', issuerId: '57246542-96fe-1a63-e053-0824d011072a', privateKey: 'password: hunter2' });
  assert.equal(asc.body, null);
  assert.match(asc.errors.privateKey, /Private key/);
  assert.match(asc.errors.privateKey, /never ask for your Apple password/);
  const ok = rules.ascKeyProblems({ keyId: 'ABCDE12345', issuerId: '57246542-96FE-1A63-E053-0824D011072A', privateKey: PEM });
  assert.ok(ok.body);
  assert.equal(ok.body.issuerId, '57246542-96fe-1a63-e053-0824d011072a');
  assert.ok(StoreAccessUpdate.safeParse({ ascKey: ok.body }).success, 'the key body passes the server’s schema');
  for (const field of ['password', 'passcode', 'appleId', 'applePassword', 'googlePassword', 'googleEmail']) {
    assert.equal(StoreAccessUpdate.safeParse({ [field]: 'x' }).success, false, `${field} must be refused by the server`);
  }
  // No page has a box for one.
  const sources = [
    ...fs.readdirSync(path.join(ROOT, CONSOLE_DIR)).filter((f) => /\.(jsx|js)$/.test(f)).map((f) => `${CONSOLE_DIR}/${f}`),
    ...fs.readdirSync(path.join(ROOT, OWNER_DIR)).filter((f) => /\.js$/.test(f)).map((f) => `${OWNER_DIR}/${f}`),
  ];
  for (const file of sources) {
    const text = read(file);
    assert.doesNotMatch(text, /type=["']password["']/, `${file} has a password input`);
    assert.doesNotMatch(text, /name=["'](?:password|passcode|apple-?id|apple-?password|google-?password)["']/i, `${file} asks for a store sign-in`);
    assert.doesNotMatch(text, /label=["'][^"']*(?:Apple ID|Apple password|Google password|passcode)[^"']*["']/i, `${file} labels a field as a store sign-in`);
  }
});

test('P-60: pasted push credentials are checked without being shown back, and pass the server’s schema', () => {
  const account = JSON.stringify({ type: 'service_account', project_id: 'kesar-app', client_email: 'push@kesar-app.iam.example.com', private_key: PEM });
  assert.equal(rules.fcmProblem(account), '');
  assert.match(rules.fcmProblem(''), /Firebase service account is needed/);
  assert.match(rules.fcmProblem('{nope'), /not valid JSON/);
  assert.match(rules.fcmProblem('{"type":"user"}'), /service account key file/);
  assert.ok(!rules.fcmProblem('{"type":"user","private_key":"SECRET-VALUE"}').includes('SECRET-VALUE'), 'a problem never echoes what was pasted');
  const apns = rules.apnsProblems({ keyId: 'ABCDE12345', teamId: 'ZYXWV98765', key: PEM, env: 'sandbox' });
  assert.ok(apns.body);
  assert.deepEqual(Object.keys(apns.body).sort(), ['env', 'key', 'keyId', 'teamId']);
  assert.equal(rules.apnsProblems({ keyId: 'short', teamId: '', key: 'x' }).body, null);
  assert.deepEqual(Object.keys(rules.apnsProblems({ keyId: 'short', teamId: '', key: 'x' }).errors).sort(), ['key', 'keyId', 'teamId']);
  assert.ok(!JSON.stringify(rules.apnsProblems({ keyId: 'ABCDE12345', teamId: 'ZYXWV98765', key: 'oops' }).errors).includes('oops'));
});

test('a .p8 key pasted on one line gets its line breaks back', () => {
  const flat = `-----BEGIN PRIVATE KEY-----${'A'.repeat(150)}-----END PRIVATE KEY-----`; // secret-scan:allow
  const lines = rules.normalisePem(flat).split('\n');
  assert.equal(lines[0], '-----BEGIN PRIVATE KEY-----'); // secret-scan:allow
  assert.equal(lines.at(-1), '-----END PRIVATE KEY-----');
  assert.ok(lines.slice(1, -1).every((l) => l.length <= 64));
  assert.equal(rules.normalisePem(rules.normalisePem(flat)), rules.normalisePem(flat), 'normalising twice changes nothing');
});

test('the plan refusal is recognised the way the server sends it', () => {
  assert.equal(rules.isPlanRefusal({ status: 403, reason: 'plan.not_included' }), true);
  assert.equal(rules.isPlanRefusal({ status: 403, reason: 'plan' }), true);
  assert.equal(rules.isPlanRefusal({ status: 403, reason: 'role' }), false);
  assert.equal(rules.isPlanRefusal({ status: 500, reason: 'plan' }), false);
});

test('the owner app has a line in English and Hindi for every string its screens use', () => {
  const index = read(`${OWNER_DIR}/index.js`);
  const screens = read(`${OWNER_DIR}/screens.js`);
  const block = (lang) => {
    const start = index.indexOf(`    ${lang}: {`);
    const end = index.indexOf('\n    },', start);
    return new Set([...index.slice(start, end).matchAll(/'(app-publishing\.[\w.]+)':/g)].map((m) => m[1]));
  };
  const en = block('en');
  const hi = block('hi');
  assert.deepEqual([...en].filter((k) => !hi.has(k)), [], 'in English, not in Hindi');
  assert.deepEqual([...hi].filter((k) => !en.has(k)), [], 'in Hindi, not in English');
  const used = new Set([...screens.matchAll(/['`](app-publishing\.[\w.]+)['`]/g)].map((m) => m[1]));
  for (const tab of ['index', 'stores', 'listing', 'review', 'offers', 'keys']) used.add(`app-publishing.tab.${tab}`);
  used.delete('app-publishing.tab.');
  assert.deepEqual([...used].filter((k) => !en.has(k)), [], 'used by a screen, not written');
  // The console must never put the other copy's words in front of a buyer: nothing here is buyer-facing, but a listing must not name the platform.
  assert.equal(rules.namesPlatform('Bhava'), true);
});

test('npm run parity stays green: every route and console page of this area has an owner-app screen', () => {
  const run = spawnSync(process.execPath, [path.join(ROOT, 'tools/parity-check.mjs'), '--root', ROOT], { encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`.slice(-1500));
  const pages = read(`${CONSOLE_DIR}/index.jsx`);
  for (const route of [...pages.matchAll(/path: '([^']+)'/g)].map((m) => `console:/${m[1]}`)) {
    assert.ok(read(`${OWNER_DIR}/index.js`).includes(`'${route}'`), `${route} is not in the owner app’s routeIds`);
  }
});
