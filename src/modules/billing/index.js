import crypto from 'node:crypto';
import express from 'express';
import { BILLING_ROUTE_OWNERS } from '../../contracts/api/billing.js';
import { ApiError } from '../../contracts/api/index.js';
import { BILLING_PLATFORM_OWNERS } from '../../contracts/api/platform.js';
import { BILLING_QUEUE, BILLING_WEBHOOK } from '../../contracts/billing.js';
import { reportError } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { BILLING_FILE_PATH, fileLink, fileLinkValid, fileNameOf, invoicePdf, statementCsv, statementPdf } from './files.js';
import { registerBillingPlatformRoutes } from './platform.js';
import { createBillingReconcile } from './reconcile.js';
import { createBilling, providerFailure } from './service.js';
import { createStatements } from './statements.js';
import { createBillingWebhooks } from './webhooks.js';

/**
 * What a business pays Bhava (PRD 3, 5.12). Track billing.
 *
 * Owns migrations 700 (the price list: plan_prices, addons, offers, billing_settings) and 701 (subscriptions,
 * subscription_items, plan_changes, offer_claims, bhava_invoices and their lines, billing_payments, pass_through_charges,
 * settlement_statements). Vocabulary and arithmetic are in src/contracts/billing.js; routes in src/contracts/api/billing.js
 * and, for the Platform Console, platform.js.
 *
 *   service.js     the plan, add-ons, invoices and credit notes, what each provider event does, renewals and grace
 *   webhooks.js    BILLING_WEBHOOK: verified on the raw bytes (a bad signature is 400, nothing stored), stored, then worked
 *   reconcile.js   reads live subscriptions from the provider and puts what no webhook brought through the same path (M-3)
 *   statements.js  the monthly settlement statement on the default payment and shipping path
 *   files.js       Bhava-branded PDFs and the CSV, behind signed links that last minutes
 *   platform.js    the Platform Console's routes
 *   money.js       taxed lines, totals and credit lines, in whole paise
 *
 * Every billing route is OWNER_ONLY in the route table, and `fresh` where it changes money: the API router refuses anyone
 * else, a session without a recent re-auth, an impersonating operator and a service operator before a handler runs. No
 * route takes an amount, a price or a discount: the server prices everything from rows. No card data ever reaches Bhava:
 * a payment or a new card goes through the provider's hosted page.
 */
const API = BILLING_ROUTE_OWNERS.billing;
const PLATFORM = BILLING_PLATFORM_OWNERS.billing;
export const BILLING_JOBS = Object.freeze({ webhooks: BILLING_QUEUE, renewals: 'billing.renewals', grace: 'billing.grace', statements: 'billing.statements', reconcile: 'billing.reconcile' });
const MINUTE = 60_000;

const built = new WeakMap();
/** The one billing service of a process's context: the service, plus webhooks, statements and the file-link secret. */
export function billingFor(ctx) {
  let service = built.get(ctx);
  if (!service) {
    const core = createBilling(ctx);
    service = Object.assign(core, { statements: createStatements(ctx, { at: core.at }), secret: ctx.config?.sessionSecret || ctx.config?.dataKey || crypto.randomBytes(32).toString('hex') });
    service.webhooks = createBillingWebhooks(ctx, service);
    service.reconcile = createBillingReconcile(ctx, service, service.webhooks);
    built.set(ctx, service);
  }
  return service;
}

const wrap = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (err) {
    throw providerFailure(err);
  }
};

/** Makes the file once, keeps it in private storage, and remembers its key (the only column of an issued invoice that may be written). */
async function invoiceFile(ctx, service, row) {
  const storage = ctx.platform.storage;
  if (row.file_key) {
    const kept = await storage.get(row.file_key);
    if (kept) return kept;
  }
  const lines = await service.invoices.lines(row.id);
  const original = row.original_invoice_id ? await service.invoices.row(row.original_invoice_id) : null;
  const pdf = await invoicePdf({ doc: row, lines, original });
  const key = `t/${tenantId()}/billing/invoices/${crypto.randomUUID()}.pdf`;
  await storage.put(key, pdf, 'application/pdf');
  await ctx.db.query(`UPDATE bhava_invoices SET file_key = $3 WHERE tenant_id = $1 AND id = $2 AND file_key = ''`, [tenantId(), row.id, key]);
  return pdf;
}

async function statementFile(ctx, row, format) {
  const storage = ctx.platform.storage;
  const column = format === 'csv' ? 'csv_key' : 'pdf_key';
  if (row[column]) {
    const kept = await storage.get(row[column]);
    if (kept) return kept;
  }
  const [t] = await ctx.db.query('SELECT name, legal_name FROM tenants WHERE id = $1', [tenantId()]);
  const file = format === 'csv' ? statementCsv(row) : await statementPdf(row, t?.legal_name || t?.name || '');
  const key = `t/${tenantId()}/billing/statements/${crypto.randomUUID()}.${format}`;
  await storage.put(key, file, format === 'csv' ? 'text/csv' : 'application/pdf');
  await ctx.db.query(`UPDATE settlement_statements SET ${column} = $3 WHERE tenant_id = $1 AND id = $2 AND ${column} = ''`, [tenantId(), row.id, key]);
  return file;
}

const statementRow = async (ctx, id) => (await ctx.db.query('SELECT * FROM settlement_statements WHERE tenant_id = $1 AND id = $2', [tenantId(), id]))[0] ?? null;
const monthOf = (row) => new Date(row.month).toISOString().slice(0, 7);

export const billing = {
  name: 'billing',
  owns: {
    migrations: ['700_plans_and_prices.sql', '701_billing.sql'],
    tables: ['plan_prices', 'addons', 'offers', 'billing_settings', 'provider_plans', 'subscriptions', 'subscription_items', 'plan_changes', 'offer_claims', 'bhava_invoice_sequences', 'bhava_invoices', 'bhava_invoice_lines', 'billing_payments', 'pass_through_charges', 'settlement_statements'],
    api: API,
    store: [],
    platform: PLATFORM,
    jobs: ['billing.webhooks', 'billing.renewals', 'billing.grace', 'billing.statements', 'billing.reconcile'],
  },

  setup(ctx) {
    ctx.billing = billingFor(ctx);
  },

  beforeTenant(app, ctx) {
    app.post(BILLING_WEBHOOK.path, (req, res) => billingFor(ctx).webhooks.receive(req, res));
  },

  routes(app, ctx) {
    const r = express.Router();
    // The file behind a signed link from billing.invoiceFile or billing.statementFile: the owner's own session only.
    r.get(BILLING_FILE_PATH, async (req, res) => {
      try {
        res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
        if (!req.user) return res.status(401).type('text').send('Sign in, then open this link again.');
        if (req.user.role !== 'owner' || req.session?.operatorRef) return res.status(403).type('text').send('Only the owner can open billing documents.');
        const kind = req.params.kind;
        const id = /^\d{1,18}$/.test(req.params.id) ? req.params.id : null;
        const format = req.query.format === 'csv' ? 'csv' : 'pdf';
        if (!id || !['invoices', 'statements'].includes(kind) || (kind === 'invoices' && format !== 'pdf')) return res.status(404).type('text').send('We couldn’t find that document.');
        if (!fileLinkValid(billingFor(ctx).secret, { kind, id, format, exp: req.query.exp, sig: req.query.sig })) return res.status(403).type('text').send('This link has expired. Open Billing again.');
        if (kind === 'invoices') {
          const row = await billingFor(ctx).invoices.row(id);
          if (!row) return res.status(404).type('text').send('We couldn’t find that document.');
          res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${fileNameOf(row.number, 'pdf')}"` });
          return res.send(await invoiceFile(ctx, billingFor(ctx), row));
        }
        const row = await statementRow(ctx, id);
        if (!row) return res.status(404).type('text').send('We couldn’t find that document.');
        res.set({ 'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf', 'Content-Disposition': `attachment; filename="${fileNameOf(`statement-${monthOf(row)}`, format)}"` });
        return res.send(await statementFile(ctx, row, format));
      } catch (err) {
        reportError(err, { msg: 'billing.file_failed' });
        return res.status(500).type('text').send('Something went wrong. Please try again.');
      }
    });
    app.use(r);
  },

  api: (ctx) => ({
    'billing.plan': () => billingFor(ctx).plan(),
    'billing.catalog': () => billingFor(ctx).catalog(),
    'billing.change': wrap(({ body, user }) => billingFor(ctx).change(body, user)),
    'billing.addItem': wrap(({ body, user }) => billingFor(ctx).addItem(body, user)),
    'billing.removeItem': wrap(({ params, user }) => billingFor(ctx).removeItem(params.id, user)),
    'billing.invoices': ({ query }) => billingFor(ctx).invoices.list(query),
    'billing.invoiceFile': async ({ params }) => {
      const row = await billingFor(ctx).invoices.row(params.id);
      if (!row) return null;
      return { ...fileLink(billingFor(ctx).secret, { kind: 'invoices', id: row.id }), fileName: fileNameOf(row.number, 'pdf') };
    },
    'billing.statements': ({ query }) => billingFor(ctx).statements.list(query),
    'billing.statementFile': async ({ params, query }) => {
      const row = await statementRow(ctx, params.id);
      if (!row) return null;
      return { ...fileLink(billingFor(ctx).secret, { kind: 'statements', id: row.id, format: query.format }), fileName: fileNameOf(`statement-${monthOf(row)}`, query.format) };
    },
    /** The provider's own hosted page, where the owner pays what is due or changes the card: no card data reaches Bhava. */
    'billing.paymentMethod': wrap(async () => {
      const [s] = await ctx.db.query('SELECT provider_subscription_id, status FROM subscriptions WHERE tenant_id = $1', [tenantId()]);
      if (!s?.provider_subscription_id || s.status === 'cancelled') throw new ApiError('conflict', 'The Free plan needs no payment method. Pick a paid plan first.', { reason: 'needs_subscription' });
      const sub = await ctx.providers.razorpay.billing.fetch(s.provider_subscription_id);
      if (!sub?.hostedUrl) throw new ApiError('conflict', 'The payment page isn’t available right now. Please try again in a minute.', { reason: 'provider' });
      return { url: sub.hostedUrl, expiresAt: null };
    }),
  }),

  platformRoutes(router, ctx) {
    registerBillingPlatformRoutes(router, ctx, billingFor(ctx));
  },

  jobs(ctx) {
    const { queue } = ctx.platform;
    const service = billingFor(ctx);
    queue.work(BILLING_JOBS.webhooks, () => service.webhooks.drain());
    queue.work(BILLING_JOBS.renewals, () => service.renewals());
    queue.work(BILLING_JOBS.grace, () => service.graceSweep());
    queue.work(BILLING_JOBS.statements, () => service.statements.monthly());
    queue.work(BILLING_JOBS.reconcile, () => service.reconcile.run());
    return async function schedule() {
      await queue.every(BILLING_JOBS.webhooks, MINUTE);
      await queue.every(BILLING_JOBS.renewals, 15 * MINUTE);
      await queue.every(BILLING_JOBS.grace, 15 * MINUTE);
      await queue.every(BILLING_JOBS.statements, 60 * MINUTE);
      await queue.every(BILLING_JOBS.reconcile, 30 * MINUTE);
    };
  },
};
