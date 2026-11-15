/**
 * A generic secret manager, in the shape src/platform/secret-source.js's `http` driver speaks. No provider is chosen
 * (the platform is cloud-neutral); this stands in for any.
 *
 *   GET /<prefix>/<SETTING>     Authorization: Bearer <token>
 *     200 { value, version }    the newest version
 *     401                       a wrong or missing token
 *     404                       the setting is not held
 *
 * Controls (under /__sim), beside the shared ones in base.mjs (faults, calls, the clock):
 *   GET  /secrets                       every name with its newest version number and how many versions exist; never a value
 *   POST /secrets { name, value }       sets a secret: the first version, or a new one (a rotation)
 *   POST /rotate  { name, value }       the same, and refuses a name that is not held yet
 *   POST /delete  { name }              removes it: the next read answers 404
 *   POST /token   { token }             changes the token the manager accepts, so the app's token is now wrong
 *   POST /slow    { ms }                every read waits this long first (0 turns it off)
 *   POST /outage  { on }                every read answers 503 while on
 *
 * A fault from base.mjs does the rest: a timeout, a dropped connection, a malformed body.
 *
 *   const manager = createSecretsManager({ token: 'sim-secrets-token', prefix: 'v1/bhava', secrets: { DATA_KEY: '...' } });
 *   await manager.start();           // SECRETS_URL=manager.url  SECRETS_PATH_PREFIX=v1/bhava
 */
import { SimError, createSim } from '../base.mjs';

const refuse = (status, code, message) => new SimError(status, { error: { code, message } });
const NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

export function createSecretsManager({ token = 'sim-secrets-token', prefix = 'v1/bhava', secrets = {} } = {}) {
  const first = () => new Map(Object.entries(secrets).map(([name, value]) => [name, [String(value)]]));
  let held = first();
  let accepted = token;
  let slowMs = 0;
  let outage = false;
  const path = `/${String(prefix).replace(/^\/+|\/+$/g, '')}/:name`;

  const put = (name, value, { mustExist = false } = {}) => {
    if (!NAME.test(String(name ?? ''))) throw new SimError(400, { error: 'name must be a setting name.' });
    if (typeof value !== 'string' || !value) throw new SimError(400, { error: 'value must be a non-empty string.' });
    if (mustExist && !held.has(name)) throw new SimError(404, { error: 'That secret is not held.' });
    const versions = held.get(name) ?? [];
    versions.push(value);
    held.set(name, versions);
    return { name, version: versions.length };
  };

  return createSim({
    name: 'secrets',
    errorBody: ({ kind }) => ({ error: { code: kind, message: `Simulated ${kind}.` } }),
    reset: () => {
      held = first();
      accepted = token;
      slowMs = 0;
      outage = false;
    },
    routes: (on) => {
      on('GET', path, async (req) => {
        if (slowMs > 0) await new Promise((resolve) => setTimeout(resolve, slowMs));
        if (outage) throw refuse(503, 'unavailable', 'The secret manager is not available.');
        if (req.headers.authorization !== `Bearer ${accepted}`) throw refuse(401, 'unauthorized', 'The token is not valid.');
        const versions = held.get(req.params.name);
        if (!versions) throw refuse(404, 'not_found', 'That secret is not held.');
        return { value: versions[versions.length - 1], version: versions.length };
      });
    },
    controls: (on) => {
      on('GET', '/secrets', () => ({ secrets: [...held].map(([name, versions]) => ({ name, version: versions.length, versions: versions.length })) }));
      on('POST', '/secrets', ({ body }) => put(body?.name, body?.value));
      on('POST', '/rotate', ({ body }) => put(body?.name, body?.value, { mustExist: true }));
      on('POST', '/delete', ({ body }) => ({ name: body?.name, deleted: held.delete(body?.name) }));
      on('POST', '/token', ({ body }) => {
        if (typeof body?.token !== 'string' || !body.token) throw new SimError(400, { error: 'token is required.' });
        accepted = body.token;
        return { changed: true };
      });
      on('POST', '/slow', ({ body }) => {
        slowMs = Math.max(0, Math.min(60_000, Number(body?.ms) || 0));
        return { ms: slowMs };
      });
      on('POST', '/outage', ({ body }) => {
        outage = body?.on !== false;
        return { on: outage };
      });
    },
  });
}
