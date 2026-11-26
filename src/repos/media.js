import crypto from 'node:crypto';
import { tenantId } from '../tenancy.js';
import { ValidationError } from '../util.js';

const UPLOAD_PATH = /^\/media\/(.*)$/i;
const FILE_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * The one ownership check for every stored link to an uploaded file: product images, brand kit logos and favicon, category
 * images and page block pictures. A business can never link to another business's data, and /media/<id> is that data, so
 * every file id a /media link names (the file itself or a size of it, such as /media/<id>/card) must be a file this business
 * uploaded. Web links (http, https) are addresses on the web and pass; a /media link that names no file id names nothing.
 * Refuses with a ValidationError naming `field` (400 validation_failed), as the landing page cover and the creator photo do.
 * `q` is the database or the open transaction; `links` is one link or a list.
 */
export async function requireOwnMedia(q, field, links) {
  const ids = new Set();
  for (const link of [links].flat()) {
    const path = UPLOAD_PATH.exec(String(link ?? '').trim())?.[1];
    for (const id of path?.match(FILE_ID) ?? []) ids.add(id.toLowerCase());
  }
  if (!ids.size) return;
  const own = await q.query('SELECT id FROM media WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [tenantId(), [...ids]]);
  if (own.length !== ids.size) throw notOwned(field);
}

function notOwned(field) {
  const message = 'Upload the image first';
  return Object.assign(new ValidationError(message), { fields: { [field]: message } });
}

export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** Uploaded files: the bytes live in the storage module, the database keeps the key and type. */
export function mediaRepo(db, { storage }) {
  return {
    async save(buffer, mime) {
      const tid = tenantId();
      const id = crypto.randomUUID();
      const key = `t/${tid}/media/${id}`;
      await storage.put(key, buffer, mime);
      try {
        await db.query('INSERT INTO media (id, tenant_id, mime, size, storage_key) VALUES ($1, $2, $3, $4, $5)', [
          id, tid, mime, buffer.length, key,
        ]);
      } catch (err) {
        await storage.remove(key).catch(() => {});
        throw err;
      }
      return id;
    },
    /** Returns { mime, data } or null. */
    async get(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const [row] = await db.query('SELECT mime, storage_key FROM media WHERE tenant_id = $1 AND id = $2', [tenantId(), id]);
      if (!row) return null;
      const data = await storage.get(row.storage_key);
      return data ? { mime: row.mime, data } : null;
    },
  };
}
