import { BILLING_ROUTE_OWNERS } from '../../contracts/api/billing.js';
import { BILLING_PLATFORM_OWNERS } from '../../contracts/api/platform.js';
import { notBuilt, platformNotBuilt } from '../not-built.js';

/**
 * What a business pays Bhava (PRD 3, 5.12). Track billing. Contract only so far: every route answers 501.
 *
 * Owns migrations 700 (the price list: plan_prices, addons, offers, billing_settings) and 701 (subscriptions,
 * subscription_items, plan_changes, offer_claims, bhava_invoices and their lines, billing_payments, pass_through_charges,
 * settlement_statements). Vocabulary and arithmetic are in src/contracts/billing.js; routes in src/contracts/api/billing.js
 * and, for the Platform Console, platform.js.
 *
 * What the track builds here:
 *
 * - The plan and the catalog from rows, never from code: plan_prices, addons (with min_plan and included_from deciding what a
 *   business may buy), the launch offer through claim_offer('launch') when a business first pays (the database counts the
 *   places), and billing_settings for every rule still open in the PRD.
 * - A change of plan: one plan_changes row through db.platform (the trigger moves tenants.plan, so entitlements see it on the
 *   next request), the provider subscription created or changed (ctx.providers.razorpay.billing), and the hosted page when a
 *   payment is needed. An upgrade is now; a downgrade and a cycle change wait for the period's end (next_plan, next_cycle).
 * - The webhook: BILLING_WEBHOOK in beforeTenant, on the raw bytes. A bad signature is 400 and nothing is stored (F-52).
 *   A good one is inserted into provider_webhook_events (provider 'razorpay', scope 'billing', the provider's event id) before
 *   the 2xx, then worked from BILLING_QUEUE: each event id once, each payment id one billing_payments row and one invoice
 *   (F-51), an older event than the state it would set ignored as 'stale'.
 * - Invoices: bhava_invoices and all its lines in one transaction (the database numbers it and checks the sum at commit);
 *   taxFor() for CGST and SGST or IGST by the business's state against Bhava's (F-54); a credit note for any correction.
 * - A failed charge: past_due, then grace until grace_until with reminders through ctx.notify, then suspended as an
 *   owner-locked pause with all data kept (F-53), or what billing_settings.after_grace says.
 * - Pass-through charges at cost from Phase 4's settlement_lines and from usage_months.cost_paise, and the monthly settlement
 *   statement per business on the default path, reconciled against ctx.providers.razorpay.route.settlementReport (F-83).
 * - Notification kinds (billing.*) in src/contracts/notifications.js, removing 'billing.' from RESERVED_PREFIXES.
 *
 * An operator who is impersonating never reaches these routes (5.10), and no route takes an amount or card data.
 */
const API = BILLING_ROUTE_OWNERS.billing;
const PLATFORM = BILLING_PLATFORM_OWNERS.billing;

export const billing = {
  name: 'billing',
  owns: {
    migrations: ['700_plans_and_prices.sql', '701_billing.sql'],
    tables: ['plan_prices', 'addons', 'offers', 'billing_settings', 'provider_plans', 'subscriptions', 'subscription_items', 'plan_changes', 'offer_claims', 'bhava_invoice_sequences', 'bhava_invoices', 'bhava_invoice_lines', 'billing_payments', 'pass_through_charges', 'settlement_statements'],
    api: API,
    store: [],
    platform: PLATFORM,
    jobs: ['billing.webhooks', 'billing.renewals', 'billing.grace', 'billing.statements'],
  },
  api: () => notBuilt(...API),
  platformRoutes(router) {
    platformNotBuilt(router, ...PLATFORM);
  },
};
