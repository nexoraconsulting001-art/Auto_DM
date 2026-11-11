import { FRESH_MINUTES } from '../../contracts/accounts.js';
import { ApiError } from '../../contracts/api/index.js';
import { isSameOrigin } from '../../auth.js';
import { log } from '../../platform/log.js';
import { currentTenant, withTenant } from '../../tenancy.js';
import { businessesOf, describeSession } from './describe.js';
import { platformOf } from './shared.js';

/**
 * Opening a session for a person who has just proved who they are (PRD 5.11, 10.2, 10.3). Every sign-in ends here,
 * whatever proved it: a WhatsApp code, Google, Apple or the review login.
 *
 * Which account opens: on a business's own address, the person's account there and nothing else; elsewhere (the
 * sign-in host) the business asked for with `tenantId`, or the one they used last. A person with no seller account
 * anywhere gets a creator business on the Free plan (F-109), and the answer says `created`. Signing in again cancels a
 * request to delete the account.
 *
 * Transport "bearer" is the owner app: a refresh family, a refresh token and a fresh access session. Transport
 * "cookie" is the web console: the cookie session, in a family of its own so revoking the device ends it too, and only
 * from this site.
 */
export function sessionOpener(ctx, { people, tokens, devices }) {
  const db = () => platformOf(ctx.db);

  async function chooseAccount({ req, personId, tenantId, review }) {
    if (review) return { account: review, created: false };
    const host = req.appHost ? null : currentTenant();
    if (host) {
      const account = await people.accountIn(personId, host.id);
      if (!account) throw new ApiError('forbidden', 'You don’t have an account at this business. Ask its owner to invite you.');
      return { account, created: false };
    }
    if (tenantId) {
      const account = await people.accountIn(personId, tenantId);
      if (!account) throw new ApiError('forbidden', 'You don’t have an account at that business.');
      return { account, created: false };
    }
    const [last] = await people.accounts(personId);
    if (last) return { account: last, created: false };
    return { account: await people.makeFirstBusiness(personId), created: true };
  }

  /**
   * `review` is the review login's demo account ({ tenant_id, user_id }), which opens that business only. `checkOrigin`
   * is false for the Google callback, whose state cookie already ties it to the browser that started it.
   */
  async function open({ req, res, personId, transport = 'bearer', device, tenantId, via, review = null, checkOrigin = true }) {
    if (transport === 'cookie' && checkOrigin && !isSameOrigin(req)) throw new ApiError('forbidden', 'Please sign in from this website.');
    await db().query(`UPDATE account_deletion_requests SET status = 'cancelled' WHERE person_id = $1 AND status = 'requested'`, [personId]);
    if (!review) await people.reconcile(personId);
    const { account, created } = await chooseAccount({ req, personId, tenantId, review });
    const tenant = await ctx.repos.tenants.get(account.tenant_id);
    if (!tenant) throw new ApiError('unauthorized');

    return withTenant(tenant, async () => {
      const user = await ctx.repos.users.get(account.user_id);
      if (!user) throw new ApiError('unauthorized');
      const deviceUnlock = await devices.seen(personId, device);
      const described = await describeSession(ctx.repos, user);
      const freshUntil = new Date(Date.now() + FRESH_MINUTES * 60_000);
      let carried;
      if (transport === 'cookie') {
        const familyId = await tokens.webFamily({ personId, deviceId: device?.id ?? '' });
        carried = { csrf: await ctx.auth.login(req, res, user, { familyId, deviceId: device?.id ?? null }) };
      } else {
        const issued = await tokens.issueApp({ personId, tenantId: tenant.id, userId: user.id, deviceId: device?.id ?? '' });
        carried = { accessToken: issued.accessToken, accessExpiresInSeconds: issued.accessExpiresInSeconds, refreshToken: issued.refreshToken };
      }
      log.info('accounts.signed_in', { via, transport, personId, userId: user.id, created });
      return { ...described, ...carried, freshUntil, businesses: await businessesOf(ctx.repos, user), created, deviceUnlock };
    });
  }

  return { open };
}
