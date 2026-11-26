/**
 * The job's own server for the showcase (Phase 8, Q-11): both sample businesses loaded from their seed files into a new
 * built-in database with `scripts/showcase.js`'s own loader, the app and its worker running on that database with every
 * outside service a simulator from tools/sim, and a front door on the port the emulator or simulator reaches. It writes what
 * the flows need to --out as NAME=value lines. Nothing here names a business: they come from seed/showcase/manifest.json,
 * and a flow reaches one by its place in that list.
 *
 *   node tools/showcase-build/server.mjs --mode export --brands <folder>
 *       load both businesses, write <folder>/<key>/brand.json (Android) and <key>/brand-ios.json (iOS simulator), stop.
 *   node tools/showcase-build/server.mjs --mode shopper --key <key> --out <file> [--brands <folder>]
 *       the server for one business's shopper app: the front door answers as that business. With --brands the business id
 *       in each brand file must be the one loaded here, or this refuses to start (the build sends it on every request).
 *   node tools/showcase-build/server.mjs --mode owner --out <file>
 *       the server for the owner app: the front door answers as the sellers' sign-in address, one account belongs to every
 *       business, and each business has one cash on delivery order waiting.
 *
 *   PORT=3000 HOST=127.0.0.1 APP_HOST=10.0.2.2
 *
 * The businesses are loaded on an in-memory database inside this process: a database in a folder is far slower to load the
 * catalogue into, and a sample server is thrown away when the job ends anyway. The front door (a plain forwarder) is the
 * only thing on PORT; it names the business the request is for, as a domain would. Refuses NODE_ENV=production,
 * DATABASE_URL, and any provider address that is not a simulator. No secret: every key is made up for the run.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SHOPPER } from '../../apps/shopper/.maestro/support/seed.mjs';
import { OPERATOR, ShowcaseBuildError, envLines, iosBrandFile, orderNumber, ownerFlowEnv } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const ADDRESS = Object.freeze({ name: 'Test Shopper', phone: '+919800000121', line1: '1 Test Lane', line2: '', landmark: '', city: 'Pune', stateCode: '27', pincode: '411001' });
/** The platform's own sender number, for the sellers' sign-in codes: a simulator's number and the token its default account takes. */
const PLATFORM_SENDER = Object.freeze({ platformWhatsappPhoneId: 'sim-platform-number', platformWhatsappToken: 'sim-whatsapp-token' });

/** A product a shopper can buy straight away: active, in stock, with no option to choose first. */
async function plainProduct(db, tenantId) {
  const [row] = await db.platform.query(
    `SELECT p.id, p.slug, p.name, p.price_paise FROM products p
      WHERE p.tenant_id = $1 AND p.active AND p.in_stock AND (p.stock IS NULL OR p.stock > 0)
        AND NOT EXISTS (SELECT 1 FROM product_options o WHERE o.tenant_id = p.tenant_id AND o.product_id = p.id)
      ORDER BY p.id LIMIT 1`,
    [tenantId],
  );
  if (!row) throw new ShowcaseBuildError(`Business ${tenantId} has no product a shopper can buy without choosing an option`);
  return row;
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

/** The business id each build carries must be the one this server loaded the business as, or the app's requests are refused. Throws naming the key only. */
export function assertBrandIds(loaded, brandsDir) {
  for (const business of loaded) {
    const brand = JSON.parse(fs.readFileSync(path.join(brandsDir, business.key, 'brand.json'), 'utf8'));
    if (brand.tenantId !== business.tenantId) throw new ShowcaseBuildError(`The brand file of "${business.key}" is for business ${brand.tenantId}, but this server loaded it as ${business.tenantId}`);
  }
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
 * The front door: every request on `listen` goes to the app with its Host replaced by `host`, which is how the app tells which
 * business (or the sellers' sign-in address) a request is for. An emulator reaches the machine at 10.0.2.2, a name no business owns.
 */
export function frontDoor({ target, host, listen }) {
  const server = http.createServer((req, res) => {
    const headers = { ...req.headers, host, 'x-forwarded-host': host };
    const forward = http.request({ host: '127.0.0.1', port: target, path: req.url, method: req.method, headers }, (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    forward.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('The showcase app did not answer.');
    });
    req.pipe(forward);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listen.port, listen.host, () => resolve(server));
  });
}

/**
 * Starts the world. Answers { env, port, brands, close }: `env` is what the flows are told, `brands` the brand files written
 * when `brandsOut` is given; `manifest` is another manifest file than the committed one (tests use a small one). mode is
 * 'export' (nothing listens), 'shopper' (needs `key`) or 'owner'.
 */
export async function startShowcaseServer({ mode, key = '', brandsDir = '', brandsOut = '', manifest = '', env = process.env } = {}) {
  if (!['export', 'shopper', 'owner'].includes(mode)) throw new ShowcaseBuildError('The mode is export, shopper or owner');
  if (String(env.NODE_ENV).toLowerCase() === 'production') throw new ShowcaseBuildError('This starts simulators: it never runs in production');
  if (env.DATABASE_URL) throw new ShowcaseBuildError('DATABASE_URL is set: the showcase runs only on a built-in database');
  if (mode === 'shopper' && !key) throw new ShowcaseBuildError('The shopper server needs --key: the business whose app is under test');
  const port = Number(env.PORT) || 3000;
  const listenHost = env.HOST || '127.0.0.1';
  const appHost = env.APP_HOST || '10.0.2.2';

  let db = null;
  let world = null;
  let door = null;
  const close = async () => {
    await new Promise((resolve) => { if (door) { door.closeAllConnections(); door.close(resolve); } else resolve(); });
    await world?.close();
    await db?.close();
  };
  try {
    const [{ openDb }, { withTenant }, { changeOrder }, showcase, { openShowcaseWorld }, { createRepos }, { createSecrets }] = await Promise.all([
      load('src/db/index.js'), load('src/tenancy.js'), load('src/modules/orders/state.js'), load('scripts/showcase.js'), load('tools/sim/activity/world.mjs'),
      load('src/repos/index.js'), load('src/platform/secrets.js'),
    ]);
    showcase.assertShowcaseAllowed(env);
    const businesses = showcase.loadShowcase({ plantSeed: env.SHOWCASE_PLANT_SEED || '', ...(manifest ? { manifest } : {}) });
    db = await openDb({ migrate: true });
    world = await openShowcaseWorld({ db, env, overrides: PLATFORM_SENDER });
    const loaded = await showcase.seedShowcase({ world, businesses });
    const brands = brandsOut ? await writeBrandFiles({ world, loaded, folder: brandsOut }) : [];
    if (brandsDir) assertBrandIds(loaded, brandsDir);
    if (mode === 'export') {
      await close();
      return { env: {}, port: 0, brands, close: async () => {} };
    }

    const repos = createRepos(db, { secrets: createSecrets({ dataKey: world.config.dataKey }) });
    const seeded = [];
    for (const [i, business] of loaded.entries()) {
      const tenant = await repos.tenants.getBySlug(business.slug);
      const product = await plainProduct(db, tenant.id);
      const entry = { key: business.key, slug: business.slug, tenantId: Number(tenant.id), name: tenant.name, product, order: null };
      // The seed leaves cash on delivery off; the flows place a cash on delivery order, so the business under test takes it.
      if (mode === 'shopper' && business.key === key) await db.platform.query('UPDATE payment_settings SET cod = true WHERE tenant_id = $1', [tenant.id]);
      if (mode === 'owner') {
        await withTenant(tenant, async () => {
          entry.order = await codOrder(db, { tenant, product, number: orderNumber(i + 1), changeOrder });
          await db.query("INSERT INTO users (tenant_id, name, phone, email, password_hash, role) VALUES ($1, $2, $3, '', NULL, 'owner')", [tenant.id, OPERATOR.name, OPERATOR.phone]);
        });
      }
      seeded.push(entry);
    }
    const chosen = seeded.find((entry) => entry.key === key);
    if (mode === 'shopper' && !chosen) throw new ShowcaseBuildError(`The manifest has no business with the key "${key}"`);

    const domain = world.config.platformDomain;
    door = await frontDoor({ target: world.port, host: mode === 'shopper' ? `${chosen.slug}.${domain}` : `app.${domain}`, listen: { port, host: listenHost } });
    const apiUrl = `http://127.0.0.1:${door.address().port}`;
    const flows = mode === 'owner'
      ? ownerFlowEnv(seeded, { apiUrl, whatsappUrl: world.sims.whatsapp.url, appHost })
      : shopperFlowEnv(chosen, { apiUrl, appHost, simUrls: { whatsapp: world.sims.whatsapp.url, razorpay: world.sims.razorpay.url }, brandsDir: brandsDir || brandsOut });
    return { env: flows, port: door.address().port, brands, seeded, world, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

/** What the shopper flows are told: the app's id and scheme from the business's own brand file when there is one, the product the seed made, local addresses. */
export function shopperFlowEnv(chosen, { apiUrl, appHost, simUrls = {}, brandsDir = '' }) {
  const file = brandsDir ? path.join(brandsDir, chosen.key, 'brand.json') : '';
  const brand = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
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
  if (mode === 'export') process.exit(0);
  fs.writeFileSync(envFile, envLines(world.env));
  const stop = () => world.close().finally(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.log(`showcase: ${mode} server ready on port ${world.port}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`showcase: ${error.message}`);
    process.exit(1);
  });
}
