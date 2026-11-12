/**
 * The job's own server for the Maestro flows (android-e2e in .github/workflows/apps.yml): seeds the made-up world into
 * a new built-in database, starts every simulator from tools/sim, then the server on that database, and writes what
 * the flows need to know (ids, invented numbers, the API and simulator addresses) to --out as NAME=value lines.
 *
 *   node apps/owner/.maestro/support/server.mjs --out <file>
 *   PORT=3100 APP_HOST=localhost SIM_BASE_PORT=9300 node apps/owner/.maestro/support/server.mjs --out <file>
 *
 * The settings are tools/app-e2e-server.mjs's (serverEnv), with one change: Bhava's own WhatsApp number is given the
 * token the WhatsApp simulator was started with, so the sign-in codes really reach the simulator's outbox, where the
 * flows read them. Nothing here reaches a real service. Refuses NODE_ENV=production and DATABASE_URL.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { seedDataDir } from './seed.mjs';
import { flowEnv } from './world.mjs';

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

/** Starts the world. Answers { env, port, close }; `env` is what the flows are told. */
export async function startFlowServer({ env = process.env, stdio = 'inherit' } = {}) {
  if (String(env.NODE_ENV).toLowerCase() === 'production') throw new Error('This starts simulators: it never runs in production');
  if (env.DATABASE_URL) throw new Error('DATABASE_URL is set: the flows run only on a built-in database');
  const port = Number(env.PORT) || 3000;
  const appHost = env.APP_HOST || '10.0.2.2';
  const simPort = env.SIM_BASE_PORT === '0' ? 0 : Number(env.SIM_BASE_PORT) || 9101; // 0: any free ports
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-flows-'));
  const removeData = () => fs.rmSync(dataDir, { recursive: true, force: true });

  let sims = null;
  let server = null;
  try {
    // One data key for the seed and the server, so the payment key the seed stores is one the server can read.
    const dataKey = crypto.randomBytes(32).toString('base64');
    const seeded = await seedDataDir(dataDir, { env, dataKey });
    const [{ startAll }, { serverEnv }] = await Promise.all([load('tools/sim/index.mjs'), load('tools/app-e2e-server.mjs')]);
    const token = crypto.randomBytes(24).toString('hex');
    sims = await startAll({ basePort: simPort, env: { ...env, NODE_ENV: 'development' }, options: { whatsapp: { token } } });
    const settings = {
      ...serverEnv({ urls: sims.urls, env }),
      PORT: String(port),
      PLATFORM_APP_HOST: appHost,
      PUBLIC_BASE_URL: `http://${appHost}:${port}`,
      DATA_DIR: dataDir,
      DATA_KEY: dataKey,
      PLATFORM_WHATSAPP_TOKEN: token,
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
    return { env: flowEnv(seeded, { apiUrl: `http://127.0.0.1:${port}`, whatsappUrl: sims.urls.whatsapp, appHost }), port, close };
  } catch (error) {
    if (server && server.exitCode === null) server.kill();
    await sims?.close();
    removeData();
    throw error;
  }
}

/** NAME=value lines, one per value; values are ids, invented numbers, names and local addresses. */
export const envLines = (env) => Object.entries(env).map(([name, value]) => `${name}=${value}`).join('\n') + '\n';

async function main() {
  const argv = process.argv.slice(2);
  const envFile = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : null;
  if (!envFile) throw new Error('Usage: node apps/owner/.maestro/support/server.mjs --out <file>');
  const world = await startFlowServer();
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
