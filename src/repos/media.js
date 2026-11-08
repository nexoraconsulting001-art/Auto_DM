import { tenantId } from '../tenancy.js';

export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export function mediaRepo(db) {
  return {
    async save(buffer, mime) {
      const [row] = await db.query('INSERT INTO media (tenant_id, mime, data, size) VALUES ($1, $2, $3, $4) RETURNING id', [
        tenantId(),
        mime,
        buffer,
        buffer.length,
      ]);
      return row.id;
    },
    async get(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const [row] = await db.query('SELECT mime, data FROM media WHERE tenant_id = $1 AND id = $2', [tenantId(), id]);
      return row || null;
    },
  };
}
