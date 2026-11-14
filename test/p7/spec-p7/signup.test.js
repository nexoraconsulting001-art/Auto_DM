// PRD 5.20 and 3: self-serve sign-up, the Free plan's limits and referrals. F-121 to F-129, U-07, U-08.
// Sign-up runs on the sign-in host with no business; the Free plan is checked on the server, never only on the screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { SIGNUP_STEPS } from '../../../src/contracts/billing.js';
import {
  APP, appSignIn, assertSellerBrand, billingHook, cardCharge, charge, change, authorize, consoleUser, json, key, linksIn, need, newInvite, newPhone, one, opCall, setSetting, setSignup, shopOn, sql,
  subscribe, unique, useBillingWorld, hit, pause,
} from './support.js';

const world = useBillingWorld();
const numericId = () => String(17_841_400_000_000_000n + BigInt(crypto.randomInt(1, 2 ** 30)) * 1000n);
const MARK = /Made with Bhava/i;

async function signUp({ mode = 'public', accountType = 'creator', name = `Priya ${unique()}`, inviteCode = '', referralCode = '', phone = newPhone(), admin } = {}) {
  if (mode) await setSignup(world, mode, admin);
  const person = await appSignIn(world, phone);
  const status = await person.call('GET', `/signup${inviteCode ? `?inviteCode=${inviteCode}` : ''}`);
  const started = await person.call('POST', '/signup', { accountType, name, inviteCode, referralCode, runToken: status.data?.runToken ?? '' });
  return { person, status, started, phone };
}

test('F-122: sign-up with a WhatsApp code makes an account with no password, and the code came by WhatsApp', async () => {
  const { person, started, phone } = await signUp();
  need(started, 201, 'Signing up');
  const { tenantId, host } = started.data;
  assert.ok(tenantId && host);
  assert.ok((await world.whatsappTo(phone)).length >= 1, 'the code arrived on WhatsApp');
  const owner = await one(world, `SELECT password_hash FROM users WHERE tenant_id = $1 AND role = 'owner'`, [tenantId]);
  assert.ok(owner, 'an owner exists');
  assert.ok(!owner.password_hash, 'no password was set');
  assert.equal((await one(world, 'SELECT plan FROM tenants WHERE id = $1', [tenantId])).plan, 'free');
  void person;
});

test('F-122: a wrong, replayed and expired code does not sign anybody in, and a number cannot ask for codes without limit', async () => {
  const phone = newPhone();
  const headers = { 'content-type': 'application/json', 'x-forwarded-host': APP };
  need(await hit(world, '/api/v1/auth/start', { host: APP, method: 'POST', headers, body: { phone } }), 202, 'A code');
  const real = await world.codeFor(phone);
  const wrong = real === '000000' ? '111111' : '000000';
  const bad = await hit(world, '/api/v1/auth/verify', { host: APP, method: 'POST', headers, body: { phone, code: wrong, transport: 'cookie' } });
  assert.ok([400, 401, 429].includes(bad.status), `a wrong code got ${bad.status}`);
  need(await hit(world, '/api/v1/auth/verify', { host: APP, method: 'POST', headers, body: { phone, code: real, transport: 'cookie' } }), 201, 'The right code');
  const again = await hit(world, '/api/v1/auth/verify', { host: APP, method: 'POST', headers, body: { phone, code: real, transport: 'cookie' } });
  assert.ok([400, 401, 429].includes(again.status), 'a code works once');
  let limited = 0;
  for (let i = 0; i < 12; i++) if ((await hit(world, '/api/v1/auth/start', { host: APP, method: 'POST', headers, body: { phone } })).status === 429) limited++;
  assert.ok(limited > 0, 'code requests for one number are limited');
});

test('F-121: sign-up with a keyword and a link ends with the first automation live, every step logged in order, within the 3 minute target', async () => {
  const { person, started, phone } = await signUp({ accountType: 'creator' });
  need(started, 201, 'Starting');
  const { tenantId, host, runToken } = started.data;
  await sql(world, `INSERT INTO compliance_settings (tenant_id, subject_salt, access_level, app_role_ok, privacy_url_ok_at, deletion_callback_ok_at, gate_passed_at) VALUES ($1, $2, 'advanced', true, now(), now(), now()) ON CONFLICT (tenant_id) DO UPDATE SET access_level = 'advanced', app_role_ok = true, privacy_url_ok_at = now(), deletion_callback_ok_at = now(), gate_passed_at = now()`, [tenantId, crypto.randomBytes(12).toString('hex')]);
  const igUserId = numericId();
  await world.meta.post('/accounts', { igUserId, username: `creator_${unique()}`, subscribedFields: ['comments', 'messages', 'messaging_postbacks', 'mentions'], appRole: true });
  const owner = await appSignIn(world, phone, host);
  await world.meta.post('/oauth/next', { igUserId });
  const connect = need(await owner.call('POST', '/instagram/connect', {}), 200, 'Starting Instagram');
  const consent = await fetch(connect.data.authorizeUrl, { redirect: 'manual' });
  const back = new URL(consent.headers.get('location'));
  need(await hit(world, `${back.pathname}${back.search}`, { host }), [200, 302, 303], 'Instagram coming back');
  const reel = numericId();
  await world.meta.post('/media', { igUserId, productType: 'REELS', caption: 'First reel', id: reel });
  const result = await person.call('POST', '/signup/first-automation', { runToken, mediaId: String(reel), keyword: 'LINK', link: 'https://example.com/shop' });
  need(result, 200, 'The first automation');
  assert.equal(result.data.live, true, `the automation is live: ${JSON.stringify(result.data.problems)}`);
  const finished = need(await person.call('POST', '/signup/finish', { runToken }), 200, 'Finishing');
  assert.equal(finished.data.withinTarget, true);
  assert.ok(finished.data.elapsedMs < 180_000);
  const steps = await sql(world, `SELECT step, at FROM signup_steps WHERE run_id = (SELECT id FROM signup_runs WHERE tenant_id = $1) ORDER BY at, step`, [tenantId]);
  const names = steps.map((s) => s.step);
  for (const step of ['opened', 'signed_in', 'account_type', 'instagram_connected', 'automation_live', 'finished']) assert.ok(names.includes(step), `${step} is logged: ${names}`);
  assert.ok(names.every((n) => SIGNUP_STEPS.includes(n)));
  assert.ok(steps.every((s, i) => i === 0 || +new Date(s.at) >= +new Date(steps[i - 1].at)), 'step times run forward');
});

test('F-121: a first automation whose link is not allowed is not made live and says why, field by field', async () => {
  const { person, started } = await signUp();
  const { runToken } = started.data;
  for (const link of ['http://example.com/plain', 'javascript:alert(1)', 'https://bit.ly/x', 'not a link', '']) {
    const res = await person.call('POST', '/signup/first-automation', { runToken, mediaId: '123', keyword: 'LINK', link });
    assert.ok(res.status === 400 || res.data?.live === false, `link ${link}: ${res.status} ${res.text.slice(0, 120)}`);
    if (res.status === 200) assert.ok(res.data.problems.length >= 1);
  }
  assert.equal(Number((await one(world, 'SELECT count(*) AS n FROM automations WHERE tenant_id = $1', [started.data.tenantId])).n), 0);
});

test('F-121: sign-up routes need the person to be signed in on the sign-in host and a run token that is theirs', async () => {
  const anon = (method, path, body) => hit(world, `/api/v1${path}`, { host: APP, method, ...(body ? { body } : {}), headers: { 'x-forwarded-host': APP } });
  assert.equal((await anon('POST', '/signup', { accountType: 'creator', name: 'X' })).status, 401);
  assert.equal((await anon('POST', '/signup/finish', { runToken: 'abc' })).status, 401);
  const a = await signUp();
  const b = await appSignIn(world, newPhone());
  const stolen = await b.call('POST', '/signup/finish', { runToken: a.started.data.runToken });
  assert.ok([401, 403, 404].includes(stolen.status), `another person's run: ${stolen.status}`);
  const onShop = await hit(world, '/api/v1/signup', { host: `x-${unique()}.${APP.split('.').slice(1).join('.')}`, headers: {} });
  assert.ok(onShop.status >= 400, 'sign-up is not offered on a business address');
});

test('F-122: sign-up while closed is refused for everyone, with or without an invite code; invite mode needs a live code', async () => {
  const admin = await consoleUser(world);
  const code = (await newInvite(world, admin, { maxUses: 1 })).code;
  await setSignup(world, 'closed', admin);
  const closed = await signUp({ mode: null, inviteCode: code });
  assert.equal((await closed.status).data.open, false);
  assert.ok([403, 409].includes(closed.started.status), `closed: ${closed.started.status}`);
  assert.equal(await tenantsNamed(closed.started.data?.slug), 0);
  await setSignup(world, 'invite', admin);
  const none = await signUp({ mode: null });
  assert.ok([400, 403].includes(none.started.status), `no code: ${none.started.status}`);
  const guess = await signUp({ mode: null, inviteCode: 'GUESSED-CODE-123' });
  assert.ok([400, 403].includes(guess.started.status), 'a guessed code');
  const good = await signUp({ mode: null, inviteCode: code });
  need(good.started, 201, 'A good invite code');
});

const tenantsNamed = async (slug) => (slug ? Number((await one(world, 'SELECT count(*) AS n FROM tenants WHERE slug = $1', [slug])).n) : 0);

test('F-122: an invite code with one use works once, also when two people use it at the same moment; a revoked or expired one never works', async () => {
  const admin = await consoleUser(world);
  await setSignup(world, 'invite', admin);
  const { code, invite } = await newInvite(world, admin, { maxUses: 1 });
  const people = await Promise.all([appSignIn(world, newPhone()), appSignIn(world, newPhone())]);
  const results = await Promise.all(people.map((p, i) => p.call('POST', '/signup', { accountType: 'creator', name: `Race ${i}`, inviteCode: code })));
  assert.equal(results.filter((r) => r.status === 201).length, 1, `one use, ${results.map((r) => r.status)}`);
  assert.equal(Number((await one(world, 'SELECT uses FROM signup_invites WHERE id = $1', [invite.id])).uses), 1);
  const third = await appSignIn(world, newPhone());
  assert.ok([400, 403].includes((await third.call('POST', '/signup', { accountType: 'creator', name: 'Late', inviteCode: code })).status), 'a used code');
  const fresh = await newInvite(world, admin, { maxUses: 5 });
  need(await opCall(world, admin, 'POST', `/signup/invites/${fresh.invite.id}/revoke`), 200, 'Revoking');
  assert.ok([400, 403].includes((await third.call('POST', '/signup', { accountType: 'creator', name: 'Revoked', inviteCode: fresh.code })).status), 'a revoked code');
  const old = await newInvite(world, admin, { maxUses: 5, expiresInDays: 1 });
  await sql(world, `UPDATE signup_invites SET expires_at = now() - interval '1 second' WHERE id = $1`, [old.invite.id]);
  assert.ok([400, 403].includes((await third.call('POST', '/signup', { accountType: 'creator', name: 'Expired', inviteCode: old.code })).status), 'an expired code');
  const listed = json(need(await opCall(world, admin, 'GET', '/signup/invites'), 200, 'Invites'));
  assert.ok(!JSON.stringify(listed).includes(code), 'the code is shown once and never stored in the clear');
  assert.equal((await sql(world, 'SELECT code_hash FROM signup_invites WHERE id = $1', [invite.id]))[0].code_hash.includes(code), false);
});

test('F-122: only the console can open or close sign-up; a seller or an anonymous caller cannot', async () => {
  const shop = await shopOn(world, 'free');
  assert.equal((await shop.send('PUT', '/signup', { mode: 'public', reason: 'x' })).status >= 400, true);
  const anon = await hit(world, '/signup', { host: `admin.${APP.split('.').slice(1).join('.')}`, method: 'PUT', body: { mode: 'public', reason: 'x' } });
  assert.equal(anon.status, 401);
  const admin = await consoleUser(world);
  refusalNeedsReason(await opCall(world, admin, 'PUT', '/signup', { mode: 'public' }));
  assert.equal((await opCall(world, admin, 'PUT', '/signup', { mode: 'somewhere', reason: 'x' })).status, 400);
  const support = await consoleUser(world, 'support');
  assert.equal((await opCall(world, support, 'PUT', '/signup', { mode: 'public', reason: 'x' })).status, 403, 'support may not open sign-up');
});
const refusalNeedsReason = (res) => assert.equal(res.status, 400, 'a change with no reason is refused');

test('F-129: one Free plan per Instagram account: a second sign-up cannot take an account that already has one', async () => {
  const first = await signUp();
  const igUserId = numericId();
  await world.meta.post('/accounts', { igUserId, username: `dup_${unique()}`, subscribedFields: ['comments', 'messages'], appRole: true });
  const connectAs = async (run) => {
    const owner = await appSignIn(world, run.phone, run.started.data.host);
    await world.meta.post('/oauth/next', { igUserId });
    const start = need(await owner.call('POST', '/instagram/connect', {}), 200, 'Starting Instagram');
    const consent = await fetch(start.data.authorizeUrl, { redirect: 'manual' });
    const back = new URL(consent.headers.get('location'));
    return hit(world, `${back.pathname}${back.search}`, { host: run.started.data.host });
  };
  need(await connectAs(first), [200, 302, 303], 'The first connection');
  const second = await signUp({ mode: null });
  const answer = await connectAs(second);
  const linked = await sql(world, 'SELECT tenant_id FROM ig_accounts WHERE ig_user_id = $1', [igUserId]);
  assert.equal(linked.length, 1, 'one business holds the account');
  assert.equal(Number(linked[0].tenant_id), Number(first.started.data.tenantId));
  assert.ok(answer.status >= 300 || /already|another|one free/i.test(answer.text), `the second is told: ${answer.status}`);
  void setSetting;
});

test('F-123: a Free account\'s 4th automation is blocked with an upgrade prompt, and the third still works', async () => {
  const shop = await shopOn(world, 'free');
  for (let i = 0; i < 3; i++) need(await shop.tryAutomation({ mediaId: await shop.reel(), linkMode: 'two_tap' }), 201, `Automation ${i + 1}`);
  const fourth = await shop.tryAutomation({ mediaId: await shop.reel(), linkMode: 'two_tap' });
  assert.equal(fourth.status, 403);
  const body = json(fourth);
  assert.equal(body.code, 'plan.limit_reached');
  assert.equal(body.plan, 't1', 'the prompt names the plan that has more');
  const features = json(need(await shop.send('GET', '/billing/features'), 200, 'Features')).features;
  assert.equal(features.automations.limit, 3);
});

test('F-124: the same 4th automation by a direct API call gets 403 and no row, also two at once, by a manager, and with a bearer token', async () => {
  const shop = await shopOn(world, 'free');
  for (let i = 0; i < 2; i++) need(await shop.tryAutomation({ mediaId: await shop.reel(), linkMode: 'two_tap' }), 201, 'Setting up');
  const race = await Promise.all([shop.tryAutomation({ mediaId: await shop.reel(), linkMode: 'two_tap' }), shop.tryAutomation({ mediaId: await shop.reel(), linkMode: 'two_tap' })]);
  assert.equal(race.filter((r) => r.status === 201).length, 1, `one place was left: ${race.map((r) => r.status)}`);
  const n = async () => Number((await one(world, 'SELECT count(*) AS n FROM automations WHERE tenant_id = $1', [shop.tenantId])).n);
  assert.equal(await n(), 3);
  const raw = await hit(world, '/api/v1/automations', { host: shop.host, method: 'POST', token: shop.token, body: shop.automationBody({ mediaId: await shop.reel(), linkMode: 'two_tap' }) });
  assert.equal(raw.status, 403);
  assert.equal(json(raw).code, 'plan.limit_reached');
  // Turning a paused one live is no way round it, and neither is an update that adds a second reel.
  assert.equal(await n(), 3, 'no fourth row');
});

test('F-125: a Free account is offered only two-tap, and the server rejects one-tap on create, update and from another reel', async () => {
  const shop = await shopOn(world, 'free');
  const features = json(need(await shop.send('GET', '/billing/features'), 200, 'Features')).features;
  assert.equal((features['links.one_tap']?.on ?? false), false);
  assert.equal(features['links.two_tap'].on, true);
  const refused = await shop.tryAutomation({ mediaId: await shop.reel(), linkMode: 'one_tap' });
  assert.equal(refused.status, 403);
  assert.equal(json(refused).feature, 'links.one_tap');
  const ok = need(await shop.tryAutomation({ mediaId: await shop.reel(), linkMode: 'two_tap' }), 201, 'A two-tap automation');
  const upgrade = await shop.send('PATCH', `/automations/${json(ok).id}`, { linkMode: 'one_tap' });
  assert.equal(upgrade.status, 403, 'changing an existing one to one-tap');
  assert.equal((await one(world, 'SELECT link_mode FROM automations WHERE id = $1', [json(ok).id])).link_mode, 'two_tap');
  const stories = await shop.tryAutomation({ triggerType: 'story_mention', keywords: [], matchMode: 'any', anyModeAcknowledged: true, linkMode: 'two_tap', triggers: [{ channel: 'instagram', targetType: 'any_story' }] });
  assert.ok([201, 400, 403].includes(stories.status));
});

test('F-126: a Free account sees no insights older than 7 days, however it asks, and an upgrade shows them', async () => {
  const shop = await shopOn(world, 'free');
  const day = (d) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
  // Every day an answer carries: its range and each metric's and the follower series' days.
  const daysIn = (data) => [data.from, ...(data.metrics ?? []).flatMap((m) => (m.days ?? []).map((d) => d.day)), ...(data.followers ?? []).map((d) => d.day)].filter(Boolean).map((d) => String(d).slice(0, 10));
  const free = await shop.send('GET', '/insights/account?range=7');
  assert.equal(free.status, 200, `the last 7 days are a Free account's: ${free.status}`);
  for (const path of ['/insights/account?range=28', '/insights/account?range=90', `/insights/account?range=custom&from=${day(30)}&to=${day(0)}`, `/insights/account?range=custom&from=${day(20)}&to=${day(10)}`]) {
    const res = await shop.send('GET', path);
    if (res.status === 200) {
      const data = json(res);
      assert.ok(data?.from, `${path}: an answer with no range`);
      const old = daysIn(data).filter((d) => d < day(7));
      assert.deepEqual(old, [], `${path} shows days older than 7 days`);
    } else assert.ok([402, 403].includes(res.status), `${path} answered ${res.status}`);
  }
  await sql(world, `UPDATE tenants SET plan = 't1' WHERE id = $1`, [shop.tenantId]);
  const paid = await shop.send('GET', '/insights/account?range=90');
  assert.equal(paid.status, 200);
  assert.ok(String(json(paid).from) < day(7), 'after the upgrade the 90 day range reaches back');
});

test('F-127: a Free account\'s DM carries no platform name, link or badge, and its creator page shows "Made with Bhava"', async () => {
  const shop = await shopOn(world, 'free');
  const auto = await shop.automate({ linkMode: 'two_tap' });
  await shop.comment(auto.mediaId, { from: world.fan() });
  await shop.settle();
  const sent = await shop.sent();
  assert.ok(sent.length >= 1, 'a DM went out');
  const everything = JSON.stringify(sent);
  assertSellerBrand(everything, 'The DM and the public reply');
  for (const url of linksIn(sent)) assert.doesNotMatch(url, /bhava/i, `a link in a DM: ${url}`);
  need(await shop.send('PATCH', '/creator-page', { slug: `free-${unique()}`.slice(0, 20), enabled: true }), 200, 'Turning the creator page on');
  const page = json(need(await shop.send('GET', '/creator-page'), 200, 'The creator page'));
  const html = await hit(world, `/${page.slug ?? ''}`, { host: shop.host });
  assert.match(html.text, MARK, 'the mark is on the creator page');
});

test('U-07: a Free creator\'s page shows the made-with mark and the DM does not', async () => {
  const shop = await shopOn(world, 'free');
  need(await shop.send('PATCH', '/creator-page', { slug: `u7-${unique()}`.slice(0, 20), enabled: true }), 200, 'Turning the page on');
  const slug = json(need(await shop.send('GET', '/creator-page'), 200, 'Page')).slug;
  const page = await hit(world, `/${slug}`, { host: shop.host });
  assert.match(page.text, MARK);
  const auto = await shop.automate({ linkMode: 'two_tap' });
  await shop.comment(auto.mediaId, { from: world.fan() });
  await shop.settle();
  assertSellerBrand(await shop.sent(), 'The DM');
});

test('U-08: upgrading from Free removes the mark at the very next request, and the page keeps its address', async () => {
  const shop = await shopOn(world, 'free');
  need(await shop.send('PATCH', '/creator-page', { slug: `u8-${unique()}`.slice(0, 20), enabled: true }), 200, 'Turning the page on');
  const slug = json(need(await shop.send('GET', '/creator-page'), 200, 'Page')).slug;
  assert.match((await hit(world, `/${slug}`, { host: shop.host })).text, MARK);
  await subscribe(world, shop, 't1');
  const after = await hit(world, `/${slug}`, { host: shop.host });
  assert.equal(after.status, 200);
  assert.doesNotMatch(after.text, MARK);
  assertSellerBrand(after.headers, 'The page headers');
});

test('F-128: a Free account upgrading to tier 3 keeps its id, data and automations, and the store features appear with no migration', async () => {
  const shop = await shopOn(world, 'free', { pay: false });
  const automation = need(await shop.tryAutomation({ mediaId: await shop.reel(), linkMode: 'two_tap' }), 201, 'An automation');
  const product = await shop.product();
  const before = { tenant: shop.tenantId, owner: (await one(world, `SELECT id FROM users WHERE tenant_id = $1 AND role = 'owner'`, [shop.tenantId])).id };
  const features = async () => json(need(await shop.send('GET', '/billing/features'), 200, 'Features')).features;
  assert.equal((await features())['store.checkout']?.on ?? false, false);
  await subscribe(world, shop, 't3');
  assert.equal((await features())['store.checkout']?.on ?? false, true);
  assert.equal((await one(world, 'SELECT count(*) AS n FROM tenants WHERE slug = $1', [shop.slug])).n, '1', 'still one account');
  assert.equal((await one(world, `SELECT id FROM users WHERE tenant_id = $1 AND role = 'owner'`, [shop.tenantId])).id, before.owner);
  assert.equal(json(need(await shop.send('GET', `/automations/${json(automation).id}`), 200, 'The automation')).id, json(automation).id);
  assert.equal(json(need(await shop.send('GET', `/products/${product.id}`), 200, 'The product')).id, product.id);
  assert.ok((await sql(world, 'SELECT 1 FROM plan_changes WHERE tenant_id = $1 AND to_plan = $2', [shop.tenantId, 't3'])).length >= 1, 'the change is on record');
});

test('F-129: a referrer is credited once when the referred account starts a paid plan, however many charges follow', async () => {
  await setSetting(world, 'referral_reward_paise', 25_000);
  try {
    const referrer = await shopOn(world, 'free');
    const referred = await shopOn(world, 'free');
    const mine = json(need(await referrer.send('GET', '/referrals'), 200, 'Referrals'));
    assert.match(mine.code, /^[a-z0-9]{6,20}$/);
    assert.ok(mine.link.includes(mine.code));
    assert.match(mine.link, /^https:\/\//, 'a sign-up link');
    await sql(world, `INSERT INTO seller_referrals (tenant_id, referred_tenant_id) VALUES ($1, $2)`, [referrer.tenantId, referred.tenantId]);
    assert.equal(json(need(await referrer.send('GET', '/referrals'), 200, 'Referrals')).counts.pending, 1);
    await subscribe(world, referred, 't1');
    await charge(world, referred);
    await charge(world, referred);
    await world.quiet(800);
    const after = json(need(await referrer.send('GET', '/referrals'), 200, 'Referrals'));
    assert.equal(after.counts.credited, 1, 'credited once');
    assert.equal(after.creditedPaise, 25_000);
    assert.equal(after.counts.pending, 0);
    // The referred account cannot see the referrer's numbers.
    assert.equal(json(need(await referred.send('GET', '/referrals'), 200, 'Referrals')).counts.credited, 0);
  } finally {
    await setSetting(world, 'referral_reward_paise', 0);
  }
});

test('F-129: a self-referral is blocked by the same phone, by the same Instagram account, and by the database when a business names itself', async () => {
  const referrer = await shopOn(world, 'free');
  const code = json(need(await referrer.send('GET', '/referrals'), 200, 'Referrals')).code;
  await assert.rejects(sql(world, `INSERT INTO seller_referrals (tenant_id, referred_tenant_id) VALUES ($1, $1)`, [referrer.tenantId]), /check|violates|itself/i);
  // The same phone signs up again with the referrer's own code.
  const ownerPhone = (await one(world, `SELECT phone FROM users WHERE tenant_id = $1 AND role = 'owner'`, [referrer.tenantId])).phone;
  await setSignup(world, 'public');
  const person = await appSignIn(world, ownerPhone);
  const res = await person.call('POST', '/signup', { accountType: 'creator', name: 'Me again', referralCode: code });
  const rows = await sql(world, `SELECT state, block_reason FROM seller_referrals WHERE tenant_id = $1`, [referrer.tenantId]);
  if (res.status === 201) assert.ok(rows.every((r) => r.state !== 'credited'), 'a referral from the same phone is never credited');
  assert.ok(res.status >= 400 || rows.every((r) => r.state === 'blocked'), `the same phone: ${res.status} ${JSON.stringify(rows)}`);
  if (rows.length) assert.ok(rows.every((r) => r.block_reason === 'same_phone' || r.state === 'blocked'));
  // A code nobody has.
  const other = await appSignIn(world, newPhone());
  const bogus = await other.call('POST', '/signup', { accountType: 'creator', name: 'Other', referralCode: 'nosuchcode1' });
  assert.ok(bogus.status === 201 || bogus.status === 400, 'a code nobody has is ignored or refused, never a crash');
});

/** Connects Instagram account `igUserId` to the business a sign-up made, as its owner on its own address. The answer to the return. */
async function connectIg(run, igUserId) {
  const owner = await appSignIn(world, run.phone, run.started.data.host);
  await world.meta.post('/oauth/next', { igUserId });
  const start = need(await owner.call('POST', '/instagram/connect', {}), 200, 'Starting Instagram');
  const consent = await fetch(start.data.authorizeUrl, { redirect: 'manual' });
  const back = new URL(consent.headers.get('location'));
  return hit(world, `${back.pathname}${back.search}`, { host: run.started.data.host });
}

test('F-129: a self-referral by the same Instagram account is never credited, even when the referred account starts paying', async () => {
  await setSetting(world, 'referral_reward_paise', 25_000);
  try {
    const referrer = await signUp();
    need(referrer.started, 201, 'The referrer signs up');
    const igUserId = numericId();
    await world.meta.post('/accounts', { igUserId, username: `self_${unique()}`, subscribedFields: ['comments', 'messages'], appRole: true });
    need(await connectIg(referrer, igUserId), [200, 302, 303], 'The referrer connects Instagram');
    const owner = await appSignIn(world, referrer.phone, referrer.started.data.host);
    const code = need(await owner.call('GET', '/referrals'), 200, 'Referrals').data.code;
    // Another phone, the referrer's own code, and the referrer's own Instagram account.
    const twin = await signUp({ mode: null, referralCode: code });
    need(twin.started, 201, 'The second sign-up');
    await connectIg(twin, igUserId);
    const twinOwner = await appSignIn(world, twin.phone, twin.started.data.host);
    const twinShop = { tenantId: twin.started.data.tenantId, send: (method, path, body) => twinOwner.call(method, path, body) };
    need(await twinShop.send('POST', '/billing/change', { plan: 't1', cycle: 'monthly', requestKey: key() }), 200, 'The second account chooses tier 1');
    const sub = await one(world, 'SELECT provider_subscription_id FROM subscriptions WHERE tenant_id = $1', [twinShop.tenantId]);
    await world.rzp.post('/subscriptions/authorize', { id: sub.provider_subscription_id });
    await world.rzp.post('/subscriptions/charge', { id: sub.provider_subscription_id });
    await world.quiet(800);
    const rows = await sql(world, 'SELECT state, block_reason FROM seller_referrals WHERE referred_tenant_id = $1', [twinShop.tenantId]);
    assert.ok(rows.every((r) => r.state !== 'credited'), `a referral of the same Instagram account was credited: ${JSON.stringify(rows)}`);
    if (rows.length) assert.deepEqual(rows.map((r) => [r.state, r.block_reason]), [['blocked', 'same_instagram']]);
    const counts = need(await owner.call('GET', '/referrals'), 200, 'Referrals').data;
    assert.deepEqual([counts.counts.credited, counts.creditedPaise], [0, 0]);
  } finally {
    await setSetting(world, 'referral_reward_paise', 0);
  }
});

test('F-129: a self-referral paid with the referrer\'s own card is blocked at the first charge and never credited', async () => {
  await setSetting(world, 'referral_reward_paise', 25_000);
  try {
    const referrer = await shopOn(world, 'free');
    const referred = await shopOn(world, 'free');
    const card = `card_${unique()}`;
    // The referrer pays for tier 1 with a card.
    need(await change(referrer, 't1', 'monthly'), 200, 'The referrer chooses tier 1');
    const subA = await authorize(world, referrer);
    assert.ok((await billingHook(world, 'subscription.charged', cardCharge(subA.provider_subscription_id, card))).status < 300);
    await world.until(async () => (await sql(world, 'SELECT 1 FROM billing_payments WHERE tenant_id = $1', [referrer.tenantId])).length > 0);
    await sql(world, `INSERT INTO seller_referrals (tenant_id, referred_tenant_id) VALUES ($1, $2)`, [referrer.tenantId, referred.tenantId]);
    // The referred account starts paying with the very same card.
    need(await change(referred, 't1', 'monthly'), 200, 'The referred account chooses tier 1');
    const subB = await authorize(world, referred);
    assert.ok((await billingHook(world, 'subscription.charged', cardCharge(subB.provider_subscription_id, card))).status < 300);
    await world.until(async () => (await sql(world, 'SELECT 1 FROM billing_payments WHERE tenant_id = $1', [referred.tenantId])).length > 0);
    await world.quiet(800);
    const row = await one(world, 'SELECT state, block_reason, credited_at FROM seller_referrals WHERE referred_tenant_id = $1', [referred.tenantId]);
    assert.deepEqual([row.state, row.block_reason, row.credited_at], ['blocked', 'same_payment_method', null]);
    const mine = json(need(await referrer.send('GET', '/referrals'), 200, 'Referrals'));
    assert.deepEqual([mine.counts.credited, mine.creditedPaise], [0, 0]);
    // A different card on a third account is credited as normal, which shows the block was the card's.
    const honest = await shopOn(world, 'free');
    await sql(world, `INSERT INTO seller_referrals (tenant_id, referred_tenant_id) VALUES ($1, $2)`, [referrer.tenantId, honest.tenantId]);
    need(await change(honest, 't1', 'monthly'), 200, 'A third account chooses tier 1');
    const subC = await authorize(world, honest);
    assert.ok((await billingHook(world, 'subscription.charged', cardCharge(subC.provider_subscription_id, `card_${unique()}`))).status < 300);
    const credited = await world.until(async () => (await one(world, 'SELECT state FROM seller_referrals WHERE referred_tenant_id = $1', [honest.tenantId])).state === 'credited');
    assert.ok(credited, 'a referral paid with another card is credited');
  } finally {
    await setSetting(world, 'referral_reward_paise', 0);
  }
});

test('F-129: the referral code in the sign-up link is read from the address, and the referral is never put in a DM', async () => {
  const referrer = await shopOn(world, 'free');
  const mine = json(need(await referrer.send('GET', '/referrals'), 200, 'Referrals'));
  const person = await appSignIn(world, newPhone());
  const status = await person.call('GET', `/signup?ref=${mine.code}`);
  assert.equal(status.status, 200);
  const auto = await referrer.automate({ linkMode: 'two_tap' });
  await referrer.comment(auto.mediaId, { from: world.fan() });
  await referrer.settle();
  assert.ok(!JSON.stringify(await referrer.sent()).includes(mine.code), 'no referral link in a DM');
  void pause, key, change, authorize;
});
