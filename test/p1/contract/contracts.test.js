// What the Phase 1 tracks build against: the requirement list, the module folders, and the API contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError, AutomationInput, CommentValue, MessagingEvent, PROVIDER_PATHS, WebhookEntry, AutomationUpdate, ComplianceSettings, ComplianceSettingsUpdate, DomainParams, ErrorBody, FbPostParams, InboxReply, ReturnTo, platformRouteList, routeList } from '../../../src/contracts/api/index.js';
import { COMPLIANCE_LIMITS } from '../../../src/contracts/compliance.js';
import { matchesKeywords } from '../../../src/modules/automations/match.js';
import { fillTemplate } from '../../../src/modules/compliance/content.js';
import { MODULES } from '../../../src/modules/index.js';
import { OWNER, startApp } from '../../helpers.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const requirements = JSON.parse(fs.readFileSync(path.join(repoRoot, 'requirements/p1.json'), 'utf8'));

const signIn = async (base, who = OWNER) => (await (await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(who) })).json()).token;

test('requirements/p1.json lists every Phase 1 scenario, once, with a short title', () => {
  const count = (prefix) => requirements.filter((r) => r.id.startsWith(`${prefix}-`)).length;
  assert.deepEqual([count('C'), count('A'), count('FB')], [65, 63, 6]);
  assert.equal(new Set(requirements.map((r) => r.id)).size, requirements.length);
  for (const r of requirements) {
    assert.deepEqual(Object.keys(r), ['id', 'title']);
    assert.match(r.id, /^(C|A|FB)-\d{2}$/);
    assert.ok(r.title.length > 0 && r.title.length <= 80, r.id);
  }
  assert.deepEqual(requirements.filter((r) => /^A-(5[5-9]|6[0-6])$/.test(r.id)), [], 'AI replies and WhatsApp are not Phase 1');
});

test('each track has its module folder, listed in the registry', () => {
  const names = MODULES.map((m) => m.name);
  for (const name of ['ig-connect', 'compliance', 'automations', 'links', 'facebook', 'domains', 'ig-accounts', 'platform-console']) {
    assert.ok(names.includes(name), name);
    assert.ok(fs.existsSync(path.join(repoRoot, 'src/modules', name, 'index.js')), name);
  }
  assert.equal(new Set(names).size, names.length);
});

test('every Phase 1 route belongs to the module named for it', () => {
  const owner = { instagram: 'ig-connect', compliance: 'compliance', automations: 'automations', testers: 'automations', iceBreakers: 'automations', inbox: 'automations', links: 'links', measurementIds: 'links', facebook: 'facebook', domains: 'domains' };
  const answers = new Map(MODULES.flatMap((m) => Object.keys(m.api?.({ repos: {}, config: {}, ig: {}, auth: {} }) ?? {}).map((id) => [id, m.name])));
  const phase1 = routeList.filter((r) => owner[r.id.split('.')[0]]);
  assert.ok(phase1.length >= 50, `found ${phase1.length}`);
  for (const route of phase1) assert.equal(answers.get(route.id), owner[route.id.split('.')[0]], route.id);
});

test('every route with a path parameter names it :id, as the client and router expect', () => {
  for (const route of routeList) {
    const params = route.path.match(/:\w+/g) ?? [];
    assert.ok(params.length <= 1 && (params.length === 0 || params[0] === ':id'), `${route.id} ${route.path}`);
  }
});

test('no route offers sellers a raw export', () => {
  assert.deepEqual(routeList.filter((r) => /raw|export/i.test(`${r.id} ${r.path}`)).map((r) => r.id), []);
});

test('a seller sees no person\'s hash, and a staff member needs the right permission', () => {
  const activity = routeList.find((r) => r.id === 'compliance.activity');
  assert.equal('subject' in activity.response.shape.items.element.shape, false);
  assert.equal(routeList.find((r) => r.id === 'inbox.reply').access.permission, 'inbox');
  assert.equal(routeList.find((r) => r.id === 'automations.create').access.permission, 'automations');
  assert.deepEqual([...routeList.find((r) => r.id === 'domains.add').access.roles], ['owner']);
  assert.deepEqual([...routeList.find((r) => r.id === 'compliance.pause').access.roles], ['owner', 'manager']);
});

test('the Platform Console\'s routes are the same kind of thing, and none reaches the seller client', () => {
  const sellers = new Set(routeList.map((r) => r.id));
  const seen = new Set();
  for (const route of platformRouteList) {
    assert.match(route.id, /^platform\.[a-zA-Z]+$/);
    assert.ok(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method), route.id);
    assert.ok(route.platformRoles?.length, route.id);
    assert.ok(route.response === null || typeof route.response?.safeParse === 'function', route.id);
    if (route.path.includes(':')) assert.ok(route.params, route.id);
    assert.ok(!sellers.has(route.id), route.id);
    assert.ok(!seen.has(`${route.method} ${route.path}`), route.id);
    seen.add(`${route.method} ${route.path}`);
  }
  assert.deepEqual([...platformRouteList.find((r) => r.id === 'platform.rawExport').platformRoles], ['super_admin']);
});

test('an automation\'s input fills in safe defaults, and a PATCH fills in nothing', () => {
  const input = AutomationInput.parse({ name: 'First', triggerType: 'comment', variants: [{ label: 'A', body: 'Hi {first_name}' }] });
  assert.equal(input.linkMode, 'two_tap', 'two taps unless the owner chooses otherwise');
  assert.equal(input.publicReplyEnabled, false, 'public replies are off by default');
  assert.equal(input.matchMode, 'keywords');
  assert.deepEqual(AutomationUpdate.parse({}), {});
  assert.deepEqual(AutomationUpdate.parse({ keywords: ['price'] }), { keywords: ['price'] });
});

test('an automation\'s limits are the PRD\'s', () => {
  const base = { name: 'A', triggerType: 'comment', variants: [{ label: 'A', body: 'x' }] };
  assert.equal(AutomationInput.safeParse({ ...base, keywords: Array(COMPLIANCE_LIMITS.keywordsMax).fill('k') }).success, true);
  assert.equal(AutomationInput.safeParse({ ...base, keywords: Array(COMPLIANCE_LIMITS.keywordsMax + 1).fill('k') }).success, false);
  assert.equal(AutomationInput.safeParse({ ...base, variants: ['A', 'B', 'C', 'A'].map((label) => ({ label, body: 'x' })) }).success, false);
  assert.equal(AutomationInput.safeParse({ ...base, variants: [] }).success, false);
  assert.equal(AutomationInput.safeParse({ ...base, followupDelayMinutes: 29 }).success, false);
});

test('hostile input stops at the schema', () => {
  assert.equal(InboxReply.safeParse({ text: 'a\0b' }).success, false);
  assert.equal(ReturnTo.safeParse('//evil.example').success, false);
  assert.equal(ReturnTo.safeParse('https://evil.example').success, false);
  assert.equal(ReturnTo.safeParse('/admin/settings').success, true);
  assert.equal(DomainParams.safeParse({ id: '../../etc' }).success, false);
  assert.equal(FbPostParams.safeParse({ id: '1/../2' }).success, false);
  assert.equal(FbPostParams.safeParse({ id: '123_456' }).success, true);
});

test('a cap override names a real cap, and needn\'t name them all', () => {
  assert.equal(ComplianceSettingsUpdate.safeParse({ capOverrides: { 'cap.per_person_24h': 2 } }).success, true);
  assert.equal(ComplianceSettingsUpdate.safeParse({ capOverrides: { 'cap.made_up': 2 } }).success, false);
  assert.equal(ComplianceSettings.safeParse({ dryRun: false, disclosureEnabled: false, utmEnabled: true, capOverrides: {} }).success, true);
});

test('the shared keyword matcher treats whole words, matras, phrases and emoji as the PRD says', () => {
  assert.equal(matchesKeywords('PRICE?', ['price']), true);
  assert.equal(matchesKeywords('priceless', ['price']), false);
  assert.equal(matchesKeywords('भावों में', ['भाव']), false);
  assert.equal(matchesKeywords('Kitne   ka hai?', ['kitne ka']), true);
  assert.equal(matchesKeywords('इसका दाम', ['दाम'.normalize('NFD')]), true);
  assert.equal(matchesKeywords('🔥🔥 want', ['🔥']), true);
  assert.equal(matchesKeywords('anything', []), false);
  assert.equal(matchesKeywords('a.b', ['a?b']), false, 'a keyword is never a pattern');
});

test('a template fills its two variables and leaves everything else as written', () => {
  assert.equal(fillTemplate('Hi {first_name}, see {url}', { firstName: 'Asha', url: 'https://a.test' }), 'Hi Asha, see https://a.test');
  assert.equal(fillTemplate('Hi {first_name}!', {}), 'Hi !');
  assert.equal(fillTemplate('{username} {constructor} {__proto__}', { firstName: 'A' }), '{username} {constructor} {__proto__}');
});

test('the webhook shapes accept what the simulator sends, and keep unknown fields out', () => {
  const comment = CommentValue.parse({ id: 'c1', text: 'hi', from: { id: '1', username: 'a' }, media: { id: 'm', media_product_type: 'REELS' }, surprise: true });
  assert.equal('surprise' in comment, false);
  assert.equal(CommentValue.safeParse({ text: 'no id' }).success, false);
  assert.equal(WebhookEntry.safeParse({ id: 1784, changes: [{}] }).data.id, '1784');
  assert.equal(MessagingEvent.safeParse({ sender: { id: '1' }, recipient: { id: '2' }, timestamp: 1, message: { mid: 'm', reply_to: { story: { id: 's' } } } }).success, true);
  assert.equal(PROVIDER_PATHS.webhook, '/webhook');
});

test('an alert is raised for one business, once per key, and read only there', async () => {
  const app = await startApp();
  try {
    const other = await app.platform.tenants.create({ slug: 'beta-store', name: 'Beta' });
    const raise = () => app.repos.alerts.raise({ kind: 'token.rejected', message: 'Reconnect Instagram', severity: 'critical', dedupeKey: 'token:1' });
    assert.ok(await raise());
    assert.equal(await raise(), null);
    const token = await signIn(app.base);
    const list = await (await fetch(`${app.base}/api/v1/alerts`, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.deepEqual(list.items.map((a) => [a.kind, a.severity, a.readAt]), [['token.rejected', 'critical', null]]);
    const read = await fetch(`${app.base}/api/v1/alerts/${list.items[0].id}/read`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    assert.equal(read.status, 204);
    assert.ok((await app.repos.alerts.list()).items[0].readAt);
    const { withTenant } = await import('../../../src/tenancy.js');
    assert.deepEqual((await withTenant(other, () => app.platform.alerts.list())).items, []);
  } finally {
    app.close();
  }
});

test('a route not built yet answers 501 only to those allowed to call it', async () => {
  const app = await startApp();
  try {
    assert.equal((await fetch(`${app.base}/api/v1/automations`)).status, 401);
    const res = await fetch(`${app.base}/api/v1/automations`, { headers: { authorization: `Bearer ${await signIn(app.base)}` } });
    assert.equal(res.status, 501);
    assert.equal((await res.json()).code, 'not_implemented');
  } finally {
    app.close();
  }
});

test('a domain still waiting for its DNS check does not route to its business', async () => {
  const app = await startApp();
  try {
    await app.platform.tenants.addDomain(app.tenant.id, 'kesar.example');
    assert.equal((await app.platform.tenants.getByDomain('kesar.example'))?.id, app.tenant.id);
    await app.db.platform.query(`UPDATE tenant_domains SET status = 'pending' WHERE domain = 'kesar.example'`);
    assert.equal(await app.platform.tenants.getByDomain('kesar.example'), null);
  } finally {
    app.close();
  }
});

test('a refusal by a compliance rule carries its reason code', async () => {
  const probe = { name: 'probe', api: () => ({ 'automations.list': () => { throw new ApiError('validation_failed', 'Too long', { reason: 'content.too_long' }); } }) };
  const app = await startApp({ modules: [...MODULES.filter((m) => m.name !== 'automations'), probe] });
  try {
    const res = await fetch(`${app.base}/api/v1/automations`, { headers: { authorization: `Bearer ${await signIn(app.base)}` } });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.reason, 'content.too_long');
    assert.equal(ErrorBody.safeParse(body).success, true);
  } finally {
    app.close();
  }
});

test('modules see meta and compliance, and a module\'s webhook replaces the old one', async () => {
  let seen;
  const probe = {
    name: 'probe',
    beforeTenant(app, ctx) {
      seen = ctx;
      app.post('/webhook', (_req, res) => res.status(202).send('mine'));
    },
  };
  const app = await startApp({ modules: [...MODULES, probe] });
  try {
    assert.equal(typeof seen.compliance.send, 'function');
    assert.equal(typeof seen.meta.client.forAccount, 'function');
    assert.equal(seen.meta.login.kind, 'instagram');
    assert.equal((await fetch(`${app.base}/webhook`, { method: 'POST' })).status, 202);
  } finally {
    app.close();
  }
});
