/**
 * What holds across the automation-side features (home, automations, inbox, connect, compliance, links, alerts,
 * activity, reels, domains): every word they ask for exists in English and Hindi, nothing is logged, nothing opens a
 * web view or keeps data outside the offline cache, and each screen is there only for someone the API would answer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { checkCatalogue } from '@bhava/app-core';
import { routeList } from '../../../../../src/contracts/api/index.js';
import { features, featureByName } from '../index.js';
import { buildNavigation } from '../../shell/menu.js';
import { catalogue } from '../../strings.js';

const AREAS = ['home', 'automations', 'inbox', 'connect', 'compliance', 'links', 'alerts', 'activity', 'reels', 'domains'];
const FEATURES = path.resolve(__dirname, '..');
const sources = (area) => fs.readdirSync(path.join(FEATURES, area)).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && f !== 'testing.js').map((f) => [`${area}/${f}`, fs.readFileSync(path.join(FEATURES, area, f), 'utf8')]);
const ALL = AREAS.flatMap(sources);
const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('every string key these screens name has a line in English and in Hindi', () => {
  expect(checkCatalogue(catalogue)).toEqual([]);
  const routeIds = new Set(routeList.map((route) => route.id));
  const screenNames = new Set(features.flatMap((feature) => feature.screens.map((screen) => `${feature.name}.${screen.name}`)));
  const prefixes = Object.keys(featureByName).map((name) => name.replace(/[-]/g, '\\-')).join('|');
  const key = new RegExp(`['\`]((?:${prefixes}|common|error|offline)\\.[A-Za-z0-9_.]+)['\`]`, 'g');
  const missing = [];
  for (const [file, text] of ALL) {
    for (const [, found] of withoutComments(text).matchAll(key)) {
      if (routeIds.has(found) || screenNames.has(found) || found.endsWith('.')) continue;
      if (typeof catalogue.en[found] !== 'string' || typeof catalogue.hi[found] !== 'string') missing.push(`${file}: ${found}`);
    }
  }
  expect(missing).toEqual([]);
});

test('the families of keys built from codes are complete for every code', () => {
  const families = {
    'automations.state.': ['draft', 'test', 'live', 'paused', 'archived'],
    'automations.move.': ['test', 'live', 'paused', 'draft', 'archived'],
    'automations.done.': ['saved', 'test', 'live', 'paused', 'draft', 'archived'],
    'automations.trigger.': ['comment', 'story_reply', 'story_mention', 'dm_keyword', 'dm_welcome'],
    'automations.trigger.short.': ['comment', 'story_reply', 'story_mention', 'dm_keyword', 'dm_welcome'],
    'automations.link.type.': ['seller_site', 'bhava_page', 'amazon', 'affiliate', 'whatsapp'],
    'automations.media.kind.': ['reel', 'post', 'story'],
    'automations.media.filter.': ['all', 'reel', 'post', 'story'],
    'inbox.status.': ['open', 'needs_human', 'closed'],
    'inbox.kind.': ['story_reply', 'story_mention', 'postback', 'attachment'],
    'inbox.needsHuman.kind.': ['negative_comment', 'handoff', 'send_failed', 'unknown_outcome', 'why_no_dm'],
    'home.band.': ['good', 'watch', 'at_risk'],
    'home.step.': ['instagram', 'store_details', 'products', 'reel', 'comment', 'order'],
    'reels.kind.': ['reel', 'post'],
  };
  const missing = Object.entries(families).flatMap(([prefix, codes]) => codes.map((code) => `${prefix}${code}`)).filter((k) => !(k in catalogue.en) || !(k in catalogue.hi));
  expect(missing).toEqual([]);
});

test('nothing here writes to a log: a commenter’s name, words or number reach the screen and nowhere else', () => {
  const logged = ALL.filter(([, text]) => /\bconsole\.(log|info|warn|error|debug)\b|\breportError\b|\blogger\b/.test(withoutComments(text))).map(([file]) => file);
  expect(logged).toEqual([]);
});

test('nothing here opens a web view or keeps data outside the offline cache', () => {
  const found = ALL.filter(([, text]) => /react-native-webview|<WebView|AsyncStorage|expo-sqlite|SecureStore/.test(withoutComments(text))).map(([file]) => file);
  expect(found).toEqual([]);
});

test('each screen is there only for someone the API would answer', () => {
  const sees = (user) => new Set(buildNavigation(features, { user, entitlements: null }).screens.map((screen) => screen.feature));
  const owner = sees({ id: 1, role: 'owner', permissions: [] });
  for (const area of AREAS) expect([area, owner.has(area)]).toEqual([area, true]);
  const ordersOnly = sees({ id: 3, role: 'staff', permissions: ['orders'] });
  expect(AREAS.filter((area) => ordersOnly.has(area))).toEqual(['home']);
  const inboxOnly = sees({ id: 4, role: 'staff', permissions: ['inbox'] });
  expect(AREAS.filter((area) => inboxOnly.has(area))).toEqual(['home', 'inbox']);
  const automationsOnly = sees({ id: 5, role: 'staff', permissions: ['automations'] });
  expect(AREAS.filter((area) => automationsOnly.has(area)).sort()).toEqual(['activity', 'alerts', 'automations', 'compliance', 'connect', 'home', 'links', 'reels']);
  const catalogOnly = sees({ id: 6, role: 'staff', permissions: ['catalog'] });
  expect(AREAS.filter((area) => catalogOnly.has(area))).toEqual(['home', 'domains']);
  const noPlan = new Set(buildNavigation(features, { user: { id: 1, role: 'owner', permissions: [] }, entitlements: { automations: false, custom_domain: false } }).screens.map((s) => s.feature));
  expect(noPlan.has('automations')).toBe(false);
  expect(noPlan.has('domains')).toBe(false);
});

test('every route id these features list is one the API has, and every route their screens call is listed', () => {
  const ids = new Set(routeList.map((route) => route.id));
  for (const area of AREAS) {
    for (const id of featureByName[area].routeIds) if (!id.startsWith('console:')) expect([area, id, ids.has(id)]).toEqual([area, id, true]);
  }
  // api.<group>.<method>( in each feature's own files, by the client's naming, which is the route id's.
  const unlisted = [];
  for (const [file, text] of ALL) {
    const area = file.split('/')[0];
    for (const [, group, method] of text.matchAll(/\bapi\.([a-zA-Z]+)\.([a-zA-Z]+)\(/g)) {
      const id = `${group}.${method}`;
      if (ids.has(id) && !featureByName[area].routeIds.includes(id)) unlisted.push(`${file} calls ${id}`);
    }
  }
  expect(unlisted).toEqual([]);
});
