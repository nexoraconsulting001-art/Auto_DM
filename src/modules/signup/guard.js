/**
 * What sign-up asks before it opens to the public (Phase 9, G-17). It is `ctx.signupGuard` in the app and in the worker.
 *
 *   ctx.signupGuard.use(async ({ mode, actor }) => ({ ok: false, missing: ['meta.app_live'] }))     in a module's setup(ctx)
 *   await ctx.signupGuard.check({ mode: 'public', actor })    -> { ok, missing: [...ids], enforced }
 *
 * The golive module registers the checklist (src/contracts/golive.js: SignupGuardVerdict); this module only asks. So the
 * sign-up module never imports the checklist and the golive track never edits this folder.
 *
 * - Only a move to `public` is asked about. `closed` and `invite` always pass.
 * - With no guard registered, or with GOLIVE_ENFORCE off (the default outside production), every move passes, and
 *   `enforced` says which it was.
 * - A guard that throws counts as "not ready", with `guard.failed` as what is missing: a broken check never opens sign-up.
 * - `missing` holds checklist item ids only, at most 50, so an answer or an audit row never carries a setting's value.
 */
const ID = /^[a-z][a-z0-9_.]{1,60}$/;

export function createSignupGuard({ enforce = false } = {}) {
  const guards = [];
  return {
    use(fn) {
      if (typeof fn !== 'function') throw new Error('A sign-up guard is a function');
      guards.push(fn);
    },
    get enforced() {
      return Boolean(enforce) && guards.length > 0;
    },
    async check({ mode, actor = '' } = {}) {
      const enforced = Boolean(enforce) && guards.length > 0;
      if (mode !== 'public' || !enforced) return { ok: true, missing: [], enforced };
      const missing = new Set();
      for (const guard of guards) {
        try {
          const verdict = await guard({ mode, actor });
          if (verdict?.ok === true) continue;
          const ids = Array.isArray(verdict?.missing) ? verdict.missing.map(String).filter((id) => ID.test(id)) : [];
          for (const id of ids.length ? ids : ['guard.not_ready']) missing.add(id);
        } catch {
          missing.add('guard.failed');
        }
      }
      return { ok: missing.size === 0, missing: [...missing].slice(0, 50), enforced };
    },
  };
}
