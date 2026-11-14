import crypto from 'node:crypto';
import { REFERRAL_CODE } from '../../contracts/billing.js';
import { tenantId } from '../../tenancy.js';

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0, o, 1, l or i: a code is read aloud and typed by hand
const LENGTH = 8;
const newCode = () => Array.from(crypto.randomBytes(LENGTH), (byte) => ALPHABET[byte % ALPHABET.length]).join('');

/**
 * Each business's own referral code (PRD 5.20, seller_referral_codes in migration 701). One row per business, made the first
 * time it is read and never changed, so a link that was shared keeps working. Every query names tenant_id.
 *
 *   await repos.referralCodes.code()   'k7m2p9xw'
 *
 * The link is referralLink(platformSiteUrlOf(config), code) from the billing contract. The referral rows themselves, the
 * credit and the self-referral blocks are the referrals track's.
 */
export function referralCodesRepo(db) {
  const t0 = () => tenantId();
  const read = async () => (await db.query('SELECT code FROM seller_referral_codes WHERE tenant_id = $1', [t0()]))[0]?.code ?? null;

  return {
    /** This business's code, made now if it has none. */
    async code() {
      const tenant = t0();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const have = await read();
        if (have && REFERRAL_CODE.test(have)) return have;
        // Two readers at once, or a code another business drew first: nothing is written and the next turn reads or redraws.
        await db.query('INSERT INTO seller_referral_codes (tenant_id, code) VALUES ($1, $2) ON CONFLICT DO NOTHING', [tenant, newCode()]);
      }
      const code = await read();
      if (!code) throw new Error('no referral code could be made');
      return code;
    },
  };
}
