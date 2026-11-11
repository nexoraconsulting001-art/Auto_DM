// How the Phase 3 console screens are wired: their routes, who may open what, the states every screen has, and the rules every console
// file keeps. Read from the source, so it needs no build and no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routes } from '../../../src/contracts/api/index.js';
import { OWNER_EDITABLE } from '../../../src/contracts/catalog.js';
import { createApiClient } from '../../../shared/api-client/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const featuresDir = path.join(repoRoot, 'console/src/features');
const FEATURES = ['catalog', 'imports', 'pages', 'themes', 'categories', 'creator', 'leads'];

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
  catalog: ['catalog', 'catalog/new', 'catalog/settings', 'catalog/:id'],
  imports: ['imports', 'imports/:id'],
  pages: ['pages', 'pages/new', 'pages/settings', 'pages/layout', 'pages/:id'],
  themes: ['look'],
  categories: ['categories', 'categories/new', 'categories/:id', 'categories/:id/reels'],
  creator: ['creator-page'],
  leads: ['leads', 'leads/form'],
};

test('each screen has its route, and loads only when opened', () => {
  for (const [feature, paths] of Object.entries(ROUTES)) {
    const index = source(`${feature}/index.jsx`);
    for (const route of paths) assert.ok(index.includes(`path: '${route}'`), `${feature}: ${route}`);
    assert.equal([...index.matchAll(/\bpath: '/g)].length, paths.length, `${feature}: a route this test doesn't know`);
    assert.match(index, /lazy\(\(\) => import\(/, feature);
    assert.doesNotMatch(index, /^import \w+Page from/m, `${feature}: a page imported directly`);
  }
});

test('a fixed path comes before the :id route that would swallow it', () => {
  for (const feature of ['catalog', 'pages']) {
    const index = source(`${feature}/index.jsx`);
    const fixed = feature === 'catalog' ? ['catalog/new', 'catalog/settings'] : ['pages/new', 'pages/settings', 'pages/layout'];
    for (const route of fixed) assert.ok(index.indexOf(`path: '${route}'`) < index.indexOf(`path: '${feature}/:id'`), `${feature}: ${route}`);
  }
});

test('no route of the console names a raw export', () => {
  for (const paths of Object.values(ROUTES)) for (const route of paths) assert.doesNotMatch(route, /raw|export/i, route);
});

test('each area asks for the permission the API routes behind it ask for', () => {
  const ACCESS = {
    catalog: ["staffWith('catalog')", ['products.list', 'products.create', 'products.recheck', 'catalogSettings.get']],
    imports: ["staffWith('catalog')", ['imports.link', 'imports.bulk', 'imports.csv', 'imports.shopify', 'imports.list', 'imports.items', 'importItems.save']],
    pages: ["staffWith('catalog')", ['pages.list', 'pages.create', 'pages.media', 'pages.update', 'pages.remove']],
    categories: ["staffWith('catalog')", ['categories.list', 'categories.reels', 'categories.setReels', 'categories.pin', 'categories.schedule', 'categories.addRule', 'categoryRules.apply']],
    leads: ["staffWith('customers')", ['leads.list', 'leads.revokeConsent']],
  };
  for (const [feature, [access, ids]] of Object.entries(ACCESS)) {
    assert.ok(source(`${feature}/index.jsx`).includes(`access: ${access}`), feature);
    const permission = /'(\w+)'/.exec(access)[1];
    for (const id of ids) assert.equal(routes[id].access.permission, permission, id);
  }
  for (const feature of ['themes', 'creator']) assert.ok(source(`${feature}/index.jsx`).includes('access: MANAGERS'), feature);
  for (const id of ['themes.presets', 'themes.get', 'themes.choose', 'themes.updateText', 'themes.readSite', 'themes.applySiteRead', 'creator.get', 'creator.update', 'creator.checkSlug']) {
    assert.deepEqual([...routes[id].access.roles], ['owner', 'manager'], id);
  }
});

test('the menu has one entry per area; imports are reached from the catalog', () => {
  const entry = (feature) => /nav: \{ to: '([^']+)', label: '([^']+)'/.exec(source(`${feature}/index.jsx`))?.slice(1) ?? null;
  assert.deepEqual(entry('catalog'), ['/catalog', 'Catalog']);
  assert.equal(entry('imports'), null);
  assert.deepEqual(entry('pages'), ['/pages', 'Landing pages']);
  assert.deepEqual(entry('themes'), ['/look', 'Shop look']);
  assert.deepEqual(entry('categories'), ['/categories', 'Categories']);
  assert.deepEqual(entry('creator'), ['/creator-page', 'Creator page']);
  assert.deepEqual(entry('leads'), ['/leads', 'Leads']);
  assert.match(source('catalog/form.js'), /\['\/imports', 'Imports'\]/);
});

test('what only owners and managers may change is only offered to them, and never asked for by anyone else', () => {
  for (const id of ['pageSettings.get', 'pageSettings.update', 'pageBlocks.get', 'pageBlocks.save', 'leads.remove', 'leadForms.get', 'leadForms.update', 'leadForms.setConsent', 'leadDownloads.list', 'leadDownloads.create']) {
    assert.deepEqual([...routes[id].access.roles], ['owner', 'manager'], id);
  }
  const marks = {
    'pages/PagesPage.jsx': ['{allowed(MANAGERS) && <AreaTabs'],
    'pages/PageSettingsPage.jsx': ['const canManage = allowed(MANAGERS)', 'enabled: canManage', '{canManage ? ('],
    'pages/PageLayoutPage.jsx': ['const canManage = allowed(MANAGERS)', 'enabled: canManage', '{canManage ? ('],
    'leads/LeadsPage.jsx': ['const canManage = allowed(MANAGERS)', '{canManage && <Downloads />}', '<LeadList canDelete={canManage} />', '{canDelete && <Button variant="danger"'],
    'leads/LeadFormPage.jsx': ['const canManage = allowed(MANAGERS)', 'enabled: canManage', '{canManage ? ('],
  };
  for (const [file, list] of Object.entries(marks)) for (const mark of list) assert.ok(source(file).includes(mark), `${file}: ${mark}`);
});

test('every screen says when it is loading, when it failed, and when there is nothing', () => {
  // Forms about one thing have nothing to be empty of; the Phase 0 category screens use the design system's Loadable, which has the same states.
  const withoutEmpty = new Set(['catalog/ProductEditorPage.jsx', 'pages/PageEditorPage.jsx', 'pages/NewPagePage.jsx', 'categories/CategoryFormPage.jsx']);
  for (const { name, text } of pages) {
    const states = [...text.matchAll(/<(Screen|Loadable)\b[^>]*>/g)];
    assert.ok(states.length > 0, `${name}: loading and error`);
    for (const match of states) assert.match(match[0], /\blabel="[^"]+"[^>]*\berrorTitle="[^"]+"/, `${name}: ${match[0]}`);
    if (!withoutEmpty.has(name)) assert.ok(text.includes('<EmptyState'), `${name}: empty`);
  }
  assert.ok(pages.length >= 14, `only ${pages.length} pages found`);
  for (const page of ['catalog/ProductEditorPage.jsx', 'imports/ImportJobPage.jsx', 'pages/PageEditorPage.jsx', 'categories/SequencePage.jsx', 'categories/CategoryFormPage.jsx']) {
    assert.match(source(page), /<(Screen|Loadable) query=\{\w+\} detail/, `${page}: a missing thing reads as missing`);
  }
});

test('the states of Phase 3\'s own: not on the plan, not switched on yet, and a missing thing', () => {
  const ui = source('catalog/shared/ui.jsx');
  assert.match(ui, /error\?\.status === 403 && error\?\.reason === PLAN_REASON/);
  assert.match(ui, /if \(isPlanRefusal\(query\.error\)\) return <PlanState/);
  assert.match(ui, /if \(detail && isMissing\(query\.error\)\) return <NotFoundState/);
  assert.match(ui, /notBuilt\(query\.error\)\) return <EmptyState title="This isn’t switched on yet"/);
  // A save the plan refuses says so as a plan matter, wherever a plan limit can be met (K-41, tier 1 add-ons).
  for (const file of ['pages/NewPagePage.jsx', 'pages/PageEditorPage.jsx', 'imports/ImportPage.jsx', 'categories/SequencePage.jsx', 'creator/CreatorPage.jsx', 'leads/LeadFormPage.jsx']) {
    assert.match(source(file), /isPlanRefusal\(/, file);
    assert.match(source(file), /<PlanState error=/, file);
  }
  assert.match(source('leads/LeadFormPage.jsx'), /if \(!settings\.available\) \{\s*return <EmptyState title="The lead form isn’t on your plan"/);
});

test('8.5: the fields a re-import keeps are named to the owner, one for one with the server\'s list', () => {
  const edited = /const EDITED_TEXT = \{([^}]+)\}/.exec(source('catalog/ProductEditorPage.jsx'))[1];
  assert.deepEqual([...edited.matchAll(/(\w+):/g)].map((m) => m[1]).sort(), [...OWNER_EDITABLE].sort());
});

test('8.7: nothing read from a page is saved until the owner has checked it', () => {
  const importPage = source('imports/ImportPage.jsx');
  assert.match(importPage, /api\.imports\.link\(body\)/);
  assert.doesNotMatch(importPage, /api\.(products\.create|importItems\.save)/, 'the import screen itself saves nothing');
  const review = source('imports/DraftReview.jsx');
  assert.match(review, /api\.importItems\.save\(itemId, body\)/);
  assert.match(review, /formToProduct\(form\.values\)/, 'what is saved is what the owner sees in the form');
});

test('direct links only: the console shows a page\'s own address, and builds no redirect or short link', () => {
  for (const { name, text } of code) {
    assert.doesNotMatch(text, /['"`/](go|l)\/\$?\{/, `${name}: a redirect path`);
    assert.doesNotMatch(text, /bit\.ly|tinyurl|shortener/i, name);
  }
  assert.match(source('pages/PageEditorPage.jsx'), /<CopyButton text=\{page\.url\}/);
  assert.match(source('creator/CreatorPage.jsx'), /<CopyButton text=\{page\.url\}/);
  assert.match(source('creator/CreatorPage.jsx'), /We never change your bio for you/);
});

test('F-103: choosing a look calls only the look\'s own route', () => {
  const theme = source('themes/ThemePage.jsx');
  assert.match(theme, /api\.themes\.choose\(\{ preset: picked, tuneAccent \}\)/);
  const calls = [...theme.matchAll(/\bapi\.(\w+)\.(\w+)/g)].map((m) => `${m[1]}.${m[2]}`);
  assert.deepEqual([...new Set(calls)].sort(), ['brandKit.update', 'themes.applySiteRead', 'themes.choose', 'themes.get', 'themes.presets', 'themes.readSite', 'themes.siteReads', 'themes.updateText']);
});

test('F-107: the looks are drawn from the rows the API sends; no screen names a preset', () => {
  for (const { name, text } of code) assert.doesNotMatch(text, /['"`](utsav|dewdrop|tadka|gadget-galli|mitti)['"`]|Utsav|Dewdrop|Tadka|Gadget Galli|Mitti/, `${name}: a preset named in code`);
});

test('the screens call only methods the shared client has', () => {
  const client = createApiClient();
  const calls = code.flatMap(({ name, text }) => [...text.matchAll(/\bapi\.([a-zA-Z]+)\.([a-zA-Z]+)/g)].map((m) => ({ name, group: m[1], method: m[2] })));
  assert.ok(calls.length > 50, `only ${calls.length} calls found`);
  for (const { name, group, method } of calls) assert.equal(typeof client[group]?.[method], 'function', `${name}: api.${group}.${method}`);
});

test('every Phase 3 seller route with a screen is used by one', () => {
  const used = new Set(code.flatMap(({ text }) => [...text.matchAll(/\bapi\.([a-zA-Z]+)\.([a-zA-Z]+)/g)].map((m) => `${m[1]}.${m[2]}`)));
  const expected = [
    'products.list', 'products.get', 'products.create', 'products.update', 'products.remove', 'products.recheck', 'catalogSettings.get', 'catalogSettings.update',
    'imports.link', 'imports.bulk', 'imports.csv', 'imports.shopify', 'imports.list', 'imports.adapters', 'imports.get', 'imports.items', 'importItems.save',
    'pages.list', 'pages.create', 'pages.media', 'pages.get', 'pages.update', 'pages.remove', 'pageSettings.get', 'pageSettings.update', 'pageBlocks.get', 'pageBlocks.save',
    'themes.presets', 'themes.get', 'themes.choose', 'themes.updateText', 'themes.readSite', 'themes.siteReads', 'themes.applySiteRead',
    'categories.list', 'categories.get', 'categories.create', 'categories.update', 'categories.remove', 'categories.reels', 'categories.setReels', 'categories.addReel',
    'categories.removeReel', 'categories.pin', 'categories.unpin', 'categories.schedule', 'categories.rules', 'categories.addRule', 'categoryRules.update', 'categoryRules.remove', 'categoryRules.apply',
    'creator.get', 'creator.update', 'creator.checkSlug',
    'leads.list', 'leads.remove', 'leads.revokeConsent', 'leadForms.get', 'leadForms.update', 'leadForms.setConsent', 'leadDownloads.list', 'leadDownloads.create',
  ];
  for (const id of expected) {
    assert.ok(routes[id], `${id}: not a route`);
    assert.ok(used.has(id), `${id}: no screen calls it`);
  }
});

test('console files import nothing from outside the console but the API\'s access rules', () => {
  for (const { name, text } of code) {
    for (const [, from] of text.matchAll(/from '([^']+)'/g)) {
      if (from.startsWith('@contracts/')) assert.equal(from, '@contracts/access.js', `${name}: ${from}`);
      else if (from.startsWith('.')) assert.ok(!path.relative(path.join(repoRoot, 'console/src'), path.resolve(featuresDir, path.dirname(name), from)).startsWith('..'), `${name}: ${from}`);
      else assert.match(from, /^(react|react-router-dom|@tanstack\/react-query|lucide-react)$/, `${name}: ${from}`);
    }
  }
});

test('screens use the design system\'s names: no raw colour, no console call, nothing kept in the browser', () => {
  for (const { name, text } of files) {
    if (name.endsWith('.css')) {
      assert.doesNotMatch(text, /#[0-9a-f]{3,8}\b|rgba?\(/i, `${name}: a raw colour`);
      continue;
    }
    assert.doesNotMatch(text, /\bconsole\.(log|warn|error|info|debug)\(/, `${name}: a console call`);
    assert.doesNotMatch(text, /localStorage|sessionStorage|document\.cookie/, `${name}: browser storage`);
    assert.doesNotMatch(text, /dangerouslySetInnerHTML|innerHTML/, `${name}: raw HTML`);
    assert.doesNotMatch(text, /(?<![\w.])fetch\(|XMLHttpRequest/, `${name}: a call that doesn't go through the API client`);
  }
  // A seller's look is the one place colours come from data: they are set as styles from the look's own values, never written here.
  for (const { name, text } of code) if (!name.startsWith('themes/')) assert.doesNotMatch(text, /['"]#[0-9a-fA-F]{6}['"]/, `${name}: a raw colour`);
});

test('every class the screens use is defined in the design system or the Phase 3 stylesheet', () => {
  const css = ['console/src/design/base.css', 'console/src/design/components.css', 'console/src/design/screens.css', 'console/src/features/catalog/shared/p3.css']
    .map((file) => fs.readFileSync(path.join(repoRoot, file), 'utf8')).join('\n');
  const defined = new Set([...css.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]));
  for (const { name, text } of code.filter((file) => file.name.endsWith('.jsx'))) {
    for (const [, list] of text.matchAll(/className="([^"]+)"/g)) for (const cls of list.split(/\s+/).filter(Boolean)) assert.ok(defined.has(cls), `${name}: .${cls} has no style`);
    for (const [, cls] of text.matchAll(/className=\{`([a-z0-9-]+)[ $`]/g)) assert.ok(defined.has(cls), `${name}: .${cls} has no style`);
    for (const [, cls] of text.matchAll(/' (p3-[a-z0-9-]+)'/g)) assert.ok(defined.has(cls), `${name}: .${cls} has no style`);
  }
});

test('buyers never see the platform, and sellers never see a client\'s name in code (5.18)', () => {
  for (const { name, text } of code) {
    // The console is Bhava's own, so its name may appear in words to the seller; a sample business may not appear at all.
    assert.doesNotMatch(text, /kesar|leafy|plants\.example/i, `${name}: a sample business`);
    assert.doesNotMatch(text, /tenant(Id|_id)? ?===? ?['"\d]/, `${name}: a business compared with a fixed value`);
  }
});
