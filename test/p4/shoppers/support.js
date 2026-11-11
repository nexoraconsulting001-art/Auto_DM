import { bindTenant } from '../../../src/repos/index.js';
import { createSecrets } from '../../../src/platform/secrets.js';
import { createGoogle } from '../../../tools/sim/google/index.mjs';
import { createWhatsApp } from '../../../tools/sim/whatsapp/index.mjs';
import { TEST_DATA_KEY, startApp } from '../../helpers.js';

/**
 * A store with WhatsApp and Google sign-in on simulators (tools/sim), and helpers that act as a shopper's browser: a cookie
 * jar per host, following redirects by hand so each hop can be checked.
 */
export const secrets = createSecrets({ dataKey: TEST_DATA_KEY });
export const PLATFORM_HOST = 'admin.bhava.test';

let phoneIds = 100;

/** Connects a business's WhatsApp number with an approved login-code template. */
export async function connectWhatsApp(db, tenantId) {
  phoneIds += 1;
  await db.platform.query(`INSERT INTO whatsapp_accounts (tenant_id, waba_id, phone_number_id, access_token_enc) VALUES ($1, $2, $3, $4)`, [tenantId, `waba${phoneIds}`, `pn${phoneIds}`, secrets.encrypt('sim-whatsapp-token')]);
  await db.platform.query(`INSERT INTO whatsapp_templates (tenant_id, purpose, category, name, status) VALUES ($1, 'otp', 'authentication', 'login_code', 'approved')`, [tenantId]);
}

export async function world({ overrides = {}, google: withGoogle = true } = {}) {
  const wa = createWhatsApp();
  await wa.start();
  const google = withGoogle ? createGoogle() : null;
  if (google) await google.start();
  const app = await startApp({
    overrides: {
      whatsappBaseUrl: wa.url,
      ...(google ? { googleClientId: 'sim-google-client', googleClientSecret: 'sim-google-secret', googleOauthBaseUrl: google.url } : {}),
      ...overrides,
    },
  });
  await connectWhatsApp(app.db, app.tenant.id);
  await app.repos.settings.update({ store_name: 'Test store' });
  return {
    app,
    wa,
    google,
    async addStore(slug, name) {
      const tenant = await app.platform.tenants.create({ slug, name });
      await connectWhatsApp(app.db, tenant.id);
      return { tenant, repos: bindTenant(app.platform, tenant), host: `${slug}.bhava.test` };
    },
    /** The last code sent on WhatsApp to this number (digits, no plus). */
    async lastCode(phone) {
      const digits = String(phone).replace(/[^0-9]/g, '');
      const { sent } = await wa.get('/sent');
      const mine = sent.filter((m) => m.to === digits || m.to === `91${digits}`);
      return mine.at(-1)?.body?.template?.components?.[0]?.parameters?.[0]?.text ?? null;
    },
    async sentCount() {
      return (await wa.get('/sent')).sent.length;
    },
    async close() {
      app.close();
      await wa.close();
      if (google) await google.close();
    },
  };
}

/** A browser: cookies kept per host, requests to the app with that host. */
export function browser(app, { host = null, userAgent = 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36' } = {}) {
  const jars = new Map();
  const jarOf = (h) => {
    if (!jars.has(h)) jars.set(h, new Map());
    return jars.get(h);
  };
  const keep = (h, res) => {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = line.split(';');
      const [name, ...rest] = pair.trim().split('=');
      const value = rest.join('=');
      const expired = attrs.some((a) => /^\s*expires=Thu, 01 Jan 1970/i.test(a)) || attrs.some((a) => /^\s*max-age=0\b/i.test(a));
      if (expired || value === '') jarOf(h).delete(name);
      else jarOf(h).set(name, value);
    }
  };
  async function request(path, { method = 'GET', body, json, headers = {}, onHost = host, form } = {}) {
    const h = onHost ?? '127.0.0.1';
    const cookie = [...jarOf(h)].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`${app.base}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        'user-agent': userAgent,
        ...(onHost ? { 'x-forwarded-host': onHost } : {}),
        ...(cookie ? { cookie } : {}),
        ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(form !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...headers,
      },
      body: json !== undefined ? JSON.stringify(json) : form !== undefined ? new URLSearchParams(form) : body,
    });
    keep(h, res);
    return res;
  }
  return {
    defaultHost: host,
    request,
    cookies: (h = host ?? '127.0.0.1') => jarOf(h),
    /** Where a redirect goes, as { host, path }: an absolute address names its host, a path stays on `from` (the host it came from). */
    location(res, from = host) {
      const to = res.headers.get('location');
      if (!to) return null;
      if (to.startsWith('/')) return { host: from, path: to };
      const url = new URL(to);
      return { host: url.hostname === '127.0.0.1' ? null : url.hostname, path: `${url.pathname}${url.search}`, href: url.href };
    },
  };
}

/** Signs in with a WhatsApp code; returns the verify answer ({ signedIn, next, csrf }). */
export async function signInWithCode(w, b, phone, { next = '/' } = {}) {
  const sent = await b.request('/api/store/otp/send', { method: 'POST', json: { phone, purpose: 'sign_in' } });
  if (sent.status !== 200) throw new Error(`send failed with ${sent.status}: ${await sent.text()}`);
  const code = await w.lastCode(phone);
  const res = await b.request(`/api/store/otp/verify?next=${encodeURIComponent(next)}`, { method: 'POST', json: { phone, purpose: 'sign_in', code } });
  if (res.status !== 200) throw new Error(`verify failed with ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * Follows redirects through the platform host and back, as a browser would, from a response that came from `from`.
 * Returns the last response, with `trail`: every { host, path } it went to.
 */
export async function follow(b, res, { from, limit = 6 } = {}) {
  let current = res;
  let at = from === undefined ? b.defaultHost : from;
  const trail = [];
  for (let i = 0; i < limit && [301, 302, 303, 307, 308].includes(current.status); i++) {
    const to = b.location(current, at);
    trail.push({ host: to.host, path: to.path });
    current = await b.request(to.path, { onHost: to.host });
    at = to.host;
  }
  return Object.assign(current, { trail });
}

/** An order placed straight into the table, as checkout would leave it, with one line. Money in paise. */
export async function placeOrder(db, tenantId, { shopperId = null, phone = '+919876543210', name = 'Asha K', totalPaise = 49900, number, address = null, paymentMode = 'prepaid' } = {}) {
  const ship = address ?? { name, phone, line1: '12 MG Road', line2: '', landmark: '', city: 'Pune', stateCode: '27', pincode: '411001' };
  return db.platform.tx(async (t) => {
    const [product] = await t.query(`INSERT INTO products (tenant_id, slug, name, price_paise) VALUES ($1, $2, 'Brass lamp', $3) RETURNING id`, [tenantId, `lamp-${Math.random().toString(36).slice(2, 8)}`, totalPaise]);
    const [order] = await t.query(
      `INSERT INTO orders (tenant_id, order_number, public_token, customer_name, phone, email, address, city, state, pincode, subtotal_paise, shipping_paise, total_paise,
         flow, payment_mode, idempotency_key, shipping_address, shopper_id, balance_paise)
       VALUES ($1, $2, $3, $4, $5, '', $6, $7, 'Maharashtra', $8, $9, 0, $9, 'checkout', $10, $11, $12, $13, $14) RETURNING *`,
      [tenantId, number ?? `A${Math.floor(Math.random() * 1e6)}`, `tok${Math.random().toString(36).slice(2)}${Date.now()}`, name, phone, ship.line1, ship.city, ship.pincode, totalPaise,
        paymentMode, `idem-${Math.random().toString(36).slice(2, 12)}`, JSON.stringify(ship), shopperId, paymentMode === 'cod' ? totalPaise : 0],
    );
    await t.query(`INSERT INTO order_items (tenant_id, order_id, product_id, name, qty, price_paise) VALUES ($1, $2, $3, 'Brass lamp', 1, $4)`, [tenantId, order.id, product.id, totalPaise]);
    return order;
  });
}
