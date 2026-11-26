/**
 * What an Instagram account or Facebook Page row says about who holds it (tenancy-1). Each business keeps its own row, and the
 * database allows one live row per account (migration 921). A row is released when its owner disconnected it: no token and
 * this status_reason. Only a released row lets the account go to another business, and it stays with its business.
 */
export const RELEASED_BY_OWNER = 'owner.disconnected';

/** True when the database refused an Instagram account for a Free business that another Free business already holds (migration 741). */
export const isFreeClaimTaken = (err) => err?.code === '23505' && /signup.free_taken/.test(err.message ?? '');

/** True when a write was refused because another business holds the account or Page live. */
export const isLiveAccountClash = (err) =>
  err?.code === '23505' && /\b(ig_accounts|fb_pages)_live_idx\b/.test(`${err.constraint ?? ''} ${err.message ?? ''}`);
