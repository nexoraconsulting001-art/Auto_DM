// The go-live checklist itself (G-15, G-16): settings, sign-offs and live probes, driven through createGolive with a
// chosen configuration and local servers standing in for the providers. Nothing here reaches a real service.
import '../../../tools/net-guard.mjs';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { GOLIVE_DETAILS, GOLIVE_ITEMS, GOLIVE_PROBES, GoliveStatus, META_PERMISSIONS, blockingOpen, goliveExitCode } from '../../../src/contracts/golive.js';
import { createWhatsApp } from '../../../src/adapters/whatsapp/index.js';
import { DETAIL, createGolive, readAttestations, settingProblem } from '../../../src/modules/golive/index.js';
import { platformTemplates } from '../../../src/modules/golive/probes.js';
import { formatMarkdown, formatText } from '../../../tools/golive/report.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-kit-'));
const closers = [];
after(async () => {
  for (const close of closers.reverse()) await close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const GOOD = {
  igAppId: '1784201234567', appSecret: 'real-app-secret-9f8e7d6c', verifyToken: 'real-verify-token-5a4b3c2d',
  razorpayKeyId: 'rzp_live_AbCdEf123456', razorpayKeySecret: 'rzp-live-secret-aa11bb22', razorpayWebhookSecret: 'rzp-hook-secret-cc33dd44',
  razorpayPartnerClientId: 'partner-client-ee55ff66', razorpayPartnerClientSecret: 'partner-secret-gg77hh88',
  publicBaseUrl: 'https://app.bhava.in', platformDomain: 'bhava.in', platformHost: 'bhava.in',
};
const SECRET_VALUES = Object.values(GOOD).filter((v) => !/^https:|^bhava\.in$/.test(v));

let fileSerial = 0;
function attestFile(entries, raw) {
  const file = path.join(dir, `attest-${++fileSerial}.json`);
  fs.writeFileSync(file, raw ?? JSON.stringify({ version: 1, entries }));
  return file;
}
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const entry = (id, over = {}) => ({ id, signedOffBy: 'Meera Rao', role: 'Counsel', date: daysAgo(5), reference: 'legal-folder-7', ...over });
const ATTESTED = GOLIVE_ITEMS.filter((i) => i.check.kind === 'attestation').map((i) => i.id);

/** A checklist on `config` with no environment of the machine leaking in. */
const checklist = (config = {}, options = {}) => createGolive({ config: { goliveAttestations: attestFile([]), ...config } }, { env: {}, timeoutMs: 600, ...options });
const itemOf = (status, id) => status.items.find((i) => i.id === id);

/** A local server playing one provider. `routes` maps "METHOD /path" to (req, body) => [status, json] | 'hang'. */
async function provider(routes) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization ?? '' });
      const route = routes[`${req.method} ${url.pathname}`];
      const answer = route ? route(req, raw, url) : [404, { error: { message: 'no route' } }];
      if (answer === 'hang') return;
      res.writeHead(answer[0], { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer[1]));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { base: `http://127.0.0.1:${server.address().port}`, calls };
}

test('G-15: every item is reported once with its owner, phase, blocking and kind, and the status parses', async () => {
  const status = await checklist().status();
  GoliveStatus.parse(status);
  assert.deepEqual(status.items.map((i) => i.id), GOLIVE_ITEMS.map((i) => i.id));
  for (const item of status.items) {
    const spec = GOLIVE_ITEMS.find((i) => i.id === item.id);
    assert.deepEqual([item.owner, item.phase, item.blocks, item.kind], [spec.owner, spec.phase, spec.blocks, spec.check.kind]);
  }
  assert.equal(status.ready, false);
  assert.equal(status.blockingMissing, blockingOpen(status.items).length);
  assert.equal(goliveExitCode(status), 1);
  for (const name of GOLIVE_PROBES) assert.ok(GOLIVE_ITEMS.some((i) => i.check.probe === name) || name === 'meta.permission_access', name);
});

test('G-16: a setting with a real-looking value is ready; a test value in any form, a placeholder or a blank is not, and the value never shows', async () => {
  const clean = await checklist(GOOD).status();
  assert.equal(itemOf(clean, 'meta.app_settings').state, 'ready');
  assert.equal(itemOf(clean, 'razorpay.settings').state, 'ready');
  const bad = ['http://127.0.0.1:9101', 'https://graph.test/v1', 'https://10.0.0.4', 'rzp_test_AbCdEf123456', 'RZP_TEST_AbCdEf123456', '  changeme  ', 'sim-secret', 'app-sim', 'https://api.example.com', 'placeholder', 'TODO', 'xxxx', 'dummy', '', '   ', 'my_test_key'];
  for (const [item, keys] of [['meta.app_settings', ['igAppId', 'appSecret', 'verifyToken']], ['razorpay.settings', ['razorpayKeyId', 'razorpayKeySecret', 'razorpayWebhookSecret', 'razorpayPartnerClientId', 'razorpayPartnerClientSecret']]]) {
    for (const key of keys) {
      for (const value of bad) {
        const status = await checklist({ ...GOOD, [key]: value }).status();
        const got = itemOf(status, item);
        assert.notEqual(got.state, 'ready', `${item}: ${key}=${JSON.stringify(value)}`);
        if (value.trim().length > 6) assert.equal(JSON.stringify(status).includes(value.trim()), false, `${key}: the value is in the answer`);
      }
    }
  }
  // A Razorpay key id that is not a live one, and a Meta app id that is not a number, are test values too.
  assert.equal(itemOf(await checklist({ ...GOOD, razorpayKeyId: 'rzp_AbCdEf123456' }).status(), 'razorpay.settings').detail, `${GOLIVE_DETAILS.testValue} RAZORPAY_KEY_ID`);
  assert.equal(itemOf(await checklist({ ...GOOD, igAppId: 'sim-app' }).status(), 'meta.app_settings').state, 'missing');
  assert.equal(itemOf(await checklist({ ...GOOD, appSecret: '' }).status(), 'meta.app_settings').detail, `${GOLIVE_DETAILS.notSet} APP_SECRET`);
  for (const [name, value, want] of [['APP_SECRET', 'http://localhost:3000', 'simulator'], ['APP_SECRET', 'sk_test_123', 'testValue'], ['IG_APP_ID', '1784201234567', ''], ['RAZORPAY_KEY_ID', 'rzp_live_ZZ1234567', '']]) assert.equal(settingProblem(name, value), want, `${name}=${value}`);
});

test('G-15: no secret reaches the status, the text or the Markdown, whatever the settings hold', async () => {
  const markers = {};
  for (const key of ['appSecret', 'verifyToken', 'razorpayKeySecret', 'razorpayWebhookSecret', 'shiprocketPassword', 'platformWhatsappToken', 'aiApiKey', 'expoToken', 'dataKey', 'sessionSecret', 'metricsToken']) markers[key] = `MARKER-${key}-k2j4h6`;
  const status = await checklist({ ...GOOD, ...markers }).status();
  const outputs = [JSON.stringify(status), formatText(status), formatMarkdown(status)];
  for (const text of outputs) for (const value of [...Object.values(markers), ...SECRET_VALUES]) assert.equal(text.includes(value), false, value);
});

test('G-15: a sign-off counts with a name, a role and a real date; every other edit of the file is not ready', async () => {
  const all = await checklist({ goliveAttestations: attestFile(ATTESTED.map((id) => entry(id))) }).status();
  for (const id of ATTESTED) assert.equal(itemOf(all, id).state, 'ready', id);
  assert.equal(JSON.stringify(all).includes('Meera Rao'), false, 'the name stays in the file');
  assert.equal(JSON.stringify(all).includes('legal-folder-7'), false);

  const variants = {
    noName: { signedOffBy: undefined }, blankName: { signedOffBy: '  ' }, oneLetter: { signedOffBy: 'M' }, noDate: { date: undefined }, blankDate: { date: '' },
    words: { date: 'last week' }, impossible: { date: '2027-13-45' }, feb30: { date: '2026-02-30' }, future: { date: daysAgo(-30) }, noRole: { role: '' }, extra: { approvedBy: 'x' }, slashes: { date: '2026/11/01' },
  };
  for (const [name, over] of Object.entries(variants)) {
    const status = await checklist({ goliveAttestations: attestFile([entry('legal.pages', over)]) }).status();
    assert.notEqual(itemOf(status, 'legal.pages').state, 'ready', name);
    assert.equal(itemOf(status, 'legal.pages').detail, DETAIL.signOffBadEntry, name);
  }
  // A bad entry does not spoil a good one beside it.
  const mixed = await checklist({ goliveAttestations: attestFile([entry('legal.pages', { date: 'soon' }), entry('legal.dpdp')]) }).status();
  assert.deepEqual([itemOf(mixed, 'legal.pages').state, itemOf(mixed, 'legal.dpdp').state], ['missing', 'ready']);
  // An entry for an item that is not signed off counts for nothing, and moves nothing.
  const wrong = await checklist({ goliveAttestations: attestFile([entry('meta.app_live'), entry('hosting.tls'), entry('made.up')]) }).status();
  for (const id of ['meta.app_live', 'hosting.tls']) assert.notEqual(itemOf(wrong, id).state, 'ready', id);
  // Too old: the item's own limit.
  const old = await checklist({ goliveAttestations: attestFile([entry('legal.pages', { date: daysAgo(366) }), entry('showcase.signoff', { date: daysAgo(181) }), entry('legal.trademark', { date: daysAgo(700) })]) }).status();
  assert.deepEqual(['legal.pages', 'showcase.signoff', 'legal.trademark'].map((id) => itemOf(old, id).state), ['missing', 'missing', 'ready']);
  assert.equal(itemOf(old, 'legal.pages').detail, GOLIVE_DETAILS.signOffExpired);
  // The newest of two entries for one item is the one that counts.
  const twice = await checklist({ goliveAttestations: attestFile([entry('legal.pages', { date: daysAgo(400) }), entry('legal.pages', { date: daysAgo(3) })]) }).status();
  assert.equal(itemOf(twice, 'legal.pages').state, 'ready');
});

test('G-15: a sign-off file that is not JSON, of another shape or missing signs nothing off and its text goes nowhere', async () => {
  for (const raw of ['{ not json "SECRET-in-file"', '', '[]', 'null', JSON.stringify({ version: 2, entries: [entry('legal.pages')] }), JSON.stringify({ version: 1 }), JSON.stringify({ version: 1, entries: [entry('legal.pages')], note: 'x' })]) {
    const status = await checklist({ goliveAttestations: attestFile([], raw) }).status();
    assert.equal(itemOf(status, 'legal.pages').state, 'missing', raw.slice(0, 30));
    assert.equal(itemOf(status, 'legal.pages').detail, DETAIL.signOffInvalid);
    assert.equal(formatText(status).includes('SECRET-in-file'), false);
  }
  const gone = await checklist({ goliveAttestations: path.join(dir, 'nowhere.json') }).status();
  assert.equal(itemOf(gone, 'legal.pages').state, 'missing');
  assert.equal(readAttestations(path.join(dir, 'nowhere.json')).fileProblem, 'unreadable');
});

test('G-16: without live checks no probe is asked and none is ready; a simulator setting makes the probe missing before anything is asked', async () => {
  const offline = await checklist(GOOD).status();
  for (const item of offline.items.filter((i) => i.kind === 'probe')) assert.notEqual(item.state, 'ready', item.id);
  assert.equal(itemOf(offline, 'meta.app_live').state, 'unknown');
  assert.equal(itemOf(offline, 'meta.app_live').detail, DETAIL.notChecked);

  const meta = await provider({ 'GET /v23.0/1784201234567': () => [200, { id: '1784201234567', app_mode: 'live' }] });
  for (const sim of ['graphBaseUrl', 'fbGraphBaseUrl', 'igApiBaseUrl']) {
    const status = await checklist({ ...GOOD, [sim]: meta.base }, { bases: { facebookGraph: meta.base } }).status({ live: true });
    for (const id of ['meta.app_live', 'meta.webhooks', 'meta.instagram_access', 'meta.business_verification']) {
      assert.equal(itemOf(status, id).state, 'missing', `${id} with ${sim}`);
      assert.match(itemOf(status, id).detail, /simulator/);
    }
  }
  assert.equal(meta.calls.length, 0, 'nothing was asked while a simulator was configured');
});

test('G-16: the Meta app is ready only when it says Live; Development, an error, a non-answer or a hang are not, and a hang is "not checked"', async () => {
  const mk = (answer) => provider({ 'GET /v23.0/1784201234567': answer });
  const cases = {
    live: [await mk(() => [200, { id: '1', app_mode: 'live' }]), 'ready'],
    development: [await mk(() => [200, { id: '1', app_mode: 'development' }]), 'missing'],
    devFlag: [await mk(() => [200, { id: '1', app_mode: 'live', development_mode: true }]), 'missing'],
    silent: [await mk(() => [200, { id: '1' }]), 'unknown'],
    error: [await mk(() => [500, { error: { message: `boom ${GOOD.appSecret}` } }]), 'unknown'],
    hang: [await mk(() => 'hang'), 'unknown'],
  };
  for (const [name, [server, want]] of Object.entries(cases)) {
    const started = Date.now();
    const status = await checklist(GOOD, { bases: { facebookGraph: server.base } }).status({ live: true });
    const item = itemOf(status, 'meta.app_live');
    assert.equal(item.state, want, name);
    assert.ok(Date.now() - started < 5000, `${name} did not hold the list`);
    if (name === 'development') assert.equal(item.detail, GOLIVE_DETAILS.developmentMode);
    if (name === 'hang') assert.equal(item.detail, GOLIVE_DETAILS.unreachable);
    assert.equal(JSON.stringify(status).includes(GOOD.appSecret), false, name);
    assert.ok(server.calls.every((c) => c.auth === `Bearer ${GOOD.igAppId}|${GOOD.appSecret}`), 'the app token goes in the header, not the address');
    assert.ok(server.calls.every((c) => !JSON.stringify(c.query).includes(GOOD.appSecret)));
  }
});

test('G-16: a permission missing or on Standard Access is "Standard Access only"; every one on Advanced is ready', async () => {
  const all = [...META_PERMISSIONS.instagram, ...META_PERMISSIONS.facebook].map((permission) => ({ permission, status: 'live', access_level: 'advanced' }));
  const answers = {
    advanced: [all, 'ready', 'ready'],
    oneStandard: [all.map((p) => (p.permission === 'instagram_business_manage_messages' ? { ...p, access_level: 'standard' } : p)), 'missing', 'ready'],
    oneMissing: [all.filter((p) => p.permission !== 'pages_messaging'), 'ready', 'missing'],
    declined: [all.map((p) => (p.permission === 'instagram_business_basic' ? { ...p, status: 'declined' } : p)), 'missing', 'ready'],
    none: [[], 'missing', 'missing'],
  };
  for (const [name, [data, ig, fb]] of Object.entries(answers)) {
    const meta = await provider({ 'GET /v23.0/1784201234567/permissions': () => [200, { data }] });
    const status = await checklist(GOOD, { bases: { facebookGraph: meta.base } }).status({ live: true });
    assert.deepEqual([itemOf(status, 'meta.instagram_access').state, itemOf(status, 'meta.facebook_access').state], [ig, fb], name);
    if (ig === 'missing') assert.equal(itemOf(status, 'meta.instagram_access').detail, GOLIVE_DETAILS.standardAccess);
  }
});

test('G-16: the webhook subscription must be active, at the platform address, with every field the code handles', async () => {
  const sub = (over = {}) => ({ object: 'instagram', active: true, callback_url: 'https://app.bhava.in/webhook', fields: ['comments', 'mentions', 'messages', 'messaging_postbacks'].map((name) => ({ name })), ...over });
  const cases = {
    good: [[sub()], 'ready'], inactive: [[sub({ active: false })], 'missing'], otherHost: [[sub({ callback_url: 'https://evil.example.net/webhook' })], 'missing'],
    http: [[sub({ callback_url: 'http://app.bhava.in/webhook' })], 'missing'], fewerFields: [[sub({ fields: [{ name: 'comments' }] })], 'missing'], pageOnly: [[sub({ object: 'page' })], 'missing'],
  };
  for (const [name, [data, want]] of Object.entries(cases)) {
    const meta = await provider({ 'GET /v23.0/1784201234567/subscriptions': () => [200, { data }] });
    const status = await checklist(GOOD, { bases: { facebookGraph: meta.base } }).status({ live: true });
    assert.equal(itemOf(status, 'meta.webhooks').state, want, name);
  }
});

test('G-16: Razorpay is ready on a live key that Route answers; a refused key and a key that is not live are not', async () => {
  const rzp = await provider({
    'GET /v1/transfers': (req) => (req.headers.authorization === `Basic ${Buffer.from(`${GOOD.razorpayKeyId}:${GOOD.razorpayKeySecret}`).toString('base64')}` ? [200, { entity: 'collection', count: 0, items: [] }] : [401, { error: { code: 'BAD_REQUEST_ERROR', description: `bad key ${req.headers.authorization}` } }]),
  });
  const ready = await checklist(GOOD, { bases: { razorpay: rzp.base } }).status({ live: true });
  assert.equal(itemOf(ready, 'razorpay.route').state, 'ready');
  const refused = await checklist({ ...GOOD, razorpayKeySecret: 'another-live-secret-77' }, { bases: { razorpay: rzp.base } }).status({ live: true });
  assert.equal(itemOf(refused, 'razorpay.route').state, 'missing');
  assert.equal(itemOf(refused, 'razorpay.route').detail, DETAIL.refused);
  const testKey = await checklist({ ...GOOD, razorpayKeyId: 'rzp_test_AbCdEf123456' }, { bases: { razorpay: rzp.base } }).status({ live: true });
  assert.equal(itemOf(testKey, 'razorpay.route').state, 'missing');
  assert.equal(rzp.calls.length, 2, 'a test-mode key is never sent');
});

test('G-16: Bhava’s WhatsApp number and its templates are checked through the WhatsApp adapter', async () => {
  const names = platformTemplates();
  let approvedAll = true;
  const wa = await provider({
    'GET /v23.0/111222333': () => [200, { id: '111222333', verified_name: 'Bhava', display_phone_number: '+91 90000 00000', quality_rating: 'GREEN' }],
    'GET /v23.0/999888777/message_templates': () => [200, { data: names.map((name, i) => ({ id: String(i), name, language: 'en', category: 'UTILITY', status: approvedAll || i > 0 ? 'APPROVED' : 'PENDING' })) }],
  });
  const config = { ...GOOD, platformWhatsappPhoneId: '111222333', platformWhatsappToken: 'wa-live-token-0a9b8c', platformWhatsappWabaId: '999888777' };
  const whatsapp = createWhatsApp({ whatsappBaseUrl: wa.base });
  const status = await checklist(config, { world: { whatsapp } }).status({ live: true });
  assert.equal(itemOf(status, 'whatsapp.sender').state, 'ready');
  assert.equal(itemOf(status, 'whatsapp.templates').state, 'ready');
  approvedAll = false;
  const pending = await checklist(config, { world: { whatsapp } }).status({ live: true });
  assert.equal(itemOf(pending, 'whatsapp.templates').state, 'missing');
  assert.equal(itemOf(pending, 'whatsapp.templates').detail, DETAIL.notApproved);
  assert.ok(wa.calls.every((c) => c.method === 'GET'), 'the probe only reads');
});

test('G-16: the running configuration is ready only in production with no rule broken; DNS and TLS answers are judged, not trusted', async () => {
  const qa = await checklist(GOOD).status();
  assert.equal(itemOf(qa, 'hosting.guard').detail, GOLIVE_DETAILS.qaProfile);
  const prod = await checklist({ ...GOOD, deployEnv: 'production', storageDriver: 'local' }).status();
  assert.equal(itemOf(prod, 'hosting.guard').state, 'missing');
  assert.match(itemOf(prod, 'hosting.guard').detail, /STORAGE_DRIVER/);

  const dns = (addresses) => ({ lookupAll: async () => addresses });
  const tls = (days) => ({ certificateDays: async () => days });
  const run = (world) => checklist(GOOD, { world }).status({ live: true });
  assert.equal(itemOf(await run({ dns: dns(['203.0.113.7']) }), 'hosting.dns').state, 'ready');
  assert.equal(itemOf(await run({ dns: dns(['10.0.0.4']) }), 'hosting.dns').state, 'missing');
  assert.equal(itemOf(await run({ dns: dns([]) }), 'hosting.dns').state, 'missing');
  assert.equal(itemOf(await run({ dns: { lookupAll: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); } } }), 'hosting.dns').detail, DETAIL.doesNotResolve);
  assert.equal(itemOf(await run({ dns: { lookupAll: () => new Promise(() => {}) } }), 'hosting.dns').state, 'unknown', 'a lookup that hangs is not checked');
  assert.equal(itemOf(await run({ tls: tls(60) }), 'hosting.tls').state, 'ready');
  assert.equal(itemOf(await run({ tls: tls(10) }), 'hosting.tls').state, 'missing');
  assert.equal(itemOf(await run({ tls: tls(-1) }), 'hosting.tls').state, 'missing');
  assert.equal(itemOf(await run({ tls: tls(null) }), 'hosting.tls').state, 'unknown');
});

test('G-16: a probe that throws, answers nonsense or invents a phrase is reported as not checked or with a fixed phrase only', async () => {
  const probes = {
    'meta.app_mode': { settings: [], simulators: [], run: async () => { throw new Error(`boom ${GOOD.appSecret}`); } },
    'meta.tech_provider': { settings: [], simulators: [], run: async () => ({ state: 'ready-ish', detail: GOOD.appSecret }) },
    'meta.business_verification': { settings: [], simulators: [], run: async () => ({ state: 'missing', detail: `leak ${GOOD.appSecret}` }) },
  };
  const status = await checklist(GOOD, { probes }).status({ live: true });
  assert.deepEqual([itemOf(status, 'meta.app_live').state, itemOf(status, 'meta.tech_provider').state, itemOf(status, 'meta.business_verification').state], ['unknown', 'unknown', 'missing']);
  assert.equal(JSON.stringify(status).includes(GOOD.appSecret), false);
});

test('G-15, G-17: with every setting real, every probe ready and every sign-off on file the checklist is clear, exits 0 and the verdict opens sign-up', async () => {
  const everything = Object.fromEntries(Object.entries(GOLIVE_ITEMS.filter((i) => i.check.kind === 'probe').reduce((acc, i) => ({ ...acc, [i.check.probe]: true }), {})).map(([name]) => [name, { settings: [], simulators: [], local: true, run: async () => ({ state: 'ready', detail: 'ok' }) }]));
  const config = { ...GOOD, reviewLoginPhone: '919000000001', reviewLoginCodeHash: 'f'.repeat(64), whatsappAppId: '22334455667', whatsappSignupConfigId: '33445566778', whatsappAppSecret: 'wa-app-secret-5d6e7f', goliveAttestations: attestFile(ATTESTED.map((id) => entry(id))) };
  const golive = createGolive({ config }, { env: {}, probes: everything });
  const status = await golive.status({ live: true });
  assert.deepEqual(blockingOpen(status.items).map((i) => i.id), []);
  assert.equal(status.ready, true);
  assert.equal(goliveExitCode(status), 0);
  assert.deepEqual(await golive.signupVerdict(), { ok: true, missing: [] });
  assert.match(formatText(status), /Ready for go-live: no blocking item is open\./);
  // One blocking item back to missing closes it again, and names it.
  const standard = createGolive({ config }, { env: {}, probes: { ...everything, 'meta.permission_access': { settings: [], simulators: [], local: true, run: async (_p, args) => ({ state: args.group === 'instagram' ? 'missing' : 'ready', detail: 'standardAccess' }) } } });
  assert.deepEqual(await standard.signupVerdict(), { ok: false, missing: ['meta.instagram_access'] });
});

test('G-15: the text and the Markdown group items by who must act and the phase, with the next step for each open one', async () => {
  const status = await checklist(GOOD).status();
  const text = formatText(status);
  assert.match(text, /== Founder \(user\) · Phase 0: foundation ==/);
  assert.match(text, /== Bhava team \(us\) · Phase 3: store ==/);
  assert.match(text, /Next: Add an entry|Next: Have counsel/);
  assert.match(text, /Not ready for go-live: \d+ blocking items? open\./);
  const md = formatMarkdown(status, { owner: 'user' });
  assert.match(md, /^# Go-live checklist/);
  assert.match(md, /\| State \| Blocks \| Item \| What \| Detail \| Next step \|/);
  assert.equal(md.includes('`hosting.tls`'), false, 'the founder’s view leaves out the team’s items');
  assert.ok(md.includes('`legal.pages`'));
});
