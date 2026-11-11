import { VISITOR_COOKIE } from '../contracts/analytics.js';

const IS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The traffic visitor id a request carries (PRD 7.10), or null. Checkout stores it on the order as orders.visitor_id, and
 * the traffic module ties the visit to the order when the order's event arrives. A random id from the seller's own
 * first-party cookie: never a person's name or number.
 */
export function visitorIdFrom(req) {
  for (const part of String(req?.headers?.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === VISITOR_COOKIE) {
      const value = rest.join('=');
      return IS_UUID.test(value) ? value.toLowerCase() : null;
    }
  }
  return null;
}
