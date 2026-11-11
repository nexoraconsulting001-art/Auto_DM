/**
 * App tests never reach the network: fetch, XMLHttpRequest, WebSocket and node's own sockets are refused for any
 * host that is not this machine. A test that needs the API starts it locally or passes its own `fetch`.
 */
const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function hostOf(target) {
  try {
    const url = typeof target === 'string' ? target : target?.url ?? target?.href ?? String(target);
    return new URL(url, 'http://localhost').hostname;
  } catch {
    return '';
  }
}

const isLocal = (host) => LOCAL.has(String(host).toLowerCase()) || String(host).toLowerCase().endsWith('.localhost');

function refuse(what, host) {
  const error = new Error(`Network call refused in a test: ${what} to "${host}". App tests may only reach localhost.`);
  error.code = 'ENETGUARD';
  return error;
}

const realFetch = globalThis.fetch;
globalThis.fetch = function guardedFetch(input, init) {
  const host = hostOf(input);
  if (!isLocal(host)) return Promise.reject(refuse('fetch', host));
  if (!realFetch) return Promise.reject(new Error('fetch is not available in this test environment'));
  return realFetch.call(globalThis, input, init);
};

for (const name of ['XMLHttpRequest', 'WebSocket', 'EventSource']) {
  const Real = globalThis[name];
  globalThis[name] = class Guarded {
    constructor(url, ...rest) {
      if (name === 'XMLHttpRequest') {
        if (!Real) throw refuse(name, '');
        const xhr = new Real();
        const open = xhr.open.bind(xhr);
        xhr.open = (method, target, ...more) => {
          if (!isLocal(hostOf(target))) throw refuse(name, hostOf(target));
          return open(method, target, ...more);
        };
        return xhr;
      }
      if (!isLocal(hostOf(url))) throw refuse(name, hostOf(url));
      if (!Real) throw new Error(`${name} is not available in this test environment`);
      return new Real(url, ...rest);
    }
  };
}

const net = require('node:net');
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const options = typeof args[0] === 'object' && args[0] !== null ? (Array.isArray(args[0]) ? args[0][0] : args[0]) : { port: args[0], host: args[1] };
  const host = options?.path ? 'localhost' : typeof options?.host === 'string' ? options.host : 'localhost';
  if (!isLocal(host)) {
    const error = refuse('a socket', host);
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return realConnect.apply(this, args);
};

module.exports = { isLocal, hostOf };
