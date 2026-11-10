// PRD 4.11 and 6.6: direct links only. C-38 to C-41, C-62 to C-65, A-31 to A-36.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addShop, addStaff, assertNoDm, assertRefused, buttonsOf, fakeSite, hit, linkOf, need, unique, useWorld } from './support.js';

const world = useWorld();
const preview = (shop, url, extra = {}) => shop.call('/links/preview', 200, { method: 'POST', body: { url, ...extra } }, 'The link preview');
const save = async (shop, o) => shop.tryAutomation({ mediaId: await shop.reel(), ...o });
const utmOff = (shop) => shop.call('/compliance/settings', 200, { method: 'PATCH', body: { utmEnabled: false } });

async function sendOne(shop, o = {}) {
  const auto = await shop.automate(o);
  await shop.comment(auto.mediaId);
  await shop.settle();
  const [dm] = await shop.dms();
  assert.ok(dm, 'A DM went out');
  return { dm, auto, link: new URL(linkOf(dm)) };
}

const assertBlocked = async (shop, url, reason) => {
  const out = await preview(shop, url);
  assert.equal(out.allowed, false, url);
  assert.equal(out.reason, reason, url);
  assertRefused(await save(shop, { linkUrl: url }), reason, url);
};

const SHORTENERS = ['https://bit.ly/x', 'https://BIT.LY/x', 'https://www.bit.ly/x', 'https://bit.ly:443/x', 'https://bit.ly./x', 'https://tinyurl.com/x', 'https://t.co/x', 'https://goo.gl/x', 'https://ow.ly/x', 'https://amzn.to/x', 'https://l.instagram.com/?u=https://shop.example', 'https://shop.example@bit.ly/x'];
for (const url of SHORTENERS) {
  test(`C-38: ${url} is link.shortener`, async () => {
    const shop = await addShop(world);
    await assertBlocked(shop, url, 'link.shortener');
  });
}

test('C-38: a shortener can\'t come in by PATCH', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate();
  assertRefused(await shop.api(`/automations/${auto.id}`, { method: 'PATCH', body: { linkUrl: 'https://bit.ly/x' } }), 'link.shortener');
  assert.equal((await shop.call(`/automations/${auto.id}`, 200)).linkUrl, auto.linkUrl);
});

test('C-38: a shortener written straight into the template text is refused too', async () => {
  const shop = await addShop(world);
  assertRefused(await save(shop, { body: 'Buy here https://bit.ly/x' }), 'link.shortener');
});

test('C-38: a look-alike of a shortener is not one', async () => {
  const shop = await addShop(world);
  const out = await preview(shop, 'https://notbit.ly/x');
  assert.notEqual(out.reason, 'link.shortener');
});

const savedNumber = (shop, number = '919876543210') => shop.repos.settings.update({ support_whatsapp: number });

for (const url of ['https://wa.me/919876543210', 'https://api.whatsapp.com/send?phone=919876543210']) {
  test(`C-39: ${url} with the business's saved number is allowed`, async () => {
    const shop = await addShop(world);
    await savedNumber(shop);
    const out = await preview(shop, url);
    assert.equal(out.allowed, true, JSON.stringify(out));
    assert.equal(out.linkType, 'whatsapp');
    need(await save(shop, { linkUrl: url, linkType: 'whatsapp' }), 201, 'Saving');
  });
}

test('C-39: a WhatsApp link carries no UTM tags', async () => {
  const shop = await addShop(world);
  await savedNumber(shop);
  const { link } = await sendOne(shop, { linkUrl: 'https://wa.me/919876543210', linkType: 'whatsapp' });
  assert.equal(link.href, 'https://wa.me/919876543210');
});

test('C-39: a WhatsApp link gets a number-format check only, and no web request', async () => {
  const shop = await addShop(world);
  await savedNumber(shop);
  const out = await shop.call('/links/check', 200, { method: 'POST', body: { url: 'https://wa.me/919876543210' } });
  assert.equal(out.ok, true);
  assert.equal(out.httpStatus, null);
});

for (const url of ['https://wa.me/919999999999', 'https://api.whatsapp.com/send?phone=919999999999', 'https://wa.me/919876543210abc', 'https://wa.me/', 'https://api.whatsapp.com/send', 'https://api.whatsapp.com/send?phone=919999999999&phone=919876543210']) {
  test(`C-40: ${url} is link.not_allowlisted`, async () => {
    const shop = await addShop(world);
    await savedNumber(shop);
    await assertBlocked(shop, url, 'link.not_allowlisted');
  });
}

test('C-40: with no number saved no WhatsApp link is allowed', async () => {
  const shop = await addShop(world);
  await assertBlocked(shop, 'https://wa.me/919876543210', 'link.not_allowlisted');
});

test('C-40: another business\'s saved number is another number', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  await savedNumber(a, '919111111111');
  await savedNumber(b, '919222222222');
  await assertBlocked(b, 'https://wa.me/919111111111', 'link.not_allowlisted');
});

const amazonTag = (shop, mediaId, value) => shop.call('/measurement-ids', 201, { method: 'POST', body: { mediaId, kind: 'amazon_tag', value } }, 'Saving the tracking id');

test('C-41: the DM link is the Amazon address itself, tag included, with no Bhava host', async () => {
  const shop = await addShop(world);
  const mediaId = await shop.reel();
  await amazonTag(shop, mediaId, 'shopa-21');
  const { link } = await sendOne(shop, { mediaId, linkType: 'amazon', linkUrl: 'https://www.amazon.in/dp/B0TEST1234' });
  assert.equal(link.origin, 'https://www.amazon.in');
  assert.equal(link.pathname, '/dp/B0TEST1234');
  assert.equal(link.searchParams.get('tag'), 'shopa-21');
});

const LINK_CASES = {
  'a seller-site link': (shop) => ({ linkUrl: shop.siteUrl('/p/1') }),
  'an Amazon link': () => ({ linkType: 'amazon', linkUrl: 'https://www.amazon.in/dp/B0TEST' }),
  'an affiliate link': () => ({ linkType: 'affiliate', linkUrl: 'https://store.affiliate.example/item/5' }),
  'a store page link': (shop) => ({ linkType: 'bhava_page', linkUrl: `https://${shop.host}/p/lamp` }),
};
for (const [label, build] of Object.entries(LINK_CASES)) {
  test(`C-62: in ${label} the link's host is the destination's, with no /l/, /r/ or /go hop`, async () => {
    const shop = await addShop(world);
    const input = build(shop);
    const { link } = await sendOne(shop, input);
    assert.equal(link.host, new URL(input.linkUrl).host);
    assert.equal(link.pathname, new URL(input.linkUrl).pathname);
    assert.doesNotMatch(link.pathname, /^\/(l|r|go)(\/|$)/);
    assert.doesNotMatch(link.href, /bhava/i);
  });
}

test('C-62: every link in a text fallback is direct too', async () => {
  const shop = await addShop(world);
  await shop.refuseSends({ code: 100 });
  const auto = await shop.automate({ linkUrl: shop.siteUrl('/p/9') });
  await shop.comment(auto.mediaId);
  await shop.settle();
  const [dm] = await shop.dms();
  assert.equal(new URL(linkOf(dm)).host, shop.siteHost);
});

test('C-62: the exact address the builder shows is the one that is sent', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ linkUrl: shop.siteUrl('/p/8') });
  await shop.comment(auto.mediaId);
  await shop.settle();
  const shown = (await shop.call(`/automations/${auto.id}`, 200)).finalUrl;
  assert.equal(new URL(shown).host, shop.siteHost);
  assert.deepEqual([...new URL(linkOf((await shop.dms())[0])).searchParams.keys()].sort(), [...new URL(shown).searchParams.keys()].sort());
});

test('C-62: the retired redirect addresses are gone', async () => {
  const shop = await addShop(world);
  for (const path of ['/l/abc123', '/go/abc123']) {
    const res = await hit(world, path, { host: shop.host });
    assert.ok(res.status < 300 || res.status >= 400, `${path} answered ${res.status}`);
    assert.equal(res.headers.location, undefined, path);
  }
});

const blockHost = (world_, host, category = 'malware') => world_.rawDb.platform.query('INSERT INTO link_blocked_hosts (host, category) VALUES ($1, $2) ON CONFLICT DO NOTHING', [host, category]);

test('C-63: a destination on the blocklist is link.blocked, and the automation can\'t go live', async () => {
  const shop = await addShop(world);
  const host = `evil-${unique()}.example`;
  await blockHost(world, host);
  const url = `https://${host}/x`;
  const out = await preview(shop, url);
  assert.equal(out.allowed, false);
  assert.equal(out.reason, 'link.blocked');
  assertRefused(await save(shop, { linkUrl: url }), 'link.blocked');
});

for (const category of ['phishing', 'adult']) {
  test(`C-63: a ${category} host is link.blocked too`, async () => {
    const shop = await addShop(world);
    const host = `${category}-${unique()}.example`;
    await blockHost(world, host, category);
    await assertBlocked(shop, `https://${host}/x`, 'link.blocked');
  });
}

test('C-63: a subdomain of a blocked host and a different letter case are blocked as well', async () => {
  const shop = await addShop(world);
  const host = `evil-${unique()}.example`;
  await blockHost(world, host);
  await assertBlocked(shop, `https://sub.${host}/x`, 'link.blocked');
  await assertBlocked(shop, `https://${host.toUpperCase()}/x`, 'link.blocked');
});

test('C-63: a host that goes on the blocklist after saving can\'t go live', async () => {
  const shop = await addShop(world);
  const host = `later-${unique()}.example`;
  const url = `https://${host}/x`;
  fakeSite(url);
  const auto = await shop.automate({ linkUrl: url, state: 'draft' });
  await blockHost(world, host);
  const res = await shop.api(`/automations/${auto.id}/state`, { method: 'POST', body: { state: 'live' } });
  assertRefused(res, 'link.blocked', 'Going live');
  assert.equal((await shop.call(`/automations/${auto.id}`, 200)).state, 'draft');
});

test('C-63: at send, a host blocked meanwhile sends nothing', async () => {
  const shop = await addShop(world);
  const host = `sendtime-${unique()}.example`;
  const auto = await shop.automate({ linkUrl: `https://${host}/x` });
  await blockHost(world, host);
  await shop.comment(auto.mediaId);
  await shop.settle();
  await assertNoDm(shop);
});

const redirecting = (status = 301) => {
  const url = `https://site-${unique()}.example/old`;
  const target = `https://other-${unique()}.example/new`;
  fakeSite(url, { status, location: target });
  fakeSite(target);
  return { url, target };
};

test('C-64: a destination that redirects to another site is link.redirect', async () => {
  const shop = await addShop(world);
  const { url } = redirecting();
  const out = await shop.call('/links/check', 200, { method: 'POST', body: { url } });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'link.redirect');
});

test('C-64: the daily check pauses a live automation whose link now redirects, and alerts the owner', async () => {
  const shop = await addShop(world);
  const { url } = redirecting();
  const auto = await shop.automate({ linkUrl: url });
  await shop.sql(`UPDATE automations SET link_checked_at = now() - interval '25 hours' WHERE id = $1`, [auto.id]);
  await shop.settle();
  const after = await shop.call(`/automations/${auto.id}`, 200);
  assert.equal(after.state, 'paused');
  assert.equal(after.linkStatus, 'failed');
  assert.equal((await shop.alerts()).length, 1);
  const [check] = await shop.sql('SELECT * FROM link_checks WHERE tenant_id = $1 AND automation_id = $2', [shop.tenantId, auto.id]);
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'link.redirect');
});

test('C-64: going live with a redirecting link is refused', async () => {
  const shop = await addShop(world);
  const { url } = redirecting(302);
  const auto = await shop.automate({ linkUrl: url, state: 'draft' });
  assertRefused(await shop.api(`/automations/${auto.id}/state`, { method: 'POST', body: { state: 'live' } }), 'link.redirect', 'Going live');
});

for (const [label, from, to] of [
  ['www added', 'https://same-site.example/a', 'https://www.same-site.example/a'],
  ['www removed', 'https://www.same-site2.example/a', 'https://same-site2.example/a'],
]) {
  test(`C-64: a ${label} redirect on the same site is allowed`, async () => {
    const shop = await addShop(world);
    fakeSite(from, { status: 301, location: to });
    fakeSite(to);
    const out = await shop.call('/links/check', 200, { method: 'POST', body: { url: from } });
    assert.equal(out.ok, true, JSON.stringify(out));
  });
}

for (const [label, site, reason] of [
  ['a 404', { status: 404 }, 'link.check_failed'],
  ['a 500', { status: 500 }, 'link.check_failed'],
]) {
  test(`C-64: ${label} from the destination fails the check`, async () => {
    const shop = await addShop(world);
    const url = `https://broken-${unique()}.example/x`;
    fakeSite(url, site);
    const out = await shop.call('/links/check', 200, { method: 'POST', body: { url } });
    assert.equal(out.ok, false);
    assert.equal(out.reason, reason);
  });
}

test('C-64: a destination that takes over 5 s fails the check', async () => {
  const shop = await addShop(world);
  const url = `https://slow-${unique()}.example/x`;
  fakeSite(url, { delayMs: 5500 });
  const out = await shop.call('/links/check', 200, { method: 'POST', body: { url } });
  assert.equal(out.ok, false);
});

test('C-64: another business can\'t see or run a check against this business\'s automation', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  const auto = await a.automate();
  assert.equal((await b.api(`/automations/${auto.id}`)).status, 404);
  assert.equal((await b.api(`/automations/${auto.id}/state`, { method: 'POST', body: { state: 'paused' } })).status, 404);
  assert.equal((await a.call(`/automations/${auto.id}`, 200)).state, 'live');
});

const BAD_SCHEMES = ['http://shop.example/x', 'HTTP://shop.example/x', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\nscript:alert(1)', 'data:text/html,hi', 'ftp://shop.example/x', 'file:///etc/passwd', '//shop.example/x', 'shop.example/x'];
for (const url of BAD_SCHEMES) {
  test(`C-65: ${JSON.stringify(url)} is link.scheme`, async () => {
    const shop = await addShop(world);
    await assertBlocked(shop, url, 'link.scheme');
  });
}

test('C-65: an internal address is refused and never fetched', async () => {
  const shop = await addShop(world);
  for (const url of ['https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data/', 'https://10.0.0.5/x', 'https://[::1]/x']) {
    const out = await shop.call('/links/check', 200, { method: 'POST', body: { url } });
    assert.equal(out.ok, false, url);
  }
});

test('C-65: an enormous or empty address is refused cleanly', async () => {
  const shop = await addShop(world);
  assert.equal((await shop.api('/links/preview', { method: 'POST', body: { url: `https://shop.example/${'a'.repeat(3000)}` } })).status, 400);
  assert.equal((await shop.api('/links/preview', { method: 'POST', body: { url: '' } })).status, 400);
});

test('A-31: a one-tap DM link answers 200 from the seller\'s site, with nothing of ours in the chain', async () => {
  const shop = await addShop(world);
  const product = shop.siteUrl('/products/lamp');
  const { link, dm } = await sendOne(shop, { linkUrl: product });
  assert.equal(buttonsOf(dm)[0].type, 'web_url');
  fakeSite(link.href);
  const res = await fetch(link.href, { redirect: 'manual' });
  assert.equal(res.status, 200);
  assert.equal(link.host, shop.siteHost);
  assert.doesNotMatch(link.href, new RegExp(`${shop.host}|bhava`, 'i'));
});

test('A-32: a seller-site link with no tags lands with the 4 UTM tags, and utm_content names the reel', async () => {
  const shop = await addShop(world);
  const mediaId = await shop.reel();
  const { link, auto } = await sendOne(shop, { mediaId, linkUrl: shop.siteUrl('/p/1') });
  assert.equal(link.searchParams.get('utm_source'), 'instagram');
  assert.equal(link.searchParams.get('utm_medium'), 'dm');
  assert.equal(link.searchParams.get('utm_campaign'), auto.slug);
  assert.equal(link.searchParams.get('utm_content'), mediaId);
});

test('A-32: tags already on the link win', async () => {
  const shop = await addShop(world);
  const { link } = await sendOne(shop, { linkUrl: shop.siteUrl('/p/1?utm_source=newsletter&utm_campaign=mine') });
  assert.equal(link.searchParams.get('utm_source'), 'newsletter');
  assert.equal(link.searchParams.get('utm_campaign'), 'mine');
  assert.equal(link.searchParams.get('utm_medium'), 'dm');
  assert.deepEqual(link.searchParams.getAll('utm_source'), ['newsletter'], 'Not added twice');
});

test('A-32: tags never change the host, the path, other parameters or the fragment', async () => {
  const shop = await addShop(world);
  const { link } = await sendOne(shop, { linkUrl: shop.siteUrl('/p/a%20b?colour=red&size=m#reviews') });
  assert.equal(link.host, shop.siteHost);
  assert.equal(link.pathname, '/p/a%20b');
  assert.equal(link.searchParams.get('colour'), 'red');
  assert.equal(link.searchParams.get('size'), 'm');
  assert.equal(link.hash, '#reviews');
});

test('A-32: UTM tags can be switched off for the business', async () => {
  const shop = await addShop(world);
  await utmOff(shop);
  const url = shop.siteUrl('/p/1');
  const { link } = await sendOne(shop, { linkUrl: url });
  assert.equal(link.href, url);
});

test('A-32: a business\'s store pages carry the UTM tags only', async () => {
  const shop = await addShop(world);
  const { link } = await sendOne(shop, { linkType: 'bhava_page', linkUrl: `https://${shop.host}/p/lamp` });
  assert.equal(link.host, shop.host);
  assert.equal(link.searchParams.get('utm_source'), 'instagram');
});

test('A-33: an Amazon link on reel A with tracking ID shopa-21 is the Amazon URL with tag=shopa-21 and nothing else changes', async () => {
  const shop = await addShop(world);
  const mediaId = await shop.reel();
  await amazonTag(shop, mediaId, 'shopa-21');
  const { link } = await sendOne(shop, { mediaId, linkType: 'amazon', linkUrl: 'https://www.amazon.in/dp/B0TEST?th=1&psc=1' });
  assert.equal(link.pathname, '/dp/B0TEST');
  assert.deepEqual(Object.fromEntries(link.searchParams), { th: '1', psc: '1', tag: 'shopa-21' }, 'And no UTM tags on Amazon');
});

test('A-33: the reel\'s tag replaces one already on the link', async () => {
  const shop = await addShop(world);
  const mediaId = await shop.reel();
  await amazonTag(shop, mediaId, 'shopa-21');
  const { link } = await sendOne(shop, { mediaId, linkType: 'amazon', linkUrl: 'https://www.amazon.in/dp/B0TEST?tag=old-21' });
  assert.deepEqual(link.searchParams.getAll('tag'), ['shopa-21']);
});

test('A-33: each reel gets its own tag', async () => {
  const shop = await addShop(world);
  const [reelA, reelB] = [await shop.reel(), await shop.reel()];
  await amazonTag(shop, reelA, 'shopa-21');
  await amazonTag(shop, reelB, 'shopb-21');
  const a = await shop.automate({ mediaId: reelA, linkType: 'amazon', linkUrl: 'https://www.amazon.in/dp/A' });
  const b = await shop.automate({ mediaId: reelB, linkType: 'amazon', linkUrl: 'https://www.amazon.in/dp/B' });
  const [ca, cb] = [await shop.comment(a.mediaId), await shop.comment(b.mediaId)];
  await shop.settle();
  assert.equal(new URL(linkOf((await shop.dms({ commentId: ca.id }))[0])).searchParams.get('tag'), 'shopa-21');
  assert.equal(new URL(linkOf((await shop.dms({ commentId: cb.id }))[0])).searchParams.get('tag'), 'shopb-21');
});

for (const value of ['x&evil=1', 'x#frag', 'x y', 'x/../y', '<script>']) {
  test(`A-33: a tracking id of ${JSON.stringify(value)} can't change the rest of the link`, async () => {
    const shop = await addShop(world);
    const mediaId = await shop.reel();
    const res = await shop.api('/measurement-ids', { method: 'POST', body: { mediaId, kind: 'amazon_tag', value } });
    if (res.status === 400) return;
    assert.equal(res.status, 201);
    const { link } = await sendOne(shop, { mediaId, linkType: 'amazon', linkUrl: 'https://www.amazon.in/dp/B0TEST' });
    assert.equal(link.searchParams.get('tag'), value);
    assert.equal(link.searchParams.has('evil'), false);
    assert.equal(link.hash, '');
  });
}

test('A-33: a look-alike host is not given an Amazon tag', async () => {
  const shop = await addShop(world);
  const mediaId = await shop.reel();
  await amazonTag(shop, mediaId, 'shopa-21');
  const out = await preview(shop, 'https://www.amazon.in.evil.example/dp/1', { mediaId });
  assert.equal(new URL(out.finalUrl).searchParams.has('tag'), false);
  assert.notEqual(out.linkType, 'amazon');
});

test('A-33: another business\'s measurement id can\'t be read, changed or removed', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  const mediaId = await a.reel();
  const saved = await amazonTag(a, mediaId, 'shopa-21');
  assert.equal((await b.api(`/measurement-ids/${saved.id}`, { method: 'PATCH', body: { value: 'stolen-21' } })).status, 404);
  assert.equal((await b.api(`/measurement-ids/${saved.id}`, { method: 'DELETE' })).status, 404);
  assert.deepEqual((await b.call('/measurement-ids', 200)).items, []);
  assert.equal((await a.call('/measurement-ids', 200)).items[0].value, 'shopa-21');
});

test('A-34: a network link on reel C carries reel C\'s sub-ID in a parameter, and the host doesn\'t change', async () => {
  const shop = await addShop(world);
  const mediaId = await shop.reel();
  await shop.call('/measurement-ids', 201, { method: 'POST', body: { mediaId, kind: 'affiliate_sub_id', network: 'cuelinks', value: 'reel-c' } });
  const { link } = await sendOne(shop, { mediaId, linkType: 'affiliate', linkUrl: 'https://store.affiliate.example/item/5?id=9' });
  assert.equal(link.host, 'store.affiliate.example');
  assert.equal(link.pathname, '/item/5');
  assert.ok([...link.searchParams.values()].includes('reel-c'), `No sub-ID in ${link.href}`);
  assert.equal(link.searchParams.get('id'), '9');
});

const WARNING = /Earnings cannot be split by reel/;

test('A-35: a second live reel with the same Amazon tag saves with a warning', async () => {
  const shop = await addShop(world);
  const [reelA, reelB] = [await shop.reel(), await shop.reel()];
  await shop.automate({ mediaId: reelA, linkType: 'amazon', linkUrl: 'https://www.amazon.in/dp/A' });
  await shop.automate({ mediaId: reelB, linkType: 'amazon', linkUrl: 'https://www.amazon.in/dp/B' });
  const first = await amazonTag(shop, reelA, 'shared-21');
  assert.deepEqual(first.warnings, []);
  const second = await amazonTag(shop, reelB, 'shared-21');
  assert.ok(second.warnings.some((w) => WARNING.test(w.message)), JSON.stringify(second.warnings));
  assert.equal(second.value, 'shared-21', 'It saved');
});

test('A-35: the warning also comes when an existing tag is changed to match', async () => {
  const shop = await addShop(world);
  const [reelA, reelB] = [await shop.reel(), await shop.reel()];
  await shop.automate({ mediaId: reelA, linkType: 'amazon', linkUrl: 'https://www.amazon.in/dp/A' });
  await shop.automate({ mediaId: reelB, linkType: 'amazon', linkUrl: 'https://www.amazon.in/dp/B' });
  await amazonTag(shop, reelA, 'one-21');
  const b = await amazonTag(shop, reelB, 'two-21');
  const updated = await shop.call(`/measurement-ids/${b.id}`, 200, { method: 'PATCH', body: { value: 'one-21' } });
  assert.ok(updated.warnings.some((w) => WARNING.test(w.message)));
});

test('A-35: the same tag at another business is no clash, and tells nothing about it', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  const [reelA, reelB] = [await a.reel(), await b.reel()];
  await a.automate({ mediaId: reelA, linkType: 'amazon', linkUrl: 'https://www.amazon.in/dp/A' });
  await b.automate({ mediaId: reelB, linkType: 'amazon', linkUrl: 'https://www.amazon.in/dp/B' });
  await amazonTag(a, reelA, 'shared-21');
  assert.deepEqual((await amazonTag(b, reelB, 'shared-21')).warnings, []);
});

test('A-35: a reel that isn\'t live doesn\'t count as a clash', async () => {
  const shop = await addShop(world);
  const [reelA, reelB] = [await shop.reel(), await shop.reel()];
  await shop.automate({ mediaId: reelA, state: 'draft', linkType: 'amazon', linkUrl: 'https://www.amazon.in/dp/A' });
  await shop.automate({ mediaId: reelB, linkType: 'amazon', linkUrl: 'https://www.amazon.in/dp/B' });
  await amazonTag(shop, reelA, 'shared-21');
  assert.deepEqual((await amazonTag(shop, reelB, 'shared-21')).warnings, []);
});

test('A-35: a staff member without automations can\'t set a measurement id', async () => {
  const shop = await addShop(world);
  const staff = await addStaff(world, shop, { permissions: ['orders'] });
  assert.equal((await shop.api('/measurement-ids', { method: 'POST', token: staff.token, body: { mediaId: 'x', kind: 'amazon_tag', value: 'a-21' } })).status, 403);
});

const ONE_TAP_MESSAGE = /One tap needs a paid plan/;

test('A-36: a Free-plan owner picking one tap is not allowed: two taps stay on, with the reason', async () => {
  const shop = await addShop(world, { plan: 'free' });
  const res = await save(shop, { linkMode: 'one_tap' });
  if (res.status === 400) {
    assert.match(res.json().error, ONE_TAP_MESSAGE);
  } else {
    assert.equal(res.status, 201);
    const saved = res.json();
    assert.equal(saved.linkMode, 'two_tap');
    assert.ok(saved.warnings.some((w) => ONE_TAP_MESSAGE.test(w.message)));
  }
});

test('A-36: a Free-plan automation can\'t be switched to one tap by a PATCH', async () => {
  const shop = await addShop(world, { plan: 'free' });
  const auto = await shop.automate({ linkMode: 'two_tap' });
  await shop.api(`/automations/${auto.id}`, { method: 'PATCH', body: { linkMode: 'one_tap' } });
  assert.equal((await shop.call(`/automations/${auto.id}`, 200)).linkMode, 'two_tap');
});

test('A-36: a Free-plan automation forced to one tap in the database still goes out as two taps', async () => {
  const shop = await addShop(world, { plan: 'free' });
  const auto = await shop.automate({ linkMode: 'two_tap' });
  await shop.sql(`UPDATE automations SET link_mode = 'one_tap' WHERE id = $1`, [auto.id]);
  await shop.comment(auto.mediaId);
  await shop.settle();
  assert.equal(buttonsOf((await shop.dms())[0])[0].type, 'postback');
});

test('A-36: a paid plan can choose either', async () => {
  const shop = await addShop(world, { plan: 't1' });
  need(await save(shop, { linkMode: 'one_tap' }), 201, 'One tap on a paid plan');
  need(await save(shop, { linkMode: 'two_tap' }), 201, 'Two taps on a paid plan');
});

test('A-36: an entitlement override gives a Free business one tap', async () => {
  const shop = await addShop(world, { plan: 'free' });
  await shop.repos.entitlements.setOverride('links.one_tap', { enabled: true });
  const saved = need(await save(shop, { linkMode: 'one_tap' }), 201, 'With the override').json();
  assert.equal(saved.linkMode, 'one_tap');
});
