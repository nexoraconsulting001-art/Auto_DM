/**
 * Placing an order without placing it twice. One attempt has one idempotency key (the one Phase 4 checks), made when the
 * attempt begins and sent with every try, so a second tap, a retry after a dropped connection or a screen opened twice all
 * reach the same order. The key is also what the cash-on-delivery code is tied to. A new key starts only when the bag or the
 * phone changes, or after the order was placed.
 */
const TERMS_BODY = true;

export function fingerprint(draft) {
  const lines = (draft.lines ?? []).map((l) => `${l.productId}:${l.variantId ?? ''}x${l.qty}`).sort().join(',');
  const phone = String(draft.phone ?? draft.address?.phone ?? '').replace(/\D/g, '').slice(-10);
  return `${lines}|${draft.addressId ?? ''}|${phone}`;
}

export function createAttempt({ newKey }) {
  let held = null;
  let flight = null;
  return {
    /** The key for this bag and phone. The same until either changes. */
    keyFor(draft) {
      const print = fingerprint(draft);
      if (!held || held.print !== print) held = { print, key: newKey() };
      return held.key;
    },
    get busy() {
      return flight !== null;
    },
    /**
     * Places the order. While a try is in flight, a second call gets the same promise, so a double tap makes one request.
     * `send(key)` makes the request. The key is kept after a failure (the retry is the same attempt) and dropped after success.
     */
    place(draft, send) {
      if (flight) return flight;
      const key = this.keyFor(draft);
      flight = Promise.resolve()
        .then(() => send(key))
        .then((result) => {
          // An order was made: the attempt is over. Asked to verify the phone first: the same attempt goes on with the same key.
          if (result?.next !== 'verify_phone') held = null;
          return result;
        })
        .finally(() => {
          flight = null;
        });
      return flight;
    },
    reset() {
      held = null;
    },
  };
}

/** What the shopper agreed to. Order updates on WhatsApp are part of taking the order; marketing is off unless ticked. */
export function consentBody({ noticeVersion, whatsappUpdates = true, emailUpdates = false, marketingWhatsapp = false, marketingEmail = false }) {
  return {
    noticeVersion: Number.isInteger(noticeVersion) && noticeVersion > 0 ? noticeVersion : 1,
    orderUpdates: { whatsapp: whatsappUpdates, email: emailUpdates },
    marketing: { whatsapp: marketingWhatsapp, email: marketingEmail },
  };
}

export const placeExtra = ({ key, consent, saveDetails = false }) => ({ idempotencyKey: key, acceptTerms: TERMS_BODY, consent, saveDetails });

/** Whether the server's state for an order means the bag is done: paid, advance paid, or cash on delivery taken. */
export const orderIsPlaced = (state) => state?.next === 'done';

/** "Paid" is said only when the server's own word is paid. Cash on delivery, an advance and a pending payment say what they are. */
export function paymentWords(paymentStatus) {
  switch (paymentStatus) {
    case 'paid': return 'paid';
    case 'advance_paid': return 'advance';
    case 'cod_due': return 'cod';
    case 'refunded': case 'partially_refunded': return 'refunded';
    case 'voided': return 'failed';
    default: return 'waiting';
  }
}
