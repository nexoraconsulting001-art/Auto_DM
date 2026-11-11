import multer from 'multer';
import { ApiError } from '../../contracts/api/errors.js';
import { IMAGE_UPLOAD } from '../../contracts/api/media.js';
import { STORE_LIMITS } from '../../contracts/orders.js';
import { ReviewCreate } from '../../contracts/store-routes.js';
import { log } from '../../platform/log.js';
import { limited, parseBody, sendStoreError, storeOn } from '../storefront/http.js';
import { OPEN_REVIEW_LIMIT, REVIEWS_FEATURE, ReviewRefused } from './repo.js';

/**
 * A review with photos (PRD 9.19: up to 3, under the store's upload rules). The same call as the JSON one, POST
 * /api/store/reviews, sent as multipart/form-data with the fields orderNumber, productId, rating and body and up to three
 * files named `photos`. The fields go through the same strict schema. Each photo is decoded and written again (upright, no
 * metadata, WebP) before it is stored, so nothing is kept as it arrived; it is stored as this business's media only after
 * the shopper is known to be allowed to write the review.
 */
const receive = multer({
  storage: multer.memoryStorage(),
  limits: { files: STORE_LIMITS.review.photos, fileSize: IMAGE_UPLOAD.maxBytes, fields: 8, fieldSize: 4096, parts: STORE_LIMITS.review.photos + 8 },
  fileFilter(_req, file, done) {
    if (file.fieldname === 'photos' && IMAGE_UPLOAD.mimeTypes.includes(file.mimetype)) done(null, true);
    else done(new ApiError('unsupported_media_type', 'Add photos as JPEG, PNG, WebP or GIF.'));
  },
}).array('photos', STORE_LIMITS.review.photos);

function parts(req, res) {
  return new Promise((resolve, reject) => receive(req, res, (err) => {
    if (!err) return resolve();
    if (err instanceof ApiError) return reject(err);
    if (err?.code === 'LIMIT_FILE_SIZE') return reject(new ApiError('payload_too_large', `Each photo can be up to ${IMAGE_UPLOAD.maxBytes / 1024 / 1024} MB.`));
    if (err?.code === 'LIMIT_FILE_COUNT' || err?.code === 'LIMIT_UNEXPECTED_FILE') return reject(new ApiError('validation_failed', `Add up to ${STORE_LIMITS.review.photos} photos.`, { fields: { photos: `Up to ${STORE_LIMITS.review.photos} photos` } }));
    return reject(new ApiError('validation_failed', 'Please check the details and try again.'));
  }));
}

/** A browser says where a request came from: another site's is refused, as on every store call. */
function fromThisStore(req) {
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).hostname.toLowerCase() !== String(req.hostname ?? '').toLowerCase()) return false;
    } catch {
      return false;
    }
  }
  const site = req.get('sec-fetch-site');
  return !site || site === 'same-origin' || site === 'none';
}

/** Multipart's fields are text: whole numbers become numbers, anything else stays text and the schema refuses it. */
const whole = (value) => (typeof value === 'string' && /^[0-9]{1,10}$/.test(value) ? Number(value) : value);

export function reviewWithPhotos(ctx, repo) {
  return async (req, res, next) => {
    if (!req.is('multipart/form-data')) return next();
    try {
      res.set('Cache-Control', 'no-store');
      if (!fromThisStore(req)) throw new ApiError('forbidden', 'This request didn’t come from the store’s own page.');
      if (!(await storeOn(ctx.repos)) || !(await ctx.repos.entitlements.can(REVIEWS_FEATURE))) throw new ApiError('not_found', 'There is nothing here.');
      await parts(req, res);
      const fields = req.body ?? {};
      const body = parseBody(ReviewCreate, Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, ['productId', 'rating'].includes(k) ? whole(v) : v])));
      if (!req.shopper?.id) throw new ApiError('unauthorized', 'Sign in to write a review.');
      await limited(ctx.platform, 'review_create', `shopper:${req.shopper.id}`, OPEN_REVIEW_LIMIT);
      const may = await repo.mayReview(req.shopper, body);
      if (may === 'duplicate') throw new ApiError('conflict', 'You have already reviewed this product for this order.');
      if (may !== 'ok') throw new ApiError('forbidden', 'You can review a product once it has been delivered to you.');
      // Every photo is written again first, so one bad file stores none of them.
      const images = [];
      for (const file of req.files ?? []) {
        try {
          images.push(await ctx.platform.images.ingest(file.buffer));
        } catch {
          throw new ApiError('validation_failed', 'One of the photos isn’t an image we can use.', { fields: { photos: 'Not an image we can use' } });
        }
      }
      const mediaIds = [];
      for (const image of images) mediaIds.push(await ctx.repos.media.save(image.buffer, image.contentType));
      let review;
      try {
        review = await repo.create(req.shopper, body, { mediaIds });
      } catch (err) {
        if (err instanceof ReviewRefused) throw new ApiError(err.code === 'duplicate' ? 'conflict' : 'forbidden', err.message);
        throw err;
      }
      log.info('reviews.created', { reviewId: review.id, productId: body.productId, rating: body.rating, photos: mediaIds.length });
      return res.status(201).json({ review, message: 'Thank you. Your review will appear once the store has checked it.' });
    } catch (err) {
      return sendStoreError(err, req, res);
    }
  };
}
