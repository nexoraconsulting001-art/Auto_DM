import { codeHash, newToken, sameSecret, tokenHash } from '../../contracts/accounts.js';
import { SHOPPER_TOKEN_PREFIX } from '../../contracts/apps.js';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { shopperServices } from '../shoppers/index.js';

/**
 * The shopper app's sessions (PRD 10.7). Every install holds one, a guest one included, so "in the app" always means "carries
 * a valid app access token". A session is a family (token_families, subject_kind 'shopper', this business's tenant_id; a null
 * shopper_id is a guest), its refresh tokens (refresh_tokens, used once each) and one live access session
 * (shopper_app_sessions). Writing them is one db.platform transaction with tenant_id = tenantId() written out in every
 * statement; reading an access token goes through the fenced db, so another business's token is never found.
 *
 *   startGuest({ device, platform, version, previous? })                  -> AppSession tokens
 *   startForShopper(shopper, { method, device, platform, version, previous? })
 *   rotate(refreshToken, { version })   spends the token; a token used twice ends its family and every app session of it.
 *                                       A token of another business, or a seller's, is unknown and changes nothing.
 *   end(appSession)                     ends this sign-in and opens a guest session for the same device
 *   find(accessToken)                   { public, shopper, platform, guest } or null
 *   revokeForShopper(shopperId, reason) every family of this shopper here
 *   purge()                             expired sessions and hand-offs, every business (the hourly job)
 *   afterSignIn(shopper, { method, phone?, googleSub? })  the sign-in consent record and the shared-profile link (9.22)
 *
 * Nothing here logs a token, a phone number or a name.
 */
const built = new WeakMap();

/** The sessions of one app's or worker's context, made once. */
export function appSessionsFor(ctx) {
  let found = built.get(ctx);
  if (!found) {
    found = createAppSessions(ctx);
    built.set(ctx, found);
  }
  return found;
}

/** What app_configs.review_code_hash holds for the store reviewers' demo number (2.1(a)): keyed, never the code itself. */
export const appReviewCodeHash = (config, { tenantId: tid, phone, code }) => codeHash(config.sessionSecret, { purpose: 'app_review', subject: `${tid}:${phone}`, code });

/** True when `code` is the review code of this business's app for `phone` (E.164), and review access is on. */
export function reviewCodeMatches(config, appConfig, { phone, code }) {
  if (!appConfig?.review_enabled || !appConfig.review_phone || !appConfig.review_code_hash || appConfig.review_phone !== phone) return false;
  return sameSecret(appReviewCodeHash(config, { tenantId: tenantId(), phone, code }), appConfig.review_code_hash);
}

const toShopper = (row) => ({
  id: row.shopper_id, phone: row.phone ?? '', email: row.email ?? '', name: row.name ?? '', hasGoogle: Boolean(row.google_sub), hasApple: Boolean(row.apple_sub),
  phoneVerified: Boolean(row.phone_verified_at), method: row.method,
});

export function createAppSessions(ctx) {
  const pdb = ctx.db.platform ?? ctx.db;
  const accessSeconds = () => (Number(ctx.config.shopperAccessTokenMinutes) || 15) * 60;
  const refreshDays = () => Number(ctx.config.shopperRefreshTokenDays) || 90;
  const cleanVersion = (v) => (/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(String(v ?? '')) ? String(v) : '');

  async function writeRefresh(t, familyId) {
    const token = `${SHOPPER_TOKEN_PREFIX.refresh}${newToken(32)}`;
    const [row] = await t.query(
      `INSERT INTO refresh_tokens (family_id, token_hash, tenant_id, user_id, expires_at) VALUES ($1, $2, $3, NULL, now() + make_interval(days => $4::int)) RETURNING id`,
      [familyId, tokenHash(token), tenantId(), refreshDays()],
    );
    return { token, id: Number(row.id) };
  }

  async function writeAccess(t, { familyId, shopperId, method, deviceId, platform, version }) {
    const token = `${SHOPPER_TOKEN_PREFIX.access}${newToken(32)}`;
    await t.query(
      `INSERT INTO shopper_app_sessions (tenant_id, family_id, shopper_id, device_id, platform, app_version, method, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9::int))`,
      [tenantId(), familyId, shopperId, deviceId, platform, cleanVersion(version), method, tokenHash(token), accessSeconds()],
    );
    return token;
  }

  async function endFamilies(t, familyIds, reason) {
    const ids = [...new Set(familyIds.map(Number))].filter((id) => id > 0);
    if (!ids.length) return;
    await t.query(
      `UPDATE token_families SET revoked_at = now(), revoke_reason = $3 WHERE tenant_id = $1 AND subject_kind = 'shopper' AND id = ANY($2::bigint[]) AND revoked_at IS NULL`,
      [tenantId(), ids, reason],
    );
    await t.query('UPDATE shopper_app_sessions SET revoked_at = now() WHERE tenant_id = $1 AND family_id = ANY($2::bigint[]) AND revoked_at IS NULL', [tenantId(), ids]);
  }

  async function open(t, { shopperId, method, device, platform, version, previous }) {
    if (previous?.familyId) await endFamilies(t, [previous.familyId], 'signed_out');
    const [family] = await t.query(
      `INSERT INTO token_families (subject_kind, tenant_id, shopper_id, device_id, app_platform) VALUES ('shopper', $1, $2, $3, $4) RETURNING id`,
      [tenantId(), shopperId, device.id, platform],
    );
    const familyId = Number(family.id);
    const refresh = await writeRefresh(t, familyId);
    const accessToken = await writeAccess(t, { familyId, shopperId, method, deviceId: device.id, platform, version });
    return { accessToken, accessExpiresInSeconds: accessSeconds(), refreshToken: refresh.token, familyId };
  }

  const service = {
    startGuest({ device, platform, version, previous = null }) {
      return pdb.tx(async (t) => {
        const tokens = await open(t, { shopperId: null, method: 'guest', device, platform, version, previous });
        log.info('app.session_started', { familyId: tokens.familyId, guest: true, platform });
        return tokens;
      });
    },

    startForShopper(shopper, { method, device, platform, version, previous = null }) {
      return pdb.tx(async (t) => {
        const tokens = await open(t, { shopperId: shopper.id, method, device, platform, version, previous });
        log.info('app.session_started', { familyId: tokens.familyId, guest: false, method, platform, shopperId: shopper.id });
        return tokens;
      });
    },

    async rotate(token, { version = '' } = {}) {
      if (typeof token !== 'string' || !token.startsWith(SHOPPER_TOKEN_PREFIX.refresh) || token.length > 200) return { refused: 'unknown' };
      const hash = tokenHash(token);
      const outcome = await pdb.tx(async (t) => {
        const tid = tenantId();
        const [spent] = await t.query(
          `UPDATE refresh_tokens SET used_at = now() WHERE token_hash = $1 AND tenant_id = $2 AND user_id IS NULL AND used_at IS NULL
             AND family_id IN (SELECT id FROM token_families WHERE subject_kind = 'shopper' AND tenant_id = $2)
           RETURNING id, family_id, expires_at > now() AS live`,
          [hash, tid],
        );
        if (!spent) {
          const [seen] = await t.query(
            `SELECT family_id FROM refresh_tokens WHERE token_hash = $1 AND tenant_id = $2 AND family_id IN (SELECT id FROM token_families WHERE subject_kind = 'shopper' AND tenant_id = $2)`,
            [hash, tid],
          );
          if (!seen) return { refused: 'unknown' };
          await endFamilies(t, [seen.family_id], 'token_reuse');
          return { refused: 'token_reuse', familyId: Number(seen.family_id) };
        }
        const familyId = Number(spent.family_id);
        const [family] = await t.query(
          `SELECT shopper_id, device_id, app_platform FROM token_families WHERE tenant_id = $1 AND id = $2 AND subject_kind = 'shopper' AND revoked_at IS NULL FOR UPDATE`,
          [tid, familyId],
        );
        if (!family) return { refused: 'revoked', familyId };
        if (!spent.live) return { refused: 'expired', familyId };
        if (family.shopper_id !== null) {
          const [live] = await t.query('SELECT 1 FROM shoppers WHERE tenant_id = $1 AND id = $2 AND erased_at IS NULL', [tid, family.shopper_id]);
          if (!live) {
            await endFamilies(t, [familyId], 'account_deleted');
            return { refused: 'erased', familyId };
          }
        }
        const [last] = await t.query('SELECT method, platform FROM shopper_app_sessions WHERE tenant_id = $1 AND family_id = $2 ORDER BY id DESC LIMIT 1', [tid, familyId]);
        const method = last?.method ?? (family.shopper_id === null ? 'guest' : 'whatsapp_otp');
        await t.query('UPDATE shopper_app_sessions SET revoked_at = now() WHERE tenant_id = $1 AND family_id = $2 AND revoked_at IS NULL', [tid, familyId]);
        const next = await writeRefresh(t, familyId);
        await t.query('UPDATE refresh_tokens SET replaced_by = $3 WHERE tenant_id = $1 AND id = $2', [tid, spent.id, next.id]);
        const accessToken = await writeAccess(t, {
          familyId, shopperId: family.shopper_id, method, deviceId: family.device_id, platform: family.app_platform ?? last?.platform ?? 'android', version,
        });
        return { accessToken, accessExpiresInSeconds: accessSeconds(), refreshToken: next.token, familyId };
      });
      if (outcome.refused) log.warn('app.refresh_refused', { reason: outcome.refused, familyId: outcome.familyId ?? null });
      return outcome;
    },

    end(appSession, { version = '' } = {}) {
      return pdb.tx(async (t) => {
        await endFamilies(t, [appSession.familyId], 'signed_out');
        log.info('app.session_ended', { familyId: appSession.familyId });
        return open(t, { shopperId: null, method: 'guest', device: { id: appSession.deviceId }, platform: appSession.platform, version: version || appSession.version });
      });
    },

    async find(token) {
      if (typeof token !== 'string' || !token.startsWith(SHOPPER_TOKEN_PREFIX.access) || token.length < 20 || token.length > 200) return null;
      const [row] = await ctx.db.query(
        `SELECT s.id, s.family_id, s.shopper_id, s.device_id, s.platform, s.app_version, s.method, s.last_used_at,
                p.id AS shopper_row, p.phone, p.phone_verified_at, p.google_sub, p.apple_sub, p.email, p.name, p.erased_at
         FROM shopper_app_sessions s LEFT JOIN shoppers p ON p.tenant_id = s.tenant_id AND p.id = s.shopper_id
         WHERE s.tenant_id = $1 AND s.token_hash = $2 AND s.revoked_at IS NULL AND s.expires_at > now()`,
        [tenantId(), tokenHash(token)],
      );
      if (!row) return null;
      if (row.shopper_id !== null && (row.shopper_row === null || row.erased_at)) return null;
      if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 5 * 60_000) {
        await ctx.db.query('UPDATE shopper_app_sessions SET last_used_at = now() WHERE tenant_id = $1 AND id = $2', [tenantId(), row.id]);
      }
      const guest = row.shopper_id === null;
      return {
        platform: row.platform,
        guest,
        shopper: guest ? null : toShopper(row),
        public: {
          id: Number(row.id), familyId: Number(row.family_id), deviceId: row.device_id, platform: row.platform, version: row.app_version, method: row.method,
          guest, shopperId: guest ? null : row.shopper_id,
        },
      };
    },

    revokeForShopper(shopperId, reason = 'signed_out') {
      return pdb.tx(async (t) => {
        const rows = await t.query(
          `SELECT id FROM token_families WHERE tenant_id = $1 AND subject_kind = 'shopper' AND shopper_id = $2 AND revoked_at IS NULL`,
          [tenantId(), shopperId],
        );
        await endFamilies(t, rows.map((r) => r.id), reason);
        return rows.length;
      });
    },

    async purge() {
      await pdb.query(
        `DELETE FROM shopper_app_sessions WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '1 day') OR expires_at < now() - make_interval(days => $1::int)`,
        [refreshDays() + 1],
      );
      await pdb.query(`DELETE FROM shopper_app_handoffs WHERE expires_at < now() - interval '1 day'`);
    },

    /** S-59 and 9.22 for an app sign-in: the consent record of the notice in force, and the link to a shared profile if one exists. */
    async afterSignIn(shopper, { method, phone = null, googleSub = null } = {}) {
      const { platform } = ctx;
      if (platform.consent?.built) {
        const current = await platform.consent.notice();
        if (current) {
          await platform.consent.record({ subject: { shopperId: shopper.id }, choices: [{ purpose: 'fulfilment', granted: true }], noticeVersion: current.version, source: 'sign_in' });
        }
      }
      const { shared } = shopperServices(ctx);
      if (shared.available && (phone || googleSub)) await shared.linkAfterSignIn({ tenantId: tenantId(), shopperId: shopper.id, phone, googleSub });
      log.info('shopper.signed_in', { shopperId: shopper.id, method, app: true });
    },
  };
  return service;
}

/** afterSignIn with the context first, for a module that has no sessions object at hand. */
export const afterSignIn = (ctx, shopper, options) => appSessionsFor(ctx).afterSignIn(shopper, options);
