import { ApiError } from '../../contracts/api/index.js';
import { currentTenant } from '../../tenancy.js';

const SESSION_DAYS = 30;

/**
 * The Phase 0 answers of the auth routes: who is signed in, their businesses, signing out, and phone-and-password
 * login. Password login happens on the business's own address, which is how the business is known at that moment,
 * and exists only while PASSWORD_LOGIN is on: the server answers 404 for it otherwise. Sign-in without passwords,
 * access and refresh tokens and devices are src/modules/accounts. Signing out works for every kind of session:
 * repos.sessions.revoke ends an app's refresh family with it.
 */
export const apiAuth = {
  name: 'api-auth',
  api({ repos, auth }) {
    async function describe(user) {
      const business = currentTenant();
      const kit = await repos.brandKit.get();
      return {
        user: { id: user.id, name: user.name, phone: user.phone, role: user.role, permissions: user.permissions ?? [] },
        business: { id: business.id, slug: business.slug, name: business.name, plan: business.plan, logoUrl: kit.logoUrl, accountType: business.account_type ?? 'seller' },
      };
    }

    return {
      'auth.login': async ({ body, req, res }) => {
        if (await auth.tooManyAttempts(req)) throw new ApiError('rate_limited', 'Too many tries. Wait 15 minutes and try again.');
        const user = await repos.users.verify(body.phone, body.password);
        if (!user) {
          await auth.recordFailure(req);
          throw new ApiError('unauthorized', 'That mobile number and password don’t match.');
        }
        if (body.transport === 'cookie') return { ...(await describe(user)), csrf: await auth.login(req, res, user) };
        await auth.clearFailures(req);
        const token = await repos.sessions.create(user.id, SESSION_DAYS, 'bearer');
        return { token, expiresInDays: SESSION_DAYS, ...(await describe(user)) };
      },

      'auth.me': async ({ user, req }) => ({ ...(await describe(user)), ...(req.csrf ? { csrf: req.csrf } : {}), freshUntil: req.session?.freshUntil ?? null }),

      'auth.logout': async ({ req, res }) => {
        if (req.bearer) await repos.sessions.revoke(req.sessionToken);
        else await auth.logout(req, res);
      },

      'auth.businesses': async ({ user }) => ({
        businesses: (await repos.users.businesses(user)).map((b) => ({ id: b.id, slug: b.slug, name: b.name, role: b.role, logoUrl: b.logo_url, current: b.current })),
      }),
    };
  },
};
