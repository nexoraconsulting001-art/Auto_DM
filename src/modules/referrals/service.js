import crypto from 'node:crypto';
import { ApiError } from '../../contracts/api/index.js';
import { REFERRAL_CODE, REFERRAL_PARAM } from '../../contracts/billing.js';
import { platformAppHostOf, platformSiteUrlOf } from '../../config.js';
import { localPhone } from '../../contracts/accounts.js';
import { SELLER_ROLES } from '../../contracts/api/access.js';
import { log } from '../../platform/log.js';
import { platformHostOf } from '../platform-console/host.js';

const platformOf = (db) => db.platform ?? db;

/** A code as typed or carried by a link: lower case, nothing else. '' when it can't be a code. */
export const normalizeReferralCode = (code) => {
  const value = String(code ?? '').trim().toLowerCase();
  return REFERRAL_CODE.test(value) ? value : '';
};

/**
 * Writes the referral when a referred account signs up (PRD 5.20), inside the sign-up's own transaction `t` (on the
 * platform path). tenant_id is the referrer; referred_tenant_id is unique, so an account is referred once and a second
 * code changes nothing. A code of the business itself is ignored. The same person, or a verified phone of theirs on one
 * of the referrer's seller accounts, makes it a blocked row (same_phone): it is kept for the console and never credited.
 * The same Instagram account and the same payment method are blocked by the database when they appear (migration 741).
 * Returns { referrerId, state } or null when there is no referral.
 */
export async function recordReferral(t, { code, referredTenantId, personId }) {
  const clean = normalizeReferralCode(code);
  if (!clean) return null;
  const [owner] = await t.query('SELECT tenant_id FROM seller_referral_codes WHERE code = $1', [clean]);
  if (!owner || Number(owner.tenant_id) === Number(referredTenantId)) return null;
  const referrerId = Number(owner.tenant_id);
  const phones = (await t.query(`SELECT subject FROM person_identities WHERE person_id = $1 AND kind = 'phone'`, [personId])).map((r) => r.subject);
  const numbers = phones.flatMap((p) => [p, localPhone(p)]).filter(Boolean);
  const [same] = await t.query(
    `SELECT 1 FROM users WHERE tenant_id = $1 AND role = ANY($2) AND (person_id = $3 OR phone = ANY($4::text[])) LIMIT 1`,
    [referrerId, SELLER_ROLES, personId, numbers],
  );
  const state = same ? 'blocked' : 'pending';
  const [row] = await t.query(
    `INSERT INTO seller_referrals (tenant_id, referred_tenant_id, state, block_reason) VALUES ($1, $2, $3, $4)
     ON CONFLICT (referred_tenant_id) DO NOTHING RETURNING id`,
    [referrerId, referredTenantId, state, same ? 'same_phone' : ''],
  );
  if (!row) return null;
  log.info('referrals.recorded', { referrerId, referredTenantId: Number(referredTenantId), state });
  return { referrerId, state };
}

/**
 * Records a payment method a business has paid with, for the self-referral block (REFERRAL_BLOCKS same_payment_method).
 * `fingerprint` is whatever stable id the billing provider gives the method (a card fingerprint, a UPI handle's token);
 * only its keyed hash is stored. The database then blocks any pending referral between two businesses that share one
 * (migration 741). Call it before the paid plan's plan_changes row, so a shared method is caught before the credit.
 */
export async function notePaymentMethod(db, { tenantId, fingerprint, key }) {
  const value = String(fingerprint ?? '').trim();
  if (!value) return false;
  const hash = crypto.createHmac('sha256', String(key || 'bhava-payment-marks')).update(value).digest('hex');
  await platformOf(db).query('INSERT INTO seller_payment_marks (tenant_id, mark_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING', [Number(tenantId), hash]);
  return true;
}

const URLS = /\bhttps?:\/\/[^\s<>"'()]+/gi;

/** Bhava's own addresses: the sign-up page's host, the sign-in host and the Platform Console's. A seller's own store address is not one. */
export function platformHosts(config = {}) {
  const hosts = new Set();
  for (const value of [platformAppHostOf(config), platformHostOf(config)]) if (value) hosts.add(String(value).toLowerCase());
  const site = platformSiteUrlOf(config);
  if (site) hosts.add(new URL(site).hostname.toLowerCase());
  return hosts;
}

/**
 * Whether any of `texts` carries a link to Bhava's own pages or a seller referral link (PRD 4.10, 5.20: no DM on any
 * plan carries the platform's link or a referral link). `knownCode(code)` says whether a `ref` value is a real code.
 * Returns the first offending text's index, or -1.
 */
export async function platformLinkIn(texts, { config, knownCode }) {
  const hosts = platformHosts(config);
  for (const [index, text] of texts.entries()) {
    for (const raw of String(text ?? '').match(URLS) ?? []) {
      let url;
      try {
        url = new URL(raw);
      } catch {
        continue;
      }
      if (hosts.has(url.hostname.toLowerCase())) return index;
      const ref = normalizeReferralCode(url.searchParams.get(REFERRAL_PARAM));
      if (ref && (await knownCode(ref))) return index;
    }
  }
  return -1;
}

/**
 * Called by automations.setState before an automation goes to Test or Live: its link and every message it sends are
 * checked for a link to Bhava or a referral link, which no DM may carry on any plan.
 */
export async function referralLinkHook(automation, ctx) {
  const fields = [
    ['linkUrl', automation.linkUrl],
    ['linkMessage', automation.linkMessage],
    ['followupText', automation.followupText],
    ...(automation.variants ?? []).flatMap((v, i) => [[`variants.${i}.body`, v.body], [`variants.${i}.fallbackText`, v.fallbackText]]),
  ];
  const db = platformOf(ctx.db);
  const knownCode = async (code) => (await db.query('SELECT 1 FROM seller_referral_codes WHERE code = $1', [code])).length > 0;
  const index = await platformLinkIn(fields.map(([, text]) => text), { config: ctx.config ?? {}, knownCode });
  if (index < 0) return;
  const message = 'Messages can’t carry a link to the platform or a referral link.';
  throw new ApiError('validation_failed', message, { fields: { [fields[index][0]]: message }, reason: 'content.bhava_promo' });
}
