import { ApiError } from '../../contracts/api/index.js';
import { AutomationInput } from '../../contracts/api/automations.js';
import { SIGNUP_TARGET_MS } from '../../contracts/billing.js';
import { log } from '../../platform/log.js';
import { currentTenant, withTenant } from '../../tenancy.js';
import { NO_PASSWORD, accountPhone } from '../accounts/shared.js';
import { writeAudit } from '../audit/index.js';
import { normalizeReferralCode, recordReferral } from '../referrals/service.js';
import { linkMemberships } from '../team/invites.js';
import { FIRST_AUTOMATION, SIGNUP_LIMITS, businessHost, newRunToken, nextStep, problemField, slugCandidates } from './rules.js';
import { signupStore } from './store.js';

const UNIQUE = '23505';

/**
 * The four sign-up routes (PRD 5.20), PUBLIC and answered with no business on PLATFORM_APP_HOST. The person has signed in
 * there with Google or a WhatsApp code (the accounts module); each handler finds that person from the session and answers
 * 401 without one. Nothing is read from ctx until a handler runs.
 */
export function signupApi(ctx) {
  let built;
  const services = () => {
    built ??= { store: signupStore(ctx.db), db: ctx.db.platform ?? ctx.db };
    return built;
  };

  async function limit(spec, subject) {
    const hit = await ctx.platform.rateLimit.hit(spec.scope, String(subject ?? ''), spec);
    if (!hit.allowed) throw new ApiError('rate_limited', 'Too many tries. Wait a little and try again.');
  }

  /** The signed-in person, or null. A Phase 0 password session has no person and cannot sign up. */
  const personOf = (user) => (Number(user?.person_id) > 0 ? Number(user.person_id) : null);
  function requirePerson(user) {
    const personId = personOf(user);
    if (!personId) throw new ApiError('unauthorized', 'Sign in with Google or WhatsApp to continue.');
    return personId;
  }

  /** The run this request names, when it is this person's (or nobody's yet). */
  async function ownRun(token, personId) {
    const { store } = services();
    const run = await store.runByToken(token);
    if (!run || !(await store.claimRun(run, personId))) return null;
    return run;
  }

  async function startedRun(token, personId) {
    const run = await ownRun(token, personId);
    if (!run?.tenantId) throw new ApiError('not_found', 'Start signing up again from the first step.');
    return run;
  }

  async function tenantOf(id) {
    const tenant = await ctx.repos.tenants.get(id);
    if (!tenant) throw new ApiError('not_found', 'Start signing up again from the first step.');
    return tenant;
  }

  /** Records instagram_connected once the business has its account (ig-connect stores the token and its scopes). */
  async function noteInstagram(run) {
    const { store } = services();
    if (!run.tenantId || !(await store.instagramConnected(run.tenantId))) return false;
    await store.step(run, 'instagram_connected');
    return true;
  }

  /**
   * The empty Free business a first sign-in made for this person (F-109, the accounts module), held or not (auth-2),
   * which this sign-up becomes instead of making a second one: theirs alone, on Free, with no sign-up run, no Instagram account, no automation and no
   * product. Null otherwise.
   */
  async function adoptable(t, personId) {
    const session = currentTenant();
    if (!session?.id) return null;
    const [row] = await t.query(
      `SELECT t.id FROM tenants t
       WHERE t.id = $1 AND t.plan = 'free' AND t.status NOT IN ('suspended', 'closed', 'killed')
         AND EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = t.id AND u.person_id = $2 AND u.role = 'owner' AND u.removed_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = t.id AND u.person_id IS DISTINCT FROM $2)
         AND NOT EXISTS (SELECT 1 FROM signup_runs r WHERE r.tenant_id = t.id)
         AND NOT EXISTS (SELECT 1 FROM ig_accounts a WHERE a.tenant_id = t.id)
         AND NOT EXISTS (SELECT 1 FROM automations a WHERE a.tenant_id = t.id)
         AND NOT EXISTS (SELECT 1 FROM products p WHERE p.tenant_id = t.id)
       FOR UPDATE OF t`,
      [Number(session.id), personId],
    );
    return row ? Number(row.id) : null;
  }

  /** Makes (or adopts) the business on Free, its owner, the run's link to it and its referral, in one transaction. */
  async function makeBusiness({ run, personId, body, mode }) {
    const { store, db } = services();
    const [person] = await db.query('SELECT name FROM people WHERE id = $1 AND deleted_at IS NULL', [personId]);
    if (!person) throw new ApiError('unauthorized', 'Sign in with Google or WhatsApp to continue.');
    const [phone] = await db.query(`SELECT subject FROM person_identities WHERE person_id = $1 AND kind = 'phone' ORDER BY verified_at, id LIMIT 1`, [personId]);
    const name = body.name.trim();
    let lastError;
    for (const slug of slugCandidates(name)) {
      try {
        return await db.tx(async (t) => {
          let inviteId = null;
          if (mode === 'invite') {
            inviteId = await store.takeInvite(t, body.inviteCode);
            if (!inviteId) throw new ApiError('forbidden', 'That invite code can’t be used. Check it, or ask for a new one.', { reason: 'signup.invite_invalid' });
          }
          const [taken] = await t.query('SELECT 1 FROM tenants WHERE slug = $1', [slug]);
          if (taken) throw Object.assign(new Error('slug taken'), { code: UNIQUE });
          let tenantId = await adoptable(t, personId);
          const adopted = Boolean(tenantId);
          let userId;
          if (adopted) {
            await t.query('UPDATE tenants SET slug = $2, name = $3, account_type = $4, signup_held = false WHERE id = $1', [tenantId, slug, name.slice(0, 80), body.accountType]);
            [{ id: userId }] = await t.query(`SELECT id FROM users WHERE tenant_id = $1 AND person_id = $2 AND role = 'owner' ORDER BY id LIMIT 1`, [tenantId, personId]);
          } else {
            [{ id: tenantId }] = await t.query(`INSERT INTO tenants (slug, name, plan, account_type) VALUES ($1, $2, 'free', $3) RETURNING id`, [slug, name.slice(0, 80), body.accountType]);
            [{ id: userId }] = await t.query(
              `INSERT INTO users (tenant_id, name, phone, email, password_hash, role, person_id) VALUES ($1, $2, $3, '', $4, 'owner', $5) RETURNING id`,
              [tenantId, (person.name || name).slice(0, 80), accountPhone(phone?.subject, personId), NO_PASSWORD, personId],
            );
          }
          const referralCode = normalizeReferralCode(body.referralCode) || run.referralCode;
          await t.query(
            'UPDATE signup_runs SET tenant_id = $2, person_id = $3, account_type = $4, invite_id = $5, referral_code = $6 WHERE id = $1',
            [run.id, tenantId, personId, body.accountType, inviteId, referralCode],
          );
          await store.step(run, 'signed_in', t);
          await store.step(run, 'account_type', t);
          const referral = await recordReferral(t, { code: referralCode, referredTenantId: tenantId, personId });
          return { tenantId: Number(tenantId), userId: Number(userId), slug, adopted, referral };
        });
      } catch (err) {
        if (err?.code !== UNIQUE || /signup_runs/.test(String(err.constraint ?? err.message))) throw err;
        lastError = err;
      }
    }
    throw lastError ?? new Error('No address could be chosen for the new business');
  }

  let automationHandlers;
  const automations = () => {
    automationHandlers ??= ctx.modules?.find((m) => m.name === 'automations')?.api?.(ctx);
    if (!automationHandlers) throw new Error('The automations module is needed for the first automation');
    return automationHandlers;
  };

  const problemOf = (err) => ({
    field: problemField(Object.keys(err.fields ?? {})[0]),
    reason: String(err.reason ?? err.code ?? 'invalid'),
    message: err.message,
  });

  return {
    async 'signup.status'({ query, user, req }) {
      const { store } = services();
      const personId = personOf(user);
      const settings = await store.settings();
      let token = query.runToken ?? '';
      let run = token ? await store.runByToken(token) : null;
      if (run && personId && !(await store.claimRun(run, personId))) run = null;
      if (run && !personId && run.personId !== null) run = null;
      const ref = normalizeReferralCode(query.ref);
      if (!run) {
        await limit(SIGNUP_LIMITS.runsPerAddress, req?.ip);
        token = newRunToken();
        run = await store.newRun(token, { personId, referralCode: ref });
      } else if (ref) await store.setReferral(run, ref);
      if (personId) await store.step(run, 'signed_in');
      await noteInstagram(run);

      let open = settings.mode === 'public' || Boolean(run.tenantId);
      if (!open && settings.mode === 'invite' && query.inviteCode) {
        await limit(SIGNUP_LIMITS.invitesPerAddress, req?.ip);
        open = await store.inviteUsable(query.inviteCode);
      }
      const steps = await store.steps(run);
      return {
        mode: settings.mode, signedIn: Boolean(personId), open, runToken: token, tenantId: run.tenantId, accountType: run.accountType,
        steps, next: nextStep(new Set(steps.map((s) => s.step))),
      };
    },

    async 'signup.start'({ body, user, req }) {
      const { store } = services();
      const personId = requirePerson(user);
      const settings = await store.settings();
      if (settings.mode === 'closed') throw new ApiError('forbidden', 'Sign-up isn’t open yet.', { reason: 'signup.closed' });
      if (settings.mode === 'invite' && !body.inviteCode) throw new ApiError('forbidden', 'Sign-up is by invitation for now. Enter your invite code.', { reason: 'signup.invite_required' });

      let token = body.runToken;
      let run = token ? await ownRun(token, personId) : null;
      if (run?.tenantId) {
        const tenant = await tenantOf(run.tenantId);
        return { tenantId: run.tenantId, slug: tenant.slug, host: businessHost(tenant.slug, ctx.config), runToken: token, next: nextStep(new Set((await store.steps(run)).map((s) => s.step))) ?? 'finished' };
      }
      // The day's cap on new businesses (signup_settings.daily_cap, Phase 9): a soft ceiling for a launch, read before the
      // business is made, so two sign-ups in the same instant can pass it by one.
      if (settings.dailyCap !== null && settings.dailyCap !== undefined && (await store.madeToday()) >= settings.dailyCap) {
        throw new ApiError('forbidden', 'Sign-up is full for today. Please try again tomorrow.', { reason: 'signup.daily_cap' });
      }
      await limit(SIGNUP_LIMITS.startsPerAddress, req?.ip);
      await limit(SIGNUP_LIMITS.startsPerPerson, personId);
      if (!run) {
        token = newRunToken();
        run = await store.newRun(token, { personId });
      }

      const made = await makeBusiness({ run, personId, body, mode: settings.mode });
      await withTenant({ id: made.tenantId, slug: made.slug }, () => ctx.db.tx((t) => writeAudit(t, {
        actor: `user:${made.userId}`, action: 'business.created', target: `tenant:${made.tenantId}`,
        details: { accountType: body.accountType, plan: 'free', via: 'signup', adopted: made.adopted, referred: Boolean(made.referral) },
      })));
      await linkMemberships(ctx.db, personId);
      log.info('signup.started', { runId: run.id, personId, tenantId: made.tenantId, adopted: made.adopted, referral: made.referral?.state ?? null });
      run.tenantId = made.tenantId;
      const connected = await noteInstagram(run);
      return { tenantId: made.tenantId, slug: made.slug, host: businessHost(made.slug, ctx.config), runToken: token, next: connected ? 'automation_drafted' : 'instagram_connected' };
    },

    async 'signup.firstAutomation'({ body, user }) {
      const { store, db } = services();
      const personId = requirePerson(user);
      const run = await startedRun(body.runToken, personId);
      const tenant = await tenantOf(run.tenantId);
      if (!(await noteInstagram(run))) {
        return { automationId: null, live: false, problems: [{ field: 'instagram', reason: 'instagram.not_connected', message: 'Connect your Instagram account first.' }] };
      }
      const [owner] = await db.query(`SELECT id, name, role FROM users WHERE tenant_id = $1 AND person_id = $2 AND role = 'owner' AND removed_at IS NULL ORDER BY id LIMIT 1`, [tenant.id, personId]);
      if (!owner) throw new ApiError('forbidden', 'Only the owner can set this up.');
      const actor = { id: Number(owner.id), role: 'owner', name: owner.name };

      return withTenant(tenant, async () => {
        const handlers = automations();
        const keyword = body.keyword.trim();
        const input = AutomationInput.parse({
          name: `Comment “${keyword}”`.slice(0, 120),
          triggerType: 'comment',
          keywords: [keyword],
          linkMode: 'two_tap',
          linkType: 'seller_site',
          linkUrl: body.link.trim(),
          tapButtonTitle: FIRST_AUTOMATION.tapButtonTitle,
          linkButtonTitle: FIRST_AUTOMATION.linkButtonTitle,
          triggers: [{ channel: 'instagram', targetType: 'reel', mediaId: body.mediaId }],
          variants: [{ label: 'A', body: FIRST_AUTOMATION.body }],
        });
        // The same reel again (a second try from the page) changes that automation rather than making another.
        const [existing] = await db.query(
          `SELECT automation_id FROM automation_triggers WHERE tenant_id = $1 AND media_id = $2 AND active ORDER BY automation_id LIMIT 1`,
          [tenant.id, body.mediaId],
        );
        let automationId = existing ? Number(existing.automation_id) : null;
        try {
          const saved = automationId
            ? await handlers['automations.update']({ params: { id: automationId }, body: { name: input.name, keywords: input.keywords, linkUrl: input.linkUrl, linkMode: 'two_tap' }, user: actor })
            : await handlers['automations.create']({ body: input, user: actor });
          automationId = Number(saved.id);
        } catch (err) {
          if (!(err instanceof ApiError)) throw err;
          return { automationId, live: false, problems: [problemOf(err)] };
        }
        await store.step(run, 'automation_drafted');
        try {
          await handlers['automations.setState']({ params: { id: automationId }, body: { state: 'live' }, user: actor });
        } catch (err) {
          if (!(err instanceof ApiError)) throw err;
          return { automationId, live: false, problems: [problemOf(err)] };
        }
        await store.step(run, 'automation_live');
        return { automationId, live: true, problems: [] };
      });
    },

    async 'signup.finish'({ body, user }) {
      const { store } = services();
      const personId = requirePerson(user);
      const run = await startedRun(body.runToken, personId);
      const tenant = await tenantOf(run.tenantId);
      const { startedAt, finishedAt } = await store.finish(run);
      const elapsedMs = Math.max(0, new Date(finishedAt) - new Date(startedAt));
      const withinTarget = elapsedMs <= SIGNUP_TARGET_MS;
      log.info('signup.finished', { runId: run.id, tenantId: tenant.id, elapsedMs, withinTarget });
      return { tenantId: Number(tenant.id), host: businessHost(tenant.slug, ctx.config), elapsedMs, withinTarget };
    },
  };
}
