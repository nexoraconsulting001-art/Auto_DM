// How the Phase 1 screens are wired: their routes, who can open them, their three states, and the rules every console file keeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routes } from '../../../src/contracts/api/index.js';
import { createApiClient } from '../../../shared/api-client/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FEATURES = ['connect', 'automations', 'inbox', 'compliance'];
const featuresDir = path.join(repoRoot, 'console/src/features');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const files = FEATURES.flatMap((feature) => walk(path.join(featuresDir, feature))).map((file) => ({ name: path.relative(featuresDir, file).replaceAll('\\', '/'), text: fs.readFileSync(file, 'utf8') }));
const code = files.filter(({ name }) => /\.jsx?$/.test(name));
const css = files.filter(({ name }) => name.endsWith('.css'));
const source = (name) => files.find((file) => file.name === name).text;

const ROUTES = {
  connect: ['connect'],
  automations: ['automations', 'automations/:id'],
  inbox: ['inbox', 'inbox/threads/:id', 'inbox/needs-human', 'inbox/why-no-dm'],
  compliance: ['compliance', 'compliance/log', 'compliance/settings'],
};

test('each screen has its route, and loads only when opened', () => {
  for (const [feature, paths] of Object.entries(ROUTES)) {
    const index = source(`${feature}/index.jsx`);
    for (const route of paths) assert.ok(index.includes(`path: '${route}'`), `${feature}: ${route}`);
    assert.match(index, /lazy\(\(\) => import\(/, feature);
    assert.doesNotMatch(index, /^import \w+Page from/m, `${feature}: a page imported directly`);
  }
});

test('each feature asks for the same access as the API route behind it', () => {
  const expected = { connect: ['automations', 'instagram.connection'], automations: ['automations', 'automations.list'], inbox: ['inbox', 'inbox.threads'], compliance: ['automations', 'compliance.status'] };
  for (const [feature, [permission, routeId]] of Object.entries(expected)) {
    assert.ok(source(`${feature}/index.jsx`).includes(`access: staffWith('${permission}')`), feature);
    assert.equal(routes[routeId].access.permission, permission, routeId);
  }
});

test('anything only a manager may do is only offered to one', () => {
  const managerOnly = {
    'connect/ConnectPage.jsx': ['canManage && view.action', 'canManage && view.connected'],
    'compliance/CompliancePage.jsx': ['!allowed(MANAGERS)', 'canDiscard={allowed(MANAGERS)}'],
    'compliance/ComplianceSettingsPage.jsx': ['canEdit = allowed(MANAGERS)', '{canEdit && <Button type="submit"'],
    'automations/TestingPanels.jsx': ['canManage = allowed(MANAGERS)', '{canManage && <AddTester'],
  };
  for (const [file, marks] of Object.entries(managerOnly)) for (const mark of marks) assert.ok(source(file).includes(mark), `${file}: ${mark}`);
  for (const id of ['instagram.connect', 'instagram.disconnect', 'compliance.pause', 'compliance.resume', 'compliance.updateSettings', 'compliance.discardHeld', 'compliance.slowModeOverride', 'compliance.addWord', 'compliance.removeWord', 'testers.createCode', 'testers.remove']) {
    assert.deepEqual([...routes[id].access.roles], ['owner', 'manager'], id);
  }
});

test('every page says when it is loading, when it failed, and when there is nothing', () => {
  const pages = {
    'automations/AutomationsPage.jsx': true,
    'automations/BuilderPage.jsx': false,
    'automations/MediaPicker.jsx': true,
    'automations/TestingPanels.jsx': true,
    'inbox/InboxPage.jsx': true,
    'inbox/ThreadPage.jsx': false,
    'inbox/NeedsHumanPage.jsx': true,
    'connect/ConnectPage.jsx': false,
    'compliance/CompliancePage.jsx': true,
    'compliance/ComplianceLogPage.jsx': true,
    'compliance/ComplianceSettingsPage.jsx': true,
  };
  for (const [page, needsEmpty] of Object.entries(pages)) {
    assert.match(source(page), /<Loadable[^>]*\blabel="[^"]+"[^>]*\berrorTitle="[^"]+"/, `${page}: loading and error`);
    if (needsEmpty) assert.match(source(page), /<EmptyState/, `${page}: empty`);
  }
  const why = source('inbox/WhyNoDmPage.jsx');
  for (const state of ['<Spinner', '<ErrorState', '<EmptyState']) assert.ok(why.includes(state), `why no DM: ${state}`);
});

test('a screen about one thing reads as missing, not broken, when it isn\'t there', () => {
  assert.match(source('automations/BuilderPage.jsx'), /<Loadable query=\{automation\} detail/);
  assert.match(source('inbox/ThreadPage.jsx'), /<Loadable query=\{thread\} detail/);
});

test('the screens call only methods the shared client has', () => {
  const client = createApiClient();
  const calls = code.flatMap(({ name, text }) => [...text.matchAll(/\bapi\.([a-zA-Z]+)\.([a-zA-Z]+)/g)].map((m) => ({ name, group: m[1], method: m[2] })));
  assert.ok(calls.length > 25, `only ${calls.length} calls found`);
  for (const { name, group, method } of calls) assert.equal(typeof client[group]?.[method], 'function', `${name}: api.${group}.${method}`);
});

test('nothing reaches past the API client or the access rules', () => {
  for (const { name, text } of code) {
    assert.doesNotMatch(text, /\bfetch\(|XMLHttpRequest|axios/, name);
    for (const [, target] of text.matchAll(/from '([^']+)'/g)) {
      if (target.startsWith('@contracts/')) assert.equal(target, '@contracts/access.js', `${name}: the rest of the contract would pull zod into the page`);
      if (target.startsWith('.')) assert.ok(path.resolve(featuresDir, path.dirname(name), target).startsWith(path.join(repoRoot, 'console', 'src')), `${name}: ${target}`);
    }
  }
});

test('no screen logs anything, and no message goes through dangerous HTML', () => {
  for (const { name, text } of code) {
    assert.doesNotMatch(text, /console\.(log|info|warn|error|debug)\(/, name);
    assert.doesNotMatch(text, /dangerouslySetInnerHTML|innerHTML/, name);
  }
});

test('PRD 4.11: the console never builds a link of its own for a DM', () => {
  for (const { name, text } of code) assert.doesNotMatch(text, /\/l\/|\/go\/|shorten|bit\.ly|redirect=/i, name);
});

test('U-10: no raw event export', () => {
  for (const { name, text } of code) assert.doesNotMatch(text, /raw[ -_]?(event|log|export)|\.csv\b|download=/i, name);
});

test('F-75: a seller\'s logo isn\'t used on these screens', () => {
  for (const { name, text } of code) assert.doesNotMatch(text, /\.logoUrl\b/, name);
});

test('A-74: what a shopper receives carries no Bhava text', () => {
  const panel = source('automations/MessagePanel.jsx');
  const preview = panel.slice(panel.indexOf('function DmPreview'), panel.indexOf('export function MessagePanel'));
  assert.doesNotMatch(preview.replace(/\/\*\*[\s\S]*?\*\//g, ''), /bhava/i);
  assert.match(preview, /session\.business\.name/, 'it is the seller\'s name');
});

test('A-28: the variables are offered as buttons, and the message box holds its own text', () => {
  const panel = source('automations/MessagePanel.jsx');
  assert.match(panel, /insert\('\{first_name\}'\)/);
  assert.match(panel, /insert\('\{url\}'\)/);
  assert.match(panel, /defaultValue=\{initial\}/, 'a controlled textarea copies its value into the page\'s text');
  for (const file of ['automations/BuilderPage.jsx', 'automations/LinkPanel.jsx']) assert.doesNotMatch(source(file), /\{first_name\}/, file);
});

test('A-36: one tap on the Free plan stays off, with the reason', () => {
  const panel = source('automations/LinkPanel.jsx');
  assert.match(panel, /One tap needs a paid plan/);
  assert.match(panel, /mode === 'one_tap' && !canOneTap\) return/);
});

test('C-43: the pause panel never offers resume on a pause by support', () => {
  const page = source('compliance/CompliancePage.jsx');
  const support = page.indexOf('status.paused && !status.canResume');
  const resume = page.indexOf('Resume sending');
  assert.ok(support > 0 && support < resume, 'the support case returns before the resume button');
});

test('the status banner reaches Home', () => {
  const index = source('compliance/index.jsx');
  assert.match(index, /home\.routes = home\.routes\.map/);
  assert.match(index, /<HomeNotices \/>/);
  assert.match(source('compliance/HomeNotices.jsx'), /allowed\(READER\)/, 'only for someone the API would answer');
});

test('styles use the design system\'s tokens, never raw colours', () => {
  assert.equal(css.length, 4, css.map((file) => file.name).join());
  for (const { name, text } of css) {
    assert.doesNotMatch(text, /#[0-9a-f]{3,8}\b/i, `${name}: a raw colour`);
    assert.doesNotMatch(text, /\brgba?\(/i, `${name}: a raw colour`);
    assert.doesNotMatch(text, /font-family:(?!\s*var\()/, `${name}: a raw font`);
  }
});

test('a tap target is never under the design\'s minimum', () => {
  for (const { name, text } of css) {
    for (const [, height] of text.matchAll(/min-height:\s*(\d+)px/g)) assert.ok(Number(height) >= 28, `${name}: min-height ${height}px`);
  }
});
