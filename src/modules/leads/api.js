import { ApiError } from '../../contracts/api/index.js';
import { PLAN_REASON } from '../../contracts/catalog.js';
import { log, reportError } from '../../platform/log.js';
import { writeAudit } from '../audit/index.js';
import { mapPage } from '../admin-api/paging.js';
import { FILE_TYPES, fileKey, fileRow, fileUrl, leadsCsv, leadsXlsx, ownsKey } from './files.js';
import { MAX_DOWNLOAD_ROWS } from './repo.js';

/**
 * The seller API for leads (PRD 8.15). Reading, deleting and recording a withdrawal are never refused for the plan: a business
 * that drops the add-on still answers for the leads it holds. The form's settings need the feature (K-59).
 */
export const FEATURE = 'lead_form';

export const toLead = (row) => ({
  id: row.id,
  firstName: row.first_name,
  phone: row.phone,
  email: row.email,
  source: row.source,
  sourceRef: row.source_ref,
  utmCampaign: row.utm_campaign,
  pageId: row.page_id,
  consentVersion: row.consent_version,
  consentedAt: row.consented_at,
  consents: row.consents.map((c) => ({ channel: c.channel, grantedAt: c.granted_at, withdrawnAt: c.withdrawn_at })),
  createdAt: row.created_at,
});

const toConsent = (row) => (row ? { version: row.version, body: row.body, channels: row.channels } : null);
const toForm = (row) => ({ surface: row.surface, enabled: row.enabled, offerLine: row.offer_line });

/** A download as the API shows it. A ready file past its time is expired, whether or not anything has swept it yet. */
export function toDownload(row, now = new Date()) {
  const expired = row.status === 'ready' && row.expires_at && new Date(row.expires_at) <= now;
  const status = expired ? 'expired' : row.status;
  return {
    id: row.id,
    format: row.format,
    status,
    rowCount: row.row_count,
    fileUrl: status === 'ready' ? fileUrl(row.id) : null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export function leadsApi({ db, repos, platform }) {
  const leads = () => repos.leads;
  const actor = (user) => `user:${user.id}`;
  const available = () => repos.entitlements.can(FEATURE);

  async function needFeature() {
    if (!(await available())) throw new ApiError('forbidden', 'The lead form isn’t on your plan.', { reason: PLAN_REASON });
  }

  const businessName = async () => (await repos.settings.getAll()).store_name;

  async function settings() {
    if (!(await available())) return { available: false, consent: null, items: [] };
    const [consent, forms] = await Promise.all([leads().consent(), leads().forms()]);
    return { available: true, consent: toConsent(consent), items: forms.map(toForm) };
  }

  return {
    'leads.list': async ({ query }) => mapPage(await leads().list(query), toLead),
    'leads.get': async ({ params }) => {
      const lead = await leads().get(params.id);
      return lead ? toLead(lead) : null;
    },
    'leads.remove': async ({ params, user }) => {
      if (!(await leads().remove(params.id))) throw new ApiError('not_found');
      await writeAudit(db, { actor: actor(user), action: 'lead.deleted', target: `lead:${params.id}`, details: {} });
    },
    'leads.revokeConsent': async ({ params, body, user }) => {
      const changed = await leads().revoke(params.id, body.channels ?? null);
      if (changed === null) return null;
      if (changed.length) await writeAudit(db, { actor: actor(user), action: 'lead.consent_withdrawn', target: `lead:${params.id}`, details: { channels: changed, by: 'seller' } });
      return toLead(await leads().get(params.id));
    },

    'leadForms.get': () => settings(),
    'leadForms.update': async ({ body, user }) => {
      await needFeature();
      // A form never shows without wording to agree to: the first one is made as the form is first switched on.
      if (body.enabled) await leads().currentConsent(await businessName());
      const saved = await leads().saveForm(body.surface, { enabled: body.enabled, offerLine: body.offerLine });
      await writeAudit(db, { actor: actor(user), action: 'lead_form.saved', target: `lead_form:${saved.surface}`, details: { enabled: saved.enabled } });
      return settings();
    },
    'leadForms.setConsent': async ({ body, user }) => {
      await needFeature();
      const text = await leads().setConsent(await businessName(), body.channels);
      await writeAudit(db, { actor: actor(user), action: 'lead_form.consent_changed', target: 'lead_form', details: { version: text.version, channels: text.channels } });
      return settings();
    },

    'leadDownloads.list': async ({ query }) => mapPage(await leads().listDownloads(query), (row) => toDownload(row)),
    'leadDownloads.get': async ({ params }) => {
      const row = await leads().getDownload(params.id);
      return row ? toDownload(row) : null;
    },
    /** The file is made here and now: a business's leads are few enough, and the owner is waiting for it. Every one is logged (5.14). */
    'leadDownloads.create': async ({ body, user }) => {
      const download = await leads().createDownload({ format: body.format, userId: user.id });
      try {
        const rows = (await leads().allForFile({ limit: MAX_DOWNLOAD_ROWS })).map(fileRow);
        const buffer = body.format === 'csv' ? leadsCsv(rows) : await leadsXlsx(rows);
        const key = fileKey(download.id, body.format);
        if (!ownsKey(key)) throw new Error('lead file key outside the business');
        await platform.storage.put(key, buffer, FILE_TYPES[body.format]);
        const ready = await leads().finishDownload(download.id, { status: 'ready', fileKey: key, rowCount: rows.length });
        await writeAudit(db, { actor: actor(user), action: 'leads.downloaded', target: `lead_download:${download.id}`, details: { format: body.format, rows: rows.length } });
        log.info('leads.download_made', { downloadId: download.id, rows: rows.length });
        return toDownload(ready);
      } catch (err) {
        reportError(err, { msg: 'leads.download_failed', downloadId: download.id });
        return toDownload(await leads().finishDownload(download.id, { status: 'failed' }));
      }
    },
  };
}
