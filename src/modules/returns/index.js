import express from 'express';
import multer from 'multer';
import { isAllowed, staffWith } from '../../contracts/api/access.js';
import { ApiError } from '../../contracts/api/index.js';
import { STORE_ROUTES } from '../../contracts/store-routes.js';
import { reportError } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { OrderStateError } from '../orders/state.js';
import { sendStoreError, shopperFrom, storeOn } from '../storefront/http.js';
import { sendStoreNotFound, sendStorePage } from '../storefront/shell.js';
import { PROOF_LIMITS, PROOF_PATH, proofLinkValid } from './proofs.js';
import { createReturns } from './service.js';
import { noReturnPage, returnPage } from './views.js';

/**
 * PRD 9.17: returns. This folder is the returns track's.
 *
 * Tables (migration 410): return_settings, returns, return_items, return_proofs. The flow is the return machine in
 * src/contracts/orders.js: requested, then approved or rejected, then the reverse pickup, received, and refunded or
 * exchanged, every move through src/modules/orders/state.js.
 *
 * Buyer: GET /account/orders/:orderNumber/return (the form, only inside the window, S-57) and
 * POST /api/store/orders/:orderNumber/returns (multipart; at least one photo or short video as the owner asked, S-80).
 * Console: returnSettings.get/update, returns.list/get/approve/decline/receive/close (src/contracts/api/fulfilment.js).
 * Proof files: GET /returns/proofs/:id, a signed link lasting minutes, for the owner and staff with order access only.
 * The reverse pickup is booked by the shipping module (ctx.shipping.bookReturn) once the approval commits.
 * Order events (one listener): shipment.* of the reverse parcel moves the return (delivered back means received and
 * waiting to be checked); refund.requested links the owner's refund named with returnId, refund.processed closes it.
 * Receiving it "good" puts the stock back once (inventory's restockReturn); "not restockable" never does (S-58).
 * Job returns.window: order.return_window_closed for every delivered order whose window has passed (loyalty listens).
 *
 * What other modules may use: returnOption(ctx, order) is the return page's address when the order can be returned now, or
 * null (the account's order page should show its link only then, S-57); returnsFor(ctx).options(order) says what of it.
 */
export const WINDOW_QUEUE = 'returns.window';
export const RETURN_EVENTS = Object.freeze([
  'shipment.pickup_scheduled', 'shipment.picked_up', 'shipment.in_transit', 'shipment.out_for_delivery', 'shipment.undelivered',
  'shipment.delivered', 'shipment.cancelled', 'shipment.lost', 'shipment.rto_initiated',
  'refund.requested', 'refund.processed',
]);
const services = new WeakMap();

export function returnsFor(ctx) {
  let found = services.get(ctx);
  if (!found) {
    found = createReturns(ctx);
    services.set(ctx, found);
  }
  return found;
}

export const returnLink = (order) => `/account/orders/${encodeURIComponent(order.order_number)}/return`;

/** The return page's address when something of `order` can be returned now, else null: for the account's order page (S-57). */
export async function returnOption(ctx, order) {
  if (!order || order.flow !== 'checkout' || order.fulfilment_status !== 'delivered') return null;
  return (await returnsFor(ctx).options(order)).ok ? returnLink(order) : null;
}

const sellerReads = staffWith('orders');
const ORDER_NUMBER = /^[A-Za-z0-9_-]{1,60}$/;

/** The signed-in shopper's own checkout order by its number, or null. */
async function shopperOrder(ctx, shopper, number) {
  if (!shopper || typeof number !== 'string' || !ORDER_NUMBER.test(number)) return null;
  const [order] = await ctx.db.query('SELECT * FROM orders WHERE tenant_id = $1 AND order_number = $2 AND shopper_id = $3', [tenantId(), number, shopper.id]);
  return order ?? null;
}

/** A write must come from a page of this store (the same rule as the store's JSON calls). */
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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.max(PROOF_LIMITS.photoBytes, PROOF_LIMITS.videoBytes), files: PROOF_LIMITS.files, fields: 8, fieldSize: PROOF_LIMITS.fieldBytes, parts: PROOF_LIMITS.files + 8 },
}).array('proof', PROOF_LIMITS.files);

function receiveFiles(req, res) {
  return new Promise((resolve, reject) => {
    upload(req, res, (err) => {
      if (!err) return resolve();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return reject(new ApiError('payload_too_large', 'That file is too large. Use a photo under 10 MB or a short video under 25 MB.', { fields: { proof: 'That file is too large' } }));
        if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') return reject(new ApiError('validation_failed', `Add up to ${PROOF_LIMITS.files} photos or videos.`, { fields: { proof: `Add up to ${PROOF_LIMITS.files} files` } }));
        return reject(new ApiError('validation_failed', 'Please check the details and try again.'));
      }
      return reject(new ApiError('validation_failed', 'Please check the details and try again.'));
    });
  });
}

/** Console handlers: a state machine refusal is a conflict, never a server error. */
const api = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (err) {
    if (err instanceof OrderStateError) throw new ApiError(err.code === 'not_found' ? 'not_found' : 'conflict', err.code === 'not_found' ? undefined : 'That can’t be done with this return now.');
    throw err;
  }
};

export const returns = {
  name: 'returns',

  setup(ctx) {
    const service = returnsFor(ctx);
    ctx.returns = service;
    ctx.orderEvents?.on(RETURN_EVENTS, 'returns.progress', (event) => service.onEvent(event));
  },

  routes(app, ctx) {
    const r = express.Router();

    r.get(STORE_ROUTES.returnStart.path, async (req, res) => {
      try {
        if (!(await storeOn(ctx.repos))) return sendStoreNotFound(ctx, req, res);
        const shopper = await shopperFrom(req, ctx.db);
        if (!shopper) return res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl.slice(0, 300))}`);
        const order = await shopperOrder(ctx, shopper, req.params.orderNumber);
        if (!order) return sendStoreNotFound(ctx, req, res, 'We couldn’t find that order.');
        const options = await returnsFor(ctx).options(order);
        if (!options.ok) {
          return sendStorePage(ctx, req, res, { title: 'Returns', main: noReturnPage({ order, message: options.message }), kind: 'other', status: 404 });
        }
        const [{ deadline }] = await ctx.db.query(
          'SELECT delivered_at + make_interval(days => $3) AS deadline FROM orders WHERE tenant_id = $1 AND id = $2',
          [tenantId(), order.id, options.settings.window_days],
        );
        return sendStorePage(ctx, req, res, { title: 'Return an item', main: returnPage({ order, options, deadline }), kind: 'other' });
      } catch (err) {
        reportError(err, { msg: 'returns.page_failed' });
        return res.status(500).type('text').send('Something went wrong. Please try again.');
      }
    });

    r.post(STORE_ROUTES.returnCreate.path, async (req, res) => {
      try {
        res.set('Cache-Control', 'no-store');
        if (!req.is('multipart/form-data')) throw new ApiError('unsupported_media_type', 'Send the form with its photos or videos.');
        if (!fromThisStore(req)) throw new ApiError('forbidden', 'This request didn’t come from the store’s own page.');
        if (!(await storeOn(ctx.repos))) throw new ApiError('not_found', 'There is nothing here.');
        // Who it is and whose order, before a byte of the files is read.
        const shopper = await shopperFrom(req, ctx.db);
        if (!shopper) throw new ApiError('unauthorized', 'Sign in to ask for a return.');
        const order = await shopperOrder(ctx, shopper, req.params.orderNumber);
        if (!order) throw new ApiError('not_found', 'We couldn’t find that order.');
        await receiveFiles(req, res);
        const fields = req.body && typeof req.body === 'object' ? req.body : {};
        const made = await returnsFor(ctx).request({ order, shopper, fields, files: req.files ?? [] });
        return res.status(201).json(made);
      } catch (err) {
        return sendStoreError(err, req, res);
      }
    });

    r.get(PROOF_PATH, async (req, res) => {
      try {
        res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
        if (!req.user) return res.status(401).type('text').send('Sign in to your admin, then open the return again.');
        if (!isAllowed(req.user, sellerReads)) return res.status(403).type('text').send('You don’t have access to returns.');
        const id = /^\d{1,18}$/.test(req.params.id) ? req.params.id : null;
        if (!id || !proofLinkValid(returnsFor(ctx).secret, id, req.query.exp, req.query.sig)) return res.status(403).type('text').send('This link has expired. Open the return again.');
        const [proof] = await ctx.db.query('SELECT file_key, content_type FROM return_proofs WHERE tenant_id = $1 AND id = $2', [tenantId(), id]);
        const file = proof ? await ctx.platform.storage.get(proof.file_key) : null;
        if (!file) return res.status(404).type('text').send('We couldn’t find that file.');
        res.set({ 'Content-Type': proof.content_type, 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; sandbox" });
        return res.send(file);
      } catch (err) {
        reportError(err, { msg: 'returns.proof_failed' });
        return res.status(500).type('text').send('Something went wrong. Please try again.');
      }
    });

    app.use(r);
  },

  api: (ctx) => ({
    'returnSettings.get': api(() => returnsFor(ctx).settings.get()),
    'returnSettings.update': api(({ body, user }) => returnsFor(ctx).settings.update(body, `user:${user.id}`)),
    'returns.list': api(({ query }) => returnsFor(ctx).list(query)),
    'returns.get': api(({ params }) => returnsFor(ctx).get(params.id)),
    'returns.approve': api(({ params, user }) => returnsFor(ctx).approve(params.id, user)),
    'returns.decline': api(({ params, body, user }) => returnsFor(ctx).decline(params.id, body.note, user)),
    'returns.receive': api(({ params, body, user }) => returnsFor(ctx).receive(params.id, body.condition, user)),
    'returns.close': api(({ params, body, user }) => returnsFor(ctx).close(params.id, body, user)),
  }),

  jobs(ctx) {
    const { queue } = ctx.platform;
    queue.work(WINDOW_QUEUE, () => returnsFor(ctx).closeWindows());
    return async function schedule() {
      await queue.every(WINDOW_QUEUE, 10 * 60_000);
    };
  },
};
