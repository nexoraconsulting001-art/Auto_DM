import express from 'express';
import { z } from 'zod';
import { ApiError } from '../../contracts/api/errors.js';
import { BUYER_ROUTES } from '../../contracts/buyer-pages.js';
import { ReviewCreate, STORE_ROUTES } from '../../contracts/store-routes.js';
import { log } from '../../platform/log.js';
import { limited, parseBody, shopperFrom, storeCall, storeOn } from '../storefront/http.js';
import { hookPages, insertAfter, insertBefore } from './page-hook.js';
import { REVIEWS_JS, REVIEWS_SCRIPT, SHOWN_ON_PAGE, reviewsSection } from './pages.js';
import { OPEN_REVIEW_LIMIT, REVIEWS_FEATURE, ReviewRefused, reviewsRepo } from './repo.js';
import { reviewWithPhotos } from './photos.js';
import { REVIEW_REQUEST_JOB, reviewRequests } from './request.js';

/**
 * PRD 9.19: ratings and reviews. This folder is the reviews track's.
 *
 * Tables (migration 412): reviews, review_photos, product_ratings (repo.js).
 * Buyer routes (src/contracts/store-routes.js):
 *   POST /api/store/reviews                  a shopper who received the product, once per product per order (S-81); as
 *                                            JSON, or as multipart with up to three photos (photos.js)
 *   GET  /api/store/products/:id/reviews     approved reviews, newest first, with the average and count
 * The product page shows the average, the count, the newest approved reviews and, for a shopper who may write one, the
 * form (pages.js). The storefront draws the page; this module adds its section as the page is sent (page-hook.js).
 * Console routes: reviews.list, reviews.approve, reviews.hide, reviews.reply (staff with catalog). There is no route that
 * changes what a shopper wrote.
 * Order events: order.delivered queues the review request, through the shopper-message gate, as marketing (request.js).
 * Gated by `store.reviews` (tier 3 and above): without it the buyer calls are the store's 404 and the console's 403, and
 * product pages show no reviews.
 */
const ProductParams = z.object({ id: z.string().regex(/^[1-9][0-9]{0,9}$/).transform(Number).refine((n) => n <= 2147483647) });
const PublicListQuery = z.object({
  cursor: z.string().max(512).regex(/^[\w-]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const notHere = () => new ApiError('not_found', 'There is nothing here.');

async function featureOn(ctx) {
  return (await storeOn(ctx.repos)) && Boolean(await ctx.repos.entitlements.can(REVIEWS_FEATURE));
}

/** The console's routes; every one needs the plan, and a review of another business is not found (null). */
function reviewsApi(ctx) {
  const repo = reviewsRepo(ctx.db);
  const plan = async () => {
    if (!(await ctx.repos.entitlements.can(REVIEWS_FEATURE))) throw new ApiError('forbidden', 'Reviews aren’t on your plan.', { reason: 'plan' });
  };
  const decided = (status) => async ({ params, user }) => {
    await plan();
    const review = await repo.decide(params.id, status);
    if (review) log.info('reviews.decided', { reviewId: review.id, status, by: user?.id ?? null });
    return review;
  };
  return {
    async 'reviews.list'({ query }) {
      await plan();
      return repo.list(query);
    },
    'reviews.approve': decided('approved'),
    'reviews.hide': decided('hidden'),
    async 'reviews.reply'({ params, body, user }) {
      await plan();
      const review = await repo.reply(params.id, body.reply);
      if (review) log.info('reviews.replied', { reviewId: review.id, by: user?.id ?? null });
      return review;
    },
  };
}

export const reviews = {
  name: 'reviews',

  setup(ctx) {
    const requests = reviewRequests(ctx);
    ctx.orderEvents?.on('order.delivered', 'reviews.request', async (event) => {
      if (!(await ctx.repos.entitlements.can(REVIEWS_FEATURE))) return;
      await requests.queue(event.orderId);
    });
  },

  routes(app, ctx) {
    const repo = reviewsRepo(ctx.db);
    const r = express.Router();

    r.post(STORE_ROUTES.reviewCreate.path, reviewWithPhotos(ctx, repo), storeCall(ctx, async (req) => {
      if (!(await ctx.repos.entitlements.can(REVIEWS_FEATURE))) throw notHere();
      const body = parseBody(ReviewCreate, req.body);
      if (!req.shopper?.id) throw new ApiError('unauthorized', 'Sign in to write a review.');
      await limited(ctx.platform, 'review_create', `shopper:${req.shopper.id}`, OPEN_REVIEW_LIMIT);
      try {
        const review = await repo.create(req.shopper, body);
        log.info('reviews.created', { reviewId: review.id, productId: body.productId, rating: body.rating });
        return { status: 201, body: { review, message: 'Thank you. Your review will appear once the store has checked it.' } };
      } catch (err) {
        if (err instanceof ReviewRefused) throw new ApiError(err.code === 'duplicate' ? 'conflict' : 'forbidden', err.message);
        throw err;
      }
    }));

    r.get(STORE_ROUTES.reviewList.path, storeCall(ctx, async (req) => {
      if (!(await ctx.repos.entitlements.can(REVIEWS_FEATURE))) throw notHere();
      const params = ProductParams.safeParse(req.params);
      if (!params.success) throw notHere();
      const query = PublicListQuery.safeParse(req.query);
      if (!query.success) throw new ApiError('validation_failed', 'Please check the details and try again.');
      const [summary, page] = await Promise.all([repo.summary(params.data.id), repo.published(params.data.id, query.data)]);
      return { body: { ...summary, ...page } };
    }));

    r.get(REVIEWS_SCRIPT, async (req, res, next) => {
      try {
        if (!(await featureOn(ctx))) return next();
        res.set('Cache-Control', 'public, max-age=3600');
        return res.type('text/javascript').send(REVIEWS_JS);
      } catch (err) {
        return next(err);
      }
    });
    app.use(r);
  },

  /** The product page is drawn by another module; the hook goes in before any route and runs as the page is sent, inside its business. */
  beforeTenant(app, ctx) {
    const repo = reviewsRepo(ctx.db);
    // The reviews under the product, as the storefront's product page goes out.
    hookPages(app, {
      name: 'reviews',
      paths: [STORE_ROUTES.product.path, BUYER_ROUTES.landingProduct.path],
      async transform(page, { req, res }) {
        // The page says which product it drew (sendBuyerPage): that, not the address, is what the reviews are of.
        if (res.locals.page?.kind !== 'product' || !(await featureOn(ctx))) return page;
        const product = await repo.productBySlug(res.locals.page.ref);
        if (!product) return page;
        const shopper = await shopperFrom(req, ctx.db);
        const [summary, newest, open] = await Promise.all([
          repo.summary(product.id),
          repo.published(product.id, { limit: SHOWN_ON_PAGE }),
          shopper ? repo.reviewable(shopper, product.id) : [],
        ]);
        const part = String(reviewsSection({ product, summary, reviews: newest.items, orderNumber: open[0] ?? '' }));
        return insertAfter(page, 'aria-labelledby="product-h"', part, '</section>') ?? insertBefore(page, '</main>', part);
      },
    });
  },

  api: (ctx) => reviewsApi(ctx),

  jobs(ctx) {
    const requests = reviewRequests(ctx);
    ctx.platform.queue.work(REVIEW_REQUEST_JOB, (job) => requests.send(Number(job.payload?.orderId)));
  },
};
