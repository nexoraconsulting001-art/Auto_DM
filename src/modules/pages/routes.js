import { BUYER_ROUTES, PREVIEW_CRAWLERS } from '../../contracts/buyer-pages.js';
import { reportError } from '../../platform/log.js';
import { gzipOnEnd, loadBuyerLayout, notFoundPage, sendBuyerPage } from '../../views/buyer/index.js';
import { storeBaseUrl } from '../admin-api/urls.js';
import { createMediaRefresher } from './media.js';
import { createSharePreviews } from './share.js';
import { mountImageVariants } from './variants.js';
import { landingPageView } from './view.js';

/**
 * The buyer routes this module owns (BUYER_ROUTES): the landing page at /r/<slug>, which is the DM link and answers 200 with
 * no redirect (K-32); the guard in front of a landing page's product page; and robots.txt. Everything is rendered on the
 * server from the database: no outside call is made while the shopper waits. Visits and taps are counted by the traffic module,
 * which adds its script to the page on the way out and loads a seller's pixels only when the consent interface says yes.
 */

const TEAM = new Set(['owner', 'manager', 'staff']);
const TRUST_ICONS = ['truck', 'shield', 'chat'];
const SLUG = /^[\w-]{1,120}$/;
const CAMPAIGN = /^[\w.-]{1,80}$/;

/** Crawlers that fetch a page to draw its preview are named, so a stricter rule for everyone else never shuts them out (8.12). */
const PREVIEW_AGENTS = ['facebookexternalhit', 'facebookcatalog', 'meta-externalagent', 'Twitterbot', 'WhatsApp', 'LinkedInBot', 'Slackbot', 'TelegramBot', 'Discordbot'];
const PRIVATE_PATHS = ['/admin', '/api/', '/account', '/login', '/logout', '/signup', '/checkout', '/order/', '/lead', '/_t/'];
export const ROBOTS_TXT = [
  ...PREVIEW_AGENTS.flatMap((agent) => [`User-agent: ${agent}`, 'Allow: /', '']),
  'User-agent: *',
  ...PRIVATE_PATHS.map((path) => `Disallow: ${path}`),
  'Allow: /',
  '',
].join('\n');

export function mountBuyerRoutes(app, ctx) {
  const { repos, config, ig } = ctx;
  const previews = createSharePreviews(ctx);
  const refreshMedia = createMediaRefresher({ repos, ig });

  async function notFound(req, res, message) {
    const { theme, business } = await loadBuyerLayout(repos);
    gzipOnEnd(req, res);
    return sendBuyerPage(res, notFoundPage({ theme, business, message }), { status: 404 });
  }

  /** A block another module draws on this page (the lead form, 8.15): that module lists it in buyerBlocks. It never takes the page down. */
  async function blockFromOwner(name, context) {
    for (const module of ctx.modules ?? []) {
      const draw = module.buyerBlocks?.[name];
      if (typeof draw !== 'function') continue;
      try {
        return (await draw(context, ctx)) ?? '';
      } catch (err) {
        reportError(err, { msg: 'page.block_failed', block: name });
        return '';
      }
    }
    return '';
  }

  mountImageVariants(app, ctx);

  app.get(BUYER_ROUTES.robots.path, (_req, res) => {
    res.set('Cache-Control', 'public, max-age=3600').type('text/plain').send(ROBOTS_TXT);
  });

  app.get(BUYER_ROUTES.landing.path, async (req, res) => {
    const slug = String(req.params.slug);
    const [layout, page] = await Promise.all([loadBuyerLayout(repos), SLUG.test(slug) ? repos.landingPages.getBySlug(slug) : null]);
    if (!page || !page.active) {
      gzipOnEnd(req, res);
      return sendBuyerPage(res, notFoundPage({ theme: layout.theme, business: layout.business, message: 'This page isn’t open right now.' }), { status: 404 });
    }

    const [pageSettings, blocks, whatsappAllowed, utmEnabled, sellsHere] = await Promise.all([
      repos.pageSettings.get(),
      repos.pageBlocks.layout('landing'),
      repos.entitlements.can('whatsapp_order'),
      repos.landingPages.utmEnabled(),
      repos.entitlements.can('store.checkout'),
    ]);
    const shown = new Set(blocks.blocks.filter((b) => b.visible !== false).map((b) => b.block));
    const [more, preview, leadForm] = await Promise.all([
      shown.has('more_reels') && pageSettings.more_reels ? repos.landingPages.moreReels(page) : null,
      previews.forPage(page, layout.theme).catch(() => null),
      shown.has('lead_form') ? blockFromOwner('lead_form', { surface: 'landing', page, theme: layout.theme, business: layout.business, req }) : '',
    ]);

    // The seller's own lists still read the Phase 0 visit count. Previews, the team and crawlers aren't visits (K-38).
    const crawler = PREVIEW_CRAWLERS.test(req.get('user-agent') ?? '');
    if (!req.query.preview && !TEAM.has(req.user?.role) && !crawler) {
      await repos.landingPages.recordVisit(page.ig_media_id, typeof req.query.src === 'string' ? req.query.src.replace(/[^\w-]/g, '') : '').catch((err) => reportError(err, { msg: 'page.visit_failed' }));
    }
    refreshMedia(page);

    const base = storeBaseUrl(req, config);
    const campaign = typeof req.query.utm_campaign === 'string' && CAMPAIGN.test(req.query.utm_campaign) ? req.query.utm_campaign : '';
    // The trust row's default is the store's own promises, which only a business that sells here has made.
    const trustItems = sellsHere ? String(layout.settings.trust_points ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).map((label, i) => ({ label, icon: TRUST_ICONS[i] })) : [];
    const view = landingPageView({
      page,
      layout,
      blocks: blocks.blocks,
      pageUrl: `${base}/r/${encodeURIComponent(page.slug)}`,
      preview: preview ? { url: `${base}/media/${preview.media_id}`, width: preview.width, height: preview.height } : null,
      options: { settings: pageSettings, whatsappAllowed, utmEnabled, campaign, more, extraBlocks: { lead_form: leadForm }, trustItems },
    });
    if (pageSettings.landing_noindex) res.set('X-Robots-Tag', 'noindex');
    gzipOnEnd(req, res);
    return sendBuyerPage(res, view, { page: { kind: BUYER_ROUTES.landing.kind, ref: page.slug } });
  });

  // A product inside a landing page is still drawn by the store. This only makes sure the product is one this page may show:
  // another business's product, or one that is off, broken or gone, is the branded 404 (K-33).
  app.get(BUYER_ROUTES.landingProduct.path, async (req, res, next) => {
    const slug = String(req.params.slug);
    const page = SLUG.test(slug) ? await repos.landingPages.getBySlug(slug) : null;
    const product = page?.active ? page.products.find((p) => p.slug === req.params.productSlug) : null;
    if (!product) return notFound(req, res, 'This product isn’t available.');
    return next();
  });
}
