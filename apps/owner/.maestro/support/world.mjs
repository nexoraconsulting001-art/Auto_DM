/**
 * The made-up world the Maestro flows run in: three businesses and one seller per flow, so no flow waits on another
 * and no number runs into the code limits. Every name and number here is invented; nothing names a real business or
 * person. Read by seed.mjs (before the server starts) and by server.mjs (the values it hands to the flows).
 *
 * A CI helper for .github/workflows/apps.yml (android-e2e). It is never bundled into the app.
 */
export const BUSINESSES = Object.freeze({
  a: Object.freeze({ slug: 'e2e-indigo-loom', name: 'Indigo Loom' }),
  b: Object.freeze({ slug: 'e2e-saffron-pantry', name: 'Saffron Pantry' }),
  // A business none of the flows' sellers belongs to: the switcher must not list it (P-09).
  c: Object.freeze({ slug: 'e2e-teal-kettle', name: 'Teal Kettle' }),
});

/**
 * Each flow's seller: a ten-digit number and the businesses where that number owns an account. The flows type the
 * number into the sign-in screen. `orderConsole` is a second owner of business a, who reads the order the way the web
 * console does (P-18).
 */
export const SELLERS = Object.freeze({
  signIn: Object.freeze({ phone: '9000000111', businesses: ['a'] }),
  switcher: Object.freeze({ phone: '9000000112', businesses: ['a', 'b'] }),
  automation: Object.freeze({ phone: '9000000113', businesses: ['a'] }),
  orders: Object.freeze({ phone: '9000000114', businesses: ['a'] }),
  orderConsole: Object.freeze({ phone: '9000000115', businesses: ['a'] }),
  payments: Object.freeze({ phone: '9000000116', businesses: ['a'] }),
  devices: Object.freeze({ phone: '9000000117', businesses: ['a'] }),
  other: Object.freeze({ phone: '9000000118', businesses: ['c'] }),
});

/** One cash on delivery order per business, waiting for the seller to confirm it. */
export const ORDERS = Object.freeze({
  a: Object.freeze({ number: 'E2E-A-1001', pricePaise: 49900 }),
  b: Object.freeze({ number: 'E2E-B-1001', pricePaise: 79900 }),
});

export const PRODUCT = Object.freeze({ name: 'Cotton tote', price: '499', stock: '50' });

/** The address on the seeded orders: invented, in the shape checkout writes. */
export const ADDRESS = Object.freeze({ name: 'Test Shopper', phone: '+919800000121', line1: '1 Test Lane', line2: '', landmark: '', city: 'Pune', stateCode: '27', pincode: '411001' });

/** `orderConsole` -> `ORDER_CONSOLE`. */
const upper = (name) => name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();

/**
 * What the flows are told (maestro test -e NAME=value): the seller numbers, the ids the seed made, and where the API
 * and the WhatsApp simulator are, as seen from the machine that runs Maestro. Ids, invented names and numbers only.
 */
export function flowEnv(seeded, { apiUrl, whatsappUrl, appHost }) {
  const env = { API_URL: apiUrl, SIM_WHATSAPP_URL: whatsappUrl, SIGN_IN_HOST: appHost };
  for (const [name, seller] of Object.entries(SELLERS)) env[`PHONE_${upper(name)}`] = seller.phone;
  for (const [key, business] of Object.entries(BUSINESSES)) env[`BUSINESS_${key.toUpperCase()}_NAME`] = business.name;
  for (const [key, business] of Object.entries(seeded.businesses)) env[`BUSINESS_${key.toUpperCase()}_ID`] = String(business.id);
  for (const [key, order] of Object.entries(seeded.orders)) {
    env[`ORDER_${key.toUpperCase()}_ID`] = String(order.id);
    env[`ORDER_${key.toUpperCase()}_NUMBER`] = order.number;
  }
  return env;
}
