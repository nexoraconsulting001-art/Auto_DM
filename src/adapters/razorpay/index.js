import { DEFAULT_TIMEOUT_MS, createHttp, hmac, providerUrl, sameBytes } from '../http.js';

/**
 * Razorpay (PRD 9.6 to 9.8): one interface, two ways to be the merchant.
 *
 *   route    Bhava's own account, with Route: each captured payment is split by a transfer to the seller's linked account,
 *            and a refund takes back the matching part of that transfer. The default (PAYMENT_MODE=managed).
 *   partner  The seller's own account, connected by Partner OAuth (or its own keys from repos.gatewayKeys). No Route.
 *
 * ctx.providers.razorpay is { route, partner, forMode(mode), default, defaultMode, verifyWebhook, verifyCheckout }. The payments module picks
 * by the business's payment_settings.mode ('managed' is route, 'own' is partner), falling back to config.paymentMode.
 *
 * Both implementations answer the same calls. `account` says whose money it is:
 *   route:    { linkedAccountId }                       the seller's Route linked account
 *   partner:  { accessToken } or { keyId, keySecret }   the seller's own credentials, decrypted by the caller
 *
 *   createOrder(account, { amountPaise, receipt, notes? })                -> { id, amountPaise, status, keyId }
 *       The exact amount in paise; the receipt is the order number. route adds the transfer to the linked account for the
 *       full amount: the gateway fee is the seller's, taken at payout, and Bhava takes nothing.
 *   fetchOrder(account, gatewayOrderId)                                   -> { id, amountPaise, amountPaidPaise, status }
 *   orderPayments(account, gatewayOrderId)                                -> [payment]         (the reconciliation job, S-26)
 *   fetchPayment(account, gatewayPaymentId)                               -> payment
 *   refund(account, gatewayPaymentId, { amountPaise, idempotencyKey, notes? }) -> { id, status, amountPaise, reversal }
 *       route reverses the transfer by the same amount (reversal: { id, amountPaise }); partner has reversal: null (S-76).
 *   fetchRefund(account, gatewayPaymentId, refundId)                      -> { id, status, amountPaise }
 *   checkoutOptions(account, { gatewayOrderId, amountPaise, display })    -> what Razorpay Checkout is opened with, in the seller's
 *       name, logo and colour (S-71). Nothing in it is the page's to change: the gateway order holds the amount.
 *
 * payment is { id, orderId, status: 'created' | 'authorized' | 'captured' | 'failed', amountPaise, method, feePaise, taxPaise,
 * amountRefundedPaise, transfers? }.
 *
 * route only: createLinkedAccount({ email, phone, legalName, businessType, contactName, reference }) -> { id, status },
 *             fetchLinkedAccount(id) -> { id, status }, fetchTransfer(id) -> { id, status, amountPaise, amountReversedPaise }.
 * partner only: authorizeUrl({ state, redirectUri }) and exchangeCode({ code, redirectUri }) -> { accessToken, refreshToken, expiresAt, accountId },
 *               refreshToken(refreshToken) -> the same.
 *
 * Signatures (never throw; false on anything missing or malformed):
 *   verifyCheckout({ gatewayOrderId, gatewayPaymentId, signature }, keySecret)   what the shopper's browser brings back (S-19, S-20)
 *   verifyWebhook(rawBody, signatureHeader, webhookSecret)                       X-Razorpay-Signature over the exact bytes (S-25)
 *
 * Every call has a 10 s timeout and follows no redirect. RAZORPAY_BASE_URL points at tools/sim/razorpay, which is refused when
 * NODE_ENV=production; any other host that isn't Razorpay's throws at start-up. Failures are ProviderError (src/adapters/http.js):
 * a refund or order whose answer was lost has delivery 'unknown' and is repeated only with its idempotency key.
 */
export const RAZORPAY_HOST = 'https://api.razorpay.com';
export const RAZORPAY_AUTH_HOST = 'https://auth.razorpay.com';

const basic = (id, secret) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
const codeOf = (body) => body?.error?.code ?? '';

const toPayment = (p) => ({
  id: p.id,
  orderId: p.order_id ?? null,
  status: p.status,
  amountPaise: p.amount,
  currency: p.currency,
  method: p.method ?? '',
  feePaise: p.fee ?? 0,
  taxPaise: p.tax ?? 0,
  amountRefundedPaise: p.amount_refunded ?? 0,
  errorCode: p.error_code ?? '',
});
const toOrder = (o, keyId) => ({ id: o.id, amountPaise: o.amount, amountPaidPaise: o.amount_paid ?? 0, status: o.status, receipt: o.receipt ?? '', keyId });
const toRefund = (r) => ({ id: r.id, status: r.status, amountPaise: r.amount, paymentId: r.payment_id });

export function verifyCheckout({ gatewayOrderId, gatewayPaymentId, signature } = {}, keySecret) {
  if (!keySecret || typeof gatewayOrderId !== 'string' || typeof gatewayPaymentId !== 'string' || typeof signature !== 'string') return false;
  return sameBytes(signature, hmac(keySecret, `${gatewayOrderId}|${gatewayPaymentId}`));
}

export function verifyWebhook(rawBody, signatureHeader, webhookSecret) {
  if (!webhookSecret || !Buffer.isBuffer(rawBody) || typeof signatureHeader !== 'string') return false;
  return sameBytes(signatureHeader, hmac(webhookSecret, rawBody));
}

function common(request, { authFor, keyIdFor }) {
  return {
    async fetchOrder(account, gatewayOrderId) {
      const { body } = await request('GET', `/v1/orders/${encodeURIComponent(gatewayOrderId)}`, { headers: authFor(account), retries: 2 });
      return toOrder(body, keyIdFor(account));
    },
    async orderPayments(account, gatewayOrderId) {
      const { body } = await request('GET', `/v1/orders/${encodeURIComponent(gatewayOrderId)}/payments`, { headers: authFor(account), retries: 2 });
      return (body?.items ?? []).map(toPayment);
    },
    async fetchPayment(account, gatewayPaymentId) {
      const { body } = await request('GET', `/v1/payments/${encodeURIComponent(gatewayPaymentId)}`, { headers: authFor(account), retries: 2 });
      return toPayment(body);
    },
    async fetchRefund(account, gatewayPaymentId, refundId) {
      const { body } = await request('GET', `/v1/payments/${encodeURIComponent(gatewayPaymentId)}/refunds/${encodeURIComponent(refundId)}`, { headers: authFor(account), retries: 2 });
      return toRefund(body);
    },
    checkoutOptions(account, { gatewayOrderId, amountPaise, display = {} }) {
      return {
        key: keyIdFor(account),
        order_id: gatewayOrderId,
        amount: amountPaise,
        currency: 'INR',
        name: display.name ?? '',
        image: display.image ?? '',
        theme: { color: display.color ?? '' },
      };
    },
  };
}

function need(value, what) {
  if (!value) throw new Error(`Razorpay needs ${what}`);
  return value;
}

/** Bhava's account with Route. */
function createRoute(config, request) {
  const auth = () => ({ authorization: basic(need(config.razorpayKeyId, 'RAZORPAY_KEY_ID'), need(config.razorpayKeySecret, 'RAZORPAY_KEY_SECRET')) });
  const linked = (account) => need(account?.linkedAccountId, 'the seller’s linked account');
  return {
    kind: 'route',
    ...common(request, { authFor: auth, keyIdFor: () => config.razorpayKeyId }),
    async createOrder(account, { amountPaise, receipt, notes = {} }) {
      const { body } = await request('POST', '/v1/orders', {
        headers: auth(),
        json: { amount: amountPaise, currency: 'INR', receipt, notes, transfers: [{ account: linked(account), amount: amountPaise, currency: 'INR', on_hold: false }] },
      });
      return toOrder(body, config.razorpayKeyId);
    },
    async refund(account, gatewayPaymentId, { amountPaise, idempotencyKey, notes = {} }) {
      linked(account);
      const { body } = await request('POST', `/v1/payments/${encodeURIComponent(gatewayPaymentId)}/refund`, {
        headers: { ...auth(), 'x-refund-idempotency': need(idempotencyKey, 'an idempotency key') },
        json: { amount: amountPaise, reverse_all: true, notes },
        retries: 2,
      });
      const reversal = body?.reversal ?? body?.reversals?.[0] ?? null;
      return { ...toRefund(body), reversal: reversal ? { id: reversal.id, amountPaise: reversal.amount } : null };
    },
    async createLinkedAccount({ email, phone, legalName, businessType, contactName, reference }) {
      const { body } = await request('POST', '/v2/accounts', {
        headers: auth(),
        json: { email, phone, type: 'route', reference_id: reference, legal_business_name: legalName, business_type: businessType, contact_name: contactName },
      });
      return { id: body.id, status: body.status };
    },
    async fetchLinkedAccount(id) {
      const { body } = await request('GET', `/v2/accounts/${encodeURIComponent(id)}`, { headers: auth(), retries: 2 });
      return { id: body.id, status: body.status };
    },
    async fetchTransfer(id) {
      const { body } = await request('GET', `/v1/transfers/${encodeURIComponent(id)}`, { headers: auth(), retries: 2 });
      return { id: body.id, status: body.status, amountPaise: body.amount, amountReversedPaise: body.amount_reversed ?? 0, recipient: body.recipient };
    },
  };
}

/** The seller's own account. */
function createPartner(config, request, authRequest) {
  const authFor = (account) => {
    if (account?.accessToken) return { authorization: `Bearer ${account.accessToken}` };
    if (account?.keyId && account?.keySecret) return { authorization: basic(account.keyId, account.keySecret) };
    throw new Error('Razorpay needs the seller’s own account: an access token, or a key id and secret');
  };
  const tokens = (body) => ({ accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: new Date(Date.now() + (Number(body.expires_in) || 0) * 1000), accountId: body.razorpay_account_id ?? '', publicToken: body.public_token ?? '' });
  return {
    kind: 'partner',
    ...common(request, { authFor, keyIdFor: (account) => account?.keyId ?? account?.publicToken ?? '' }),
    async createOrder(account, { amountPaise, receipt, notes = {} }) {
      const { body } = await request('POST', '/v1/orders', { headers: authFor(account), json: { amount: amountPaise, currency: 'INR', receipt, notes } });
      return toOrder(body, account?.keyId ?? account?.publicToken ?? '');
    },
    async refund(account, gatewayPaymentId, { amountPaise, idempotencyKey, notes = {} }) {
      const { body } = await request('POST', `/v1/payments/${encodeURIComponent(gatewayPaymentId)}/refund`, {
        headers: { ...authFor(account), 'x-refund-idempotency': need(idempotencyKey, 'an idempotency key') },
        json: { amount: amountPaise, notes },
        retries: 2,
      });
      return { ...toRefund(body), reversal: null };
    },
    authorizeUrl({ state, redirectUri }) {
      const url = new URL(`${authRequest.baseUrl}/authorize`);
      url.search = new URLSearchParams({ client_id: need(config.razorpayPartnerClientId, 'RAZORPAY_PARTNER_CLIENT_ID'), response_type: 'code', redirect_uri: redirectUri, scope: 'read_write', state }).toString();
      return url.href;
    },
    async exchangeCode({ code, redirectUri }) {
      const { body } = await authRequest('POST', '/token', { json: { client_id: need(config.razorpayPartnerClientId, 'RAZORPAY_PARTNER_CLIENT_ID'), client_secret: need(config.razorpayPartnerClientSecret, 'RAZORPAY_PARTNER_CLIENT_SECRET'), grant_type: 'authorization_code', redirect_uri: redirectUri, code } });
      return tokens(body);
    },
    async refreshToken(refreshToken) {
      const { body } = await authRequest('POST', '/token', { json: { client_id: need(config.razorpayPartnerClientId, 'RAZORPAY_PARTNER_CLIENT_ID'), client_secret: need(config.razorpayPartnerClientSecret, 'RAZORPAY_PARTNER_CLIENT_SECRET'), grant_type: 'refresh_token', refresh_token: refreshToken } });
      return tokens(body);
    },
  };
}

/** Both implementations, and which is the default. Throws at start-up on a bad address. */
export function createRazorpay(config = {}, { env = process.env } = {}) {
  const baseUrl = providerUrl({ value: config.razorpayBaseUrl, real: RAZORPAY_HOST, name: 'RAZORPAY_BASE_URL', env });
  // With only RAZORPAY_BASE_URL pointed at a simulator, the OAuth calls follow it there.
  const authBaseUrl = providerUrl({ value: config.razorpayAuthBaseUrl || (baseUrl === RAZORPAY_HOST ? '' : baseUrl), real: RAZORPAY_AUTH_HOST, name: 'RAZORPAY_AUTH_BASE_URL', env });
  const timeoutMs = config.providerTimeoutMs || DEFAULT_TIMEOUT_MS;
  const request = createHttp({ provider: 'razorpay', baseUrl, timeoutMs, codeOf });
  const authRequest = Object.assign(createHttp({ provider: 'razorpay', baseUrl: authBaseUrl, timeoutMs, codeOf }), { baseUrl: authBaseUrl });
  const route = createRoute(config, request);
  const partner = createPartner(config, request, authRequest);
  const defaultMode = config.paymentMode === 'own' ? 'own' : 'managed';
  const forMode = (mode) => ((mode ?? defaultMode) === 'own' ? partner : route);
  return { route, partner, forMode, defaultMode, default: forMode(defaultMode), verifyCheckout, verifyWebhook };
}
