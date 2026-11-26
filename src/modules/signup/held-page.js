import path from 'node:path';

/** Where a held sign-up place is shown that it is waiting (B-AUTH-4). On the sign-in host only. */
export const WAITING_PATH = '/admin/waiting';
const SIGNUP_PATH = '/admin/signup';
const HEADERS = Object.freeze({ 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });

const waitingHtml = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Waiting for approval</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.25rem;line-height:1.5;color:#1f2933}h1{font-size:1.5rem}</style>
</head><body><main>
<h1>Your sign-up is waiting for approval</h1>
<p>Sign-up isn’t open right now, so your business hasn’t been made yet. Nothing is lost: once it opens, sign in again with the same number and you can finish setting up.</p>
</main></body></html>`;

/**
 * A session in a held sign-up place (auth-2, PRD 5.20) never gets the console shell for a business page (user decision
 * 2026-11-26, B-AUTH-4). While sign-up is closed every page answers with a redirect to the "waiting for approval" page,
 * which holds no data; while it is open (public or by invite) every page goes to the console's sign-up screen, the one
 * page such a session may use, to finish. The console's own files (scripts, styles, icons) and the API are left to
 * the routes after this; the API refuses every business route with 403 signup.pending.
 * `held()` says whether this request's session is in a held place; `mode()` reads signup_settings.mode.
 */
export function heldPages({ held, mode }) {
  return async (req, res, next) => {
    try {
      if (!held() || !['GET', 'HEAD'].includes(req.method) || req.path.startsWith('/api/') || path.extname(req.path)) return next();
      const open = (await mode()) !== 'closed';
      if (open) return req.path === SIGNUP_PATH ? next() : res.redirect(303, SIGNUP_PATH);
      if (req.path !== WAITING_PATH) return res.redirect(303, WAITING_PATH);
      return res.status(200).set(HEADERS).type('html').send(waitingHtml());
    } catch (err) {
      return next(err);
    }
  };
}
