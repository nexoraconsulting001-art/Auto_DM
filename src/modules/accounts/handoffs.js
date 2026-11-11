import { HANDOFF_SECONDS, newToken, pkceMatches, tokenHash } from '../../contracts/accounts.js';
import { platformOf } from './shared.js';

/**
 * Carrying a browser sign-in back to the app (PRD 10.3). The callback writes a single-use code bound to the PKCE
 * challenge the app sent at the start; the app swaps the code and its verifier. The code lives HANDOFF_SECONDS, only its
 * hash is stored, and it is spent by the first try, right verifier or wrong, so a code caught on its way to the app is
 * worth nothing to whoever caught it.
 */
export function handoffsService(ctx) {
  const db = () => platformOf(ctx.db);

  async function create({ personId, challenge, purpose }) {
    const code = newToken(32);
    await db().query(
      `INSERT INTO auth_handoffs (code_hash, person_id, challenge, purpose, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5::int))`,
      [tokenHash(code), personId, challenge, purpose, HANDOFF_SECONDS],
    );
    return code;
  }

  /** The person this code was for, when it is live, for this purpose, and the verifier matches its challenge; otherwise null. */
  async function take({ code, verifier, purpose }) {
    if (typeof code !== 'string' || !code || code.length > 200) return null;
    const [row] = await db().query(
      'UPDATE auth_handoffs SET used_at = now() WHERE code_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now() RETURNING person_id, challenge',
      [tokenHash(code), purpose],
    );
    if (!row || !pkceMatches(verifier, row.challenge)) return null;
    return Number(row.person_id);
  }

  async function purge() {
    await db().query(`DELETE FROM auth_handoffs WHERE expires_at < now() - interval '1 day'`);
  }

  return { create, take, purge };
}
