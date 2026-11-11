import { formatRupees } from '../../contracts/catalog.js';
import { INDIAN_STATES } from '../../contracts/orders.js';
import { buyerPage, safeHref } from '../../views/buyer/index.js';
import { html, jsonScript, raw } from '../../views/html.js';
import { maskPhone } from './keys.js';

/**
 * The shopper's own pages (PRD 9.3, 9.4, 9.17, 9.22): sign-in, the account and its orders, and the shared-profile consent
 * screen. Every page is the shared buyer layout in the seller's brand. The one exception is sharedConsentPage, the only
 * buyer page that may name the platform (S-101), because the platform is the data fiduciary for that profile.
 *
 * Scripts are inline and small, and call this store's own JSON at /api/store with the session's CSRF token. There is no
 * SMS option anywhere (9.3).
 */
const STATUS_TEXT = Object.freeze({
  pending: 'Waiting for payment', new: 'Confirmed', packed: 'Packed', ready_to_ship: 'Ready to ship', shipped: 'Shipped', out_for_delivery: 'Out for delivery',
  delivered: 'Delivered', cancelled: 'Cancelled', rto_initiated: 'Returning to the store', rto_delivered: 'Returned to the store',
});
const CANCELLABLE = new Set(['pending', 'new', 'packed', 'ready_to_ship']);

const STYLE = raw(`<style>
.acct{display:flex;flex-direction:column;gap:20px;padding:8px 20px 40px;max-width:680px;margin:0 auto;width:100%}
.acct h1{font-family:var(--display);font-weight:var(--display-weight);font-size:30px;margin:0}
.acct h2{font-family:var(--display);font-weight:var(--display-weight);font-size:20px;margin:0}
.panel{display:flex;flex-direction:column;gap:10px;padding:16px;background:var(--card);border:1px solid var(--line);border-radius:12px}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.muted{color:var(--ink);opacity:.72;margin:0}
.list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.list li{padding:10px 0;border-top:1px solid var(--line)}
.list li:first-child{border-top:0}
.order-row{display:flex;justify-content:space-between;gap:12px;color:inherit;text-decoration:none}
.badge{display:inline-block;padding:2px 10px;border-radius:999px;background:var(--chip);font-size:13px;font-weight:600}
.err{color:var(--primary);font-weight:700;margin:0}
.ok{font-weight:700;margin:0}
.options{display:flex;flex-direction:column;gap:14px}
.wide{align-self:stretch;width:100%}
.form select{min-height:44px;padding:0 12px;border:1.5px solid var(--line-strong);border-radius:8px;background:var(--ground);color:var(--ink);font:inherit}
.form input[inputmode=numeric]{min-height:44px;padding:0 12px;border:1.5px solid var(--line-strong);border-radius:8px;background:var(--ground);color:var(--ink);font:inherit;letter-spacing:.3em}
.form input[type=password]{min-height:44px;padding:0 12px;border:1.5px solid var(--line-strong);border-radius:8px;background:var(--ground);color:var(--ink);font:inherit}
details summary{cursor:pointer;font-weight:600}
[hidden]{display:none!important}
</style>`);

const shownPhone = (phone) => (String(phone).startsWith('+91') ? `+91 ${maskPhone(phone)}` : maskPhone(phone));
const dateText = (value) => (value ? new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '');

/** The tokens a page's script sends: the shopper's, and the seller's when a seller is signed in on the same browser. */
const tokens = ({ shopperCsrf = '', sellerCsrf = '' }) => html`<div id="tokens" hidden data-shopper-csrf="${shopperCsrf}" data-csrf="${sellerCsrf}"></div>`;

// One helper every page's script shares: JSON to this store with both CSRF tokens, answering { ok, status, body }.
const CALL = `function call(method,url,body){var t=document.getElementById('tokens');var h={'content-type':'application/json'};if(t){if(t.dataset.shopperCsrf)h['x-shopper-csrf']=t.dataset.shopperCsrf;if(t.dataset.csrf)h['x-csrf-token']=t.dataset.csrf;}return fetch(url,{method:method,headers:h,credentials:'same-origin',body:body===undefined?undefined:JSON.stringify(body)}).then(function(r){return r.json().catch(function(){return {};}).then(function(b){return {ok:r.ok,status:r.status,body:b};});}).catch(function(){return {ok:false,status:0,body:{error:'We couldn’t reach the store. Check your connection and try again.'}};});}`;

function page(layout, { title, main, description = '' }) {
  return buyerPage({
    theme: layout.theme,
    business: layout.business,
    meta: { title: `${title} · ${layout.business.name || 'Shop'}`, description, indexable: false },
    main: html`${STYLE}${main}`,
  });
}

/** The store's consent notice (9.18), bilingual, naming the business. */
function noticeBlock(notice, storeName) {
  return html`<details class="panel"><summary>How ${storeName} uses your details</summary>
<p lang="en">${notice.bodyEn}</p>
<p lang="hi">${notice.bodyHi}</p>
</details>`;
}

/** A plain message page in the seller's brand, for a link that has expired or a step that could not finish. */
export function messagePage(layout, { title, message, action = { href: '/login', label: 'Back to sign in' }, status = 200 }) {
  void status;
  return page(layout, { title, main: html`<section class="notice"><h1>${title}</h1><p>${message}</p>${action ? html`<a class="btn" href="${safeHref(action.href) || '/'}">${action.label}</a>` : ''}</section>` });
}

/**
 * The sign-in page (9.3, S-10). A WhatsApp code and Google; inside Instagram's or Facebook's in-app browser, where Google
 * sign-in may not work, the WhatsApp code comes first. `shared` adds the way back in with details saved at another store.
 */
export function signInPage(layout, { next = '/', notice, googleOn = false, inApp = false, sharedOn = false, error = '', sellerCsrf = '' }) {
  const store = layout.business.name || 'this store';
  const checkoutNote = next.startsWith('/checkout') ? html`<p class="muted">Sign in, or create an account to place your order. It takes one WhatsApp code, and your bag is saved.</p>` : '';
  const whatsapp = html`<form class="form" id="otp-form" novalidate>
<h2>Get a code on WhatsApp</h2>
<div id="otp-step-phone" class="options">
<label>WhatsApp number<input id="otp-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required maxlength="20" placeholder="10-digit number"></label>
<button class="btn wide" type="submit" id="otp-send">Send code on WhatsApp</button>
</div>
<div id="otp-step-code" class="options" hidden>
<p class="muted" id="otp-sent-to"></p>
<label>6-digit code<input id="otp-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6"></label>
<label class="check"><input type="checkbox" id="opt-updates"> Send my order updates on WhatsApp</label>
<label class="check"><input type="checkbox" id="opt-offers"> Send me offers and news from ${store} on WhatsApp</label>
<button class="btn wide" type="button" id="otp-verify">Sign in</button>
<div class="row"><button class="btn-quiet" type="button" id="otp-change">Change number</button><button class="btn-quiet" type="button" id="otp-resend">Send a new code</button></div>
</div>
<p class="err" id="otp-error" role="alert"${error ? '' : raw(' hidden')}>${error}</p>
</form>`;
  const google = googleOn
    ? html`<div class="panel"><a class="btn wide" href="/auth/google?next=${encodeURIComponent(next)}">Continue with Google</a>${inApp ? html`<p class="muted">Google sign-in may not open inside this app. The WhatsApp code always works.</p>` : ''}</div>`
    : '';
  const options = inApp || !googleOn ? [whatsapp, google] : [google, whatsapp];
  const script = raw(`<script>(function(){${CALL}
var next=${JSON.stringify(next)},noticeVersion=${Number(notice.version) || 1};
var f=document.getElementById('otp-form'),phone=document.getElementById('otp-phone'),code=document.getElementById('otp-code'),err=document.getElementById('otp-error');
var stepPhone=document.getElementById('otp-step-phone'),stepCode=document.getElementById('otp-step-code'),sentTo=document.getElementById('otp-sent-to');
function show(m){err.textContent=m||'';err.hidden=!m;}
function send(){show('');call('POST','/api/store/otp/send',{phone:phone.value,purpose:'sign_in'}).then(function(r){if(!r.ok)return show(r.body.error||'We couldn’t send a code.');stepPhone.hidden=true;stepCode.hidden=false;sentTo.textContent='We sent a code on WhatsApp. It works for 5 minutes.';code.focus();});}
f.addEventListener('submit',function(e){e.preventDefault();if(stepCode.hidden)send();else verify();});
document.getElementById('otp-resend').addEventListener('click',send);
document.getElementById('otp-change').addEventListener('click',function(){stepCode.hidden=true;stepPhone.hidden=false;code.value='';show('');phone.focus();});
function verify(){show('');call('POST','/api/store/otp/verify?next='+encodeURIComponent(next),{phone:phone.value,purpose:'sign_in',code:code.value}).then(function(r){if(!r.ok)return show(r.body.error||'That code didn’t work.');
var u=document.getElementById('opt-updates').checked,o=document.getElementById('opt-offers').checked;var go=function(){location.href=r.body.next||next;};
var t=document.getElementById('tokens');if(t)t.dataset.shopperCsrf=r.body.csrf||'';
if(!u&&!o)return go();call('POST','/api/store/consent?source=sign_in',{choices:{noticeVersion:noticeVersion,orderUpdates:{whatsapp:u,email:false},marketing:{whatsapp:o,email:false}}}).then(go);});}
document.getElementById('otp-verify').addEventListener('click',verify);
})();</script>`);
  return page(layout, {
    title: 'Sign in',
    main: html`${tokens({ sellerCsrf })}<section class="acct">
<h1>Sign in</h1>
${checkoutNote}
<div class="options">${options}</div>
${sharedOn ? html`<p><a class="btn-quiet" href="/auth/shared?next=${encodeURIComponent(next)}">Saved your details at another store? Continue without a code</a></p>` : ''}
${noticeBlock(notice, store)}
<p class="muted">By signing in you agree that ${store} uses your number to sign you in and to take and deliver your orders. Messages and offers are only sent if you tick them.</p>
<div class="panel" id="team-sign-in"><h2>Store team</h2>
<p class="muted">For the owner and staff of , and accounts made with a password before.</p>
<form class="form" method="post" action="/login"><input type="hidden" name="next" value="${next}">
<label>Mobile number<input name="phone" type="tel" autocomplete="tel-national" required maxlength="20"></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
<button class="btn" type="submit">Log in</button></form>
</div>
</section>${script}`,
  });
}

/** Asked once at a store, after the platform recognised a browser that has saved its details (9.22): nothing is shared until "Continue". */
export function sharedConfirmPage(layout, { phone, next, notice, shopperCsrf = '', sellerCsrf = '' }) {
  const store = layout.business.name || 'this store';
  return page(layout, {
    title: 'Continue',
    main: html`<section class="acct">
<h1>Welcome back</h1>
<div class="panel">
<p>Continue as <strong>${shownPhone(phone)}</strong>? This number was verified before, so no code is needed.</p>
<form method="post" action="/auth/shared/confirm">${shopperCsrf ? html`<input type="hidden" name="_shopper_csrf" value="${shopperCsrf}">` : ''}${sellerCsrf ? html`<input type="hidden" name="_csrf" value="${sellerCsrf}">` : ''}<input type="hidden" name="next" value="${next}">
<button class="btn wide" type="submit">Continue</button></form>
<a class="btn-quiet" href="/login?next=${encodeURIComponent(next)}">Use another number</a>
</div>
${noticeBlock(notice, store)}
</section>`,
  });
}

function addressText(a) {
  return [a.name, [a.line1, a.line2].filter(Boolean).join(', '), a.landmark, `${a.city}, ${a.state || INDIAN_STATES[a.stateCode] || ''} ${a.pincode}`, a.phone].filter(Boolean).join('\n');
}

function addressForm() {
  const states = Object.entries(INDIAN_STATES).sort((a, b) => a[1].localeCompare(b[1]));
  return html`<form class="form" id="addr-form" hidden novalidate>
<input type="hidden" id="addr-id">
<label>Full name<input type="text" id="addr-name" autocomplete="name" maxlength="80" required></label>
<label>Mobile number<input type="tel" id="addr-phone" autocomplete="tel" maxlength="20" required></label>
<label>House, building, street<input type="text" id="addr-line1" autocomplete="address-line1" maxlength="200" required></label>
<label>Area, colony (optional)<input type="text" id="addr-line2" autocomplete="address-line2" maxlength="200"></label>
<label>Landmark (optional)<input type="text" id="addr-landmark" maxlength="120"></label>
<label>City<input type="text" id="addr-city" autocomplete="address-level2" maxlength="60" required></label>
<label>State<select id="addr-state" required><option value="">Pick your state</option>${states.map(([code, name]) => html`<option value="${code}">${name}</option>`)}</select></label>
<label>PIN code<input type="text" id="addr-pincode" inputmode="numeric" autocomplete="postal-code" maxlength="6" required></label>
<label>Type<select id="addr-kind"><option value="home">Home</option><option value="work">Work</option><option value="other">Other</option></select></label>
<label class="check"><input type="checkbox" id="addr-default"> Use this address by default</label>
<p class="err" id="addr-error" role="alert" hidden></p>
<div class="row"><button class="btn" type="submit">Save address</button><button class="btn-quiet" type="button" id="addr-cancel">Cancel</button></div>
</form>`;
}

/** The account (9.17): orders, addresses, what messages are allowed, saved details across stores, and the shopper's own data. */
export function accountPage(layout, { shopper, orders, addresses, choices, shared, shopperCsrf, sellerCsrf = '', flash = '' }) {
  const store = layout.business.name || 'this store';
  const name = shopper.name ? shopper.name.split(' ')[0] : '';
  const checked = (v) => (v === true ? raw(' checked') : '');
  const own = addresses.filter((a) => !a.shared);
  const script = raw(`<script>(function(){${CALL}
var addresses=${jsonScript(own)},store=${jsonScript(store)};
var f=document.getElementById('addr-form'),err=document.getElementById('addr-error');
function el(id){return document.getElementById(id);}
function fill(a){el('addr-id').value=a?a.id:'';['name','phone','line1','line2','landmark','city','pincode'].forEach(function(k){el('addr-'+k).value=a?a[k]||'':'';});el('addr-state').value=a?a.stateCode:'';el('addr-kind').value=a?a.kind:'home';el('addr-default').checked=a?a.isDefault:false;}
el('addr-add').addEventListener('click',function(){fill(null);f.hidden=false;el('addr-name').focus();});
el('addr-cancel').addEventListener('click',function(){f.hidden=true;});
document.querySelectorAll('[data-edit]').forEach(function(b){b.addEventListener('click',function(){var a=addresses.filter(function(x){return String(x.id)===b.dataset.edit;})[0];fill(a);f.hidden=false;});});
document.querySelectorAll('[data-remove]').forEach(function(b){b.addEventListener('click',function(){if(!confirm('Remove this address?'))return;call('DELETE','/api/store/addresses/'+b.dataset.remove).then(function(){location.reload();});});});
f.addEventListener('submit',function(e){e.preventDefault();var id=el('addr-id').value;var body={name:el('addr-name').value,phone:el('addr-phone').value,line1:el('addr-line1').value,line2:el('addr-line2').value,landmark:el('addr-landmark').value,city:el('addr-city').value,stateCode:el('addr-state').value,pincode:el('addr-pincode').value,kind:el('addr-kind').value,isDefault:el('addr-default').checked};
call(id?'PUT':'POST','/api/store/addresses'+(id?'/'+id:''),body).then(function(r){if(r.ok)return location.reload();var m=r.body.fields?Object.values(r.body.fields)[0]:r.body.error;err.textContent=m||'Please check the address.';err.hidden=false;});});
el('consent-form').addEventListener('submit',function(e){e.preventDefault();var c=function(id){return el(id).checked;};
call('POST','/api/store/consent?source=account',{choices:{noticeVersion:Number(el('consent-form').dataset.notice),orderUpdates:{whatsapp:c('c-ou-wa'),email:c('c-ou-em')},marketing:{whatsapp:c('c-mk-wa'),email:c('c-mk-em')}}}).then(function(r){el('consent-done').hidden=!r.ok;el('consent-done').textContent=r.ok?'Saved.':(r.body.error||'Not saved.');el('consent-done').hidden=false;});});
el('data-access').addEventListener('click',function(){call('POST','/api/store/data-requests',{kind:'access'}).then(function(r){if(!r.ok)return alert(r.body.error||'Please try again.');var blob=new Blob([JSON.stringify(r.body.data,null,2)],{type:'application/json'});var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='my-data.json';document.body.appendChild(a);a.click();a.remove();});});
el('data-erase').addEventListener('click',function(){if(!confirm('Delete your account and personal details at '+store+'? Tax records of your orders are kept with your details removed. This can’t be undone.'))return;call('POST','/api/store/data-requests',{kind:'erasure',confirm:true}).then(function(r){if(!r.ok)return alert(r.body.error||'Please try again.');alert(r.body.message);if(r.body.signedOut)location.href='/';});});
})();</script>`);
  return page(layout, {
    title: 'My account',
    main: html`${tokens({ shopperCsrf, sellerCsrf })}<section class="acct">
<div class="row"><h1>Hi${name ? html`, ${name}` : ''}</h1>
<form method="post" action="/logout"><input type="hidden" name="_shopper_csrf" value="${shopperCsrf}">${sellerCsrf ? html`<input type="hidden" name="_csrf" value="${sellerCsrf}">` : ''}<button class="btn-quiet" type="submit">Sign out</button></form></div>
${shopper.phone ? html`<p class="muted">Signed in as ${shownPhone(shopper.phone)}</p>` : shopper.email ? html`<p class="muted">Signed in with Google</p>` : ''}
${flash ? html`<p class="ok" role="status">${flash}</p>` : ''}
<div class="panel"><div class="row"><h2>Your orders</h2>${orders.length ? html`<a class="btn-quiet" href="/account/orders">See all</a>` : ''}</div>
${orders.length ? html`<ul class="list">${orders.slice(0, 5).map((o) => html`<li><a class="order-row" href="/account/orders/${encodeURIComponent(o.order_number)}"><span><strong>${o.order_number}</strong><br><span class="muted">${dateText(o.created_at)}</span></span><span><span class="badge">${STATUS_TEXT[o.fulfilment_status] ?? o.status}</span><br>${formatRupees(o.total_paise)}</span></a></li>`)}</ul>`
    : html`<p class="muted">No orders yet. <a href="/shop">Start shopping</a></p>`}</div>
<div class="panel"><div class="row"><h2>Addresses</h2><button class="btn-quiet" type="button" id="addr-add">Add an address</button></div>
${addresses.length ? html`<ul class="list">${addresses.map((a) => html`<li><div class="row"><span style="white-space:pre-line">${addressText(a)}</span><span>${a.isDefault && !a.shared ? html`<span class="badge">Default</span> ` : ''}${a.shared ? html`<span class="badge">Saved for all stores</span>` : html`<button class="btn-quiet" type="button" data-edit="${a.id}">Edit</button><button class="btn-quiet" type="button" data-remove="${a.id}">Remove</button>`}</span></div></li>`)}</ul>`
    : html`<p class="muted">No saved addresses yet.</p>`}
${addressForm()}</div>
<form class="panel" id="consent-form" data-notice="${choices.noticeVersion}"><h2>Messages from ${store}</h2>
<p class="muted">Order updates and offers are separate choices. You can change them at any time.</p>
<label class="check"><input type="checkbox" id="c-ou-wa"${checked(choices.orderUpdates.whatsapp)}> Order updates on WhatsApp</label>
<label class="check"><input type="checkbox" id="c-ou-em"${checked(choices.orderUpdates.email)}> Order updates by email</label>
<label class="check"><input type="checkbox" id="c-mk-wa"${checked(choices.marketing.whatsapp)}> Offers and news on WhatsApp</label>
<label class="check"><input type="checkbox" id="c-mk-em"${checked(choices.marketing.email)}> Offers and news by email</label>
<button class="btn" type="submit">Save choices</button><p class="ok" id="consent-done" role="status" hidden></p>
<p class="muted"><a href="/policies/privacy">Privacy policy</a></p></form>
${shared.available ? html`<div class="panel"><h2>Saved details for other stores</h2>
<p class="muted">${shared.on ? 'Your verified number and addresses are saved so you can check out at other stores without signing up again.' : 'Save your verified number and addresses so you can check out at other stores without signing up again. Off unless you turn it on.'}</p>
<a class="btn-quiet" href="/account/shared-profile">${shared.on ? 'Manage or turn off' : 'Find out more'}</a></div>` : ''}
<div class="panel"><h2>Your data</h2>
<p class="muted">Download what ${store} holds about you, or ask for it to be deleted.</p>
<div class="row"><button class="btn-quiet" type="button" id="data-access">Download my data</button><button class="btn-quiet" type="button" id="data-erase">Delete my data</button></div></div>
</section>${script}`,
  });
}

export function ordersPage(layout, { orders }) {
  return page(layout, {
    title: 'Your orders',
    main: html`<section class="acct"><h1>Your orders</h1><div class="panel">
${orders.length ? html`<ul class="list">${orders.map((o) => html`<li><a class="order-row" href="/account/orders/${encodeURIComponent(o.order_number)}"><span><strong>${o.order_number}</strong><br><span class="muted">${dateText(o.created_at)}</span></span><span><span class="badge">${STATUS_TEXT[o.fulfilment_status] ?? o.status}</span><br>${formatRupees(o.total_paise)}</span></a></li>`)}</ul>`
    : html`<p class="muted">No orders yet. <a href="/shop">Start shopping</a></p>`}
</div><a class="btn-quiet" href="/account">Back to your account</a></section>`,
  });
}

/** One order (9.17): what was bought, where it goes (the address as it was when ordered, S-14), invoices, and what can be done now. */
export function orderDetailPage(layout, { order, shopperCsrf, sellerCsrf = '' }) {
  const a = order.shipping_address ?? { name: order.customer_name, line1: order.address, city: order.city, state: order.state, pincode: order.pincode };
  const canCancel = order.flow === 'checkout' && CANCELLABLE.has(order.fulfilment_status) && !order.shipped_at;
  const script = canCancel ? raw(`<script>(function(){${CALL}
document.getElementById('cancel').addEventListener('click',function(){if(!confirm('Cancel this order?'))return;call('POST','/api/store/orders/'+encodeURIComponent(${JSON.stringify(order.order_number)})+'/cancel',{}).then(function(r){if(r.ok)return location.reload();alert(r.body.error||'This order can’t be cancelled now.');});});
})();</script>`) : '';
  return page(layout, {
    title: `Order ${order.order_number}`,
    main: html`${tokens({ shopperCsrf, sellerCsrf })}<section class="acct">
<div class="row"><h1>Order ${order.order_number}</h1><span class="badge">${STATUS_TEXT[order.fulfilment_status] ?? order.status}</span></div>
<p class="muted">Placed ${dateText(order.created_at)}</p>
<div class="panel"><h2>Items</h2><ul class="list">${order.items.map((i) => html`<li class="row"><span>${i.name}${i.option_value ? html` · ${i.option_value}` : ''} × ${i.qty}</span><span>${formatRupees(Number(i.price_paise) * i.qty)}</span></li>`)}</ul>
<div class="row"><strong>Total</strong><strong>${formatRupees(order.total_paise)}</strong></div></div>
<div class="panel"><h2>Delivery address</h2><p style="white-space:pre-line;margin:0">${addressText({ ...a, state: a.state || INDIAN_STATES[a.stateCode] || '' })}</p></div>
${order.shipments.length ? html`<div class="panel"><h2>Tracking</h2>${order.shipments.filter((s) => s.kind === 'forward').map((s) => html`<p class="muted">${s.courier_name || 'Courier'}${s.awb ? html` · ${s.awb}` : ''}</p>`)}<a class="btn-quiet" href="/order/${encodeURIComponent(order.public_token)}">Track this order</a></div>` : ''}
${order.invoices.length ? html`<div class="panel"><h2>Invoices</h2><ul class="list">${order.invoices.map((inv) => html`<li><a href="/order/${encodeURIComponent(order.public_token)}/invoice/${encodeURIComponent(inv.number)}">${inv.doc_type === 'credit_note' ? 'Credit note' : 'Invoice'} ${inv.number}</a></li>`)}</ul></div>` : ''}
${order.returns.length ? html`<div class="panel"><h2>Returns</h2>${order.returns.map((r) => html`<p class="muted">Return requested ${dateText(r.created_at)}: ${r.status.replace(/_/g, ' ')}</p>`)}</div>` : ''}
<div class="row">${canCancel ? html`<button class="btn" type="button" id="cancel">Cancel order</button>` : ''}${order.fulfilment_status === 'delivered' ? html`<a class="btn-quiet" href="/account/orders/${encodeURIComponent(order.order_number)}/return">Return an item</a>` : ''}
<a class="btn-quiet" href="/account/orders">All orders</a></div>
</section>${script}`,
  });
}

/**
 * The shared-profile consent screen (9.18, 9.22, S-97): the one buyer page that names the platform, because the platform
 * is the data fiduciary for this profile. It lists what is held, what for, how to withdraw and the grievance contact.
 * The box is unticked.
 */
export function sharedConsentPage(layout, { notice, status, shopperCsrf, sellerCsrf = '', next = '/account', canConsent = true }) {
  const script = raw(`<script>(function(){${CALL}
var err=document.getElementById('sp-error');function show(m){err.textContent=m||'';err.hidden=!m;}
var save=document.getElementById('sp-save');if(save)save.addEventListener('click',function(){if(!document.getElementById('sp-agree').checked)return show('Tick the box to agree first.');call('POST','/api/store/shared-profile',{noticeVersion:${Number(notice.version)},agree:true,next:${JSON.stringify(next)}}).then(function(r){if(!r.ok)return show(r.body.error||'Not saved.');location.href=r.body.redirect||${JSON.stringify(next)};});});
var off=document.getElementById('sp-withdraw');if(off)off.addEventListener('click',function(){if(!confirm('Delete your saved details for other stores? Each store keeps only its own orders.'))return;call('DELETE','/api/store/shared-profile').then(function(r){if(!r.ok)return show(r.body.error||'Please try again.');location.href='/account';});});
})();</script>`);
  return page(layout, {
    title: 'Saved details for other stores',
    main: html`${tokens({ shopperCsrf, sellerCsrf })}<section class="acct">
<h1>Saved details for other stores</h1>
<div class="panel">
<p>${notice.platformName} runs the technology behind this store and other stores. ${notice.platformName} is the data fiduciary for this shared profile under India’s Digital Personal Data Protection Act, 2023.</p>
<h2>What is kept</h2>
<ul><li>Your verified phone number or Google account</li><li>Your saved delivery addresses</li><li>A cash-on-delivery risk level, worked out from parcels refused at the door. No store sees which stores, what you bought or how many orders.</li></ul>
<h2>What it is for</h2>
<p>Only so you can check out at other stores without signing up again, and so a store can decide whether to offer cash on delivery. Each store keeps its own orders, and a store sends you offers only if you say yes at that store.</p>
<h2>How to withdraw</h2>
<p>From any store’s account page, at any time. That deletes the shared profile. Each store keeps only its own order and tax records.</p>
<h2>Grievance contact</h2>
<p>${notice.grievanceContact}</p>
<details><summary>Full notice (English and हिंदी)</summary><p lang="en">${notice.bodyEn}</p><p lang="hi">${notice.bodyHi}</p></details>
</div>
${status.on ? html`<div class="panel"><p class="ok">Your details are saved for other stores${status.since ? html` since ${dateText(status.since)}` : ''}.</p><button class="btn" type="button" id="sp-withdraw">Withdraw and delete the shared profile</button></div>`
    : canConsent ? html`<div class="panel"><label class="check"><input type="checkbox" id="sp-agree"> I agree that ${notice.platformName} keeps the shared profile described above.</label><button class="btn" type="button" id="sp-save">Save my details for other stores</button></div>`
      : html`<div class="panel"><p class="muted">Sign in with a WhatsApp code or Google first, so there is a verified number or account to save.</p></div>`}
<p class="err" id="sp-error" role="alert" hidden></p>
<a class="btn-quiet" href="/account">Back to your account</a>
</section>${script}`,
  });
}
