// Q-13: showcase feedback over HTTP, and the Platform Console screen's source.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSOLE_HOST, addBusiness, closeShared, consoleUser, filesUnder, hit, onConsole, read, sharedWorld, signIn, u,
} from '../spec-p8/support.js';

after(closeShared);

let world;
async function setup() {
  if (world) return world;
  const app = await sharedWorld();
  world = {
    app,
    a: await addBusiness(app, { slug: u('dk-first'), name: 'Demo Kit First' }),
    b: await addBusiness(app, { slug: u('dk-second'), name: 'Demo Kit Second' }),
    admin: await consoleUser(app, 'super_admin'),
    support: await consoleUser(app, 'support'),
    onboarder: await consoleUser(app, 'onboarding'),
  };
  return world;
}
const log = (w, who, business, body) => onConsole(w.app, who, `/tenants/${business.tenant.id}/feedback`, { method: 'POST', body });
const note = { saidBy: 'The owner', area: 'Inbox', text: 'The reply box is small', severity: 'high' };

test('Q-13: an item is logged against its business and tracked from new, to planned, to fixed with what fixed it', async () => {
  const w = await setup();
  const made = await log(w, w.support, w.a, note);
  assert.equal(made.status, 201, made.text);
  const item = made.json();
  assert.deepEqual([item.tenantId, item.state, item.fixedIn, item.severity], [w.a.tenant.id, 'new', '', 'high']);
  const patch = (body) => onConsole(w.app, w.admin, `/feedback/${item.id}`, { method: 'PATCH', body });
  assert.equal((await patch({ state: 'planned' })).json().state, 'planned');
  assert.equal((await patch({ state: 'fixed' })).status, 400, 'a fix says what fixed it');
  const fixed = (await patch({ state: 'fixed', fixedIn: 'abc1234' })).json();
  assert.deepEqual([fixed.state, fixed.fixedIn], ['fixed', 'abc1234']);
  assert.equal((await patch({ fixedIn: 'def5678' })).json().fixedIn, 'def5678', 'what fixed it can be corrected while it is fixed');
  assert.equal((await patch({ state: 'declined' })).json().fixedIn, '', 'moving away from fixed clears it');
  assert.equal((await patch({ fixedIn: 'nope' })).status, 400, 'only a fixed item has one');
  assert.equal((await patch({})).status, 400);
  assert.equal((await onConsole(w.app, w.admin, '/feedback/abc', { method: 'PATCH', body: { state: 'planned' } })).status, 400);
  assert.equal((await onConsole(w.app, w.admin, '/feedback/99999999', { method: 'PATCH', body: { state: 'planned' } })).status, 404);
});

test('Q-13: the words are stored as typed and the audit trail holds ids, never the words', async () => {
  const w = await setup();
  const words = '<img src=x onerror=alert(1)> private-words-dk';
  const made = (await log(w, w.admin, w.a, { ...note, text: words })).json();
  assert.equal(made.text, words);
  const audit = await w.app.db.platform.query(`SELECT details::text AS d, target FROM audit_log WHERE action LIKE 'feedback.%' AND target = $1`, [String(made.id)]);
  assert.ok(audit.length >= 1, 'logging is audited');
  assert.ok(audit.every((row) => !row.d.includes('private-words-dk')), 'the audit row holds no words');
});

test('Q-13: only support and super admin can read or change feedback; a seller never sees it', async () => {
  const w = await setup();
  const made = (await log(w, w.admin, w.a, { ...note, text: 'only-the-platform-dk' })).json();
  for (const [url, method, body] of [['/feedback', 'GET'], [`/feedback/${made.id}`, 'PATCH', { state: 'planned' }], [`/tenants/${w.a.tenant.id}/feedback`, 'POST', note]]) {
    assert.equal((await hit(w.app, url, { host: CONSOLE_HOST, method, body })).status, 401, `${method} ${url} signed out`);
    assert.equal((await onConsole(w.app, w.onboarder, url, { method, body })).status, 403, `${method} ${url} without the role`);
  }
  assert.equal((await onConsole(w.app, w.admin, `/feedback?tenantId=${w.a.tenant.id}`)).json().items.find((i) => i.id === made.id).state, 'new', 'nothing changed');
  const token = await signIn(w.app, w.a);
  for (const route of ['/api/v1/feedback', '/api/v1/platform/feedback']) {
    const res = await hit(w.app, route, { host: w.a.host, token });
    assert.ok([403, 404].includes(res.status));
    assert.doesNotMatch(res.text, /only-the-platform-dk/);
  }
});

test('Q-13: the list can be limited to one business and one state, and pages without repeating an item', async () => {
  const w = await setup();
  for (let i = 0; i < 7; i += 1) await log(w, w.admin, w.b, { ...note, text: `second-${i}-dk` });
  const seen = [];
  let cursor = '';
  for (let page = 0; page < 10; page += 1) {
    const res = (await onConsole(w.app, w.admin, `/feedback?tenantId=${w.b.tenant.id}&limit=3${cursor ? `&cursor=${cursor}` : ''}`)).json();
    seen.push(...res.items);
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  assert.ok(seen.length >= 7 && seen.every((i) => i.tenantId === w.b.tenant.id));
  assert.equal(new Set(seen.map((i) => i.id)).size, seen.length);
  assert.equal((await onConsole(w.app, w.admin, '/feedback?state=nope')).status, 400);
});

test('Q-13: the screen shows the words as text, hides nothing behind a role it does not check, and the feature is registered', () => {
  const files = filesUnder('console/src/platform/features/feedback', { ext: ['.jsx', '.js'] });
  assert.ok(files.length >= 2);
  const text = files.map(read).join('\n');
  assert.doesNotMatch(text, /dangerouslySetInnerHTML|innerHTML/);
  assert.match(text, /\{item\.text\}/, 'the words are a text child');
  assert.match(text, /roles: \['super_admin', 'support'\]/);
  assert.match(text, /platform\.updateFeedback/, 'the change button is shown only to a role that may use it');
  assert.match(text, /platform\.createFeedback/);
});
