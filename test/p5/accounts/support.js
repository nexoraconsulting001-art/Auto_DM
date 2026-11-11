// What the accounts track's tests share: an app wired to the WhatsApp simulator as Bhava's own number, calls on the
// sign-in host from an address of the test's choosing, and sign-in through the code the simulator received.
import crypto from 'node:crypto';
import { createWhatsApp } from '../../../tools/sim/whatsapp/index.mjs';
import { APP_HOST, OWNER, sellerCodeFor, startApp, testDevice } from '../../helpers.js';
import { withTenant } from '../../../src/tenancy.js';

export { APP_HOST, OWNER, sellerCodeFor, testDevice };

let nextIp = 1;
/** A made-up client address, so limits per address in one test do not reach into the next. */
export const freshIp = () => `10.${(nextIp >> 16) & 255}.${(nextIp >> 8) & 255}.${nextIp++ & 255}`;

/** A test app whose platform WhatsApp number is the simulator. `close()` stops both. */
export async function accountsApp({ overrides = {}, ...rest } = {}) {
  const whatsapp = createWhatsApp({ token: 'platform-token' });
  await whatsapp.start();
  const app = await startApp({
    overrides: { whatsappBaseUrl: whatsapp.url, platformWhatsappPhoneId: '1000', platformWhatsappToken: 'platform-token', ...overrides },
    ...rest,
  });
  const ownerId = (await app.repos.users.findByPhone(OWNER.phone)).id;
  return {
    ...app,
    whatsapp,
    ownerId,
    async close() {
      app.close();
      await whatsapp.close();
    },
  };
}

/**
 * One request. `host` is the address it is sent to (the sign-in host unless told otherwise; null for the default
 * business at 127.0.0.1), `ip` the client address the proxy reports.
 */
export async function call(app, pathname, { method = 'GET', headers = {}, body, host = APP_HOST, ip = '10.200.0.1' } = {}) {
  const res = await fetch(`${app.base}${pathname}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(host ? { 'x-forwarded-host': host } : {}),
      'x-forwarded-for': ip,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, json, text, headers: res.headers };
}

/** How many WhatsApp messages the simulator has taken so far. */
export const sentCount = async (whatsapp) => (await whatsapp.get('/sent')).sent.length;

/**
 * Signs `phone` in with a code, each time from a new address. Returns the AuthSession plus the headers a later call
 * sends: the access token for transport bearer, or the cookie and CSRF token for cookie.
 */
export async function codeSignIn(app, { phone = OWNER.phone, transport = 'bearer', device, tenantId, host = APP_HOST, headers = {} } = {}) {
  const ip = freshIp();
  const start = await call(app, '/api/v1/auth/start', { method: 'POST', body: { phone }, ip, host, headers });
  if (start.status !== 202) throw new Error(`auth.start answered ${start.status}`);
  const code = await sellerCodeFor(app.whatsapp, phone);
  const res = await fetch(`${app.base}/api/v1/auth/verify`, {
    method: 'POST',
    headers: { ...(host ? { 'x-forwarded-host': host } : {}), 'x-forwarded-for': ip, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ phone, code, transport, ...(device ? { device } : {}), ...(tenantId ? { tenantId } : {}) }),
  });
  const session = await res.json();
  if (res.status !== 201) throw new Error(`auth.verify answered ${res.status}: ${session.code}`);
  const cookie = transport === 'cookie' ? res.headers.get('set-cookie')?.split(';')[0] : null;
  const auth = transport === 'cookie' ? { cookie, 'x-csrf-token': session.csrf } : { authorization: `Bearer ${session.accessToken}` };
  return { ...session, cookie, auth, ip, host };
}

/** A seller account typed in by an owner (no person has proved it yet), in `tenant`. */
export async function typedAccount(app, tenant, { name = 'Typed Person', phone, role = 'staff', permissions = [] }) {
  return withTenant(tenant, async () => {
    const [row] = await app.db.query(
      `INSERT INTO users (tenant_id, name, phone, email, password_hash, role, permissions) VALUES ($1, $2, $3, '', '!', $4, $5) RETURNING id`,
      [tenant.id, name, phone, role, permissions],
    );
    return row.id;
  });
}

/** Another business, with no account in it. */
export async function otherBusiness(app, name = 'Second Shop') {
  return app.platform.tenants.create({ slug: `s-${crypto.randomBytes(4).toString('hex')}`, name });
}

/** Captures every log line while `fn` runs. */
export async function captureLogs(fn) {
  const { setLogSink } = await import('../../../src/platform/log.js');
  const lines = [];
  setLogSink((line) => lines.push(line));
  try {
    await fn();
  } finally {
    setLogSink((line, level) => (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`));
  }
  return lines;
}

export const random10 = () => `9${String(crypto.randomInt(0, 1e9)).padStart(9, '0')}`;
