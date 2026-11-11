// What the notifications track's tests share: an app wired to the push, WhatsApp and email simulators, workers with a
// clock the test moves, and sellers with a person, a verified phone, an email address and signed-in devices.
import crypto from 'node:crypto';
import { createNotify } from '../../../src/modules/notifications/index.js';
import { withTenant } from '../../../src/tenancy.js';
import { createEmail as createEmailSim } from '../../../tools/sim/email/index.mjs';
import { createPush as createPushSim } from '../../../tools/sim/push/index.mjs';
import { createWhatsApp as createWhatsAppSim } from '../../../tools/sim/whatsapp/index.mjs';
import { OWNER, startApp } from '../../helpers.js';

export const PLATFORM_FROM = 'alerts@mail.bhava.example';
/** The shopper every order in these tests belongs to: none of this may ever reach a seller's push, email or WhatsApp. */
export const SHOPPER = Object.freeze({ name: 'Asha Rao', phone: '+919876543210', line1: '12 Lake Road', pincode: '411001' });
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;

export function testClock(start = Date.now()) {
  let at = start;
  return { now: () => new Date(at), advance: (ms) => (at += ms), set: (date) => (at = +new Date(date)), get ms() { return at; } };
}

export const androidToken = () => `fcm-${crypto.randomBytes(16).toString('hex')}`;
export const iosToken = () => crypto.randomBytes(32).toString('hex');
export const deviceId = () => `dev-${crypto.randomBytes(10).toString('hex')}`;
const phoneSeq = { n: 0 };
const nextPhone = () => `+9199${String(Date.now() % 1e6).padStart(6, '0')}${String(++phoneSeq.n % 100).padStart(2, '0')}`;

/**
 * An app with every seller channel pointed at a simulator (turn one off with push/whatsapp/email: false). Nothing in the
 * app dispatches by itself: the test makes workers with worker() and drains them on its own clock.
 */
export async function startWorld({ push = true, whatsapp = true, email = true, overrides = {} } = {}) {
  const sims = {};
  if (push) {
    sims.push = createPushSim();
    await sims.push.start();
  }
  if (whatsapp) {
    sims.whatsapp = createWhatsAppSim({ token: 'platform-token' });
    await sims.whatsapp.start();
  }
  if (email) {
    sims.email = createEmailSim();
    await sims.email.start();
  }
  const fcm = push ? sims.push.fcmCredentials() : null;
  const apns = push ? sims.push.apnsCredentials() : null;
  const config = {
    providerTimeoutMs: 700,
    notifyPollMs: 0,
    ...(push ? {
      pushDriver: 'fcm,apns', fcmProjectId: fcm.projectId, fcmServiceAccount: fcm.serviceAccount, fcmBaseUrl: sims.push.url,
      apnsKeyId: apns.keyId, apnsTeamId: apns.teamId, apnsKey: apns.key, apnsTopic: apns.topic, apnsBaseUrl: sims.push.apnsUrl, apnsEnv: 'sandbox',
    } : { pushDriver: 'none' }),
    ...(whatsapp ? { whatsappBaseUrl: sims.whatsapp.url, platformWhatsappPhoneId: '1000', platformWhatsappToken: 'platform-token' } : {}),
    ...(email ? { emailDriver: 'http', emailBaseUrl: sims.email.url, emailApiKey: 'sim-email-key', platformEmailFrom: PLATFORM_FROM } : { emailDriver: 'none', platformEmailFrom: '' }),
    ...overrides,
  };
  const app = await startApp({ overrides: config });
  const clock = testClock();
  const workers = [];
  const sql = (text, params) => app.db.platform.query(text, params);
  const owner = (await app.repos.users.findByPhone(OWNER.phone)).id;
  const w = {
    app, sims, clock, sql, owner,
    tenant: app.tenant,
    notify: app.ctx.notify,
    /** A worker as the worker process builds it, on this test's clock. */
    worker({ now = clock.now } = {}) {
      const made = createNotify({ db: app.db, providers: app.ctx.providers, config: app.config, now });
      made.bind(app.ctx);
      workers.push(made);
      return made;
    },
    inTenant: (fn, tenant = app.tenant) => withTenant(tenant, fn),
    async close() {
      for (const made of workers) made.close();
      app.ctx.notify.close();
      app.close();
      for (const sim of Object.values(sims)) await sim.close();
    },
  };
  return w;
}

/** Another business in the same database, with its own owner account. */
export async function addBusiness(w, slug) {
  const tenant = await w.app.platform.tenants.ensure({ slug, name: `Shop ${slug}` });
  const owner = await addUser(w, { tenant, role: 'owner' });
  return { tenant, owner };
}

/** A seller account straight in the table: owner, manager or staff (with permissions), or a customer. */
export async function addUser(w, { tenant = w.tenant, role = 'staff', permissions = [], name = 'Team member' } = {}) {
  const phone = String(9000000000 + crypto.randomInt(1e8)).slice(0, 10);
  const [row] = await w.sql('INSERT INTO users (tenant_id, name, phone, password_hash, role, permissions) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [tenant.id, name, phone, 'x', role, permissions]);
  return row.id;
}

/** Ties an account to a person with a verified phone and an email address, the way signing in does. */
export async function addPerson(w, { userId, phone = nextPhone(), email = `seller${crypto.randomInt(1e9)}@shop.example`, personId = null } = {}) {
  let id = personId;
  if (!id) {
    const [person] = await w.sql(`INSERT INTO people (name) VALUES ('') RETURNING id`);
    id = Number(person.id);
    if (phone) await w.sql(`INSERT INTO person_identities (person_id, kind, subject, verified_at) VALUES ($1, 'phone', $2, now())`, [id, phone]);
  }
  await w.sql('UPDATE users SET person_id = $2, email = $3 WHERE id = $1', [userId, id, email ?? '']);
  return { personId: id, phone, email };
}

/** Signs a person in on a device the way the owner app does (a token family, the device, an access session) and returns its headers. */
export async function signInDevice(w, { personId, userId, tenant = w.tenant, platform = 'android', id = deviceId() }) {
  const [family] = await w.sql(`INSERT INTO token_families (subject_kind, person_id, device_id) VALUES ('user', $1, $2) RETURNING id`, [personId, id]);
  await w.sql(`INSERT INTO auth_devices (person_id, device_id, platform) VALUES ($1, $2, $3) ON CONFLICT (person_id, device_id) DO UPDATE SET revoked_at = NULL`, [personId, id, platform]);
  const access = await withTenant(tenant, () => w.app.platform.sessions.createAccess(userId, { familyId: family.id, deviceId: id, minutes: 15 }));
  return { id, platform, familyId: Number(family.id), headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' } };
}

export async function api(w, path, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(`${w.app.base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

/** Registers the device's push token through the route the app calls. */
export async function registerPush(w, device, token) {
  const res = await api(w, '/push/devices', { method: 'POST', headers: device.headers, body: { deviceId: device.id, platform: device.platform, token, appVersion: '1.0.0' } });
  if (res.status !== 204) throw new Error(`push.register answered ${res.status}: ${JSON.stringify(res.body)}`);
  return token;
}

/** A seller ready for every channel: a person, a verified phone, an email, and `devices` signed in with push tokens. */
export async function connect(w, { userId = w.owner, tenant = w.tenant, devices = ['android'], email, phone, personId } = {}) {
  const person = await addPerson(w, { userId, email, phone, personId });
  const made = [];
  for (const platform of devices) {
    const device = await signInDevice(w, { personId: person.personId, userId, tenant, platform });
    device.token = await registerPush(w, device, platform === 'ios' ? iosToken() : androidToken());
    made.push(device);
  }
  return { ...person, userId, devices: made };
}

export const received = async (w, token) => (await w.sims.push.received()).filter((p) => !token || p.token === token);
export const accepted = async (w, token) => (await received(w, token)).filter((p) => p.outcome === 'accepted');
export const emailsTo = async (w, address) => (await w.sims.email.get('/sent')).sent.filter((m) => m.to.includes(address));
export const whatsappsTo = async (w, phone) => (await w.sims.whatsapp.get('/sent')).sent.filter((m) => m.to === String(phone).replace(/^\+/, ''));
export const deliveriesOf = (w, eventId) => w.sql('SELECT * FROM notification_deliveries WHERE event_id = $1 ORDER BY id', [eventId]);
export const deliveryOf = async (w, eventId, channel, userId) => (await deliveriesOf(w, eventId)).find((d) => d.channel === channel && (!userId || d.user_id === userId));
