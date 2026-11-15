/**
 * What the readiness checks may talk to, and what they may print (PRD 11; G-10 to G-12).
 *
 *   assertLocalServices(env)   throws CheckRefused unless every service address names this machine, or a CI service
 *   makeScrub(env, extra)      a function that removes every address, password and key of this run from text
 *
 * A refusal names the setting, never its value. Nothing here connects anywhere.
 */
import net from 'node:net';

export class CheckRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'CheckRefused';
    this.code = 'refused';
  }
}

/** The settings that hold an address a check connects to. */
export const ADDRESS_SETTINGS = Object.freeze(['TEST_DATABASE_URL', 'REDIS_URL', 'CLICKHOUSE_URL', 'S3_ENDPOINT', 'BACKUP_S3_ENDPOINT']);
/** The settings that hold a credential or a key. Their values never appear in output. */
export const SECRET_SETTINGS = Object.freeze(['TEST_DATABASE_URL', 'REDIS_URL', 'CLICKHOUSE_URL', 'S3_SECRET_ACCESS_KEY', 'S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY', 'BACKUP_S3_ACCESS_KEY_ID', 'DATABASE_URL', 'DATABASE_OWNER_URL', 'DATA_KEY', 'SESSION_SECRET', 'APP_SECRET']);

/** The names a CI job's service containers have on the job's network, when the job runs in a container. */
const CI_SERVICE_NAMES = Object.freeze(['postgres', 'redis', 'clickhouse', 'minio']);

export const inCi = (env) => String(env.GITHUB_ACTIONS ?? '').toLowerCase() === 'true';

const loopback = new net.BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

/** True for 127.0.0.0/8, ::1, localhost and *.localhost. */
export function isLoopback(host) {
  const name = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const family = net.isIP(name);
  if (family) return loopback.check(name, family === 4 ? 'ipv4' : 'ipv6');
  return name === 'localhost' || name.endsWith('.localhost');
}

/** Whether `host` is this machine, or (in CI) one of the job's service containers. */
export const isAllowedHost = (host, env = process.env) => isLoopback(host) || (inCi(env) && CI_SERVICE_NAMES.includes(String(host).toLowerCase()));

const hostOf = (value) => {
  try {
    return new URL(String(value)).hostname;
  } catch {
    return null;
  }
};

/** Throws CheckRefused naming the first setting whose address is not on this machine or a CI service. */
export function assertLocalServices(env = process.env, names = ADDRESS_SETTINGS) {
  for (const name of names) {
    const value = env[name];
    if (!value) continue;
    const host = hostOf(value);
    if (host === null) throw new CheckRefused(`${name} is not a web or database address, so it is refused: these checks only run against services on this machine or a CI service.`);
    if (!isAllowedHost(host, env)) throw new CheckRefused(`${name} is not on this machine or a CI service, so it is refused: these checks only run against local services and never touch a live one.`);
  }
}

/** Passwords and user names inside the addresses, and the values of the secret settings, collected for scrubbing. */
export function secretValues(env = process.env, extra = []) {
  const out = new Set();
  const add = (v) => {
    const s = String(v ?? '');
    if (s.length >= 4) out.add(s);
  };
  for (const name of SECRET_SETTINGS) add(env[name]);
  for (const name of ADDRESS_SETTINGS) {
    try {
      const u = new URL(env[name]);
      add(decodeURIComponent(u.password));
      add(u.password);
      add(decodeURIComponent(u.username));
    } catch {
      // not an address
    }
  }
  for (const v of extra) add(v);
  return [...out].sort((a, b) => b.length - a.length);
}

/** A function that takes text and answers it with no address, password or key of this run in it. */
export function makeScrub(env = process.env, extra = []) {
  const secrets = secretValues(env, extra);
  const urls = [...new Set(ADDRESS_SETTINGS.map((n) => env[n]).filter(Boolean))];
  return (text) => {
    let out = String(text ?? '');
    for (const url of urls) out = out.split(url).join('<address>');
    for (const secret of secrets) out = out.split(secret).join('***');
    return out.replace(/\b(postgres(?:ql)?|rediss?|https?):\/\/[^\s'"@/]*:[^\s'"@/]*@[^\s'"]+/gi, '$1://***');
  };
}
