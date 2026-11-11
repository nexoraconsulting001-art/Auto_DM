import { ApiError } from '../../contracts/api/index.js';
import { LEAD_SURFACES } from '../../contracts/buyer-pages.js';
import { tenantId } from '../../tenancy.js';
import { pageOfFetched, readCursor } from '../admin-api/paging.js';
import { consentBody, orderedChannels } from './rules.js';

/**
 * Leads (PRD 8.15, migration 306): this business's only, in every query. A lead is a first name, a phone number or an email,
 * where it came from and the consent given per channel against a numbered wording. There is no column for anything else, and
 * nothing here reads or writes another business's rows: leads are never moved between businesses and there is no import.
 */

/** The channels a business's first consent wording covers, until the owner picks. */
export const DEFAULT_CHANNELS = Object.freeze(['whatsapp', 'email']);
/** New leads one business takes in an hour. Past it the form asks the shopper to try later: a flood can't fill the table. */
export const MAX_NEW_PER_HOUR = 600;
export const DOWNLOAD_HOURS = 24;
export const MAX_DOWNLOAD_ROWS = 200_000;

const UNIQUE_VIOLATION = '23505';
/** The first half of the advisory lock a capture takes; the second is the business's id. */
const CAPTURE_LOCK = 4_242_150;
const LEAD_COLS = `l.id, l.first_name, l.phone, l.email, l.source, l.source_ref, l.utm_campaign, l.page_id, l.consented_at, l.created_at, ct.version AS consent_version`;
const LEAD_FROM = 'leads l JOIN lead_consent_texts ct ON ct.tenant_id = l.tenant_id AND ct.id = l.consent_text_id';

export function leadsRepo(db) {
  const t0 = () => tenantId();

  async function withConsents(rows, runner = db) {
    if (!rows.length) return [];
    const consents = await runner.query(
      'SELECT lead_id, channel, granted_at, withdrawn_at FROM lead_consents WHERE tenant_id = $1 AND lead_id = ANY($2::int[])',
      [t0(), rows.map((r) => r.id)],
    );
    const byLead = new Map();
    for (const c of consents) byLead.set(c.lead_id, [...(byLead.get(c.lead_id) ?? []), c]);
    return rows.map((row) => ({
      ...row,
      consents: orderedChannels((byLead.get(row.id) ?? []).map((c) => c.channel)).map((channel) => (byLead.get(row.id) ?? []).find((c) => c.channel === channel)),
    }));
  }

  const latestConsent = async (runner = db) =>
    (await runner.query('SELECT id, version, body, channels FROM lead_consent_texts WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1', [t0()]))[0] ?? null;

  /** Adds the next numbered wording. Two saves at once can pick the same number; the second tries again with the next. */
  async function addConsent(businessName, channels) {
    const list = orderedChannels(channels);
    if (!list.length) throw new ApiError('validation_failed', 'Pick at least one way to contact.', { fields: { channels: 'Pick at least one way to contact' } });
    const body = consentBody(businessName, list);
    for (let attempt = 0; ; attempt++) {
      try {
        const [row] = await db.query(
          `INSERT INTO lead_consent_texts (tenant_id, version, body, channels)
           SELECT $1, COALESCE(max(version), 0) + 1, $2, $3::text[] FROM lead_consent_texts WHERE tenant_id = $1
           RETURNING id, version, body, channels`,
          [t0(), body, list],
        );
        return row;
      } catch (err) {
        if (err?.code !== UNIQUE_VIOLATION || attempt >= 3) throw err;
      }
    }
  }

  const self = {
    // ---- the form's settings ----------------------------------------------------------------------------------------------

    /** Every surface's setting, in the contract's order; one never saved is off. */
    async forms() {
      const rows = await db.query('SELECT surface, enabled, offer_line FROM lead_forms WHERE tenant_id = $1', [t0()]);
      return LEAD_SURFACES.map((surface) => rows.find((r) => r.surface === surface) ?? { surface, enabled: false, offer_line: '' });
    },

    async form(surface) {
      if (!LEAD_SURFACES.includes(surface)) return null;
      const [row] = await db.query('SELECT surface, enabled, offer_line FROM lead_forms WHERE tenant_id = $1 AND surface = $2', [t0(), surface]);
      return row ?? { surface, enabled: false, offer_line: '' };
    },

    async saveForm(surface, { enabled, offerLine }) {
      const [row] = await db.query(
        `INSERT INTO lead_forms (tenant_id, surface, enabled, offer_line) VALUES ($1, $2, COALESCE($3, false), COALESCE($4, ''))
         ON CONFLICT (tenant_id, surface) DO UPDATE SET enabled = COALESCE($3, lead_forms.enabled), offer_line = COALESCE($4, lead_forms.offer_line), updated_at = now()
         RETURNING surface, enabled, offer_line`,
        [t0(), surface, enabled ?? null, offerLine ?? null],
      );
      return row;
    },

    // ---- consent wordings: numbered, never changed ------------------------------------------------------------------------

    consent: () => latestConsent(),

    async consentVersion(version) {
      if (!Number.isInteger(version) || version < 1) return null;
      const [row] = await db.query('SELECT id, version, body, channels FROM lead_consent_texts WHERE tenant_id = $1 AND version = $2', [t0(), version]);
      return row ?? null;
    },

    setConsent: (businessName, channels) => addConsent(businessName, channels),

    /**
     * The wording a form shows now. The first time there is none it is made for the default channels, and when the business
     * has changed its name since, a new version names it: a shopper always agrees to wording that names the seller as it is.
     */
    async currentConsent(businessName) {
      const latest = await latestConsent();
      if (!latest) return addConsent(businessName, DEFAULT_CHANNELS);
      if (latest.body !== consentBody(businessName, latest.channels)) return addConsent(businessName, latest.channels);
      return latest;
    },

    // ---- taking a lead in -------------------------------------------------------------------------------------------------

    /**
     * Stores what a shopper sent, with the consent they gave. The same phone number or email again is the same person: their
     * one lead is brought up to date (the consent just given, any contact they had not given before) and no second row is
     * made, so sending the form over and over leaves one lead. Answers { id, created } or { refused: 'busy' }.
     */
    async capture({ lead, source, sourceRef = '', utmCampaign = '', pageId = null, consentTextId }) {
      return db.tx(async (t) => {
        // One at a time per business: two sends of one contact can't both find nothing and both insert.
        await t.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [CAPTURE_LOCK, t0()]);
        const [existing] = await t.query(
          `SELECT id, phone, email FROM leads WHERE tenant_id = $1 AND (($2::text <> '' AND phone = $2::text) OR ($3::text <> '' AND lower(email) = $3::text)) ORDER BY id LIMIT 1`,
          [t0(), lead.phone, lead.email],
        );
        let id = existing?.id ?? null;
        if (existing) {
          await t.query(
            `UPDATE leads SET first_name = $3, phone = CASE WHEN phone = '' THEN $4 ELSE phone END, email = CASE WHEN email = '' THEN $5 ELSE email END,
               consent_text_id = $6, consented_at = now() WHERE tenant_id = $1 AND id = $2`,
            [t0(), id, lead.firstName, lead.phone, lead.email, consentTextId],
          );
        } else {
          const [{ n }] = await t.query(`SELECT count(*)::int AS n FROM leads WHERE tenant_id = $1 AND created_at > now() - interval '1 hour'`, [t0()]);
          if (n >= MAX_NEW_PER_HOUR) return { refused: 'busy' };
          const [row] = await t.query(
            `INSERT INTO leads (tenant_id, first_name, phone, email, source, source_ref, utm_campaign, page_id, consent_text_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [t0(), lead.firstName, lead.phone, lead.email, source, sourceRef, utmCampaign, pageId, consentTextId],
          );
          id = row.id;
        }
        // Each channel is its own purpose. Agreeing again after withdrawing is fresh consent for the channels this contact reaches.
        const [held] = await t.query('SELECT phone, email FROM leads WHERE tenant_id = $1 AND id = $2', [t0(), id]);
        for (const channel of lead.channels) {
          const reachable = channel === 'email' ? Boolean(lead.email) && held.email === lead.email : Boolean(lead.phone) && held.phone === lead.phone;
          if (!reachable) continue;
          await t.query(
            `INSERT INTO lead_consents (tenant_id, lead_id, channel) VALUES ($1, $2, $3)
             ON CONFLICT (tenant_id, lead_id, channel) DO UPDATE SET granted_at = now(), withdrawn_at = NULL`,
            [t0(), id, channel],
          );
        }
        return { id, created: !existing };
      });
    },

    // ---- the seller's list ------------------------------------------------------------------------------------------------

    async list({ cursor, limit = 25, source = 'all', consent = 'all' } = {}) {
      const before = cursor ? readCursor(cursor, (key) => key.length === 1 && Number.isSafeInteger(key[0]) && key[0] > 0)[0] : null;
      const rows = await db.query(
        `SELECT ${LEAD_COLS} FROM ${LEAD_FROM}
         WHERE l.tenant_id = $1 AND ($2::int IS NULL OR l.id < $2) AND ($3::text = 'all' OR l.source = $3::text)
           AND ($4::text = 'all'
             OR ($4::text = 'active' AND EXISTS (SELECT 1 FROM lead_consents c WHERE c.tenant_id = l.tenant_id AND c.lead_id = l.id AND c.withdrawn_at IS NULL))
             OR ($4::text = 'withdrawn' AND EXISTS (SELECT 1 FROM lead_consents c WHERE c.tenant_id = l.tenant_id AND c.lead_id = l.id AND c.withdrawn_at IS NOT NULL)))
         ORDER BY l.id DESC LIMIT $5`,
        [t0(), before, source, consent, limit + 1],
      );
      const page = pageOfFetched(rows, limit, (row) => [row.id]);
      return { items: await withConsents(page.items), nextCursor: page.nextCursor };
    },

    async get(id) {
      const rows = await db.query(`SELECT ${LEAD_COLS} FROM ${LEAD_FROM} WHERE l.tenant_id = $1 AND l.id = $2`, [t0(), id]);
      return (await withConsents(rows))[0] ?? null;
    },

    /** Erases the lead and its consent records (9.18). True when there was one. */
    async remove(id) {
      const [row] = await db.query('DELETE FROM leads WHERE tenant_id = $1 AND id = $2 RETURNING id', [t0(), id]);
      return Boolean(row);
    },

    /**
     * Records a withdrawal: every channel, or the ones named. A withdrawn channel stays withdrawn (its first date is kept).
     * Null when the lead isn't this business's.
     */
    async revoke(id, channels = null) {
      const [lead] = await db.query('SELECT id FROM leads WHERE tenant_id = $1 AND id = $2', [t0(), id]);
      if (!lead) return null;
      const changed = await db.query(
        `UPDATE lead_consents SET withdrawn_at = now() WHERE tenant_id = $1 AND lead_id = $2 AND withdrawn_at IS NULL AND ($3::text[] IS NULL OR channel = ANY($3::text[])) RETURNING channel`,
        [t0(), id, channels?.length ? channels : null],
      );
      return changed.map((c) => c.channel);
    },

    /** Every lead for a file, oldest first, with each channel's consent as it stands now. */
    async allForFile({ limit = MAX_DOWNLOAD_ROWS } = {}) {
      const rows = await db.query(`SELECT ${LEAD_COLS} FROM ${LEAD_FROM} WHERE l.tenant_id = $1 ORDER BY l.id ASC LIMIT $2`, [t0(), limit]);
      return withConsents(rows);
    },

    // ---- downloads --------------------------------------------------------------------------------------------------------

    async createDownload({ format, userId }) {
      const [row] = await db.query('INSERT INTO lead_downloads (tenant_id, format, created_by) VALUES ($1, $2, $3) RETURNING *', [t0(), format, userId ?? null]);
      return row;
    },

    async finishDownload(id, { status, fileKey = '', rowCount = 0 }) {
      const [row] = await db.query(
        `UPDATE lead_downloads SET status = $3::text, file_key = $4, row_count = $5, expires_at = CASE WHEN $3::text = 'ready' THEN now() + $6::int * interval '1 hour' ELSE NULL END
         WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [t0(), id, status, fileKey, rowCount, DOWNLOAD_HOURS],
      );
      return row ?? null;
    },

    async expireDownload(id) {
      const [row] = await db.query(`UPDATE lead_downloads SET status = 'expired', file_key = '' WHERE tenant_id = $1 AND id = $2 AND status = 'ready' RETURNING *`, [t0(), id]);
      return row ?? null;
    },

    async getDownload(id) {
      const [row] = await db.query('SELECT * FROM lead_downloads WHERE tenant_id = $1 AND id = $2', [t0(), id]);
      return row ?? null;
    },

    async listDownloads({ cursor, limit = 25 } = {}) {
      const before = cursor ? readCursor(cursor, (key) => key.length === 1 && Number.isSafeInteger(key[0]) && key[0] > 0)[0] : null;
      const rows = await db.query('SELECT * FROM lead_downloads WHERE tenant_id = $1 AND ($2::int IS NULL OR id < $2) ORDER BY id DESC LIMIT $3', [t0(), before, limit + 1]);
      return pageOfFetched(rows, limit, (row) => [row.id]);
    },
  };
  return self;
}
