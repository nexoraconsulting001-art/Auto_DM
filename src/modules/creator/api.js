import { ApiError } from '../../contracts/api/index.js';
import { PLAN_REASON } from '../../contracts/catalog.js';
import { writeAudit } from '../audit/index.js';
import { retryOnRace } from '../admin-api/errors.js';
import { storeBaseUrl } from '../admin-api/urls.js';

/**
 * The seller API for the creator page (PRD 8.14): its address and header. The owner copies `url` into their bio themselves;
 * nothing here touches an Instagram profile. `badge` says whether the page carries the Free plan's footer badge (K-64).
 */
const DEFAULTS = Object.freeze({ slug: '', enabled: false, display_name: '', bio: '', photo_media_id: null, website_url: '', show_whatsapp: true, more_shelf_title: 'More reels', updated_at: null });

export function creatorApi({ db, repos, config }) {
  const pages = () => repos.creatorPages;

  async function view(req, row) {
    const page = row ?? DEFAULTS;
    return {
      slug: page.slug,
      enabled: page.enabled,
      displayName: page.display_name,
      bio: page.bio,
      photoUrl: page.photo_media_id ? `/media/${page.photo_media_id}` : '',
      websiteUrl: page.website_url,
      showWhatsapp: page.show_whatsapp,
      moreShelfTitle: page.more_shelf_title,
      url: page.slug ? `${storeBaseUrl(req, config)}/${page.slug}` : '',
      badge: await repos.entitlements.can('badge.made_with'),
      updatedAt: page.updated_at,
    };
  }

  return {
    'creator.get': async ({ req }) => view(req, await pages().get()),
    'creator.update': async ({ body, user, req }) => {
      if (!(await repos.entitlements.can('creator_page'))) throw new ApiError('forbidden', 'The creator page isn’t on your plan.', { reason: PLAN_REASON });
      const saved = await retryOnRace(() => pages().save(body));
      await writeAudit(db, { actor: `user:${user.id}`, action: 'creator_page.saved', target: 'creator_page', details: { enabled: saved.enabled, fields: Object.keys(body).sort() } });
      return view(req, saved);
    },
    'creator.checkSlug': async ({ query }) => {
      const slug = query.slug.toLowerCase();
      const message = pages().slugProblem(slug);
      return { slug, available: !message, message };
    },
  };
}
