/**
 * Starting the app for the readiness checks: the simulators, the web servers and the worker as their own processes on the
 * settings a check names, and the helpers the checks use to talk to them. Built on the load test's world (tools/load): the same
 * environment for a child, the same business seeding, the same simulators. Nothing here reaches an outside service: a child's
 * environment is made from nothing, the simulators stand in for Meta and Razorpay, and (on this machine) every child loads
 * tools/net-guard.mjs.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { createMeta } from '../sim/meta/index.mjs';
import { hubSignature } from '../sim/meta/index.mjs';
import { createRazorpay } from '../sim/razorpay/index.mjs';
import { createClient, sleep } from '../load/http.mjs';
import { loadBudgets, startNode } from '../load/stack.mjs';
import { childEnv, freePort, madeUpSecrets, seedBusinesses, waitReady, waitWorker } from '../load/world.mjs';
import { isLoopback } from './guard.mjs';

export { createClient, freePort, madeUpSecrets, seedBusinesses, sleep };

/** The made-up secrets of one run (the same set for every process of that run: moving data is not changing keys). */
export const runSecrets = () => madeUpSecrets();

/**
 * The environment of a web server or worker: the load test's (every value made up) with `settings` laid over it. When any
 * service of the run is not on this machine (a CI service container by name), the net guard is left out, since it only allows loopback.
 */
export function appEnv({ ownerUrl, appUrl, port, workerPort, metaUrl, razorpay, secrets, storageDir, settings = {}, guard = true }) {
  const env = { ...childEnv({ ownerUrl, appUrl, webPort: port, workerPort, metaUrl, razorpay, secrets, storageDir }), ...settings };
  if (!guard) delete env.NODE_OPTIONS;
  return env;
}

/** True when every address in `urls` is on this machine, so the children can load the net guard. */
export function allLoopback(urls) {
  return urls.filter(Boolean).every((u) => {
    try {
      return isLoopback(new URL(u).hostname);
    } catch {
      return false;
    }
  });
}

/** The two simulators the app is pointed at, started for this run. `webhookUrl` is where Meta's webhooks go (the load balancer, or the one server). */
export async function startSimulators({ cleanup, secrets, webhookUrl }) {
  const meta = createMeta({ app: { id: 'sim-app', secret: secrets.appSecret, verifyToken: secrets.verifyToken, webhookUrl } });
  await meta.start();
  cleanup.add('Meta simulator', () => meta.close());
  const razorpay = createRazorpay({ webhookUrl: webhookUrl.replace(/\/webhook$/, '/webhooks/razorpay') });
  await razorpay.start();
  cleanup.add('Razorpay simulator', () => razorpay.close());
  return { meta, razorpay };
}

/** Starts web or worker as its own process. It is stopped by its own pid when the cleanup runs. */
export function startRole(role, { env, cleanup, label = role }) {
  const node = startNode(role, { budgets: loadBudgets(), env });
  cleanup.add(`${label} process`, async () => {
    await node.stop();
  });
  node.label = label;
  return node;
}

export async function waitWeb(port, node, ms = 90_000) {
  const client = createClient({ port, connections: 2 });
  try {
    await waitReady(client, undefined, ms, node);
  } finally {
    client.close();
  }
}

export const waitWorkerUp = (port, node, ms = 90_000) => waitWorker(port, ms, node);

/** What a failed start can say without leaking: the last lines of the process output, scrubbed by the caller. */
export const lastOutput = (node, lines = 4) => node.output().split('\n').slice(-lines).join(' | ').slice(0, 400);

/** A small PNG that is different each time it is asked for (so two uploads are never the same file). */
export async function pngBytes(seed = crypto.randomBytes(3)) {
  const { default: sharp } = await import('sharp');
  return sharp({ create: { width: 24, height: 24, channels: 3, background: { r: seed[0], g: seed[1], b: seed[2] } } }).png().toBuffer();
}

/** A multipart/form-data body with one file field. */
export function multipartFile({ field = 'file', filename = 'image.png', type = 'image/png', bytes }) {
  const boundary = `----chk${crypto.randomBytes(8).toString('hex')}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, bytes, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** The body of a Meta webhook for one comment on a business's reel, and its signature header, signed with the app's secret as Meta signs. */
export function signedCommentWebhook({ shop, id, fan, secret, text = 'price please' }) {
  const body = { object: 'instagram', entry: [{ id: shop.igUserId, time: Math.floor(Date.now() / 1000), changes: [{ field: 'comments', value: { id, text, from: { id: fan, username: `fan_${fan.slice(-6)}` }, media: { id: shop.reelId, media_product_type: 'REELS' } } }] }] };
  const raw = JSON.stringify(body);
  return { raw, headers: { 'x-hub-signature-256': hubSignature(raw, secret), 'content-type': 'application/json' } };
}

/** The same business API calls the seeding makes: sign in on the business's host. Answers the token. */
export async function signIn(client, shop) {
  const res = await client.request({ method: 'POST', path: '/api/v1/auth/login', host: shop.host, body: shop.owner });
  if (res.status !== 201) throw new Error(`sign-in answered ${res.status}`);
  return JSON.parse(res.text).token;
}

export const authed = (token) => ({ authorization: `Bearer ${token}` });

export const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/** One request with the body as bytes (the load client answers text). `host` is the business's host name; the connection is to 127.0.0.1:port. */
export function rawRequest({ port, method = 'GET', path, host, headers = {}, body }) {
  return new Promise((resolve) => {
    const sent = { ...headers, ...(host ? { host } : {}) };
    if (body !== undefined) sent['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: sent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', (err) => resolve({ status: 0, headers: {}, body: Buffer.alloc(0), error: err.code || 'error' }));
    });
    req.on('error', (err) => resolve({ status: 0, headers: {}, body: Buffer.alloc(0), error: err.code || 'error' }));
    req.setTimeout(20_000, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    if (body !== undefined) req.write(body);
    req.end();
  });
}
