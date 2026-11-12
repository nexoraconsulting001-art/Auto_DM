/**
 * Writes the flows' made-up world (world.mjs) into a built-in database before the job's server opens it: the
 * businesses (on plan t3, which has DM automations, checkout and payments), one owner account per flow (no password:
 * each proves the number with a WhatsApp code), a product with stock, cash on delivery on, and one cash on delivery
 * order per business waiting to be confirmed. The order is made the way checkout makes one: inserted, then moved to
 * new and cash due through the order state machine. Business a takes money in its own gateway account, connected with
 * a made-up key (encrypted with the data key the server is then started with), so the payments flow replaces it.
 *
 * Used by server.mjs. Refuses NODE_ENV=production and DATABASE_URL: it only ever seeds a throwaway database.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ADDRESS, BUSINESSES, ORDERS, PRODUCT, SELLERS } from './world.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const PLAN = 't3';
/** Made up, and too short to be a real key. The payments flow replaces it. */
export const SEEDED_KEY = Object.freeze({ keyId: 'rzp_test_e2eold', keySecret: 'seeded-secret-not-real' });

/** Seeds an open database. Answers { businesses: { a: { id, slug } }, orders: { a: { id, number } } }. */
export async function seed(db, { repos, withTenant, changeOrder }) {
  const out = { businesses: {}, orders: {} };
  for (const [key, spec] of Object.entries(BUSINESSES)) {
    const tenant = (await repos.tenants.getBySlug(spec.slug)) ?? (await repos.tenants.create({ slug: spec.slug, name: spec.name, plan: PLAN }));
    out.businesses[key] = { id: Number(tenant.id), slug: spec.slug };
    await withTenant(tenant, async () => {
      await repos.settings.update({ shipping_fee_paise: '0', free_shipping_above_paise: '0', store_name: spec.name });
      const product = await repos.products.create({ ...PRODUCT, active: 'on' });
      await db.query(
        `INSERT INTO payment_settings (tenant_id, mode, cod) VALUES ($1, 'managed', true)
         ON CONFLICT (tenant_id) DO UPDATE SET cod = true`,
        [tenant.id],
      );
      if (key === 'a') {
        await repos.gatewayKeys.save('razorpay', SEEDED_KEY, 'seed');
        await db.query("UPDATE payment_settings SET mode = 'own', own_connection = 'keys', own_account_id = $2 WHERE tenant_id = $1", [tenant.id, SEEDED_KEY.keyId]);
      }
      if (ORDERS[key]) out.orders[key] = await codOrder(db, tenant, product, ORDERS[key], changeOrder);
    });
  }
  for (const [name, seller] of Object.entries(SELLERS)) {
    for (const key of seller.businesses) {
      const tenant = await repos.tenants.getBySlug(BUSINESSES[key].slug);
      await withTenant(tenant, () => db.query(
        `INSERT INTO users (tenant_id, name, phone, email, password_hash, role) VALUES ($1, $2, $3, '', '!', 'owner')`,
        [tenant.id, `Flow ${name}`, seller.phone],
      ));
    }
  }
  return out;
}

async function codOrder(db, tenant, product, spec, changeOrder) {
  return db.tx(async (t) => {
    const [order] = await t.query(
      `INSERT INTO orders (tenant_id, order_number, public_token, flow, payment_mode, customer_name, phone, address, city, state, pincode,
         subtotal_paise, discount_paise, shipping_paise, tax_paise, total_paise, advance_paise, balance_paise, idempotency_key, shipping_address)
       VALUES ($1, $2, $3, 'checkout', 'cod', $4, $5, $6, $7, 'Maharashtra', $8, $9, 0, 0, 0, $9, 0, $9, $10, $11) RETURNING id`,
      [tenant.id, spec.number, crypto.randomBytes(12).toString('base64url'), ADDRESS.name, ADDRESS.phone, ADDRESS.line1, ADDRESS.city, ADDRESS.pincode,
        spec.pricePaise, crypto.randomUUID(), JSON.stringify(ADDRESS)],
    );
    await t.query(
      'INSERT INTO order_items (tenant_id, order_id, product_id, name, price_paise, qty) VALUES ($1, $2, $3, $4, $5, 1)',
      [tenant.id, order.id, product.id, PRODUCT.name, spec.pricePaise],
    );
    await changeOrder(t, order.id, { payment: 'cod_due', fulfilment: 'new', actor: 'shopper', reason: 'Cash on delivery, phone verified' });
    return { id: Number(order.id), number: spec.number };
  });
}

/** Opens the built-in database at `dataDir`, migrates it, seeds it and closes it. `dataKey` is the server's DATA_KEY. */
export async function seedDataDir(dataDir, { env = process.env, dataKey } = {}) {
  if (String(env.NODE_ENV).toLowerCase() === 'production') throw new Error('This seeds a test database: it never runs in production');
  if (env.DATABASE_URL) throw new Error('DATABASE_URL is set: the flows seed only a built-in database');
  if (!dataDir || !dataKey) throw new Error('No folder for the built-in database, or no data key');
  const [{ openDb }, { createRepos }, { createSecrets }, { withTenant }, { changeOrder }] = await Promise.all([
    load('src/db/index.js'), load('src/repos/index.js'), load('src/platform/secrets.js'), load('src/tenancy.js'), load('src/modules/orders/state.js'),
  ]);
  const db = await openDb({ dataDir, migrate: true });
  try {
    const repos = createRepos(db, { secrets: createSecrets({ dataKey }) });
    return await seed(db, { repos, withTenant, changeOrder });
  } finally {
    await db.close();
  }
}
