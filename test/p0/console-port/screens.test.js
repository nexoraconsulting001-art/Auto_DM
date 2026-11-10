// How the console's screens are wired together, and that they agree with the API contract and the server's rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { IMAGE_UPLOAD, ORDER_STATUSES, routes } from '../../../src/contracts/api/index.js';
import { createApiClient } from '../../../shared/api-client/index.js';
import { COLOR_KEYS, FONTS, contrastRatio as serverContrast } from '../../../src/modules/brand/theme.js';
import { COLOR_SLOTS, FONT_CHOICES, contrastRatio } from '../../../console/src/features/brand-kit/options.js';
import { ORDER_STATUS } from '../../../console/src/features/orders/status.js';
import { IMAGE_TYPES, MAX_IMAGE_BYTES } from '../../../console/src/lib/images.js';
import { repoRoot } from '../backend-gaps/support.js';

const featuresDir = path.join(repoRoot, 'console/src/features');
const SCREENS = {
  home: ['index'],
  products: ['products', 'products/new', 'products/:id'],
  categories: ['categories', 'categories/new', 'categories/:id'],
  reels: ['reels', 'reels/:id'],
  orders: ['orders', 'orders/:id'],
  customers: ['customers'],
  activity: ['activity'],
  settings: ['settings'],
  'brand-kit': ['brand-kit'],
};

function read(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? read(full) : [full];
  });
}
const sourceFiles = read(path.join(repoRoot, 'console/src')).filter((file) => /\.jsx?$/.test(file));
const sources = sourceFiles.map((file) => ({ file: path.relative(repoRoot, file).replaceAll('\\', '/'), text: fs.readFileSync(file, 'utf8') }));
const featureIndex = (name) => fs.readFileSync(path.join(featuresDir, name, 'index.jsx'), 'utf8');

test('every screen of the old admin has a feature with its routes', () => {
  assert.deepEqual(fs.readdirSync(featuresDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(), Object.keys(SCREENS).sort());
  for (const [feature, paths] of Object.entries(SCREENS)) {
    const text = featureIndex(feature);
    for (const route of paths) {
      assert.ok(route === 'index' ? text.includes('index: true') : text.includes(`path: '${route}'`), `${feature}: ${route}`);
    }
  }
});

test('a page loads only when opened', () => {
  for (const feature of Object.keys(SCREENS)) assert.match(featureIndex(feature), /lazy\(\(\) => import\(/, feature);
});

test('each feature asks for the same access as the API routes behind it', () => {
  const expected = {
    products: ["staffWith('catalog')", 'products.list'],
    categories: ["staffWith('catalog')", 'categories.list'],
    reels: ["staffWith('automations')", 'reels.list'],
    orders: ["staffWith('orders')", 'orders.list'],
    customers: ["staffWith('customers')", 'customers.list'],
    activity: ["staffWith('automations')", 'activity.list'],
    settings: ['MANAGERS', 'settings.get'],
    'brand-kit': ['MANAGERS', 'brandKit.get'],
  };
  for (const [feature, [access, routeId]] of Object.entries(expected)) {
    assert.ok(featureIndex(feature).includes(`access: ${access}`), feature);
    const named = access.startsWith('staffWith') ? { permission: access.slice(11, -2), roles: ['owner', 'manager', 'staff'] } : { roles: ['owner', 'manager'] };
    assert.deepEqual({ permission: routes[routeId].access.permission, roles: [...routes[routeId].access.roles] }, { permission: named.permission, roles: named.roles }, routeId);
  }
});

test('the console calls only methods the shared client has', () => {
  const client = createApiClient();
  const calls = sources.flatMap(({ file, text }) => [...text.matchAll(/\bapi\.([a-zA-Z]+)\.([a-zA-Z]+)/g)].map((m) => ({ file, group: m[1], method: m[2] })));
  assert.ok(calls.length > 25);
  for (const { file, group, method } of calls) assert.equal(typeof client[group]?.[method], 'function', `${file}: api.${group}.${method}`);
});

test('the console imports nothing the Docker build doesn\'t copy', () => {
  for (const { file, text } of sources) {
    for (const [, target] of text.matchAll(/from '([^']+)'/g)) {
      if (target.startsWith('@contracts/')) {
        assert.equal(target, '@contracts/access.js', `${file}: importing the rest of the contract would pull zod into the page`);
      } else if (target.startsWith('.')) {
        const resolved = path.resolve(repoRoot, path.dirname(file), target);
        assert.ok(resolved.startsWith(path.join(repoRoot, 'console', 'src')), `${file}: ${target}`);
      }
    }
  }
});

test('no console screen reaches past the API client', () => {
  for (const { file, text } of sources) {
    assert.doesNotMatch(text, /\bfetch\(|XMLHttpRequest|\/admin\/media|axios/, file);
  }
});

test('every list and detail screen has its loading, error and empty states', () => {
  const screens = {
    'features/products/ProductsPage.jsx': { empty: true },
    'features/categories/CategoriesPage.jsx': { empty: true },
    'features/reels/ReelsPage.jsx': { empty: true },
    'features/orders/OrdersPage.jsx': { empty: true },
    'features/customers/CustomersPage.jsx': { empty: true },
    'features/activity/ActivityPage.jsx': { empty: true },
    'features/home/HomePage.jsx': { empty: true },
    'features/products/ProductFormPage.jsx': {},
    'features/categories/CategoryFormPage.jsx': {},
    'features/reels/ReelFormPage.jsx': {},
    'features/orders/OrderPage.jsx': {},
    'features/settings/SettingsPage.jsx': {},
    'features/brand-kit/BrandKitPage.jsx': {},
  };
  for (const [screen, { empty }] of Object.entries(screens)) {
    const text = sources.find(({ file }) => file.endsWith(screen)).text;
    assert.match(text, /<Loadable[^>]*\blabel="[^"]+"[^>]*\berrorTitle="[^"]+"/, `${screen}: loading and error`);
    if (empty) assert.match(text, /<EmptyState/, `${screen}: empty`);
  }
});

test('the console\'s lists of statuses, image types, colours and fonts match the server\'s', () => {
  assert.deepEqual(Object.keys(ORDER_STATUS).sort(), [...ORDER_STATUSES].sort());
  assert.deepEqual([...IMAGE_TYPES].sort(), [...IMAGE_UPLOAD.mimeTypes].sort());
  assert.equal(MAX_IMAGE_BYTES, IMAGE_UPLOAD.maxBytes);
  assert.deepEqual(COLOR_SLOTS.map(([key]) => key).sort(), [...COLOR_KEYS].sort());
  assert.deepEqual([...FONT_CHOICES].sort(), Object.keys(FONTS).sort());
  for (const [a, b] of [['#000000', '#FFFFFF'], ['#3B2FC9', '#FFFFFF'], ['#234D33', '#F6F5F1']]) assert.equal(contrastRatio(a, b), serverContrast(a, b));
});

test('F-75: the console is Bhava\'s; a seller\'s logo appears only as the workspace identity', () => {
  const uses = sources.filter(({ text }) => /business\.logoUrl|\.logoUrl\b/.test(text)).map(({ file }) => file).sort();
  assert.deepEqual(uses, [
    'console/src/features/brand-kit/BrandKitPage.jsx', // editing the kit
    'console/src/features/brand-kit/options.js', // editing the kit
    'console/src/features/reels/ReelFormPage.jsx', // the preview of the shopper's DM
    'console/src/shell/AppShell.jsx', // the workspace identity
  ]);
  const shell = sources.find(({ file }) => file.endsWith('shell/AppShell.jsx')).text;
  assert.match(shell, /logo-white\.svg/);
  assert.match(sources.find(({ file }) => file.endsWith('shell/LoginPage.jsx')).text, /logo\.svg/);
});

test('U-10, F-119: the console offers no raw event log export', () => {
  for (const { file, text } of sources) assert.doesNotMatch(text, /raw[ -_]?(event|log|export)|\.csv\b|download=/i, file);
});

test('what a shopper receives carries no Bhava text', () => {
  const reelForm = fs.readFileSync(path.join(featuresDir, 'reels/form.js'), 'utf8');
  const start = reelForm.indexOf('export const NEW_REEL');
  const defaults = reelForm.slice(start, reelForm.indexOf('});', start));
  assert.doesNotMatch(defaults, /bhava/i);
  assert.doesNotMatch(sources.find(({ file }) => file.endsWith('reels/ReelFormPage.jsx')).text.match(/function DmPreview[\s\S]*?\n}\n/)[0], /bhava/i);
});

test('DM links are the reel\'s own store link: the console never builds a redirect', () => {
  for (const { file, text } of sources) assert.doesNotMatch(text, /\/l\/|shorten|bit\.ly|redirect=/i, file);
});

test('no console screen logs anything', () => {
  for (const { file, text } of sources) assert.doesNotMatch(text, /console\.(log|info|warn|error|debug)\(/, file);
});
