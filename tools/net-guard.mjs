/**
 * Keeps tests off the real internet. Load it before anything else: `node --import ./tools/net-guard.mjs`.
 * Every outgoing TCP, TLS, UDP or DNS request (net, tls, http, https, fetch, pg, ioredis, the AWS SDK)
 * is refused with code ENETGUARD unless it stays on this machine. Unix sockets and named pipes are local,
 * so they pass. Node child processes inherit the guard through NODE_OPTIONS.
 */
import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

export class NetGuardError extends Error {
  constructor(what) {
    super(`net-guard: refused ${what}. Tests may only use loopback; point this at tools/sim instead.`);
    this.name = 'NetGuardError';
    this.code = 'ENETGUARD';
  }
}

const loopback = new net.BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

/** True for 127.0.0.0/8, ::1 (and IPv4-mapped loopback), localhost and *.localhost. Everything else is outside. */
export function isLoopback(host) {
  const name = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const family = net.isIP(name);
  if (family) {
    try {
      return loopback.check(name, family === 4 ? 'ipv4' : 'ipv6');
    } catch {
      return false;
    }
  }
  return name === 'localhost' || name.endsWith('.localhost');
}

function refusal(what) {
  const err = new NetGuardError(what);
  process.stderr.write(`${err.message}\n`);
  return err;
}

/** The { host, port } a Socket#connect call is aimed at, or null for a Unix socket or named pipe. */
function connectTarget(args) {
  let [first, second] = args;
  if (Array.isArray(first)) [first, second] = first; // net.connect() passes its arguments already normalised
  if (first && typeof first === 'object') return first.path ? null : { host: first.host ?? 'localhost', port: first.port };
  if (typeof first === 'string' && !/^\d+$/.test(first)) return null;
  return { host: typeof second === 'string' ? second : 'localhost', port: first };
}

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const target = connectTarget(args);
  if (target) {
    const label = `a connection to ${target.host}:${target.port}`;
    if (!isLoopback(target.host)) {
      // Next tick, as a real connection failure would be: tls.connect() and fetch still set up the socket after this returns.
      const err = refusal(label);
      process.nextTick(() => this.destroy(err));
      return this;
    }
    // A loopback name must also resolve to loopback, whatever lookup function the caller supplied.
    if (!net.isIP(String(target.host).replace(/^\[|\]$/g, ''))) {
      this.on('lookup', (err, address) => {
        if (!err && address && !isLoopback(address) && !this.destroyed) this.destroy(refusal(`${label} resolving to ${address}`));
      });
    }
  }
  return realConnect.apply(this, args);
};

for (const method of ['send', 'connect']) {
  const real = dgram.Socket.prototype[method];
  dgram.Socket.prototype[method] = function guardedDgram(...args) {
    const host = args.slice(method === 'send' ? 1 : 0).find((a) => typeof a === 'string');
    if (host && !isLoopback(host)) throw refusal(`a UDP ${method} to ${host}`);
    return real.apply(this, args);
  };
}

const realLookup = dns.lookup;
dns.lookup = function guardedLookup(hostname, ...rest) {
  if (isLoopback(hostname)) return realLookup.call(this, hostname, ...rest);
  const callback = rest.at(-1);
  const err = refusal(`a DNS lookup of ${hostname}`);
  if (typeof callback !== 'function') throw err;
  process.nextTick(callback, err);
  return {};
};

const realPromiseLookup = dns.promises.lookup;
dns.promises.lookup = async function guardedLookup(hostname, ...rest) {
  if (!isLoopback(hostname)) throw refusal(`a DNS lookup of ${hostname}`);
  return realPromiseLookup.call(this, hostname, ...rest);
};

/** Stops every c-ares query (resolve4, resolveAny, reverse and so on): none of them is ever needed in a test. */
function blockResolvers(target) {
  for (const name of Object.getOwnPropertyNames(target)) {
    if (!/^(resolve|reverse)/.test(name) || typeof target[name] !== 'function') continue;
    target[name] = function guardedResolve(hostname, ...rest) {
      const err = refusal(`a DNS query for ${hostname}`);
      const callback = rest.at(-1);
      if (typeof callback === 'function') return void process.nextTick(callback, err);
      return Promise.reject(err);
    };
  }
}
blockResolvers(dns);
blockResolvers(dns.promises);
blockResolvers(dns.Resolver.prototype);
blockResolvers(dns.promises.Resolver.prototype);
syncBuiltinESMExports();

// Scripts a test starts with node get the same guard.
if (!(process.env.NODE_OPTIONS ?? '').includes(import.meta.url)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import=${import.meta.url}`.trim();
}
