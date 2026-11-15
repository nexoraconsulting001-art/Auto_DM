import fs from 'node:fs';
import path from 'node:path';

/**
 * Where the settings marked secret in src/config.js (SECRET_SETTINGS) come from. SECRETS_DRIVER picks one:
 *
 *   env    the environment, as before (the default)
 *   file   SECRETS_DIR, a directory with one file per setting, named as the setting (DATA_KEY, APP_SECRET, ...). This is
 *          how Docker secrets, a Kubernetes Secret volume and every cloud's secret manager (through its CSI driver or
 *          agent) hand secrets to a container, so no cloud SDK is needed.
 *   http   a secret manager's HTTP API, read at start and again every SECRETS_REFRESH_SECONDS:
 *            GET <SECRETS_URL>/<SECRETS_PATH_PREFIX>/<SETTING>     Authorization: Bearer <the text of SECRETS_TOKEN_FILE>
 *            200 { "value": "...", "version": 3 }      404: the setting is not held there
 *          tools/sim/secrets speaks it. A manager with another shape sits behind its own agent, which writes files.
 *
 * Under every driver <SETTING>_FILE names a file holding that one setting and wins over everything else, and a setting
 * the driver does not hold falls back to the environment. A file's last line break is dropped.
 *
 * Nothing here logs, returns in an error or puts in a URL the value of a setting: an error names the setting only.
 *
 *   readLocalSecrets(names, env)                    -> { values, sources }        env, *_FILE and SECRETS_DIR; synchronous
 *   createSecretSource({ names, env, fetch, onAlert }) -> { driver, load(), start(onChange), stop(), state() }
 */
export const SECRET_DRIVERS = Object.freeze(['env', 'file', 'http']);

/** A failure to read a secret. `setting` is the name of the setting, when one is to blame; the value is never in it. */
export class SecretSourceError extends Error {
  constructor(message, { setting = null, code = 'secret_source' } = {}) {
    super(message);
    this.name = 'SecretSourceError';
    this.setting = setting;
    this.code = code;
  }
}

export function secretDriverOf(env = process.env) {
  const driver = String(env.SECRETS_DRIVER || 'env').trim().toLowerCase();
  if (!SECRET_DRIVERS.includes(driver)) throw new SecretSourceError(`Unknown SECRETS_DRIVER (use ${SECRET_DRIVERS.join(', ')})`, { setting: 'SECRETS_DRIVER', code: 'bad_driver' });
  return driver;
}

const trimEnd = (text) => String(text).replace(/\r?\n$/, '');

function readFileOf(setting, file, readFile) {
  try {
    return trimEnd(readFile(file, 'utf8'));
  } catch {
    // The path may itself be private, and the system's message quotes it: name the setting only.
    throw new SecretSourceError(`The file for ${setting} could not be read`, { setting, code: 'unreadable' });
  }
}

/**
 * Every secret that needs no network: { values: { NAME: text }, sources: { NAME: 'env' | 'file' } }. A name with no value
 * anywhere is left out. Throws SecretSourceError naming the setting when a file it was pointed at cannot be read.
 */
export function readLocalSecrets(names, env = process.env, { readFile = fs.readFileSync, exists = fs.existsSync } = {}) {
  const driver = secretDriverOf(env);
  const dir = driver === 'file' ? String(env.SECRETS_DIR || '') : '';
  if (driver === 'file' && !dir) throw new SecretSourceError('SECRETS_DRIVER is file, so SECRETS_DIR must name the directory', { setting: 'SECRETS_DIR', code: 'not_configured' });
  const values = {};
  const sources = {};
  for (const name of names) {
    const pointed = env[`${name}_FILE`];
    if (pointed) {
      values[name] = readFileOf(name, pointed, readFile);
      sources[name] = 'file';
    } else if (dir && exists(path.join(dir, name))) {
      values[name] = readFileOf(name, path.join(dir, name), readFile);
      sources[name] = 'file';
    } else if (env[name] !== undefined && env[name] !== '') {
      values[name] = String(env[name]);
      sources[name] = 'env';
    }
  }
  return { values, sources };
}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

function httpSettings(env) {
  const url = String(env.SECRETS_URL || '').replace(/\/+$/, '');
  if (!url) throw new SecretSourceError('SECRETS_DRIVER is http, so SECRETS_URL must be set', { setting: 'SECRETS_URL', code: 'not_configured' });
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new SecretSourceError('SECRETS_URL is not an address', { setting: 'SECRETS_URL', code: 'not_configured' });
  }
  const production = String(env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
  if (parsed.protocol !== 'https:' && (production || !LOOPBACK.test(parsed.hostname))) {
    throw new SecretSourceError('SECRETS_URL must be https', { setting: 'SECRETS_URL', code: 'not_configured' });
  }
  if (parsed.username || parsed.password || parsed.search) throw new SecretSourceError('SECRETS_URL must not carry a login or a query', { setting: 'SECRETS_URL', code: 'not_configured' });
  if (!env.SECRETS_TOKEN_FILE) throw new SecretSourceError('SECRETS_DRIVER is http, so SECRETS_TOKEN_FILE must name the token file', { setting: 'SECRETS_TOKEN_FILE', code: 'not_configured' });
  const prefix = String(env.SECRETS_PATH_PREFIX || '').replace(/^\/+|\/+$/g, '');
  if (prefix && !/^[\w./-]+$/.test(prefix)) throw new SecretSourceError('SECRETS_PATH_PREFIX may hold letters, digits, dots, dashes and slashes', { setting: 'SECRETS_PATH_PREFIX', code: 'not_configured' });
  return {
    base: prefix ? `${url}/${prefix}` : url,
    tokenFile: env.SECRETS_TOKEN_FILE,
    timeoutMs: Number(env.SECRETS_TIMEOUT_MS) > 0 ? Number(env.SECRETS_TIMEOUT_MS) : 5000,
    refreshSeconds: Number(env.SECRETS_REFRESH_SECONDS) > 0 ? Number(env.SECRETS_REFRESH_SECONDS) : 0,
  };
}

/**
 * The source for the process. `load()` answers { values, sources, versions } and throws SecretSourceError when the source
 * cannot be read (start is then refused). `start(onChange)` begins the refresh, when the driver has one: a refresh that
 * fails keeps the last good values and calls onAlert({ code, setting }); one that brings a change calls
 * onChange({ values, changed }) with the names that changed. `stop()` ends it. `state()` is for health and the checklist:
 * { driver, loadedAt, refreshedAt, failures, lastError } with no value in it.
 */
export function createSecretSource({ names, env = process.env, fetch: send = (...args) => globalThis.fetch(...args), onAlert = () => {}, readFile = fs.readFileSync, exists = fs.existsSync, now = () => Date.now() } = {}) {
  const driver = secretDriverOf(env);
  const status = { driver, loadedAt: null, refreshedAt: null, failures: 0, lastError: null };
  let last = null;
  let timer = null;

  async function fetchOne(http, token, name) {
    let response;
    try {
      response = await send(`${http.base}/${encodeURIComponent(name)}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(http.timeoutMs), redirect: 'error' });
    } catch {
      throw new SecretSourceError('The secret manager could not be reached', { setting: name, code: 'unreachable' });
    }
    if (response.status === 404) return null;
    if (response.status === 401 || response.status === 403) throw new SecretSourceError('The secret manager refused the token', { setting: 'SECRETS_TOKEN_FILE', code: 'unauthorized' });
    if (!response.ok) throw new SecretSourceError(`The secret manager answered ${response.status}`, { setting: name, code: 'unavailable' });
    let body;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!body || typeof body.value !== 'string') throw new SecretSourceError('The secret manager’s answer could not be read', { setting: name, code: 'invalid_answer' });
    return { value: body.value, version: body.version ?? null };
  }

  async function read() {
    const local = readLocalSecrets(names, env, { readFile, exists });
    if (driver !== 'http') return { ...local, versions: {} };
    const http = httpSettings(env);
    const token = readFileOf('SECRETS_TOKEN_FILE', http.tokenFile, readFile);
    const versions = {};
    // A setting with its own *_FILE is not asked for: the file wins.
    const wanted = names.filter((name) => local.sources[name] !== 'file');
    const found = await Promise.all(wanted.map((name) => fetchOne(http, token, name)));
    wanted.forEach((name, i) => {
      if (!found[i]) return;
      local.values[name] = found[i].value;
      local.sources[name] = 'http';
      versions[name] = found[i].version;
    });
    return { ...local, versions };
  }

  return {
    driver,
    async load() {
      last = await read();
      status.loadedAt = now();
      return last;
    },
    start(onChange = () => {}) {
      if (driver !== 'http' || timer) return;
      const { refreshSeconds } = httpSettings(env);
      if (!refreshSeconds) return;
      timer = setInterval(async () => {
        try {
          const next = await read();
          const changed = names.filter((name) => next.values[name] !== last?.values[name]);
          last = next;
          status.refreshedAt = now();
          status.lastError = null;
          if (changed.length) await onChange({ values: next.values, sources: next.sources, changed });
        } catch (err) {
          // The last good values stay in use.
          status.failures += 1;
          status.lastError = err?.code ?? 'secret_source';
          onAlert({ code: status.lastError, setting: err?.setting ?? null });
        }
      }, refreshSeconds * 1000);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    state: () => ({ ...status }),
  };
}
