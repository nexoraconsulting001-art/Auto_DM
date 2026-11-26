// Final attack on "auth" (sign-in and sessions): real HTTP against the real app, the WhatsApp simulator for codes,
// real concurrency and hostile input. A failing test here shows wrong behaviour; a passing one stays as hardening.
// PRD 5.11 (roles and authentication), 5.20 (sign-up modes and the day's cap), 10.2 and 10.3 (app sessions, re-auth).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenHash } from '../../../src/contracts/accounts.js';
import { OWNER, accountsApp, call, codeSignIn, freshIp, random10, sellerCodeFor, sentCount, testDevice } from '../../p5/accounts/support.js';

let app;
let owner;
before(async () => {
  app = await accountsApp();
  owner = await codeSignIn(app, { device: testDevice('Owner phone') });
});
after(() => app?.close());

/** Lets the next code go out at once and clears every per-address and per-number count. */
const reset = async () => {
  await app.db.platform.query(`UPDATE seller_login_codes SET created_at = created_at - interval '31 seconds'`);
  await app.db.platform.query('DELETE FROM rate_limit_hits');
};
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const makeFresh = (token) => app.db.platform.query(`UPDATE sessions SET fresh_until = now() + interval '5 minutes' WHERE id = $1`, [tokenHash(token)]);
const statuses = (answers) => answers.map((a) => a.status).join(',');

// ---- sign-up's day cap holds for every way a business is made --------------------------------------------------------------

describe('sign-up cap (PRD 5.20, migration 910, auth-2)', () => {
  test('with the day\'s cap at 1, first sign-ins of new people make at most one working business between them', async () => {
    await reset();
    await app.db.platform.query('UPDATE signup_settings SET mode = $1, daily_cap = $2', ['public', 1]);
    try {
      const made = [];
      for (let i = 0; i < 3; i++) {
        await reset();
        made.push(await codeSignIn(app, { phone: random10() }));
      }
      assert.ok(made.every((s) => s.created), 'each new person got a place');
      const rows = await app.db.platform.query('SELECT id, signup_held FROM tenants WHERE id = ANY($1::int[]) ORDER BY id', [made.map((s) => s.business.id)]);
      const working = rows.filter((r) => !r.signup_held);
      assert.ok(working.length <= 1, `the day's cap is 1 but ${working.length} working businesses were made today by sign-in alone`);
      // A held place answers nothing but sign-in and sign-up.
      const last = made.at(-1);
      const probe = await call(app, '/api/v1/products', { headers: last.auth });
      if (rows.find((r) => r.id === last.business.id)?.signup_held) assert.equal(probe.status, 403, probe.text);
    } finally {
      await app.db.platform.query('UPDATE signup_settings SET mode = $1, daily_cap = NULL', ['public']);
    }
  });

  test('closed sign-up: a first sign-in is a held place that reaches no business route, by API or by page', async () => {
    await reset();
    await app.db.platform.query(`UPDATE signup_settings SET mode = 'closed'`);
    try {
      const held = await codeSignIn(app, { phone: random10() });
      const [row] = await app.db.platform.query('SELECT signup_held FROM tenants WHERE id = $1', [held.business.id]);
      assert.equal(row.signup_held, true);
      for (const path of ['/api/v1/products', '/api/v1/orders', '/api/v1/team', '/api/v1/billing']) {
        const res = await call(app, path, { headers: held.auth });
        assert.ok([401, 403].includes(res.status), `${path} answered ${res.status}`);
      }
      const page = await call(app, '/admin/products', { headers: held.auth });
      assert.ok(page.status >= 300, `a page answered ${page.status} for a held place`);
      // User decision 2026-11-26 (B-AUTH-4): while sign-up is closed, the page it goes to says it is waiting for approval, with no data.
      const waiting = await call(app, '/admin/waiting', { headers: held.auth });
      assert.equal(waiting.status, 200, waiting.text);
      assert.match(waiting.text, /waiting for approval/);
      // Sign-up refuses while closed, whatever the body says.
      const start = await call(app, '/api/v1/signup', { method: 'POST', headers: held.auth, body: { name: 'Sneaky', accountType: 'seller', inviteCode: 'AAAA-BBBB-CCCC' } });
      assert.equal(start.status, 403, start.text);
      const [still] = await app.db.platform.query('SELECT signup_held FROM tenants WHERE id = $1', [held.business.id]);
      assert.equal(still.signup_held, true);
    } finally {
      await app.db.platform.query(`UPDATE signup_settings SET mode = 'public', daily_cap = NULL`);
    }
  });
});

// ---- staff seats are a paid limit: a burst of invitations must not go past it ------------------------------------------------

describe('team seats under concurrency (PRD 5.7, 5.11)', () => {
  test('six invitations sent at once with one seat left make one invitation', async () => {
    await reset();
    await makeFresh(owner.accessToken);
    await app.db.platform.query(`DELETE FROM team_invites WHERE tenant_id = $1`, [app.tenant.id]);
    await app.db.platform.query(
      `INSERT INTO tenant_features (tenant_id, feature, enabled, limit_value) VALUES ($1, 'staff.seats', true, 1)
       ON CONFLICT (tenant_id, feature) DO UPDATE SET enabled = true, limit_value = 1`,
      [app.tenant.id],
    );
    try {
      const answers = await Promise.all(Array.from({ length: 6 }, () => call(app, '/api/v1/team/invites', {
        method: 'POST', headers: owner.auth, body: { contact: random10(), role: 'staff', permissions: ['orders'] },
      })));
      assert.ok(answers.every((a) => a.status < 500), statuses(answers));
      const made = answers.filter((a) => a.status === 201).length;
      const [open] = await app.db.platform.query(
        `SELECT count(*)::int AS n FROM team_invites WHERE tenant_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
        [app.tenant.id],
      );
      assert.equal(made, 1, `one seat, ${made} invitations answered 201 (${statuses(answers)})`);
      assert.equal(open.n, 1, `one seat, ${open.n} open invitations`);
    } finally {
      await app.db.platform.query(`DELETE FROM tenant_features WHERE tenant_id = $1 AND feature = 'staff.seats'`, [app.tenant.id]);
      await app.db.platform.query(`DELETE FROM team_invites WHERE tenant_id = $1`, [app.tenant.id]);
    }
  });
});

// ---- codes: one code, one session; one send per burst --------------------------------------------------------------------------

describe('one-time codes under concurrency (PRD 5.11)', () => {
  test('the right code sent five times at once opens exactly one session', async () => {
    await reset();
    const phone = random10();
    const ip = freshIp();
    assert.equal((await call(app, '/api/v1/auth/start', { method: 'POST', body: { phone }, ip })).status, 202);
    const code = await sellerCodeFor(app.whatsapp, phone);
    const answers = await Promise.all(Array.from({ length: 5 }, () => call(app, '/api/v1/auth/verify', { method: 'POST', body: { phone, code, transport: 'bearer' }, ip: freshIp() })));
    assert.ok(answers.every((a) => a.status < 500), statuses(answers));
    assert.equal(answers.filter((a) => a.status === 201).length, 1, statuses(answers));
  });

  test('a burst of sign-in requests for one number sends one code and does not use up the number\'s hourly sends', async () => {
    await reset();
    const phone = random10();
    const before = await sentCount(app.whatsapp);
    const answers = await Promise.all(Array.from({ length: 6 }, () => call(app, '/api/v1/auth/start', { method: 'POST', body: { phone }, ip: freshIp() })));
    assert.ok(answers.every((a) => a.status < 500), statuses(answers));
    assert.equal((await sentCount(app.whatsapp)) - before, 1, 'one burst, one code');
    // Only one code went out, so after the resend wait the number may have another (the limit counts codes that go out).
    await app.db.platform.query(`UPDATE seller_login_codes SET created_at = created_at - interval '31 seconds'`);
    const again = await call(app, '/api/v1/auth/start', { method: 'POST', body: { phone }, ip: freshIp() });
    assert.equal(again.status, 202, `after one code went out the number got ${again.status}: ${again.text}`);
    assert.equal((await sentCount(app.whatsapp)) - before, 2, 'the second code went out');
  });

  test('a re-auth code sent by two of the person\'s sessions at once makes one of them fresh', async () => {
    await reset();
    const a = await codeSignIn(app, { device: testDevice('Phone A') });
    await reset();
    const b = await codeSignIn(app, { device: testDevice('Phone B') });
    // Plain refreshes: neither access session is fresh.
    const stale = [];
    for (const s of [a, b]) {
      const r = await call(app, '/api/v1/auth/refresh', { method: 'POST', body: { refreshToken: s.refreshToken }, ip: freshIp() });
      assert.equal(r.status, 201, r.text);
      stale.push(bearer(r.json.accessToken));
    }
    await reset();
    assert.equal((await call(app, '/api/v1/auth/reauth/start', { method: 'POST', headers: stale[0] })).status, 202);
    const code = await sellerCodeFor(app.whatsapp, OWNER.phone);
    const answers = await Promise.all(stale.map((headers) => call(app, '/api/v1/auth/reauth/verify', { method: 'POST', headers, body: { code }, ip: freshIp() })));
    assert.ok(answers.every((x) => x.status < 500), statuses(answers));
    assert.equal(answers.filter((x) => x.status === 200).length, 1, statuses(answers));
  });
});

// ---- sessions: fixation, CSRF, origin ---------------------------------------------------------------------------------------------

describe('cookie sessions (PRD 5.11)', () => {
  test('a planted session cookie is replaced at sign-in and never becomes a session', async () => {
    await reset();
    const planted = 'sid=attacker-chosen-session-value-0123456789abcdef';
    const session = await codeSignIn(app, { transport: 'cookie', headers: { cookie: planted } });
    assert.ok(session.cookie && session.cookie !== planted, 'the sign-in set a new cookie');
    const me = await call(app, '/api/v1/auth/me', { headers: { cookie: planted } });
    assert.equal(me.status, 401, me.text);
    assert.equal((await call(app, '/api/v1/auth/me', { headers: { cookie: session.cookie } })).status, 200);
  });

  test('a cookie session\'s change needs its own CSRF token: none, empty, another session\'s, in the query, or as a list is refused', async () => {
    await reset();
    const one = await codeSignIn(app, { transport: 'cookie' });
    await reset();
    const two = await codeSignIn(app, { transport: 'cookie' });
    await makeFresh(decodeURIComponent(one.cookie.split('=')[1]));
    const body = { contact: random10(), role: 'staff' };
    const tries = [
      { cookie: one.cookie },
      { cookie: one.cookie, 'x-csrf-token': '' },
      { cookie: one.cookie, 'x-csrf-token': two.csrf },
      { cookie: one.cookie, 'x-csrf-token': `${one.csrf}x` },
      { cookie: one.cookie, 'x-csrf-token': one.csrf.slice(0, -1) },
    ];
    for (const headers of tries) {
      const res = await call(app, '/api/v1/team/invites', { method: 'POST', headers, body });
      assert.equal(res.status, 403, `${JSON.stringify(Object.keys(headers))}: ${res.status} ${res.text}`);
    }
    const inQuery = await call(app, `/api/v1/team/invites?_csrf=${encodeURIComponent(one.csrf)}`, { method: 'POST', headers: { cookie: one.cookie }, body });
    assert.equal(inQuery.status, 403, inQuery.text);
    const asList = await call(app, '/api/v1/team/invites', { method: 'POST', headers: { cookie: one.cookie }, body: { ...body, _csrf: [one.csrf, one.csrf] } });
    assert.equal(asList.status, 403, asList.text);
    for (const method of ['DELETE', 'PATCH', 'PUT']) {
      const res = await call(app, `/api/v1/team/${app.ownerId}`, { method, headers: { cookie: one.cookie }, body: { role: 'staff' } });
      assert.ok([403, 404].includes(res.status), `${method} without CSRF answered ${res.status}`);
    }
    const [still] = await app.db.platform.query('SELECT role FROM users WHERE id = $1', [app.ownerId]);
    assert.equal(still.role, 'owner');
  });

  test('a cookie sign-in from another site is refused and sets no cookie: foreign Origin, "null" Origin, foreign Referer', async () => {
    for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, { referer: 'https://evil.example/page' }, { origin: 'https://app.bhava.test.evil.example' }]) {
      await reset();
      const phone = OWNER.phone;
      const ip = freshIp();
      assert.equal((await call(app, '/api/v1/auth/start', { method: 'POST', body: { phone }, ip })).status, 202);
      const code = await sellerCodeFor(app.whatsapp, phone);
      const res = await call(app, '/api/v1/auth/verify', { method: 'POST', body: { phone, code, transport: 'cookie' }, ip, headers });
      assert.equal(res.status, 403, `${JSON.stringify(headers)}: ${res.status}`);
      assert.equal(res.headers.get('set-cookie'), null, `${JSON.stringify(headers)} set a cookie`);
    }
  });
});

// ---- hostile input: never a session, never a 500 -----------------------------------------------------------------------------

describe('hostile input on the sign-in and session routes', () => {
  test('auth.start: wrong types, huge, empty, NUL, unicode digits: never a 5xx, and no code to a number that is not one', async () => {
    await reset();
    const before = await sentCount(app.whatsapp);
    const bodies = [
      { phone: 9000000001 }, { phone: ['9000000001'] }, { phone: {} }, { phone: null }, { phone: '' }, { phone: 'x'.repeat(100_000) },
      { phone: '900000\u00000001' }, { phone: '９００００００００１' }, { phone: '٩٠٠٠٠٠٠٠٠١' },
      { phone: '+1' }, { phone: '+99999999999999999999' }, {}, [],
    ];
    for (const body of bodies) {
      const res = await call(app, '/api/v1/auth/start', { method: 'POST', body, ip: freshIp() });
      assert.ok(res.status < 500, `${JSON.stringify(body).slice(0, 60)} answered ${res.status}`);
    }
    assert.equal((await sentCount(app.whatsapp)) - before, 0, 'a code went to something that is not a number');
    const notJson = await fetch(`${app.base}/api/v1/auth/start`, { method: 'POST', headers: { 'x-forwarded-host': 'app.bhava.test', 'content-type': 'application/json' }, body: '{"phone":' });
    assert.ok(notJson.status >= 400 && notJson.status < 500, `broken JSON answered ${notJson.status}`);
  });

  test('auth.verify: no 201 and no 5xx for codes of the wrong type, shape or script, or hostile ids', async () => {
    await reset();
    const phone = random10();
    const ip = freshIp();
    assert.equal((await call(app, '/api/v1/auth/start', { method: 'POST', body: { phone }, ip })).status, 202);
    const code = await sellerCodeFor(app.whatsapp, phone);
    const arabic = [...code].map((d) => String.fromCharCode(0x0660 + Number(d))).join('');
    const wide = [...code].map((d) => String.fromCharCode(0xff10 + Number(d))).join('');
    const bodies = [
      { phone, code: Number(code) }, { phone, code: [code] }, { phone, code: { $ne: '' } }, { phone, code: ` ${code}` }, { phone, code: `${code}\u0000` },
      { phone, code: arabic }, { phone, code: wide }, { phone, code: `${code}0` }, { phone, code: '' }, { phone: [phone], code },
    ];
    for (const body of bodies) {
      const res = await call(app, '/api/v1/auth/verify', { method: 'POST', body: { ...body, transport: 'bearer' }, ip: freshIp() });
      assert.ok(res.status !== 201 && res.status < 500, `${JSON.stringify(body).slice(0, 80)} answered ${res.status}`);
    }
    // Five refused tries above at most: the code is dead now, as five wrong tries must make it.
    await app.db.platform.query('DELETE FROM rate_limit_hits');
    const late = await call(app, '/api/v1/auth/verify', { method: 'POST', body: { phone, code, transport: 'bearer' }, ip: freshIp() });
    assert.equal(late.status, 401, 'the right code after five wrong tries');
    // Hostile ids and transports with a good code are a sign-in in the last business, or a refusal; never a 5xx.
    for (const extra of [{ tenantId: 2 ** 32 }, { tenantId: -1 }, { tenantId: '1' }, { tenantId: 1.5 }, { transport: 'smoke' }, { device: { id: '\u0000', platform: 'android' } }, { device: 'x'.repeat(10_000) }]) {
      await reset();
      const p = random10();
      const where = freshIp();
      await call(app, '/api/v1/auth/start', { method: 'POST', body: { phone: p }, ip: where });
      const c = await sellerCodeFor(app.whatsapp, p);
      const res = await call(app, '/api/v1/auth/verify', { method: 'POST', body: { phone: p, code: c, transport: 'bearer', ...extra }, ip: where });
      assert.ok(res.status < 500, `${JSON.stringify(extra).slice(0, 60)} answered ${res.status} ${res.text}`);
    }
  });

  test('auth.refresh and Authorization: hostile tokens are 4xx and never a session', async () => {
    await reset();
    for (const refreshToken of [123, null, ['x'], { $ne: null }, '', 'a'.repeat(300), 'a\u0000b', owner.accessToken]) {
      const res = await call(app, '/api/v1/auth/refresh', { method: 'POST', body: { refreshToken }, ip: freshIp() });
      assert.ok(res.status >= 400 && res.status < 500, `${JSON.stringify(refreshToken)?.slice(0, 40)} answered ${res.status}`);
    }
    const headers = [`Bearer ${'a'.repeat(5000)}`, 'Bearer', 'Bearer  ', `Bearer ${owner.accessToken} extra`, `Basic ${owner.accessToken}`, `Bearer ${owner.refreshToken}`, `Bearer ${owner.accessToken.slice(0, -1)}`];
    for (const authorization of headers) {
      const res = await call(app, '/api/v1/auth/me', { headers: { authorization } });
      assert.ok(res.status === 401, `"${authorization.slice(0, 30)}…" answered ${res.status}`);
    }
  });

  test('X-Tenant-Id and ids past 32 bits: refused or not found, never another business and never a 5xx', async () => {
    await reset();
    await makeFresh(owner.accessToken);
    for (const wanted of ['4294967296', '2147483648', '-1', '0', '1e3', ` ${app.tenant.id}`, `0${app.tenant.id}`, '¹', 'abc', '99999999999999999999', '']) {
      const res = await call(app, '/api/v1/auth/me', { headers: { ...owner.auth, 'x-tenant-id': wanted } });
      assert.ok([200, 403].includes(res.status), `X-Tenant-Id "${wanted}" answered ${res.status}`);
      if (res.status === 200) assert.equal(res.json.business.id, app.tenant.id, `X-Tenant-Id "${wanted}" opened another business`);
    }
    for (const [method, path, body] of [['DELETE', '/api/v1/auth/devices/4294967296'], ['PATCH', '/api/v1/team/4294967296', { role: 'staff' }], ['DELETE', '/api/v1/team/99999999999'], ['PATCH', '/api/v1/team/-1', { role: 'staff' }], ['PATCH', '/api/v1/team/1.5', { role: 'staff' }]]) {
      const res = await call(app, path, { method, headers: owner.auth, body });
      assert.ok([400, 404].includes(res.status), `${method} ${path} answered ${res.status}`);
    }
    const invites = [{ contact: 'a'.repeat(5000), role: 'staff' }, { contact: '98765\u000043210', role: 'staff' }, { contact: random10(), role: 'admin' }, { contact: random10(), role: 'staff', permissions: ['billing'] }, { contact: random10(), role: 'staff', permissions: 'orders' }];
    for (const body of invites) {
      const res = await call(app, '/api/v1/team/invites', { method: 'POST', headers: owner.auth, body });
      assert.ok(res.status >= 400 && res.status < 500, `${JSON.stringify(body).slice(0, 60)} answered ${res.status}`);
    }
  });
});

// ---- the last owner, under concurrency --------------------------------------------------------------------------------------------

describe('owners (F-49) under concurrency', () => {
  test('two owners demoting each other at the same moment leave one owner', async () => {
    await reset();
    await makeFresh(owner.accessToken);
    const phone = random10();
    const invited = await call(app, '/api/v1/team/invites', { method: 'POST', headers: owner.auth, body: { contact: phone, role: 'owner' } });
    assert.equal(invited.status, 201, invited.text);
    await reset();
    const second = await codeSignIn(app, { phone, tenantId: app.tenant.id });
    assert.equal(second.business.id, app.tenant.id);
    assert.equal(second.user.role, 'owner');
    try {
      await makeFresh(owner.accessToken);
      const answers = await Promise.all([
        call(app, `/api/v1/team/${second.user.id}`, { method: 'PATCH', headers: owner.auth, body: { role: 'staff' } }),
        call(app, `/api/v1/team/${app.ownerId}`, { method: 'PATCH', headers: second.auth, body: { role: 'staff' } }),
      ]);
      assert.ok(answers.every((a) => a.status < 500), statuses(answers));
      const owners = await app.db.platform.query(`SELECT id FROM users WHERE tenant_id = $1 AND role = 'owner' AND removed_at IS NULL`, [app.tenant.id]);
      assert.ok(owners.length >= 1, `no owner left (${statuses(answers)})`);
    } finally {
      await app.db.platform.query(`UPDATE users SET role = 'owner' WHERE id = $1`, [app.ownerId]);
      await app.db.platform.query(`UPDATE users SET removed_at = now() WHERE id = $1`, [second.user.id]);
    }
  });

  test('two owners removing each other at the same moment leave one owner', async () => {
    await reset();
    await makeFresh(owner.accessToken);
    const phone = random10();
    const invited = await call(app, '/api/v1/team/invites', { method: 'POST', headers: owner.auth, body: { contact: phone, role: 'owner' } });
    assert.equal(invited.status, 201, invited.text);
    await reset();
    const second = await codeSignIn(app, { phone, tenantId: app.tenant.id });
    try {
      await makeFresh(owner.accessToken);
      const answers = await Promise.all([
        call(app, `/api/v1/team/${second.user.id}`, { method: 'DELETE', headers: owner.auth }),
        call(app, `/api/v1/team/${app.ownerId}`, { method: 'DELETE', headers: second.auth }),
      ]);
      assert.ok(answers.every((a) => a.status < 500), statuses(answers));
      const owners = await app.db.platform.query(`SELECT id FROM users WHERE tenant_id = $1 AND role = 'owner' AND removed_at IS NULL`, [app.tenant.id]);
      assert.ok(owners.length >= 1, `no owner left (${statuses(answers)})`);
    } finally {
      await app.db.platform.query(`UPDATE users SET removed_at = NULL, role = 'owner' WHERE id = $1`, [app.ownerId]);
    }
  });
});
