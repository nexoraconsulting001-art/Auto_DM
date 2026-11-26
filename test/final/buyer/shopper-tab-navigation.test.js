// Final loop 1 (Maestro shopper: P-28, P-29, P-30, P-46, P-64): the shopper app's tabs are one navigator nested in the
// root stack, and every other screen (product, checkout, an order, a finished deletion) sits on that stack above them.
// React Navigation 7 sends navigate() only up the tree, so navigate('cart.index') from a stack screen reached no navigator
// and did nothing, and the tab bar is not on screen there. A tab's screen is opened through the tabs (shell/menu.js openTab).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const APP = path.join(ROOT, 'apps/shopper/src');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

/** The registry's tab screens, read from each feature's index.js: '<feature>.<first screen>' for a feature with nav. */
function tabScreens() {
  const names = [];
  for (const dir of fs.readdirSync(path.join(APP, 'features'), { withFileTypes: true })) {
    const file = path.join('features', dir.name, 'index.js');
    if (!dir.isDirectory() || !fs.existsSync(path.join(APP, file))) continue;
    const text = read(file);
    if (!/\bnav:\s*\{/.test(text)) continue;
    const feature = text.match(/\bname:\s*'([a-z0-9-]+)'/)[1];
    const first = text.match(/screens:\s*\[\s*\{\s*name:\s*'([A-Za-z0-9]+)'/)[1];
    names.push(`${feature}.${first}`);
  }
  return names.sort();
}

function sources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(file, out);
    else if (/\.js$/.test(entry.name) && !/\.(test|fixture)\.js$/.test(entry.name)) out.push(file);
  }
  return out;
}

test('openTab opens a tab’s screen through the tabs navigator, from any screen', async () => {
  const { TABS, openTab } = await import(pathToFileURL(path.join(APP, 'shell/menu.js')).href);
  const calls = [];
  const navigation = { navigate: (...args) => calls.push(args) };
  openTab(navigation, 'cart.index');
  openTab(navigation, 'catalog.index', { sort: 'new' });
  assert.deepEqual(calls, [[TABS, { screen: 'cart.index', params: undefined }], [TABS, { screen: 'catalog.index', params: { sort: 'new' } }]]);
});

test('no shopper screen navigates to a tab’s screen by its bare name', () => {
  const tabs = tabScreens();
  assert.deepEqual(tabs, ['account.index', 'cart.index', 'catalog.index', 'home.index', 'reels.index']);
  const bare = new RegExp(String.raw`\.navigate\(\s*'(${tabs.map((t) => t.replace('.', '\.')).join('|')})'`);
  const found = sources(APP).filter((file) => bare.test(fs.readFileSync(file, 'utf8'))).map((file) => path.relative(ROOT, file));
  assert.deepEqual(found, []);
});

test('the product page offers the cart once a line is added, since the tab bar is not on screen there', () => {
  const text = read('features/product/ProductScreen.js');
  assert.match(text, /testID="added-go-cart"[^\n]*openTab\(navigation, 'cart\.index'\)/);
  const strings = read('features/product/index.js');
  for (const key of ['product.added', 'product.goToCart']) assert.equal(strings.split(`'${key}'`).length - 1, 2, `${key} in en and hi`);
});
