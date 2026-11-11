import { buyerBaseUrl } from '../admin-api/urls.js';
import { tenantId } from '../../tenancy.js';

/**
 * What a message to a shopper says about the business it comes from: its own store name, its own buyer address (the
 * verified primary domain when it has one) and its brand colour. Never the platform's name or address. Read inside the
 * business.
 */
const HEX = /^#[0-9a-f]{6}$/i;

export async function businessOf({ repos, config }) {
  const tenant = await repos.tenants.get(tenantId());
  const settings = await repos.settings.getAll().catch(() => ({}));
  const kit = await repos.brandKit.get().catch(() => null);
  const storeName = String(settings?.store_name ?? '').trim();
  const name = storeName && storeName !== 'My store' ? storeName : String(tenant?.name ?? '').trim();
  const base = tenant ? String(buyerBaseUrl(tenant, config) ?? '').replace(/\/+$/, '') : '';
  const primary = kit?.colors?.primary;
  return { name, base, color: HEX.test(String(primary ?? '')) ? primary : '#16152B' };
}

/** The first word of a person's name, for "Hi Asha", or a friendly word when there is none. */
export function firstName(name) {
  const first = String(name ?? '').trim().split(/\s+/)[0] ?? '';
  return first.replace(/[^\p{L}\p{M}'-]/gu, '').slice(0, 30) || 'there';
}
