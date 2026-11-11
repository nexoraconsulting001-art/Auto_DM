import crypto from 'node:crypto';

/**
 * Limits that hold across every process and server (PRD 9.3, 9.5: S-09, S-18), counted in Postgres (rate_limit_hits,
 * migration 400). A limit kept in one process's memory lets each instance allow its own share.
 *
 *   hit(scope, subject, { limit, windowMs }) -> { allowed, hits, retryAfterMs }
 *       scope    what is being limited: 'order_attempts', 'otp_sends_ip'
 *       subject  who: an IP address, a business id and a phone number together. Only a hash of scope and subject is stored.
 *       Counts this hit. The window starts at the first hit and the count starts again once it has passed.
 *   peek(scope, subject, { limit, windowMs }) -> the same, without counting
 *   reset(scope, subject)
 *   purge(olderThanMs) removes rows nobody has hit lately (housekeeping).
 *
 * Runs on the platform path: a limit is about no single business.
 */
const keyOf = (scope, subject) => crypto.createHash('sha256').update(`${scope}\n${subject}`).digest('hex');

export function createRateLimit({ db } = {}) {
  const platformDb = db?.platform ?? db;
  const need = () => {
    if (!platformDb) throw new Error('platform.rateLimit needs the database');
    return platformDb;
  };
  const answer = (row, limit, windowMs) => {
    const hits = row ? Number(row.hits) : 0;
    const left = row ? Math.max(0, Number(row.left_ms)) : 0;
    return { allowed: hits <= limit, hits, retryAfterMs: hits > limit ? Math.min(windowMs, Math.ceil(left)) : 0 };
  };

  return {
    async hit(scope, subject, { limit, windowMs }) {
      const [row] = await need().query(
        `INSERT INTO rate_limit_hits AS r (key, window_start, hits) VALUES ($1, now(), 1)
         ON CONFLICT (key) DO UPDATE SET
           hits = CASE WHEN r.window_start <= now() - make_interval(secs => $2::float / 1000) THEN 1 ELSE r.hits + 1 END,
           window_start = CASE WHEN r.window_start <= now() - make_interval(secs => $2::float / 1000) THEN now() ELSE r.window_start END
         RETURNING hits, extract(epoch FROM (window_start + make_interval(secs => $2::float / 1000) - now())) * 1000 AS left_ms`,
        [keyOf(scope, subject), windowMs],
      );
      return answer(row, limit, windowMs);
    },
    async peek(scope, subject, { limit, windowMs }) {
      const [row] = await need().query(
        `SELECT hits, extract(epoch FROM (window_start + make_interval(secs => $2::float / 1000) - now())) * 1000 AS left_ms
         FROM rate_limit_hits WHERE key = $1 AND window_start > now() - make_interval(secs => $2::float / 1000)`,
        [keyOf(scope, subject), windowMs],
      );
      return row ? answer({ ...row, hits: Number(row.hits) + 1 }, limit, windowMs) : { allowed: true, hits: 0, retryAfterMs: 0 };
    },
    async reset(scope, subject) {
      await need().query('DELETE FROM rate_limit_hits WHERE key = $1', [keyOf(scope, subject)]);
    },
    async purge(olderThanMs = 2 * 86_400_000) {
      await need().query('DELETE FROM rate_limit_hits WHERE window_start < now() - make_interval(secs => $1::float / 1000)', [olderThanMs]);
    },
  };
}
