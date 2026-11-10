// How the Phase 2 console screens are wired: their routes, who may open what, the states every screen has, a source label on every
// figure, and the rules every console file keeps. Read from the source, so it needs no build and no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routes } from '../../../src/contracts/api/index.js';
import { createApiClient } from '../../../shared/api-client/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const featuresDir = path.join(repoRoot, 'console/src/features');
const FEATURES = ['insights', 'traffic', 'reach-guard', 'reports'];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const files = FEATURES.flatMap((feature) => walk(path.join(featuresDir, feature))).map((file) => ({ name: path.relative(featuresDir, file).replaceAll('\\', '/'), text: fs.readFileSync(file, 'utf8') }));
const code = files.filter(({ name }) => /\.jsx?$/.test(name));
const pages = code.filter(({ name }) => /Page\.jsx$/.test(name));
const source = (name) => {
  const found = files.find((file) => file.name === name);
  assert.ok(found, `no file ${name}`);
  return found.text;
};

const ROUTES = {
  insights: ['analytics', 'analytics/content', 'analytics/content/:id', 'analytics/stories', 'analytics/audience', 'analytics/top', 'analytics/funnels', 'analytics/funnels/:id', 'analytics/sources'],
  traffic: ['traffic', 'traffic/tags', 'explore', 'funnels', 'funnels/new', 'funnels/:id', 'funnels/:id/edit', 'cohorts'],
  'reach-guard': ['reach-guard', 'account-health'],
  reports: ['reports', 'reports/scheduled', 'settings/api-keys'],
};

test('each screen has its route, and loads only when opened', () => {
  for (const [feature, paths] of Object.entries(ROUTES)) {
    const index = source(`${feature}/index.jsx`);
    for (const route of paths) assert.ok(index.includes(`path: '${route}'`), `${feature}: ${route}`);
    assert.match(index, /lazy\(\(\) => import\(/, feature);
    assert.doesNotMatch(index, /^import \w+Page from/m, `${feature}: a page imported directly`);
  }
});

test('no route of the console names a raw export: summary files only (N-81)', () => {
  for (const paths of Object.values(ROUTES)) for (const route of paths) assert.doesNotMatch(route, /raw|export|event/i, route);
});

test('each area asks for the analytics permission, as the API routes behind it do', () => {
  for (const feature of FEATURES) assert.ok(source(`${feature}/index.jsx`).includes("access: staffWith('analytics')"), feature);
  for (const id of ['insights.status', 'insights.account', 'traffic.summary', 'explore.query', 'reachGuard.status', 'accountHealth.get', 'downloads.create', 'reports.list', 'funnels.results', 'cohorts.get']) {
    assert.equal(routes[id].access.permission, 'analytics', id);
  }
});

test('the menu has one entry per area, in the Insights part of the menu', () => {
  const labels = FEATURES.map((feature) => /nav: \{ to: '([^']+)', label: '([^']+)'/.exec(source(`${feature}/index.jsx`)).slice(1));
  assert.deepEqual(labels, [['/analytics', 'Insights'], ['/traffic', 'Traffic'], ['/reach-guard', 'Reach Guard'], ['/reports', 'Reports']]);
});

test('owner-only things are only offered to the owner, as the API decides (N-27, N-63, 7.14)', () => {
  for (const id of ['reachGuard.setThresholds', 'tags.get', 'tags.update', 'apiKeys.list', 'apiKeys.create', 'apiKeys.revoke', 'scheduledReports.addRecipient', 'scheduledReports.removeRecipient']) {
    assert.deepEqual([...routes[id].access.roles], ['owner'], id);
  }
  const marks = {
    'reach-guard/ReachGuardPage.jsx': ['{view.offerOverride && <Override />}', 'canEdit={view.canEditThresholds}', 'if (!canEdit) {'],
    'traffic/TagsPage.jsx': ["const isOwner = session.user.role === 'owner'", 'enabled: isOwner', '{isOwner ? ('],
    'reports/ApiKeysPage.jsx': ["const isOwner = session.user.role === 'owner'", '{isOwner ? ('],
    'reports/ScheduledPage.jsx': ['{isOwner && (', "isOwner && r.kind === 'outside'"],
  };
  for (const [file, list] of Object.entries(marks)) for (const mark of list) assert.ok(source(file).includes(mark), `${file}: ${mark}`);
  // The override route itself is open to managers in the table; its handler holds the owner rule, and the screen follows it.
  assert.ok(source('insights/shared/figures.js').includes("const isOwner = role === 'owner'"));
});

test('what only owners and managers may change is only offered to them', () => {
  for (const id of ['funnels.create', 'funnels.update', 'funnels.remove', 'destinations.setSiteTag', 'destinations.uploadReport', 'scheduledReports.list', 'scheduledReports.create']) {
    assert.deepEqual([...routes[id].access.roles], ['owner', 'manager'], id);
  }
  const marks = {
    'traffic/FunnelListPage.jsx': ['const canEdit = allowed(MANAGERS)'],
    'traffic/FunnelEditPage.jsx': ['if (!allowed(MANAGERS)) {'],
    'traffic/FunnelResultsPage.jsx': ['allowed(MANAGERS) ? <Button as={Link}', '{allowed(MANAGERS) && <Button variant="danger"'],
    'insights/SourcesPage.jsx': ['const canManage = allowed(MANAGERS)', '{canManage && <UploadReport />}'],
    'reports/ScheduledPage.jsx': ['const canSchedule = allowed(MANAGERS)', '{ enabled: canSchedule }'],
  };
  for (const [file, list] of Object.entries(marks)) for (const mark of list) assert.ok(source(file).includes(mark), `${file}: ${mark}`);
});

test('a role without revenue access is shown no revenue (7.11, N-53)', () => {
  for (const file of ['traffic/TrafficPage.jsx', 'traffic/CohortsPage.jsx', 'insights/TopPage.jsx']) assert.match(source(file), /canSeeRevenue\(session\.user\)/, file);
});

test('every screen says when it is loading, when it failed, and when there is nothing', () => {
  const withoutEmpty = new Set(['insights/MediaPage.jsx', 'insights/FunnelPage.jsx', 'traffic/FunnelEditPage.jsx', 'traffic/FunnelResultsPage.jsx', 'reports/ReportsPage.jsx']);
  for (const { name, text } of pages) {
    if (name === 'reports/ReportsPage.jsx') {
      assert.match(text, /<AnalyticsLoadable[^>]*\blabel="[^"]+"[^>]*\berrorTitle="[^"]+"/, name);
      continue;
    }
    if (name === 'traffic/FunnelEditPage.jsx') {
      assert.match(text, /<AnalyticsLoadable[^>]*\bdetail\b[^>]*\blabel="[^"]+"[^>]*\berrorTitle="[^"]+"/, name);
      continue;
    }
    for (const match of text.matchAll(/<AnalyticsLoadable\b[^>]*>/g)) assert.match(match[0], /\blabel="[^"]+"[^>]*\berrorTitle="[^"]+"/, `${name}: ${match[0]}`);
    assert.ok(text.includes('<AnalyticsLoadable'), `${name}: loading and error`);
    if (!withoutEmpty.has(name)) assert.ok(text.includes('<EmptyState'), `${name}: empty`);
  }
  for (const page of ['insights/MediaPage.jsx', 'insights/FunnelPage.jsx', 'traffic/FunnelResultsPage.jsx']) assert.match(source(page), /<AnalyticsLoadable query=\{\w+\} detail/, `${page}: a missing thing reads as missing`);
});

test('the analytics states of their own: not switched on yet, Owner only, Learning, Permission needed, and the 100-follower notice', () => {
  const ui = source('insights/shared/ui.jsx');
  assert.match(ui, /error\?\.status === 501\) return <NotYetState/);
  assert.match(ui, /error\?\.status === 403\) return <RefusedState/);
  assert.match(ui, /export function PermissionNeeded/);
  assert.match(source('insights/AccountPage.jsx'), /status\.permission === 'needed' && <PermissionNeeded/);
  assert.match(source('reach-guard/ReachGuardPage.jsx'), /view\.state === 'permission_needed' && <PermissionNeeded/);
  assert.match(source('reach-guard/ReachGuardPage.jsx'), /view\.learning && \(/);
  assert.match(source('insights/AudiencePage.jsx'), /if \(!audience\.available\) return <EmptyState title=\{audience\.message/);
  assert.match(source('insights/TopPage.jsx'), /if \(!best\.available\) return <EmptyState/);
});

test('PRD 7.15: every screen with figures shows where they come from', () => {
  const noFigures = new Set(['traffic/FunnelEditPage.jsx', 'traffic/FunnelListPage.jsx', 'reports/ScheduledPage.jsx', 'reports/ApiKeysPage.jsx', 'reports/ReportsPage.jsx']);
  for (const { name, text } of pages) {
    if (noFigures.has(name)) continue;
    assert.ok(text.includes('<SourceTag'), `${name}: no source label`);
  }
  assert.match(source('reports/PinnedViews.jsx'), /sourceLabel\(c\.source\)/);
  assert.match(source('traffic/ExplorePage.jsx'), /sourceLabel\(c\.source\)/, 'each Explore column says where it comes from');
  assert.match(source('insights/FunnelPage.jsx'), /<SourceTag source=\{step\.sourceCode\} \/>/, 'each funnel step has its own label');
});

test('PRD 7.1: views say they replace impressions, the last 2 days are flagged, and estimated figures say so', () => {
  const account = source('insights/AccountPage.jsx');
  assert.match(account, /FIGURE_TEXT\.mayChange/);
  assert.match(account, /<EstimatedNote/);
  assert.match(account, /<RefreshNow/);
  assert.match(source('insights/shared/ui.jsx'), /FIGURE_TEXT\.estimated/);
});

test('the screens call only methods the shared client has', () => {
  const client = createApiClient();
  const calls = code.flatMap(({ name, text }) => [...text.matchAll(/\bapi\.([a-zA-Z]+)\.([a-zA-Z]+)/g)].map((m) => ({ name, group: m[1], method: m[2] })));
  assert.ok(calls.length > 40, `only ${calls.length} calls found`);
  for (const { name, group, method } of calls) assert.equal(typeof client[group]?.[method], 'function', `${name}: api.${group}.${method}`);
});

test('nothing reaches past the API client and the access rules, or outside what the Docker build copies', () => {
  for (const { name, text } of code) {
    assert.doesNotMatch(text, /\bfetch\(|XMLHttpRequest|axios|sendBeacon/, name);
    for (const [, target] of text.matchAll(/from '([^']+)'/g)) {
      if (target.startsWith('@contracts/')) assert.equal(target, '@contracts/access.js', `${name}: the rest of the contract would pull zod into the page`);
      if (target.startsWith('.')) assert.ok(path.resolve(featuresDir, path.dirname(name), target).startsWith(path.join(repoRoot, 'console', 'src')), `${name}: ${target}`);
    }
  }
});

test('the console-wide rules of Phase 0 hold for these screens too: no raw export words, no ".csv" or download attribute', () => {
  for (const { name, text } of code) assert.doesNotMatch(text, /raw[ -_]?(event|log|export)|\.csv\b|download=/i, name);
});

test('no screen logs anything, and no text goes through dangerous HTML', () => {
  for (const { name, text } of code) {
    assert.doesNotMatch(text, /console\.(log|info|warn|error|debug)\(/, name);
    assert.doesNotMatch(text, /dangerouslySetInnerHTML|innerHTML|eval\(/, name);
  }
});

test('PRD 4.11: the console never builds a link of its own for a DM', () => {
  for (const { name, text } of code) assert.doesNotMatch(text, /\/l\/|\/go\/|shorten|bit\.ly|redirect=/i, name);
});

test('PRD 7.6: Reach Guard never says "shadowban" or "safe"', () => {
  for (const { name, text } of files) assert.doesNotMatch(text, /shadow.?ban/i, name);
  for (const name of ['reach-guard/ReachGuardPage.jsx', 'reach-guard/HealthPage.jsx']) {
    const strings = [...source(name).matchAll(/(['`"])((?:(?!\1).)*)\1/g)].map((m) => m[2]).join(' ');
    assert.doesNotMatch(strings, /\bsafe\b|\bsafely\b/i, name);
  }
});

test('N-81: no screen offers a raw event log, and the summary files offer CSV and Excel', () => {
  for (const { name, text } of code) {
    const strings = [...text.matchAll(/(['`"])((?:(?!\1).)*)\1|>([^<>{}]+)</g)].map((m) => m[2] ?? m[3] ?? '').join(' ');
    assert.doesNotMatch(strings, /raw[ -_]?(event|log|export)|event log/i, name);
  }
  assert.match(source('insights/shared/figures.js'), /FORMAT_WORDS = Object\.freeze\(\{ csv: 'CSV', xlsx: 'Excel' \}\)/);
});

test('a key is shown once and never kept by the console', () => {
  const keys = source('reports/ApiKeysPage.jsx');
  assert.doesNotMatch(keys, /localStorage|sessionStorage|setQueryData/);
  assert.match(keys, /won’t be shown again/);
  for (const { name, text } of code) assert.doesNotMatch(text, /localStorage|sessionStorage|document\.cookie/, name);
});

test('secrets typed into the tag form are never shown back: the inputs are password fields and start empty', () => {
  const tags = source('traffic/TagsPage.jsx');
  assert.match(tags, /label="Conversions API token" type="password"/);
  assert.match(tags, /label="Measurement Protocol API secret" type="password"/);
  assert.match(tags, /capiToken: '', ga4Enabled/);
});

test('the console\'s analytics styles use the design tokens only, and stay inside their own classes', () => {
  const css = files.filter(({ name }) => name.endsWith('.css'));
  assert.ok(css.length >= 1);
  for (const { name, text } of css) {
    assert.doesNotMatch(text.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgba?\(/i, `${name}: a raw colour`);
    // CSS is global once loaded, so every rule names one of this area's own classes and can't restyle another screen.
    const selectors = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]+\{/g, '').match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.map((s) => s.trim()).filter(Boolean)) {
      for (const part of selector.split(',')) assert.match(part, /\.an-/, `${name}: "${part.trim()}" could restyle another screen`);
    }
  }
});

test('Home gets the pinned views and the Reach Guard banner without Home\'s files being touched, the way the compliance banner does it', () => {
  for (const feature of ['reports', 'reach-guard']) assert.match(source(`${feature}/index.jsx`), /home\.routes = home\.routes\.map\(\(route\) => \(route\.index/, feature);
  assert.match(source('reports/PinnedViews.jsx'), /allowed\(staffWith\('analytics'\)\) \? <Pinned \/> : null/);
  assert.match(source('reach-guard/GuardNotice.jsx'), /allowed\(staffWith\('analytics'\)\) \? <Notice \/> : null/);
  assert.match(source('reach-guard/GuardNotice.jsx'), /const SHOWN = new Set\(\['tripped', 'permission_needed'\]\)/);
});
