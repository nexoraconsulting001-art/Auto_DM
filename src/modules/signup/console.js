import { mountPlatform } from '../app-config/index.js';
import { ApiError } from '../../contracts/api/index.js';
import { newInviteCode } from './rules.js';
import { signupStore } from './store.js';

/**
 * The Platform Console's sign-up controls (PRD 5.20): the mode (closed, invite or public; a super admin's change, with a
 * reason, audited), and invite codes, each shown once when made and stored only as its hash, counted in the database and
 * revocable. BILLING_PLATFORM_OWNERS.signup.
 */
export function signupConsoleRoutes(router, ctx) {
  let store;
  const s = () => (store ??= signupStore(ctx.db));

  mountPlatform(router, 'platform.signup', () => s().settings());

  // Opening to the public asks the go-live guard first (ctx.signupGuard, src/modules/signup/guard.js; G-17). While a
  // blocking item is missing the move is refused with the item ids, unless the super admin forces it with a second reason.
  mountPlatform(router, 'platform.setSignupMode', async ({ body, actor }) => {
    const verdict = ctx.signupGuard ? await ctx.signupGuard.check({ mode: body.mode, actor }) : { ok: true, missing: [] };
    if (!verdict.ok && !body.force) {
      throw new ApiError('conflict', 'Sign-up can’t open to the public yet: the go-live checklist has blocking items missing.', { reason: 'signup.golive_blocked', fields: { golive: verdict.missing.join(' ') } });
    }
    const forced = !verdict.ok && body.force ? { reason: body.forceReason, missing: verdict.missing } : null;
    await s().setMode(body.mode, { actor, reason: body.reason, dailyCap: body.dailyCap, forced });
    return s().settings();
  });

  mountPlatform(router, 'platform.signupInvites', ({ query }) => s().listInvites(query));

  mountPlatform(router, 'platform.createSignupInvite', async ({ body, actor }) => {
    const code = newInviteCode();
    const invite = await s().createInvite({ code, note: body.note, maxUses: body.maxUses, expiresInDays: body.expiresInDays, actor });
    return { invite, code };
  });

  mountPlatform(router, 'platform.revokeSignupInvite', ({ params, actor }) => s().revokeInvite(params.id, actor));
}
