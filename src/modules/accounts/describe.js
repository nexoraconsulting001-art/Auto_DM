import { currentTenant } from '../../tenancy.js';
import { ownPhone } from './shared.js';

/**
 * The signed-in seller and their business as the API shows them (CurrentSession), for the current business. The
 * business's logo is workspace identity only: everything else a seller sees is the platform's.
 */
export async function describeSession(repos, user) {
  const business = currentTenant();
  const kit = await repos.brandKit.get();
  return {
    user: { id: user.id, name: user.name, phone: ownPhone(user.phone), role: user.role, permissions: user.role === 'staff' ? user.permissions ?? [] : [] },
    business: { id: business.id, slug: business.slug, name: business.name, plan: business.plan, logoUrl: kit?.logoUrl ?? '', accountType: business.account_type ?? 'seller' },
  };
}

/** The businesses this seller can switch to, this one first (Membership). */
export async function businessesOf(repos, user) {
  return (await repos.users.businesses(user)).map((b) => ({ id: b.id, slug: b.slug, name: b.name, role: b.role, logoUrl: b.logo_url ?? '', current: b.current }));
}
