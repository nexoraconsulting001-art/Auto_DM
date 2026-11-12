// What the shopper-api track's tests share: a store business with its app turned on, a WhatsApp simulator for sign-in codes,
// a second business on its own host, and the stand-in app (shopperApp in test/helpers.js) signed in or not.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { namesPlatform } from '../../../src/contracts/apps.js';
import { withTenant } from '../../../src/tenancy.js';
import { enableApp, shopperApp } from '../../helpers.js';
import { setPlan } from '../../p4/checkout/support.js';
import { world } from '../../p4/shoppers/support.js';

export { ADDRESS, hit, inTenant, markPaid, orderByNumber, payments, placeBody, product, q, withSizes } from '../../p4/checkout/support.js';

/** The store's settings the checkout tests use: no delivery fee, so totals read plainly. */
async function storeSettings(app, tenant, name) {
  await withTenant(tenant, () => app.platform.settings.update({ shipping_fee_paise: '0', free_shipping_above_paise: '0', store_name: name }));
}

/**
 * An app with the WhatsApp (and Google) simulators, whose default business is a tier 3 store with its own app on both
 * platforms. `addStore(slug, name)` makes another such business on <slug>.bhava.test.
 */
export async function appWorld({ overrides = {}, platforms = ['android', 'ios'], google = true } = {}) {
  const w = await world({ overrides, google });
  await setPlan(w.app, w.app.tenant.id, 't3');
  await storeSettings(w.app, w.app.tenant, 'Neel Studio');
  await enableApp(w.app, { platforms });
  const addStore = w.addStore;
  return {
    ...w,
    async addStore(slug, name, { app: withApp = true } = {}) {
      const store = await addStore(slug, name);
      await setPlan(w.app, store.tenant.id, 't3');
      await storeSettings(w.app, store.tenant, name);
      if (withApp) await enableApp(w.app, { platforms, tenant: store.tenant });
      return store;
    },
  };
}

export const newDevice = () => ({ id: crypto.randomBytes(16).toString('hex'), name: 'Pixel 8' });

/** The app of `tenantId` with a guest session. */
export async function guestApp(w, { tenantId = w.app.tenant.id, host, platform = 'android', version = '1.0.0' } = {}) {
  const a = shopperApp(w.app.base, { tenantId, host, platform, version, device: newDevice() });
  const started = await a.start('guest');
  assert.equal(started.status, 201, JSON.stringify(started.body));
  return a;
}

/** The app of `tenantId`, signed in with a WhatsApp code sent to `phone` (10 digits). */
export async function signedInApp(w, { phone, tenantId = w.app.tenant.id, host, platform = 'android' } = {}) {
  const a = await guestApp(w, { tenantId, host, platform });
  const sent = await a.fetch('/api/store/otp/send', { method: 'POST', body: { phone, purpose: 'sign_in' } });
  assert.equal(sent.status, 200, await sent.clone().text());
  const code = await w.lastCode(phone);
  assert.ok(code, 'a code was sent');
  const signedIn = await a.start({ grant: 'otp', phone, code });
  assert.equal(signedIn.status, 201, JSON.stringify(signedIn.body));
  return a;
}

/** A JSON answer and its status. */
export async function json(res) {
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, text, headers: res.headers };
}

/** Nothing a shopper can read names the platform. */
export const assertBrandOnly = (value, what = 'answer') => assert.equal(namesPlatform(typeof value === 'string' ? value : JSON.stringify(value)), false, `${what} names no platform`);
