/**
 * Every outside service as a loopback HTTP server, so no test or local run reaches the real one.
 *
 *   node tools/sim/index.mjs      (`npm run sim`)
 *
 * Starts them on SIM_BASE_PORT (default 9101) upward, in the order of SERVICES. Point the app at them with
 * GRAPH_BASE_URL=http://127.0.0.1:9101 and so on. APP_SECRET and VERIFY_TOKEN from the environment or .env are the Meta
 * app's, so its webhooks pass the app's signature check; they go to SIM_WEBHOOK_URL (default the local app's /webhook).
 *
 * Shared controls are in base.mjs, Meta's in meta/control.mjs. In a test, start only what it needs:
 *
 *   const meta = createMeta({ app: { secret: 'secret', webhookUrl } });
 *   await meta.start();                       // meta.url is on 127.0.0.1
 *   await meta.post('/accounts', { igUserId: '1', username: 'shop', token: 't', subscribedFields: ['comments'] });
 *   await meta.fault({ kind: 'rate_limit', code: 613, match: { path: '/v23.0/1/messages' } });
 *
 * Simulators refuse to run when NODE_ENV=production; see guard.mjs for the matching check on service URLs.
 *
 * The store's simulators (razorpay, shiprocket, shopify, whatsapp) also send the webhooks their services send: signed, with
 * duplicates, and out of order. See tools/sim/webhooks.mjs and the header of each.
 *
 * tools/sim/email (an HTTP mail API, for order emails) is not in SERVICES: no mail provider is chosen yet, so a test that sends
 * email starts it itself (createEmail from tools/sim/email/index.mjs) and points EMAIL_BASE_URL at it.
 *
 * tools/sim/apple (Sign in with Apple: the signing keys and identity tokens, right and wrong) is not in SERVICES either: a test
 * that signs in with Apple starts it itself (createApple from tools/sim/apple/index.mjs) and points APPLE_KEYS_BASE_URL at it.
 * Google's keys and seller tokens are part of tools/sim/google: point GOOGLE_KEYS_BASE_URL at it.
 *
 * tools/sim/push (FCM HTTP v1 and APNs over HTTP/2, for owner push) is not in SERVICES either: a test that pushes starts it itself
 * (createPush from tools/sim/push/index.mjs) and points FCM_BASE_URL at its url and APNS_BASE_URL at its apnsUrl.
 *
 * tools/sim/sites (outside websites for imports and theme reads, hostile ones included) is not in SERVICES: safeFetch never
 * connects to loopback, so a test starts it in process and hands its transport() to the fetcher (see sites/index.mjs).
 */
import { pathToFileURL } from 'node:url';
import { assertSimulatorsAllowed } from './guard.mjs';
import { createGoogle } from './google/index.mjs';
import { createMeta } from './meta/index.mjs';
import { createRazorpay } from './razorpay/index.mjs';
import { createShiprocket } from './shiprocket/index.mjs';
import { createShopify } from './shopify/index.mjs';
import { createWhatsApp } from './whatsapp/index.mjs';

export const SERVICES = [
  ['meta', createMeta],
  ['whatsapp', createWhatsApp],
  ['razorpay', createRazorpay],
  ['shiprocket', createShiprocket],
  ['shopify', createShopify],
  ['google', createGoogle],
];

export const DEFAULT_BASE_PORT = 9101;

/** `basePort` 0 gives each service a free port. `options` is per service, by name. */
export async function startAll({ basePort = DEFAULT_BASE_PORT, env = process.env, options = {} } = {}) {
  assertSimulatorsAllowed(env);
  const sims = {};
  const close = () => Promise.all(Object.values(sims).map((sim) => sim.close()));
  try {
    for (const [index, [name, create]] of SERVICES.entries()) {
      sims[name] = create(options[name]);
      await sims[name].start({ port: basePort === 0 ? 0 : basePort + index, env });
    }
  } catch (err) {
    await close();
    throw err;
  }
  return { sims, urls: Object.fromEntries(Object.entries(sims).map(([name, sim]) => [name, sim.url])), close };
}

function basePortFrom(env) {
  if (env.SIM_BASE_PORT === undefined || env.SIM_BASE_PORT === '') return DEFAULT_BASE_PORT;
  const port = Number(env.SIM_BASE_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('SIM_BASE_PORT must be a port number.');
  return port;
}

async function main() {
  await import('dotenv/config');
  const { env } = process;
  const all = await startAll({
    basePort: basePortFrom(env),
    options: {
      meta: {
        app: {
          id: env.IG_APP_ID || undefined,
          secret: env.APP_SECRET || undefined,
          verifyToken: env.VERIFY_TOKEN || undefined,
          webhookUrl: env.SIM_WEBHOOK_URL || `http://127.0.0.1:${env.PORT || 3000}/webhook`,
        },
        facebookApp: { id: env.FB_APP_ID || undefined, secret: env.FB_APP_SECRET || undefined },
      },
    },
  });
  for (const [name, url] of Object.entries(all.urls)) console.log(`sim ${name.padEnd(10)} ${url}`);
  const stop = () => all.close().finally(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`sim: ${err.message}`);
    process.exit(1);
  });
}
