import crypto from 'node:crypto';
import { BUYER_ROUTES, LEAD_SURFACES } from '../../contracts/buyer-pages.js';
import { MANAGERS, isAllowed } from '../../contracts/api/access.js';
import { log, reportError } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { buyerPage, loadBuyerLayout, notFoundPage, safeHref, sendBuyerPage } from '../../views/buyer/index.js';
import { html } from '../../views/html.js';
import { writeAudit } from '../audit/index.js';
import { toDownload } from './api.js';
import { FILE_TYPES, LEAD_FILE_PATH, ownsKey } from './files.js';
import { FEATURE, TRAP_FIELD, formStyles, leadFormState, leadFormView } from './form.js';
import { checkLead, cleanTag, optOutToken, readOptOutToken, safeBack } from './rules.js';

/**
 * The lead form's own addresses (PRD 8.15), all in the seller's brand: the form on a page of its own (GET /lead, which a DM can
 * link to), where it posts, the thank-you page, and the door a shopper uses to withdraw consent or have their details erased
 * (9.18). Without the feature every one of them is the branded 404 (K-59), except the door: a shopper can always leave.
 *
 * Spam: the hidden field, a limit per address kept only in the cache for ten minutes (as a keyed hash, never stored with a
 * lead), and the repo's ceiling per business. No CAPTCHA. Nothing a shopper types is logged.
 */
const SLUG = /^[a-z0-9-]{1,80}$/;
const WINDOW_SECONDS = 600;
const DEFAULT_PER_ADDRESS = 20;
const OPT_OUT_PATH = BUYER_ROUTES.leadOptOut.path;

const one = (value) => (typeof value === 'string' ? value : '');

export function registerLeadPages(app, ctx) {
  const { db, repos, config, platform } = ctx;
  const secret = config.sessionSecret;

  const layout = () => loadBuyerLayout(repos);

  async function notFound(res, message = 'This page isn’t available.') {
    const { theme, business } = await layout();
    return sendBuyerPage(res, notFoundPage({ theme, business, message }), { status: 404 });
  }

  /** A short page with a heading, a line or two and what to do next. `body` may be a function of the business. */
  async function notice(res, { status = 200, title, body }) {
    const { theme, business } = await layout();
    res.set('Referrer-Policy', 'no-referrer');
    const view = buyerPage({
      theme,
      business,
      meta: { title: `${title} · ${business.name}`, description: title, indexable: false },
      main: html`${formStyles()}<section class="notice"><h1>${title}</h1>${typeof body === 'function' ? body(business) : body}</section>`,
    });
    return sendBuyerPage(res, view, { status, page: { kind: 'other', ref: 'lead' } });
  }

  async function landingPage(slug) {
    if (!SLUG.test(slug)) return null;
    const [row] = await db.query('SELECT id, slug, lead_form FROM reels WHERE tenant_id = $1 AND slug = $2 AND active', [tenantId(), slug]);
    return row ?? null;
  }

  /** Where a send came from: the surface, the page it sat on, and whether this business shows a form there (`state`). */
  async function placeOf({ surface, ref }) {
    const place = { surface: LEAD_SURFACES.includes(surface) ? surface : 'landing', ref: '', pageId: null, state: null };
    let override = null;
    if (place.surface === 'landing' && ref) {
      const page = await landingPage(ref);
      if (page) Object.assign(place, { ref: page.slug, pageId: page.id });
      override = page?.lead_form ?? null;
    } else if (place.surface === 'creator' && SLUG.test(ref)) {
      const creator = await repos.creatorPages?.get();
      if (creator?.slug === ref) place.ref = ref;
    }
    place.state = await leadFormState(repos, { surface: place.surface, pageOverride: override });
    return place;
  }

  async function formPage(res, { status = 200, place, consent, values = {}, errors = {}, back = '', utm = {}, csrf = '' }) {
    const { theme, business } = await layout();
    const backHref = safeHref(safeBack(back));
    const view = buyerPage({
      theme,
      business,
      meta: { title: `Stay in touch · ${business.name}`, description: `Hear from ${business.name}`, indexable: false },
      main: html`${formStyles()}<section class="notice"><h1>Stay in touch</h1>
${leadFormView({ consent, offerLine: place.state.form.offer_line, hidden: { surface: place.surface, ref: place.ref, back, utmCampaign: utm.campaign, utmMedium: utm.medium }, values, errors, csrf })}
${backHref ? html`<a class="btn-quiet" href="${backHref}">Back</a>` : ''}</section>`,
    });
    return sendBuyerPage(res, view, { status, page: { kind: 'other', ref: 'lead' } });
  }

  const thanks = (res, { back = '', token = '' } = {}) => notice(res, {
    title: 'Thank you',
    body: (business) => html`<p>${business.name} has your details and will be in touch.</p>
<a class="btn" href="${safeHref(safeBack(back)) || '/'}">Back</a>
${token ? html`<p class="hint">Changed your mind? <a href="${OPT_OUT_PATH}?t=${token}">Withdraw or delete your details</a>.</p>` : ''}`,
  });

  /** True when this address has sent the form too often in the last ten minutes. The address is kept only as a keyed hash, only in the cache. */
  async function overLimit(req) {
    const max = Number.isInteger(config.leadsPerAddress) ? config.leadsPerAddress : DEFAULT_PER_ADDRESS;
    const who = crypto.createHmac('sha256', String(secret)).update(`lead-address:${String(req.ip ?? '')}`).digest('base64url').slice(0, 32);
    const key = `lead-sends:${tenantId()}:${who}`;
    const now = Date.now();
    const seen = (await platform.cache.get(key)) ?? { n: 0, reset: now + WINDOW_SECONDS * 1000 };
    if (seen.reset <= now) Object.assign(seen, { n: 0, reset: now + WINDOW_SECONDS * 1000 });
    if (seen.n >= max) return true;
    seen.n += 1;
    await platform.cache.set(key, seen, Math.max(1, Math.ceil((seen.reset - now) / 1000)));
    return false;
  }

  const tooMany = (res) => notice(res, { status: 429, title: 'Please try again later', body: html`<p>We’ve had a lot of forms from this connection. Please try again in a few minutes.</p>` });

  // ---- the form on its own page -----------------------------------------------------------------------------------------

  app.get(BUYER_ROUTES.leadSubmit.path, async (req, res, next) => {
    try {
      const place = await placeOf({ surface: 'landing', ref: one(req.query.r).toLowerCase() });
      if (!place.state) return notFound(res);
      return formPage(res, {
        place,
        consent: place.state.consent,
        back: place.ref ? `/r/${place.ref}` : '',
        utm: { campaign: one(req.query.utm_campaign), medium: one(req.query.utm_medium) },
        csrf: req.csrf ?? '',
      });
    } catch (err) {
      return next(err);
    }
  });

  app.post(BUYER_ROUTES.leadSubmit.path, async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      if (!(await repos.entitlements.can(FEATURE))) return notFound(res);
      const place = await placeOf({ surface: one(body.surface), ref: one(body.ref).toLowerCase() });
      if (!place.state) return notFound(res);
      const back = safeBack(one(body.back));

      // A script that fills every field fills the one no person sees. It is told what a person is told, and nothing is kept.
      if (Array.isArray(body[TRAP_FIELD]) || one(body[TRAP_FIELD]).trim() !== '') {
        log.info('leads.trap_filled', { surface: place.surface });
        return thanks(res, { back });
      }
      if (await overLimit(req)) return tooMany(res);

      // The wording the shopper had in front of them, when it is one of this business's; else today's.
      const shown = /^[1-9]\d{0,8}$/.test(one(body.cv)) ? await repos.leads.consentVersion(Number(body.cv)) : null;
      const consent = shown ?? place.state.consent;
      const utm = { campaign: cleanTag(one(body.utm_campaign)), medium: cleanTag(one(body.utm_medium), 40).toLowerCase() };
      const { lead, errors, typed } = checkLead({ firstName: one(body.firstName), phone: one(body.phone), email: one(body.email), consent: body.consent }, consent.channels);
      if (Object.keys(errors).length) return formPage(res, { status: 422, place, consent, values: typed, errors, back, utm, csrf: req.csrf ?? '' });

      const source = place.surface === 'landing' && utm.medium === 'bio' ? 'bio' : place.surface;
      const saved = await repos.leads.capture({ lead, source, sourceRef: place.ref, utmCampaign: utm.campaign, pageId: place.pageId, consentTextId: consent.id });
      if (saved.refused) return tooMany(res);

      log.info('leads.captured', { leadId: saved.id, source, created: saved.created });
      if (saved.created) {
        // One alert an hour at most, in our own words to the seller and with nothing about the shopper in it.
        repos.alerts.raise({
          kind: 'lead.new',
          severity: 'info',
          message: 'You have new leads. Open Leads in your Bhava admin to follow up.',
          target: 'leads',
          dedupeKey: `lead.new:${new Date().toISOString().slice(0, 13)}`,
        }).catch((err) => reportError(err, { msg: 'leads.alert_failed' }));
      }
      return thanks(res, { back, token: optOutToken(secret, tenantId(), saved.id) });
    } catch (err) {
      return next(err);
    }
  });

  app.get(BUYER_ROUTES.leadThanks.path, async (req, res, next) => {
    try {
      if (!(await repos.entitlements.can(FEATURE))) return notFound(res);
      return thanks(res, { back: one(req.query.back) });
    } catch (err) {
      return next(err);
    }
  });

  // ---- the shopper's door: withdraw consent, or have the details erased (9.18) ------------------------------------------

  const badLink = (res) => notFound(res, 'This link doesn’t work any more.');

  // Opening the link changes nothing: a mail or chat app that follows links can't withdraw or erase for anyone.
  app.get(OPT_OUT_PATH, async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const token = one(req.query.t);
      if (!readOptOutToken(secret, tenantId(), token)) return badLink(res);
      const csrf = req.csrf ? html`<input type="hidden" name="_csrf" value="${req.csrf}">` : '';
      const choice = (action, label) => html`<form method="post" action="${OPT_OUT_PATH}"><input type="hidden" name="t" value="${token}"><input type="hidden" name="action" value="${action}">${csrf}<button class="btn" type="submit">${label}</button></form>`;
      return notice(res, {
        title: 'Your details',
        body: (business) => html`<p>Tell ${business.name} what to do with the details you sent.</p>
${choice('withdraw', 'Stop contacting me')}
${choice('delete', 'Delete my details')}`,
      });
    } catch (err) {
      return next(err);
    }
  });

  app.post(OPT_OUT_PATH, async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const leadId = readOptOutToken(secret, tenantId(), one(body.t));
      if (!leadId) return badLink(res);
      const erase = one(body.action) === 'delete';
      if (erase) {
        if (await repos.leads.remove(leadId)) await writeAudit(db, { actor: 'shopper', action: 'lead.deleted', target: `lead:${leadId}`, details: { by: 'shopper' } });
      } else {
        const changed = await repos.leads.revoke(leadId);
        if (changed?.length) await writeAudit(db, { actor: 'shopper', action: 'lead.consent_withdrawn', target: `lead:${leadId}`, details: { channels: changed, by: 'shopper' } });
      }
      log.info('leads.shopper_choice', { leadId, erase });
      // The same answer whether or not the lead was still there: the link tells nobody what is held.
      return notice(res, {
        title: 'Done',
        body: (business) => html`<p>${erase ? `${business.name} no longer holds the details you sent.` : `${business.name} won’t contact you about offers any more.`}</p><a class="btn" href="/">Go to the home page</a>`,
      });
    } catch (err) {
      return next(err);
    }
  });

  // ---- the seller's file --------------------------------------------------------------------------------------------------

  app.get(LEAD_FILE_PATH, async (req, res, next) => {
    try {
      res.set('Cache-Control', 'private, no-store');
      const refuse = (status, message) => res.status(status).type('text').send(message);
      if (!req.user) return refuse(401, 'Sign in to your admin, then open this link again.');
      if (!isAllowed(req.user, MANAGERS)) return refuse(403, 'You don’t have access to this file.');
      const row = /^[1-9]\d{0,8}$/.test(req.params.id) ? await repos.leads.getDownload(Number(req.params.id)) : null;
      if (!row) return refuse(404, 'We couldn’t find that file.');
      const view = toDownload(row);
      if (view.status === 'expired') {
        if (row.status === 'ready') await dropFile(ctx, row);
        return refuse(410, 'This file has expired. Make a new one from the Leads screen.');
      }
      const buffer = view.status === 'ready' && ownsKey(row.file_key) ? await platform.storage.get(row.file_key) : null;
      if (!buffer) return refuse(404, 'We couldn’t find that file.');
      await writeAudit(db, { actor: `user:${req.user.id}`, action: 'leads.file_opened', target: `lead_download:${row.id}`, details: { format: row.format, rows: row.row_count } });
      res.set('Content-Type', FILE_TYPES[row.format]);
      res.set('Content-Disposition', `attachment; filename="leads-${row.id}.${row.format}"`);
      return res.send(buffer);
    } catch (err) {
      return next(err);
    }
  });
}

/** Removes an expired download's file and marks its row. Runs as the row's business. */
export async function dropFile({ repos, platform }, row) {
  if (ownsKey(row.file_key)) await platform.storage.remove(row.file_key);
  await repos.leads.expireDownload(row.id);
}
