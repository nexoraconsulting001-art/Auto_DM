/**
 * The job's own server for the showcase (Phase 8, Q-11): both sample businesses loaded from their seed files into a new
 * built-in database with `scripts/showcase.js`'s own loader, every outside service a simulator from tools/sim, and then the
 * real server on that database. It writes what the flows need to --out as NAME=value lines. Nothing here names a business:
 * they come from seed/showcase/manifest.json, and a flow reaches one by its place in that list.
 *
 *   node tools/showcase-build/server.mjs --mode export --brands <folder>
 *       load both businesses, write <folder>/<key>/brand.json (Android) and <key>/brand-ios.json (iOS simulator), stop.
 *   node tools/showcase-build/server.mjs --mode shopper --key <key> --out <file> [--brands <folder>]
 *       the server for one business's shopper app: the emulator's address answers as that business. With --brands the
 *       business id in that business's brand file must be the one loaded here, or this refuses to start.
 *   node tools/showcase-build/server.mjs --mode owner --out <file>
 *       the server for the owner app: its sign-in address is the platform's, one account belongs to every business, and
 *       each business has one cash on delivery order waiting.
 *
 *   PORT=3000 APP_HOST=10.0.2.2 SIM_BASE_PORT=9101 (SIM_BASE_PORT=0 takes any free ports)
 *
 * Refuses NODE_ENV=production, DATABASE_URL, and any provider address that is not a simulator. No secret: every key is made
 * up for the run.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SHOPPER } from '../../apps/shopper/.maestro/support/seed.mjs';
import { OPERATOR, ShowcaseBuildError, envLines, iosBrandFile, orderNumber, ownerFlowEnv } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const GATEWAY = Object.freeze({ keyId: 'rzp_test_sim', keySecret: 'sim-key-secret', webhookSecret: 'sim-webhook-secret' });
const ADDRESS = Object.freeze({ name: 'Test Shopper', phone: '+919800000121', line1: '1 Test Lane', line2: '', landmark: '', city: 'Pune', stateCode: '27', pincode: '411001' });

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

/** A product a shopper can buy straight away: active, in stock, with no option to choose first. */
async function plainProduct(db, tenantId) {
  const [row] = await db.query(
    `SELECT p.id, p.slug, p.name, p.price_paise FROM products p
      WHERE p.tenant_id = $1 AND p.active AND p.in_stock AND (p.stock IS NULL OR p.stock > 0)
        AND NOT EXISTS (SELECT 1 FROM product_options o WHERE o.tenant_id = p.tenant_id AND o.product_id = p.id)
      ORDER BY p.id LIMIT 1`,
    [tenantId],
  );
  if (!row) throw new ShowcaseBuildError(`Business ${tenantId} has no product a shopper can buy without choosing an option`);
  return row;
}

/** A linked account at the payment simulator with KYC passed: online payment is on only for a verified one. */
async function linkedAccount({ url, keyId, keySecret }, label) {
  const basic = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const made = await fetch(`${url}/v2/accounts`, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'sim@showcase.test', phone: '9876500000', legal_business_name: label, reference_id: `showcase-${label}` }),
  });
  if (!made.ok) throw new ShowcaseBuildError(`The payment simulator refused the linked account (${made.status})`);
  const { id } = await made.json();
  const kyc = await fetch(`${url}/__sim/accounts/kyc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, status: 'activated' }) });
  if (!kyc.ok) throw new ShowcaseBuildError(`The payment simulator would not pass KYC (${kyc.status})`);
  return id;
}

/** Everything a shopper app needs on the server beyond the seed: cash on delivery and online payment on, and the store's own WhatsApp number (the codes go out from it). */
async function prepareShopperStore(db, { tenant, secrets, whatsappToken, gateway }) {
  const linked = await linkedAccount(gateway, tenant.slug);
  await db.query(
    `INSERT INTO payment_settings (tenant_id, mode, cod, linked_account_id, kyc_status) VALUES ($1, 'managed', true, $2, 'verified')
     ON CONFLICT (tenant_id) DO UPDATE SET mode = 'managed', cod = true, linked_account_id = EXCLUDED.linked_account_id, kyc_status = 'verified'`,
    [tenant.id, linked],
  );
  await db.query(
    'INSERT INTO whatsapp_accounts (tenant_id, waba_id, phone_number_id, access_token_enc) VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id) DO UPDATE SET access_token_enc = EXCLUDED.access_token_enc, status = \'active\'',
    [tenant.id, `waba-${tenant.id}`, `pn-${tenant.id}`, secrets.encrypt(whatsappToken)],
  );
  const [have] = await db.query("SELECT 1 AS one FROM whatsapp_templates WHERE tenant_id = $1 AND purpose = 'otp' AND status = 'approved'", [tenant.id]);
  if (!have) await db.query("INSERT INTO whatsapp_templates (tenant_id, purpose, category, name, status) VALUES ($1, 'otp', 'authentication', 'login_code', 'approved')", [tenant.id]);
}

/** One cash on delivery order, made the way checkout makes one: inserted, then moved to new with cash due through the order state machine. */
async function codOrder(db, { tenant, product, number, changeOrder }) {
  return db.tx(async (t) => {
    const total = Number(product.price_paise);
    const [order] = await t.query(
      `INSERT INTO orders (tenant_id, order_number, public_token, flow, payment_mode, customer_name, phone, address, city, state, pincode,
         subtotal_paise, discount_paise, shipping_paise, tax_paise, total_paise, advance_paise, balance_paise, idempotency_key, shipping_address)
       VALUES ($1, $2, $3, 'checkout', 'cod', $4, $5, $6, $7, 'Maharashtra', $8, $9, 0, 0, 0, $9, 0, $9, $10, $11) RETURNING id`,
      [tenant.id, number, crypto.randomBytes(12).toString('base64url'), ADDRESS.name, ADDRESS.phone, ADDRESS.line1, ADDRESS.city, ADDRESS.pincode,
        total, crypto.randomUUID(), JSON.stringify(ADDRESS)],
    );
    await t.query('INSERT INTO order_items (tenant_id, order_id, product_id, name, price_paise, qty) VALUES ($1, $2, $3, $4, $5, 1)', [tenant.id, order.id, product.id, product.name, total]);
    await changeOrder(t, order.id, { payment: 'cod_due', fulfilment: 'new', actor: 'shopper', reason: 'Cash on delivery, phone verified' });
    return { id: Number(order.id), number };
  });
}

/** Writes every business's brand files under <folder>/<key>/. Answers [{ key, file, iosFile }]. */
export async function writeBrandFiles({ world, loaded, folder }) {
  const { exportBrands } = await load('scripts/showcase.js');
  const written = await exportBrands({ world, loaded, folder });
  return written.map(({ key, file }) => {
    const iosFile = path.join(path.dirname(file), 'brand-ios.json');
    fs.writeFileSync(iosFile, `${JSON.stringify(iosBrandFile(JSON.parse(fs.readFileSync(file, 'utf8'))), null, 2)}\n`);
    return { key, file, iosFile };
  });
}

/**
 * Starts the world. Answers { env, port, brands, close }: `env` is what the flows are told, `brands` the brand files written
 * when `brandsOut` is given. mode is 'export' (no server started), 'shopper' (needs `key`) or 'owner'.
 */
export async function startShowcaseServer({ mode, key = '', brandsDir = '', brandsOut = '', env = process.env, stdio = 'inherit' } = {}) {
  if (!['export', 'shopper', 'owner'].includes(mode)) throw new ShowcaseBuildError('The mode is export, shopper or owner');
  if (String(env.NODE_ENV).toLowerCase() === 'production') throw new ShowcaseBuildError('This starts simulators: it never runs in production');
  if (env.DATABASE_URL) throw new ShowcaseBuildError('DATABASE_URL is set: the showcase runs only on a built-in database');
  if (mode === 'shopper' && !key) throw new ShowcaseBuildError('The shopper server needs --key: the business whose app is under test');
  const port = Number(env.PORT) || 3000;
  const appHost = env.APP_HOST || '10.0.2.2';
  const simPort = env.SIM_BASE_PORT === '0' ? 0 : Number(env.SIM_BASE_PORT) || 9101;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showcase-'));
  const removeData = () => fs.rmSync(dataDir, { recursive: true, force: true });

  let sims = null;
  let server = null;
  let db = null;
  try {
    const [{ startAll }, { serverEnv }, { openDb }, { createRepos }, { createSecrets }, { withTenant }, { changeOrder }, showcase, { openShowcaseWorld }] = await Promise.all([
      load('tools/sim/index.mjs'), load('tools/app-e2e-server.mjs'), load('src/db/index.js'), load('src/repos/index.js'), load('src/platform/secrets.js'),
      load('src/tenancy.js'), load('src/modules/orders/state.js'), load('scripts/showcase.js'), load('tools/sim/activity/world.mjs'),
    ]);
    const dataKey = crypto.randomBytes(32).toString('base64');
    const whatsappToken = crypto.randomBytes(24).toString('hex');
    const simEnv = { ...env, NODE_ENV: 'development' };
    showcase.assertShowcaseAllowed(simEnv);
    sims = await startAll({ basePort: simPort, env: simEnv, options: { whatsapp: { token: whatsappToken }, razorpay: GATEWAY } });

    db = await openDb({ dataDir, migrate: true });
    const secrets = createSecrets({ dataKey });
    const repos = createRepos(db, { secrets });
    const businesses = showcase.loadShowcase({ plantSeed: env.SHOWCASE_PLANT_SEED || '' });
    const world = await openShowcaseWorld({ db, env: { ...simEnv, DATA_KEY: dataKey } });
    let loaded;
    let brands = [];
    try {
      loaded = await showcase.seedShowcase({ world, businesses });
      if (brandsOut) brands = await writeBrandFiles({ world, loaded, folder: brandsOut });
    } finally {
      await world.close();
    }

    // The business ids the builds carry must be the ones loaded here.
    if (brandsDir) {
      for (const business of loaded) {
        const file = path.join(brandsDir, business.key, 'brand.json');
        const brand = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (brand.tenantId !== business.tenantId) throw new ShowcaseBuildError(`The brand file of "${business.key}" is for business ${brand.tenantId}, but this server loaded it as ${business.tenantId}`);
      }
    }

    const seeded = [];
    for (const [i, business] of loaded.entries()) {
      const tenant = await repos.tenants.getBySlug(business.slug);
      const product = await plainProduct(db, tenant.id);
      const entry = { key: business.key, slug: business.slug, tenantId: Number(tenant.id), name: tenant.name, product, order: null };
      if (mode === 'shopper' && business.key === key) {
        await prepareShopperStore(db, { tenant, secrets, whatsappToken, gateway: { url: sims.urls.razorpay, ...GATEWAY } });
      }
      if (mode === 'owner') {
        await withTenant(tenant, async () => {
          entry.order = await codOrder(db, { tenant, product, number: orderNumber(i + 1), changeOrder });
          await db.query("INSERT INTO users (tenant_id, name, phone, email, password_hash, role) VALUES ($1, $2, $3, '', '!', 'owner')", [tenant.id, OPERATOR.name, OPERATOR.phone]);
        });
      }
      seeded.push(entry);
    }
    const chosen = seeded.find((entry) => entry.key === key);
    if (mode === 'shopper' && !chosen) throw new ShowcaseBuildError(`The manifest has no business with the key "${key}"`);
    await db.close();
    db = null;

    if (mode === 'export') {
      await sims.close();
      removeData();
      return { env: {}, port: 0, brands, close: async () => {} };
    }

    const settings = {
      ...serverEnv({ urls: sims.urls, env }),
      PORT: String(port),
      PUBLIC_BASE_URL: `http://${appHost}:${port}`,
      DATA_DIR: dataDir,
      DATA_KEY: dataKey,
      PLATFORM_WHATSAPP_TOKEN: whatsappToken,
      ...(mode === 'shopper'
        ? { PLATFORM_APP_HOST: 'sellers.invalid', DEFAULT_TENANT: chosen.slug, RAZORPAY_KEY_ID: GATEWAY.keyId, RAZORPAY_KEY_SECRET: GATEWAY.keySecret, RAZORPAY_WEBHOOK_SECRET: GATEWAY.webhookSecret }
        : { PLATFORM_APP_HOST: appHost }),
    };
    server = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: settings, stdio });
    const exited = new Promise((resolve) => server.once('exit', resolve));
    const up = await Promise.race([healthy(`http://127.0.0.1:${port}/healthz`), exited.then(() => false)]);
    if (!up) throw new ShowcaseBuildError('The server did not come up');
    if (mode === 'shopper') {
      // The payment simulator sends the gateway's signed webhooks to this server, as Razorpay would.
      const hook = await fetch(`${sims.urls.razorpay}/__sim/webhooks/url`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: `http://127.0.0.1:${port}/webhooks/razorpay` }) });
      if (!hook.ok) throw new ShowcaseBuildError('The payment simulator would not take the webhook address');
    }
    const close = async () => {
      if (server.exitCode === null) {
        server.kill();
        await exited;
      }
      await sims.close();
      removeData();
    };
    const apiUrl = `http://127.0.0.1:${port}`;
    const flows = mode === 'owner'
      ? ownerFlowEnv(seeded, { apiUrl, whatsappUrl: sims.urls.whatsapp, appHost })
      : shopperFlowEnv(chosen, loaded.find((entry) => entry.key === key), { apiUrl, appHost, simUrls: sims.urls, brandsDir });
    return { env: flows, port, brands, close };
  } catch (error) {
    if (server && server.exitCode === null) server.kill();
    await db?.close().catch(() => {});
    await sims?.close();
    removeData();
    throw error;
  }
}

/** What the shopper flows are told: the app's id and scheme from the business's own brand file when there is one, the product the seed made, local addresses. */
export function shopperFlowEnv(chosen, loaded, { apiUrl, appHost, simUrls = {}, brandsDir = '' }) {
  const brand = brandsDir ? JSON.parse(fs.readFileSync(path.join(brandsDir, chosen.key, 'brand.json'), 'utf8')) : null;
  return {
    APP_ID: brand?.android?.package ?? '',
    APP_NAME: brand?.name ?? chosen.name,
    SHORT_NAME: brand?.shortName ?? chosen.name,
    APP_SCHEME: brand?.scheme ?? '',
    TENANT_ID: String(chosen.tenantId),
    PRODUCT_NAME: chosen.product.name,
    PRODUCT_SLUG: chosen.product.slug,
    SHOPPER_NAME: SHOPPER.name,
    SHOPPER_PHONE: SHOPPER.phone,
    SHOPPER_LINE1: SHOPPER.line1,
    SHOPPER_CITY: SHOPPER.city,
    SHOPPER_PINCODE: SHOPPER.pincode,
    SHOPPER_STATE_CODE: SHOPPER.stateCode,
    SHOPPER_EMAIL: SHOPPER.email,
    API_URL: apiUrl,
    APP_HOST: appHost,
    SIM_WHATSAPP_URL: simUrls.whatsapp ?? '',
    SIM_RAZORPAY_URL: simUrls.razorpay ?? '',
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : '');
  const mode = option('--mode');
  const envFile = option('--out');
  if (!mode || (mode !== 'export' && !envFile)) throw new ShowcaseBuildError('Usage: node tools/showcase-build/server.mjs --mode export --brands <folder> | --mode shopper --key <key> --out <file> [--brands <folder>] | --mode owner --out <file>');
  const brands = option('--brands');
  const world = await startShowcaseServer({ mode, key: option('--key'), brandsOut: mode === 'export' ? path.resolve(brands) : '', brandsDir: mode !== 'export' && brands ? path.resolve(brands) : '' });
  for (const entry of world.brands) console.log(`brand file: ${path.relative(process.cwd(), entry.file)}`);
  if (mode === 'export') return;
  fs.writeFileSync(envFile, envLines(world.env));
  const stop = () => world.close().finally(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  // Started by a test with an IPC channel: when the test lets go, everything here stops too (Windows has no SIGTERM).
  if (process.send) process.once('disconnect', stop);
  console.log(`showcase: ${mode} server ready on port ${world.port}`);
  process.send?.({ ready: true, port: world.port });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`showcase: ${error.message}`);
    process.exit(1);
  });
}
