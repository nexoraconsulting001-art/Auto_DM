/** Pure: what Home shows, as string keys and paths, from the API's answers. No React, so the server's tests load it too. */
import { isAllowed, staffWith } from '@bhava/app-core/access';

const DAY_MS = 86_400_000;

/** The setup steps the console knows, in its order, and the app screen each one opens. */
export const CHECKLIST_STEPS = Object.freeze({
  instagram: '/connect',
  store_details: '/settings',
  products: '/products',
  reel: '/reels',
  comment: '/activity',
  order: '/orders',
});

/** Finished or hidden, the checklist is not shown at all (the console's rule). Steps this build does not know are left out. */
export function checklistView(checklist) {
  const steps = (checklist?.steps ?? []).filter((step) => Object.hasOwn(CHECKLIST_STEPS, step.key));
  const done = steps.filter((step) => step.done).length;
  const nextKey = steps.find((step) => !step.done)?.key;
  return {
    visible: Boolean(checklist) && !checklist.dismissed && steps.length > 0 && done < steps.length,
    done,
    total: steps.length,
    steps: steps.map((step) => ({ key: step.key, done: step.done, next: step.key === nextKey, path: CHECKLIST_STEPS[step.key] })),
  };
}

/** The first word of a name, for "Hello, Asha". Nothing for no name. */
export const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] ?? '';

export const HEALTH_TONES = Object.freeze({ good: 'good', watch: 'warn', at_risk: 'bad' });

/** Whole days until an active connection's access runs out, or null when there is nothing to say. */
export function renewalDays(connection, now = Date.now()) {
  if (connection?.status !== 'active' || !connection.tokenExpiresAt) return null;
  const at = new Date(connection.tokenExpiresAt).getTime();
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / DAY_MS));
}

/**
 * The cards under "Needs you", most urgent first: orders to confirm and to ship (for someone who may open orders) and
 * chats waiting for a person. `waiting` is the first page of inbox.needsHuman, or null for someone without the inbox.
 */
export function needsYou({ stats, waiting = null, user }) {
  const items = [];
  const orders = isAllowed(user ?? null, staffWith('orders'));
  if (orders && stats?.toConfirm > 0) items.push({ key: 'confirm', title: 'home.needs.confirm', values: { count: stats.toConfirm }, body: 'home.needs.confirmBody', cta: 'home.needs.confirmAction', path: '/orders' });
  if (orders && stats?.toShip > 0) items.push({ key: 'ship', title: 'home.needs.ship', values: { count: stats.toShip }, body: 'home.needs.shipBody', cta: 'home.needs.shipAction', path: '/orders' });
  const open = waiting?.items?.length ?? 0;
  if (open > 0) items.push({ key: 'human', title: 'home.needs.human', values: { count: waiting.nextCursor ? `${open}+` : String(open) }, body: 'home.needs.humanBody', cta: 'home.needs.humanAction', path: '/inbox/needs-human' });
  return items;
}
