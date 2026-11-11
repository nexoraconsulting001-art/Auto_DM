import { ApiError } from '../../contracts/api/index.js';
import { POLICY_KINDS } from '../../contracts/api/store.js';
import { tenantId } from '../../tenancy.js';
import { writeAudit } from '../audit/index.js';
import { DEFAULT_NOTICE, storeName } from './provider.js';

/**
 * The seller's side of 9.18: the grievance contact, the four policy pages, the consent notice and its versions, and data
 * requests. Each answers a route of src/contracts/api/store.js (privacyRoutes). Every change is in the audit log.
 */
export function createPrivacy({ db }) {
  const toSettings = (row) => ({ grievanceName: row?.grievance_name ?? '', grievanceEmail: row?.grievance_email ?? '', grievancePhone: row?.grievance_phone ?? '', grievanceAddress: row?.grievance_address ?? '' });

  return {
    async settings() {
      const [row] = await db.query('SELECT * FROM privacy_settings WHERE tenant_id = $1', [tenantId()]);
      return toSettings(row);
    },

    async saveSettings(patch) {
      const [row] = await db.query(
        `INSERT INTO privacy_settings (tenant_id, grievance_name, grievance_email, grievance_phone, grievance_address)
         VALUES ($1, COALESCE($2, ''), COALESCE($3, ''), COALESCE($4, ''), COALESCE($5, ''))
         ON CONFLICT (tenant_id) DO UPDATE SET
           grievance_name = COALESCE($2, privacy_settings.grievance_name), grievance_email = COALESCE($3, privacy_settings.grievance_email),
           grievance_phone = COALESCE($4, privacy_settings.grievance_phone), grievance_address = COALESCE($5, privacy_settings.grievance_address), updated_at = now()
         RETURNING *`,
        [tenantId(), patch.grievanceName ?? null, patch.grievanceEmail ?? null, patch.grievancePhone ?? null, patch.grievanceAddress ?? null],
      );
      return toSettings(row);
    },

    /** The contact the privacy page shows (S-62): the seller's own, or the store's support details until they set one. */
    async grievance() {
      const [row] = await db.query('SELECT * FROM privacy_settings WHERE tenant_id = $1', [tenantId()]);
      const set = toSettings(row);
      if (set.grievanceName || set.grievanceEmail || set.grievancePhone || set.grievanceAddress) {
        return { name: set.grievanceName, email: set.grievanceEmail, phone: set.grievancePhone, address: set.grievanceAddress };
      }
      const rows = await db.query(`SELECT key, value FROM settings WHERE tenant_id = $1 AND key IN ('store_name', 'support_email', 'support_whatsapp')`, [tenantId()]);
      const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      return { name: s.store_name ?? '', email: s.support_email ?? '', phone: s.support_whatsapp ?? '', address: '' };
    },

    async policyBody(kind) {
      const [row] = await db.query('SELECT body FROM policy_pages WHERE tenant_id = $1 AND kind = $2', [tenantId(), kind]);
      return row?.body ?? '';
    },

    async policies() {
      const rows = await db.query('SELECT kind, body, updated_at FROM policy_pages WHERE tenant_id = $1', [tenantId()]);
      return POLICY_KINDS.map((kind) => {
        const row = rows.find((r) => r.kind === kind);
        return { kind, body: row?.body ?? '', url: `/policies/${kind}`, updatedAt: row?.updated_at ?? null };
      });
    },

    async savePolicy(kind, body) {
      const [row] = await db.query(
        `INSERT INTO policy_pages (tenant_id, kind, body) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, kind) DO UPDATE SET body = EXCLUDED.body, updated_at = now() RETURNING kind, body, updated_at`,
        [tenantId(), kind, body],
      );
      return { kind: row.kind, body: row.body, url: `/policies/${row.kind}`, updatedAt: row.updated_at };
    },
  };
}

export function consentApi(services) {
  const actor = (user) => `user:${user.id}`;
  return {
    'privacy.get': async () => services().privacy.settings(),
    'privacy.update': async ({ body, user }) => {
      const saved = await services().privacy.saveSettings(body);
      await writeAudit(services().db, { actor: actor(user), action: 'privacy.update', target: 'privacy', details: { fields: Object.keys(body) } });
      return saved;
    },
    'policies.all': async () => ({ items: await services().privacy.policies() }),
    'policies.save': async ({ body, user }) => {
      const saved = await services().privacy.savePolicy(body.kind, body.body);
      await writeAudit(services().db, { actor: actor(user), action: 'policies.save', target: `policy:${body.kind}`, details: { chars: body.body.length } });
      return saved;
    },
    'consentNotice.get': async () => {
      const published = await services().store.publishedNotice();
      if (published) return published;
      const name = await storeName(services().db);
      return { version: 0, bodyEn: DEFAULT_NOTICE.en(name), bodyHi: DEFAULT_NOTICE.hi(name), createdAt: null };
    },
    'consentNotice.publish': async ({ body, user }) => {
      const notice = await services().store.publish({ bodyEn: body.bodyEn, bodyHi: body.bodyHi });
      await writeAudit(services().db, { actor: actor(user), action: 'consent_notice.publish', target: `consent_notice:${notice.version}`, details: { version: notice.version } });
      return notice;
    },
    'dataRequests.list': async ({ query }) => services().requests.list(query),
    'dataRequests.get': async ({ params }) => services().requests.get(params.id),
    'dataRequests.create': async ({ body, user }) => {
      const made = await services().requests.create({ shopperId: body.shopperId, kind: body.kind, source: 'seller', actor: actor(user) });
      if (!made) throw new ApiError('not_found', 'We couldn’t find that shopper.');
      return made.request;
    },
  };
}
