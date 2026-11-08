import { ValidationError, slugify } from '../util.js';
import { tenantId } from '../tenancy.js';

export function normalizeCategory(input) {
  const name = String(input.name ?? '').trim();
  if (!name) throw new ValidationError('Name is required');
  if (name.length > 60) throw new ValidationError('Name must be 60 characters or fewer');
  const slug = slugify(input.slug || name);
  if (!slug) throw new ValidationError('Add a name with letters or numbers');
  const image_url = String(input.image_url ?? '').trim();
  if (image_url && !/^(https?:\/\/|\/media\/)/i.test(image_url)) throw new ValidationError('Image must be an uploaded file or an http(s) link');
  const position = Number.parseInt(input.position, 10);
  return {
    name,
    slug,
    image_url,
    description: String(input.description ?? '').trim().slice(0, 400),
    position: Number.isFinite(position) ? position : 0,
    visible: input.visible === true || input.visible === 'on' || input.visible === 'true',
  };
}

export function categoriesRepo(db) {
  const withCounts = `c.*, (SELECT count(*)::int FROM product_categories pc JOIN products p ON p.tenant_id = pc.tenant_id AND p.id = pc.product_id
                             WHERE pc.tenant_id = c.tenant_id AND pc.category_id = c.id AND p.active) AS product_count`;
  return {
    async list({ visibleOnly = false } = {}) {
      return db.query(
        `SELECT ${withCounts} FROM categories c WHERE c.tenant_id = $1 AND (NOT $2 OR c.visible) ORDER BY c.position, c.name`,
        [tenantId(), visibleOnly],
      );
    },
    async get(id) {
      const [row] = await db.query(`SELECT ${withCounts} FROM categories c WHERE c.tenant_id = $1 AND c.id = $2`, [tenantId(), Number(id) || 0]);
      return row || null;
    },
    async getBySlug(slug, { visibleOnly = true } = {}) {
      const [row] = await db.query(
        `SELECT ${withCounts} FROM categories c WHERE c.tenant_id = $1 AND c.slug = $2 AND (NOT $3 OR c.visible)`,
        [tenantId(), String(slug), visibleOnly],
      );
      return row || null;
    },
    async findByName(name) {
      const [row] = await db.query('SELECT * FROM categories WHERE tenant_id = $1 AND lower(name) = lower($2)', [tenantId(), String(name)]);
      return row || null;
    },
    async save(id, input) {
      const c = normalizeCategory(input);
      const t = tenantId();
      const [taken] = await db.query(
        'SELECT 1 FROM categories WHERE tenant_id = $1 AND slug = $2 AND ($3::int IS NULL OR id <> $3)',
        [t, c.slug, id ? Number(id) : null],
      );
      if (taken) throw new ValidationError(`The link name “${c.slug}” is already used by another category`);
      if (id) {
        const [row] = await db.query(
          `UPDATE categories SET name = $3, slug = $4, image_url = $5, description = $6, position = $7, visible = $8
           WHERE tenant_id = $1 AND id = $2 RETURNING *`,
          [t, Number(id), c.name, c.slug, c.image_url, c.description, c.position, c.visible],
        );
        if (!row) throw new ValidationError('Category not found');
        return row;
      }
      const [row] = await db.query(
        `INSERT INTO categories (tenant_id, name, slug, image_url, description, position, visible)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [t, c.name, c.slug, c.image_url, c.description, c.position, c.visible],
      );
      return row;
    },
    /** Removes the category; its products stay in the catalog. */
    async remove(id) {
      await db.query('DELETE FROM categories WHERE tenant_id = $1 AND id = $2', [tenantId(), Number(id)]);
    },
  };
}
