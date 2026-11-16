// D-12: PRD 5.16 "IDs are remapped": an export's media id is a key into the id map like every other old id, so a media id
// that is not a UUID (the spec export's 'm1') is imported under a new id, and a /media/<old id> picture that names it is
// pointed at the new media. A path or anything outside the old-id shape is still refused.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { legacyExport, world } from '../../p8/migration-import/support.js';

const reason = 'Moving the old shop to the platform';

async function withMediaId(id) {
  const source = await legacyExport();
  const old = source.tables.media[0].id;
  source.tables.media[0].id = id;
  // Every picture that named the old media names it by the new old id.
  const swap = (v) => (typeof v === 'string' ? v.replace(`/media/${old}`, `/media/${id}`) : Array.isArray(v) ? v.map(swap) : v);
  for (const rows of Object.values(source.tables)) for (const row of rows) for (const [k, v] of Object.entries(row)) row[k] = swap(v);
  return source;
}

test('D-12: a media id that is not a UUID is remapped and its pictures follow it, instead of the whole import being refused', async () => {
  const w = await world();
  const source = await withMediaId('m1');
  const report = await w.importer().run(source, { tenantId: w.target.id, startedBy: w.operatorId }, { reason });
  assert.equal(report.blocked, false);
  const t = w.target.id;
  const [media] = await w.q('SELECT id FROM media WHERE tenant_id = $1', [t]);
  assert.ok(media, 'the media is kept');
  assert.notEqual(media.id, 'm1');
  const [lamp] = await w.q(`SELECT images FROM products WHERE tenant_id = $1 AND slug = 'brass-lamp'`, [t]);
  assert.equal(lamp.images[0], `/media/${media.id}`, 'the picture points at the new media');
  const [category] = await w.q(`SELECT image_url FROM categories WHERE tenant_id = $1 AND slug = 'lamps'`, [t]);
  assert.equal(category.image_url, `/media/${media.id}`);
});

test('D-12: a path in a media id or a picture link is still refused', async () => {
  const w = await world();
  await assert.rejects(w.importer().run(await withMediaId('../m1'), { tenantId: w.target.id, startedBy: w.operatorId }, { reason }), (err) => err.migrationCode === 'refused:media.#0.id');
  const link = await withMediaId('m1');
  link.tables.products[0].images = ['/media/m1/../../secret'];
  await assert.rejects(w.importer().run(link, { tenantId: w.target.id, startedBy: w.operatorId }, { reason }), (err) => /^refused:products\.\d+\.images$/.test(err.migrationCode));
});
