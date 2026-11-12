import assert from 'node:assert/strict';
import test from 'node:test';
import { APP_LINK_PATHS, namesPlatform } from '../../../src/contracts/apps.js';
import { appleSiteFile, assetLinksFile, bannerFor, platformOfAgent } from '../../../src/modules/app-links/index.js';
import { TEST_SIGNING_SHA256, enableApp, seedReel, startApp } from '../../helpers.js';
import { modulesWithGate } from './support.js';

// Deep links (PRD 10.12): the two verified-link files per business host, and the install banner on buyer pages.

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const OTHER_PRINT = Array.from({ length: 32 }, (_, i) => (255 - i).toString(16).toUpperCase().padStart(2, '0')).join(':');

async function twoBusinesses() {
  const app = await startApp({ modules: modulesWithGate() });
  const other = await app.platform.tenants.ensure({ slug: 'mehndi', name: 'Mehndi House' });
  await app.db.platform.query("INSERT INTO tenant_domains (domain, tenant_id) VALUES ('shop.kesar.test', $1)", [app.tenant.id]);
  return { app, other };
}

const get = (app, path, { host = 'default.bhava.test', ua = DESKTOP_UA, headers = {} } = {}) =>
  fetch(`${app.base}${path}`, { redirect: 'manual', headers: { 'x-forwarded-host': host, 'user-agent': ua, ...headers } });

test('P-53 the AASA file on the business\'s host is 200 JSON, no redirect, with only its own team and bundle id', async () => {
  const { app, other } = await twoBusinesses();
  try {
    await enableApp(app, { platforms: ['android', 'ios'], config: { ios_bundle_id: 'com.example.kesar', apple_team_id: 'KESAR12345' } });
    await enableApp(app, { tenant: other, platforms: ['android', 'ios'], config: { ios_bundle_id: 'com.example.mehndi', apple_team_id: 'MEHND12345', android_package: 'com.example.mehndi', play_signing_sha256: [OTHER_PRINT] } });

    for (const host of ['default.bhava.test', 'shop.kesar.test']) {
      const res = await get(app, '/.well-known/apple-app-site-association', { host });
      assert.equal(res.status, 200, host);
      assert.match(res.headers.get('content-type'), /^application\/json/);
      assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
      assert.equal(res.headers.get('location'), null);
      assert.equal(res.headers.get('set-cookie'), null, 'no cookie on a well-known file');
      const body = await res.json();
      assert.deepEqual(body.applinks.details.map((d) => d.appIDs), [['KESAR12345.com.example.kesar']]);
      const components = body.applinks.details[0].components;
      assert.deepEqual(components.filter((c) => c.exclude).map((c) => c['/']), [...APP_LINK_PATHS.exclude]);
      assert.deepEqual(components.filter((c) => !c.exclude).map((c) => c['/']), [...APP_LINK_PATHS.open]);
      assert.ok(components.findIndex((c) => !c.exclude) > components.findLastIndex((c) => c.exclude), 'exclusions come first');
      const text = JSON.stringify(body);
      assert.ok(!text.includes('mehndi') && !text.includes('MEHND'), 'nothing of the other business');
      assert.equal(namesPlatform(text), false);
    }
    const theirs = await (await get(app, '/.well-known/apple-app-site-association', { host: 'mehndi.bhava.test' })).json();
    assert.deepEqual(theirs.applinks.details[0].appIDs, ['MEHND12345.com.example.mehndi']);

    const links = await get(app, '/.well-known/assetlinks.json');
    assert.equal(links.status, 200);
    assert.equal(links.headers.get('set-cookie'), null);
    assert.deepEqual(await links.json(), [{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: `com.example.t${app.tenant.id}`, sha256_cert_fingerprints: [TEST_SIGNING_SHA256] },
    }]);
    const theirLinks = await (await get(app, '/.well-known/assetlinks.json', { host: 'mehndi.bhava.test' })).json();
    assert.deepEqual(theirLinks[0].target, { namespace: 'android_app', package_name: 'com.example.mehndi', sha256_cert_fingerprints: [OTHER_PRINT] });
  } finally {
    app.close();
  }
});

test('a host with no app, without that platform, or that is no business\'s own gets the plain 404', async () => {
  const { app, other } = await twoBusinesses();
  try {
    // No app at all for this business.
    for (const path of ['/.well-known/assetlinks.json', '/.well-known/apple-app-site-association']) {
      const res = await get(app, path, { host: 'mehndi.bhava.test' });
      assert.equal(res.status, 404, path);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('set-cookie'), null);
      assert.equal(await res.text(), 'Not found.');
    }
    // Android only: the AASA file is 404, and so is assetlinks without a fingerprint.
    await enableApp(app, { tenant: other, platforms: ['android'], config: { android_package: 'com.example.mehndi', play_signing_sha256: [] } });
    assert.equal((await get(app, '/.well-known/apple-app-site-association', { host: 'mehndi.bhava.test' })).status, 404);
    assert.equal((await get(app, '/.well-known/assetlinks.json', { host: 'mehndi.bhava.test' })).status, 404, 'no fingerprint, no file');
    // The row is there but the plan does not include iOS.
    await enableApp(app, { platforms: ['android'] });
    assert.equal((await get(app, '/.well-known/apple-app-site-association')).status, 404, 'app_configs alone is not the iOS app');
    assert.equal((await get(app, '/.well-known/assetlinks.json')).status, 200);
    // An address that only falls back to the default business is not its own, and neither is the sign-in host.
    assert.equal((await get(app, '/.well-known/assetlinks.json', { host: 'unknown.example' })).status, 404);
    assert.equal((await get(app, '/.well-known/assetlinks.json', { host: 'app.bhava.test' })).status, 404);
    // The plan stops including Android: the file goes with it.
    await app.db.platform.query("UPDATE tenant_features SET enabled = false WHERE tenant_id = $1 AND feature = 'app.android'", [app.tenant.id]);
    assert.equal((await get(app, '/.well-known/assetlinks.json')).status, 404);
  } finally {
    app.close();
  }
});

test('the well-known files are pure: package, fingerprints, team and bundle id of the row given, nothing else', () => {
  const row = { android_package: 'com.example.a', play_signing_sha256: [TEST_SIGNING_SHA256.toLowerCase(), 'junk'], apple_team_id: 'ABCDE12345', ios_bundle_id: 'com.example.a' };
  assert.deepEqual(assetLinksFile(row, { android: true })[0].target.sha256_cert_fingerprints, [TEST_SIGNING_SHA256]);
  assert.equal(assetLinksFile(row, { android: false }), null);
  assert.equal(assetLinksFile({ ...row, android_package: null }, { android: true }), null);
  assert.equal(appleSiteFile({ ...row, apple_team_id: '' }, { ios: true }), null);
  assert.equal(appleSiteFile(row, { ios: false }), null);
  assert.deepEqual(Object.keys(appleSiteFile(row, { ios: true })), ['applinks']);
  assert.equal(platformOfAgent(ANDROID_UA), 'android');
  assert.equal(platformOfAgent(IPHONE_UA), 'ios');
  assert.equal(platformOfAgent(DESKTOP_UA), null);
});

async function liveApp(app, platform, { state = 'live', config = {} } = {}) {
  await enableApp(app, { platforms: ['android', 'ios'], config: {
    android_store_url: `https://play.google.com/store/apps/details?id=com.example.t${app.tenant.id}`, ios_store_url: 'https://apps.apple.com/in/app/kesar/id6449812345',
    app_name: 'Kesar Home', short_name: 'Kesar', ...config,
  } });
  await app.db.platform.query(
    `INSERT INTO app_submissions (tenant_id, platform, state) VALUES ($1, $2, 'draft') ON CONFLICT (tenant_id, platform) DO NOTHING`,
    [app.tenant.id, platform],
  );
  // The state is the submissions track's to move; a test sets it directly, past its transition trigger.
  await app.db.platform.exec('ALTER TABLE app_submissions DISABLE TRIGGER app_submissions_transition');
  await app.db.platform.query('UPDATE app_submissions SET state = $3 WHERE tenant_id = $1 AND platform = $2', [app.tenant.id, platform, state]);
  await app.db.platform.exec('ALTER TABLE app_submissions ENABLE TRIGGER app_submissions_transition');
}

test('P-52 without the app, a DM link opens the web landing page with an install banner for the phone\'s platform', async () => {
  const app = await startApp({ modules: modulesWithGate() });
  try {
    await seedReel(app.repos);
    const [{ slug }] = await app.db.platform.query('SELECT slug FROM reels WHERE tenant_id = $1', [app.tenant.id]);
    const dmLink = `/r/${slug}?src=dm`;
    const before = await get(app, dmLink, { ua: ANDROID_UA });
    assert.equal(before.status, 200);
    assert.ok(!(await before.text()).includes('data-app-banner'), 'no app, no banner');

    await liveApp(app, 'android');
    // The business's own domain: the link the DM carries, and the one the banner hands to the app.
    await app.db.platform.query("INSERT INTO tenant_domains (domain, tenant_id) VALUES ('shop.kesar.test', $1)", [app.tenant.id]);
    const res = await get(app, dmLink, { ua: ANDROID_UA, host: 'shop.kesar.test' });
    assert.equal(res.status, 200, 'the DM link is answered where it is, no redirect');
    assert.equal(res.headers.get('location'), null);
    const landing = await res.text();
    const href = /data-app-banner[\s\S]*?<a href="([^"]+)"/.exec(landing)?.[1]?.replaceAll('&amp;', '&');
    assert.ok(href, 'an Android phone sees the banner');
    const store = `https://play.google.com/store/apps/details?id=com.example.t${app.tenant.id}`;
    assert.equal(href, `intent://shop.kesar.test${dmLink}#Intent;scheme=https;package=com.example.t${app.tenant.id};S.browser_fallback_url=${encodeURIComponent(store)};end`);
    const banner = /<div data-app-banner[\s\S]*?<\/a><\/div>/.exec(landing)[0];
    assert.match(banner, /Open in app/);
    assert.match(banner, /Kesar/);
    assert.match(banner, /var\(--gold/, 'in the seller\'s own colours');
    assert.equal(namesPlatform(banner), false, 'no platform name in the banner');
    assert.ok(!/<script/i.test(banner), 'no script of ours');
    assert.equal((landing.match(/data-app-banner/g) ?? []).length, 1, 'one banner');

    // Desktop and iPhone (iOS not live) see nothing; a request from the app itself sees nothing.
    assert.ok(!(await (await get(app, '/', { ua: DESKTOP_UA })).text()).includes('data-app-banner'));
    const iphone = await (await get(app, '/', { ua: IPHONE_UA })).text();
    assert.ok(!iphone.includes('apple-itunes-app') && !iphone.includes('data-app-banner'), 'iOS not live: nothing');
    assert.ok(!(await (await get(app, dmLink, { ua: ANDROID_UA, headers: { 'x-app': 'shopper' } })).text()).includes('data-app-banner'), 'not inside the app');

    await liveApp(app, 'ios');
    const ios = await (await get(app, '/shop?sort=newest', { ua: IPHONE_UA })).text();
    const meta = /<meta name="apple-itunes-app" content="([^"]+)">/.exec(ios)?.[1]?.replaceAll('&amp;', '&');
    assert.equal(meta, 'app-id=6449812345, app-argument=http://default.bhava.test/shop?sort=newest');
    assert.ok(ios.indexOf('apple-itunes-app') < ios.indexOf('</head>'), 'the meta tag is in the head');
    assert.ok(!ios.includes('data-app-banner'), 'Safari shows its own banner: no second one');
    // Instagram's in-app browser shows no Safari banner, so the page carries one that opens the App Store page.
    const insta = await (await get(app, dmLink, { ua: `${IPHONE_UA} Instagram 350.0.0.0 (iPhone15,2; iOS 18_0; en_IN)`, host: 'shop.kesar.test' })).text();
    const iosHref = /data-app-banner[\s\S]*?<a href="([^"]+)"/.exec(insta)?.[1];
    assert.equal(iosHref, 'https://apps.apple.com/in/app/kesar/id6449812345');

    // Not a buyer page: nothing added.
    const json = await get(app, '/api/store/app/push/prefs', { ua: ANDROID_UA });
    assert.ok(!(await json.text()).includes('data-app-banner'));
  } finally {
    app.close();
  }
});

test('an app in review shows no "Open in app"; the payment page opened from the app reads "Back to the app"', async () => {
  const app = await startApp({ modules: modulesWithGate() });
  try {
    await liveApp(app, 'android', { state: 'in_review' });
    assert.ok(!(await (await get(app, '/', { ua: ANDROID_UA })).text()).includes('data-app-banner'), 'in review: not live');
    const state = { app_name: 'Kesar Home', short_name: 'Kesar', android_package: 'com.example.kesar', ios_bundle_id: 'com.example.kesar', url_scheme: 'kesar', state: 'in_review' };
    const back = bannerFor({ platform: 'android', state, host: 'shop.kesar.test', path: '/order/AbCdEf123456', originalUrl: '/order/AbCdEf123456?app=1', protocol: 'https', query: { app: '1' } });
    assert.match(back.body, /href="kesar:\/\/order\/AbCdEf123456"/);
    assert.match(back.body, /Back to the app/);
    assert.equal(bannerFor({ platform: 'android', state, host: 'h', path: '/order/AbCdEf123456', originalUrl: '/order/AbCdEf123456', protocol: 'https', query: {} }), null, 'without app=1 it is the ordinary rule');
    assert.equal(bannerFor({ platform: 'android', state: { ...state, url_scheme: null }, host: 'h', path: '/order/AbCdEf123456', originalUrl: '/x', protocol: 'https', query: { app: '1' } }), null);
    const live = bannerFor({ platform: 'android', state: { ...state, state: 'live' }, host: 'h', path: '/p/x', originalUrl: '/p/x?a="><script>', protocol: 'https', query: {} });
    assert.ok(!live.body.includes('"><script>'), 'the address is escaped into the link');
  } finally {
    app.close();
  }
});
