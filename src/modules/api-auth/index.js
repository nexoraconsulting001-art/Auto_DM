import { ApiError } from '../../contracts/api/index.js';
import { businessesOf, describeSession } from '../accounts/describe.js';
import { dropPushDevices } from '../accounts/tokens.js';

const SESSION_DAYS = 30;

/**
 * The Phase 0 answers of the auth routes: who is signed in, their businesses, signing out, and phone-and-password
 * login. Password login happens on the business's own address, which is how the business is known at that moment,
 * and exists only while PASSWORD_LOGIN is on: the server answers 404 for it otherwise, and so does this handler.
 * Sign-in without passwords, access and refresh tokens and devices are src/modules/accounts. Signing out works for
 * every kind of session: repos.sessions.revoke ends a refresh family with it, and the device stops getting pushes.
 */
export const apiAuth = {
  name: 'api-auth',
  api(ctx) {
    const describe = (user) => describeSession(ctx.repos, user);

    return {
      'auth.login': async ({ body, req, res }) => {
        if (!ctx.config?.passwordLogin) throw new ApiError('not_found');
        const { repos, auth } = ctx;
        if (await auth.tooManyAttempts(req)) throw new ApiError('rate_limited', 'Too many tries. Wait 15 minutes and try again.');
        const user = await repos.users.verify(body.phone, body.password);
        if (!user) {
          await auth.recordFailure(req);
          throw new ApiError('unauthorized', 'That mobile number and password don’t match.');
        }
        // A good password never wipes the count of guesses made from this address at someone else's.
        if (body.transport === 'cookie') return { ...(await describe(user)), csrf: await auth.login(req, res, user) };
        const token = await repos.sessions.create(user.id, SESSION_DAYS, 'bearer');
        return { token, expiresInDays: SESSION_DAYS, ...(await describe(user)) };
      },

      'auth.me': async ({ user, req }) => ({ ...(await describe(user)), ...(req.csrf ? { csrf: req.csrf } : {}), freshUntil: req.session?.freshUntil ?? null }),

      'auth.logout': async ({ user, req, res }) => {
        if (req.bearer) await ctx.repos.sessions.revoke(req.sessionToken);
        else await ctx.auth.logout(req, res);
        const deviceId = req.session?.deviceId ?? null;
        if (user?.person_id && deviceId) {
          const platform = ctx.db.platform ?? ctx.db;
          await platform.tx((t) => dropPushDevices(t, { personId: user.person_id, deviceId, reason: 'signed_out' }));
        }
      },

      'auth.businesses': async ({ user }) => ({ businesses: await businessesOf(ctx.repos, user) }),
    };
  },
};
