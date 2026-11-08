import crypto from 'node:crypto';
import { tenantId } from '../tenancy.js';

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
