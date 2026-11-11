import { ApiError } from '../../contracts/api/errors.js';
import { ProviderError } from '../../adapters/http.js';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { writeAudit } from '../audit/index.js';
import { TEMPLATE_LANGUAGE, TEMPLATE_PURPOSES, WHATSAPP_TEMPLATES, reviewStatus, templateComponents, templateName } from './templates.js';

/**
 * The owner's side of shopper alerts (PRD 9.16, S-96): which alerts go out and from where, the business's own WhatsApp
 * account, and its message templates with Meta's review of each. WhatsApp and email are the only channels: there is no SMS.
 *
 *   view() / update(patch, actor)                        AlertSettings (src/contracts/api/store.js)
 *   account() / connect(input, actor) / disconnect(actor) WhatsappAccount. The token is stored encrypted and never returned.
 *   templates() / syncTemplates()                         every purpose's template, submitted when missing, status read back
 *   activeAccount()                                       the decrypted account for a WhatsApp call, or null
 *
 * WhatsApp charges are shown at cost with no markup. Meta's per-message prices are not in the codebase yet (to confirm in
 * PRD 9.16): config.whatsappCostPaise ({ utility, authentication, marketing }, whole paise) supplies them; without it each
 * is null, which the console shows as "not known yet".
 */
export const ALERT_EVENTS = Object.freeze(['placed', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded']);
const DEFAULTS = Object.freeze({ whatsapp: true, email: true, events: [...ALERT_EVENTS], email_from: 'neutral', email_from_local: 'orders', email_reply_to: '', cart_reminders: false });
const UNIQUE_VIOLATION = '23505';

const costOf = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

export function createAlertSettings({ db, platform, providers, config }) {
  async function row() {
    const [found] = await db.query('SELECT * FROM alert_settings WHERE tenant_id = $1', [tenantId()]);
    return found ?? { ...DEFAULTS };
  }

  /** The business's own domain, when it is verified and primary: the only one order email may come from as 'own'. */
  async function ownDomain() {
    const [found] = await db.query(`SELECT domain FROM tenant_domains WHERE tenant_id = $1 AND is_primary AND status = 'verified' LIMIT 1`, [tenantId()]);
    return found?.domain ?? null;
  }

  function neutralAddress(local) {
    const domain = String(config.emailNeutralDomain ?? '').trim().toLowerCase();
    return domain ? `${local}@${domain}` : '';
  }

  async function view() {
    const s = await row();
    const domain = s.email_from === 'own' ? await ownDomain() : null;
    const cost = config.whatsappCostPaise ?? {};
    return {
      channels: ['whatsapp', 'email'],
      whatsapp: s.whatsapp,
      email: s.email,
      events: ALERT_EVENTS.filter((e) => s.events.includes(e)),
      emailFrom: s.email_from,
      emailFromAddress: domain ? `${s.email_from_local}@${domain}` : neutralAddress(s.email_from_local),
      emailReplyTo: s.email_reply_to,
      whatsappCostPaise: { utility: costOf(cost.utility), authentication: costOf(cost.authentication), marketing: costOf(cost.marketing) },
    };
  }

  /** Saves the fields given; the rest stay as they are. Email 'own' needs a verified domain of the business's own. */
  async function update(patch, actor) {
    const changes = {};
    if (patch.whatsapp !== undefined) changes.whatsapp = patch.whatsapp;
    if (patch.email !== undefined) changes.email = patch.email;
    if (patch.events !== undefined) changes.events = ALERT_EVENTS.filter((e) => patch.events.includes(e));
    if (patch.emailFrom !== undefined) changes.email_from = patch.emailFrom;
    if (patch.emailFromLocal !== undefined) changes.email_from_local = patch.emailFromLocal;
    if (patch.emailReplyTo !== undefined) changes.email_reply_to = patch.emailReplyTo.toLowerCase();
    if (changes.email_from === 'own' && !(await ownDomain())) {
      throw new ApiError('validation_failed', 'Connect and verify your own domain before sending order email from it.', { fields: { emailFrom: 'Your domain isn’t verified yet' } });
    }
    if (Object.keys(changes).length) await save(changes, actor, 'alert_settings.updated');
    return view();
  }

  async function save(changes, actor, action) {
    const names = Object.keys(changes);
    const values = names.map((n) => changes[n]);
    await db.tx(async (t) => {
      await t.query(
        `INSERT INTO alert_settings (tenant_id, ${names.join(', ')}) VALUES ($1, ${names.map((_, i) => `$${i + 2}`).join(', ')})
         ON CONFLICT (tenant_id) DO UPDATE SET ${names.map((n) => `${n} = EXCLUDED.${n}`).join(', ')}, updated_at = now()`,
        [tenantId(), ...values],
      );
      if (actor) await writeAudit(t, { actor, action, target: 'alert_settings', details: { fields: names } });
    });
  }

  // ---- the business's WhatsApp account ----

  async function accountRow() {
    const [found] = await db.query('SELECT * FROM whatsapp_accounts WHERE tenant_id = $1', [tenantId()]);
    return found ?? null;
  }

  async function account() {
    const a = await accountRow();
    if (!a) return { connected: false, displayNumber: '', status: 'none' };
    return { connected: a.status === 'active', displayNumber: a.display_number, status: a.status };
  }

  /** The account with its token decrypted, for a call to WhatsApp; null when there is none or it can't be read. */
  async function activeAccount() {
    const a = await accountRow();
    if (!a || a.status !== 'active' || !a.access_token_enc) return null;
    try {
      return { wabaId: a.waba_id, phoneNumberId: a.phone_number_id, accessToken: platform.secrets.decrypt(a.access_token_enc) };
    } catch {
      // A token that no longer decrypts (the key changed) reads as needing a reconnect, never a server error.
      return null;
    }
  }

  async function connect({ wabaId, phoneNumberId, accessToken, displayNumber }, actor) {
    const candidate = { wabaId, phoneNumberId, accessToken };
    let shown = displayNumber ?? '';
    try {
      const number = await providers.whatsapp.phoneNumber(candidate);
      if (!shown) shown = String(number.displayNumber ?? '').slice(0, 20);
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      if (err.kind === 'auth' || err.kind === 'rejected') throw new ApiError('validation_failed', 'WhatsApp didn’t accept these details. Check the phone number id and the access token.', { fields: { accessToken: 'Not accepted by WhatsApp' } });
      // WhatsApp could not be reached just now: keep the details; the template sync will tell if they are wrong.
      log.warn('whatsapp.connect_unchecked', { kind: err.kind, status: err.status });
    }
    const before = await accountRow();
    try {
      await db.tx(async (t) => {
        await t.query(
          `INSERT INTO whatsapp_accounts (tenant_id, waba_id, phone_number_id, display_number, access_token_enc, status, connected_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'active', now(), now())
           ON CONFLICT (tenant_id) DO UPDATE SET waba_id = EXCLUDED.waba_id, phone_number_id = EXCLUDED.phone_number_id, display_number = EXCLUDED.display_number,
             access_token_enc = EXCLUDED.access_token_enc, status = 'active', connected_at = now(), updated_at = now()`,
          [tenantId(), wabaId, phoneNumberId, String(shown).slice(0, 20), platform.secrets.encrypt(accessToken)],
        );
        // Another WhatsApp account has its own templates and reviews: read them again rather than trust the old ones.
        if (before && before.waba_id !== wabaId) await t.query(`UPDATE whatsapp_templates SET status = 'pending', provider_id = NULL, checked_at = NULL, updated_at = now() WHERE tenant_id = $1`, [tenantId()]);
        await writeAudit(t, { actor, action: 'whatsapp.connected', target: 'whatsapp_account', details: { replaced: Boolean(before) } });
      });
    } catch (err) {
      if (err?.code === UNIQUE_VIOLATION) throw new ApiError('conflict', 'This WhatsApp number is already connected to another business.');
      throw err;
    }
    log.info('whatsapp.connected', { tenantId: tenantId() });
    return account();
  }

  async function disconnect(actor) {
    await db.tx(async (t) => {
      await t.query('DELETE FROM whatsapp_accounts WHERE tenant_id = $1', [tenantId()]);
      await writeAudit(t, { actor, action: 'whatsapp.disconnected', target: 'whatsapp_account' });
    });
  }

  // ---- templates ----

  const toTemplate = (r) => ({ id: r.id, purpose: r.purpose, category: r.category, name: r.name, language: r.language, status: r.status, checkedAt: r.checked_at ?? null });

  async function templates() {
    const rows = await db.query('SELECT * FROM whatsapp_templates WHERE tenant_id = $1 ORDER BY id', [tenantId()]);
    return { items: rows.map(toTemplate) };
  }

  async function ensureTemplateRows() {
    for (const purpose of TEMPLATE_PURPOSES) {
      const spec = WHATSAPP_TEMPLATES[purpose];
      await db.query(
        `INSERT INTO whatsapp_templates (tenant_id, purpose, category, name, language, body) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, purpose, language) DO NOTHING`,
        [tenantId(), purpose, spec.category, templateName(purpose), TEMPLATE_LANGUAGE, spec.body],
      );
    }
  }

  /** Submits every missing template and reads every review status back from WhatsApp. */
  async function syncTemplates() {
    const acc = await activeAccount();
    if (!acc) throw new ApiError('conflict', 'Connect your WhatsApp Business account first.');
    await ensureTemplateRows();
    let remote;
    try {
      remote = await providers.whatsapp.templates(acc);
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      if (err.kind === 'auth') {
        await db.query(`UPDATE whatsapp_accounts SET status = 'reconnect', updated_at = now() WHERE tenant_id = $1`, [tenantId()]);
        throw new ApiError('conflict', 'WhatsApp no longer accepts your access token. Connect your account again.');
      }
      throw new ApiError('conflict', 'WhatsApp couldn’t be reached. Try again in a minute.');
    }
    const byKey = new Map(remote.map((r) => [`${r.name}\u0001${r.language}`, r]));
    const rows = await db.query('SELECT * FROM whatsapp_templates WHERE tenant_id = $1 ORDER BY id', [tenantId()]);
    for (const r of rows) {
      const found = byKey.get(`${r.name}\u0001${r.language}`);
      if (found) {
        await setStatus(r.id, reviewStatus(found.status), found.id);
        // Meta may file a template under another category than asked (a Utility one as Marketing): keep what it says.
        if (['utility', 'authentication', 'marketing'].includes(found.category) && found.category !== r.category) {
          await db.query('UPDATE whatsapp_templates SET category = $3 WHERE tenant_id = $1 AND id = $2', [tenantId(), r.id, found.category]);
        }
        continue;
      }
      if (!WHATSAPP_TEMPLATES[r.purpose]) continue;
      try {
        const made = await providers.whatsapp.createTemplate(acc, { name: r.name, language: r.language, category: r.category, components: templateComponents(r.purpose) });
        await setStatus(r.id, reviewStatus(made.status), made.id);
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        // 2388024: one with this name and language exists already; its review is read on the next sync.
        const exists = String(err.code) === '2388024';
        await setStatus(r.id, exists || err.retryable ? r.status : 'rejected', r.provider_id);
        log.warn('whatsapp.template_submit_failed', { purpose: r.purpose, kind: err.kind, code: err.code });
      }
    }
    return templates();
  }

  async function setStatus(id, status, providerId) {
    await db.query(
      'UPDATE whatsapp_templates SET status = $3, provider_id = $4, checked_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2',
      [tenantId(), id, status, providerId ? String(providerId).slice(0, 60) : null],
    );
  }

  /** The review status of one purpose's template, or 'none'. */
  async function templateStatus(purpose) {
    const [found] = await db.query(`SELECT status FROM whatsapp_templates WHERE tenant_id = $1 AND purpose = $2 ORDER BY (status = 'approved') DESC, id LIMIT 1`, [tenantId(), purpose]);
    return found?.status ?? 'none';
  }

  return { row, view, update, save, account, activeAccount, connect, disconnect, templates, syncTemplates, templateStatus };
}
