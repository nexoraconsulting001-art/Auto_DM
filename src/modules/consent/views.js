import { buyerPage } from '../../views/buyer/index.js';
import { esc, html, raw } from '../../views/html.js';

/**
 * The consent module's buyer pages (PRD 9.18): the four policy pages, the unsubscribe page, and the cookie banner. All in
 * the seller's brand: the platform is never named (the processor is not named on a business's notice: 9.18, to confirm).
 */
export const POLICY_TITLES = Object.freeze({ privacy: 'Privacy policy', terms: 'Terms of sale', refund: 'Refunds and returns', shipping: 'Shipping' });
const CHANNEL_TEXT = Object.freeze({ whatsapp: 'on WhatsApp', email: 'by email' });
const PURPOSE_TEXT = Object.freeze({ marketing: 'offers and news', order_updates: 'order updates' });

const STYLE = raw(`<style>
.policy{display:flex;flex-direction:column;gap:16px;padding:8px 20px 40px;max-width:720px;margin:0 auto;width:100%}
.policy h1{font-family:var(--display);font-weight:var(--display-weight);font-size:30px;margin:0}
.policy h2{font-family:var(--display);font-weight:var(--display-weight);font-size:20px;margin:8px 0 0}
.policy p,.policy li{margin:0}
.panel{display:flex;flex-direction:column;gap:8px;padding:16px;background:var(--card);border:1px solid var(--line);border-radius:12px}
.pair{display:flex;gap:10px;flex-wrap:wrap}
.pair .btn{flex:1;min-width:140px}
</style>`);

const paragraphs = (text) => String(text).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => html`<p style="white-space:pre-line">${p}</p>`);

function page(layout, { title, main }) {
  return buyerPage({
    theme: layout.theme,
    business: layout.business,
    meta: { title: `${title} · ${layout.business.name || 'Shop'}`, description: title, indexable: true },
    main: html`${STYLE}${main}`,
    footer: { links: Object.entries(POLICY_TITLES).map(([kind, label]) => ({ href: `/policies/${kind}`, label })) },
  });
}

/** What a business's privacy page says until the seller writes their own: naming the business, never the platform. */
export function defaultPrivacy(store) {
  return [
    `${store} collects your name, phone number, email address and delivery address when you sign in or place an order, and uses them to take, deliver and support your order. This is the only use made of them unless you say yes to more.`,
    `With your separate permission, ${store} may send you order updates and offers on WhatsApp or by email, and may use cookies to measure visits and the ads that brought you here. Each is a separate choice, and each is off until you turn it on.`,
    `Your details are shared only with the companies that deliver your order and take your payment, and only what they need for that.`,
    `You can see the details ${store} holds about you, correct them, ask for them to be deleted, or take back any permission, from your account page or by contacting us below. Taking back a permission is as easy as giving it, and stops the messages that follow. When you ask for deletion, your personal details are erased; the tax records of past orders are kept, as the law requires, with your details removed.`,
  ].join('\n\n');
}

const DEFAULT_BODY = Object.freeze({
  terms: (store) => `These are the terms on which ${store} sells through this website. Prices include GST unless the product says otherwise. An order is confirmed once it is paid, or once a cash-on-delivery order's phone number is verified.`,
  refund: (store) => `${store} will tell you here how returns and refunds work. Until then, please contact the store about any problem with your order.`,
  shipping: (store) => `${store} ships across India. The delivery charge and the expected time are shown at checkout, before you pay.`,
});

/** One policy page (S-61), readable signed out on the business's own domain; the privacy page shows the grievance contact (S-62). */
export function policyPage(layout, { kind, body, grievance, cookie = null, shopperCsrf = '', sellerCsrf = '' }) {
  const store = layout.business.name || 'This store';
  const text = body?.trim() || (kind === 'privacy' ? defaultPrivacy(store) : DEFAULT_BODY[kind](store));
  const contact = [grievance.name, grievance.email ? html`<a href="mailto:${grievance.email}">${grievance.email}</a>` : '', grievance.phone, grievance.address].filter(Boolean);
  const cookieScript = cookie ? raw(`<script>(function(){var t=document.getElementById('cc-tokens');document.querySelectorAll('[data-choice]').forEach(function(b){b.addEventListener('click',function(){var h={'content-type':'application/json'};if(t.dataset.shopperCsrf)h['x-shopper-csrf']=t.dataset.shopperCsrf;if(t.dataset.csrf)h['x-csrf-token']=t.dataset.csrf;fetch('/api/store/consent?source=banner',{method:'POST',credentials:'same-origin',headers:h,body:JSON.stringify({choices:{noticeVersion:${Number(cookie.noticeVersion) || 1},analyticsAds:b.dataset.choice==='1'}})}).then(function(){location.reload();});});});})();</script>`) : '';
  return page(layout, {
    title: POLICY_TITLES[kind],
    main: html`<section class="policy">
<h1>${POLICY_TITLES[kind]}</h1>
${paragraphs(text)}
${kind === 'privacy' ? html`<div class="panel"><h2>Grievance contact</h2>
${contact.length ? contact.map((line) => html`<p>${line}</p>`) : html`<p>Contact ${store} through the details on this website.</p>`}
<p>Write to this contact with any question or complaint about your personal data.</p></div>` : ''}
${cookie ? html`<div class="panel" id="cookie-choice"><div id="cc-tokens" hidden data-shopper-csrf="${shopperCsrf}" data-csrf="${sellerCsrf}"></div><h2>Cookies on this website</h2>
<p>${cookie.answered ? (cookie.granted ? 'You allowed cookies that measure visits and ads.' : 'You turned off cookies that measure visits and ads.') : 'You haven’t chosen yet.'}</p>
<div class="pair"><button class="btn" type="button" data-choice="1">Allow</button><button class="btn" type="button" data-choice="0">Don’t allow</button></div></div>${cookieScript}` : ''}
</section>`,
  });
}

/** The page a message's unsubscribe link opens (one tap, no sign-in). Opening it changes nothing: the button does. */
export function unsubscribePage(layout, { state, purpose = 'marketing', channel = 'whatsapp', token = '', shopperCsrf = '', sellerCsrf = '' }) {
  const store = layout.business.name || 'this store';
  const what = `${PURPOSE_TEXT[purpose] ?? 'messages'} ${CHANNEL_TEXT[channel] ?? ''}`.trim();
  const main = state === 'ask'
    ? html`<section class="notice"><h1>Stop ${what}?</h1><p>You won’t get ${what} from ${store} any more. ${purpose === 'marketing' ? 'Order updates are a separate choice and carry on.' : ''}</p>
<form method="post" action="/unsubscribe/${encodeURIComponent(token)}">${shopperCsrf ? html`<input type="hidden" name="_shopper_csrf" value="${shopperCsrf}">` : ''}${sellerCsrf ? html`<input type="hidden" name="_csrf" value="${sellerCsrf}">` : ''}<button class="btn" type="submit">Stop ${what}</button></form></section>`
    : state === 'done'
      ? html`<section class="notice"><h1>Done</h1><p>You won’t get ${what} from ${store} any more. You can turn it back on from your account at any time.</p><a class="btn" href="/">Back to the store</a></section>`
      : html`<section class="notice"><h1>This link doesn’t work</h1><p>It may be incomplete or out of date. You can change which messages you get from your account.</p><a class="btn" href="/account">Your account</a></section>`;
  return page(layout, { title: 'Messages', main });
}

/**
 * The cookie banner (7.14, 9.18): the seller's name and colours, two buttons of the same size and style so declining is
 * as easy as accepting, and nothing loads until one is pressed. Its answer is the browser's (the visitor id).
 */
export function bannerHtml({ store, noticeVersion, shopperCsrf = '', sellerCsrf = '' }) {
  const button = 'flex:1;min-height:44px;padding:0 16px;border-radius:var(--r-btn,8px);border:1.5px solid var(--primary,#16152B);background:var(--primary,#16152B);color:var(--on-primary,#FFFFFF);font:inherit;font-weight:700;cursor:pointer';
  return `<div id="cookie-banner" role="region" aria-label="Cookie choice" data-shopper-csrf="${esc(shopperCsrf)}" data-csrf="${esc(sellerCsrf)}" style="position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483000;max-width:560px;margin:0 auto;background:var(--card,#FFFFFF);color:var(--ink,#16152B);border:1px solid var(--line,#D9D6CC);border-radius:12px;padding:14px 16px;box-shadow:0 8px 28px rgba(0,0,0,.18);font:14px/1.45 var(--body,system-ui,sans-serif)">`
    + `<p style="margin:0 0 6px">${esc(store)} would like to use cookies to measure visits and the ads that brought you here. Nothing is measured unless you allow it. <a href="/policies/privacy" style="color:inherit">Privacy policy</a></p>`
    + `<p lang="hi" style="margin:0 0 10px">${esc(store)} विज़िट और विज्ञापनों को मापने के लिए कुकीज़ का उपयोग करना चाहता है। आपकी अनुमति के बिना कुछ नहीं मापा जाता।</p>`
    + `<div style="display:flex;gap:10px;flex-wrap:wrap"><button type="button" data-cookie="1" style="${button}">Allow</button><button type="button" data-cookie="0" style="${button}">Don’t allow</button></div></div>`
    + `<script>(function(){var b=document.getElementById('cookie-banner');if(!b)return;b.querySelectorAll('[data-cookie]').forEach(function(x){x.addEventListener('click',function(){var yes=x.getAttribute('data-cookie')==='1';var h={'content-type':'application/json'};if(b.dataset.shopperCsrf)h['x-shopper-csrf']=b.dataset.shopperCsrf;if(b.dataset.csrf)h['x-csrf-token']=b.dataset.csrf;`
    + `fetch('/api/store/consent?source=banner',{method:'POST',credentials:'same-origin',headers:h,body:JSON.stringify({choices:{noticeVersion:${Number(noticeVersion) || 1},analyticsAds:yes}})}).then(function(r){if(!r.ok)return;b.remove();if(yes)location.reload();});});});})();</script>`;
}

