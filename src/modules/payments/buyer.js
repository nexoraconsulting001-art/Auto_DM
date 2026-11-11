import { ProviderError } from '../../adapters/http.js';
import { ERROR_STATUS } from '../../contracts/api/errors.js';
import { PaymentReturn, STORE_ROUTES } from '../../contracts/store-routes.js';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { PaymentError, isGatewayId } from './util.js';

/**
 * The shopper's side of paying (PRD 9.6, 9.7), on the seller's own address, in JSON under /api/store:
 *
 *   POST /api/store/payments/return        what the gateway's checkout handed the page: checked on the server (S-19, S-20).
 *       -> { status: 'paid' | 'pending' | 'failed' | 'review', orderNumber, token, next }  `next` is the order page, where
 *          success, pending and failure are shown in the seller's brand (S-74).
 *   POST /api/store/orders/:token/retry    pay again for the same order: the same gateway order while it can take money.
 *       -> { orderNumber, token, next: 'pay' | 'done', gateway }
 *
 * Errors are { error, code, fields? }. Nothing here names the platform.
 */
const TOKEN = /^[A-Za-z0-9_-]{8,100}$/;
const SIGNATURE = /^[A-Za-z0-9]{0,200}$/;
const RETURN_LIMIT = Object.freeze({ limit: 30, windowMs: 10 * 60_000 });

const fail = (res, code, error, fields) => res.status(ERROR_STATUS[code] ?? 400).json({ error, code, ...(fields ? { fields } : {}) });

/** The page's own address, for the logo the gateway's checkout shows. */
const baseOf = (req) => `${req.protocol}://${req.get('host')}`;

export function mountBuyerRoutes(app, ctx, service) {
  const limited = async (req, scope) => {
    const hit = await ctx.platform.rateLimit.hit(scope, `${tenantId()}:${req.ip}`, RETURN_LIMIT);
    return !hit.allowed;
  };

  app.post(STORE_ROUTES.paymentReturn.path, async (req, res) => {
    if (await limited(req, 'payment_return_ip')) return fail(res, 'rate_limited', 'Too many tries. Wait a little and try again.');
    const parsed = PaymentReturn.safeParse(req.body ?? {});
    const body = parsed.success ? parsed.data : null;
    if (!body || !TOKEN.test(body.orderToken) || !isGatewayId(body.gatewayOrderId) || !isGatewayId(body.gatewayPaymentId) || !SIGNATURE.test(body.signature)) {
      return fail(res, 'validation_failed', 'That payment answer couldn’t be read. Open your order to see where it stands.');
    }
    const result = await service.confirmReturn(body);
    if (result.status === 'refused') {
      return result.http === 404 ? fail(res, 'not_found', 'We couldn’t find that order.') : fail(res, 'forbidden', 'We couldn’t confirm this payment. Open your order to see where it stands.');
    }
    res.status(result.http).json({ status: result.status, orderNumber: result.orderNumber, token: result.token, next: `/order/${encodeURIComponent(result.token)}` });
  });

  app.post(STORE_ROUTES.orderRetry.path, async (req, res) => {
    if (await limited(req, 'payment_retry_ip')) return fail(res, 'rate_limited', 'Too many tries. Wait a little and try again.');
    if (!TOKEN.test(String(req.params.token ?? ''))) return fail(res, 'not_found', 'We couldn’t find that order.');
    try {
      res.json(await service.retry(req.params.token, { baseUrl: baseOf(req) }));
    } catch (err) {
      if (err instanceof PaymentError) return fail(res, err.code, err.message);
      if (err instanceof ProviderError) {
        log.warn('payments.retry_unavailable', { kind: err.kind });
        return fail(res, 'conflict', 'We couldn’t start the payment just now. Please try again in a minute.');
      }
      throw err;
    }
  });
}
