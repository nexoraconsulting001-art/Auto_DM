// What the WhatsApp add-on's tests share: businesses with a connected number and the add-on, the simulator's deliveries
// and outbox, and Meta-shaped signed webhooks. Each test file is its own process and calls useWorld() once. Track whatsapp-addon.
import crypto from 'node:crypto';
import { withTenant } from '../../../src/tenancy.js';
import { STORE_PROVIDER_PATHS, SIGNATURE_HEADERS, hit, json, need, one, shopOn, sql, unique } from '../spec-p7/support.js';

let world;
let prefix = 6_000_000;
/** Points the helpers at this file's world; `numbers` keeps each file's phone number ids apart. */
export function useWorld(w, { numbers = 6_000_000 } = {}) {
  world = w;
  prefix = numbers;
}

export const HOUR = 3_600_000;
export const feature = (shop, enabled = true) => sql(world, `INSERT INTO tenant_features (tenant_id, feature, enabled, limit_value) VALUES ($1, 'whatsapp_automation', $2, NULL) ON CONFLICT (tenant_id, feature) DO UPDATE SET enabled = EXCLUDED.enabled`, [shop.tenantId, enabled]);

let serial = 0;
export async function waShop(name) {
  const shop = await shopOn(world, 't1', name ? { name } : {});
  await feature(shop);
  const phoneId = `${prefix + ++serial}${crypto.randomInt(1000, 9999)}`;
  await sql(world, `INSERT INTO whatsapp_accounts (tenant_id, waba_id, phone_number_id, display_number, access_token_enc, status, display_name) VALUES ($1, $2, $3, '+919800000000', $4, 'active', $5)
    ON CONFLICT (tenant_id) DO UPDATE SET phone_number_id = EXCLUDED.phone_number_id, waba_id = EXCLUDED.waba_id, status = 'active', display_name = EXCLUDED.display_name, access_token_enc = EXCLUDED.access_token_enc`,
  [shop.tenantId, `waba${phoneId}`, phoneId, world.secrets.encrypt('sim-whatsapp-token'), shop.name]);
  await world.wa.post('/numbers', { phoneId, displayName: shop.name, displayNumber: '+919800000000' });
  shop.phoneId = phoneId;
  return shop;
}
export const keywordsFor = async (shop, items) => json(need(await shop.send('PUT', '/whatsapp/keywords', { items }), 200, 'Saving keyword sets'));
export const linkSet = (keyword, linkUrl, rest = {}) => ({ keywords: [keyword], reelId: null, linkUrl, message: '', active: true, ...rest });
export const shopper = () => `9188${crypto.randomInt(10_000_000, 99_999_999)}`;
export const sentTo = async (to) => (await world.wa.get('/sent')).sent.filter((m) => !to || m.to === to);
export const bodyOf = (m) => JSON.stringify(m.body?.text ?? m.body?.template ?? m.body);
export const inbound = (shop, from, text, rest = {}) => world.wa.post('/inbound', { phoneId: shop.phoneId, from, text, name: 'Asha', ...rest });
export const hash = (shop, from) => withTenant(shop.tenant, () => world.platform.compliance.subjectHash('whatsapp', from));
export const waEvents = (shop) => sql(world, `SELECT * FROM inbound_events WHERE tenant_id = $1 AND channel = 'whatsapp' ORDER BY id`, [shop.tenantId]);
export const threadOf = async (shop, from) => one(world, `SELECT * FROM inbox_threads WHERE tenant_id = $1 AND channel = 'whatsapp' AND subject_hash = $2`, [shop.tenantId, await hash(shop, from)]);

/** A delivery as Meta would send it, as the exact bytes a test signs with sign(). */
export function delivery(phoneId, from, text, { messageId = `wamid.t${unique()}`, at = Date.now() } = {}) {
  return JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '919800000000', phone_number_id: phoneId }, contacts: [{ wa_id: from, profile: { name: 'Ravi' } }], messages: [{ from, id: messageId, timestamp: String(Math.floor(at / 1000)), type: 'text', text: { body: text } }] } }] }] });
}
export const sign = (raw) => `sha256=${crypto.createHmac('sha256', world.wa.appSecret).update(raw).digest('hex')}`;
export const post = (raw, signature) => hit(world, STORE_PROVIDER_PATHS.whatsapp.path, { method: 'POST', headers: { 'content-type': 'application/json', ...(signature ? { [SIGNATURE_HEADERS.whatsapp]: signature } : {}) }, body: raw });
