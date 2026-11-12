/**
 * EAS as src/adapters/eas speaks to it: cloud builds, store submits and over-the-air updates on a channel. Point EAS_BASE_URL at
 * this server and EXPO_TOKEN at the token it was made with. Every state change follows the simulator's clock (/__sim/clock).
 *
 * API (Authorization: Bearer <token>; a wrong one is 401; Idempotency-Key on POST: the same key answers the same build,
 * submission or update):
 *   POST  /v1/builds { platform, profile, channel, appVersion, buildNumber, runtimeVersion, brandFile } -> { id, status: 'queued' }
 *   GET   /v1/builds/:id            -> { id, platform, status, fingerprint, artifactUrl, error }   queued for 5 s, then building
 *                                      for buildMs (60 s unless a behaviour says), then built (or failed)
 *   GET   /v1/builds/:id/artifact   a small generated file, once built
 *   POST  /v1/submissions { buildId, platform, track, credentials } -> { id, status: 'queued' }   queued 2 s, in_progress to 10 s,
 *                                      then finished (or errored)
 *   GET   /v1/submissions/:id       -> { id, status, error }
 *   POST  /v1/channels/:channel/updates { runtimeVersion, bundleId, message } -> { id, rollout: 10 }
 *   PATCH /v1/channels/:channel/updates/:id { rollout: 10 | 50 | 100 } -> { id, rollout }
 *   POST  /v1/channels/:channel/updates/:id/roll-back -> { rolledBack: true }
 *
 * Controls (under /__sim), beside the shared ones in base.mjs (faults: timeout, malformed for junk, server_error, ...; calls; clock):
 *   POST /builds/behaviour { kind: 'slow' | 'fail', platform?, step?, message?, buildMs?, times? }   the next matching builds
 *        are slow (buildMs, default 10 minutes) or fail at `step` (default 'build') with `message`; times defaults to 1
 *   POST /submissions/behaviour { kind: 'fail', message?, times? }
 *   POST /fingerprints { runtimeVersion, fingerprint }   the native fingerprint builds on that runtime report
 *   GET  /builds, GET /submissions, GET /updates         what it holds (credentials are never echoed)
 *   GET  /channels/:channel/resolve?runtimeVersion=&seed=   -> { updateId }: the update a device on that runtime gets, or null.
 *        A device gets the newest update of its runtime that is not rolled back and whose rollout covers its seed (0 to 99).
 *
 * Not in SERVICES (tools/sim/index.mjs): a test that needs it starts it itself, like tools/sim/push.
 */
import crypto from 'node:crypto';
import { SimError, createSim, reply } from '../base.mjs';

const QUEUE_MS = 5_000;
const BUILD_MS = 60_000;
const SLOW_MS = 10 * 60_000;
const SUBMIT_QUEUE_MS = 2_000;
const SUBMIT_MS = 10_000;
const ROLLOUTS = [10, 50, 100];

const bad = (message) => new SimError(400, { errors: [{ code: 'BAD_REQUEST', message }] });

export function createEas({ token = 'sim-expo-token' } = {}) {
  let seq = 0;
  let builds = new Map();
  let submissions = new Map();
  let updates = new Map();
  let keys = new Map();
  let fingerprints = new Map();
  let buildBehaviours = [];
  let submissionBehaviours = [];

  const now = () => sim.clock.now();
  const nextId = (prefix) => `${prefix}-${String(++seq).padStart(6, '0')}`;
  const authorize = (headers) => {
    if (headers.authorization !== `Bearer ${token}`) throw new SimError(401, { errors: [{ code: 'UNAUTHORIZED', message: 'Unknown access token.' }] });
  };
  const once = (key, make) => {
    if (!key) return make();
    if (!keys.has(key)) keys.set(key, make());
    return keys.get(key);
  };
  const fingerprintFor = (runtimeVersion) => fingerprints.get(runtimeVersion) ?? `fp${crypto.createHash('sha256').update(`native:${runtimeVersion}`).digest('hex').slice(0, 30)}`;
  const take = (list, matches) => {
    const found = list.find((b) => (b.times === 'forever' || b.times > 0) && matches(b));
    if (!found) return null;
    if (found.times !== 'forever') found.times -= 1;
    return found;
  };

  function buildStatus(build) {
    const age = now() - build.createdAt;
    if (age < QUEUE_MS) return 'queued';
    if (age < QUEUE_MS + build.buildMs) return 'building';
    return build.fail ? 'failed' : 'built';
  }
  function describeBuild(build) {
    const status = buildStatus(build);
    return {
      id: build.id, platform: build.platform, status, fingerprint: status === 'built' ? build.fingerprint : '',
      artifactUrl: status === 'built' ? `${sim.url}/v1/builds/${build.id}/artifact` : null,
      error: status === 'failed' ? { step: build.fail.step, message: build.fail.message } : null,
    };
  }
  function submissionStatus(submission) {
    const age = now() - submission.createdAt;
    if (age < SUBMIT_QUEUE_MS) return 'queued';
    if (age < SUBMIT_MS) return 'in_progress';
    return submission.fail ? 'errored' : 'finished';
  }
  const describeSubmission = (s) => {
    const status = submissionStatus(s);
    return { id: s.id, buildId: s.buildId, platform: s.platform, status, error: status === 'errored' ? s.fail : null };
  };
  const describeUpdate = (u) => ({ id: u.id, channel: u.channel, runtimeVersion: u.runtimeVersion, bundleId: u.bundleId, rollout: u.rollout, rolledBack: u.rolledBack });
  const updateOf = (channel, id) => {
    const update = updates.get(id);
    if (!update || update.channel !== channel) throw new SimError(404, { errors: [{ code: 'NOT_FOUND', message: 'No such update.' }] });
    return update;
  };
  /** 0 to 99 for a device seed: a number is used as it is, anything else is hashed. */
  const bucketOf = (seed) => (/^\d+$/.test(String(seed)) ? Number(seed) % 100 : crypto.createHash('sha256').update(String(seed)).digest().readUInt16BE(0) % 100);

  const sim = createSim({
    name: 'eas',
    errorBody: ({ kind }) => ({ errors: [{ code: kind, message: `Simulated ${kind}.` }] }),
    reset() {
      seq = 0;
      builds = new Map();
      submissions = new Map();
      updates = new Map();
      keys = new Map();
      fingerprints = new Map();
      buildBehaviours = [];
      submissionBehaviours = [];
    },
    routes: (on) => {
      on('POST', '/v1/builds', ({ headers, body = {} }) => {
        authorize(headers);
        if (!['android', 'ios'].includes(body.platform)) throw bad('platform must be android or ios.');
        for (const field of ['appVersion', 'runtimeVersion', 'channel']) if (typeof body[field] !== 'string' || !body[field]) throw bad(`${field} is required.`);
        if (!Number.isInteger(body.buildNumber) || body.buildNumber < 1) throw bad('buildNumber is required.');
        if (!body.brandFile || typeof body.brandFile !== 'object') throw bad('brandFile is required.');
        const build = once(`build:${headers['idempotency-key'] ?? ''}`, () => {
          const behaviour = take(buildBehaviours, (b) => !b.platform || b.platform === body.platform);
          const made = {
            id: nextId('build'), platform: body.platform, channel: body.channel, appVersion: body.appVersion, buildNumber: body.buildNumber,
            runtimeVersion: body.runtimeVersion, createdAt: now(), fingerprint: fingerprintFor(body.runtimeVersion),
            buildMs: behaviour?.buildMs ?? (behaviour?.kind === 'slow' ? SLOW_MS : BUILD_MS),
            fail: behaviour?.kind === 'fail' ? { step: behaviour.step ?? 'build', message: behaviour.message ?? 'The build failed.' } : null,
          };
          builds.set(made.id, made);
          return made;
        });
        return { id: build.id, status: buildStatus(build) };
      });
      on('GET', '/v1/builds/:id', ({ headers, params }) => {
        authorize(headers);
        const build = builds.get(params.id);
        if (!build) throw new SimError(404, { errors: [{ code: 'NOT_FOUND', message: 'No such build.' }] });
        return describeBuild(build);
      });
      on('GET', '/v1/builds/:id/artifact', ({ headers, params }) => {
        authorize(headers);
        const build = builds.get(params.id);
        if (!build || buildStatus(build) !== 'built') throw new SimError(404, { errors: [{ code: 'NOT_FOUND', message: 'No artifact.' }] });
        return reply(200, Buffer.from(`SIM-ARTIFACT ${build.id} ${build.platform} ${build.appVersion} (${build.buildNumber})\n`), { 'content-type': 'application/octet-stream' });
      });
      on('POST', '/v1/submissions', ({ headers, body = {} }) => {
        authorize(headers);
        const build = builds.get(body.buildId);
        if (!build || buildStatus(build) !== 'built') throw bad('buildId must name a finished build.');
        if (body.platform !== build.platform) throw bad('platform must be the build\'s.');
        if (!body.credentials || typeof body.credentials !== 'object') throw bad('credentials are required.');
        const submission = once(`submission:${headers['idempotency-key'] ?? ''}`, () => {
          const behaviour = take(submissionBehaviours, () => true);
          const made = { id: nextId('submission'), buildId: build.id, platform: build.platform, track: body.track ?? 'production', createdAt: now(), fail: behaviour ? behaviour.message ?? 'The store refused the upload.' : null };
          submissions.set(made.id, made);
          return made;
        });
        return { id: submission.id, status: submissionStatus(submission) };
      });
      on('GET', '/v1/submissions/:id', ({ headers, params }) => {
        authorize(headers);
        const submission = submissions.get(params.id);
        if (!submission) throw new SimError(404, { errors: [{ code: 'NOT_FOUND', message: 'No such submission.' }] });
        return describeSubmission(submission);
      });
      on('POST', '/v1/channels/:channel/updates', ({ headers, params, body = {} }) => {
        authorize(headers);
        if (typeof body.runtimeVersion !== 'string' || !body.runtimeVersion) throw bad('runtimeVersion is required.');
        if (typeof body.bundleId !== 'string' || !body.bundleId) throw bad('bundleId is required.');
        const update = once(`update:${params.channel}:${headers['idempotency-key'] ?? ''}`, () => {
          const made = { id: nextId('update'), channel: params.channel, runtimeVersion: body.runtimeVersion, bundleId: body.bundleId, message: String(body.message ?? ''), rollout: 10, rolledBack: false, order: seq, createdAt: now() };
          updates.set(made.id, made);
          return made;
        });
        return { id: update.id, rollout: update.rollout };
      });
      on('PATCH', '/v1/channels/:channel/updates/:id', ({ headers, params, body = {} }) => {
        authorize(headers);
        const update = updateOf(params.channel, params.id);
        if (!ROLLOUTS.includes(body.rollout)) throw bad('rollout must be 10, 50 or 100.');
        if (update.rolledBack) throw new SimError(409, { errors: [{ code: 'CONFLICT', message: 'This update was rolled back.' }] });
        update.rollout = body.rollout;
        return { id: update.id, rollout: update.rollout };
      });
      on('POST', '/v1/channels/:channel/updates/:id/roll-back', ({ headers, params }) => {
        authorize(headers);
        const update = updateOf(params.channel, params.id);
        update.rolledBack = true;
        return { rolledBack: true };
      });
    },
    controls: (on) => {
      on('POST', '/builds/behaviour', ({ body = {} }) => {
        if (!['slow', 'fail'].includes(body.kind)) throw new SimError(400, { error: 'kind must be slow or fail.' });
        const times = body.times ?? 1;
        if (times !== 'forever' && !(Number.isInteger(times) && times >= 1)) throw new SimError(400, { error: 'times must be a whole number from 1, or "forever".' });
        buildBehaviours.push({ kind: body.kind, platform: body.platform, step: body.step, message: body.message, buildMs: body.buildMs, times });
        return { ok: true };
      });
      on('POST', '/submissions/behaviour', ({ body = {} }) => {
        if (body.kind !== 'fail') throw new SimError(400, { error: 'kind must be fail.' });
        submissionBehaviours.push({ kind: 'fail', message: body.message, times: body.times ?? 1 });
        return { ok: true };
      });
      on('POST', '/fingerprints', ({ body = {} }) => {
        if (typeof body.runtimeVersion !== 'string' || typeof body.fingerprint !== 'string') throw new SimError(400, { error: 'runtimeVersion and fingerprint are required.' });
        fingerprints.set(body.runtimeVersion, body.fingerprint);
        return { ok: true };
      });
      on('GET', '/builds', () => ({ builds: [...builds.values()].map(describeBuild) }));
      on('GET', '/submissions', () => ({ submissions: [...submissions.values()].map(describeSubmission) }));
      on('GET', '/updates', () => ({ updates: [...updates.values()].map(describeUpdate) }));
      on('GET', '/channels/:channel/resolve', ({ params, query }) => {
        const bucket = bucketOf(query.seed ?? '0');
        const candidates = [...updates.values()]
          .filter((u) => u.channel === params.channel && u.runtimeVersion === query.runtimeVersion && !u.rolledBack)
          .sort((a, b) => b.order - a.order);
        const hit = candidates.find((u) => bucket < u.rollout);
        return { updateId: hit?.id ?? null };
      });
    },
  });
  sim.fingerprintFor = fingerprintFor;
  return sim;
}
