import crypto from 'node:crypto';
import { tenantId } from '../../tenancy.js';

/**
 * The reel link a browser opened, kept on the server (PRD 9.5, S-17). Opening /r/<slug> records that page against a random
 * session id in the store's own cookie; checkout reads the record back to name the order's source reel. The body of the order
 * is never believed about it. No personal data is kept, and every row belongs to one business.
 */
export const OPENED_COOKIE = '_bso';
export const OPENED_DAYS = 30;
const IS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The session id this request carries, or null. */
export function openedSessionFrom(req) {
  for (const part of String(req?.headers?.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === OPENED_COOKIE) {
      const value = rest.join('=');
      return IS_UUID.test(value) ? value.toLowerCase() : null;
    }
  }
  return null;
}

/** Records that this browser opened this page (a reels row id of this business), minting the session cookie when it has none. */
export async function recordPageOpen(q, req, res, pageId) {
  const session = openedSessionFrom(req) ?? crypto.randomUUID();
  await q.query(
    `INSERT INTO store_page_opens (tenant_id, session_id, page_id) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, session_id) DO UPDATE SET page_id = EXCLUDED.page_id, opened_at = now()`,
    [tenantId(), session, pageId],
  );
  res.cookie(OPENED_COOKIE, session, { path: '/', maxAge: OPENED_DAYS * 86_400_000, httpOnly: true, sameSite: 'lax', secure: req.secure });
}

/** The page this browser last opened within the window, as { id, ig_media_id }, or null (the source is then unknown, never guessed). */
export async function openedPageOf(q, req) {
  const session = openedSessionFrom(req);
  if (!session) return null;
  const [row] = await q.query(
    `SELECT r.id, r.ig_media_id FROM store_page_opens o JOIN reels r ON r.tenant_id = o.tenant_id AND r.id = o.page_id
     WHERE o.tenant_id = $1 AND o.session_id = $2 AND o.opened_at > now() - make_interval(days => $3)`,
    [tenantId(), session, OPENED_DAYS],
  );
  return row ?? null;
}
