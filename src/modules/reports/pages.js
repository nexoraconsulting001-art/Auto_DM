import { ReportUnsubscribe } from '../../contracts/api/index.js';
import { readsAnalytics } from './business.js';
import { parseFileRef } from './files.js';
import { escapeHtml } from './render.js';

/**
 * The two addresses outside /api/v1: report files (REPORT_FILE_PATH), which are not JSON, and the page an unsubscribe link opens. Both are seller
 * pages, so they are Bhava's, and neither is a buyer page, so no tracking script or tag is added to them.
 */
export const UNSUBSCRIBE_PATH = '/reporting/unsubscribe';

function page(title, body) {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title><meta name="robots" content="noindex"></head>`,
    '<body style="margin:0;background:#F6F5F1;color:#16152B;font-family:Figtree,Arial,sans-serif;line-height:1.5">',
    '<main style="max-width:480px;margin:0 auto;padding:40px 16px">',
    '<p style="font-family:Unbounded,Arial,sans-serif;font-weight:700;font-size:20px;color:#3B2FC9;margin:0 0 24px">Bhava</p>',
    body,
    '</main></body></html>',
  ].join('');
}

const button = 'display:inline-block;padding:12px 20px;border:0;border-radius:8px;background:#3B2FC9;color:#FFFFFF;font:inherit;font-weight:600;cursor:pointer;text-decoration:none';
const WHICH = Object.freeze({ weekly: 'the weekly report', monthly: 'the monthly report', all: 'Bhava report emails' });

const STATUS_TEXT = Object.freeze({
  401: 'Sign in to your Bhava admin, then open this link again.',
  403: 'You don’t have access to this file.',
  404: 'We couldn’t find that file.',
  410: 'This file has expired. Make a new one from the Reports screen in your Bhava admin.',
});

export function registerPages(app, { reports, fileFor }) {
  app.get('/report-files/:ref', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'private, no-store');
      const refuse = (status, message) => res.status(status).type('html').send(page('Bhava', `<p>${escapeHtml(message ?? STATUS_TEXT[status])}</p>${status === 401 ? `<p><a href="/admin" style="${button}">Sign in</a></p>` : ''}`));
      if (!req.user) return refuse(401);
      const ref = parseFileRef(req.params.ref);
      if (!ref) return refuse(404);
      if (!readsAnalytics(req.user)) return refuse(403);
      const found = await fileFor(ref, req.user);
      if (found.status !== 200) return refuse(found.status, found.message);
      res.set('Content-Type', found.type);
      res.set('Content-Disposition', `attachment; filename="${found.name}"`);
      return res.send(found.buffer);
    } catch (err) {
      return next(err);
    }
  });

  app.get(UNSUBSCRIBE_PATH, (req, res) => {
    const token = typeof req.query.token === 'string' && /^[\w-]{1,200}$/.test(req.query.token) ? req.query.token : '';
    const report = Object.hasOwn(WHICH, req.query.report) ? req.query.report : 'all';
    res.set('Cache-Control', 'no-store');
    if (!token) return res.status(400).type('html').send(page('Unsubscribe', '<p>This link isn’t complete. Use the link in the email again.</p>'));
    // One click: the button. Opening the link alone changes nothing, so a mail scanner that follows links can't unsubscribe anyone.
    const csrf = req.csrf ? `<input type="hidden" name="_csrf" value="${escapeHtml(req.csrf)}">` : '';
    return res.type('html').send(page('Unsubscribe', [
      `<h1 style="font-family:Unbounded,Arial,sans-serif;font-size:22px;margin:0 0 12px">Stop ${escapeHtml(WHICH[report])}?</h1>`,
      '<p style="margin:0 0 20px">You can turn it back on at any time in your Bhava admin, under Reports.</p>',
      `<form method="post" action="${UNSUBSCRIBE_PATH}">${csrf}<input type="hidden" name="token" value="${escapeHtml(token)}"><input type="hidden" name="report" value="${escapeHtml(report)}">`,
      `<button type="submit" style="${button}">Unsubscribe</button></form>`,
    ].join('')));
  });

  // The form above, and a mail app's own one-click unsubscribe (RFC 8058), which posts "List-Unsubscribe=One-Click" to the link itself.
  app.post(UNSUBSCRIBE_PATH, async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const parsed = ReportUnsubscribe.safeParse({ token: req.body?.token ?? req.query.token, report: req.body?.report ?? req.query.report ?? 'all' });
      if (!parsed.success) return res.status(400).type('html').send(page('Unsubscribe', '<p>This link isn’t complete. Use the link in the email again.</p>'));
      const { ok } = await reports().preferences.unsubscribe(parsed.data);
      return res.status(ok ? 200 : 404).type('html').send(page('Unsubscribe', ok
        ? `<h1 style="font-family:Unbounded,Arial,sans-serif;font-size:22px;margin:0 0 12px">Done</h1><p>You won’t get ${escapeHtml(WHICH[parsed.data.report])} any more.</p>`
        : '<p>This link doesn’t work any more. You can change which reports you get in your Bhava admin, under Reports.</p>'));
    } catch (err) {
      return next(err);
    }
  });
}
