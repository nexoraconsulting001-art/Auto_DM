/**
 * App Store Connect as src/adapters/appstores reads it: API keys a business makes (each with a role), its apps, and where each
 * app stands in review. Point APPSTORE_BASE_URL at this server. Review changes can wait for the simulator's clock.
 *
 * API (Authorization: Bearer <ES256 JWT> signed with a key this simulator issued: kid the key id, iss its issuer id, aud
 * 'appstoreconnect-v1', at most 20 minutes long; anything else is 401):
 *   GET /v1/apps?filter[bundleId]=&include=appStoreVersions&limit=   -> { data: [{ type: 'apps', id, attributes: { bundleId,
 *       name, sellerName } }], included: [{ type: 'appStoreVersions', id, attributes: { versionString, buildNumber,
 *       appStoreState, createdDate, rejection? } }], meta: { apiKey: { roles: [role] } } }
 *       appStoreState is App Store Connect's own word (IN_REVIEW, REJECTED, PENDING_DEVELOPER_RELEASE, READY_FOR_SALE, ...).
 *       meta.apiKey and attributes.sellerName and rejection are this simulator's: the real service does not say them.
 *
 * Controls (under /__sim), beside the shared ones in base.mjs (faults: timeout, malformed for junk, server_error; calls; clock):
 *   POST /keys { role = 'APP_MANAGER' } -> { keyId, issuerId, privateKey }   role DEVELOPER is a key with too low a role
 *   POST /apps { bundleId, sellerName, name? } -> { id, bundleId }
 *   POST /review { bundleId, state: 'none' | 'in_review' | 'rejected' | 'approved' | 'live', guideline?, message?, version?,
 *                  buildNumber?, afterMs? }   now, or once the clock has moved afterMs further
 *   GET  /apps
 *
 * Not in SERVICES (tools/sim/index.mjs): a test that needs it starts it itself.
 */
import crypto from 'node:crypto';
import { SimError, createSim } from '../base.mjs';

const STATES = Object.freeze({ none: 'PREPARE_FOR_SUBMISSION', in_review: 'IN_REVIEW', rejected: 'REJECTED', approved: 'PENDING_DEVELOPER_RELEASE', live: 'READY_FOR_SALE' });
const ROLES = ['DEVELOPER', 'APP_MANAGER', 'ADMIN', 'ACCOUNT_HOLDER'];
const MAX_TOKEN_SECONDS = 20 * 60;
const unauthorized = () => new SimError(401, { errors: [{ status: '401', code: 'NOT_AUTHORIZED', title: 'Authentication credentials are missing or invalid.' }] });
const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

export function createAppStore() {
  let keys = new Map(); // keyId -> { issuerId, role, publicKey }
  let apps = new Map(); // bundleId -> app
  let seq = 0;

  const now = () => sim.clock.now();
  const nextKeyId = () => crypto.randomBytes(8).toString('hex').toUpperCase().slice(0, 10).replace(/[^A-Z0-9]/g, 'A');

  function authorize(headers) {
    const [scheme, jwt] = String(headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !jwt) throw unauthorized();
    const parts = jwt.split('.');
    if (parts.length !== 3) throw unauthorized();
    let head;
    let claims;
    try {
      head = decode(parts[0]);
      claims = decode(parts[1]);
    } catch {
      throw unauthorized();
    }
    const key = head?.alg === 'ES256' ? keys.get(head.kid) : null;
    if (!key) throw unauthorized();
    const signed = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: key.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url'));
    const seconds = Math.floor(now() / 1000);
    if (!signed || claims.iss !== key.issuerId || claims.aud !== 'appstoreconnect-v1' || !(claims.exp > seconds) || claims.exp - (claims.iat ?? seconds) > MAX_TOKEN_SECONDS) throw unauthorized();
    return key;
  }

  function settle(app) {
    const due = app.pending.filter((change) => change.at <= now());
    app.pending = app.pending.filter((change) => change.at > now());
    for (const change of due) apply(app, change);
  }
  function apply(app, change) {
    app.review = {
      state: change.state,
      version: change.version ?? app.review?.version ?? '1.0.0',
      buildNumber: change.buildNumber ?? app.review?.buildNumber ?? 1,
      createdDate: new Date(change.at ?? now()).toISOString(),
      rejection: change.state === 'rejected' ? { key: `rej-${++seq}`, guideline: String(change.guideline ?? ''), message: String(change.message ?? '') } : null,
      versionId: `v${app.id}-${++seq}`,
    };
  }
  const resource = (app) => ({ type: 'apps', id: app.id, attributes: { bundleId: app.bundleId, name: app.name, sellerName: app.sellerName } });
  const versionOf = (app) => (app.review ? [{
    type: 'appStoreVersions',
    id: app.review.versionId,
    attributes: {
      versionString: app.review.version, buildNumber: String(app.review.buildNumber), appStoreState: STATES[app.review.state], createdDate: app.review.createdDate,
      ...(app.review.rejection ? { rejection: app.review.rejection } : {}),
    },
  }] : []);

  const sim = createSim({
    name: 'appstore',
    errorBody: ({ kind, status }) => ({ errors: [{ status: String(status), code: kind, title: `Simulated ${kind}.` }] }),
    reset() {
      keys = new Map();
      apps = new Map();
      seq = 0;
    },
    routes: (on) => {
      on('GET', '/v1/apps', ({ headers, query }) => {
        const key = authorize(headers);
        const wanted = query['filter[bundleId]'];
        const found = [...apps.values()].filter((app) => !wanted || app.bundleId === wanted).slice(0, Number(query.limit) || 50);
        for (const app of found) settle(app);
        return {
          data: found.map(resource),
          ...(String(query.include ?? '').split(',').includes('appStoreVersions') ? { included: found.flatMap(versionOf) } : {}),
          meta: { paging: { total: found.length }, apiKey: { roles: [key.role] } },
        };
      });
    },
    controls: (on) => {
      on('POST', '/keys', ({ body = {} }) => {
        const role = String(body.role ?? 'APP_MANAGER').toUpperCase();
        if (!ROLES.includes(role)) throw new SimError(400, { error: `role must be one of ${ROLES.join(', ')}.` });
        const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
        const keyId = nextKeyId();
        const issuerId = crypto.randomUUID();
        keys.set(keyId, { issuerId, role, publicKey });
        return { keyId, issuerId, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
      });
      on('POST', '/apps', ({ body = {} }) => {
        if (typeof body.bundleId !== 'string' || !body.bundleId) throw new SimError(400, { error: 'bundleId is required.' });
        const app = { id: String(1_000_000_000 + apps.size + 1), bundleId: body.bundleId, name: String(body.name ?? body.sellerName ?? 'App'), sellerName: String(body.sellerName ?? ''), review: null, pending: [] };
        apps.set(app.bundleId, app);
        return { id: app.id, bundleId: app.bundleId };
      });
      on('POST', '/review', ({ body = {} }) => {
        const app = apps.get(body.bundleId);
        if (!app) throw new SimError(404, { error: 'No app with that bundleId.' });
        if (!Object.hasOwn(STATES, body.state)) throw new SimError(400, { error: `state must be one of ${Object.keys(STATES).join(', ')}.` });
        const change = { state: body.state, guideline: body.guideline, message: body.message, version: body.version, buildNumber: body.buildNumber, at: now() + (Number(body.afterMs) || 0) };
        if (Number(body.afterMs) > 0) app.pending.push(change);
        else apply(app, change);
        return { ok: true, at: change.at };
      });
      on('GET', '/apps', () => ({ apps: [...apps.values()].map((app) => { settle(app); return { ...resource(app), review: app.review }; }) }));
    },
  });
  return sim;
}
