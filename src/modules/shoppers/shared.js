import { log } from '../../platform/log.js';
import { keyedHash, newToken, readToken, signToken } from './keys.js';

/**
 * The shared shopper profile (PRD 9.22, 9.18): one person across stores, held by the platform, never by a business.
 *
 * Its tables (migration 415) have no tenant_id and no grant to the app role, so everything here goes through db.platform,
 * and this file is the only code that reads them. What a business's code gets back is only what its own shopper needs:
 * whether THIS shopper has a profile, this shopper's own saved addresses, and a risk label. Nothing here returns a store's
 * name, an order, a product, a count, or which other businesses a person is linked to, and no function takes a phone number
 * and says whether a profile exists for it: a link is made only after the person has proved the number or the Google
 * account at the business that asks (S-99, S-103).
 *
 * The profile exists only by the shopper's explicit yes on the one consent screen that names the platform. Taking that
 * back deletes the row, and with it the addresses, the links and the signals (S-102).
 */
const NOTICE_PLATFORM = 'Bhava';
export const SHARED_COOKIE = '_shp';
const REMEMBER_DAYS = 180;
const RISK_MONTHS = 6;

export const defaultSharedNotice = (contact) => ({
  en: `${NOTICE_PLATFORM} runs the technology behind this store and many others. If you agree, ${NOTICE_PLATFORM} will keep a shared profile for you. It holds your verified phone number or Google account, your saved delivery addresses, and a cash-on-delivery risk level worked out from parcels refused at the door. It is used only so that you can check out at other ${NOTICE_PLATFORM} stores without signing up again, and so that a store can decide whether to offer cash on delivery. No store sees what you bought at another store, or where you shop. ${NOTICE_PLATFORM} is the data fiduciary for this shared profile under India's Digital Personal Data Protection Act, 2023. You can withdraw at any time from any store's account page: that deletes the shared profile, and each store keeps only its own order and tax records. Grievance contact: ${contact}.`,
  hi: `${NOTICE_PLATFORM} इस स्टोर और कई अन्य स्टोर की तकनीक चलाता है। आपकी सहमति से ${NOTICE_PLATFORM} आपके लिए एक साझा प्रोफ़ाइल रखेगा। इसमें आपका सत्यापित फ़ोन नंबर या Google खाता, आपके सहेजे हुए डिलीवरी पते, और दरवाज़े पर लौटाए गए पार्सलों से निकाला गया कैश-ऑन-डिलीवरी जोखिम स्तर रहता है। इसका उपयोग केवल इसलिए होता है कि आप दूसरे ${NOTICE_PLATFORM} स्टोर पर दोबारा साइन अप किए बिना ख़रीद सकें, और स्टोर तय कर सके कि कैश ऑन डिलीवरी दी जाए या नहीं। कोई स्टोर यह नहीं देखता कि आपने किसी दूसरे स्टोर से क्या ख़रीदा या आप कहाँ ख़रीदारी करते हैं। भारत के डिजिटल व्यक्तिगत डेटा संरक्षण अधिनियम, 2023 के अंतर्गत इस साझा प्रोफ़ाइल के लिए ${NOTICE_PLATFORM} डेटा फ़िड्यूशरी है। आप किसी भी स्टोर के खाता पेज से कभी भी सहमति वापस ले सकते हैं: इससे साझा प्रोफ़ाइल हट जाती है, और हर स्टोर केवल अपने ऑर्डर और टैक्स रिकॉर्ड रखता है। शिकायत संपर्क: ${contact}।`,
});

/** The label from refused cash-on-delivery parcels in the last six months. How it is scored is still to be confirmed (9.22). */
export const riskLabel = (refused) => (refused >= 3 ? 'high' : refused >= 2 ? 'elevated' : 'none');

export function createSharedProfiles({ db, config, platform }) {
  const pdb = db.platform ?? db;
  const phoneHash = (phone) => keyedHash(config, 'shared:phone', phone);
  const googleHash = (sub) => keyedHash(config, 'shared:google', sub);
  const grievanceContact = () => config.platformGrievanceEmail || (config.platformDomain ? `privacy@${config.platformDomain}` : 'the address on the platform’s website');
  const enc = (value) => platform.secrets.encrypt(JSON.stringify(value));
  const dec = (stored) => {
    try {
      return JSON.parse(platform.secrets.decrypt(stored));
    } catch {
      return null;
    }
  };
  const seal = (profileId) => platform.secrets.encrypt(String(Number(profileId)));
  /** A token's payload with its sealed profile id opened as `p`, or null when it can't be. */
  const opened = (payload) => {
    if (!payload || typeof payload.q !== 'string') return null;
    try {
      const p = Number(platform.secrets.decrypt(payload.q));
      return Number.isSafeInteger(p) && p > 0 ? { ...payload, p } : null;
    } catch {
      return null;
    }
  };

  async function notice(runner = pdb) {
    const latest = async () => (await runner.query('SELECT version, body_en, body_hi FROM shared_consent_notices ORDER BY version DESC LIMIT 1'))[0];
    let row = await latest();
    if (!row) {
      const text = defaultSharedNotice(grievanceContact());
      await runner.query('INSERT INTO shared_consent_notices (version, body_en, body_hi) VALUES (1, $1, $2) ON CONFLICT DO NOTHING', [text.en, text.hi]);
      row = await latest();
    }
    return { version: row.version, bodyEn: row.body_en, bodyHi: row.body_hi, platformName: NOTICE_PLATFORM, grievanceContact: grievanceContact() };
  }

  /** The profile this business's shopper is linked to, or null. */
  async function profileOf(tenantId, shopperId, runner = pdb) {
    const [row] = await runner.query(
      `SELECT p.id, p.cod_risk, p.consented_at, p.notice_version FROM shared_profile_links l JOIN shared_profiles p ON p.id = l.profile_id WHERE l.tenant_id = $1 AND l.shopper_id = $2`,
      [tenantId, shopperId],
    );
    return row ?? null;
  }

  async function refreshRisk(runner, profileId) {
    const [{ refused }] = await runner.query(
      `SELECT COALESCE(sum(refused), 0)::int AS refused FROM shared_cod_signals WHERE profile_id = $1 AND month > (date_trunc('month', now()) - make_interval(months => $2))::date`,
      [profileId, RISK_MONTHS],
    );
    await runner.query('UPDATE shared_profiles SET cod_risk = $2, updated_at = now() WHERE id = $1', [profileId, riskLabel(refused)]);
  }

  return {
    /** False when the platform cannot encrypt (no DATA_KEY): the profile is then not offered at all. */
    get available() {
      return Boolean(platform.secrets?.configured);
    },
    notice,

    /** For the shopper's own consent screen and account page: do they have one, and since when. */
    async status(tenantId, shopperId) {
      const profile = await profileOf(tenantId, shopperId);
      return profile ? { on: true, since: profile.consented_at, noticeVersion: profile.notice_version } : { on: false, since: null, noticeVersion: null };
    },

    /**
     * The shopper said yes on the consent screen. `shopper` is this business's row ({ id, phone, googleSub }), already
     * verified here; `addresses` are the ones saved here, which the shopper is choosing to carry.
     */
    async consent({ tenantId, shopper, googleSub = null, addresses = [], noticeVersion }) {
      const current = await notice();
      if (noticeVersion !== current.version) throw Object.assign(new Error('The notice changed. Please read it again.'), { code: 'notice_changed' });
      const pHash = shopper.phone ? phoneHash(shopper.phone) : null;
      const gHash = googleSub ? googleHash(googleSub) : null;
      if (!pHash && !gHash) throw new Error('A shared profile needs a verified phone or Google account');
      return pdb.tx(async (t) => {
        let [profile] = await t.query('SELECT id, phone_hash, google_hash FROM shared_profiles WHERE ($1::text IS NOT NULL AND phone_hash = $1) OR ($2::text IS NOT NULL AND google_hash = $2) ORDER BY id LIMIT 1 FOR UPDATE', [pHash, gHash]);
        if (!profile) {
          [profile] = await t.query(
            `INSERT INTO shared_profiles (phone_hash, phone_enc, google_hash, notice_version) VALUES ($1, $2, $3, $4) RETURNING id, phone_hash, google_hash`,
            [pHash, pHash ? enc({ phone: shopper.phone }) : '', gHash, current.version],
          );
        } else {
          // The same person proving a second way to sign in adds it, unless another profile already holds it.
          if (pHash && !profile.phone_hash) await t.query(`UPDATE shared_profiles SET phone_hash = $2, phone_enc = $3, updated_at = now() WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM shared_profiles WHERE phone_hash = $2)`, [profile.id, pHash, enc({ phone: shopper.phone })]);
          if (gHash && !profile.google_hash) await t.query(`UPDATE shared_profiles SET google_hash = $2, updated_at = now() WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM shared_profiles WHERE google_hash = $2)`, [profile.id, gHash]);
          await t.query('UPDATE shared_profiles SET notice_version = $2, updated_at = now() WHERE id = $1', [profile.id, current.version]);
        }
        await t.query('INSERT INTO shared_profile_links (profile_id, tenant_id, shopper_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [profile.id, tenantId, shopper.id]);
        const [{ n }] = await t.query('SELECT count(*)::int AS n FROM shared_addresses WHERE profile_id = $1', [profile.id]);
        let hasDefault = n > 0;
        for (const a of n === 0 ? addresses.slice(0, 20) : []) {
          const makeDefault = !hasDefault && (a.isDefault || a === addresses[0]);
          await t.query('INSERT INTO shared_addresses (profile_id, address_enc, is_default) VALUES ($1, $2, $3)', [
            profile.id, enc({ name: a.name, phone: a.phone, line1: a.line1, line2: a.line2, landmark: a.landmark, city: a.city, stateCode: a.stateCode, pincode: a.pincode, kind: a.kind }), makeDefault,
          ]);
          hasDefault ||= makeDefault;
        }
        await t.query('INSERT INTO shared_consent_log (subject_hash, granted, notice_version) VALUES ($1, true, $2)', [pHash ?? gHash, current.version]);
        log.info('shared_profile.consented', { noticeVersion: current.version });
        return { profileId: Number(profile.id) };
      });
    },

    /**
     * After a shopper proved a phone or Google account at a business: if that person already has a shared profile, this
     * business's shopper row is linked to it, so their saved addresses are offered at this checkout. Returns nothing a
     * caller could show: a business never learns from here whether a person shops elsewhere.
     */
    async linkAfterSignIn({ tenantId, shopperId, phone = null, googleSub = null }) {
      const pHash = phone ? phoneHash(phone) : null;
      const gHash = googleSub ? googleHash(googleSub) : null;
      if (!pHash && !gHash) return;
      const [profile] = await pdb.query('SELECT id FROM shared_profiles WHERE ($1::text IS NOT NULL AND phone_hash = $1) OR ($2::text IS NOT NULL AND google_hash = $2) ORDER BY id LIMIT 1', [pHash, gHash]);
      if (profile) await pdb.query('INSERT INTO shared_profile_links (profile_id, tenant_id, shopper_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [profile.id, tenantId, shopperId]);
    },

    /** This shopper's saved addresses from the shared profile, for their own checkout here. Empty without a profile. */
    async addresses(tenantId, shopperId) {
      const profile = await profileOf(tenantId, shopperId);
      if (!profile) return [];
      const rows = await pdb.query('SELECT id, address_enc, is_default FROM shared_addresses WHERE profile_id = $1 ORDER BY is_default DESC, id', [profile.id]);
      return rows.map((row) => ({ row, a: dec(row.address_enc) })).filter(({ a }) => a).map(({ row, a }) => ({ ...a, id: null, sharedId: `s${row.id}`, isDefault: row.is_default, shared: true }));
    },

    /** An address the shopper saved here also joins their shared profile, when they have one. */
    async addAddress(tenantId, shopperId, a) {
      const profile = await profileOf(tenantId, shopperId);
      if (!profile) return;
      const [{ n }] = await pdb.query('SELECT count(*)::int AS n FROM shared_addresses WHERE profile_id = $1', [profile.id]);
      if (n >= 20) return;
      await pdb.query('INSERT INTO shared_addresses (profile_id, address_enc, is_default) VALUES ($1, $2, $3)', [
        profile.id, enc({ name: a.name, phone: a.phone, line1: a.line1, line2: a.line2, landmark: a.landmark, city: a.city, stateCode: a.stateCode, pincode: a.pincode, kind: a.kind }), n === 0,
      ]);
    },

    /**
     * Withdrawal, from any store's account page: the profile goes, with its addresses, links and signals, and every sign-in
     * that was made through it ends at every store. Each business keeps its own shopper row and orders.
     */
    async withdraw(tenantId, shopperId) {
      return pdb.tx(async (t) => {
        const profile = await profileOf(tenantId, shopperId, t);
        if (!profile) return { removed: false };
        const [full] = await t.query('SELECT phone_hash, google_hash, notice_version FROM shared_profiles WHERE id = $1 FOR UPDATE', [profile.id]);
        await t.query(
          `UPDATE shopper_sessions s SET revoked_at = now() FROM shared_profile_links l
           WHERE l.profile_id = $1 AND s.tenant_id = l.tenant_id AND s.shopper_id = l.shopper_id AND s.method = 'shared' AND s.revoked_at IS NULL`,
          [profile.id],
        );
        await t.query('INSERT INTO shared_consent_log (subject_hash, granted, notice_version) VALUES ($1, false, $2)', [full.phone_hash ?? full.google_hash, full.notice_version]);
        await t.query('DELETE FROM shared_profiles WHERE id = $1', [profile.id]);
        log.info('shared_profile.withdrawn', {});
        return { removed: true };
      });
    },

    /** The label only (S-103): 'none', 'elevated' or 'high'. A shopper with no profile is 'none'. */
    async codRisk(tenantId, shopperId) {
      return (await profileOf(tenantId, shopperId))?.cod_risk ?? 'none';
    },

    /** One cash-on-delivery parcel reached its end: delivered, or refused at the door. The row names no business. */
    async recordCodOutcome(tenantId, shopperId, { refused }) {
      await pdb.tx(async (t) => {
        const profile = await profileOf(tenantId, shopperId, t);
        if (!profile) return;
        await t.query(
          `INSERT INTO shared_cod_signals (profile_id, month, delivered, refused) VALUES ($1, date_trunc('month', now())::date, $2, $3)
           ON CONFLICT (profile_id, month) DO UPDATE SET delivered = shared_cod_signals.delivered + EXCLUDED.delivered, refused = shared_cod_signals.refused + EXCLUDED.refused`,
          [profile.id, refused ? 0 : 1, refused ? 1 : 0],
        );
        await refreshRisk(t, profile.id);
      });
    },

    // ---- signing in at another store without a new code (S-98) ----
    // The platform's own host remembers the person in a cookie of its own. A store sends the browser there with a signed
    // request; the platform host answers with a one-use ticket for that store alone, or with nothing.

    // Every token below passes through a browser, so the profile's id inside it is sealed (encrypted with DATA_KEY): a
    // stable id that two stores could both see would let them tell that one person shops at both.

    /** A ticket that lets the platform host remember this profile in the browser. Made when consent is given, or after a sign-in at a linked store. */
    async rememberTicket(tenantId, shopperId, returnTo) {
      const profile = await profileOf(tenantId, shopperId);
      return profile ? signToken(config, 'shared-remember', { q: seal(profile.id), t: tenantId, r: returnTo, j: newToken(12) }, 2 * 60_000) : null;
    },
    readRememberTicket: (ticket) => opened(readToken(config, 'shared-remember', ticket)),
    rememberCookie: (profileId) => signToken(config, 'shared-cookie', { q: seal(profileId) }, REMEMBER_DAYS * 86_400_000),
    rememberMaxAgeMs: REMEMBER_DAYS * 86_400_000,
    async profileFromCookie(value) {
      const payload = opened(readToken(config, 'shared-cookie', value));
      if (!payload) return null;
      const [row] = await pdb.query('SELECT id FROM shared_profiles WHERE id = $1', [payload.p]);
      return row ? Number(row.id) : null;
    },
    async profileExists(profileId) {
      return Boolean((await pdb.query('SELECT 1 FROM shared_profiles WHERE id = $1', [profileId]))[0]);
    },
    signRequest: (tenantId, host, nonce, next) => signToken(config, 'shared-request', { t: tenantId, h: host, n: nonce, x: next }, 5 * 60_000),
    readRequest: (value) => readToken(config, 'shared-request', value),
    signTicket: (profileId, tenantId, nonce) => signToken(config, 'shared-ticket', { q: seal(profileId), t: tenantId, n: nonce, j: newToken(12) }, 60_000),
    readTicket: (value) => opened(readToken(config, 'shared-ticket', value)),
    /** True the first time a ticket id is seen, false ever after: a ticket works once. */
    async firstUse(jti) {
      return (await platform.rateLimit.hit('shared_ticket', String(jti), { limit: 1, windowMs: 10 * 60_000 })).allowed;
    },
    /** The verified phone of a profile, for the store the ticket was made for. null when the profile has none (Google only) or is gone. */
    async verifiedPhone(profileId) {
      const [row] = await pdb.query('SELECT phone_enc FROM shared_profiles WHERE id = $1', [profileId]);
      return row?.phone_enc ? dec(row.phone_enc)?.phone ?? null : null;
    },
  };
}
