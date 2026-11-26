import crypto from 'node:crypto';
import { ApiError } from '../../contracts/api/errors.js';
import { ProviderError } from '../../adapters/http.js';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { WHATSAPP_LIMITS } from '../../contracts/addons.js';
import { writeAudit } from '../audit/index.js';
import { checkContent, linksIn } from '../compliance/content.js';
import { linkProblem } from '../links/rules.js';
import { secretBinding } from '../../contracts/secrets.js';

/**
 * The add-on's console routes (src/contracts/api/addons.js, whatsappRoutes). The router has already checked who may call
 * each one, a fresh sign-in where it says so, and the entitlement where the route names it; reading, removing and
 * disconnecting never need the add-on, so what a business has stays manageable after it ends.
 *
 * No answer carries the access token, the phone number id, or anything about a shopper beyond an opt-in's purpose, source
 * and times. Nothing here sends a message: there is no broadcast, and a message the business starts can only be an
 * approved template to someone who opted in, which the compliance gate decides (wa.no_optin).
 */
const STATE_TTL_MS = 10 * 60_000;
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

const hashState = (state) => crypto.createHash('sha256').update(String(state)).digest('hex');
const actorOf = (user) => `user:${user?.id ?? 'unknown'}`;

const toKeywordSet = (r) => ({ id: r.id, keywords: r.keywords, reelId: r.reel_id ?? null, linkUrl: r.link_url, message: r.message, active: r.active });
const toOptin = (r) => ({ id: Number(r.id), purpose: r.purpose, source: r.source, optedInAt: r.opted_in_at, withdrawnAt: r.withdrawn_at ?? null });

/** One keyword as it is kept: trimmed and single-spaced. The matcher folds case and form itself. */
const cleanKeyword = (k) => String(k).normalize('NFC').trim().replace(/\s+/g, ' ');

const LINK_REFUSAL = 'That link can’t be sent on WhatsApp.';

export function whatsappApi(ctx) {
  const { db, config, providers, platform } = ctx;

  const signupReady = () => Boolean(config.whatsappAppId && config.whatsappSignupConfigId && config.whatsappAppSecret);

  async function accountRow() {
    const [row] = await db.query('SELECT * FROM whatsapp_accounts WHERE tenant_id = $1', [tenantId()]);
    return row ?? null;
  }

  async function status() {
    const row = await accountRow();
    return {
      connected: Boolean(row && row.status === 'active' && row.access_token_enc),
      status: row?.status ?? null,
      displayName: row?.display_name ?? '',
      displayNumber: row?.display_number ?? '',
      connectedAt: row?.connected_at ?? null,
      signupReady: signupReady(),
    };
  }

  // ---- embedded signup ----------------------------------------------------------------------------------------------

  async function connectStart({ user }) {
    const state = crypto.randomBytes(32).toString('base64url');
    await db.query(
      `INSERT INTO oauth_states (state_hash, tenant_id, provider, user_id, return_to, expires_at) VALUES ($1, $2, 'whatsapp', $3, '', $4::timestamptz)`,
      [hashState(state), tenantId(), user?.id ?? null, new Date(Date.now() + STATE_TTL_MS)],
    );
    return { appId: String(config.whatsappAppId ?? ''), configId: String(config.whatsappSignupConfigId ?? ''), state };
  }

  /** The state works once, for this business and the person who started, within its few minutes. */
  async function useState(state, user) {
    const [row] = await db.query(
      `UPDATE oauth_states SET used_at = now()
       WHERE state_hash = $1 AND tenant_id = $2 AND provider = 'whatsapp' AND used_at IS NULL AND expires_at > now() AND (user_id IS NULL OR user_id = $3)
       RETURNING state_hash`,
      [hashState(state), tenantId(), user?.id ?? null],
    );
    return Boolean(row);
  }

  async function connectFinish({ body, user }) {
    if (!(await useState(body.state, user))) {
      throw new ApiError('validation_failed', 'That WhatsApp sign-up has expired or was already used. Start again.', { fields: { state: 'Start the sign-up again' } });
    }
    let account;
    let number;
    try {
      const { accessToken } = await providers.whatsapp.exchangeCode({ code: body.code });
      account = { wabaId: body.wabaId, phoneNumberId: body.phoneNumberId, accessToken };
      number = await providers.whatsapp.phoneNumber(account);
      await providers.whatsapp.subscribe(account);
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      log.warn('whatsapp.signup_refused', { kind: err.kind, status: err.status, code: String(err.code ?? '').slice(0, 20) });
      if (err.code === 'not_configured') throw new ApiError('conflict', 'WhatsApp sign-up isn’t set up on this server yet.');
      throw new ApiError('validation_failed', 'WhatsApp didn’t accept that sign-up. Start again.', { fields: { code: 'Not accepted by WhatsApp' } });
    }
    const before = await accountRow();
    try {
      await db.tx(async (t) => {
        await t.query(
          `INSERT INTO whatsapp_accounts (tenant_id, waba_id, phone_number_id, display_number, display_name, access_token_enc, status, connected_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'active', now(), now())
           ON CONFLICT (tenant_id) DO UPDATE SET waba_id = EXCLUDED.waba_id, phone_number_id = EXCLUDED.phone_number_id, display_number = EXCLUDED.display_number,
             display_name = EXCLUDED.display_name, access_token_enc = EXCLUDED.access_token_enc, status = 'active', connected_at = now(), updated_at = now()`,
          [tenantId(), account.wabaId, account.phoneNumberId, String(number.displayNumber ?? '').slice(0, 20), String(number.verifiedName ?? '').slice(0, 120), platform.secrets.encrypt(account.accessToken, secretBinding('whatsapp_accounts', 'access_token_enc', { tenant_id: tenantId() }))],
        );
        // Another WhatsApp Business account has its own templates and reviews: read them again rather than trust the old ones.
        if (before && before.waba_id !== account.wabaId) {
          await t.query(`UPDATE whatsapp_templates SET status = 'pending', provider_id = NULL, checked_at = NULL, updated_at = now() WHERE tenant_id = $1`, [tenantId()]);
        }
        await writeAudit(t, { actor: actorOf(user), action: 'whatsapp.connected', target: 'whatsapp_account', details: { replaced: Boolean(before), signup: 'embedded' } });
      });
    } catch (err) {
      if (err?.code === UNIQUE_VIOLATION) throw new ApiError('conflict', 'This WhatsApp number is already connected to another business.');
      throw err;
    }
    log.info('whatsapp.connected', { tenantId: tenantId() });
    return status();
  }

  /**
   * The number stops answering at once: the token is dropped and the account marked disabled, so the gate holds anything
   * queued (paused.reconnect) and nothing new is queued. The inbox keeps its WhatsApp threads.
   */
  async function disconnect({ user }) {
    await db.tx(async (t) => {
      await t.query(`UPDATE whatsapp_accounts SET status = 'disabled', access_token_enc = '', updated_at = now() WHERE tenant_id = $1`, [tenantId()]);
      await writeAudit(t, { actor: actorOf(user), action: 'whatsapp.disconnected', target: 'whatsapp_account' });
    });
    return null;
  }

  // ---- keyword sets -------------------------------------------------------------------------------------------------

  /**
   * PRD 4.10 and 4.11 at save, as the gate checks again at send: the message's content (WhatsApp's 4,096-byte limit, no platform
   * name, no request for card or bank details), and its link and every link written in the message (no shortener, nothing on
   * the blocklist, WhatsApp only to the saved support number). {link} is where the link goes, so it is no variable to refuse.
   */
  async function checkKeywordSets(items) {
    const settings = await ctx.repos.settings.getAll();
    const context = { whatsappNumber: settings.support_whatsapp ?? '', blockedHosts: await ctx.repos.automations.blockedHosts() };
    const refuse = (field, message, reason) => new ApiError('validation_failed', message, { fields: { [field]: message }, reason });
    for (const [index, item] of items.entries()) {
      const text = String(item.message ?? '').replaceAll('{link}', '');
      const ownDomain = config.platformDomain ?? '';
      // Checked as the gate will see it at send, once {link} is filled: any other {name} would reach the shopper as written.
      const [problem] = checkContent({ text, ownDomain, maxBytes: WHATSAPP_LIMITS.textBytes, filled: true });
      if (problem) throw refuse(`items.${index}.message`, problem.message, problem.reason);
      if (item.linkUrl) {
        const reason = linkProblem(item.linkUrl, context);
        if (reason) throw refuse(`items.${index}.linkUrl`, LINK_REFUSAL, reason);
        const [promo] = checkContent({ url: item.linkUrl, ownDomain });
        if (promo) throw refuse(`items.${index}.linkUrl`, promo.message, promo.reason);
      }
      for (const url of linksIn(text)) {
        const reason = linkProblem(url, context);
        if (reason) throw refuse(`items.${index}.message`, LINK_REFUSAL, reason);
      }
    }
  }

  async function keywords() {
    const rows = await db.query('SELECT * FROM whatsapp_keywords WHERE tenant_id = $1 ORDER BY position, id', [tenantId()]);
    return { items: rows.map(toKeywordSet) };
  }

  /** The whole list in priority order: a set left out is removed, an id that is not this business's is refused. */
  async function saveKeywords({ body, user }) {
    const items = body.items.map((item) => ({ ...item, keywords: [...new Set(item.keywords.map(cleanKeyword).filter(Boolean))] }));
    const blank = items.findIndex((item) => !item.keywords.length);
    if (blank >= 0) throw new ApiError('validation_failed', 'Add a keyword', { fields: { [`items.${blank}.keywords`]: 'Add a keyword' } });
    await checkKeywordSets(items);
    try {
      await db.tx(async (t) => {
        const existing = new Set((await t.query('SELECT id FROM whatsapp_keywords WHERE tenant_id = $1', [tenantId()])).map((r) => r.id));
        const kept = items.filter((item) => item.id !== undefined).map((item) => item.id);
        const unknown = kept.findIndex((id) => !existing.has(id));
        if (unknown >= 0) throw new ApiError('validation_failed', 'That keyword set no longer exists. Reload and try again.', { fields: { items: 'Reload and try again' } });
        await t.query('DELETE FROM whatsapp_keywords WHERE tenant_id = $1 AND NOT (id = ANY($2::integer[]))', [tenantId(), kept]);
        for (const [position, item] of items.entries()) {
          const values = [tenantId(), item.keywords, item.reelId, item.linkUrl, item.message, position, item.active];
          if (item.id !== undefined) {
            await t.query(
              `UPDATE whatsapp_keywords SET keywords = $2::text[], reel_id = $3, link_url = $4, message = $5, position = $6, active = $7, updated_at = now()
               WHERE tenant_id = $1 AND id = $8`,
              [...values, item.id],
            );
          } else {
            await t.query(
              `INSERT INTO whatsapp_keywords (tenant_id, keywords, reel_id, link_url, message, position, active) VALUES ($1, $2::text[], $3, $4, $5, $6, $7)`,
              values,
            );
          }
        }
        await writeAudit(t, { actor: actorOf(user), action: 'whatsapp.keywords_saved', target: 'whatsapp_keywords', details: { sets: items.length } });
      });
    } catch (err) {
      if (err?.code === FOREIGN_KEY_VIOLATION) throw new ApiError('validation_failed', 'Choose one of your own reels', { fields: { reelId: 'Choose one of your own reels' } });
      throw err;
    }
    return keywords();
  }

  // ---- opt-ins ------------------------------------------------------------------------------------------------------

  async function optins({ query }) {
    const limit = query.limit ?? 25;
    // The cursor is the last row's time in microseconds and its id, so two opt-ins in one millisecond are never skipped.
    const [us, id] = String(query.cursor ?? '').split('_').map(Number);
    const after = query.cursor && Number.isSafeInteger(us) && Number.isSafeInteger(id) ? { us, id } : null;
    const rows = await db.query(
      `SELECT id, purpose, source, opted_in_at, withdrawn_at, (extract(epoch FROM opted_in_at) * 1000000)::bigint AS at_us FROM whatsapp_optins
       WHERE tenant_id = $1 AND ($2::text IS NULL OR purpose = $2)
         AND ($3::bigint IS NULL OR ((extract(epoch FROM opted_in_at) * 1000000)::bigint, id) < ($3::bigint, $4::bigint))
       ORDER BY opted_in_at DESC, id DESC LIMIT $5`,
      [tenantId(), query.purpose ?? null, after?.us ?? null, after?.id ?? 0, limit + 1],
    );
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return { items: page.map(toOptin), nextCursor: more && last ? `${last.at_us}_${last.id}` : null };
  }

  return {
    'whatsapp.status': () => status(),
    'whatsapp.connectStart': (call) => connectStart(call),
    'whatsapp.connectFinish': (call) => connectFinish(call),
    'whatsapp.disconnect': (call) => disconnect(call),
    'whatsapp.keywords': () => keywords(),
    'whatsapp.saveKeywords': (call) => saveKeywords(call),
    'whatsapp.optins': (call) => optins(call),
  };
}
