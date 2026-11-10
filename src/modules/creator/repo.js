import { ApiError } from '../../contracts/api/index.js';
import { isReservedPath } from '../../contracts/buyer-pages.js';
import { tenantId } from '../../tenancy.js';

/**
 * The creator page (PRD 8.14, migration 305): one row per business. It holds the page's address and header only; shelves and
 * their order come from the categories module, so nothing about order is kept here. Every query names tenant_id.
 */
export const CREATOR_SLUG = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const MEDIA_PATH = /^\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Names the app serves that the shared list doesn't carry yet: the review sign-in, and this page's own tiles address. */
const ALSO_TAKEN = Object.freeze(['review', '_tiles']);
const taken = (slug) => isReservedPath(slug) || ALSO_TAKEN.includes(slug);

const invalid = (field, message) => new ApiError('validation_failed', message, { fields: { [field]: message } });

/** Why a name can't be the page's address, or '' when it can. */
export function slugProblem(slug) {
  const value = String(slug ?? '').trim().toLowerCase();
  if (!CREATOR_SLUG.test(value)) return 'Use 2 to 40 lower-case letters, numbers and dashes';
  if (taken(value)) return 'That name is taken by a page of the store';
  return '';
}

export function creatorPagesRepo(db) {
  const t0 = () => tenantId();
  const select = async (runner = db) => (await runner.query('SELECT * FROM creator_pages WHERE tenant_id = $1', [t0()]))[0] ?? null;

  return {
    slugProblem,

    /** The business's page, or null when it has never saved one. */
    get: () => select(),

    /** The page a shopper may open at /<slug>: saved under that name and switched on. */
    async getLive(slug) {
      const value = String(slug ?? '').toLowerCase();
      if (!CREATOR_SLUG.test(value) || taken(value)) return null;
      const [row] = await db.query('SELECT * FROM creator_pages WHERE tenant_id = $1 AND slug = $2 AND enabled', [t0(), value]);
      return row ?? null;
    },

    /**
     * Saves the fields given; the rest stay. The first save must name the page. The photo is a file this business uploaded
     * (/media/<id>): its bytes are ours to serve, which a web link's are not.
     */
    async save(patch) {
      return db.tx(async (t) => {
        const current = await select(t);
        const slug = patch.slug ?? current?.slug;
        if (!slug) throw invalid('slug', 'Pick a name for your page first');
        const problem = slugProblem(slug);
        if (problem) throw invalid('slug', problem);

        let photo = current?.photo_media_id ?? null;
        if (patch.photoUrl !== undefined) {
          if (patch.photoUrl === '') photo = null;
          else {
            const id = MEDIA_PATH.exec(patch.photoUrl)?.[1]?.toLowerCase();
            if (!id) throw invalid('photoUrl', 'Upload the photo first');
            const [file] = await t.query('SELECT id FROM media WHERE tenant_id = $1 AND id = $2', [t0(), id]);
            if (!file) throw invalid('photoUrl', 'That photo is no longer available. Upload it again');
            photo = id;
          }
        }
        const next = {
          enabled: patch.enabled ?? current?.enabled ?? false,
          display_name: patch.displayName ?? current?.display_name ?? '',
          bio: patch.bio ?? current?.bio ?? '',
          website_url: patch.websiteUrl ?? current?.website_url ?? '',
          show_whatsapp: patch.showWhatsapp ?? current?.show_whatsapp ?? true,
          more_shelf_title: patch.moreShelfTitle ?? current?.more_shelf_title ?? 'More reels',
        };
        const [row] = await t.query(
          `INSERT INTO creator_pages (tenant_id, slug, enabled, display_name, bio, photo_media_id, website_url, show_whatsapp, more_shelf_title)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (tenant_id) DO UPDATE SET slug = EXCLUDED.slug, enabled = EXCLUDED.enabled, display_name = EXCLUDED.display_name, bio = EXCLUDED.bio,
             photo_media_id = EXCLUDED.photo_media_id, website_url = EXCLUDED.website_url, show_whatsapp = EXCLUDED.show_whatsapp,
             more_shelf_title = EXCLUDED.more_shelf_title, updated_at = now()
           RETURNING *`,
          [t0(), slug, next.enabled, next.display_name, next.bio, photo, next.website_url, next.show_whatsapp, next.more_shelf_title],
        );
        return row;
      });
    },

    /** The share preview the pages module drew for the creator page or one shelf, when there is one: { url, width, height }. */
    async sharePreview(target) {
      const [row] = await db.query('SELECT media_id, width, height FROM share_previews WHERE tenant_id = $1 AND target = $2 AND media_id IS NOT NULL', [t0(), target]);
      return row ? { url: `/media/${row.media_id}`, width: row.width, height: row.height } : null;
    },

    /** The business's own order of the creator page's blocks (5.18), or null when it has placed none: [{ block, settings }]. */
    async blocks() {
      const rows = await db.query(`SELECT block, visible, settings FROM page_blocks WHERE tenant_id = $1 AND surface = 'creator' ORDER BY position, id`, [t0()]);
      return rows.length ? rows.filter((r) => r.visible).map((r) => ({ block: r.block, settings: r.settings ?? {} })) : null;
    },
  };
}
