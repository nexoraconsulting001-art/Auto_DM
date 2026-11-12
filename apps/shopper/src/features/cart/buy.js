/**
 * Every call the buying screens make to the store, in one place, and the one rule they all keep: nothing the app sends holds a
 * price, a total, a discount, a fee or a tax. The server works those out from the products and the codes, and the screens draw
 * its answer. A request that carries such a field is refused here, before it leaves the phone.
 *
 *   const buy = createBuy(client);
 *   const quote = await buy.quote({ lines, addressId, paymentMode, couponCode, redeemPoints });
 *   const placed = await buy.place({ ...draft, idempotencyKey, acceptTerms: true, consent });
 */
const MONEY = /(price|paise|rupee|total|amount|discount|fee|tax|cost|balance|advance)/i;

/** Throws when a request body carries a money field. `redeemPoints` is points, not money, and is the server's to cap. */
export function assertNoMoney(value, path = 'body') {
  if (Array.isArray(value)) {
    value.forEach((entry, i) => assertNoMoney(entry, `${path}[${i}]`));
    return value;
  }
  if (value && typeof value === 'object' && !(typeof FormData !== 'undefined' && value instanceof FormData)) {
    for (const [key, inner] of Object.entries(value)) {
      if (MONEY.test(key)) throw new Error(`The app never sends money: ${path}.${key}`);
      assertNoMoney(inner, `${path}.${key}`);
    }
  }
  return value;
}

/** A line as the server takes it: which product, which variant, how many. */
export const lineOf = (line) => ({ productId: line.productId, variantId: line.variantId ?? null, qty: line.qty });

const clean = (value) => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== ''));

/** The checkout fields shared by a quote and an order. */
export function draftBody(draft) {
  const body = {
    lines: (draft.lines ?? []).map(lineOf),
    ...(draft.addressId ? { addressId: draft.addressId } : draft.address ? { address: clean(draft.address) } : {}),
    ...(draft.paymentMode ? { paymentMode: draft.paymentMode } : {}),
    ...clean({ email: draft.email, couponCode: draft.couponCode, referralCode: draft.referralCode }),
    ...(draft.redeemPoints > 0 ? { redeemPoints: draft.redeemPoints } : {}),
  };
  return body;
}

/** `ready()` resolves once the app has a session, so a call that must not go twice (an order) never goes without one. */
export function createBuy(client, { ready } = {}) {
  const call = async (id, options = {}) => {
    if (options.body !== undefined) assertNoMoney(options.body);
    await ready?.();
    return client.call(id, options);
  };
  return Object.freeze({
    call,
    quote: (draft) => call('checkoutQuote', { body: draftBody(draft) }),
    /** `extra` is idempotencyKey, acceptTerms, consent and saveDetails. */
    place: (draft, extra) => call('checkoutPlace', { body: { ...draftBody(draft), ...extra } }),
    retry: (token) => call('orderRetry', { params: { token } }),
    state: (token) => call('appOrderByToken', { params: { token } }),
    sendCodFor: ({ phone, checkoutKey }) => call('otpSend', { body: { phone, purpose: 'cod', checkoutKey } }),
    verifyCodFor: ({ phone, code, checkoutKey }) => call('otpVerify', { body: { phone, purpose: 'cod', code, checkoutKey } }),
    checkCoupon: ({ code, lines }) => call('couponCheck', { body: { code, lines: lines.map(lineOf) } }),
  });
}
