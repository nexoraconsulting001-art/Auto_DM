/**
 * Push providers, both wire formats, so no test or local run reaches Google or Apple:
 *
 *   FCM HTTP v1 (what src/adapters/push/fcm.js calls), on sim.url, HTTP/1.1:
 *     POST /token                                  the OAuth exchange: a JWT signed by the service account -> an access token
 *     POST /v1/projects/:project/messages:send     { message: { token, notification, data, android } } -> { name }
 *   APNs (what src/adapters/push/apns.js calls), on sim.apnsUrl, HTTP/2 in the clear:
 *     POST /3/device/:token                        headers authorization (an ES256 provider token), apns-topic,
 *                                                  apns-push-type, apns-collapse-id, apns-expiration -> 200 with apns-id
 *
 * Point FCM_BASE_URL at sim.url and APNS_BASE_URL at sim.apnsUrl. sim.fcmCredentials() and sim.apnsCredentials() give
 * a service account and a .p8 key this simulator accepts: every start makes new ones, and nothing else is accepted, so
 * a wrong key, key id, team or topic is refused the way the real services refuse it.
 *
 * Controls (under /__sim on sim.url), beside the shared ones in base.mjs (the clock, calls, and faults on the FCM side):
 *   GET  /received                       every payload received on either wire, oldest first, refused ones included:
 *                                        { seq, wire, platform, token, title, body, data, collapseKey, ttl, topic, outcome, raw, at }
 *   POST /tokens { token, state }        state: unregistered | invalid | ok. What the provider says about one token from now on
 *   POST /behaviour { kind, wire?, token?, times?, delayMs?, retryAfter? }
 *        kind: throttle     429 with the provider's own error shape (retryAfter in seconds, optional)
 *              error        a 500
 *              hang         never answers
 *              junk         a body that is not what the provider sends (not JSON on FCM; no reason on APNs)
 *              slow         answers properly after delayMs (default 1500)
 *        wire: fcm | apns (default both); token: only for that token; times: how many sends it fires on (default 1), or "forever"
 *   GET  /behaviour                      what is still waiting to fire
 *   POST /credentials/rotate             new FCM and APNs keys: the old ones stop working
 *
 * Not in SERVICES (tools/sim/index.mjs): a test that pushes starts it itself, like tools/sim/email.
 */
import crypto from 'node:crypto';
import http2 from 'node:http2';
import { SimError, createSim, reply } from '../base.mjs';
import { isLoopbackHost } from '../guard.mjs';

const BEHAVIOURS = ['throttle', 'error', 'hang', 'junk', 'slow'];
const TOKEN_STATES = ['unregistered', 'invalid', 'ok'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());
const fcmError = (status, code, message) => new SimError(status, {
  error: { code: status, message, status: code === 'UNREGISTERED' ? 'NOT_FOUND' : code, details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: code }] },
});
const decodeJwt = (jwt) => {
  const [head, claims, signature] = String(jwt ?? '').split('.');
  try {
    return { head: JSON.parse(Buffer.from(head, 'base64url')), claims: JSON.parse(Buffer.from(claims, 'base64url')), signed: `${head}.${claims}`, signature: Buffer.from(signature ?? '', 'base64url') };
  } catch {
    return null;
  }
};

export function createPush({ project = 'sim-bhava-owner', topic = 'app.sim.bhava.business', keyId = 'SIMKEY1234', teamId = 'SIMTEAM123' } = {}) {
  let received = [];
  let tokens = new Map();
  let behaviours = [];
  let accessTokens = new Set();
  let seq = 0;
  let behaviourSeq = 0;
  let fcmKeys = null;
  let apnsKeys = null;
  let apnsServer = null;
  const hanging = new Set();

  function newCredentials() {
    fcmKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    apnsKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    accessTokens = new Set();
  }
  newCredentials();

  /** Claims a firing before any await, so racing sends each use up their own. */
  function takeBehaviour(wire, token) {
    for (const behaviour of behaviours) {
      if (behaviour.wire && behaviour.wire !== wire) continue;
      if (behaviour.token && behaviour.token !== token) continue;
      behaviour.fired++;
      if (behaviour.times !== 'forever' && behaviour.fired >= behaviour.times) behaviours = behaviours.filter((b) => b !== behaviour);
      return behaviour;
    }
    return null;
  }

  function record(entry) {
    const kept = { seq: ++seq, at: sim.clock.now(), outcome: 'accepted', ...entry };
    received.push(kept);
    return kept;
  }

  let sim = null;
  sim = createSim({
    name: 'push',
    errorBody: ({ status, kind }) => ({ error: { code: status, message: `Simulated ${kind}.`, status: kind === 'rate_limit' ? 'RESOURCE_EXHAUSTED' : 'UNAVAILABLE' } }),
    reset: () => {
      received = [];
      tokens = new Map();
      behaviours = [];
      seq = 0;
      behaviourSeq = 0;
    },
    routes: (on) => {
      on('POST', '/token', (req) => {
        const jwt = decodeJwt(req.body?.assertion);
        if (req.body?.grant_type !== 'urn:ietf:params:oauth:grant-type:jwt-bearer' || !jwt) throw new SimError(400, { error: 'invalid_request' });
        const now = Math.floor(Date.now() / 1000);
        const good = jwt.head.alg === 'RS256' && jwt.claims.iss === serviceAccountEmail() && jwt.claims.aud === `${sim.url}/token` && jwt.claims.exp > now
          && String(jwt.claims.scope ?? '').includes('firebase.messaging') && crypto.verify('RSA-SHA256', Buffer.from(jwt.signed), fcmKeys.publicKey, jwt.signature);
        if (!good) throw new SimError(400, { error: 'invalid_grant', error_description: 'Invalid JWT signature.' });
        const accessToken = `ya29.sim-${crypto.randomBytes(12).toString('hex')}`;
        accessTokens.add(accessToken);
        return { access_token: accessToken, expires_in: 3600, token_type: 'Bearer' };
      });

      on('POST', '/v1/projects/:project/:action', async (req) => {
        if (req.params.action !== 'messages:send') throw new SimError(404, { error: { code: 404, message: 'Not found.', status: 'NOT_FOUND' } });
        const message = req.body?.message ?? {};
        const entry = record({
          wire: 'fcm', platform: 'android', token: message.token ?? '', title: message.notification?.title ?? '', body: message.notification?.body ?? '',
          data: message.data ?? {}, collapseKey: message.android?.collapse_key ?? '', ttl: Number.parseInt(message.android?.ttl ?? '', 10) || 0, topic: req.params.project, raw: req.body ?? null,
        });
        const refuse = (outcome, error) => {
          entry.outcome = outcome;
          throw error;
        };
        const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
        if (!accessTokens.has(bearer)) refuse('unauthenticated', fcmError(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.'));
        if (req.params.project !== project) refuse('wrong_project', fcmError(403, 'SENDER_ID_MISMATCH', 'The sender is not allowed to send to this token.'));
        if (typeof message.token !== 'string' || !message.token || Object.values(message.data ?? {}).some((value) => typeof value !== 'string')) {
          refuse('invalid', fcmError(400, 'INVALID_ARGUMENT', 'The registration token is not valid, or data holds a value that is not a string.'));
        }
        const behaviour = takeBehaviour('fcm', message.token);
        if (behaviour) {
          entry.outcome = behaviour.kind;
          if (behaviour.kind === 'throttle') throw new SimError(429, fcmError(429, 'QUOTA_EXCEEDED', 'Sending quota exceeded.').body, behaviour.retryAfter !== undefined ? { 'retry-after': String(behaviour.retryAfter) } : {});
          if (behaviour.kind === 'error') throw fcmError(500, 'INTERNAL', 'Internal error.');
          if (behaviour.kind === 'hang') await new Promise(() => {});
          if (behaviour.kind === 'junk') return reply(200, '<html>Bad gateway</html>', { 'content-type': 'application/json; charset=UTF-8' });
          if (behaviour.kind === 'slow') {
            await sleep(behaviour.delayMs ?? 1500);
            entry.outcome = 'accepted';
          }
        }
        const state = tokens.get(message.token);
        if (state === 'unregistered') refuse('unregistered', fcmError(404, 'UNREGISTERED', 'Requested entity was not found.'));
        if (state === 'invalid') refuse('invalid', fcmError(400, 'INVALID_ARGUMENT', 'The registration token is not a valid FCM registration token.'));
        return { name: `projects/${project}/messages/sim${entry.seq}` };
      });
    },
    controls: (on) => {
      on('GET', '/received', () => ({ received }));
      on('POST', '/tokens', ({ body }) => {
        if (typeof body.token !== 'string' || !body.token || !TOKEN_STATES.includes(body.state)) throw new SimError(400, { error: `token, and state: ${TOKEN_STATES.join(', ')}.` });
        if (body.state === 'ok') tokens.delete(body.token);
        else tokens.set(body.token, body.state);
        return { token: body.token, state: body.state };
      });
      on('GET', '/behaviour', () => ({ behaviours }));
      on('POST', '/behaviour', ({ body }) => {
        if (!BEHAVIOURS.includes(body.kind)) throw new SimError(400, { error: `kind is one of ${BEHAVIOURS.join(', ')}.` });
        if (body.wire !== undefined && !['fcm', 'apns'].includes(body.wire)) throw new SimError(400, { error: 'wire is fcm or apns.' });
        if (body.times !== undefined && body.times !== 'forever' && !(Number.isInteger(body.times) && body.times > 0)) throw new SimError(400, { error: 'times is a positive whole number or "forever".' });
        const behaviour = { id: `b${++behaviourSeq}`, kind: body.kind, wire: body.wire ?? null, token: body.token ?? null, times: body.times ?? 1, delayMs: body.delayMs, retryAfter: body.retryAfter, fired: 0 };
        behaviours.push(behaviour);
        return behaviour;
      });
      on('POST', '/credentials/rotate', () => {
        newCredentials();
        return { ok: true };
      });
    },
  });

  const serviceAccountEmail = () => `firebase-adminsdk@${project}.iam.gserviceaccount.com`;

  // ---- APNs: HTTP/2, the same token states and behaviours ----

  function apnsProblem(headers) {
    const jwt = decodeJwt(String(headers.authorization ?? '').replace(/^bearer /i, ''));
    if (!jwt) return [403, 'MissingProviderToken'];
    const age = Math.floor(Date.now() / 1000) - Number(jwt.claims.iat);
    let signed = false;
    try {
      signed = crypto.verify('sha256', Buffer.from(jwt.signed), { key: apnsKeys.publicKey, dsaEncoding: 'ieee-p1363' }, jwt.signature);
    } catch {
      signed = false;
    }
    if (jwt.head.alg !== 'ES256' || jwt.head.kid !== keyId || jwt.claims.iss !== teamId || !signed) return [403, 'InvalidProviderToken'];
    if (!(age >= -60 && age <= 3600)) return [403, 'ExpiredProviderToken'];
    if (!headers['apns-topic']) return [400, 'MissingTopic'];
    if (headers['apns-topic'] !== topic) return [400, 'DeviceTokenNotForTopic'];
    if (headers['apns-push-type'] !== 'alert') return [400, 'InvalidPushType'];
    return null;
  }

  function onApnsStream(stream, headers) {
    const chunks = [];
    stream.on('error', () => {});
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', async () => {
      const answer = (status, body, extra = {}) => {
        if (stream.destroyed || stream.closed) return;
        stream.respond({ ':status': status, 'apns-id': crypto.randomUUID(), ...(body ? { 'content-type': 'application/json' } : {}), ...extra });
        stream.end(body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined);
      };
      const path = String(headers[':path'] ?? '');
      const match = /^\/3\/device\/([^/?]+)$/.exec(path);
      if (headers[':method'] !== 'POST' || !match) return answer(404, { reason: 'BadPath' });
      if (!isLoopbackHost(String(headers[':authority'] ?? '').replace(/:\d+$/, ''))) return answer(403, { reason: 'Forbidden' });
      const token = decodeURIComponent(match[1]);
      let payload = null;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        payload = null;
      }
      const { aps, ...data } = payload ?? {};
      const expiration = Number(headers['apns-expiration']) || 0;
      const entry = record({
        wire: 'apns', platform: 'ios', token, title: aps?.alert?.title ?? '', body: aps?.alert?.body ?? '', data, collapseKey: String(headers['apns-collapse-id'] ?? ''),
        ttl: expiration ? Math.max(0, expiration - Math.floor(Date.now() / 1000)) : 0, topic: String(headers['apns-topic'] ?? ''), raw: payload,
        headers: Object.fromEntries(Object.entries(headers).filter(([name]) => name.startsWith('apns-'))),
      });
      const refuse = (outcome, status, reason, extra) => {
        entry.outcome = outcome;
        answer(status, { reason }, extra);
      };
      const problem = apnsProblem(headers);
      if (problem) return refuse(problem[1], problem[0], problem[1]);
      if (!payload || typeof aps !== 'object') return refuse('invalid', 400, 'PayloadEmpty');
      const behaviour = takeBehaviour('apns', token);
      if (behaviour) {
        entry.outcome = behaviour.kind;
        if (behaviour.kind === 'throttle') return answer(429, { reason: 'TooManyRequests' }, behaviour.retryAfter !== undefined ? { 'retry-after': String(behaviour.retryAfter) } : {});
        if (behaviour.kind === 'error') return answer(500, { reason: 'InternalServerError' });
        if (behaviour.kind === 'hang') return void hanging.add(stream);
        if (behaviour.kind === 'junk') return answer(502, '<html>Bad gateway</html>');
        if (behaviour.kind === 'slow') {
          await sleep(behaviour.delayMs ?? 1500);
          entry.outcome = 'accepted';
        }
      }
      const state = tokens.get(token);
      if (state === 'unregistered') return refuse('unregistered', 410, 'Unregistered');
      if (state === 'invalid') return refuse('invalid', 400, 'BadDeviceToken');
      answer(200);
    });
  }

  const start = sim.start;
  const close = sim.close;
  return Object.assign(sim, {
    apnsUrl: null,
    apnsPort: null,
    project,
    topic,
    /** Starts both listeners on 127.0.0.1: FCM on `port`, APNs on `apnsPort` (or any free one). */
    async start({ port = 0, apnsPort = 0, env = process.env } = {}) {
      await start({ port, env });
      const server = http2.createServer();
      server.on('stream', onApnsStream);
      server.on('sessionError', () => {});
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(apnsPort, '127.0.0.1', resolve);
      });
      const sessions = new Set();
      server.on('session', (session) => {
        sessions.add(session);
        session.on('close', () => sessions.delete(session));
      });
      apnsServer = { server, sessions };
      sim.apnsPort = server.address().port;
      sim.apnsUrl = `http://127.0.0.1:${sim.apnsPort}`;
      return sim;
    },
    async close() {
      if (apnsServer) {
        const { server, sessions } = apnsServer;
        apnsServer = null;
        hanging.clear();
        const closing = new Promise((resolve) => server.close(resolve));
        for (const session of sessions) session.destroy();
        await closing;
      }
      await close();
    },
    /** A service account this simulator accepts, as FCM_SERVICE_ACCOUNT takes it, and the project to send to. */
    fcmCredentials: () => ({
      projectId: project,
      serviceAccount: JSON.stringify({ type: 'service_account', project_id: project, client_email: serviceAccountEmail(), private_key: fcmKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: `${sim.url}/token` }),
    }),
    /** The .p8 key, key id, team and topic this simulator accepts. */
    apnsCredentials: () => ({ keyId, teamId, topic, key: apnsKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }) }),
    /** Every payload received, refused ones included. */
    received: async () => (await sim.get('/received')).received,
  });
}
