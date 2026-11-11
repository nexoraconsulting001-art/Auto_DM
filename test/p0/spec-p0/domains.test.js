// PRD 5.2 and 5.4: which business an address serves, what links are generated, and custom domains.
// The HTTPS half of F-16 (a real certificate on the first request) needs real DNS and Caddy: it is a live check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS_DIR } from '../../../src/db/index.js';
import { CONSOLE_HOST, NEUTRAL, addBusiness, addReel, api, consoleUser, hit, need, noPlatformName, onConsole, pageSource, signIn, startWorld, titleOf } from './support.js';
import { askForCertificate, consolePaths, fakeDns, fakeMail, hooks, sellerPaths } from './surfaces.js';

const repoRoot = path.resolve(MIGRATIONS_DIR, '..', '..', '..');

test('F-07: a business\'s primary domain serves its own storefront with its brand kit', async (t) => {
  const app = await startWorld(t);
  const mehta = await addBusiness(app, { slug: 'mehtamart', name: 'Mehta Mart', domain: 'mehtamart.example' });
  const plant = await addBusiness(app, { slug: 'plantstore', name: 'Plant Store', domain: 'plantstore.example' });
  await mehta.repos.brandKit.save({ colors: { primary: '#234D33' }, headingFont: 'Playfair Display' });
  await plant.repos.brandKit.save({ colors: { primary: '#123456' }, headingFont: 'Lora' });

  const { res, source } = await pageSource(app, 'mehtamart.example', '/');
  need(res, 200, 'Mehta Mart home page');
  assert.match(titleOf(res.text), /Mehta Mart/);
  assert.match(source, /#234D33/i, 'the page uses the business\'s own primary colour');
  assert.match(source, /Playfair[ +]Display/, 'the page uses the business\'s own heading font');
  assert.doesNotMatch(res.text, /Plant Store/);
  assert.doesNotMatch(source, /#123456/i, 'and not another business\'s colour');

  const upper = await hit(app, '/', { host: 'MehtaMart.Example:443' });
  need(upper, 200, 'The same address in capitals with a port');
  assert.match(titleOf(upper.text), /Mehta Mart/);
});

test('F-08: an unknown host gets a neutral 404 with no brand of any kind', async (t) => {
  const app = await startWorld(t);
  await addBusiness(app, { slug: 'mehtamart', name: 'Mehta Mart' });
  for (const pathname of ['/', '/shop', '/p/anything', '/admin']) {
    const res = await hit(app, pathname, { host: 'unknown.example' });
    assert.equal(res.status, 404, pathname);
    noPlatformName(`404 for ${pathname}`, res.text);
    noPlatformName(`404 headers for ${pathname}`, res.headers);
    assert.doesNotMatch(res.text, /Mehta|Test store/, 'no business is named');
    assert.doesNotMatch(res.text, /<img|<link[^>]+stylesheet|fonts\.googleapis/i, 'no logo, theme or font');
  }
});

test('F-08: a reserved host never resolves to a business, even if one claims it', async (t) => {
  const app = await startWorld(t);
  const shop = await addBusiness(app, { slug: 'grabby', name: 'Grabby Shop' });
  await app.db.query('INSERT INTO tenant_domains (domain, tenant_id) VALUES ($1, $2)', [CONSOLE_HOST, shop.tenant.id]);
  const res = await hit(app, '/', { host: CONSOLE_HOST });
  assert.doesNotMatch(res.text, /Grabby Shop/);
});

test('F-09: a spoofed X-Forwarded-Host of B does not change links generated for A', async (t) => {
  const app = await startWorld(t);
  const a = await addBusiness(app, { slug: 'alpha-store', name: 'Alpha Store' });
  const b = await addBusiness(app, { slug: 'beta-store', name: 'Beta Store' });
  const reelId = '17900000000000001';
  await addReel(a, reelId);
  const token = await signIn(app, a);
  const spoofed = { headers: { 'x-forwarded-host': b.host } };

  // Since Phase 4 a token for A that arrives on B's own address is refused outright (test/p4/db-login/bearer-address.test.js),
  // so no link is generated there at all. An address that belongs to no business is the next test.
  for (const path of [`/reels/${reelId}`, '/settings/setup']) {
    const refused = need(await api(app, a, token, path, spoofed), 401, 'A token on another business address');
    assert.doesNotMatch(refused.text, /beta-store|storeUrl/);
  }

  // On A's own address the link is A's.
  const reel = need(await api(app, a, token, `/reels/${reelId}`), 200, 'Read reel');
  const link = new URL(reel.json().storeUrl);
  assert.equal(link.protocol, 'https:');
  assert.equal(link.hostname, a.host, "the DM link is on A's own address");
  assert.doesNotMatch(reel.text, /beta-store/);
});

test('F-09: generated links ignore a Host header naming somewhere else', async (t) => {
  const app = await startWorld(t);
  const a = await addBusiness(app, { slug: 'alpha-store', name: 'Alpha Store' });
  const reelId = '17900000000000002';
  await addReel(a, reelId);
  const token = await signIn(app, a);
  const elsewhere = { host: 'attacker.example', headers: { 'x-forwarded-host': 'attacker.example' } };
  const reel = need(await api(app, a, token, `/reels/${reelId}`, elsewhere), 200, 'Read reel');
  assert.equal(new URL(reel.json().storeUrl).hostname, a.host);
  assert.doesNotMatch(reel.text, /attacker/);
});

test('F-10: X-Tenant-Id of a business the user does not belong to is 403', async (t) => {
  const app = await startWorld(t);
  const a = await addBusiness(app, { slug: 'alpha-store', name: 'Alpha Store' });
  const b = await addBusiness(app, { slug: 'beta-store', name: 'Beta Store' });
  const token = await signIn(app, a);
  const asTenant = (id, route) => api(app, a, token, route, { headers: { 'x-tenant-id': String(id) } });

  need(await asTenant(a.tenant.id, '/auth/me'), 200, 'Own business in the header');
  for (const route of ['/auth/me', '/products', '/orders', '/settings']) {
    const res = await asTenant(b.tenant.id, route);
    assert.equal(res.status, 403, route);
    assert.equal(res.json().code, 'forbidden', route);
    assert.doesNotMatch(res.text, /Beta Store/, route);
  }
  assert.equal((await asTenant('999999', '/products')).status, 403, 'a business that does not exist');
  for (const nonsense of ['abc', '-1', `${a.tenant.id}, ${b.tenant.id}`]) {
    assert.ok([400, 403].includes((await asTenant(nonsense, '/products')).status), `header value ${nonsense}`);
  }
});

// ---- Custom domains ----

async function domainWorld(t, options = {}) {
  const dns = fakeDns();
  const mail = fakeMail();
  const app = await startWorld(t, { ...options, overrides: { [hooks.dns]: dns, [hooks.mail]: mail, ...options.overrides } });
  const shop = await addBusiness(app, { slug: 'kesar-home', name: 'Kesar Home' });
  const token = await signIn(app, shop);
  const addDomain = async (domain) => need(await api(app, shop, token, sellerPaths.domains, { method: 'POST', body: { domain } }), 201, 'Add a custom domain').json();
  const check = async (id) => need(await api(app, shop, token, sellerPaths.domainCheck(id), { method: 'POST' }), 200, 'Run the DNS check').json();
  const verify = async (domain) => {
    const added = await addDomain(domain);
    dns.publish(added.records);
    assert.equal((await check(added.id)).status, 'verified');
    return added;
  };
  return { app, dns, mail, shop, token, addDomain, check, verify };
}

test('F-16: a domain with its CNAME and TXT records verifies and is then served and allowed a certificate', async (t) => {
  const { app, shop, dns, addDomain, check } = await domainWorld(t);
  const added = await addDomain('shop.kesarhome.example');
  assert.equal(added.status, 'pending');
  const txt = added.records.find((r) => r.type === 'TXT');
  const cname = added.records.find((r) => r.type === 'CNAME');
  assert.equal(txt.name, '_site-verification.shop.kesarhome.example');
  assert.ok(txt.value.length >= 16, 'the token is hard to guess');
  assert.equal(cname.value, `edge.${NEUTRAL}`);

  dns.publish(added.records);
  assert.equal((await check(added.id)).status, 'verified');
  need(await askForCertificate(app, 'shop.kesarhome.example'), 200, 'The certificate check for a verified domain');
  const page = need(await hit(app, '/', { host: 'shop.kesarhome.example' }), 200, 'The store on its own domain');
  assert.match(titleOf(page.text), new RegExp(shop.name));
});

test('F-16: each business proves ownership with its own token', async (t) => {
  const { app, addDomain } = await domainWorld(t);
  const other = await addBusiness(app, { slug: 'leaf-and-clay', name: 'Leaf and Clay' });
  const first = await addDomain('one.kesarhome.example');
  const second = need(await api(app, other, await signIn(app, other), sellerPaths.domains, { method: 'POST', body: { domain: 'one.leafandclay.example' } }), 201, 'Add a domain').json();
  const token = (added) => added.records.find((r) => r.type === 'TXT').value;
  assert.notEqual(token(first), token(second));
});

test('F-17: an unverified domain pointed at the platform is denied a certificate', async (t) => {
  const { app, addDomain, verify } = await domainWorld(t);
  await verify('good.kesarhome.example');
  need(await askForCertificate(app, 'good.kesarhome.example'), 200, 'Positive control: a verified domain');

  assert.notEqual((await askForCertificate(app, 'evil.example')).status, 200, 'a domain no business has claimed');
  await addDomain('pending.kesarhome.example');
  assert.notEqual((await askForCertificate(app, 'pending.kesarhome.example')).status, 200, 'a domain added but not verified');
});

test('F-17: a closed business\'s verified domain is denied a certificate', async (t) => {
  const { app, shop, verify } = await domainWorld(t);
  await verify('gone.kesarhome.example');
  await app.db.query(`UPDATE tenants SET status = 'closed' WHERE id = $1`, [shop.tenant.id]);
  assert.notEqual((await askForCertificate(app, 'gone.kesarhome.example')).status, 200);
});

test('F-18: when the TXT record is still missing after 72 h, checks stop and owner and console are alerted', async (t) => {
  const { app, dns, mail, shop, addDomain, check } = await domainWorld(t);
  const operator = await consoleUser(app);
  const added = await addDomain('late.kesarhome.example');
  assert.equal((await check(added.id)).status, 'pending', 'within 72 h the check keeps waiting');
  await app.db.query(`UPDATE tenant_domains SET created_at = now() - interval '73 hours' WHERE domain = $1`, ['late.kesarhome.example']);

  const stopped = await check(added.id);
  assert.ok(['failed', 'stopped', 'expired'].includes(stopped.status), `status after 72 h: ${stopped.status}`);
  const lookups = dns.calls;
  await check(added.id);
  assert.equal(dns.calls, lookups, 'no more DNS lookups once the checks have stopped');

  const ownerEmailed = mail.sent.some((m) => /domain/i.test(`${m.subject} ${m.text ?? m.html}`));
  assert.ok(ownerEmailed, `The owner got no alert about the domain. Mail sent: ${mail.sent.length}`);
  const alerts = need(await onConsole(app, operator, consolePaths.alerts), 200, 'Console alerts');
  assert.match(alerts.text, /late\.kesarhome\.example/);
  assert.ok(shop.tenant.id);
});

test('F-19: buyer pages and their headers carry no platform name', async (t) => {
  const app = await startWorld(t);
  const shop = await addBusiness(app, { slug: 'kesar-home', name: 'Kesar Home' });
  const { products, reel } = await addReel(shop, '17900000000000003');
  for (const pathname of ['/', '/shop', `/p/${products[0].slug}`, `/r/${reel.slug}`]) {
    const res = await hit(app, pathname, { host: shop.host });
    need(res, 200, pathname);
    noPlatformName(`${pathname} headers`, res.headers);
  }
  noPlatformName('A fallback host', `${shop.slug}.${NEUTRAL}`);
});

test('F-19: the DNS records a seller is told to add carry no platform name', async (t) => {
  const { addDomain } = await domainWorld(t);
  const added = await addDomain('shop.kesarhome.example');
  assert.ok(added.records.length >= 2);
  noPlatformName('DNS records', added.records);
});

test('F-19: the sample settings never make the neutral buyer domain one that names the platform', () => {
  const sample = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
  for (const line of sample.split('\n').filter((l) => /PLATFORM_DOMAIN\s*=/.test(l) || /PLATFORM_DOMAIN \(e\.g\./.test(l))) {
    noPlatformName(`.env.example: ${line}`, line);
  }
});

test('F-20: after the primary changes from X to Y, X answers 301 to the same path on Y', async (t) => {
  const { app, shop, token, verify } = await domainWorld(t);
  await verify('x.kesarhome.example');
  await verify('y.kesarhome.example');
  const change = async (domain) => need(await api(app, shop, token, sellerPaths.domainPrimary, { method: 'PUT', body: { domain } }), 200, 'Set the primary domain');
  await change('x.kesarhome.example');
  need(await hit(app, '/', { host: 'x.kesarhome.example' }), 200, 'X while it is the primary');

  await change('y.kesarhome.example');
  need(await hit(app, '/', { host: 'y.kesarhome.example' }), 200, 'Y once it is the primary');
  const moved = await hit(app, '/shop?sort=price-desc', { host: 'x.kesarhome.example' });
  assert.equal(moved.status, 301);
  assert.equal(moved.headers.location, 'https://y.kesarhome.example/shop?sort=price-desc');
});

test('F-20: changing the primary also changes generated links', async (t) => {
  const { app, shop, token, verify } = await domainWorld(t);
  await verify('z.kesarhome.example');
  need(await api(app, shop, token, sellerPaths.domainPrimary, { method: 'PUT', body: { domain: 'z.kesarhome.example' } }), 200, 'Set the primary domain');
  const setup = need(await api(app, shop, token, '/settings/setup'), 200, 'Read setup').json();
  assert.equal(new URL(setup.storeUrl).hostname, 'z.kesarhome.example');
});
