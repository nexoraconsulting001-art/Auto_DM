// PRD 10.12 (deep links from DM links): the app opens the same direct link a DM carries, with no token and no click call; without
// the app the landing page shows an "Open in app" banner; the two verified-link files are built per business host from its own
// config and served as they are. P-50, P-51, P-52, P-53, P-54 (the server half; the emulator's verification is the CI job's).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_LINK_PATHS, APP_ROUTES, OTHER_SHA256, SIGNING_SHA256, UA, accepted, addAppShop, addP4Shop, apps, assertNoPlatformName, hit, namesPlatform, stockedProducts, useP6World,
} from './kit.js';

const world = useP6World();

async function linkShop(options = {}) {
  const shop = await addAppShop(world, options);
  const products = await stockedProducts(shop, 2);
  const page = await shop.page({ productIds: products.map((p) => p.id), caption: 'Brunch edit' });
  return { shop, products, page };
}

const wellKnown = (shop, file, { host = shop.host, headers = {}, method = 'GET' } = {}) => hit(world, `/.well-known/${file}`, { host, method, headers });
const flat = (res) => JSON.stringify(JSON.parse(res.text));

test('P-53: the AASA file on the business\'s host is 200 JSON with no redirect, with its own team and bundle ID and the shared path list', async () => {
  const { shop } = await linkShop({ platforms: ['ios'], config: { apple_team_id: 'TEAM123456', ios_bundle_id: 'in.example.kesar' } });
  for (const file of ['apple-app-site-association']) {
    const res = await wellKnown(shop, file);
    assert.equal(res.status, 200, `The AASA file answered ${res.status}`);
    assert.ok(!res.headers.location, 'The AASA file redirected');
    assert.match(res.headers['content-type'] ?? '', /^application\/(json|pkcs7-mime)/, 'AASA is served as JSON');
    const doc = JSON.parse(res.text);
    const text = flat(res);
    assert.ok(text.includes('TEAM123456.in.example.kesar'), 'The team and bundle ID are not in the file');
    assert.ok(doc.applinks, 'No applinks section');
    for (const path of APP_LINK_PATHS.open) assert.ok(text.includes(path), `The open path ${path} is not in the file`);
    for (const path of APP_LINK_PATHS.exclude) assert.ok(text.includes(path), `The excluded path ${path} is not in the file`);
    assert.ok(!namesPlatform(res.text), 'The file names the platform');
    assert.ok(!/google|assetlinks|play\./i.test(text), 'The iOS file holds Android data');
    assert.doesNotMatch(res.headers['cache-control'] ?? '', /no-store/, 'The well-known files are the one thing the app routes allow to cache');
  }
  // Other methods and look-alike paths.
  assert.equal((await wellKnown(shop, 'apple-app-site-association', { method: 'HEAD' })).status, 200);
  assert.ok([404, 405].includes((await hit(world, '/.well-known/apple-app-site-association', { host: shop.host, method: 'POST', body: {} })).status));
  // Another business has its own, never this one's.
  const other = await linkShop({ platforms: ['ios'], config: { apple_team_id: 'OTHER98765', ios_bundle_id: 'in.example.mitti' } });
  const theirs = await wellKnown(other.shop, 'apple-app-site-association');
  assert.ok(flat(theirs).includes('OTHER98765.in.example.mitti'));
  assert.ok(!theirs.text.includes('TEAM123456') && !theirs.text.includes('kesar'), 'One business\'s file shows another\'s ids');
  // Asking for the first business's file on the second's host, with the first's tenant header, changes nothing.
  const crossed = await wellKnown(other.shop, 'apple-app-site-association', { headers: { 'x-app-tenant': String(shop.tenantId), 'x-forwarded-host': shop.host } });
  assert.ok(!crossed.text.includes('TEAM123456'), 'Headers chose another business\'s file');
  // The file follows the config: a new bundle ID shows at once.
  await shop.appSet({ ios_bundle_id: 'in.example.kesar2' });
  assert.ok(flat(await wellKnown(shop, 'apple-app-site-association')).includes('TEAM123456.in.example.kesar2'));
});

test('P-53: a host with no app, a host that does not exist, and a platform the business has not got answer 404 with nothing of any business', async () => {
  const plain = await addP4Shop(world, { name: 'No App Store' });
  for (const file of ['apple-app-site-association', 'assetlinks.json']) {
    const res = await wellKnown(plain, file);
    assert.equal(res.status, 404, `${file} on a host with no app answered ${res.status}`);
    assert.ok(!res.headers.location);
    assert.ok(!/package|bundle|sha256|appIDs/i.test(res.text), 'A host with no app shows ids');
    assertNoPlatformName(res, `${file} on a host with no app`);
  }
  for (const host of ['unknown.example', 'localhost', world.config.platformAppHost || 'app.bhava.localhost']) {
    for (const file of ['apple-app-site-association', 'assetlinks.json']) {
      const res = await wellKnown(plain, file, { host });
      assert.ok([404, 421].includes(res.status), `${file} on ${host} answered ${res.status}`);
      assert.ok(!/package_name|appIDs/.test(res.text));
    }
  }
  // Tier 4 has Android only: its assetlinks exist, its AASA does not list an iOS app.
  const android = await linkShop({ platforms: ['android'] });
  assert.equal((await wellKnown(android.shop, 'assetlinks.json')).status, 200);
  const none = await wellKnown(android.shop, 'apple-app-site-association');
  assert.ok(none.status === 404 || !/appIDs.*[A-Z0-9]{10}\./.test(none.text), 'An Android-only business lists an iOS app');
  // An app turned off by the plan stops being served at once.
  await android.shop.sql(`UPDATE tenant_features SET enabled = false WHERE tenant_id = $1 AND feature = 'app.android'`, [android.shop.tenantId]);
  assert.equal((await wellKnown(android.shop, 'assetlinks.json')).status, 404, 'A business without the plan feature still has its files');
});

test('P-54: assetlinks.json lists the business\'s package with its Play App Signing fingerprints, and nothing of any other business', async () => {
  const { shop } = await linkShop({ config: { android_package: 'in.example.kesar', play_signing_sha256: [SIGNING_SHA256, OTHER_SHA256] } });
  const res = await wellKnown(shop, 'assetlinks.json');
  assert.equal(res.status, 200);
  assert.ok(!res.headers.location, 'assetlinks.json redirected');
  assert.match(res.headers['content-type'] ?? '', /^application\/json/);
  const doc = JSON.parse(res.text);
  assert.ok(Array.isArray(doc) && doc.length >= 1);
  const entry = doc.find((e) => e.target?.package_name === 'in.example.kesar');
  assert.ok(entry, 'The package is not listed');
  assert.deepEqual(entry.relation, ['delegate_permission/common.handle_all_urls']);
  assert.equal(entry.target.namespace, 'android_app');
  assert.deepEqual([...entry.target.sha256_cert_fingerprints].sort(), [SIGNING_SHA256, OTHER_SHA256].sort());
  for (const print of entry.target.sha256_cert_fingerprints) assert.match(print, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.ok(doc.every((e) => e.target.package_name === 'in.example.kesar'), 'Another package is listed');
  // The fingerprint is Play App Signing's, not a debug key: a business that has not added one gets no verified link at all.
  await shop.appSet({ play_signing_sha256: [] });
  const bare = await wellKnown(shop, 'assetlinks.json');
  assert.ok(bare.status === 404 || !/sha256_cert_fingerprints"\s*:\s*\[\s*"/.test(bare.text), 'A file with no fingerprint claims the host is verified');
  // The brand-file check names the missing fingerprint (it is the build's gate too).
  const problems = apps.brandFileProblems({ appName: 'X', shortName: 'X', shopDomain: shop.host, supportEmail: 'a@b.co', privacyUrl: 'https://x.co', iconMediaId: 'i', urlScheme: 'abc', androidPackage: 'in.example.kesar', playSigningSha256: [] }, { colors: { primary: '#112233' } }, { platforms: ['android'], hosts: [shop.host] });
  assert.ok(problems.some((p) => p.field === 'playSigningSha256' && p.code === 'required'));
  assert.ok(apps.isAppLinkPath('/r/brunch'));
});

test('P-50: the DM link is a direct link on the business\'s own host that the app opens as it is: the reel\'s landing opens with its products', async () => {
  const { shop, products, page } = await linkShop();
  const app = shop.app();
  accepted(await app.start('guest'));
  const dmLink = `https://${shop.host}/r/${page.slug}`;
  assert.ok(apps.isAppLinkPath(new URL(dmLink).pathname), 'The reel link is a path the app opens');
  const landing = accepted(await app.get(`/api/store/app/landing/${page.slug}`), 'The landing the app opens').data;
  assert.equal(landing.slug, page.slug);
  assert.deepEqual(landing.products.map((p) => p.id).sort(), products.map((p) => p.id).sort(), 'The reel\'s products');
  assert.ok(landing.media.url);
  assertNoPlatformName({ text: JSON.stringify(landing), headers: {} }, 'The landing');
  // A reel of another business, a reel that is off, and a slug that is nothing: 404, so the app opens home.
  const other = await linkShop();
  assert.equal((await app.get(`/api/store/app/landing/${other.page.slug}`)).status, 404, 'Another business\'s reel');
  assert.equal((await app.get('/api/store/app/landing/not-a-reel')).status, 404);
  assert.equal((await app.get('/api/store/app/landing/..%2F..%2Fadmin')).status, 404);
  await shop.must('PATCH', `/pages/${page.id}`, { active: false }, 200, 'Switching the reel off').catch(() => shop.sql('UPDATE pages SET active = false WHERE tenant_id = $1 AND id = $2', [shop.tenantId, page.id]));
  assert.equal((await app.get(`/api/store/app/landing/${page.slug}`)).status, 404, 'A switched-off reel opened');
  // The paths the app takes from the browser and the ones it never does.
  for (const path of ['/', '/shop', '/reels', '/cart', `/r/${page.slug}`, '/p/kettle', '/c/tea', '/order/abc', '/track/abc', '/account/orders/MM-1', '/refer/ABCDEF']) assert.equal(apps.isAppLinkPath(path), true, `${path} opens the app`);
  for (const path of ['/checkout', '/login', '/auth/google', '/admin', '/admin/orders', '/api/v1/orders', '/media/x', '/webhooks/razorpay', '/.well-known/assetlinks.json', '/policies/privacy', '/unsubscribe/x', '/cart/restore/x', '/account/shared-profile', '/lead', '/zzz', '/r/', '//evil.example', '/r/a/../../admin', '/r/x?y=1', '/p/%2e%2e']) {
    assert.equal(apps.isAppLinkPath(path), false, `${path} must not open the app`);
  }
});

test('P-51: opening the same DM link in the app twice sends no token and no click call', async () => {
  const { shop, page } = await linkShop();
  const clickTables = (await world.sql(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* 'click'`)).map((r) => r.table_name);
  const count = async () => {
    let n = 0;
    for (const table of clickTables) n += Number((await world.sql(`SELECT count(*)::int AS n FROM "${table}"`))[0].n);
    n += (await shop.trafficEvents()).filter((e) => /click|redirect/i.test(e.name)).length;
    return n;
  };
  const before = await count();
  const app = shop.app();
  accepted(await app.start('guest'));
  const bytesBefore = (await world.sql('SELECT count(*)::int AS n FROM shopper_app_sessions'))[0].n;
  const calls = [];
  for (let i = 0; i < 2; i++) {
    const res = accepted(await app.get(`/api/store/app/landing/${page.slug}`), `Opening the link, time ${i + 1}`);
    calls.push(res);
    assert.ok(!res.headers.location, 'The landing redirected');
    // Nothing in the answer is a token, a click id or a tracking link.
    const text = JSON.stringify(res.data);
    assert.ok(!/[?&](t|token|cid|click|utm_[a-z]+)=/i.test(text), 'The answer carries a token or click parameter');
    assert.ok(!/\/go\/|\/l\/|\/click|bit\.ly|short/i.test(text), 'The answer carries a redirect or shortener');
  }
  assert.equal(JSON.stringify(calls[0].data), JSON.stringify(calls[1].data), 'The same link opened differently the second time');
  assert.equal(await count(), before, 'Opening the link wrote a click');
  assert.equal((await world.sql('SELECT count(*)::int AS n FROM shopper_app_sessions'))[0].n, bytesBefore, 'Opening the link opened a session');
  // The contract itself has no click route and no token route for links.
  for (const [id, route] of Object.entries(APP_ROUTES)) {
    assert.ok(!/click|redirect|short|\/go\b|\/l\//i.test(`${id} ${route.path}`), `${id} looks like a click or redirect route`);
    if (/token/i.test(route.path)) assert.ok(/order/.test(route.path + id), `${id} takes a token that is not an order's`);
  }
  // A click call the app might be tempted to make is not there to make.
  for (const path of [`/api/store/app/click/${page.slug}`, `/api/store/app/links/${page.slug}`, `/api/store/app/link-token`, `/click/${page.slug}`]) {
    const res = await app.get(path);
    assert.ok([404, 405].includes(res.status), `${path} answered ${res.status}`);
  }
  assert.ok(apps.APP_LINK_PATHS.open.includes('/r/*'));
});

test('P-52: without the app, the DM link opens the web landing page with an "Open in app" banner that names the seller\'s own app', async () => {
  const { shop, page } = await linkShop({ platforms: ['android', 'ios'], name: 'Kesar Kitchen' });
  await shop.appSet({
    android_min_version: '1.0.0', android_store_url: 'https://play.google.com/store/apps/details?id=com.example.kesar',
    ios_min_version: '1.0.0', ios_store_url: 'https://apps.apple.com/in/app/kesar/id1234567890',
  });
  const open = (ua, path = `/r/${page.slug}`) => hit(world, path, { host: shop.host, headers: { 'user-agent': ua, accept: 'text/html' } });
  const phone = await open(UA.phone);
  assert.equal(phone.status, 200, 'The landing page did not open');
  assert.ok(!phone.headers.location, 'The landing page redirected');
  assert.match(phone.text, /open (in|the) (the )?app|get the app|install/i, 'No install banner');
  assert.ok(phone.text.includes('https://play.google.com/store/apps/details?id=com.example.kesar') || phone.text.includes('apps.apple.com'), 'The banner has no store link');
  assert.ok(phone.text.includes(`shop${shop.tenantId}://`) || phone.text.includes(`https://${shop.host}/r/${page.slug}`), 'The banner does not open the app on this reel');
  assert.ok(!namesPlatform(phone.text.replace(/<script[\s\S]*?<\/script>/g, '')), 'The landing names the platform');
  assert.ok(phone.text.includes(page.slug) || /Brunch edit/.test(phone.text), 'The landing page lost its content');
  // An iPhone is sent to the App Store link and an Android phone to Play (not both stores' link as the only one).
  const iphone = await open('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1');
  assert.ok(iphone.text.includes('https://apps.apple.com/in/app/kesar/id1234567890'), 'iPhone: no App Store link');
  const android = await open(UA.phone);
  assert.ok(android.text.includes('https://play.google.com/store/apps/details?id=com.example.kesar'), 'Android: no Play link');
  // The banner is not an injection point: the slug in the page is the real one, not the request's.
  const hostile = await open(UA.phone, `/r/${page.slug}?x=%22%3E%3Cscript%3Ealert(1)%3C/script%3E`);
  assert.ok(!hostile.text.includes('<script>alert(1)</script>'), 'A query string reached the banner as markup');
  // A business without the app shows no banner at all.
  const plain = await addP4Shop(world, { name: 'Plain Store' });
  const p = await plain.page({ productIds: [(await plain.item({ stock: 3 })).id] });
  const none = await hit(world, `/r/${p.slug}`, { host: plain.host, headers: { 'user-agent': UA.phone, accept: 'text/html' } });
  assert.equal(none.status, 200);
  assert.doesNotMatch(none.text, /open (in|the) (the )?app|get the app/i, 'A business with no app shows an app banner');
  // A business whose app has no store link yet (not live): no banner with a broken link.
  await shop.appSet({ android_store_url: '', ios_store_url: '', android_min_version: '', ios_min_version: '' });
  const early = await open(UA.phone);
  assert.doesNotMatch(early.text, /href="(#|)"/, 'A banner with an empty link');
});
