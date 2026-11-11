import express from 'express';
import { staffWith, isAllowed } from '../../contracts/api/access.js';
import { ApiError } from '../../contracts/api/errors.js';
import { STORE_ROUTES } from '../../contracts/store-routes.js';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { storeCall } from '../storefront/http.js';
import { cancelOrder, refundDue } from './cancel.js';

/**
 * The orders module's two addresses outside /api/v1:
 *
 *   POST /api/store/orders/:orderNumber/cancel   the signed-in shopper cancels their own order before it ships (9.17, S-56)
 *   GET  /orders/downloads/:id/file              the seller's CSV file (9.9), for a signed-in owner, manager or staff with
 *                                                the orders permission, until it expires. Never cached, never logged by content.
 */
const ORDER_NUMBER = /^[A-Za-z0-9-]{1,40}$/;

export function shopperCancel(ctx) {
  return storeCall(ctx, async (req) => {
    const shopper = req.shopper;
    if (!shopper) throw new ApiError('unauthorized', 'Sign in to manage your orders.');
    const number = String(req.params.orderNumber ?? '');
    const [order] = ORDER_NUMBER.test(number)
      ? await ctx.db.query('SELECT id, flow FROM orders WHERE tenant_id = $1 AND order_number = $2 AND shopper_id = $3', [tenantId(), number, shopper.id])
      : [];
    if (!order || order.flow !== 'checkout') throw new ApiError('not_found', 'We couldn’t find that order.');
    const after = await ctx.db.tx((t) => cancelOrder(t, order.id, { actor: `shopper:${shopper.id}`, cancelReason: 'shopper', events: ctx.orderEvents }))
      .catch((err) => {
        if (err?.name === 'OrderStateError') throw new ApiError('conflict', err.code === 'not_allowed' ? err.message : 'This order can’t be cancelled now.');
        throw err;
      });
    ctx.orderEvents?.kick();
    return { body: { orderNumber: after.order_number, fulfilmentStatus: after.fulfilment_status, paymentStatus: after.payment_status, refundDuePaise: refundDue(after) } };
  });
}

export function downloadFile(ctx) {
  const access = staffWith('orders');
  return async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      if (!req.user || !isAllowed(req.user, access) || req.user.role === 'customer') return res.status(req.user ? 403 : 401).type('text').send(req.user ? 'You don’t have access to this.' : 'Please sign in.');
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0 || id > 2147483647) return res.status(404).type('text').send('Not found');
      const [row] = await ctx.db.query('SELECT id, status, storage_key, expires_at FROM order_downloads WHERE tenant_id = $1 AND id = $2', [tenantId(), id]);
      if (!row || row.status !== 'ready' || !row.storage_key) return res.status(404).type('text').send('Not found');
      if (row.expires_at && new Date(row.expires_at) <= new Date()) return res.status(410).type('text').send('This file has expired. Make a new one.');
      const file = await ctx.platform.storage.get(row.storage_key);
      if (!file) return res.status(404).type('text').send('Not found');
      log.info('orders.download_opened', { downloadId: row.id, userId: req.user.id });
      res.set('Content-Disposition', `attachment; filename="orders-${row.id}.csv"`);
      return res.type('text/csv; charset=utf-8').send(file);
    } catch (err) {
      return next(err);
    }
  };
}

export function ordersRoutes(app, ctx) {
  const r = express.Router();
  r.post(STORE_ROUTES.accountOrderCancel.path, shopperCancel(ctx));
  r.get('/orders/downloads/:id/file', downloadFile(ctx));
  app.use(r);
}
