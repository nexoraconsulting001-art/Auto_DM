import { Readable } from 'node:stream';
import { DEFAULT_TIMEOUT_MS, ProviderError, createHttp, providerUrl } from '../http.js';

/**
 * EAS (Expo Application Services) for the branded shopper apps (PRD 10.8, 10.10): cloud builds, store submits, and
 * over-the-air updates on a channel per brand ('t<tenantId>'). ctx.eas, in the app and the worker.
 *
 *   configured                                                            EXPO_TOKEN is set; without it every call throws
 *                                                                         ProviderError kind 'not_configured', delivery 'none'
 *   startBuild({ platform, profile, channel, appVersion, buildNumber, runtimeVersion, brandFile, idempotencyKey }) -> { buildId, status: 'queued' }
 *   getBuild(buildId)              -> { buildId, status: 'queued' | 'building' | 'built' | 'failed', fingerprint, artifactUrl, error: { step, message } | null }
 *   fetchArtifact(buildId)         -> { stream, mime, bytes }   from artifactUrl, on the same origin only; refused over 300 MB
 *   submit({ buildId, platform, track, credentials, idempotencyKey })   -> { submissionId, status }
 *   getSubmission(submissionId)    -> { submissionId, status: 'queued' | 'in_progress' | 'finished' | 'errored', error }
 *   publishUpdate({ channel, runtimeVersion, bundleId, message, idempotencyKey }) -> { updateId }   (a new update starts at 10%)
 *   setRollout({ channel, updateId, percent })                          -> { percent }   10, 50 or 100
 *   rollBack({ channel, updateId, idempotencyKey })                     -> { rolledBack: true }
 *
 * The wire format (what tools/sim/eas serves): POST /v1/builds, GET /v1/builds/:id, GET /v1/builds/:id/artifact,
 * POST /v1/submissions, GET /v1/submissions/:id, POST /v1/channels/:channel/updates, PATCH /v1/channels/:channel/updates/:id
 * ({ rollout }), POST /v1/channels/:channel/updates/:id/roll-back. Authorization: Bearer <EXPO_TOKEN>; Idempotency-Key on every
 * POST, and a POST is repeated only with its key. The real service is driven by its CLI and GraphQL API: binding this interface
 * to it is not done and not verified (Phase 6 contract, open points). Nothing in Phase 6 calls the real service.
 *
 * EAS_BASE_URL points it at the simulator, which is refused when NODE_ENV=production; any other host throws at start. 10 s
 * timeout, no redirect. `credentials` go in the body of submit only and are never kept here. Nothing here logs a token, a key,
 * a credential or a name.
 */
export const EAS_ORIGIN = 'https://api.expo.dev';
export const EAS_BUILD_STATUSES = Object.freeze(['queued', 'building', 'built', 'failed']);
export const EAS_SUBMISSION_STATUSES = Object.freeze(['queued', 'in_progress', 'finished', 'errored']);
export const MAX_ARTIFACT_BYTES = 300 * 1024 * 1024;

const CHANNEL = /^[A-Za-z0-9_-]{1,64}$/;
const KEY = /^[A-Za-z0-9_-]{8,120}$/;
const PROVIDER = 'eas';
const malformed = () => new ProviderError({ provider: PROVIDER, kind: 'malformed', delivery: 'unknown' });
const seg = (value) => encodeURIComponent(String(value));

function need(condition, message) {
  if (!condition) throw new TypeError(message);
}

export function createEas(config = {}, { env = process.env } = {}) {
  const baseUrl = providerUrl({ value: config.easBaseUrl, real: EAS_ORIGIN, name: 'EAS_BASE_URL', env });
  const token = String(config.expoToken ?? '');
  const timeoutMs = config.providerTimeoutMs || DEFAULT_TIMEOUT_MS;
  const request = createHttp({ provider: PROVIDER, baseUrl, timeoutMs, codeOf: (body) => body?.errors?.[0]?.code ?? body?.error?.code ?? '' });

  async function call(method, path, { json, idempotencyKey, retries = 0 } = {}) {
    if (!token) throw new ProviderError({ provider: PROVIDER, kind: 'not_configured', delivery: 'none' });
    const headers = { authorization: `Bearer ${token}`, ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) };
    const { body } = await request(method, path, { headers, json, retries });
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw malformed();
    return body;
  }

  const buildOf = (body) => {
    if (typeof body.id !== 'string' || !EAS_BUILD_STATUSES.includes(body.status)) throw malformed();
    return {
      buildId: body.id,
      status: body.status,
      fingerprint: typeof body.fingerprint === 'string' ? body.fingerprint : '',
      artifactUrl: typeof body.artifactUrl === 'string' && body.artifactUrl ? body.artifactUrl : null,
      error: body.error && typeof body.error === 'object' ? { step: String(body.error.step ?? 'build'), message: String(body.error.message ?? '').slice(0, 500) } : null,
    };
  };

  return {
    get configured() {
      return Boolean(token);
    },

    async startBuild({ platform, profile = 'production', channel, appVersion, buildNumber, runtimeVersion, brandFile, idempotencyKey }) {
      need(['android', 'ios'].includes(platform), 'startBuild needs a platform');
      need(CHANNEL.test(String(channel)), 'startBuild needs a channel');
      need(KEY.test(String(idempotencyKey)), 'startBuild needs an idempotency key');
      const body = await call('POST', '/v1/builds', { json: { platform, profile, channel, appVersion, buildNumber, runtimeVersion, brandFile }, idempotencyKey, retries: 2 });
      if (typeof body.id !== 'string') throw malformed();
      return { buildId: body.id, status: 'queued' };
    },

    async getBuild(buildId) {
      return buildOf(await call('GET', `/v1/builds/${seg(buildId)}`, { retries: 2 }));
    },

    async fetchArtifact(buildId) {
      const build = await this.getBuild(buildId);
      if (build.status !== 'built' || !build.artifactUrl) throw new ProviderError({ provider: PROVIDER, kind: 'rejected', code: 'not_built', delivery: 'none' });
      let url;
      try {
        url = new URL(build.artifactUrl);
      } catch {
        throw malformed();
      }
      if (url.origin !== new URL(baseUrl).origin) throw new ProviderError({ provider: PROVIDER, kind: 'rejected', code: 'foreign_artifact', delivery: 'none' });
      let res;
      try {
        res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        throw new ProviderError({ provider: PROVIDER, kind: err?.name === 'TimeoutError' ? 'timeout' : 'network', delivery: 'none' });
      }
      if (!res.ok || !res.body) throw new ProviderError({ provider: PROVIDER, kind: res.status >= 500 ? 'server' : 'rejected', status: res.status, delivery: 'none' });
      const bytes = Number(res.headers.get('content-length')) || 0;
      if (bytes > MAX_ARTIFACT_BYTES) {
        await res.body.cancel().catch(() => {});
        throw new ProviderError({ provider: PROVIDER, kind: 'rejected', code: 'too_large', delivery: 'none' });
      }
      let seen = 0;
      const limited = Readable.fromWeb(res.body).map((chunk) => {
        seen += chunk.length;
        if (seen > MAX_ARTIFACT_BYTES) throw new ProviderError({ provider: PROVIDER, kind: 'rejected', code: 'too_large', delivery: 'none' });
        return chunk;
      });
      return { stream: limited, mime: (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim(), bytes };
    },

    async submit({ buildId, platform, track = 'production', credentials, idempotencyKey }) {
      need(['android', 'ios'].includes(platform), 'submit needs a platform');
      need(KEY.test(String(idempotencyKey)), 'submit needs an idempotency key');
      const body = await call('POST', '/v1/submissions', { json: { buildId, platform, track, credentials }, idempotencyKey, retries: 2 });
      if (typeof body.id !== 'string' || !EAS_SUBMISSION_STATUSES.includes(body.status)) throw malformed();
      return { submissionId: body.id, status: body.status };
    },

    async getSubmission(submissionId) {
      const body = await call('GET', `/v1/submissions/${seg(submissionId)}`, { retries: 2 });
      if (typeof body.id !== 'string' || !EAS_SUBMISSION_STATUSES.includes(body.status)) throw malformed();
      return { submissionId: body.id, status: body.status, error: body.error ? String(body.error).slice(0, 500) : null };
    },

    async publishUpdate({ channel, runtimeVersion, bundleId, message = '', idempotencyKey }) {
      need(CHANNEL.test(String(channel)), 'publishUpdate needs a channel');
      need(KEY.test(String(idempotencyKey)), 'publishUpdate needs an idempotency key');
      const body = await call('POST', `/v1/channels/${seg(channel)}/updates`, { json: { runtimeVersion, bundleId, message }, idempotencyKey, retries: 2 });
      if (typeof body.id !== 'string') throw malformed();
      return { updateId: body.id };
    },

    async setRollout({ channel, updateId, percent }) {
      need(CHANNEL.test(String(channel)), 'setRollout needs a channel');
      need([10, 50, 100].includes(percent), 'Rollout is 10, 50 or 100');
      // Setting a value is safe to repeat.
      const body = await call('PATCH', `/v1/channels/${seg(channel)}/updates/${seg(updateId)}`, { json: { rollout: percent }, retries: 2 });
      if (![10, 50, 100].includes(body.rollout)) throw malformed();
      return { percent: body.rollout };
    },

    async rollBack({ channel, updateId, idempotencyKey }) {
      need(CHANNEL.test(String(channel)), 'rollBack needs a channel');
      need(KEY.test(String(idempotencyKey)), 'rollBack needs an idempotency key');
      const body = await call('POST', `/v1/channels/${seg(channel)}/updates/${seg(updateId)}/roll-back`, { idempotencyKey, retries: 2 });
      if (body.rolledBack !== true) throw malformed();
      return { rolledBack: true };
    },
  };
}
