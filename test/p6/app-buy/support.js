// What the buying tests share: the shopper app's own session, bag, store client and pay package pointed at a real running store
// (the shopper-api track's world), with a stand-in for the phone's secure storage and for the payment page's browser tab.
import { createCart } from '../../../apps/shopper/src/features/cart/cart.js';
import { createBuy } from '../../../apps/shopper/src/features/cart/buy.js';
import { createAttempt } from '../../../apps/shopper/src/features/checkout/placing.js';
import { createSession } from '../../../apps/shopper/src/features/sign-in/session.js';
import { createPay } from '../../../packages/pay/src/index.js';
import { createStoreClient } from '../../../packages/store-client/src/index.js';

export { ADDRESS, appWorld, markPaid, orderByNumber, payments, product, q } from '../shopper-api/support.js';

/** The phone's SecureStore, in memory. `dump()` is everything it holds. */
export function memoryStore() {
  const held = new Map();
  return {
    getRefreshToken: async () => held.get('refresh') ?? null,
    setRefreshToken: async (value) => (value ? held.set('refresh', value) : held.delete('refresh')),
    getDeviceId: async () => 'device-abcdefghijklmnop',
    clearSession: async () => held.clear(),
    dump: () => Object.fromEntries(held),
  };
}

/** A fetch that remembers every request, and can be slowed down to hold two taps in flight at once. */
export function recorder({ delayMs = 0 } = {}) {
  const calls = [];
  const wrapped = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({ method: init.method ?? 'GET', path: parsed.pathname, query: parsed.search, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return fetch(url, init);
  };
  return { calls, fetch: wrapped };
}

/** The whole shopper side of buying, made the way the app makes it, against the world's store. */
export function shopperSide(world, { delayMs = 0, browser, now } = {}) {
  const net = recorder({ delayMs });
  const store = memoryStore();
  const wiped = [];
  let session = null;
  const client = createStoreClient({
    origin: world.app.base,
    tenantId: world.app.tenant.id,
    version: '1.0.0',
    platform: 'android',
    getAccessToken: () => session.getAccessToken(),
    onUnauthorized: () => session.onUnauthorized(),
    fetch: net.fetch,
  });
  const cart = createCart({ remote: { active: () => session.getState().status === 'signedIn', put: async (lines) => (await client.call('cartPut', { body: { lines } })).lines } });
  session = createSession({
    client,
    store,
    scheme: 'neel',
    random: async (n) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) % 256),
    sha256: async () => 'x',
    onWipe: [() => { wiped.push('wipe'); return cart.wipe(); }],
    now,
  });
  const buy = createBuy(client, { ready: () => session.start() });
  const attempt = createAttempt({ newKey: (() => { let n = 0; return () => `attempt-${Date.now()}-${++n}`; })() });
  const opened = [];
  const tab = browser ?? { openAuthSessionAsync: async (url) => { opened.push(url); return { type: 'success', url: 'neel://order/x' }; } };
  const pay = createPay({
    driver: 'hosted',
    orderState: (token) => client.call('appOrderByToken', { params: { token } }),
    pageUrl: (order) => client.pageUrl('order', { token: order.token }),
    returnUrl: (order) => `neel://order/${order.token}`,
    browser: tab,
    attempts: 2,
    waitMs: 1,
    wait: async () => {},
  });
  return { net, store, client, session, cart, buy, attempt, pay, opened, wiped };
}
