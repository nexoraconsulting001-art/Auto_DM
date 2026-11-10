// Fills the store with demo data: products from seed/mehtamart.json and a store for each of your
// 3 newest reels. Safe to run more than once.
//
//   npm run seed                               # finds your 3 newest reels with the business's Instagram token
//   npm run seed -- <newest> <second> <third>  # or give the reel IDs yourself
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../src/config.js';
import { openRuntimeDb } from '../src/db/index.js';
import { createRepos } from '../src/repos/index.js';
import { withTenant } from '../src/tenancy.js';
import { SETTING_DEFAULTS } from '../src/repos/settings.js';
import { createSecrets } from '../src/platform/secrets.js';
import { createInstagram, forAccount } from '../src/instagram.js';

export const SEED_FILE = path.join(config.rootDir, 'seed', 'mehtamart.json');

/**
 * Loads seed data into the store. `reels` is [{ id, thumbnail_url?, permalink?, caption?, video_url? }, ...]
 * in the same order as data.reels. Safe to run again: categories and products are matched by name and reused,
 * and settings the owner already changed are kept. Returns a summary of what was created or reused.
 *
 * Seed format: { store, categories?: [{ name, slug, image_url, description, position }],
 *   products?: [{ name, price, mrp, description, images, categories: [names], featured }],
 *   reels: [{ headline, slug, keywords, dm_message, products: [names, or product objects as above] }] }
 */
export async function seedDemo({ repos }, data, reels) {
  if (reels.length < data.reels.length) throw new Error(`Need ${data.reels.length} reels, got ${reels.length}`);

  // Settings: only fill in values that are still at their defaults, so your own edits are kept.
  const current = await repos.settings.getAll();
  const updates = {};
  for (const [key, value] of Object.entries(data.store)) {
    if (key in SETTING_DEFAULTS && current[key] === SETTING_DEFAULTS[key]) updates[key] = value;
  }
  await repos.settings.update(updates);

  // The logo and accent colour live in the brand kit; keep them if the owner has set their own.
  const kit = await repos.brandKit.get();
  if (!kit.logoUrl && data.store.logo_url) {
    await repos.brandKit.save({ logoUrl: data.store.logo_url, ...(data.store.accent_color ? { colors: { accent: data.store.accent_color } } : {}) });
  }

  const summary = {
    settings: Object.keys(updates),
    categories: { created: 0, reused: 0 },
    products: { created: 0, reused: 0 },
    reels: [],
  };

  const categoryIds = new Map();
  for (const c of data.categories || []) {
    const existing = await repos.categories.findByName(c.name);
    if (existing) {
      categoryIds.set(c.name, existing.id);
      summary.categories.reused++;
      continue;
    }
    const created = await repos.categories.save(null, { ...c, visible: true });
    categoryIds.set(c.name, created.id);
    summary.categories.created++;
  }

  const productIds = new Map();
  async function ensureProduct(p) {
    if (productIds.has(p.name)) return productIds.get(p.name);
    const cats = (p.categories || []).map((n) => categoryIds.get(n)).filter(Boolean);
    const existing = await repos.products.findByName(p.name);
    let id;
    if (existing) {
      id = existing.id;
      // Add the demo categories without removing any the owner picked.
      await repos.products.addCategories(id, cats);
      summary.products.reused++;
    } else {
      const created = await repos.products.create({
        name: p.name,
        description: p.description,
        price: String(p.price),
        mrp: p.mrp ? String(p.mrp) : '',
        images: p.images,
        option_values: '',
        stock: '',
        active: true,
        featured: Boolean(p.featured),
        categoryIds: cats,
      });
      id = created.id;
      summary.products.created++;
    }
    productIds.set(p.name, id);
    return id;
  }

  const byName = new Map((data.products || []).map((p) => [p.name, p]));
  for (const p of data.products || []) await ensureProduct(p);

  for (const [i, def] of data.reels.entries()) {
    const ids = [];
    for (const item of def.products) {
      const p = typeof item === 'string' ? byName.get(item) : item;
      if (p) ids.push(await ensureProduct(p));
    }
    const reel = reels[i];
    await repos.reels.save(reel.id, {
      headline: def.headline,
      slug: def.slug,
      keywords: def.keywords,
      dm_message: def.dm_message,
      button_text: 'Shop now',
      public_reply: 'Sent you a DM 📩',
      active: true,
      permalink: reel.permalink || '',
      thumbnail_url: reel.thumbnail_url || '',
      video_url: reel.video_url || '',
      caption: reel.caption || '',
      productIds: ids,
    });
    summary.reels.push({ id: reel.id, slug: def.slug, products: ids.length });
  }
  return summary;
}

const reelInfo = (m, id = m.id) => ({
  id,
  thumbnail_url: m.thumbnail_url || m.media_url,
  permalink: m.permalink,
  caption: m.caption,
  video_url: m.media_type === 'VIDEO' ? m.media_url : '',
});

/** The newest `count` reels on the account, newest first. */
export async function newestReels(ig, count) {
  const { data = [] } = await ig.listMedia(50);
  return data
    .filter((m) => m.media_product_type === 'REELS')
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, count)
    .map((m) => reelInfo(m));
}

async function findReels(repos, data, ids) {
  const account = await repos.igAccounts.current();
  const instagram = account ? forAccount(createInstagram(config), account) : null;
  if (ids.length) {
    const reels = [];
    for (const id of ids) reels.push(instagram ? await instagram.getMedia(id).catch(() => ({ id })) : { id });
    return reels.map((m, i) => reelInfo(m, ids[i]));
  }
  if (!instagram) throw new Error('This business has no Instagram token yet. Add one (npm run tenant -- ig-token), or pass 3 reel IDs: npm run seed -- <id1> <id2> <id3>');
  const reels = await newestReels(instagram, data.reels.length);
  if (reels.length < data.reels.length) {
    throw new Error(`Found only ${reels.length} reel(s) on the account. Post ${data.reels.length} reels, or pass reel IDs: npm run seed -- <id1> <id2> <id3>`);
  }
  return reels;
}

async function main() {
  const data = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  const ids = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
  const db = await openRuntimeDb(config);
  const repos = createRepos(db, { secrets: createSecrets(config) });
  const tenant = await repos.tenants.ensure({ slug: config.defaultTenant || 'default', name: config.defaultTenantName });
  const summary = await withTenant(tenant, async () => seedDemo({ repos }, data, await findReels(repos, data, ids)));
  await db.close();

  const base = config.publicBaseUrl || `http://localhost:${config.port}`;
  console.log(`Categories: ${summary.categories.created} created, ${summary.categories.reused} already there`);
  console.log(`Products: ${summary.products.created} created, ${summary.products.reused} already there`);
  if (summary.settings.length) console.log(`Settings filled in: ${summary.settings.join(', ')}`);
  console.log('Reel stores:');
  for (const r of summary.reels) console.log(`  ${base}/r/${r.slug}  (reel ${r.id}, ${r.products} products)`);
  console.log(`\nStore: ${base}/   Shop: ${base}/shop   Admin: ${base}/admin`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`Seeding failed: ${err.message}`);
    process.exit(1);
  });
}
