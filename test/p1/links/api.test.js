// The links and measurement id routes, going live, and the daily check, through the running app (PRD 4.11, 6.6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoTenantError } from '../../../src/tenancy.js';
import { addShop, addStaff, buttonsOf, fakeSite, hit, linkOf, unique, useWorld } from '../spec-p1/support.js';

const world = useWorld();

const preview = (shop, url, extra = {}) => shop.call('/links/preview', 200, { method: 'POST', body: { url, ...extra } });
const check = (shop, url) => shop.call('/links/check', 200, { method: 'POST', body: { url } });
const saveId = (shop, body) => shop.call('/measurement-ids', 201, { method: 'POST', body });
const amazonTag = (shop, mediaId, value = 'shopa-21') => saveId(shop, { mediaId, kind: 'amazon_tag', value });
const saveNumber = (shop, number = '919876543210') => shop.repos.settings.update({ support_whatsapp: number });
const setState = (shop, id, state) => shop.api(`/automations/${id}/state`, { method: 'POST', body: { state } });
const checksOf = (shop) => shop.sql('SELECT * FROM link_checks WHERE tenant_id = $1 ORDER BY id', [shop.tenantId]);
const auditOf = (shop, like) => shop.sql('SELECT * FROM audit_log WHERE tenant_id = $1 AND action LIKE $2 ORDER BY id', [shop.tenantId, like]);
const makeDue = (shop, id) => shop.sql(`UPDATE automations SET link_checked_at = now() - interval '25 hours' WHERE id = $1`, [id]);
const siteOf = (shop, options) => {
  const url = shop.siteUrl(`/p/${unique()}`);
  fakeSite(url, options);
  return url;
};
const redirectingSite = (shop) => siteOf(shop, { status: 301, location: `https://other-${unique()}.example/` });

// ---- preview ----

test('PRD 4.11: the preview shows the exact address with its tags', async () => {
  const shop = await addShop(world);
  const out = await preview(shop, 'https://site.example/p?a=1', { automationSlug: 'diwali', mediaId: '555' });
  assert.equal(out.finalUrl, 'https://site.example/p?a=1&utm_source=instagram&utm_medium=dm&utm_campaign=diwali&utm_content=555');
  assert.deepEqual([out.allowed, out.reason, out.linkType, out.warnings], [true, null, 'seller_site', []]);
});

test('PRD 6.6: the preview tags for the channel it is told, and honours UTM being off', async () => {
  const shop = await addShop(world);
  assert.equal(new URL((await preview(shop, 'https://site.example/p', { channel: 'facebook' })).finalUrl).searchParams.get('utm_source'), 'facebook');
  await shop.call('/compliance/settings', 200, { method: 'PATCH', body: { utmEnabled: false } });
  assert.equal((await preview(shop, 'https://site.example/p')).finalUrl, 'https://site.example/p');
});

test('the preview reads the type from the address', async () => {
  const shop = await addShop(world);
  await saveNumber(shop);
  assert.equal((await preview(shop, 'https://www.amazon.in/dp/1')).linkType, 'amazon');
  assert.equal((await preview(shop, 'https://wa.me/919876543210')).linkType, 'whatsapp');
  assert.equal((await preview(shop, `https://${shop.host}/p/lamp`)).linkType, 'bhava_page');
  assert.equal((await preview(shop, 'https://elsewhere.example/p')).linkType, 'seller_site');
});

test('another business\'s address is not this business\'s page', async () => {
  const [shop, other] = [await addShop(world), await addShop(world)];
  assert.equal((await preview(shop, `https://${other.host}/p/lamp`)).linkType, 'seller_site');
});

test('a custom domain of this business is its own page', async () => {
  const shop = await addShop(world);
  const domain = `shop-${unique()}.example`;
  await world.rawDb.platform.query(`INSERT INTO tenant_domains (tenant_id, domain, status) VALUES ($1, $2, 'verified')`, [shop.tenantId, domain]);
  assert.equal((await preview(shop, `https://${domain}/p`)).linkType, 'bhava_page');
});

test('A-33, A-34: the preview shows the reel\'s tag and sub-ID', async () => {
  const shop = await addShop(world);
  const mediaId = await shop.reel();
  await amazonTag(shop, mediaId);
  await saveId(shop, { mediaId, kind: 'affiliate_sub_id', network: 'cuelinks', value: 'reel-c' });
  assert.equal((await preview(shop, 'https://www.amazon.in/dp/1', { mediaId })).finalUrl, 'https://www.amazon.in/dp/1?tag=shopa-21');
  const network = await preview(shop, 'https://store.example/i', { mediaId });
  assert.deepEqual([network.finalUrl, network.linkType], ['https://store.example/i?subid=reel-c', 'affiliate']);
});

test('a refused address has no final address and says why', async () => {
  const shop = await addShop(world);
  for (const [url, reason, linkType] of [['https://bit.ly/x', 'link.shortener', 'seller_site'], ['http://site.example/', 'link.scheme', 'seller_site'], ['javascript:alert(1)', 'link.scheme', 'seller_site'], ['https://wa.me/1234567', 'link.not_allowlisted', 'whatsapp'], ['https://10.0.0.1/', 'link.blocked', 'seller_site']]) {
    assert.deepEqual(await preview(shop, url), { finalUrl: '', linkType, allowed: false, reason, warnings: [] }, url);
  }
});

test('characters that can\'t be encoded or stored don\'t break the preview', async () => {
  const shop = await addShop(world);
  for (const body of [{ url: 'https://site.example/p', mediaId: '\ud800' }, { url: 'https://site.example/p', automationSlug: '\ud800' }, { url: 'https://site.example/\ud800' }]) {
    const res = await shop.api('/links/preview', { method: 'POST', body });
    assert.equal(res.status, 200, JSON.stringify(body));
  }
});

test('A-35: the preview warns when the reel shares its id with another live reel', async () => {
  const shop = await addShop(world);
  const [a, b] = [await shop.automate({ linkType: 'amazon', linkUrl: 'https://www.amazon.in/dp/A' }), await shop.automate({ linkType: 'amazon', linkUrl: 'https://www.amazon.in/dp/B' })];
  await amazonTag(shop, a.mediaId, 'shared-21');
  await amazonTag(shop, b.mediaId, 'shared-21');
  const out = await preview(shop, 'https://www.amazon.in/dp/A', { mediaId: a.mediaId });
  assert.match(out.warnings[0].message, /Earnings cannot be split by reel/);
});

// ---- check ----

test('C-64: POST /links/check answers with the status it saw', async () => {
  const shop = await addShop(world);
  const out = await check(shop, siteOf(shop));
  assert.deepEqual([out.ok, out.reason, out.httpStatus], [true, null, 200]);
  assert.ok(Math.abs(Date.now() - Date.parse(out.checkedAt)) < 60_000);
  const missing = await check(shop, siteOf(shop, { status: 404 }));
  assert.deepEqual([missing.ok, missing.reason, missing.httpStatus], [false, 'link.check_failed', 404]);
});

test('with no way to reach the internet, the check says it couldn\'t confirm the link', async () => {
  const shop = await addShop(world);
  const out = await check(shop, `https://not-registered-${unique()}.example/`);
  assert.deepEqual([out.ok, out.reason, out.httpStatus], [false, 'link.check_failed', null]);
});

test('a business gets 30 link checks a minute, and another business has its own', async () => {
  const [shop, other] = [await addShop(world), await addShop(world)];
  await saveNumber(shop);
  await saveNumber(other);
  for (let i = 0; i < 30; i++) await check(shop, 'https://wa.me/919876543210');
  const res = await shop.api('/links/check', { method: 'POST', body: { url: 'https://wa.me/919876543210' } });
  assert.equal(res.status, 429);
  assert.equal(res.json().code, 'rate_limited');
  assert.equal((await check(other, 'https://wa.me/919876543210')).ok, true);
});

test('a staff member without automations can\'t preview or check', async () => {
  const shop = await addShop(world);
  const staff = await addStaff(world, shop, { permissions: ['orders'] });
  for (const path of ['/links/preview', '/links/check']) assert.equal((await shop.api(path, { method: 'POST', token: staff.token, body: { url: 'https://site.example/' } })).status, 403);
  assert.equal((await shop.api('/links/taps', { token: staff.token })).status, 403);
});

// ---- measurement ids ----

test('A-33: an id is saved, listed, changed and removed, and each step is on the audit log', async () => {
  const shop = await addShop(world);
  const mediaId = await shop.reel();
  const saved = await amazonTag(shop, mediaId);
  assert.deepEqual([saved.mediaId, saved.kind, saved.network, saved.value, saved.warnings], [mediaId, 'amazon_tag', '', 'shopa-21', []]);
  assert.deepEqual((await shop.call('/measurement-ids', 200)).items.map((i) => i.id), [saved.id]);
  assert.equal((await shop.call(`/measurement-ids/${saved.id}`, 200, { method: 'PATCH', body: { value: 'shopb-21' } })).value, 'shopb-21');
  assert.equal((await shop.api(`/measurement-ids/${saved.id}`, { method: 'DELETE' })).status, 204);
  assert.deepEqual((await shop.call('/measurement-ids', 200)).items, []);
  assert.deepEqual((await auditOf(shop, 'measurement_id.%')).map((r) => r.action), ['measurement_id.save', 'measurement_id.update', 'measurement_id.remove']);
  assert.equal((await auditOf(shop, 'measurement_id.save'))[0].details.mediaId, mediaId);
});

test('PRD 6.6: a reel has one id of a kind, so setting it again replaces it', async () => {
  const shop = await addShop(world);
  const mediaId = await shop.reel();
  const first = await amazonTag(shop, mediaId, 'one-21');
  const second = await amazonTag(shop, mediaId, 'two-21');
  assert.equal(second.id, first.id);
  assert.deepEqual((await shop.call('/measurement-ids', 200)).items.map((i) => i.value), ['two-21']);
});

test('a network belongs only to an affiliate sub-ID, and two networks can each have one', async () => {
  const shop = await addShop(world);
  const mediaId = await shop.reel();
  assert.equal((await saveId(shop, { mediaId, kind: 'amazon_tag', network: 'whatever', value: 'a-21' })).network, '');
  assert.equal((await saveId(shop, { mediaId, kind: 'discount_code', network: 'whatever', value: 'DIWALI10' })).network, '');
  assert.equal((await saveId(shop, { mediaId, kind: 'affiliate_sub_id', network: 'CueLinks', value: 'r1' })).network, 'cuelinks');
  await saveId(shop, { mediaId, kind: 'affiliate_sub_id', network: 'admitad', value: 'r2' });
  assert.equal((await shop.call(`/measurement-ids?mediaId=${mediaId}`, 200)).items.length, 4);
});

for (const [label, body] of [
  ['a value with an ampersand', { mediaId: 'R1', kind: 'amazon_tag', value: 'x&evil=1' }],
  ['a value with a hash', { mediaId: 'R1', kind: 'amazon_tag', value: 'x#y' }],
  ['a value with a space', { mediaId: 'R1', kind: 'amazon_tag', value: 'x y' }],
  ['a value with a slash', { mediaId: 'R1', kind: 'amazon_tag', value: 'x/../y' }],
  ['a value with markup', { mediaId: 'R1', kind: 'discount_code', value: '<script>' }],
  ['a value starting with punctuation', { mediaId: 'R1', kind: 'amazon_tag', value: '-x' }],
  ['a value that isn\'t well formed', { mediaId: 'R1', kind: 'amazon_tag', value: 'x\ud800' }],
  ['a reel id that isn\'t one', { mediaId: 'a b', kind: 'amazon_tag', value: 'x' }],
  ['a reel id that can\'t be stored', { mediaId: 'x\ud800', kind: 'amazon_tag', value: 'x' }],
  ['a network with odd characters', { mediaId: 'R1', kind: 'affiliate_sub_id', network: 'a&b', value: 'x' }],
  ['no value', { mediaId: 'R1', kind: 'amazon_tag', value: '' }],
  ['an unknown kind', { mediaId: 'R1', kind: 'nonsense', value: 'x' }],
]) {
  test(`A-33: ${label} is refused and nothing is saved`, async () => {
    const shop = await addShop(world);
    const res = await shop.api('/measurement-ids', { method: 'POST', body });
    assert.equal(res.status, 400, res.text.slice(0, 200));
    assert.deepEqual((await shop.call('/measurement-ids', 200)).items, []);
  });
}

test('A-33: a change is held to the same rule', async () => {
  const shop = await addShop(world);
  const saved = await amazonTag(shop, await shop.reel());
  assert.equal((await shop.api(`/measurement-ids/${saved.id}`, { method: 'PATCH', body: { value: 'x&y' } })).status, 400);
  assert.equal((await shop.call('/measurement-ids', 200)).items[0].value, 'shopa-21');
});

test('the list pages, newest first, and filters by reel', async () => {
  const shop = await addShop(world);
  const reels = [];
  for (let i = 0; i < 5; i++) {
    reels.push(`R${i}`);
    await amazonTag(shop, `R${i}`, `t${i}-21`);
  }
  const first = await shop.call('/measurement-ids?limit=2', 200);
  assert.deepEqual(first.items.map((i) => i.mediaId), ['R4', 'R3']);
  const second = await shop.call(`/measurement-ids?limit=2&cursor=${first.nextCursor}`, 200);
  assert.deepEqual(second.items.map((i) => i.mediaId), ['R2', 'R1']);
  const last = await shop.call(`/measurement-ids?limit=2&cursor=${second.nextCursor}`, 200);
  assert.deepEqual([last.items.map((i) => i.mediaId), last.nextCursor], [['R0'], null]);
  assert.deepEqual((await shop.call('/measurement-ids?mediaId=R2', 200)).items.map((i) => i.value), ['t2-21']);
  assert.equal((await shop.api('/measurement-ids?cursor=bad-cursor')).status, 400);
});

test('A-33: one business can\'t read, change, remove or collide with another\'s ids', async () => {
  const [a, b] = [await addShop(world), await addShop(world)];
  const saved = await amazonTag(a, 'SAME-REEL', 'a-21');
  assert.deepEqual((await b.call('/measurement-ids', 200)).items, []);
  assert.equal((await b.api(`/measurement-ids/${saved.id}`, { method: 'PATCH', body: { value: 'b-21' } })).status, 404);
  assert.equal((await b.api(`/measurement-ids/${saved.id}`, { method: 'DELETE' })).status, 404);
  const theirs = await amazonTag(b, 'SAME-REEL', 'b-21');
  assert.notEqual(theirs.id, saved.id);
  assert.equal((await a.call('/measurement-ids', 200)).items[0].value, 'a-21');
});

test('A-35: the warning needs both reels live, in this business, of the same kind', async () => {
  const shop = await addShop(world);
  const [a, b] = [await shop.automate({ linkType: 'amazon', linkUrl: 'https://www.amazon.in/dp/A' }), await shop.automate({ linkType: 'amazon', linkUrl: 'https://www.amazon.in/dp/B' })];
  assert.deepEqual((await amazonTag(shop, a.mediaId, 'same-21')).warnings, []);
  assert.deepEqual((await saveId(shop, { mediaId: b.mediaId, kind: 'discount_code', value: 'same-21' })).warnings, [], 'Another kind of id is no clash');
  const clash = await amazonTag(shop, b.mediaId, 'same-21');
  assert.deepEqual(clash.warnings.map((w) => w.code), ['shared_measurement_id']);
  await shop.setState(a.id, 'paused');
  assert.deepEqual((await amazonTag(shop, b.mediaId, 'same-21')).warnings, [], 'A paused reel isn\'t live');
});

test('A-35: on a reel that isn\'t live there is nothing to warn about yet', async () => {
  const shop = await addShop(world);
  const [a, draft] = [await shop.automate({ linkType: 'amazon', linkUrl: 'https://www.amazon.in/dp/A' }), await shop.automate({ state: 'draft', linkType: 'amazon', linkUrl: 'https://www.amazon.in/dp/B' })];
  await amazonTag(shop, a.mediaId, 'same-21');
  assert.deepEqual((await amazonTag(shop, draft.mediaId, 'same-21')).warnings, []);
});

test('PRD 5.1: outside a business the repo refuses to run', async () => {
  await assert.rejects(world.platform.links.idsForMedia('R1'), NoTenantError);
  await assert.rejects(world.platform.links.tapSummaries({ limit: 1 }), NoTenantError);
  await assert.rejects(world.platform.links.clearFailedLink('https://x.example/', new Date()), NoTenantError);
});

// ---- going live ----

async function draftOn(shop, url) {
  const auto = await shop.automate({ linkUrl: url, state: 'draft' });
  await shop.sql(`UPDATE automations SET link_status = 'unchecked', link_checked_at = NULL WHERE id = $1`, [auto.id]);
  return auto;
}

test('PRD 4.11: going live checks the address as saved, without its tags, and remembers it passed', async () => {
  const shop = await addShop(world);
  const url = siteOf(shop);
  const auto = await draftOn(shop, url);
  const live = await shop.call(`/automations/${auto.id}/state`, 200, { method: 'POST', body: { state: 'live' } });
  assert.deepEqual([live.state, live.linkStatus], ['live', 'ok']);
  const [row] = await checksOf(shop);
  assert.deepEqual([row.url, row.ok, row.reason, row.http_status], [url, true, '', 200]);
  const [{ link_checked_at: at }] = await shop.sql('SELECT link_checked_at FROM automations WHERE id = $1', [auto.id]);
  assert.ok(at);
  assert.deepEqual((await auditOf(shop, 'automation.%')).map((r) => r.action), ['automation.create', 'automation.state'], 'A passing check adds nothing to the audit log');
});

test('C-64: a refused launch says why, stays a draft, is on record, and can be retried once the site is fixed', async () => {
  const shop = await addShop(world);
  const url = siteOf(shop, { status: 301, location: `https://other-${unique()}.example/` });
  const auto = await draftOn(shop, url);
  const res = await setState(shop, auto.id, 'live');
  assert.equal(res.status, 400);
  assert.deepEqual([res.json().code, res.json().reason], ['validation_failed', 'link.redirect']);
  assert.ok(res.json().fields.linkUrl);
  const after = await shop.call(`/automations/${auto.id}`, 200);
  assert.deepEqual([after.state, after.linkStatus], ['draft', 'unchecked']);
  const [row] = await checksOf(shop);
  assert.deepEqual([row.ok, row.reason, row.http_status], [false, 'link.redirect', 301]);
  fakeSite(url);
  assert.equal((await setState(shop, auto.id, 'live')).status, 200);
});

test('going to Test checks the link as well', async () => {
  const shop = await addShop(world);
  const auto = await draftOn(shop, siteOf(shop, { status: 500 }));
  const res = await setState(shop, auto.id, 'test');
  assert.deepEqual([res.status, res.json().reason], [400, 'link.check_failed']);
});

test('a WhatsApp link goes live on its number alone', async () => {
  const shop = await addShop(world);
  await saveNumber(shop);
  const auto = await draftOn(shop, 'https://wa.me/919876543210');
  assert.equal((await shop.call(`/automations/${auto.id}/state`, 200, { method: 'POST', body: { state: 'live' } })).linkStatus, 'ok');
  assert.equal((await checksOf(shop))[0].http_status, null);
});

test('with no way to reach the internet, going live isn\'t blocked and the link stays unchecked', async () => {
  const shop = await addShop(world);
  const auto = await draftOn(shop, shop.siteUrl(`/p/${unique()}`));
  const live = await shop.call(`/automations/${auto.id}/state`, 200, { method: 'POST', body: { state: 'live' } });
  assert.deepEqual([live.state, live.linkStatus], ['live', 'unchecked']);
  assert.deepEqual(await checksOf(shop), []);
});

// ---- the daily check ----

test('C-64: a live automation whose link now redirects is paused, the owner is told, and it is on every record', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ linkUrl: redirectingSite(shop) });
  await makeDue(shop, auto.id);
  await shop.settle();
  const after = await shop.call(`/automations/${auto.id}`, 200);
  assert.deepEqual([after.state, after.linkStatus], ['paused', 'failed']);
  const [{ paused_reason: pausedReason }] = await shop.sql('SELECT paused_reason FROM automations WHERE id = $1', [auto.id]);
  assert.equal(pausedReason, 'link.redirect');
  const [alert] = await shop.alerts();
  assert.deepEqual([alert.kind, alert.target], ['link.redirect', String(auto.id)]);
  assert.match(alert.message, new RegExp(auto.name));
  const [row] = await checksOf(shop);
  assert.deepEqual([row.ok, row.reason, row.http_status], [false, 'link.redirect', 301]);
  assert.equal((await auditOf(shop, 'automation.state'))[0].actor, 'system:link_check');
  assert.ok((await shop.events('kind = $2', ['link_check'])).some((e) => e.reason === 'link.redirect' && e.automation_id === auto.id));
});

test('C-64: nothing goes out on a link that has failed, and a later comment is held', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ linkUrl: redirectingSite(shop) });
  await makeDue(shop, auto.id);
  await shop.settle();
  await world.switchLag();
  await shop.comment(auto.mediaId);
  await shop.settle();
  assert.deepEqual(await shop.dms(), []);
  assert.deepEqual((await shop.jobs()).map((j) => [j.status, j.reason]), [['held', 'paused.automation']]);
});

test('PRD 4.11: a passing daily check moves the date on and leaves the automation live', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ linkUrl: siteOf(shop) });
  await makeDue(shop, auto.id);
  await shop.settle();
  const [row] = await shop.sql('SELECT state, link_status, link_checked_at FROM automations WHERE id = $1', [auto.id]);
  assert.deepEqual([row.state, row.link_status], ['live', 'ok']);
  assert.ok(Date.now() - new Date(row.link_checked_at).getTime() < 60_000);
  assert.equal((await checksOf(shop)).length, 1);
  await shop.settle();
  assert.equal((await checksOf(shop)).length, 1, 'Once a day, not once a tick');
  assert.deepEqual(await shop.alerts(), []);
});

test('the daily check leaves alone what isn\'t live, and what isn\'t due', async () => {
  const shop = await addShop(world);
  const broken = () => redirectingSite(shop);
  const [draft, paused, fresh] = [await shop.automate({ linkUrl: broken(), state: 'draft' }), await shop.automate({ linkUrl: broken(), state: 'paused' }), await shop.automate({ linkUrl: broken() })];
  await makeDue(shop, draft.id);
  await makeDue(shop, paused.id);
  await shop.settle();
  assert.deepEqual(await checksOf(shop), []);
  assert.equal((await shop.call(`/automations/${fresh.id}`, 200)).state, 'live');
});

test('with no way to reach the internet, the daily check pauses nothing', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ linkUrl: shop.siteUrl(`/p/${unique()}`) });
  await makeDue(shop, auto.id);
  await shop.settle();
  assert.equal((await shop.call(`/automations/${auto.id}`, 200)).state, 'live');
  assert.deepEqual(await checksOf(shop), []);
  assert.deepEqual(await shop.alerts(), []);
});

test('PRD 4.11: a live automation whose link is edited is checked without waiting a day', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ linkUrl: siteOf(shop) });
  await shop.call(`/automations/${auto.id}`, 200, { method: 'PATCH', body: { linkUrl: redirectingSite(shop) } });
  await shop.settle();
  assert.equal((await shop.call(`/automations/${auto.id}`, 200)).state, 'paused');
});

test('an answer about a link the owner has since changed changes nothing', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ linkUrl: siteOf(shop) });
  const verdict = { ok: false, reason: 'link.redirect', httpStatus: 301 };
  assert.equal(await shop.repos.links.pauseForFailedLink(auto.id, 'https://the-old-link.example/', verdict, new Date()), false);
  await shop.repos.links.linkPassed(auto.id, 'https://the-old-link.example/', { ok: true, reason: null, httpStatus: 200 }, new Date());
  assert.equal((await shop.call(`/automations/${auto.id}`, 200)).state, 'live');
  assert.deepEqual(await checksOf(shop), []);
});

test('one business\'s repo can\'t pause another\'s automation', async () => {
  const [a, b] = [await addShop(world), await addShop(world)];
  const url = siteOf(a);
  const auto = await a.automate({ linkUrl: url });
  assert.equal(await b.repos.links.pauseForFailedLink(auto.id, url, { ok: false, reason: 'link.redirect', httpStatus: 301 }, new Date()), false);
  assert.equal((await a.call(`/automations/${auto.id}`, 200)).state, 'live');
});

test('C-64: after a failed link is fixed, checking it again lets the automation go back live', async () => {
  const shop = await addShop(world);
  const url = redirectingSite(shop);
  const auto = await shop.automate({ linkUrl: url });
  await makeDue(shop, auto.id);
  await shop.settle();
  const stuck = await setState(shop, auto.id, 'live');
  assert.deepEqual([stuck.status, stuck.json().reason], [400, 'link.check_failed']);
  fakeSite(url);
  assert.equal((await check(shop, url)).ok, true);
  assert.equal((await shop.call(`/automations/${auto.id}/state`, 200, { method: 'POST', body: { state: 'live' } })).state, 'live');
});

test('a failing re-check clears nothing, and another business\'s check clears nothing here', async () => {
  const [a, b] = [await addShop(world), await addShop(world)];
  const url = redirectingSite(a);
  const auto = await a.automate({ linkUrl: url });
  await makeDue(a, auto.id);
  await a.settle();
  assert.equal((await check(a, url)).ok, false);
  assert.equal((await a.call(`/automations/${auto.id}`, 200)).linkStatus, 'failed');
  fakeSite(url);
  assert.equal((await check(b, url)).ok, true);
  assert.equal((await a.call(`/automations/${auto.id}`, 200)).linkStatus, 'failed');
});

// ---- the links that really go out ----

test('C-41, C-62: what the builder saved is what goes out, as a plain button to the destination', async () => {
  const shop = await addShop(world);
  const mediaId = await shop.reel();
  await amazonTag(shop, mediaId);
  const auto = await shop.automate({ mediaId, linkType: 'amazon', linkUrl: 'https://www.amazon.in/dp/B0?th=1' });
  await shop.comment(auto.mediaId);
  await shop.settle();
  const [dm] = await shop.dms();
  assert.equal(buttonsOf(dm)[0].type, 'web_url');
  assert.equal(linkOf(dm), 'https://www.amazon.in/dp/B0?th=1&tag=shopa-21');
});

test('C-62: this track adds no route that forwards anyone anywhere', async () => {
  const shop = await addShop(world);
  for (const path of ['/links/abc', '/l/abc', '/go/abc', '/link/abc']) {
    const res = await hit(world, path, { host: shop.host });
    assert.equal(res.headers.location, undefined, path);
  }
});
