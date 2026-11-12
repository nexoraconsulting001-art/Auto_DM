/**
 * Writes one store into a built-in database before the job's server opens it: the business a brand file was made for,
 * with that file's business id (the build sends it on every request), its name, a plan that includes the app, its app
 * config, one product with stock and cash on delivery on. Everything about the store comes from the brand file handed
 * in; nothing here names a brand.
 *
 * Used by server.mjs. Refuses NODE_ENV=production and DATABASE_URL: it only ever seeds a throwaway database.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
/** The plan with the Android app (PRD 5.7). */
const PLAN = 't4';
export const PRODUCT = Object.freeze({ name: 'Flow test mug', price: '499', stock: '25' });

/** The store's address name: the brand's link scheme, which is already lower-case letters and digits. */
export const slugOf = (brand) => brand.scheme;

/** Seeds an open database for one brand. Answers { tenantId, slug, productId }. */
export async function seed(db, brand, { repos, withTenant }) {
  // The build carries the brand file's business id, so the store is created with exactly that id.
  await db.query("SELECT setval(pg_get_serial_sequence('tenants', 'id'), $1, false)", [brand.tenantId]);
  const tenant = await repos.tenants.create({ slug: slugOf(brand), name: brand.name, plan: PLAN });
  if (Number(tenant.id) !== brand.tenantId) throw new Error('The seeded store did not get the brand file’s business id');
  const out = { tenantId: Number(tenant.id), slug: tenant.slug, productId: null };
  await withTenant(tenant, async () => {
    await repos.settings.update({ shipping_fee_paise: '0', free_shipping_above_paise: '0', store_name: brand.name });
    const product = await repos.products.create({ ...PRODUCT, active: 'on' });
    out.productId = Number(product.id);
    await db.query(
      `INSERT INTO payment_settings (tenant_id, mode, cod) VALUES ($1, 'managed', true)
       ON CONFLICT (tenant_id) DO UPDATE SET cod = true`,
      [tenant.id],
    );
    await db.query(
      `INSERT INTO app_configs (tenant_id, app_name, short_name, android_package, ios_bundle_id, url_scheme, shop_domain, support_email, privacy_url, apple_team_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [tenant.id, brand.name, brand.shortName, brand.android?.package ?? null, brand.ios?.bundleId ?? null, brand.scheme, brand.shopDomain, brand.supportEmail, brand.privacyUrl, brand.ios?.teamId ?? ''],
    );
  });
  return out;
}

/** Opens the built-in database at `dataDir`, migrates it, seeds the brand's store and closes it. */
export async function seedDataDir(dataDir, brand, { env = process.env, dataKey } = {}) {
  if (String(env.NODE_ENV).toLowerCase() === 'production') throw new Error('This seeds a test database: it never runs in production');
  if (env.DATABASE_URL) throw new Error('DATABASE_URL is set: the flows seed only a built-in database');
  if (!dataDir || !dataKey) throw new Error('No folder for the built-in database, or no data key');
  const [{ openDb }, { createRepos }, { createSecrets }, { withTenant }] = await Promise.all([
    load('src/db/index.js'), load('src/repos/index.js'), load('src/platform/secrets.js'), load('src/tenancy.js'),
  ]);
  const db = await openDb({ dataDir, migrate: true });
  try {
    const repos = createRepos(db, { secrets: createSecrets({ dataKey }) });
    return await seed(db, brand, { repos, withTenant });
  } finally {
    await db.close();
  }
}
