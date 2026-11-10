/**
 * Keeps simulators out of production. Nothing here imports the rest of tools/sim, so an adapter or config
 * module can import it on its own: pass each configurable service URL through refuseSimulatorUrl().
 */
import net from 'node:net';

const loopback = new net.BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

/** "Listen on every interface" addresses also reach this machine, so they count as simulator hosts too. */
const UNSPECIFIED = new Set(['0.0.0.0', '[::]']);

export class SimulatorRefusedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SimulatorRefusedError';
    this.code = 'ESIMREFUSED';
  }
}

const inProduction = (env) => String(env?.NODE_ENV ?? '').trim().toLowerCase() === 'production';

/** True for 127.0.0.0/8, ::1 (and IPv4-mapped loopback), localhost and *.localhost. */
export function isLoopbackHost(host) {
  const name = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const family = net.isIP(name);
  if (family) return loopback.check(name, family === 4 ? 'ipv4' : 'ipv6');
  return name === 'localhost' || name.endsWith('.localhost');
}

/** URL parsing normalises 127.1, 0x7f.0.0.1 and 2130706433 to 127.0.0.1. A value with no scheme is read as http. */
function parse(value) {
  try {
    const url = new URL(value);
    if (url.hostname) return url;
  } catch {
    // Not absolute: try it as host[:port][/path] below.
  }
  try {
    return new URL(`http://${value}`);
  } catch {
    return null;
  }
}

/** An http(s) URL on this machine: the only place a simulator may send webhooks and callbacks. */
export function isLoopbackUrl(value) {
  const url = parse(value);
  return Boolean(url && /^https?:$/.test(url.protocol) && isLoopbackHost(url.hostname));
}

/** Simulators only ever listen on this machine, so a local address or a control path means a simulator. */
export function isSimulatorUrl(value) {
  const url = parse(value);
  if (!url) return false;
  return isLoopbackHost(url.hostname) || UNSPECIFIED.has(url.hostname) || url.pathname === '/__sim' || url.pathname.startsWith('/__sim/');
}

/** Returns `value` unchanged, or throws when NODE_ENV=production and it points at a simulator. */
export function refuseSimulatorUrl(value, { env = process.env, name = 'This service URL' } = {}) {
  if (value && inProduction(env) && isSimulatorUrl(value)) {
    throw new SimulatorRefusedError(`${name} points at a simulator, which is refused when NODE_ENV=production.`);
  }
  return value;
}

/** Throws when NODE_ENV=production. Every simulator calls this before it listens. */
export function assertSimulatorsAllowed(env = process.env) {
  if (inProduction(env)) throw new SimulatorRefusedError('Simulators do not run when NODE_ENV=production.');
}
