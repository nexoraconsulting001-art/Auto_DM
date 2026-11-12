/**
 * The job's own server for the shopper app's Maestro flows (.github/workflows/brand-apps.yml): seeds one store for the
 * brand file it is given into a new built-in database, starts every simulator from tools/sim, then the server on that
 * database, and writes what the flows need (the app's id, the names the flows look for, local addresses) to --out as
 * NAME=value lines.
 *
 *   node apps/shopper/.maestro/support/server.mjs --brand <brand.json> --out <file>
 *   PORT=3100 APP_HOST=localhost SIM_BASE_PORT=0 node apps/shopper/.maestro/support/server.mjs --brand <brand.json> --out <file>
 *
 * The seeded store is the default business, so the emulator's address for this machine (APP_HOST, 10.0.2.2) answers as
 * that store; the sellers' sign-in address is set to a name nothing resolves. Nothing here reaches a real service.
 * Refuses NODE_ENV=production and DATABASE_URL.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PRODUCT, seedDataDir } from './seed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

async function healthy(url, { tries = 240, every = 500 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, every));
  }
  return false;
}

/** What the flows are told: ids, the brand's own names and local addresses. */
export const flowEnv = (brand, seeded, { apiUrl, appHost }) => ({
  APP_ID: brand.android?.package ?? '',
  APP_NAME: brand.name,
  SHORT_NAME: brand.shortName,
  APP_SCHEME: brand.scheme,
  TENANT_ID: String(seeded.tenantId),
  PRODUCT_NAME: PRODUCT.name,
  API_URL: apiUrl,
  APP_HOST: appHost,
});

/** Starts the world for one brand. Answers { env, port, close }. */
export async function startFlowServer(brand, { env = process.env, stdio = 'inherit' } = {}) {
  if (String(env.NODE_ENV).toLowerCase() === 'production') throw new Error('This starts simulators: it never runs in production');
  if (env.DATABASE_URL) throw new Error('DATABASE_URL is set: the flows run only on a built-in database');
  const port = Number(env.PORT) || 3000;
  const appHost = env.APP_HOST || '10.0.2.2';
  const simPort = env.SIM_BASE_PORT === '0' ? 0 : Number(env.SIM_BASE_PORT) || 9101; // 0: any free ports
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shopper-flows-'));
  const removeData = () => fs.rmSync(dataDir, { recursive: true, force: true });

  let sims = null;
  let server = null;
  try {
    const dataKey = crypto.randomBytes(32).toString('base64');
    const seeded = await seedDataDir(dataDir, brand, { env, dataKey });
    const [{ startAll }, { serverEnv }] = await Promise.all([load('tools/sim/index.mjs'), load('tools/app-e2e-server.mjs')]);
    sims = await startAll({ basePort: simPort, env: { ...env, NODE_ENV: 'development' } });
    const settings = {
      ...serverEnv({ urls: sims.urls, env }),
      PORT: String(port),
      // Sellers sign in on a name of their own; every other address, the emulator's included, is the seeded store.
      PLATFORM_APP_HOST: 'sellers.invalid',
      DEFAULT_TENANT: seeded.slug,
      PUBLIC_BASE_URL: `http://${appHost}:${port}`,
      DATA_DIR: dataDir,
      DATA_KEY: dataKey,
    };
    server = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: settings, stdio });
    const exited = new Promise((resolve) => server.once('exit', resolve));
    const up = await Promise.race([healthy(`http://127.0.0.1:${port}/healthz`), exited.then(() => false)]);
    if (!up) throw new Error('The server did not come up');
    const close = async () => {
      if (server.exitCode === null) {
        server.kill();
        await exited;
      }
      await sims.close();
      removeData();
    };
    return { env: flowEnv(brand, seeded, { apiUrl: `http://127.0.0.1:${port}`, appHost }), port, seeded, close };
  } catch (error) {
    if (server && server.exitCode === null) server.kill();
    await sims?.close();
    removeData();
    throw error;
  }
}

/** NAME=value lines, one per value. */
export const envLines = (env) => Object.entries(env).map(([name, value]) => `${name}=${value}`).join('\n') + '\n';

async function main() {
  const argv = process.argv.slice(2);
  const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const brandFile = option('--brand');
  const envFile = option('--out');
  if (!brandFile || !envFile) throw new Error('Usage: node apps/shopper/.maestro/support/server.mjs --brand <brand.json> --out <file>');
  const brand = JSON.parse(fs.readFileSync(path.resolve(brandFile), 'utf8'));
  const world = await startFlowServer(brand);
  fs.writeFileSync(envFile, envLines(world.env));
  const stop = () => world.close().finally(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  // Started by a test with an IPC channel: when the test lets go, everything here stops too (Windows has no SIGTERM).
  if (process.send) process.once('disconnect', stop);
  console.log(`flows: ready on port ${world.port}`);
  process.send?.({ ready: true, port: world.port });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`flows: ${error.message}`);
    process.exit(1);
  });
}
