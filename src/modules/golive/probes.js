import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { GOLIVE_PROBES, META_PERMISSIONS } from '../../contracts/golive.js';
import { CODE_TEMPLATE, NOTIFY_EVENTS } from '../../contracts/notifications.js';
import { PROVIDER_PATHS } from '../../contracts/api/provider.js';
import { platformAppHostOf } from '../../config.js';
import { createHttp } from '../../adapters/http.js';
import { DEFAULT_GRAPH_VERSION, META_HOSTS } from '../../adapters/meta/index.js';
import { createMetaHttp } from '../../adapters/meta/http.js';
import { RAZORPAY_HOST } from '../../adapters/razorpay/index.js';
import { SHIPROCKET_HOST } from '../../adapters/shiprocket/index.js';
import { WHATSAPP_HOST, createWhatsApp } from '../../adapters/whatsapp/index.js';
import { GOOGLE_TOKEN_URL, readServiceAccount } from '../../adapters/push/fcm.js';
import { readApnsKey } from '../../adapters/push/apns.js';
import { EAS_ORIGIN } from '../../adapters/eas/index.js';
import { WEBHOOK_FIELDS } from '../ig-connect/rules.js';
import { createSecretRotation } from '../secret-rotation/index.js';
import { productionProblems } from '../../platform/production-guard.js';

/**
 * The live probes of the go-live checklist (GOLIVE_PROBES), one per name. Each is read-only: it asks a provider what is
 * true and never sends a message, makes an order or changes anything. Each declares
 *
 *   settings   the settings it needs (names as in the environment); a missing or test one makes the item missing first
 *   simulators the settings that point its adapter elsewhere; any of them set makes it missing (a simulator is never ready)
 *   chosen     base URLs of a provider of our choosing: set, https, and not a simulator
 *   local      true when it asks nothing outside (the database, a file, the configuration): it runs with --offline too
 *   run(p)     -> { state, detail } where detail is a key of DETAIL (checklist.js): the answer is checked there again
 *
 * A probe is ready only on an answer that shows it positively; an answer that says nothing either way is unknown.
 * Where a provider's field names are not documented for app-level reads (marked "to confirm"), the probe expects the
 * shape written beside it and answers unknown for anything else, so a wrong guess can never report ready.
 */

const META_SIMS = ['GRAPH_BASE_URL', 'IG_API_BASE_URL', 'FB_GRAPH_BASE_URL', 'IG_DIALOG_BASE_URL', 'FB_DIALOG_BASE_URL'];
const GOOGLE_OAUTH_HOST = 'https://oauth2.googleapis.com';
const ok = () => ({ state: 'ready', detail: 'ok' });
const missing = (detail) => ({ state: 'missing', detail });
const unknown = (detail = 'unreachable') => ({ state: 'unknown', detail });
const lower = (v) => String(v ?? '').trim().toLowerCase();
const DAY = 86_400_000;

/** Every platform host the public reaches: the domain, the platform host, the sign-in host and the public address's host. */
export function platformHosts(config) {
  const hosts = [config.platformDomain, config.platformHost, platformAppHostOf(config)];
  try {
    if (config.publicBaseUrl) hosts.push(new URL(config.publicBaseUrl).hostname);
  } catch {
    // Not an address: the settings check reports it.
  }
  return [...new Set(hosts.map(lower).filter(Boolean))];
}

const PRIVATE = /^(10\.|127\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)|^(::1?|f[cd][0-9a-f]{0,2}:|fe[89ab][0-9a-f]?:|::ffff:)/i;

/** The WhatsApp templates Bhava's own number sends: the login code and every alert kind that goes by WhatsApp. */
export function platformTemplates() {
  return [...new Set([CODE_TEMPLATE, ...Object.values(NOTIFY_EVENTS).map((e) => e.whatsapp).filter(Boolean)])];
}

function meta(p) {
  const call = createMetaHttp({ timeoutMs: p.timeoutMs });
  const base = p.bases.facebookGraph ?? META_HOSTS.facebookGraph;
  const appId = String(p.value('IG_APP_ID'));
  const token = `${appId}|${p.value('APP_SECRET')}`;
  return async (pathname, query = {}) => (await call({ base, version: DEFAULT_GRAPH_VERSION, method: 'GET', pathname: `${encodeURIComponent(appId)}${pathname}`, query, token })).data;
}

const http = (p, provider, base, codeOf) => createHttp({ provider, baseUrl: String(base).replace(/\/+$/, ''), timeoutMs: p.timeoutMs, codeOf });
const basic = (id, secret) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

/** A refusal of our own credentials is "refused"; a provider that would not answer stays unknown. */
const byFailure = (err, rejected = 'notApproved') => {
  if (err?.kind === 'auth') return missing('refused');
  if (err?.kind === 'rejected' || err?.kind === 'oauth' || err?.kind === 'permission') return missing(rejected);
  return unknown();
};

async function lookupAll(host) {
  const found = await dns.promises.lookup(host, { all: true, verbatim: true });
  return found.map((a) => a.address);
}

function certificateDays(host, { timeoutMs, port = 443 }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, timeout: timeoutMs, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate();
      if (!socket.authorized || !cert?.valid_to) return done(-1);
      done((new Date(cert.valid_to).getTime() - Date.now()) / DAY);
    });
    socket.on('timeout', () => done(null));
    socket.on('error', () => done(null));
  });
}

function fcmAssertion(account, now = Date.now()) {
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const iat = Math.floor(now / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: account.clientEmail, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: GOOGLE_TOKEN_URL, iat, exp: iat + 600 })}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(account.privateKey).toString('base64url');
  return `${unsigned}.${signature}`;
}

async function prometheusAny(p, query) {
  const base = p.bases.prometheus ?? p.value('PROMETHEUS_URL');
  const { body } = await http(p, 'prometheus', base)('GET', '/api/v1/query', { query: { query } });
  const result = Array.isArray(body?.data?.result) ? body.data.result : null;
  if (!result) return null;
  return result.some((r) => String(r?.value?.[1]) === '1');
}

export const PROBES = Object.freeze({
  // Meta: one app-level read each, with the app's own token (id|secret), at graph.facebook.com.
  'meta.app_mode': {
    settings: ['IG_APP_ID', 'APP_SECRET'], simulators: META_SIMS,
    // To confirm: GET /{app-id}?fields=id,app_mode answers { app_mode: 'live' | 'development' }.
    async run(p) {
      const data = await meta(p)('', { fields: 'id,app_mode' });
      const mode = lower(data.app_mode ?? data.mode);
      if (data.development_mode === true || mode === 'development' || mode === 'dev') return missing('developmentMode');
      if (mode === 'live' && data.development_mode !== true) return ok();
      return unknown();
    },
  },
  'meta.business_verification': {
    settings: ['IG_APP_ID', 'APP_SECRET'], simulators: META_SIMS,
    // To confirm: GET /{app-id}?fields=business{verification_status} answers { business: { verification_status } }.
    async run(p) {
      const status = lower((await meta(p)('', { fields: 'business{verification_status}' })).business?.verification_status);
      if (status === 'verified') return ok();
      return status ? missing('notVerified') : unknown();
    },
  },
  'meta.tech_provider': {
    settings: ['IG_APP_ID', 'APP_SECRET'], simulators: META_SIMS,
    // To confirm: GET /{app-id}?fields=tech_provider_status answers { tech_provider_status: 'approved' | ... }.
    async run(p) {
      const status = lower((await meta(p)('', { fields: 'tech_provider_status' })).tech_provider_status);
      if (status === 'approved' || status === 'granted') return ok();
      return status ? missing('notApproved') : unknown();
    },
  },
  'meta.permission_access': {
    settings: ['IG_APP_ID', 'APP_SECRET'], simulators: META_SIMS,
    // To confirm: GET /{app-id}/permissions answers { data: [{ permission, status, access_level }] }. Every permission of
    // the group must be there with Advanced Access; one missing or on Standard Access is "Standard Access only".
    async run(p, args = {}) {
      const wanted = META_PERMISSIONS[args.group];
      if (!wanted) return unknown('notBuilt');
      const data = await meta(p)('/permissions');
      if (!Array.isArray(data.data)) return unknown();
      const byName = new Map(data.data.map((row) => [String(row?.permission ?? ''), row]));
      const advanced = (row) => lower(row?.access_level) === 'advanced' && !['declined', 'revoked', 'disabled'].includes(lower(row?.status));
      return wanted.every((name) => advanced(byName.get(name))) ? ok() : missing('standardAccess');
    },
  },
  'meta.webhook_subscription': {
    settings: ['IG_APP_ID', 'APP_SECRET', 'PUBLIC_BASE_URL'], simulators: META_SIMS,
    // GET /{app-id}/subscriptions (app token): { data: [{ object, callback_url, active, fields: [{ name }] }] }.
    async run(p) {
      const data = await meta(p)('/subscriptions');
      if (!Array.isArray(data.data)) return unknown();
      const sub = data.data.find((s) => lower(s?.object) === 'instagram');
      if (!sub || sub.active === false) return missing('notSubscribed');
      let callback;
      try {
        callback = new URL(String(sub.callback_url ?? ''));
      } catch {
        return missing('wrongAddress');
      }
      if (callback.protocol !== 'https:' || !platformHosts(p.config).includes(lower(callback.hostname)) || callback.pathname.replace(/\/+$/, '') !== PROVIDER_PATHS.webhook) return missing('wrongAddress');
      const fields = new Set((Array.isArray(sub.fields) ? sub.fields : []).map((f) => String(typeof f === 'string' ? f : f?.name ?? '')));
      return WEBHOOK_FIELDS.every((f) => fields.has(f)) ? ok() : missing('notSubscribed');
    },
  },
  'meta.privacy_and_deletion': {
    settings: ['PUBLIC_BASE_URL'], simulators: [],
    // The privacy page answers 200; the deletion callback answers an unsigned request with a refusal (it is there, and
    // it checks the signature). Neither changes anything.
    async run(p) {
      const request = http(p, 'platform', p.bases.public ?? p.config.publicBaseUrl);
      const page = await request('GET', '/privacy', { headers: { accept: 'text/html' } }).catch((err) => err);
      if (page?.status !== 200) return page?.kind === 'rejected' || page?.kind === 'auth' ? missing('notAnswering') : unknown();
      try {
        await request('POST', PROVIDER_PATHS.deletion, { form: { signed_request: 'golive.probe' } });
        return missing('acceptsUnsigned');
      } catch (err) {
        if (err?.status === 404 || err?.status === 405) return missing('notAnswering');
        return err?.status >= 400 && err?.status < 500 ? ok() : unknown();
      }
    },
  },

  // Bhava's Razorpay account: live keys, Route, Subscriptions.
  'razorpay.route_live': {
    settings: ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'], simulators: ['RAZORPAY_BASE_URL', 'RAZORPAY_AUTH_BASE_URL'],
    async run(p) {
      try {
        const { body } = await http(p, 'razorpay', p.bases.razorpay ?? RAZORPAY_HOST)('GET', '/v1/transfers', { headers: { authorization: basic(p.value('RAZORPAY_KEY_ID'), p.value('RAZORPAY_KEY_SECRET')) }, query: { count: 1 } });
        return body?.entity === 'collection' ? ok() : unknown();
      } catch (err) {
        return byFailure(err);
      }
    },
  },
  'razorpay.billing_live': {
    settings: ['RAZORPAY_BILLING_WEBHOOK_SECRET'], simulators: ['RAZORPAY_BASE_URL'],
    async run(p) {
      const id = p.value('RAZORPAY_BILLING_KEY_ID') || p.value('RAZORPAY_KEY_ID');
      const secret = p.value('RAZORPAY_BILLING_KEY_SECRET') || p.value('RAZORPAY_KEY_SECRET');
      if (!id || !secret) return missing('notSet');
      if (!/^rzp_live_/.test(id)) return missing('testValue');
      try {
        const { body } = await http(p, 'razorpay', p.bases.razorpay ?? RAZORPAY_HOST)('GET', '/v1/plans', { headers: { authorization: basic(id, secret) }, query: { count: 1 } });
        return body?.entity === 'collection' ? ok() : unknown();
      } catch (err) {
        return byFailure(err);
      }
    },
  },
  'shiprocket.account': {
    settings: ['SHIPROCKET_EMAIL', 'SHIPROCKET_PASSWORD', 'SHIPROCKET_WEBHOOK_TOKEN'], simulators: ['SHIPROCKET_BASE_URL'],
    // Signing in is the one read Shiprocket offers for "this account works": it changes nothing.
    async run(p) {
      try {
        const { body } = await http(p, 'shiprocket', p.bases.shiprocket ?? SHIPROCKET_HOST)('POST', '/v1/external/auth/login', { json: { email: p.value('SHIPROCKET_EMAIL'), password: p.value('SHIPROCKET_PASSWORD') } });
        return body?.token ? ok() : unknown();
      } catch (err) {
        return err?.kind === 'rejected' ? missing('refused') : byFailure(err);
      }
    },
  },

  // Bhava's own WhatsApp number, through the WhatsApp adapter.
  'whatsapp.sender': {
    settings: ['PLATFORM_WHATSAPP_PHONE_ID', 'PLATFORM_WHATSAPP_TOKEN'], simulators: ['WHATSAPP_BASE_URL'],
    async run(p) {
      try {
        const number = await p.whatsapp().phoneNumber({ phoneNumberId: p.value('PLATFORM_WHATSAPP_PHONE_ID'), accessToken: p.value('PLATFORM_WHATSAPP_TOKEN') });
        if (!number.verifiedName) return missing('notVerified');
        return lower(number.quality) === 'red' ? missing('notApproved') : ok();
      } catch (err) {
        return byFailure(err);
      }
    },
  },
  'whatsapp.templates': {
    settings: ['PLATFORM_WHATSAPP_PHONE_ID', 'PLATFORM_WHATSAPP_TOKEN', 'PLATFORM_WHATSAPP_WABA_ID'], simulators: ['WHATSAPP_BASE_URL'],
    async run(p) {
      try {
        const account = { wabaId: p.value('PLATFORM_WHATSAPP_WABA_ID'), phoneNumberId: p.value('PLATFORM_WHATSAPP_PHONE_ID'), accessToken: p.value('PLATFORM_WHATSAPP_TOKEN') };
        const have = await p.whatsapp().templates(account);
        const renamed = p.config.platformWhatsappTemplates ?? {};
        const nameOf = (name) => (typeof renamed[name] === 'string' && renamed[name] ? renamed[name] : name);
        const approved = new Set(have.filter((t) => t.status === 'approved').map((t) => t.name));
        return platformTemplates().every((name) => approved.has(nameOf(name))) ? ok() : missing('notApproved');
      } catch (err) {
        return byFailure(err);
      }
    },
  },

  // Google sign-in: a code exchange with a code that cannot be valid. "invalid_grant" means the client was accepted;
  // "invalid_client" means it was not. The consent screen's verification has no API and is the founder's to finish.
  'google.signin_client': {
    settings: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], simulators: ['GOOGLE_OAUTH_BASE_URL', 'GOOGLE_KEYS_BASE_URL'],
    async run(p) {
      const request = http(p, 'google', p.bases.googleOauth ?? GOOGLE_OAUTH_HOST, (body) => body?.error ?? '');
      const pairs = [['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], ['SELLER_GOOGLE_CLIENT_ID', 'SELLER_GOOGLE_CLIENT_SECRET']].filter(([id]) => p.value(id));
      for (const [id, secret] of pairs) {
        if (!p.value(secret)) return missing('notSet');
        try {
          await request('POST', '/token', { form: { grant_type: 'authorization_code', code: 'golive-probe', client_id: p.value(id), client_secret: p.value(secret), redirect_uri: p.config.publicBaseUrl || 'https://invalid' } });
          return unknown();
        } catch (err) {
          if (err?.code === 'invalid_client' || err?.code === 'unauthorized_client') return missing('refused');
          if (err?.code !== 'invalid_grant' && err?.code !== 'redirect_uri_mismatch') return unknown();
        }
      }
      return ok();
    },
  },

  // Push: FCM answers a token for the service account; APNs has no read-only call, so its key is checked here only.
  'push.fcm': {
    settings: ['FCM_PROJECT_ID', 'FCM_SERVICE_ACCOUNT'], simulators: ['FCM_BASE_URL'],
    async run(p) {
      let account;
      try {
        account = readServiceAccount(p.value('FCM_SERVICE_ACCOUNT'));
      } catch {
        return missing('unreadable');
      }
      try {
        const url = new URL(p.bases.googleToken ?? GOOGLE_TOKEN_URL);
        const { body } = await http(p, 'fcm', url.origin, (b) => b?.error ?? '')('POST', url.pathname, { form: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: fcmAssertion(account) } });
        return body?.access_token ? ok() : unknown();
      } catch (err) {
        return err?.code === 'invalid_grant' || err?.code === 'invalid_client' ? missing('refused') : byFailure(err);
      }
    },
  },
  'push.apns': {
    settings: ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_KEY', 'APNS_TOPIC'], simulators: ['APNS_BASE_URL'], local: true,
    async run(p) {
      if (lower(p.value('APNS_ENV')) !== 'production') return missing('testValue');
      try {
        readApnsKey(p.value('APNS_KEY'));
      } catch {
        return missing('unreadable');
      }
      return unknown('localOnly');
    },
  },
  'ai.provider': {
    settings: ['AI_API_KEY'], chosen: ['AI_BASE_URL'], simulators: [],
    async run(p) {
      try {
        await http(p, 'ai', p.bases.ai ?? p.config.aiBaseUrl)('GET', '/models', { headers: { authorization: `Bearer ${p.value('AI_API_KEY')}` } });
        return ok();
      } catch (err) {
        return byFailure(err);
      }
    },
  },
  'email.sender': {
    settings: ['EMAIL_API_KEY', 'PLATFORM_EMAIL_FROM', 'EMAIL_DKIM_SELECTOR'], chosen: ['EMAIL_BASE_URL'], simulators: [],
    async run(p) {
      const domain = String(p.value('PLATFORM_EMAIL_FROM')).split('@').pop();
      const records = await p.dns.resolveTxt(`${p.value('EMAIL_DKIM_SELECTOR')}._domainkey.${domain}`).catch((err) => (err?.code === 'ENOTFOUND' || err?.code === 'ENODATA' ? [] : null));
      if (!records) return unknown();
      const text = records.map((r) => r.join('')).join(' ');
      return /v=DKIM1/i.test(text) && /p=[A-Za-z0-9+/]{20,}/.test(text) ? ok() : missing('notVerified');
    },
  },

  // The platform's own hosts.
  'dns.platform_hosts': {
    settings: ['PLATFORM_DOMAIN'], simulators: [],
    async run(p) {
      const want = lower(p.value('LOAD_BALANCER_ADDRESS'));
      for (const host of platformHosts(p.config)) {
        let addresses;
        try {
          addresses = await p.dns.lookupAll(host);
        } catch (err) {
          if (err?.code === 'ENOTFOUND' || err?.code === 'ENODATA') return missing('doesNotResolve');
          return unknown();
        }
        if (!addresses.length) return missing('doesNotResolve');
        if (addresses.some((a) => PRIVATE.test(a))) return missing('simulator');
        if (want && !addresses.map(lower).includes(want)) return missing('wrongAddress');
      }
      return ok();
    },
  },
  'tls.platform_hosts': {
    settings: ['PLATFORM_DOMAIN'], simulators: [],
    async run(p) {
      for (const host of platformHosts(p.config)) {
        const days = await p.tls.certificateDays(host, { timeoutMs: p.timeoutMs, port: p.bases.tlsPort });
        if (days === null) return unknown();
        if (days <= 14) return missing('certificate');
      }
      return ok();
    },
  },
  'backups.recent': {
    settings: ['BACKUP_STORAGE_DRIVER'], simulators: [], local: true,
    async run(p) {
      if (!p.db) return unknown();
      const [row] = await p.db.query(`SELECT max(finished_at) AS at FROM jobs WHERE queue = 'system.backup' AND status = 'done'`);
      const at = row?.at ? new Date(row.at).getTime() : 0;
      if (!at || p.now() - at > 26 * 3_600_000) return missing('backupOld');
      const report = path.join(p.config.rootDir ?? process.cwd(), 'test-results', 'drill', 'report.json');
      try {
        const stat = fs.statSync(report);
        const parsed = JSON.parse(fs.readFileSync(report, 'utf8'));
        if (parsed?.ok !== true || p.now() - stat.mtimeMs > 90 * DAY) return missing('drillNotPassed');
      } catch {
        return missing('drillNotPassed');
      }
      return ok();
    },
  },
  'monitoring.scraping': {
    settings: ['METRICS_TOKEN'], chosen: ['PROMETHEUS_URL', 'ALERTMANAGER_URL'], simulators: [],
    async run(p) {
      const scraped = await prometheusAny(p, 'up{job=~"bhava.*"}');
      if (scraped === null) return unknown();
      if (!scraped) return missing('notScraped');
      const { body } = await http(p, 'alertmanager', p.bases.alertmanager ?? p.value('ALERTMANAGER_URL'))('GET', '/api/v2/receivers');
      const receivers = Array.isArray(body) ? body.map((r) => lower(r?.name)).filter((n) => n && !['null', 'blackhole', 'default-null'].includes(n)) : null;
      if (!receivers) return unknown();
      return receivers.length ? ok() : missing('noReceiver');
    },
  },
  'monitoring.uptime_probe': {
    settings: [], chosen: ['PROMETHEUS_URL'], simulators: [],
    async run(p) {
      const up = await prometheusAny(p, 'probe_success');
      if (up === null) return unknown();
      return up ? ok() : missing('notScraped');
    },
  },
  'secrets.rewrap_done': {
    settings: ['DATA_KEY'], simulators: [], local: true,
    async run(p) {
      if (lower(p.config.secretsFormat) !== 'v2') return missing('notEnvelope');
      if (!p.db || !p.secrets?.configured) return unknown();
      const { remaining } = await createSecretRotation({ db: p.db, platform: { secrets: p.secrets } }).retirable();
      return remaining.length === 0 ? ok() : missing('notEnvelope');
    },
  },
  'runtime.production_guard': {
    settings: [], simulators: [], local: true,
    async run(p) {
      if (lower(p.config.deployEnv) !== 'production') return missing('qaProfile');
      const broken = productionProblems(p.config);
      return broken.length ? { state: 'missing', detail: 'brokenRule', names: broken.flatMap((b) => b.settings ?? []) } : ok();
    },
  },
  'eas.account': {
    settings: ['EXPO_TOKEN', 'EAS_ACCOUNT'], simulators: ['EAS_BASE_URL'],
    async run(p) {
      try {
        const { body } = await http(p, 'eas', p.bases.eas ?? EAS_ORIGIN)('POST', '/graphql', { headers: { authorization: `Bearer ${p.value('EXPO_TOKEN')}` }, json: { query: '{ me { username } }' } });
        return body?.data?.me ? ok() : missing('refused');
      } catch (err) {
        return byFailure(err);
      }
    },
  },
  'stores.owner_app_listed': {
    settings: ['OWNER_APP_BUNDLE_ID', 'OWNER_APP_PACKAGE'], simulators: ['APPSTORE_BASE_URL', 'PLAY_BASE_URL'], local: true,
    // The stores' read APIs need Bhava's own App Store Connect key and Play service account, which have no settings yet.
    async run() {
      return unknown('notBuilt');
    },
  },
});

for (const name of GOLIVE_PROBES) if (!PROBES[name]) throw new Error(`The go-live probe ${name} has no implementation`);

/** The outside world the probes use; tests replace parts of it. */
export function probeWorld(config, overrides = {}) {
  let whatsapp;
  return {
    whatsapp: () => (whatsapp ??= overrides.whatsapp ?? createWhatsApp(config)),
    dns: { lookupAll, resolveTxt: (name) => dns.promises.resolveTxt(name), ...overrides.dns },
    tls: { certificateDays, ...overrides.tls },
  };
}
