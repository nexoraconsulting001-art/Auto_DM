import { ProviderError } from '../../adapters/http.js';
import { ApiError } from '../../contracts/api/index.js';
import { INDIAN_STATES } from '../../contracts/orders.js';
import { STEP_CHECKS, checkoutOpenFor, onboardingDone, stepsFor } from '../../contracts/onboarding.js';
import { MASKED } from '../../contracts/services.js';
import { log, reportError } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { writeAudit } from '../audit/index.js';
import { maskKeyId } from '../gateway-keys/index.js';
import { paymentsFor } from '../payments/index.js';
import { shippingFor } from '../shipping/index.js';
import { createChecks, testOwnKeys } from './checks.js';

/**
 * The done-for-you checklist of one business (PRD 5.6). Which steps it has, and which are required, is its plan's
 * (stepsFor); each step's state is what its live checks last found, kept in onboarding_steps. Nothing here ticks a step:
 * the owner does their part (terms, pickup address, KYC, keys) and the step's checks decide.
 *
 *   view()             the checklist as last checked
 *   get()              runs the checks of every step that is not done, or was done more than RECHECK_MS ago, then view()
 *   run(names?)        runs the checks of these steps (all by default) now
 */
const RECHECK_MS = 10 * 60_000;

/** A state's code from its name, as the shipping settings keep it ('27' for Maharashtra). Null for a name that is not a state. */
export function stateCodeOf(name) {
  const wanted = String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/&/g, 'and');
  for (const [code, label] of Object.entries(INDIAN_STATES)) {
    if (label.toLowerCase() === wanted) return String(code).padStart(2, '0');
  }
  return null;
}

/** Runs `promise` for at most `ms`: past that, the check is `waiting`. */
async function withinTimeout(promise, ms) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: 'waiting', code: 'check.timeout', reason: 'This check did not finish in time. We will try again shortly.', fix: '' }), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The step's outcome from its checks, in order: the first that is not done decides; a done step keeps a warning. */
function combine(results) {
  const notDone = results.find((r) => r.status !== 'done');
  const chosen = notDone ?? results.find((r) => r.code) ?? results[0] ?? { status: 'pending' };
  const kyc = results.find((r) => r.kyc !== undefined)?.kyc;
  return { status: chosen.status, code: chosen.code ?? '', reason: String(chosen.reason ?? '').slice(0, 300), fix: chosen.fix ?? '', ...(kyc !== undefined ? { kyc } : {}) };
}

export function createChecklist(ctx) {
  const { db } = ctx;
  const checks = createChecks(ctx);

  async function planOf() {
    const [row] = await db.query('SELECT plan FROM tenants WHERE id = $1', [tenantId()]);
    return row?.plan ?? 'free';
  }

  async function rows() {
    const found = await db.query('SELECT step, required, status, checked_at, detail FROM onboarding_steps WHERE tenant_id = $1', [tenantId()]);
    return new Map(found.map((r) => [r.step, r]));
  }

  async function runCheck(name) {
    try {
      return await withinTimeout(checks[name](), STEP_CHECKS[name]?.timeoutMs ?? 10_000);
    } catch (err) {
      reportError(err, { msg: 'onboarding.check_failed', check: name });
      return { status: 'waiting', code: 'check.error', reason: 'This check could not run. We will try again shortly.', fix: '' };
    }
  }

  async function save(step, required, outcome) {
    const detail = { code: outcome.code, reason: outcome.reason, fix: outcome.fix, ...(outcome.kyc !== undefined ? { kyc: outcome.kyc } : {}) };
    await db.query(
      `INSERT INTO onboarding_steps AS s (tenant_id, step, required, status, checked_at, detail, updated_at) VALUES ($1, $2, $3, $4, now(), $5, now())
       ON CONFLICT (tenant_id, step) DO UPDATE SET required = EXCLUDED.required, status = EXCLUDED.status, checked_at = now(),
         detail = s.detail || EXCLUDED.detail, updated_at = now()`,
      [tenantId(), step, required, outcome.status, JSON.stringify(detail)],
    );
  }

  /** Runs the checks of these steps of the plan, in parallel; each step's checks in order, stopping at the first not done. */
  async function run(names = null, plan = null) {
    const visible = stepsFor(plan ?? (await planOf())).filter((s) => !names || names.includes(s.step));
    await Promise.all(visible.map(async (s) => {
      const results = [];
      for (const check of s.checks) {
        const result = await runCheck(check);
        results.push(result);
        if (result.status !== 'done') break;
      }
      await save(s.step, s.required, combine(results));
    }));
  }

  async function checkoutOpen(kyc) {
    const settings = paymentsFor(ctx).settings;
    const mode = await settings.effectiveMode();
    if (mode === 'own') return settings.ready('own');
    if (kyc && !checkoutOpenFor(kyc.status)) return false;
    return settings.ready('managed');
  }

  async function view(plan = null) {
    const p = plan ?? (await planOf());
    const stored = await rows();
    const steps = stepsFor(p).map((s) => {
      const r = stored.get(s.step);
      const d = r?.detail ?? {};
      return { step: s.step, label: s.label, required: s.required, status: r?.status ?? 'pending', checkedAt: r?.checked_at ?? null, code: d.code ?? '', reason: d.reason ?? '', fix: d.fix ?? '' };
    });
    const kycDetail = stored.get('payments')?.detail?.kyc ?? null;
    const kyc = kycDetail?.status ? { status: kycDetail.status, reason: kycDetail.reason ?? '' } : null;
    const statuses = Object.fromEntries(steps.map((s) => [s.step, s.status]));
    return { plan: p, done: onboardingDone(p, statuses), checkoutOpen: await checkoutOpen(kyc), kyc, steps };
  }

  async function get() {
    const plan = await planOf();
    const stored = await rows();
    const stale = stepsFor(plan).filter((s) => {
      const r = stored.get(s.step);
      return !r || r.status !== 'done' || !r.checked_at || Date.now() - new Date(r.checked_at).getTime() > RECHECK_MS;
    }).map((s) => s.step);
    if (stale.length) await run(stale, plan);
    return view(plan);
  }

  async function ownerOf() {
    const [owner] = await db.query(`SELECT id, name, phone, email FROM users WHERE tenant_id = $1 AND role = 'owner' AND removed_at IS NULL ORDER BY id LIMIT 1`, [tenantId()]);
    return owner ?? null;
  }

  return {
    view,
    get,
    run,

    async check(step) {
      await run(step ? [step] : null);
      return view();
    },

    async acceptTerms(version, user) {
      const accepted = { version, at: new Date().toISOString(), by: Number(user.id) };
      await db.tx(async (t) => {
        await t.query(
          `INSERT INTO onboarding_steps AS s (tenant_id, step, required, status, detail) VALUES ($1, 'terms', true, 'pending', $2)
           ON CONFLICT (tenant_id, step) DO UPDATE SET detail = s.detail || EXCLUDED.detail, updated_at = now()`,
          [tenantId(), JSON.stringify({ accepted })],
        );
        await writeAudit(t, { actor: `user:${user.id}`, action: 'onboarding.terms_accepted', target: 'terms', details: { version } });
      });
      await run(['terms']);
      return view();
    },

    async pickupAddress(body, user) {
      const stateCode = stateCodeOf(body.state);
      if (!stateCode) throw new ApiError('validation_failed', 'Pick a state', { fields: { state: 'Pick a state' } });
      if (!/^[1-9]\d{5}$/.test(body.pincode)) throw new ApiError('validation_failed', 'Enter a 6-digit pincode', { fields: { pincode: 'Enter a 6-digit pincode' } });
      // On Bhava's master courier account (managed mode), as this business's own pickup location. Saving the same address
      // again registers nothing new.
      await shippingFor(ctx).settings.update({
        pickupName: body.name, pickupPhone: body.phone, pickupLine1: body.line1, pickupLine2: body.line2 ?? '', pickupCity: body.city, pickupStateCode: stateCode, pickupPincode: body.pincode,
      }, `user:${user.id}`);
      await run(['shipping']);
      return view();
    },

    async kycLink(user) {
      const settings = paymentsFor(ctx).settings;
      let [row] = await db.query('SELECT linked_account_id FROM payment_settings WHERE tenant_id = $1', [tenantId()]);
      if (!row?.linked_account_id) {
        const owner = await ownerOf();
        const [tenant] = await db.query('SELECT name FROM tenants WHERE id = $1', [tenantId()]);
        // Razorpay asks for an email to create the account; the owner's own, or this business's address on Bhava's
        // neutral mail domain when the owner gave none. Everything else is collected on Razorpay's own KYC page.
        const neutral = ctx.config?.emailNeutralDomain ? `kyc-b${tenantId()}@${ctx.config.emailNeutralDomain}` : '';
        const email = owner?.email || neutral;
        if (!email) throw new ApiError('validation_failed', 'Add your email address to your account first.', { fields: { email: 'Add your email address' } });
        await settings.startLinked({ email, phone: owner?.phone ?? '', legalName: tenant?.name ?? 'Business', businessType: 'individual', contactName: owner?.name || tenant?.name || 'Owner' }, `user:${user.id}`);
        [row] = await db.query('SELECT linked_account_id FROM payment_settings WHERE tenant_id = $1', [tenantId()]);
      }
      if (!row?.linked_account_id) throw new ApiError('conflict', 'The payment account could not be set up. Try again in a minute.');
      let url = '';
      try {
        ({ url } = await ctx.providers.razorpay.route.kycLink(row.linked_account_id));
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        log.warn('onboarding.kyc_link_failed', { tenantId: tenantId(), kind: err.kind, status: err.status });
        throw new ApiError('conflict', 'Razorpay didn’t answer. Try again in a minute.');
      }
      if (!/^https:\/\/[^\s]+$/i.test(url)) throw new ApiError('conflict', 'Razorpay didn’t give a page to finish KYC on. Try again in a minute.');
      await run(['payments']);
      const kyc = (await view()).kyc;
      return { url, status: kyc?.status ?? 'created', reason: kyc?.reason ?? '' };
    },

    /** The test call first; keys that fail it are never stored, and the default path stays as it was (F-79). */
    async ownKeys(body, user) {
      const actor = `user:${user.id}`;
      if (body.provider === 'cashfree') throw new ApiError('conflict', 'Cashfree keys can’t be checked yet, so they can’t be added. Please contact support.');
      const result = await testOwnKeys(ctx, body.provider, { keyId: body.keyId, keySecret: body.keySecret });
      if (result === 'invalid') {
        await writeAudit(db, { actor, action: 'onboarding.own_keys_refused', target: body.provider, details: { provider: body.provider } });
        throw new ApiError('validation_failed', 'These keys didn’t work. Nothing was saved, and Bhava’s accounts stay in use.', { fields: { keySecret: 'The provider refused these keys' } });
      }
      if (result !== 'ok') throw new ApiError('conflict', 'The provider didn’t answer, so the keys couldn’t be checked. Nothing was saved. Try again in a minute.');
      if (body.provider === 'razorpay') {
        await ctx.repos.gatewayKeys.save('razorpay', { keyId: body.keyId, keySecret: body.keySecret }, actor);
      } else {
        await shippingFor(ctx).settings.update({ ownEmail: body.keyId, ownPassword: body.keySecret }, actor);
      }
      log.info('onboarding.own_keys_saved', { tenantId: tenantId(), provider: body.provider });
      await run(['own_keys']);
      const keyId = body.provider === 'razorpay' ? maskKeyId(body.keyId) : String(body.keyId).replace(/^(.).*(@.*)$/, '$1…$2');
      return { provider: body.provider, keyId, masked: MASKED, checklist: await view() };
    },
  };
}
