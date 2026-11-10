// The Phase 3 tables: fenced per business, linked only within a business, indexed for their keys, money in bigint paise, and
// the migrations run on a database that already holds Phase 2 data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MIGRATIONS_DIR, runMigrations } from '../../../src/db/index.js';
import { withTenant } from '../../../src/tenancy.js';
import { openTestDb, setup } from '../../helpers.js';

const BUSINESS_TABLES = [
  'product_options', 'product_images', 'product_variants', 'catalog_settings', 'import_jobs', 'import_items', 'site_adapters', 'product_checks',
  'page_settings', 'share_previews', 'page_blocks', 'category_reels', 'category_rules', 'category_reel_removals', 'theme_site_reads',
  'creator_pages', 'lead_forms', 'lead_consent_texts', 'leads', 'lead_consents', 'lead_downloads', 'customisation_requests',
];

async function twoBusinesses() {
  const world = await setup();
  const a = world.tenant;
  const b = await world.platform.tenants.create({ slug: 'beta-store', name: 'Beta' });
  return { ...world, a, b };
}

const one = async (db, tenant, sql, params) => (await withTenant(tenant, () => db.query(sql, params)))[0];
const product = (db, tenant, name, extra = {}) => one(db, tenant,
  `INSERT INTO products (tenant_id, name, slug, price_paise, external_url) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
  [tenant.id, name, name.toLowerCase().replace(/\W+/g, '-'), extra.price ?? 49900, extra.url ?? '']);

test('every Phase 3 business table has row-level security, its policy and a tenant_id', async () => {
  const { db } = await setup();
  for (const table of BUSINESS_TABLES) {
    const [row] = await db.query(
      `SELECT c.relrowsecurity AS secured, (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = $1 AND p.policyname = 'tenant_fence') AS policies,
              (SELECT count(*)::int FROM information_schema.columns i WHERE i.table_name = $1 AND i.column_name = 'tenant_id') AS tenant_column
       FROM pg_class c WHERE c.oid = format('public.%I', $1::text)::regclass`,
      [table],
    );
    assert.deepEqual(row, { secured: true, policies: 1, tenant_column: 1 }, table);
  }
});

test('every foreign key on a Phase 3 table has an index its lookups and cascades can use', async () => {
  const { db } = await setup();
  const tables = [...BUSINESS_TABLES, 'products', 'reels', 'media'];
  const foreign = await db.query(`SELECT conrelid::regclass::text AS tbl, conname, conkey FROM pg_constraint WHERE contype = 'f' AND conrelid = ANY($1::regclass[])`, [tables]);
  const indexes = await db.query(`SELECT indrelid::regclass::text AS tbl, string_to_array(indkey::text, ' ')::int[] AS columns FROM pg_index WHERE indrelid = ANY($1::regclass[]) AND indpred IS NULL`, [tables]);
  assert.ok(foreign.length >= 30, `found ${foreign.length}`);
  for (const fk of foreign.filter((f) => BUSINESS_TABLES.includes(f.tbl) || /cover|_fk$/.test(f.conname))) {
    const key = fk.conkey.map(Number);
    if (key.length === 1 && fk.tbl !== 'customisation_requests') continue; // the tenant_id reference, which every table's own key begins with
    const covered = indexes.some((index) => index.tbl === fk.tbl && index.columns.length >= key.length && key.every((_c, i) => key.includes(index.columns[i])));
    assert.ok(covered, `${fk.tbl} ${fk.conname}`);
  }
});

test('K-01: two businesses can save the same address; each sees only its own, and one business can\'t hold it twice', async () => {
  const { db, a, b } = await twoBusinesses();
  await product(db, a, 'Pot A', { url: 'https://x.example/p/1' });
  await product(db, b, 'Pot B', { url: 'https://x.example/p/1' });
  assert.deepEqual((await withTenant(a, () => db.query('SELECT name FROM products'))).map((r) => r.name), ['Pot A']);
  await assert.rejects(() => product(db, a, 'Pot A again', { url: 'https://x.example/p/1' }), /duplicate key/i);
});

test('nothing in the catalog, pages, categories or leads can link to another business\'s row', async () => {
  const { db, a, b } = await twoBusinesses();
  const theirs = await product(db, a, 'Theirs');
  await assert.rejects(() => one(db, b, 'INSERT INTO product_variants (tenant_id, product_id, price_paise) VALUES ($1, $2, 100) RETURNING id', [b.id, theirs.id]), /foreign key/i);
  await assert.rejects(() => one(db, b, 'INSERT INTO product_options (tenant_id, product_id, position, name) VALUES ($1, $2, 0, $3) RETURNING id', [b.id, theirs.id, 'Size']), /foreign key/i);
  const [media] = await withTenant(a, () => db.query(`INSERT INTO media (tenant_id, mime, size, storage_key) VALUES ($1, 'image/png', 1, 'k') RETURNING id`, [a.id]));
  const mine = await product(db, b, 'Mine');
  await assert.rejects(() => one(db, b, 'INSERT INTO product_images (tenant_id, product_id, position, media_id) VALUES ($1, $2, 0, $3) RETURNING id', [b.id, mine.id, media.id]), /foreign key/i, 'another business\'s file');

  const page = await one(db, a, `INSERT INTO reels (tenant_id, ig_media_id, slug) VALUES ($1, '1789', 'brunch') RETURNING id`, [a.id]);
  const category = await one(db, b, `INSERT INTO categories (tenant_id, name, slug) VALUES ($1, 'Bottles', 'bottles') RETURNING id`, [b.id]);
  await assert.rejects(() => one(db, b, 'INSERT INTO category_reels (tenant_id, category_id, page_id, position) VALUES ($1, $2, $3, 0) RETURNING page_id', [b.id, category.id, page.id]), /foreign key/i);
  const text = await one(db, a, `INSERT INTO lead_consent_texts (tenant_id, version, body, channels) VALUES ($1, 1, 'I agree that A may contact me by WhatsApp.', '{whatsapp}') RETURNING id`, [a.id]);
  await assert.rejects(() => one(db, b, `INSERT INTO leads (tenant_id, first_name, phone, source, consent_text_id) VALUES ($1, 'Asha', '+919320001717', 'landing', $2) RETURNING id`, [b.id, text.id]), /foreign key/i);
  assert.deepEqual(await withTenant(b, () => db.query('SELECT id FROM reels')), [], 'RLS hides the other business\'s page');
});

test('money is bigint paise, an MRP below the price is refused, and amounts past 32 bits fit', async () => {
  const { db, a } = await twoBusinesses();
  const types = await db.query(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE column_name LIKE '%paise' AND table_name IN ('products', 'product_variants', 'product_checks')`);
  assert.ok(types.length >= 5);
  for (const t of types) assert.equal(t.data_type, 'bigint', `${t.table_name}.${t.column_name}`);
  await assert.rejects(() => one(db, a, `INSERT INTO products (tenant_id, name, slug, price_paise, mrp_paise) VALUES ($1, 'Pot', 'pot', 129900, 99900) RETURNING id`, [a.id]), /check constraint/i, 'K-02');
  const big = await one(db, a, `INSERT INTO products (tenant_id, name, slug, price_paise) VALUES ($1, 'Car', 'car', 3000000000) RETURNING price_paise`, [a.id]);
  assert.equal(big.price_paise, 3000000000);
  await assert.rejects(() => one(db, a, `INSERT INTO products (tenant_id, name, slug, price_paise) VALUES ($1, 'Misread', 'misread', 9999999999900) RETURNING id`, [a.id]), /check constraint/i, 'a misread price costs that product');
  const p = await product(db, a, 'Pot');
  await assert.rejects(() => one(db, a, 'INSERT INTO product_variants (tenant_id, product_id, price_paise, mrp_paise) VALUES ($1, $2, 500, 400) RETURNING id', [a.id, p.id]), /check constraint/i);
  await assert.rejects(() => one(db, a, 'INSERT INTO product_images (tenant_id, product_id, position, source_url) VALUES ($1, $2, 6, $3) RETURNING id', [a.id, p.id, 'https://x.example/7.png']), /check constraint/i, 'at most 6 images');
});

test('leads hold a first name, one contact and the consent given, and no column for an IP, device or message', async () => {
  const { db, a } = await twoBusinesses();
  const columns = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name IN ('leads', 'lead_consents')`)).map((r) => r.column_name);
  assert.deepEqual(columns.filter((c) => /ip|agent|device|message|address|city/.test(c)), []);
  const text = await one(db, a, `INSERT INTO lead_consent_texts (tenant_id, version, body, channels) VALUES ($1, 1, 'I agree that A may contact me by WhatsApp.', '{whatsapp}') RETURNING id`, [a.id]);
  await assert.rejects(() => one(db, a, `INSERT INTO leads (tenant_id, first_name, source, consent_text_id) VALUES ($1, 'Asha', 'landing', $2) RETURNING id`, [a.id, text.id]), /check constraint/i, 'K-55: a contact is required');
  await assert.rejects(() => one(db, a, `INSERT INTO leads (tenant_id, first_name, phone, source, consent_text_id) VALUES ($1, 'Asha', '93200 01717', 'landing', $2) RETURNING id`, [a.id, text.id]), /check constraint/i, 'international format');
  await assert.rejects(() => withTenant(a, () => db.query(`UPDATE lead_consent_texts SET body = 'changed wording here' WHERE tenant_id = $1`, [a.id])), /permission denied/i, 'a consent wording is never changed');
});

test('platform-only tables are out of reach of business code', async () => {
  const { db, a } = await twoBusinesses();
  await assert.rejects(() => withTenant(a, () => db.query('SELECT * FROM fetch_hosts')), /permission denied/i);
  await assert.rejects(() => withTenant(a, () => db.query('SELECT * FROM customisation_requests')), /permission denied/i);
  await db.platform.query(`INSERT INTO customisation_requests (tenant_id, summary, decision, alternative, level) VALUES ($1, 'Custom script on checkout', 'alternative', 'A block from the library', 3)`, [a.id]);
  await assert.rejects(() => db.platform.query(`INSERT INTO customisation_requests (tenant_id, summary, decision) VALUES ($1, 'x', 'alternative')`, [a.id]), /check constraint/i, 'F-100: an alternative must be named');
});

test('the Phase 3 migrations run on a database holding Phase 2 data, and keep its products and reels', async () => {
  const before = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-p2-'));
  try {
    for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^[0-2]\d{2}_/.test(f))) fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(before, file));
    const db = await openTestDb({ migrate: false });
    await runMigrations(db, before);
    const [{ id: tenant }] = await db.platform.query(`INSERT INTO tenants (slug, name) VALUES ('old-shop', 'Old shop') RETURNING id`);
    const [{ id: media }] = await db.platform.query(`INSERT INTO media (tenant_id, mime, size, storage_key) VALUES ($1, 'image/png', 1, 'k') RETURNING id`, [tenant]);
    await db.platform.query(
      `INSERT INTO products (tenant_id, name, slug, price_paise, mrp_paise, images) VALUES ($1, 'Pot', 'pot', 49900, 49900, $2), ($1, 'Mug', 'mug', 19900, 9900, '[]')`,
      [tenant, JSON.stringify([`/media/${media}`, 'https://old.example/pot.png', 'javascript:alert(1)'])],
    );
    await db.platform.query(`INSERT INTO reels (tenant_id, ig_media_id, slug, headline) VALUES ($1, '1789', 'brunch', 'Brunch')`, [tenant]);
    const applied = await runMigrations(db);
    assert.ok(applied.includes('300_catalog.sql') && applied.includes('307_plan_features.sql'), applied.join(','));
    const images = await db.platform.query('SELECT position, media_id, source_url FROM product_images ORDER BY position');
    assert.deepEqual(images.map((i) => [i.position, i.media_id, i.source_url]), [[0, media, ''], [1, null, 'https://old.example/pot.png']]);
    const products = await db.platform.query('SELECT name, mrp_paise, in_stock, source, price_manual FROM products ORDER BY name');
    assert.deepEqual(products, [{ name: 'Mug', mrp_paise: null, in_stock: true, source: 'manual', price_manual: true }, { name: 'Pot', mrp_paise: 49900, in_stock: true, source: 'manual', price_manual: true }]);
    const [reel] = await db.platform.query('SELECT id, kind, channel FROM reels');
    assert.ok(reel.id > 0);
    assert.deepEqual([reel.kind, reel.channel], ['reel', 'instagram']);
    await db.close();
  } finally {
    fs.rmSync(before, { recursive: true, force: true });
  }
});
