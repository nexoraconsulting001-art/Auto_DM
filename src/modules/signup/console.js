import { mountPlatform } from '../app-config/index.js';
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

  mountPlatform(router, 'platform.setSignupMode', async ({ body, actor }) => {
    await s().setMode(body.mode, { actor, reason: body.reason });
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
