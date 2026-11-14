// What the Platform Console's source must hold (PRD 5.5 to 5.10, 5.12, 5.17, 5.20, 6.11, 6.12), read from the files themselves:
// a screen is offered to exactly the roles its server routes allow, every call that the server wants a reason for sends one that
// the person had to write, a secret is never put on screen whole, and nothing of the seller's console is reached from here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PLATFORM_ROUTES } from '../../../shared/api-client/platform-routes.js';
import { platformRoutes } from '../../../src/contracts/api/platform.js';
import { SRC, filesUnder, read } from './support.js';

const FEATURES = path.join(SRC, 'features');
const features = () => filesUnder(FEATURES, /index\.jsx$/).map((file) => {
  const text = read(file);
  const name = /name: '([a-z-]+)'/.exec(text)[1];
  const roles = [...(/roles: \[([^\]]*)\]/.exec(text)[1].matchAll(/'([a-z_]+)'/g))].map((m) => m[1]);
  const to = /to: '([^']+)'/.exec(text)?.[1];
  const order = Number(/order: (\d+)/.exec(text)?.[1]);
  return { name, roles, to, order, dir: path.dirname(file) };
});
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/** The console's own files, comments left out. api.js only builds the client, so it holds no screens' calls. */
const sources = () => filesUnder(SRC, /\.(jsx?)$/)
  .map((file) => ({ file, rel: path.relative(SRC, file).replaceAll('\\', '/'), text: stripComments(read(file)) }))
  .filter((source) => source.rel !== 'api.js');

/** Every `api.<method>` in a file: a call with the text of its arguments, or a method handed to a list helper (arguments ''). */
function callsIn(text) {
  const found = [];
  for (const match of text.matchAll(/(?<![\w/'.])api\.([a-zA-Z]+)\b(\()?/g)) {
    if (!match[2]) {
      found.push({ method: match[1], args: '', handed: true });
      continue;
    }
    let depth = 1;
    let at = match.index + match[0].length;
    while (depth > 0 && at < text.length) {
      if (text[at] === '(') depth += 1;
      if (text[at] === ')') depth -= 1;
      at += 1;
    }
    found.push({ method: match[1], args: text.slice(match.index + match[0].length, at - 1) });
  }
  return found;
}

test('every call the console makes is a route that exists, and the route table matches the contract', () => {
  for (const [id, route] of Object.entries(platformRoutes)) {
    assert.equal(PLATFORM_ROUTES[id]?.path, route.path, id);
    assert.deepEqual([...(PLATFORM_ROUTES[id]?.platformRoles ?? [])], [...route.platformRoles], id);
  }
  const ids = new Set(Object.keys(PLATFORM_ROUTES).map((id) => id.split('.')[1]));
  let calls = 0;
  for (const { rel, text } of sources()) {
    for (const call of callsIn(text)) {
      calls += 1;
      assert.ok(ids.has(call.method), `${rel} calls api.${call.method}, which is not a platform route`);
    }
  }
  assert.ok(calls > 70, `only ${calls} calls found: the scan is not reading the screens`);
});

test('F-37 F-43: every route of this phase’s list has a screen that calls it (nothing in the PRD list is left unbuilt)', () => {
  const used = new Set();
  for (const { text } of sources()) for (const call of callsIn(text)) used.add(`platform.${call.method}`);
  // Routes the console deliberately does not call: Phase 3 theme presets, site adapters and customisation requests belong to other
  // screens, and the team list is a later part of the console. Everything else must be reached.
  const elsewhere = new Set(['platform.siteAdapters', 'platform.setSiteAdapter', 'platform.themePresets', 'platform.saveThemePreset', 'platform.customisationRequests',
    'platform.createCustomisationRequest', 'platform.decideCustomisationRequest', 'platform.team', 'platform.addTeamMember', 'platform.updateTeamMember',
    'platform.alerts', 'platform.accountHealthList', 'platform.unblockPerson']);
  const missing = Object.keys(PLATFORM_ROUTES).filter((id) => !used.has(id) && !elsewhere.has(id));
  assert.deepEqual(missing, [], `routes with no screen: ${missing.join(', ')}`);
});

test('F-39: a screen is offered to exactly the roles its main route allows, and a role never sees a menu entry it would be refused', () => {
  const main = {
    businesses: 'platform.businesses', onboarding: 'platform.onboardingList', health: 'platform.health', switches: 'platform.switches', impersonation: 'platform.impersonations',
    services: 'platform.services', billing: 'platform.billing', flags: 'platform.flags', signup: 'platform.signup', apps: 'platform.appSubmissions', exports: 'platform.rawExport', audit: 'platform.auditLog',
  };
  const all = features();
  assert.deepEqual(all.map((f) => f.name).sort(), Object.keys(main).sort());
  for (const feature of all) {
    assert.deepEqual([...feature.roles].sort(), [...PLATFORM_ROUTES[main[feature.name]].platformRoles].sort(), `${feature.name}: roles`);
    assert.ok(feature.to === `/${feature.name}`, `${feature.name}: menu address`);
  }
  assert.equal(new Set(all.map((f) => f.order)).size, all.length, 'menu orders are unique, so the menu is in a fixed order');
  // A page's actions that only some roles may call are wrapped in <Can route=...> or checked with can(...): no raw call sits in a role-gated spot unguarded.
  const gated = ['platform.setMetaAccess', 'platform.overridePlan', 'platform.createCreditNote', 'platform.saveFlag', 'platform.setSignupMode', 'platform.createAppBatch', 'platform.publishOta', 'platform.advanceOta', 'platform.unfreezeActivations', 'platform.setAppMinimum', 'platform.setAppReviewAccess', 'platform.saveBillingSettings'];
  for (const id of gated) assert.deepEqual([...PLATFORM_ROUTES[id].platformRoles], ['super_admin'], `${id} is super admin only`);
  const text = sources().map((s) => s.text).join('\n');
  for (const id of gated) assert.ok(text.includes(`route="${id}"`) || text.includes(`can('${id}')`), `${id}: the control is offered only to a role that may use it`);
});

test('F-36 F-52 F-129: every call that needs a reason sends one, and the sheet that asks for it will not submit without it', () => {
  const needs = Object.entries(platformRoutes).filter(([id, route]) => route.body?.shape && ('reason' in route.body.shape || 'resolution' in route.body.shape || id === 'platform.createAppBatch')).map(([id]) => id.split('.')[1]);
  assert.ok(needs.length >= 20, `${needs.length} routes want a reason`);
  const all = sources().flatMap(({ rel, text }) => callsIn(text).map((call) => ({ ...call, rel, text })));
  for (const method of needs) {
    if (method === 'createCreditNote' || method === 'confirmImpersonationWrite') continue; // checked below, with their own fields
    const calls = all.filter((call) => call.method === method && !call.handed);
    if (!calls.length) continue;
    for (const call of calls) assert.match(call.args, /\b(reason|resolution|note)\b/, `api.${method} in ${call.rel} sends no reason`);
    for (const call of calls) assert.ok(/ActionSheet|reasonProblem/.test(call.text), `${call.rel}: api.${method} is not behind a reason sheet`);
  }
  for (const method of ['createCreditNote', 'confirmImpersonationWrite']) {
    const [call] = all.filter((c) => c.method === method);
    assert.match(call.args, /\breason\b/, method);
  }
  // The sheet itself: the button is off until the reason is written, and a submit with none says why instead of sending.
  const kit = read(path.join(SRC, 'kit.jsx'));
  assert.match(kit, /reasonProblem\(text\) !== ''\) \|\| !valid/);
  assert.match(kit, /disabled=\{blocked\}/);
  assert.match(kit, /if \(problem\) \{[\s\S]{0,80}setError\(problem\);[\s\S]{0,40}return;/);
  // Every sheet that turns the reason off is for a call the contract does not ask a reason for.
  for (const { rel, text } of sources()) {
    for (const match of text.matchAll(/needsReason=\{false\}[\s\S]{0,700}?onSubmit=\{[\s\S]{0,260}?api\.([a-zA-Z]+)\(/g)) {
      assert.ok(!needs.includes(match[1]), `${rel}: api.${match[1]} needs a reason but its sheet does not ask for one`);
    }
  }
});

test('F-122 F-129: a secret is shown only masked: the invite code, the invite link and the review code never appear whole, and the console stores nothing in the browser', () => {
  const all = sources();
  const joined = all.map((s) => s.text).join('\n');
  for (const word of ['localStorage', 'sessionStorage', 'document.cookie', 'indexedDB', 'dangerouslySetInnerHTML', 'console.log', 'console.debug']) assert.ok(!joined.includes(word), `${word} is used`);
  const secret = /export function Secret[\s\S]*?\n\}\n/.exec(read(path.join(SRC, 'kit.jsx')))[0];
  assert.match(secret, /\{maskSecret\(value\)\}/, 'the secret component prints the masked text');
  assert.equal([...secret.matchAll(/\{value\}/g)].length, 0, 'the secret component never prints the value whole');
  // The places a secret arrives: only ever handed to Secret (to copy) or masked.
  for (const { rel, text } of all) {
    for (const match of text.matchAll(/\b(created\.code|sent\.url)\b/g)) {
      const around = text.slice(Math.max(0, match.index - 40), match.index + match[0].length + 5);
      assert.ok(/value=\{|maskLink\(/.test(around), `${rel}: ${match[0]} is used outside Secret or maskLink: ${around}`);
    }
  }
  // The store-review code is typed into a password field with nothing remembered, and is never read back into the page.
  const apps = read(path.join(FEATURES, 'apps', 'pages.jsx'));
  assert.match(apps, /label="Review code" type="password"/);
  assert.match(apps, /autoComplete="new-password"/);
  assert.doesNotMatch(apps, /setCode\(.*review/i);
});

test('F-90: the console reaches only the platform client and the shared design: nothing of the seller’s API, session, screens or brand', () => {
  const allowed = [/^react/, /^lucide-react$/, /^@tanstack\/react-query$/, /^@bhava\/api-client\/platform$/, /^\.\.?\//];
  const sharedOk = ['../design/', '../../design/', '../../../design/', '../lib/format.js', '../../lib/format.js', '../../../lib/format.js', '../lib/forms.js', '../../lib/forms.js', '../../../lib/forms.js', '../components/feedback.jsx', '../../components/feedback.jsx', '../../../components/feedback.jsx', '@fontsource-variable/'];
  for (const { rel, text } of sources()) {
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
      const spec = match[1];
      if (spec.startsWith('.') && !spec.includes('..')) continue; // a file beside it
      const inside = spec.startsWith('.') && path.resolve(path.dirname(path.join(SRC, rel)), spec).startsWith(SRC);
      if (inside) continue;
      assert.ok(allowed.some((rule) => rule.test(spec)) || spec.startsWith('@fontsource-variable/') || spec.endsWith('.css'), `${rel} imports ${spec}`);
      if (spec.startsWith('.')) assert.ok(sharedOk.some((ok) => spec.startsWith(ok) || spec === ok), `${rel} reaches outside the console: ${spec}`);
    }
    assert.ok(!text.includes('/api/v1'), `${rel} names the seller API`);
    assert.ok(!/@contracts|lib\/api|lib\/session|lib\/query|\/shell\/|\/features\//.test(text.replace(/\.\/features\//g, '').replace(/\.\.\/features\//g, '')), `${rel} reaches the seller console`);
  }
});

test('F-91: the seller console never loads the Platform Console: it is its own entry, its own build folder, its own base address', () => {
  const root = path.resolve(SRC, '..', '..');
  const seller = read(path.join(root, 'vite.config.js'));
  const platform = read(path.join(root, 'vite.platform.config.js'));
  assert.match(seller, /base: '\/admin\/'/);
  assert.match(seller, /outDir: 'dist'/);
  assert.doesNotMatch(seller, /platform/);
  assert.match(platform, /base: '\/console\/'/);
  assert.match(platform, /outDir: 'dist-platform'/);
  assert.match(platform, /platform\.html/);
  for (const file of filesUnder(path.join(root, 'src'), /\.(jsx?)$/)) {
    if (file.startsWith(SRC)) continue;
    assert.doesNotMatch(read(file), /from '[^']*\/platform\/|import\('[^']*\/platform\//, `${path.relative(root, file)} imports the Platform Console`);
  }
  assert.doesNotMatch(read(path.join(root, 'index.html')), /platform/);
});

test('F-39: no screen shows Bhava’s brand to a buyer or a seller’s brand here: the console is Bhava’s own tool', () => {
  const joined = sources().map((s) => s.text).join('\n');
  assert.match(joined, /Bhava Console/);
  assert.ok(!/instagram\.com\/|wa\.me\//.test(joined), 'no direct links to a social network from the console');
});
