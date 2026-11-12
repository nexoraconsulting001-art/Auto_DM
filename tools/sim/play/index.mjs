/**
 * Google Play as src/adapters/appstores reads it: the token exchange for our service account, the apps that granted it
 * permissions, and each app's track and review state. Point PLAY_BASE_URL at this server: it serves both the Play API and the
 * token address (POST /token). Review changes can wait for the simulator's clock.
 *
 * API:
 *   POST   /token  grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<RS256 JWT of a service account it issued,
 *                  aud <this server>/token>   -> { access_token, expires_in, token_type }; anything else is 400 invalid_grant
 *   (the rest needs Authorization: Bearer <access token>; anything else is 401)
 *   POST   /androidpublisher/v3/applications/:packageName/edits   -> { id, expiryTimeSeconds, grantedPermissions }   404 for an app
 *          it does not know, 403 when the app granted our account nothing. grantedPermissions is this simulator's
 *   DELETE /androidpublisher/v3/applications/:packageName/edits/:editId   -> 204
 *   GET    /androidpublisher/v3/applications/:packageName/edits/:editId/tracks/:track -> { track, releases: [{ name, versionCodes,
 *          status }], developerName, review: { state, rejection } }   developerName and review are this simulator's
 *
 * Controls (under /__sim), beside the shared ones in base.mjs (faults: timeout, malformed for junk, server_error; calls; clock):
 *   POST /service-account -> the service account JSON it accepts ({ type, client_email, private_key, token_uri, ... })
 *   POST /apps { packageName, developerName, permissions: ['RELEASE_TO_PRODUCTION', ...] }   [] grants nothing
 *   POST /track { packageName, state: 'none' | 'in_review' | 'rejected' | 'approved' | 'live', guideline?, message?, versionName?,
 *                 versionCode?, afterMs? }   now, or once the clock has moved afterMs further
 *   GET  /apps
 *
 * Not in SERVICES (tools/sim/index.mjs): a test that needs it starts it itself.
 */
import crypto from 'node:crypto';
import { SimError, createSim, reply } from '../base.mjs';

const REVIEW_STATES = ['none', 'in_review', 'rejected', 'approved', 'live'];
const RELEASE_STATUS = Object.freeze({ none: 'draft', in_review: 'inProgress', rejected: 'halted', approved: 'inProgress', live: 'completed' });
const unauthenticated = () => new SimError(401, { error: { code: 401, status: 'UNAUTHENTICATED', message: 'Request had invalid authentication credentials.' } });
const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

export function createPlay() {
  let accounts = new Map(); // client_email -> publicKey
  let tokens = new Map(); // access token -> { email, until }
  let apps = new Map(); // packageName -> app
  let edits = new Map(); // editId -> packageName
  let seq = 0;

  const now = () => sim.clock.now();

  function authorize(headers) {
    const [scheme, value] = String(headers.authorization ?? '').split(' ');
    const held = scheme === 'Bearer' ? tokens.get(value) : null;
    if (!held || held.until <= now()) throw unauthenticated();
    return held.email;
  }
  function appOf(packageName) {
    const app = apps.get(packageName);
    if (!app) throw new SimError(404, { error: { code: 404, status: 'NOT_FOUND', message: 'Package not found.' } });
    return app;
  }
  function settle(app) {
    const due = app.pending.filter((change) => change.at <= now());
    app.pending = app.pending.filter((change) => change.at > now());
    for (const change of due) apply(app, change);
  }
  function apply(app, change) {
    app.review = {
      state: change.state,
      versionName: change.versionName ?? app.review?.versionName ?? '1.0.0',
      versionCode: change.versionCode ?? app.review?.versionCode ?? 1,
      rejection: change.state === 'rejected' ? { key: `play-rej-${++seq}`, guideline: String(change.guideline ?? ''), message: String(change.message ?? '') } : null,
    };
  }

  const sim = createSim({
    name: 'play',
    errorBody: ({ kind, status }) => ({ error: { code: status, status: kind, message: `Simulated ${kind}.` } }),
    reset() {
      accounts = new Map();
      tokens = new Map();
      apps = new Map();
      edits = new Map();
      seq = 0;
    },
    routes: (on) => {
      on('POST', '/token', ({ body = {} }) => {
        const invalid = () => new SimError(400, { error: 'invalid_grant', error_description: 'Invalid JWT.' });
        if (body.grant_type !== 'urn:ietf:params:oauth:grant-type:jwt-bearer' || typeof body.assertion !== 'string') throw invalid();
        const parts = body.assertion.split('.');
        if (parts.length !== 3) throw invalid();
        let head;
        let claims;
        try {
          head = decode(parts[0]);
          claims = decode(parts[1]);
        } catch {
          throw invalid();
        }
        const publicKey = head?.alg === 'RS256' ? accounts.get(claims?.iss) : null;
        if (!publicKey) throw invalid();
        const signed = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url'));
        const seconds = Math.floor(now() / 1000);
        if (!signed || claims.aud !== `${sim.url}/token` || !String(claims.scope ?? '').includes('androidpublisher') || !(claims.exp > seconds)) throw invalid();
        const token = `ya29.sim-${crypto.randomBytes(18).toString('base64url')}`;
        tokens.set(token, { email: claims.iss, until: now() + 3600_000 });
        return { access_token: token, expires_in: 3600, token_type: 'Bearer' };
      });
      on('POST', '/androidpublisher/v3/applications/:packageName/edits', ({ headers, params }) => {
        authorize(headers);
        const app = appOf(params.packageName);
        if (!app.permissions.length) throw new SimError(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission.' } });
        const id = `edit-${++seq}`;
        edits.set(id, app.packageName);
        return { id, expiryTimeSeconds: String(Math.floor(now() / 1000) + 3600), grantedPermissions: [...app.permissions] };
      });
      on('DELETE', '/androidpublisher/v3/applications/:packageName/edits/:editId', ({ headers, params }) => {
        authorize(headers);
        edits.delete(params.editId);
        return reply(204, null);
      });
      on('GET', '/androidpublisher/v3/applications/:packageName/edits/:editId/tracks/:track', ({ headers, params }) => {
        authorize(headers);
        if (edits.get(params.editId) !== params.packageName) throw new SimError(404, { error: { code: 404, status: 'NOT_FOUND', message: 'Edit not found.' } });
        const app = appOf(params.packageName);
        settle(app);
        const review = app.review ?? { state: 'none', versionName: '', versionCode: null, rejection: null };
        return {
          track: params.track,
          releases: review.versionCode ? [{ name: review.versionName, versionCodes: [String(review.versionCode)], status: RELEASE_STATUS[review.state] }] : [],
          developerName: app.developerName,
          review: { state: review.state, ...(review.rejection ? { rejection: review.rejection } : {}) },
        };
      });
    },
    controls: (on) => {
      on('POST', '/service-account', () => {
        const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const email = `publisher-${++seq}@sim-play.iam.gserviceaccount.com`;
        accounts.set(email, publicKey);
        return {
          type: 'service_account', project_id: 'sim-play', private_key_id: crypto.randomBytes(20).toString('hex'),
          private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), client_email: email, token_uri: `${sim.url}/token`,
        };
      });
      on('POST', '/apps', ({ body = {} }) => {
        if (typeof body.packageName !== 'string' || !body.packageName) throw new SimError(400, { error: 'packageName is required.' });
        const app = { packageName: body.packageName, developerName: String(body.developerName ?? ''), permissions: Array.isArray(body.permissions) ? body.permissions.map(String) : [], review: null, pending: [] };
        apps.set(app.packageName, app);
        return { packageName: app.packageName };
      });
      on('POST', '/track', ({ body = {} }) => {
        const app = apps.get(body.packageName);
        if (!app) throw new SimError(404, { error: 'No app with that packageName.' });
        if (!REVIEW_STATES.includes(body.state)) throw new SimError(400, { error: `state must be one of ${REVIEW_STATES.join(', ')}.` });
        const change = { state: body.state, guideline: body.guideline, message: body.message, versionName: body.versionName, versionCode: body.versionCode, at: now() + (Number(body.afterMs) || 0) };
        if (Number(body.afterMs) > 0) app.pending.push(change);
        else apply(app, change);
        return { ok: true, at: change.at };
      });
      on('GET', '/apps', () => ({ apps: [...apps.values()].map((app) => { settle(app); return { packageName: app.packageName, developerName: app.developerName, permissions: app.permissions, review: app.review }; }) }));
    },
  });
  return sim;
}
