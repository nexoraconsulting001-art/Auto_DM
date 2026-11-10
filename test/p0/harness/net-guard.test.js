// Runs each probe in a fresh process that loads the guard, the way every test run does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { repoRoot } from '../../../tools/gate-lib.mjs';

function probe(code) {
  const run = spawnSync(process.execPath, ['--import', './tools/net-guard.mjs', '--input-type=module', '-e', code], { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

// 192.0.2.0/24 is reserved for documentation and never routed, so even a broken guard sends nothing anywhere real.
const OUTSIDE = '192.0.2.1';
const errorCode = `(p) => p.then(() => 'connected', (e) => e.cause?.code ?? e.code)`;
const socketOutcome = `(s) => new Promise((done) => s.once('error', (e) => done(e.code)).once('connect', () => { s.destroy(); done('connected'); }).once('secureConnect', () => { s.destroy(); done('connected'); }))`;

test('net.connect to an outside address is refused', () => {
  const out = probe(`
    import net from 'node:net';
    const outcome = ${socketOutcome};
    console.log(JSON.stringify({
      options: await outcome(net.connect({ host: '${OUTSIDE}', port: 80 })),
      positional: await outcome(net.connect(80, '${OUTSIDE}')),
      socket: await outcome(new net.Socket().connect(80, '${OUTSIDE}')),
      wildcard: await outcome(net.connect({ host: '0.0.0.0', port: 80 })),
      shortForm: await outcome(net.connect({ host: '127.1', port: 80 })),
      name: await outcome(net.connect({ host: 'example.com', port: 80 })),
    }));`);
  assert.deepEqual(new Set(Object.values(out)), new Set(['ENETGUARD']));
});

test('fetch, http, https and tls to the outside are refused', () => {
  const out = probe(`
    import http from 'node:http';
    import https from 'node:https';
    import tls from 'node:tls';
    const code = ${errorCode};
    const outcome = ${socketOutcome};
    const request = (mod, url) => new Promise((done) => mod.get(url, () => done('connected')).on('error', (e) => done(e.code)));
    console.log(JSON.stringify({
      fetch: await code(fetch('http://${OUTSIDE}/')),
      fetchTls: await code(fetch('https://graph.instagram.com/me')),
      http: await request(http, 'http://${OUTSIDE}/'),
      https: await request(https, 'https://api.razorpay.com/v1'),
      tls: await outcome(tls.connect({ host: '${OUTSIDE}', port: 443 })),
    }));`);
  assert.deepEqual(new Set(Object.values(out)), new Set(['ENETGUARD']));
});

test('a loopback name that resolves outside is refused', () => {
  const out = probe(`
    import net from 'node:net';
    const outcome = ${socketOutcome};
    const lookup = (_host, options, cb) => options.all ? cb(null, [{ address: '${OUTSIDE}', family: 4 }]) : cb(null, '${OUTSIDE}', 4);
    console.log(JSON.stringify({ code: await outcome(net.connect({ host: 'localhost', port: 80, lookup })) }));`);
  assert.equal(out.code, 'ENETGUARD');
});

test('DNS and UDP stay local too', () => {
  const out = probe(`
    import dns, { lookup, resolve4 } from 'node:dns';
    import { lookup as promiseLookup, Resolver } from 'node:dns/promises';
    import dgram from 'node:dgram';
    const code = ${errorCode};
    const cb = (fn, ...args) => new Promise((done) => fn(...args, (e) => done(e?.code ?? 'resolved')));
    const socket = dgram.createSocket('udp4');
    let udp = 'sent';
    try { socket.send('x', 53, '${OUTSIDE}'); } catch (e) { udp = e.code; }
    socket.close();
    console.log(JSON.stringify({
      lookup: await cb(dns.lookup, 'example.com'),
      namedImport: await cb(lookup, 'example.com'),
      resolve4: await cb(resolve4, 'example.com'),
      promise: await code(promiseLookup('example.com')),
      resolver: await code(new Resolver().resolve4('example.com')),
      udp,
    }));`);
  assert.deepEqual(new Set(Object.values(out)), new Set(['ENETGUARD']));
});

test('loopback still works, and child processes inherit the guard', () => {
  const out = probe(`
    import http from 'node:http';
    import { execFileSync } from 'node:child_process';
    import { isLoopback } from './tools/net-guard.mjs';
    const server = http.createServer((_q, r) => r.end('hi'));
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address();
    const body = await (await fetch('http://127.0.0.1:' + port + '/')).text();
    const viaName = await (await fetch('http://localhost:' + port + '/')).text().catch((e) => e.cause?.code);
    server.close();
    const child = execFileSync(process.execPath, ['--input-type=module', '-e',
      "import net from 'node:net'; net.connect(80, '${OUTSIDE}').once('error', (e) => console.log(e.code));"], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    console.log(JSON.stringify({ body, viaName, child, verdicts: ['127.0.0.1', '127.9.9.9', '::1', '[::1]', '::ffff:127.0.0.1', 'localhost', 'a.localhost', 'LOCALHOST.', '0.0.0.0', '::', '10.0.0.1', '169.254.169.254', 'localhost.evil.com', ''].map(isLoopback) }));`);
  assert.equal(out.body, 'hi');
  // On machines where localhost resolves to ::1 first the server above is not there, which is a plain refusal.
  assert.ok(out.viaName === 'hi' || out.viaName === 'ECONNREFUSED', `localhost gave ${out.viaName}`);
  assert.equal(out.child, 'ENETGUARD');
  assert.deepEqual(out.verdicts, [true, true, true, true, true, true, true, true, false, false, false, false, false, false]);
});
