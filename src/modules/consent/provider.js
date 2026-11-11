import { CHANNEL_PURPOSES, CONSENT_CHANNELS } from '../../platform/consent.js';
import { tenantId } from '../../tenancy.js';
import { keyedHash, normalEmail, toE164 } from '../shoppers/keys.js';

/**
 * The answers behind platform.consent (PRD 9.18): the ledger in consent_records, read newest first.
 *
 * Who a row is about. A signed-in shopper (shopper_id), a guest known by the phone or email typed at checkout (keyed
 * hashes, scoped to this business, so the same number at another business is another value), or a browser (the traffic
 * visitor id) for the analytics and ads choice. A row carries every key the caller knew, and a question is answered by the
 * newest row matching any key the asker knows: a withdrawal made from an unsubscribe link (phone only) therefore also
 * stops a send addressed by shopper id, and the other way round.
 *
 * Analytics and ads (the Phase 2 question) is the browser's choice: it is answered from the visitor id. When that
 * browser's choice was made by a signed-in shopper, the shopper's newest choice on any device counts too, so taking it
 * back on one device stops events from the others. A shopper id passed by a caller is not trusted for this purpose,
 * because Phase 2 callers know an account id from the sellers' table, which is not a shopper id.
 *
 * Nothing here is ever assumed: no row is a no, with `answered` false.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isId = (value) => Number.isInteger(value) && value > 0 && value <= 2147483647;

export const DEFAULT_NOTICE = Object.freeze({
  en: (name) => `${name} uses your name, phone number and address to take, deliver and support your order. With your separate permission, ${name} may also send you order updates and offers on WhatsApp or by email, and use cookies to measure visits and ads. You can say no, and you can change your mind at any time from your account or the Privacy page.`,
  hi: (name) => `${name} आपके नाम, फ़ोन नंबर और पते का उपयोग आपका ऑर्डर लेने, पहुँचाने और उससे जुड़ी मदद के लिए करता है। आपकी अलग अनुमति मिलने पर ${name} आपको WhatsApp या ईमेल से ऑर्डर की जानकारी और ऑफ़र भेज सकता है, और विज़िट तथा विज्ञापनों को मापने के लिए कुकीज़ का उपयोग कर सकता है। आप मना कर सकते हैं, और अपने खाते या प्राइवेसी पेज से कभी भी अपनी पसंद बदल सकते हैं।`,
});

/**
 * The business's name as its buyers see it: the store name it set, or the name it was onboarded with. Never a query that
 * may fail: inside a checkout's transaction a failed query would end the whole order.
 */
export async function storeName(runner) {
  const [settings] = await runner.query(`SELECT value FROM settings WHERE tenant_id = $1 AND key = 'store_name'`, [tenantId()]);
  const [tenant] = await runner.query('SELECT name FROM tenants WHERE id = $1', [tenantId()]);
  return String(settings?.value || tenant?.name || 'This store').slice(0, 120);
}

export function createConsentStore({ db, config }) {
  const phoneHash = (phone) => {
    const e164 = toE164(phone);
    return e164 ? keyedHash(config, `phone:${tenantId()}`, e164) : null;
  };
  const emailHash = (email) => {
    const e = normalEmail(email);
    return e ? keyedHash(config, `email:${tenantId()}`, e) : null;
  };

  /** The keys of a person, as the ledger holds them. */
  function keysOf(subject = {}) {
    return {
      shopperId: isId(subject.shopperId) ? subject.shopperId : null,
      phoneHash: subject.phoneHash && /^[0-9a-f]{64}$/.test(subject.phoneHash) ? subject.phoneHash : phoneHash(subject.phone),
      emailHash: subject.emailHash && /^[0-9a-f]{64}$/.test(subject.emailHash) ? subject.emailHash : emailHash(subject.email),
      visitorId: typeof subject.visitorId === 'string' && UUID.test(subject.visitorId) ? subject.visitorId.toLowerCase() : null,
    };
  }

  /** A shopper's own phone and email are keys of theirs too, so what they said as a guest still holds after they sign in. */
  async function withShopperKeys(keys, runner = db) {
    if (!keys.shopperId) return keys;
    const [row] = await runner.query('SELECT phone, email FROM shoppers WHERE tenant_id = $1 AND id = $2 AND erased_at IS NULL', [tenantId(), keys.shopperId]);
    // A shopper who is gone (erased) is no longer a key: a row naming them could not be written.
    if (!row) return { ...keys, shopperId: null };
    return { ...keys, phoneHash: keys.phoneHash ?? phoneHash(row.phone), emailHash: keys.emailHash ?? emailHash(row.email) };
  }

  async function ensureNotice(runner = db) {
    const latest = async () => (await runner.query('SELECT version, body_en, body_hi, created_at FROM consent_notices WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1', [tenantId()]))[0];
    let row = await latest();
    if (!row) {
      const name = await storeName(runner);
      await runner.query('INSERT INTO consent_notices (tenant_id, version, body_en, body_hi) VALUES ($1, 1, $2, $3) ON CONFLICT DO NOTHING', [tenantId(), DEFAULT_NOTICE.en(name), DEFAULT_NOTICE.hi(name)]);
      row = await latest();
    }
    return row;
  }
  const toNotice = (row) => ({ version: row.version, bodyEn: row.body_en, bodyHi: row.body_hi, createdAt: row.created_at });

  /** The newest row for one purpose and channel among every key given. */
  async function newest(keys, purpose, channel, runner = db) {
    if (!keys.shopperId && !keys.phoneHash && !keys.emailHash) return null;
    const [row] = await runner.query(
      `SELECT id, granted, notice_version, created_at FROM consent_records
       WHERE tenant_id = $1 AND purpose = $2 AND channel = $3
         AND (($4::int IS NOT NULL AND shopper_id = $4) OR ($5::text IS NOT NULL AND phone_hash = $5) OR ($6::text IS NOT NULL AND email_hash = $6))
       ORDER BY id DESC LIMIT 1`,
      [tenantId(), purpose, channel, keys.shopperId, keys.phoneHash, keys.emailHash],
    );
    return row ?? null;
  }

  /** The browser's choice, or the newer choice of the shopper who made it. */
  async function newestForVisitor(visitorId, runner = db) {
    if (!visitorId) return null;
    const [row] = await runner.query(
      `SELECT id, granted, notice_version, created_at, shopper_id FROM consent_records
       WHERE tenant_id = $1 AND purpose = 'analytics_ads' AND visitor_id = $2 ORDER BY id DESC LIMIT 1`,
      [tenantId(), visitorId],
    );
    if (!row?.shopper_id) return row ?? null;
    const [theirs] = await runner.query(
      `SELECT id, granted, notice_version, created_at FROM consent_records
       WHERE tenant_id = $1 AND purpose = 'analytics_ads' AND shopper_id = $2 ORDER BY id DESC LIMIT 1`,
      [tenantId(), row.shopper_id],
    );
    return theirs && Number(theirs.id) > Number(row.id) ? theirs : row;
  }

  const answer = (row) => (row ? { granted: row.granted === true, answered: true, reason: row.granted === true ? 'granted' : 'withdrawn' } : { granted: false, answered: false, reason: 'not_asked' });

  async function insert(runner, keys, { purpose, channel = '', granted, noticeVersion, source, orderId = null }) {
    await runner.query(
      `INSERT INTO consent_records (tenant_id, shopper_id, phone_hash, email_hash, visitor_id, purpose, channel, granted, notice_version, source, order_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [tenantId(), keys.shopperId, keys.phoneHash, keys.emailHash, keys.visitorId, purpose, channel || '', granted, noticeVersion, source, isId(orderId) ? orderId : null],
    );
  }

  const provider = {
    async allows({ purpose, channel, ...subject }) {
      const keys = keysOf(subject);
      if (purpose === 'analytics_ads') {
        if (!keys.visitorId) return { granted: false, answered: false, reason: 'consent.no_visitor' };
        return answer(await newestForVisitor(keys.visitorId));
      }
      return answer(await newest(await withShopperKeys(keys), purpose, channel ?? ''));
    },

    async record({ subject, choices, noticeVersion, source, orderId }, t) {
      const runner = t ?? db;
      // A row carries every key of the person, so a later question asked by phone, by email or by account finds it.
      const keys = await withShopperKeys(keysOf(subject), runner);
      if (!keys.shopperId && !keys.phoneHash && !keys.emailHash && !keys.visitorId) throw new Error('A consent record needs who it is about');
      const notice = await ensureNotice(runner);
      // A choice names the wording that was on screen. A version this business never published is refused, not rounded.
      if (noticeVersion > notice.version) throw new Error('That consent notice version does not exist');
      for (const choice of choices) {
        if (choice.purpose !== 'analytics_ads' && !keys.shopperId && !keys.phoneHash && !keys.emailHash) throw new Error('A browser alone can only answer for analytics and ads');
        await insert(runner, keys, { ...choice, noticeVersion, source, orderId });
      }
      return { recorded: choices.length };
    },

    async revoke({ subject, purpose, channel, source }, t) {
      const runner = t ?? db;
      const keys = await withShopperKeys(keysOf(subject), runner);
      if (!keys.shopperId && !keys.phoneHash && !keys.emailHash && !keys.visitorId) return { recorded: 0 };
      if (purpose !== 'analytics_ads' && !keys.shopperId && !keys.phoneHash && !keys.emailHash) throw new Error('A browser alone can only answer for analytics and ads');
      const notice = await ensureNotice(runner);
      await insert(runner, keys, { purpose, channel, granted: false, noticeVersion: notice.version, source });
      return { recorded: 1 };
    },

    async status(subject) {
      const keys = await withShopperKeys(keysOf(subject));
      const out = [];
      for (const purpose of ['fulfilment', ...CHANNEL_PURPOSES]) {
        for (const channel of CHANNEL_PURPOSES.includes(purpose) ? CONSENT_CHANNELS : ['']) {
          const row = await newest(keys, purpose, channel);
          if (row) out.push({ purpose, channel, granted: row.granted === true, noticeVersion: row.notice_version, at: row.created_at });
        }
      }
      const visit = await newestForVisitor(keys.visitorId);
      if (visit) out.push({ purpose: 'analytics_ads', channel: '', granted: visit.granted === true, noticeVersion: visit.notice_version, at: visit.created_at });
      return out;
    },

    async notice() {
      return toNotice(await ensureNotice());
    },
  };

  return {
    provider,
    keysOf,
    phoneHash,
    emailHash,
    ensureNotice: async (runner) => toNotice(await ensureNotice(runner)),

    /** The wording as the seller last published it, or version 0 with the default wording when nothing is published yet. */
    async publishedNotice() {
      const [row] = await db.query('SELECT version, body_en, body_hi, created_at FROM consent_notices WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1', [tenantId()]);
      return row ? toNotice(row) : null;
    },

    /** A new version. Old ones stay, so every record still names what was read. */
    async publish({ bodyEn, bodyHi }, runner = db) {
      const [row] = await runner.query(
        `INSERT INTO consent_notices (tenant_id, version, body_en, body_hi)
         SELECT $1, COALESCE(max(version), 0) + 1, $2, $3 FROM consent_notices WHERE tenant_id = $1
         RETURNING version, body_en, body_hi, created_at`,
        [tenantId(), bodyEn, bodyHi],
      );
      return toNotice(row);
    },

    /** What a signed-in shopper or a browser has said, as the buyer pages show it. null means never asked. */
    async choicesFor({ shopperId = null, visitorId = null }) {
      const keys = await withShopperKeys(keysOf({ shopperId, visitorId }));
      const yes = async (purpose, channel) => {
        const row = await newest(keys, purpose, channel);
        return row ? row.granted === true : null;
      };
      const visit = await newestForVisitor(keys.visitorId);
      const known = Boolean(keys.shopperId);
      return {
        orderUpdates: { whatsapp: known ? await yes('order_updates', 'whatsapp') : null, email: known ? await yes('order_updates', 'email') : null },
        marketing: { whatsapp: known ? await yes('marketing', 'whatsapp') : null, email: known ? await yes('marketing', 'email') : null },
        analyticsAds: visit ? visit.granted === true : null,
      };
    },

    /** Does this person hold a marketing yes here, per channel. For the seller's customer list (S-104: this business's ledger only). */
    async marketingFor(subject) {
      const keys = await withShopperKeys(keysOf(subject));
      const out = {};
      for (const channel of CONSENT_CHANNELS) out[channel] = (await newest(keys, 'marketing', channel))?.granted === true;
      return out;
    },
  };
}
