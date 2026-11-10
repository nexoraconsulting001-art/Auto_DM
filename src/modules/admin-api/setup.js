import { forAccount } from '../../instagram.js';
import { SETTING_DEFAULTS } from '../../repos/settings.js';
import { currentTenant } from '../../tenancy.js';

const CHECK_TTL_MS = 10 * 60_000;

/** The Instagram connection check and the "set up your store" checklist, shared by the API and the old admin pages. */
export function createSetupChecks({ repos, ig }) {
  // Whether each business's Instagram token works, cached so the dashboard stays fast.
  const igChecks = new Map();

  /** The Instagram client for this business's connected account, or null when it has none. */
  async function igClient() {
    const account = await repos.igAccounts.current();
    return account ? forAccount(ig, account) : null;
  }

  /** { connected, username }. A token Instagram refuses counts as not connected. */
  async function instagramStatus(client) {
    if (!client) return { connected: false, username: '' };
    const business = currentTenant().id;
    const hit = igChecks.get(business);
    if (hit && Date.now() - hit.at < CHECK_TTL_MS) return hit.status;
    let username = '';
    try {
      username = String((await client.getAccount())?.username ?? '');
    } catch {
      username = '';
    }
    const status = { connected: Boolean(username), username };
    igChecks.set(business, { at: Date.now(), status });
    return status;
  }

  async function setupChecklist(settings, kit, stats, reels, client) {
    const comments = await repos.activity.count();
    const storeChanged = settings.store_name !== SETTING_DEFAULTS.store_name || Boolean(kit.logoUrl);
    return {
      dismissed: settings.checklist_dismissed === '1',
      steps: [
        { key: 'instagram', title: 'Connect Instagram', text: 'Connect your Instagram account so comments can be answered with a DM.', done: (await instagramStatus(client)).connected, href: '/admin/settings', action: 'Check connection' },
        { key: 'store_details', title: 'Add your store details', text: 'Store name, logo, WhatsApp number and delivery fee.', done: storeChanged, href: '/admin/settings', action: 'Open settings' },
        { key: 'products', title: 'Add products', text: 'Photos, price and MRP. Group them into categories for the shop.', done: stats.products > 0, href: '/admin/products/new', action: 'Add a product' },
        { key: 'reel', title: 'Set up your first reel store', text: 'Pick a reel, choose its products and the keyword people comment.', done: reels.length > 0, href: '/admin/reels', action: 'Choose a reel' },
        { key: 'comment', title: 'Receive a comment', text: 'Comment your keyword on the reel from another account. The DM shows up in DM activity.', done: comments > 0, href: '/admin/activity', action: 'See DM activity' },
        { key: 'order', title: 'Get your first order', text: 'Share your store link. Orders land in Orders for you to confirm.', done: stats.orders > 0, href: '/', action: 'Open your store' },
      ],
    };
  }

  return { igClient, instagramStatus, setupChecklist };
}
