/**
 * The API an app under test talks to (`npm run app:server`): the server on its built-in database, with every
 * outside service a simulator from tools/sim on this machine. Used by the android-e2e job in
 * .github/workflows/apps.yml and for running the owner app on an emulator at a desk. Nothing here reaches a real
 * service, and it refuses to run with NODE_ENV=production.
 *
 *   node tools/app-e2e-server.mjs            port 3000; an Android emulator reaches it at http://10.0.2.2:3000
 *   PORT=3100 APP_HOST=localhost node tools/app-e2e-server.mjs
 *
 * APP_HOST is the host name the app uses for the API (10.0.2.2 from an Android emulator, localhost from an iOS
 * simulator). It becomes PLATFORM_APP_HOST, the sign-in host that belongs to no business.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAll } from './sim/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || 3000;
const appHost = process.env.APP_HOST || '10.0.2.2';
const simPort = Number(process.env.SIM_BASE_PORT) || 9101;

/** The settings the server is started with: simulators for every outside service, and secrets made up for this run. */
export function serverEnv({ urls, env = process.env, random = () => crypto.randomBytes(32) }) {
  const whatsappToken = random().toString('hex');
  return {
    ...env,
    NODE_ENV: 'development',
    ALLOW_PGLITE: '1',
    PORT: String(port),
    PLATFORM_DOMAIN: 'bhava.test',
    PLATFORM_APP_HOST: appHost,
    PUBLIC_BASE_URL: `http://${appHost}:${port}`,
    SESSION_SECRET: random().toString('hex'),
    DATA_KEY: random().toString('base64'),
    APP_SECRET: env.APP_SECRET || random().toString('hex'),
    VERIFY_TOKEN: env.VERIFY_TOKEN || random().toString('hex'),
    GRAPH_BASE_URL: urls.meta,
    WHATSAPP_BASE_URL: urls.whatsapp,
    RAZORPAY_BASE_URL: urls.razorpay,
    SHIPROCKET_BASE_URL: urls.shiprocket,
    SHOPIFY_BASE_URL: urls.shopify,
    GA4_BASE_URL: urls.google,
    GOOGLE_KEYS_BASE_URL: urls.google,
    PLATFORM_WHATSAPP_PHONE_ID: 'sim-platform-number',
    PLATFORM_WHATSAPP_TOKEN: whatsappToken,
    PUSH_DRIVER: 'none',
  };
}

async function waitFor(url, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function main() {
  if (String(process.env.NODE_ENV).toLowerCase() === 'production') throw new Error('This starts simulators: it never runs in production');
  const all = await startAll({ basePort: simPort, env: { ...process.env, NODE_ENV: 'development' } });
  const env = serverEnv({ urls: all.urls });
  const server = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env, stdio: 'inherit' });
  const stop = () => {
    server.kill();
    all.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  server.once('exit', (code) => all.close().finally(() => process.exit(code ?? 1)));
  if (!(await waitFor(`http://127.0.0.1:${port}/healthz`))) {
    console.error('app-e2e-server: the server did not come up');
    server.kill();
    return;
  }
  console.log(`app-e2e-server: ready on port ${port}; apps use http://${appHost}:${port}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(`app-e2e-server: ${err.message}`);
    process.exit(1);
  });
}
