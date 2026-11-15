// What the signup-plans track's tests share: an app wired to the WhatsApp simulator (sign-in codes), sign-up on the
// sign-in host, the Platform Console on its host, and plan changes written the way billing and the console write them.
import crypto from 'node:crypto';
import { withTenant } from '../../../src/tenancy.js';
import { passReleaseGates } from '../../helpers.js';
import { APP_HOST, OWNER, accountsApp, call, codeSignIn, freshIp, random10 } from '../../p5/accounts/support.js';

export { APP_HOST, OWNER, call, codeSignIn, freshIp, random10 };
export const PLATFORM_HOST = 'admin.bhava.test';

/** Every outbound link check answers 200, so a link passes 4.11 without the network. */
const linkOk = async () => new Response(null, { status: 200 });

export async function world({ overrides = {} } = {}) {
  const app = await accountsApp({ overrides: { linkCheckFetch: linkOk, ...overrides } });
  // The default business is connected like one that may go live (PRD 4.15).
  await passReleaseGates(app.db, app.tenant.id);
  const sql = (text, params) => app.db.platform.query(text, params);
  let consoleSession;

  const w = {
    ...app,
    sql,
    /** A Platform Console call as a super admin. */
    async console(method, pathname, body) {
      if (!consoleSession) {
        await app.platform.platformUsers.create({ email: 'ops@team.example', password: 'platform-pass-123', role: 'super_admin' }); // secret-scan:allow
        const res = await fetch(`${app.base}/login`, { method: 'POST', headers: { 'x-forwarded-host': PLATFORM_HOST, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ops@team.example', password: 'platform-pass-123' }) }); // secret-scan:allow
        if (res.status !== 200) throw new Error(`console login answered ${res.status}`);
        consoleSession = { cookie: res.headers.get('set-cookie').split(';')[0], csrf: (await res.json()).csrf };
      }
      return call(app, pathname, { method, body, host: PLATFORM_HOST, headers: { cookie: consoleSession.cookie, 'x-csrf-token': consoleSession.csrf } });
    },
    setMode: (mode) => sql('UPDATE signup_settings SET mode = $1', [mode]),
    /** A new person signed in on the sign-in host (bearer). Their first sign-in gives them the empty Free business of F-109. */
    async person(phone = random10()) {
      const session = await codeSignIn(app, { phone, transport: 'bearer' });
      return { phone, session, headers: session.auth, personId: Number((await sql('SELECT person_id FROM person_identities WHERE subject = $1', [`+91${phone}`]))[0]?.person_id) };
    },
    /** A sign-up call on the sign-in host as `who`, from a fresh address unless one is given. */
    signup(who, method, pathname, body, ip = freshIp()) {
      return call(app, `/api/v1${pathname}`, { method, body, headers: who?.headers ?? {}, ip });
    },
    /** Opens a run and starts a business. Returns { run, started }. */
    async signUp(who, { name = `Shop ${crypto.randomBytes(3).toString('hex')}`, accountType = 'seller', inviteCode, referralCode, ref } = {}) {
      const status = await w.signup(who, 'GET', `/signup${ref ? `?ref=${ref}` : ''}`);
      const started = await w.signup(who, 'POST', '/signup', { accountType, name, runToken: status.json.runToken, ...(inviteCode ? { inviteCode } : {}), ...(referralCode ? { referralCode } : {}) });
      return { runToken: status.json.runToken, started };
    },
    /** Connects an Instagram account to a business the way ig-connect stores it: the row, then its token. */
    async connectInstagram(tenantId, igUserId) {
      await app.platform.tenants.linkIgAccount(tenantId, igUserId, `ig${igUserId}`);
      await withTenant({ id: tenantId }, () => app.ctx.repos.igAccounts.setToken(igUserId, `token-${igUserId}`));
      await passReleaseGates(app.db, tenantId, igUserId);
    },
    /** A plan change as billing (source 'billing'), the owner ('owner') or the console ('console') writes it: one plan_changes row. */
    changePlan: (tenantId, plan, { source = 'console', actor = 'platform:1', cycle = 'monthly' } = {}) =>
      sql('INSERT INTO plan_changes (tenant_id, from_plan, to_plan, from_cycle, to_cycle, actor, source) VALUES ($1, $2, $2, $3, $3, $4, $5)', [tenantId, plan, cycle, actor, source]),
    /** The owner's bearer token in the default business (password login, tests only). */
    async ownerToken() {
      const res = await fetch(`${app.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OWNER) });
      return (await res.json()).token;
    },
  };
  return w;
}

/** An /api/v1 call on the default business's own address with a bearer token. */
export const api = (w, token, method, pathname, body) => call(w, `/api/v1${pathname}`, { method, body, host: null, headers: { authorization: `Bearer ${token}` } });

/** A valid automation for the builder: a comment keyword on a reel, two-tap, with the seller's own link. */
export const automationBody = (n, extra = {}) => ({
  name: `Auto ${n}`,
  triggerType: 'comment',
  keywords: [`WORD${n}`],
  linkUrl: 'https://shop.example/p',
  triggers: [{ channel: 'instagram', targetType: 'reel', mediaId: `179000000000${String(n).padStart(5, '0')}` }],
  variants: [{ label: 'A', body: 'Hi {first_name}, tap below for the link.' }],
  ...extra,
});
