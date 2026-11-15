import { log } from '../../platform/log.js';
import { inviteHash, sha256 } from './rules.js';

/**
 * Sign-up's rows (migration 700): signup_settings, signup_invites, signup_runs and signup_steps. A run starts before there
 * is a business, so everything here is on the platform path. Logs carry ids and times only.
 */
export function signupStore(db) {
  const p = db.platform ?? db;

  const toRun = (row) => row && ({
    id: Number(row.id),
    personId: row.person_id === null ? null : Number(row.person_id),
    tenantId: row.tenant_id === null ? null : Number(row.tenant_id),
    accountType: row.account_type ?? null,
    referralCode: row.referral_code ?? '',
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
  });

  const toInvite = (row) => ({
    id: Number(row.id), note: row.note, maxUses: row.max_uses, uses: row.uses, expiresAt: row.expires_at ?? null,
    revokedAt: row.revoked_at ?? null, createdBy: row.created_by, createdAt: row.created_at,
  });

  return {
    toInvite,

    async settings() {
      const [row] = await p.query('SELECT mode, free_per_instagram, daily_cap, updated_at FROM signup_settings');
      return { mode: row?.mode ?? 'closed', freePerInstagram: row?.free_per_instagram ?? 1, dailyCap: row?.daily_cap ?? null, updatedAt: row?.updated_at ?? new Date(0) };
    },

    /**
     * `dailyCap` undefined keeps the cap; null removes it. `forced` is { reason, missing } when a super admin opened sign-up
     * past the go-live checklist: the second reason and the item ids that were missing go into the audit row.
     */
    async setMode(mode, { actor, reason, dailyCap, forced = null }) {
      await p.tx(async (t) => {
        if (dailyCap === undefined) await t.query('UPDATE signup_settings SET mode = $1, updated_at = now()', [mode]);
        else await t.query('UPDATE signup_settings SET mode = $1, daily_cap = $2, updated_at = now()', [mode, dailyCap]);
        const details = { mode, reason, ...(dailyCap === undefined ? {} : { dailyCap }), ...(forced ? { forced: true, forceReason: forced.reason, missing: forced.missing } : {}) };
        await t.query(`INSERT INTO audit_log (tenant_id, actor, action, target, details) VALUES (NULL, $1, 'signup.mode_set', 'signup', $2::jsonb)`, [actor, JSON.stringify(details)]);
      });
    },

    /** Businesses sign-up has made since midnight, India time: what the daily cap is compared with. */
    async madeToday() {
      const [row] = await p.query(
        `SELECT count(*)::int AS n FROM signup_runs r JOIN tenants t ON t.id = r.tenant_id
          WHERE t.created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`,
      );
      return row?.n ?? 0;
    },

    /** Whether an invite code would be accepted now. Reads only: the use is counted when the business is made. */
    async inviteUsable(code) {
      if (!code) return false;
      const [row] = await p.query(
        `SELECT 1 FROM signup_invites WHERE code_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND uses < max_uses`,
        [inviteHash(code)],
      );
      return Boolean(row);
    },

    /** Counts one use of an invite inside `t`, in one statement, so two sign-ups cannot both take the last use. Null when it can't be used. */
    async takeInvite(t, code) {
      if (!code) return null;
      const [row] = await t.query(
        `UPDATE signup_invites SET uses = uses + 1
         WHERE code_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND uses < max_uses RETURNING id`,
        [inviteHash(code)],
      );
      return row ? Number(row.id) : null;
    },

    async createInvite({ code, note, maxUses, expiresInDays, actor }) {
      return p.tx(async (t) => {
        const [row] = await t.query(
          `INSERT INTO signup_invites (code_hash, note, max_uses, expires_at, created_by)
           VALUES ($1, $2, $3, CASE WHEN $4::int IS NULL THEN NULL ELSE now() + make_interval(days => $4::int) END, $5) RETURNING *`,
          [inviteHash(code), note, maxUses, expiresInDays ?? null, actor],
        );
        await t.query(`INSERT INTO audit_log (tenant_id, actor, action, target, details) VALUES (NULL, $1, 'signup.invite_created', $2, $3::jsonb)`, [actor, `signup_invite:${row.id}`, JSON.stringify({ maxUses, expiresInDays: expiresInDays ?? null })]);
        return toInvite(row);
      });
    },

    async listInvites({ cursor, limit }) {
      const after = /^\d{1,18}$/.test(String(cursor ?? '')) ? cursor : null;
      const rows = await p.query('SELECT * FROM signup_invites WHERE ($1::bigint IS NULL OR id < $1::bigint) ORDER BY id DESC LIMIT $2', [after, limit + 1]);
      const items = rows.slice(0, limit).map(toInvite);
      return { items, nextCursor: rows.length > limit ? String(items.at(-1).id) : null };
    },

    async revokeInvite(id, actor) {
      return p.tx(async (t) => {
        const [row] = await t.query('UPDATE signup_invites SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 RETURNING *', [Number(id)]);
        if (!row) return null;
        await t.query(`INSERT INTO audit_log (tenant_id, actor, action, target, details) VALUES (NULL, $1, 'signup.invite_revoked', $2, '{}'::jsonb)`, [actor, `signup_invite:${row.id}`]);
        return toInvite(row);
      });
    },

    async newRun(token, { personId = null, referralCode = '' } = {}) {
      const [row] = await p.query('INSERT INTO signup_runs (token_hash, person_id, referral_code) VALUES ($1, $2, $3) RETURNING *', [sha256(token), personId, referralCode]);
      const run = toRun(row);
      await this.step(run, 'opened');
      return run;
    },

    async runByToken(token) {
      if (!token) return null;
      const [row] = await p.query('SELECT * FROM signup_runs WHERE token_hash = $1', [sha256(token)]);
      return toRun(row) ?? null;
    },

    async runById(id, t = p) {
      const [row] = await t.query('SELECT * FROM signup_runs WHERE id = $1', [id]);
      return toRun(row) ?? null;
    },

    /** A run with no person yet becomes this person's. False when it is someone else's. */
    async claimRun(run, personId) {
      if (run.personId === personId) return true;
      if (run.personId !== null) return false;
      const [row] = await p.query('UPDATE signup_runs SET person_id = $2 WHERE id = $1 AND person_id IS NULL RETURNING id', [run.id, personId]);
      if (!row) return false;
      run.personId = personId;
      return true;
    },

    async setReferral(run, code) {
      if (!code || run.referralCode) return;
      await p.query(`UPDATE signup_runs SET referral_code = $2 WHERE id = $1 AND referral_code = ''`, [run.id, code]);
      run.referralCode = code;
    },

    /** Writes a step once per run with its time, and logs how long into the run it came (F-121). */
    async step(run, step, t = p) {
      const [row] = await t.query('INSERT INTO signup_steps (run_id, step) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING at', [run.id, step]);
      if (row) log.info('signup.step', { runId: run.id, step, ms: Math.max(0, new Date(row.at) - new Date(run.startedAt)) });
      return Boolean(row);
    },

    async steps(run) {
      return (await p.query('SELECT step, at FROM signup_steps WHERE run_id = $1 ORDER BY at, step', [run.id])).map((r) => ({ step: r.step, at: r.at }));
    },

    async finish(run) {
      const [row] = await p.query('UPDATE signup_runs SET finished_at = COALESCE(finished_at, now()) WHERE id = $1 RETURNING started_at, finished_at', [run.id]);
      await this.step(run, 'finished');
      return { startedAt: row.started_at, finishedAt: row.finished_at };
    },

    /** The business has an Instagram account with a token: connected with Instagram Login, its scopes stored by ig-connect. */
    async instagramConnected(tenantId) {
      const [row] = await p.query(`SELECT 1 FROM ig_accounts WHERE tenant_id = $1 AND access_token_enc <> '' AND status = 'active' LIMIT 1`, [tenantId]);
      return Boolean(row);
    },
  };
}
