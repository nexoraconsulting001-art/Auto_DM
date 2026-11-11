import { LEAD_SURFACES } from '../../contracts/buyer-pages.js';
import { section } from '../../views/buyer/index.js';
import { html, raw } from '../../views/html.js';
import { cleanTag, fieldsFor, safeBack } from './rules.js';

/**
 * The lead form as buyer pages show it (PRD 8.15), in the seller's brand only. It asks for a first name and only the contact
 * the consent wording covers; the consent box is never ticked for the shopper, on first show or after an error. A field that
 * people never see catches scripts that fill everything in (no CAPTCHA).
 *
 * Other buyer pages place it with leadFormFor(ctx, req, { surface, pageSlug, pageOverride, back }), which answers '' when the
 * business has no form there.
 */
export const FEATURE = 'lead_form';
/** The hidden field no person fills in. Named like a real one so a script that fills every field fills it. */
export const TRAP_FIELD = 'company_website';

// Static: nothing a seller or shopper types reaches this stylesheet.
const FORM_CSS = [
  '.form .trap{position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden}',
  '.form .agree{flex-direction:row;align-items:flex-start;gap:10px;font-weight:500;line-height:1.4}',
  '.form .agree input{flex:none;width:22px;height:22px;margin:1px 0 0;accent-color:var(--primary)}',
  '.form .err{margin:0;font-size:13px;font-weight:700;color:var(--ink);border-left:3px solid var(--accent);padding-left:8px}',
  '.form .hint{margin:0;font-size:13px;color:var(--muted)}',
  '.form .offer{margin:0;font-weight:700}',
  '.form button{border:0}',
  '.hint{font-size:13px;color:var(--muted)}',
  '.notice p{margin:0}.notice form{margin:0}',
  '.notice .form{text-align:left;align-self:stretch}',
  '.notice .btn{border:0;align-self:center}',
].join('');

export const formStyles = () => html`<style>${raw(FORM_CSS)}</style>`;

const error = (errors, field, id) => (errors[field] ? html`<p class="err" id="${id}" role="alert">${errors[field]}</p>` : '');

/**
 * The form itself. `consent` is the wording's row ({ version, body, channels }); `hidden` says where the form sits
 * ({ surface, ref, back, utmCampaign, utmMedium }); `values` and `errors` come back from a refused send.
 */
export function leadFormView({ consent, offerLine = '', hidden = {}, values = {}, errors = {}, csrf = '', idPrefix = 'lead' }) {
  const fields = fieldsFor(consent.channels);
  const both = fields.phone && fields.email;
  const id = (name) => `${idPrefix}-${name}`;
  const describedBy = (name) => (errors[name] ? raw(` aria-invalid="true" aria-describedby="${id(`${name}-err`)}"`) : '');
  const failed = Object.keys(errors).length > 0;
  return html`<form class="form" method="post" action="/lead" id="${id('form')}">
${offerLine ? html`<p class="offer">${offerLine}</p>` : ''}
${failed && errors.form ? html`<p class="err" role="alert">${errors.form}</p>` : ''}
<label for="${id('name')}">First name
<input type="text" id="${id('name')}" name="firstName" value="${values.firstName ?? ''}" maxlength="60" autocomplete="given-name" required${describedBy('firstName')}></label>
${error(errors, 'firstName', id('firstName-err'))}
${fields.phone ? html`<label for="${id('phone')}">Phone number${both ? ' (or email below)' : ''}
<input type="tel" id="${id('phone')}" name="phone" value="${values.phone ?? ''}" maxlength="40" autocomplete="tel" inputmode="tel"${both ? '' : raw(' required')}${describedBy('phone')}></label>
${error(errors, 'phone', id('phone-err'))}` : ''}
${fields.email ? html`<label for="${id('email')}">Email
<input type="email" id="${id('email')}" name="email" value="${values.email ?? ''}" maxlength="254" autocomplete="email"${both ? '' : raw(' required')}${describedBy('email')}></label>
${error(errors, 'email', id('email-err'))}` : ''}
${error(errors, 'contact', id('contact-err'))}
<div class="trap" aria-hidden="true"><label for="${id('trap')}">Leave this empty
<input type="text" id="${id('trap')}" name="${TRAP_FIELD}" value="" tabindex="-1" autocomplete="off"></label></div>
<label class="agree" for="${id('consent')}"><input type="checkbox" id="${id('consent')}" name="consent" value="yes" required${describedBy('consent')}><span>${consent.body}</span></label>
${error(errors, 'consent', id('consent-err'))}
<input type="hidden" name="cv" value="${Number(consent.version)}">
<input type="hidden" name="surface" value="${LEAD_SURFACES.includes(hidden.surface) ? hidden.surface : 'landing'}">
<input type="hidden" name="ref" value="${hidden.ref ?? ''}">
<input type="hidden" name="back" value="${safeBack(hidden.back)}">
<input type="hidden" name="utm_campaign" value="${cleanTag(hidden.utmCampaign)}">
<input type="hidden" name="utm_medium" value="${cleanTag(hidden.utmMedium, 40)}">
${csrf ? html`<input type="hidden" name="_csrf" value="${csrf}">` : ''}
<button class="btn" type="submit">Send</button>
<p class="hint">Used only to contact you as you agreed. You can withdraw at any time.</p>
</form>`;
}

/** The form as a section of a page, with its styles. */
export function leadFormSection({ theme, title = 'Stay in touch', ...form }) {
  return html`${formStyles()}
${section({ theme, id: `${form.idPrefix ?? 'lead'}-h`, kicker: 'Offers', title, body: leadFormView(form) })}`;
}

/**
 * Whether this business shows the form on a surface, and with what: { form, consent } or null. `pageOverride` is a landing
 * page's own choice (reels.lead_form): true or false wins over the surface's setting, null follows it.
 */
export async function leadFormState(repos, { surface, pageOverride = null }) {
  if (!LEAD_SURFACES.includes(surface)) return null;
  if (!(await repos.entitlements.can(FEATURE))) return null;
  const form = await repos.leads.form(surface);
  const on = pageOverride === true || (pageOverride !== false && form.enabled);
  if (!on) return null;
  const consent = await repos.leads.currentConsent((await repos.settings.getAll()).store_name);
  return { form, consent };
}

/**
 * The form's section for a buyer page, or '' when the business has none there. `pageSlug` is the landing page it sits on (its
 * leads are counted to that page); `back` is where the thank-you page's link returns to.
 */
export async function leadFormFor({ repos }, req, { theme, surface, pageSlug = '', pageOverride = null, back = '', title } = {}) {
  const state = await leadFormState(repos, { surface, pageOverride });
  if (!state) return '';
  return leadFormSection({
    theme,
    title,
    consent: state.consent,
    offerLine: state.form.offer_line,
    hidden: { surface, ref: pageSlug, back, utmCampaign: req?.query?.utm_campaign, utmMedium: req?.query?.utm_medium },
    csrf: req?.csrf ?? '',
  });
}
