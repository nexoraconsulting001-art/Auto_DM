// PRD 5.2 and 5.4: custom domains, beyond the scenarios in test/p0/spec-p0/domains.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../../../src/platform/cache.js';
import { domains } from '../../../src/modules/domains/index.js';
import { createDomainService } from '../../../src/modules/domains/service.js';
import { NoTenantError, withTenant } from '../../../src/tenancy.js';
import { bindTenant } from '../../../src/repos/index.js';
import { CONSOLE_HOST, NEUTRAL, addBusiness, addStaff, api, captureLogs, consoleUser, hit, need, onConsole, signIn, titleOf } from '../../p0/spec-p0/support.js';
import { askForCertificate } from '../../p0/spec-p0/surfaces.js';
import { EDGE_IP, domainWorld } from './support.js';

const isDenied = (res) => res.status !== 200;

test('adding a domain normalises whatever the owner typed', async (t) => {
  const { added, list } = await domainWorld(t);
  assert.equal((await added('HTTPS://Shop.KesarHome.Example/some/page?x=1')).id, 'shop.kesarhome.example');
  assert.equal((await added('münchen.example.')).domain, 'xn--mnchen-3ya.example');
  assert.deepEqual((await list()).map((d) => d.domain).sort(), ['shop.kesarhome.example', 'xn--mnchen-3ya.example']);
});

test('an address that is not the seller\'s own to claim is refused and nothing is stored', async (t) => {
  const { app, add, shop } = await domainWorld(t);
  for (const bad of ['localhost', 'printer.local', 'box.internal', '10.0.0.5', '192.168.1.1', 'nodots', 'two..dots.example', '-bad.example', 'bad-.example',
    `${'a'.repeat(64)}.example`, NEUTRAL, `kesar-home.${NEUTRAL}`, `someone-else.${NEUTRAL}`, CONSOLE_HOST, `edge.${NEUTRAL}`]) {
    const res = await add(bad);
    assert.equal(res.status, 400, bad);
    assert.equal(res.json().code, 'validation_failed', bad);
  }
  assert.deepEqual(await app.db.query('SELECT domain FROM tenant_domains WHERE tenant_id = $1', [shop.tenant.id]), []);
});

test('only the owner changes domains, staff with catalog can read them, and the free plan has none', async (t) => {
  const { app, shop, added } = await domainWorld(t);
  const row = await added('shop.kesarhome.example');
  const staff = await addStaff(app, shop, { permissions: ['catalog'] });
  const asStaff = (path, options) => api(app, shop, staff.token, path, options);
  need(await asStaff('/domains'), 200, 'Staff with catalog lists domains');
  for (const [path, method, body] of [['/domains', 'POST', { domain: 'x.kesarhome.example' }], [`/domains/${row.id}/check`, 'POST'], ['/domains/primary', 'PUT', { domain: row.id }], [`/domains/${row.id}`, 'DELETE']]) {
    assert.equal((await asStaff(path, { method, body })).status, 403, `${method} ${path}`);
  }

  const free = await addBusiness(app, { slug: 'free-shop', name: 'Free Shop', plan: 'free' });
  const res = await api(app, free, await signIn(app, free), '/domains', { method: 'POST', body: { domain: 'free.example' } });
  assert.equal(res.status, 403);
  assert.match(res.json().error, /plan/);
});

test('one business can neither see nor touch another business\'s domain', async (t) => {
  const { app, verified, list, other } = await domainWorld(t);
  await verified('mine.kesarhome.example');
  const them = await other('leaf-and-clay', 'Leaf and Clay');
  assert.deepEqual(await them.list(), []);
  assert.equal((await them.check('mine.kesarhome.example')).status, 404);
  assert.equal((await them.remove('mine.kesarhome.example')).status, 404);
  assert.equal((await them.primary('mine.kesarhome.example')).status, 404);
  assert.equal((await list()).length, 1, 'still there');

  const scoped = bindTenant(app.platform, them.business.tenant);
  assert.equal(await scoped.domains.get('mine.kesarhome.example'), null);
  await assert.rejects(() => app.platform.domains.list(), NoTenantError);
});

test('a verified domain is exclusive to its business, unless that business has closed', async (t) => {
  const { app, verified, shop, other, add } = await domainWorld(t);
  await verified('held.kesarhome.example');
  const them = await other('leaf-and-clay', 'Leaf and Clay');
  const res = await them.add('held.kesarhome.example');
  assert.equal(res.status, 409);
  assert.match(res.json().error, /another business/);
  assert.equal((await add('held.kesarhome.example')).status, 409, 'adding it twice is refused too');

  need(await askForCertificate(app, 'held.kesarhome.example'), 200, 'Still served');
  await app.db.query(`UPDATE tenants SET status = 'closed' WHERE id = $1`, [shop.tenant.id]);
  const taken = need(await them.add('held.kesarhome.example'), 201, 'A closed business no longer holds it').json();
  assert.equal(taken.status, 'pending', 'and the new owner still has to prove it');
  assert.ok(isDenied(await askForCertificate(app, 'held.kesarhome.example')));
});

test('no one can squat on an unverified domain, and only the token really in DNS can win it', async (t) => {
  const { dns, added, check, list, other } = await domainWorld(t);
  const mine = await added('wanted.kesarhome.example');
  dns.publish(mine.records); // the real owner's records are live, but their check hasn't run

  const them = await other('squatter', 'Squatter');
  const claimed = await them.added('wanted.kesarhome.example');
  assert.notEqual(claimed.records[0].value, mine.records[0].value);
  assert.equal((await them.check(claimed.id)).json().status, 'pending', 'someone else\'s TXT proves nothing');
  assert.deepEqual(await list(), [], 'the row has moved');

  const again = await added('wanted.kesarhome.example');
  assert.equal(again.records[0].value, mine.records[0].value, 'the owner\'s token is the same as before, so their TXT still counts');
  assert.equal((await check(again.id)).json().status, 'verified');
  assert.equal((await them.check(claimed.id)).status, 404);
  assert.equal((await them.add('wanted.kesarhome.example')).status, 409);
});

test('a business uses one token for all its domains', async (t) => {
  const { added } = await domainWorld(t);
  const txt = (row) => row.records.find((r) => r.type === 'TXT').value;
  assert.equal(txt(await added('one.kesarhome.example')), txt(await added('two.kesarhome.example')));
});

test('verification needs both the TXT with the right token and the routing record', async (t) => {
  const { dns, added, check, primary } = await domainWorld(t);
  const row = await added('half.kesarhome.example');
  const txt = row.records.find((r) => r.type === 'TXT');
  const cname = row.records.find((r) => r.type === 'CNAME');

  dns.publish([{ ...txt, value: 'not-the-token' }, cname]);
  assert.equal((await check(row.id)).json().status, 'pending', 'wrong token');
  dns.unpublish('CNAME', cname.name);
  dns.publish([txt]);
  assert.equal((await check(row.id)).json().status, 'pending', 'no routing yet');
  assert.equal((await primary(row.id)).status, 409, 'and an unverified domain can\'t become the primary');
  dns.publish([cname]);
  const done = (await check(row.id)).json();
  assert.equal(done.status, 'verified');
  assert.ok(done.verifiedAt && done.lastCheckedAt);
});

test('an apex is told to use A records, and verifies through them', async (t) => {
  const { dns, added, check } = await domainWorld(t, { edgeAddress: EDGE_IP });
  const row = await added('kesarhome.example');
  assert.deepEqual(row.records.filter((r) => r.type !== 'TXT'), [{ type: 'A', name: 'kesarhome.example', value: EDGE_IP }]);
  dns.publish(row.records);
  assert.equal((await check(row.id)).json().status, 'verified');

  const wrong = await added('elsewhere.example');
  dns.publish([wrong.records[0], { type: 'A', name: 'elsewhere.example', value: '198.51.100.7' }]);
  assert.equal((await check(wrong.id)).json().status, 'pending', 'an address that is not ours');
});

test('the non-primary of www and the apex always answers 301 to the primary', async (t) => {
  const { app, verified, primary } = await domainWorld(t, { edgeAddress: EDGE_IP });
  await verified('kesarhome.example');
  await verified('www.kesarhome.example');
  await verified('blog.kesarhome.example');
  need(await primary('www.kesarhome.example'), 200, 'Primary on www');

  const apex = await hit(app, '/shop?a=1', { host: 'kesarhome.example' });
  assert.equal(apex.status, 301);
  assert.equal(apex.headers.location, 'https://www.kesarhome.example/shop?a=1');
  need(await hit(app, '/', { host: 'www.kesarhome.example' }), 200, 'The primary itself');
  need(await hit(app, '/', { host: 'blog.kesarhome.example' }), 200, 'Another verified domain is served as it is');

  need(await primary('kesarhome.example'), 200, 'Primary back on the apex');
  const www = await hit(app, '/', { host: 'www.kesarhome.example' });
  assert.equal(www.status, 301);
  assert.equal(www.headers.location, 'https://kesarhome.example/');
});

test('a replaced primary keeps its 301 for 12 months, with no chains', async (t) => {
  const { app, verified, primary, shop } = await domainWorld(t);
  for (const name of ['x', 'y', 'z']) await verified(`${name}.kesarhome.example`);
  for (const name of ['x', 'y', 'z']) need(await primary(`${name}.kesarhome.example`), 200, `Primary ${name}`);

  const rows = await app.db.query('SELECT domain, is_primary, redirect_to, redirect_until FROM tenant_domains WHERE tenant_id = $1 ORDER BY domain', [shop.tenant.id]);
  assert.deepEqual(rows.map((r) => [r.is_primary, r.redirect_to]), [[false, 'z.kesarhome.example'], [false, 'z.kesarhome.example'], [true, '']]);
  const days = (new Date(rows[0].redirect_until) - Date.now()) / 86_400_000;
  assert.ok(days > 360 && days < 370, `kept for ${days} days`);
  assert.equal((await hit(app, '/', { host: 'x.kesarhome.example' })).headers.location, 'https://z.kesarhome.example/', 'straight to the current primary');

  await app.db.query(`UPDATE tenant_domains SET redirect_until = now() - interval '1 day' WHERE domain = 'y.kesarhome.example'`);
  need(await hit(app, '/', { host: 'y.kesarhome.example' }), 200, 'After 12 months it is served again');
});

test('choosing a domain that is already the primary changes nothing, and links can go back to the fallback host', async (t) => {
  const { app, verified, primary, shop, list } = await domainWorld(t);
  await verified('x.kesarhome.example');
  need(await primary('x.kesarhome.example'), 200, 'Primary');
  need(await primary('x.kesarhome.example'), 200, 'The same primary again');
  need(await hit(app, '/', { host: 'x.kesarhome.example' }), 200, 'Still served, not redirected to itself');

  const fallback = `${shop.slug}.${NEUTRAL}`;
  const res = need(await primary(fallback), 200, 'Back to the fallback host').json();
  assert.equal(res.isPrimary, true);
  assert.equal(res.domain, fallback);
  assert.equal((await list())[0].isPrimary, false);
  assert.equal((await hit(app, '/p?q=1', { host: 'x.kesarhome.example' })).headers.location, `https://${fallback}/p?q=1`);
});

test('a domain that isn\'t in the list can\'t become the primary, whatever is typed', async (t) => {
  const { primary } = await domainWorld(t);
  for (const typed of ['nope.example', '!!!', 'https://']) assert.equal((await primary(typed)).status, 404, typed);
});

test('removing a domain stops it being served; the primary has to be replaced first', async (t) => {
  const { app, shop, verified, primary, remove, list } = await domainWorld(t);
  await verified('keep.kesarhome.example');
  await verified('drop.kesarhome.example');
  need(await primary('keep.kesarhome.example'), 200, 'Primary');
  assert.equal((await remove('keep.kesarhome.example')).status, 409);
  assert.equal((await remove('missing.kesarhome.example')).status, 404);
  need(await remove('drop.kesarhome.example'), 204, 'Remove');
  assert.deepEqual((await list()).map((d) => d.domain), ['keep.kesarhome.example']);
  assert.ok(isDenied(await askForCertificate(app, 'drop.kesarhome.example')));

  const log = await app.db.query(`SELECT action, target FROM audit_log WHERE tenant_id = $1 AND action LIKE 'domain.%' ORDER BY id`, [shop.tenant.id]);
  assert.deepEqual(log.map((r) => r.action), ['domain.add', 'domain.add', 'domain.primary', 'domain.remove']);
});

test('only pages are redirected: POSTs and the API keep working on an old primary', async (t) => {
  const { app, token, verified, primary } = await domainWorld(t);
  await verified('old.kesarhome.example');
  await verified('new.kesarhome.example');
  need(await primary('old.kesarhome.example'), 200, 'Old');
  need(await primary('new.kesarhome.example'), 200, 'New');
  assert.equal((await hit(app, '/shop', { host: 'old.kesarhome.example', method: 'HEAD' })).status, 301);
  need(await hit(app, '/api/v1/auth/me', { host: 'old.kesarhome.example', token }), 200, 'The API on the old address');
  assert.notEqual((await hit(app, '/login', { host: 'old.kesarhome.example', method: 'POST', body: {} })).status, 301);
});

test('when the routing lookup fails, the page is still served', async () => {
  const service = createDomainService({
    repos: { domains: { routeOf: async () => { throw new Error('database gone'); } } },
    platform: { cache: createCache({ cacheDriver: 'memory' }) },
    config: { platformDomain: NEUTRAL, sessionSecret: 's', dnsResolver: {} },
  });
  let passed = false;
  await service.redirect({ method: 'GET', originalUrl: '/', hostname: 'shop.kesarhome.example' }, {}, () => { passed = true; });
  assert.ok(passed);
});

test('a failed look-up of our own edge address isn\'t remembered', async (t) => {
  const { dns, added, check } = await domainWorld(t);
  const row = await added('kesarhome.example');
  assert.equal(row.records.find((r) => r.type !== 'TXT').type, 'CNAME');
  dns.publish([{ type: 'A', name: `edge.${NEUTRAL}`, value: EDGE_IP }, row.records[0], { type: 'A', name: 'kesarhome.example', value: EDGE_IP }]);
  const after = (await check(row.id)).json();
  assert.equal(after.status, 'verified');
  assert.equal(after.records.find((r) => r.type !== 'TXT').type, 'A');
});

test('a Host header can\'t turn the redirect into one to somewhere else', async (t) => {
  const { app, verified, primary } = await domainWorld(t);
  await verified('old.kesarhome.example');
  await verified('new.kesarhome.example');
  need(await primary('old.kesarhome.example'), 200, 'Old');
  need(await primary('new.kesarhome.example'), 200, 'New');
  const res = await hit(app, '//attacker.example/%2e%2e', { host: 'old.kesarhome.example', headers: { 'x-forwarded-host': 'old.kesarhome.example' } });
  assert.equal(res.status, 301);
  assert.equal(new URL(res.headers.location).hostname, 'new.kesarhome.example');
});

test('the certificate check: reserved hosts never, fallback hosts of live businesses yes, bad questions no', async (t) => {
  const { app, shop, verified } = await domainWorld(t);
  await verified('shop.kesarhome.example');
  need(await askForCertificate(app, 'SHOP.KesarHome.Example.'), 200, 'Case and a trailing dot don\'t matter');
  need(await hit(app, '/tls/ask?domain=shop.kesarhome.example', { host: '127.0.0.1' }), 200, 'Caddy reaching the app by its internal address');
  need(await askForCertificate(app, `${shop.slug}.${NEUTRAL}`), 200, 'The fallback host');

  for (const label of ['admin', 'www', 'app', 'api', 'bhava', 'edge']) {
    await app.db.query('INSERT INTO tenant_domains (domain, tenant_id) VALUES ($1, $2)', [`${label}.${NEUTRAL}`, shop.tenant.id]);
    assert.ok(isDenied(await askForCertificate(app, `${label}.${NEUTRAL}`)), label);
  }
  for (const host of [NEUTRAL, `nobody.${NEUTRAL}`, `deep.${shop.slug}.${NEUTRAL}`, '']) assert.ok(isDenied(await askForCertificate(app, host)), `"${host}"`);
  assert.equal((await hit(app, '/tls/ask', { host: CONSOLE_HOST })).status, 400);
  assert.equal((await hit(app, '/tls/ask?domain=a.example&domain=b.example', { host: CONSOLE_HOST })).status, 400);

  await app.db.query(`UPDATE tenants SET status = 'closed' WHERE id = $1`, [shop.tenant.id]);
  assert.ok(isDenied(await askForCertificate(app, `${shop.slug}.${NEUTRAL}`)), 'a closed business\'s fallback host');
});

function scheduledChecks(app, dns, extra = {}) {
  return createDomainService({
    repos: app.platform,
    platform: { cache: createCache({ cacheDriver: 'memory' }) },
    config: { platformDomain: NEUTRAL, sessionSecret: 'test-secret', dnsResolver: dns, ...extra },
  });
}

test('the scheduled check verifies each business\'s pending domains and leaves recent ones alone', async (t) => {
  const { app, dns, added, other, list } = await domainWorld(t);
  const logs = captureLogs(t);
  const service = scheduledChecks(app, dns);
  const mine = await added('mine.kesarhome.example');
  const them = await other('leaf-and-clay', 'Leaf and Clay');
  const theirs = await them.added('theirs.leafandclay.example');
  await added('waiting.kesarhome.example');
  dns.publish([...mine.records, ...theirs.records]);

  await service.checkDue();
  const status = (rows) => Object.fromEntries(rows.map((r) => [r.domain, r.status]));
  assert.deepEqual(status(await list()), { 'mine.kesarhome.example': 'verified', 'waiting.kesarhome.example': 'pending' });
  assert.deepEqual(status(await them.list()), { 'theirs.leafandclay.example': 'verified' });

  const before = dns.calls;
  await service.checkDue();
  assert.equal(dns.calls, before, 'a domain checked a moment ago isn\'t looked up again');
  await app.db.query(`UPDATE tenant_domains SET last_checked_at = now() - interval '6 minutes' WHERE domain = 'waiting.kesarhome.example'`);
  await service.checkDue();
  assert.ok(dns.calls > before, 'five minutes later it is');
  assert.doesNotMatch(logs.text(), /kesarhome|leafandclay/, 'logs hold counts and ids');
});

test('after 72 hours the schedule stops, and owner and ops are told exactly once', async (t) => {
  const { app, dns, mail, shop, token, added, check } = await domainWorld(t);
  const operator = await consoleUser(app);
  const service = scheduledChecks(app, dns, { mailTransport: mail });
  const row = await added('late.kesarhome.example');
  await app.db.query(`UPDATE tenant_domains SET check_until = now() - interval '1 minute' WHERE domain = 'late.kesarhome.example'`);

  await Promise.all([service.checkDue(), service.checkDue()]);
  await service.checkDue();
  assert.equal((await check(row.id)).json().status, 'stopped');
  assert.equal(mail.sent.length, 1);
  assert.match(mail.sent[0].from, /Bhava/, 'seller mail carries the platform\'s name');

  const owner = need(await api(app, shop, token, '/alerts'), 200, 'Owner alerts').json().items.filter((a) => a.kind === 'domain.stopped');
  assert.equal(owner.length, 1);
  assert.equal(owner[0].target, 'late.kesarhome.example');
  const ops = need(await onConsole(app, operator, '/alerts'), 200, 'Console alerts').json().items.filter((a) => a.kind === 'domain.stopped');
  assert.equal(ops.length, 1);
  assert.equal(ops[0].tenantId, shop.tenant.id);
});

test('adding a stopped domain again starts a fresh 72 hours', async (t) => {
  const { app, dns, added, check, shop, mail } = await domainWorld(t);
  const row = await added('late.kesarhome.example');
  await app.db.query(`UPDATE tenant_domains SET created_at = now() - interval '73 hours' WHERE domain = 'late.kesarhome.example'`);
  assert.equal((await check(row.id)).json().status, 'stopped');
  assert.ok(isDenied(await askForCertificate(app, 'late.kesarhome.example')));

  const again = await added('late.kesarhome.example');
  assert.equal(again.status, 'pending');
  dns.publish(again.records);
  assert.equal((await check(row.id)).json().status, 'verified');
  const [{ n }] = await app.db.query(`SELECT count(*)::int AS n FROM alerts WHERE tenant_id = $1 AND audience = 'owner' AND kind = 'domain.stopped'`, [shop.tenant.id]);
  assert.equal(n, 1);
  assert.equal(mail.sent.length, 1);
});

test('a closed business\'s pending domains are left out of the schedule', async (t) => {
  const { app, dns, added, shop } = await domainWorld(t);
  await added('quiet.kesarhome.example');
  await app.db.query(`UPDATE tenants SET status = 'closed' WHERE id = $1`, [shop.tenant.id]);
  const before = dns.calls;
  await scheduledChecks(app, dns).checkDue();
  assert.equal(dns.calls, before);
});

test('a failure on one domain doesn\'t stop the others being checked', async (t) => {
  const { app, dns, added, other, list } = await domainWorld(t);
  const mine = await added('mine.kesarhome.example');
  const them = await other('leaf-and-clay', 'Leaf and Clay');
  await them.added('theirs.leafandclay.example');
  dns.publish(mine.records);

  const repos = {
    ...app.platform,
    domains: {
      ...app.platform.domains,
      get: (domain) => (domain.includes('leafandclay') ? Promise.reject(new Error('boom')) : app.platform.domains.get(domain)),
    },
  };
  const service = createDomainService({ repos, platform: { cache: createCache({ cacheDriver: 'memory' }) }, config: { platformDomain: NEUTRAL, sessionSecret: 's', dnsResolver: dns } });
  await service.checkDue();
  assert.equal((await list())[0].status, 'verified');
});

test('a business can\'t pile up domains without limit', async (t) => {
  const { app, shop, add } = await domainWorld(t);
  for (let i = 0; i < 20; i++) await app.db.query('INSERT INTO tenant_domains (domain, tenant_id) VALUES ($1, $2)', [`d${i}.kesarhome.example`, shop.tenant.id]);
  const res = await add('one-more.kesarhome.example');
  assert.equal(res.status, 409);
  assert.match(res.json().error, /20/);
});

test('with no neutral domain set, custom domains say they aren\'t available', async (t) => {
  const { app, shop } = await domainWorld(t);
  const service = createDomainService({ repos: app.platform, platform: { cache: createCache({ cacheDriver: 'memory' }) }, config: { platformDomain: '', sessionSecret: 's', dnsResolver: {} } });
  await assert.rejects(() => withTenant(shop.tenant, () => service.add('a.example', { id: 1 })), /available/);
});

test('the schedule runs every five minutes, and a failure doesn\'t stop the worker\'s other jobs', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  let runs = 0;
  const schedule = domains.jobs({
    repos: { domains: { dueForCheck: async () => { runs++; throw new Error('database gone'); } } },
    config: { platformDomain: NEUTRAL, sessionSecret: 's', dnsResolver: {} },
    platform: { cache: {} },
  });
  await schedule();
  await schedule();
  assert.equal(runs, 1);
  t.mock.timers.tick(299_000);
  await schedule();
  assert.equal(runs, 1);
  t.mock.timers.tick(1_000);
  await schedule();
  assert.equal(runs, 2);
});

test('a domain goes live for its own business, with its own store', async (t) => {
  const { app, verified, other } = await domainWorld(t);
  const them = await other('leaf-and-clay', 'Leaf and Clay');
  await verified('kesar.kesarhome.example');
  await them.verified('leaf.leafandclay.example');
  assert.match(titleOf((await hit(app, '/', { host: 'kesar.kesarhome.example' })).text), /Kesar Home/);
  assert.match(titleOf((await hit(app, '/', { host: 'leaf.leafandclay.example' })).text), /Leaf and Clay/);
});
