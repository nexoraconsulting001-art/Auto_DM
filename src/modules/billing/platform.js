import { requirePlatformRole } from '../../auth.js';
import { platformRoutes as ROUTES } from '../../contracts/api/platform.js';
import { withTenant } from '../../tenancy.js';

const badRequest = (res, issues) => res.status(400).json({ error: issues[0]?.message ?? 'Check the details and try again.' });

const toSettings = (s) => ({
  legalName: s.legal_name, gstin: s.gstin, stateCode: s.state_code, address: s.address, sac: s.sac, taxRateBp: Number(s.tax_rate_bp), statementDay: Number(s.statement_day),
  graceDays: Number(s.grace_days), afterGrace: s.after_grace, proration: s.proration, yearlyMonths: Number(s.yearly_months), freeCanBuyPacks: Boolean(s.free_can_buy_packs),
  referralRewardPaise: Number(s.referral_reward_paise),
});

/** billing_settings columns the console may set, by the field that names each. Nothing else reaches the SQL. */
const SETTABLE = Object.freeze({
  legalName: 'legal_name', gstin: 'gstin', stateCode: 'state_code', address: 'address', sac: 'sac', taxRateBp: 'tax_rate_bp', statementDay: 'statement_day', graceDays: 'grace_days',
  afterGrace: 'after_grace', proration: 'proration', freeCanBuyPacks: 'free_can_buy_packs', referralRewardPaise: 'referral_reward_paise',
});

/**
 * The Platform Console's billing routes (PRD 5.7, 5.12), on the console host behind requirePlatformRole: a business's plan
 * with every change, a plan override without payment, credit notes, a billing hold and its release, and Bhava's own invoice
 * details. Every change is in the audit log with who did it and why, and the owner is told.
 */
export function registerBillingPlatformRoutes(router, ctx, billing) {
  const { db } = ctx;
  const platformDb = db.platform ?? db;

  const route = (id, handler) => {
    const definition = ROUTES[id];
    router[definition.method.toLowerCase()](definition.path, requirePlatformRole(...definition.platformRoles), async (req, res, next) => {
      try {
        const params = definition.params?.safeParse(req.params);
        if (params && !params.success) return res.status(404).json({ error: 'Not found.' });
        const body = definition.body?.safeParse(req.body ?? {});
        if (body && !body.success) return badRequest(res, body.error.issues);
        const actor = `platform:${req.platformUser.id}`;
        const result = await handler({ params: params?.data, body: body?.data, actor, res });
        if (res.headersSent) return undefined;
        return res.status(definition.status ?? 200).json(definition.response.parse(result));
      } catch (err) {
        if (err?.name === 'ApiError' && err.status && err.status < 500) return res.status(err.status).json({ error: err.message, code: err.code });
        return next(err);
      }
    });
  };

  /** Runs fn inside the business named in the address, or answers 404. */
  const inBusiness = async (id, res, fn) => {
    const [t] = await platformDb.query('SELECT id FROM tenants WHERE id = $1', [id]);
    if (!t) {
      res.status(404).json({ error: 'Not found.' });
      return undefined;
    }
    return withTenant(Number(t.id), fn);
  };

  route('platform.billing', ({ params, res }) => inBusiness(params.id, res, () => billing.platform.view()));
  route('platform.overridePlan', ({ params, body, actor, res }) => inBusiness(params.id, res, () => billing.platform.overridePlan(body, actor)));
  route('platform.createCreditNote', ({ params, body, actor, res }) => inBusiness(params.id, res, () => billing.platform.creditNote(body, actor)));
  route('platform.suspendBilling', ({ params, body, actor, res }) => inBusiness(params.id, res, () => billing.platform.suspend(body, actor)));
  route('platform.resumeBilling', ({ params, body, actor, res }) => inBusiness(params.id, res, () => billing.platform.resume(body, actor)));
  route('platform.billingSettings', async () => toSettings(await billing.settingsOf(platformDb)));
  route('platform.saveBillingSettings', async ({ body, actor }) => {
    const sets = [];
    const values = [];
    for (const [field, column] of Object.entries(SETTABLE)) {
      if (body[field] === undefined) continue;
      values.push(body[field]);
      sets.push(`${column} = $${values.length}`);
    }
    await platformDb.tx(async (p) => {
      const [before] = await p.query('SELECT * FROM billing_settings LIMIT 1 FOR UPDATE');
      if (sets.length) await p.query(`UPDATE billing_settings SET ${sets.join(', ')}, updated_at = now()`, values);
      const changed = Object.keys(SETTABLE).filter((f) => body[f] !== undefined && String(body[f]) !== String(toSettings(before)[f]));
      await p.query('INSERT INTO audit_log (tenant_id, actor, action, target, details) VALUES (NULL, $1, $2, $3, $4::jsonb)', [actor, 'billing.settings_saved', 'billing_settings', JSON.stringify({ changed, reason: body.reason })]);
    });
    return toSettings(await billing.settingsOf(platformDb));
  });
}
