import { formatRupees } from '../../contracts/catalog.js';
import { html, raw } from '../../views/html.js';
import { PROOF_LIMITS, PROOF_MESSAGES } from './proofs.js';

/**
 * The shopper's return page (PRD 9.17): in the store's frame (src/modules/storefront/shell.js), the seller's brand only.
 * It lists what can still be returned, asks why and for a refund or an exchange, and takes the photo or video the owner
 * asked for. Submit is blocked in the page with the same sentence the server refuses with (S-80).
 */
const ACCEPT = Object.freeze({ photo: 'image/jpeg,image/png,image/webp', video: 'video/mp4,video/quicktime,video/webm', either: 'image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm' });
const ASK = Object.freeze({ photo: 'A photo of the item', video: 'A short video of the item', either: 'A photo or short video of the item' });

const dateText = (at) => new Date(at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

const STYLE = raw(`<style>.ret h1{margin:0 0 4px}.ret .pick{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center}
.ret .pick select{width:auto;min-width:72px}.ret .choice{display:flex;gap:16px;flex-wrap:wrap}.ret .choice label{flex-direction:row;align-items:center;gap:8px;font-weight:600}
.ret .choice input{width:20px;min-height:20px}.ret textarea{min-height:96px}.ret .done{border-radius:12px;padding:14px;background:var(--chip)}</style>`);

/** `order` the order row; `options` from service.options(); `deadline` when the window closes. */
export function returnPage({ order, options, deadline }) {
  const proof = options.settings.proof;
  const lines = options.lines.filter((l) => l.left > 0);
  const script = raw(`<script>(function(){
var form=document.getElementById('return-form');if(!form)return;
var err=document.getElementById('return-error');var done=document.getElementById('return-done');
function token(){var m=document.querySelector('meta[name="shopper-csrf"]');return m?m.content:'';}
function show(t){err.textContent=t;err.hidden=!t;}
form.addEventListener('submit',function(e){e.preventDefault();show('');
var items=[];form.querySelectorAll('[data-line]').forEach(function(row){var box=row.querySelector('input[type=checkbox]');if(box.checked)items.push({orderItemId:Number(box.value),qty:Number(row.querySelector('select').value)});});
if(!items.length)return show('Choose what you are returning.');
var files=form.querySelector('input[type=file]').files;var need=${JSON.stringify(proof)};var photos=0,videos=0;
for(var i=0;i<files.length;i++){if(/^image\\//.test(files[i].type))photos++;else if(/^video\\//.test(files[i].type))videos++;}
if((need==='photo'&&!photos)||(need==='video'&&!videos)||(need==='either'&&!photos&&!videos))return show(${JSON.stringify(PROOF_MESSAGES[proof] ?? PROOF_MESSAGES.either)});
if(files.length>${PROOF_LIMITS.files})return show('Add up to ${PROOF_LIMITS.files} files.');
var body=new FormData();body.append('items',JSON.stringify(items));body.append('reason',form.reason.value);
var res=form.querySelector('input[name=resolution]:checked');body.append('resolution',res?res.value:'refund');
for(var j=0;j<files.length;j++)body.append('proof',files[j]);
var button=form.querySelector('button[type=submit]');button.disabled=true;
fetch(${JSON.stringify(`/api/store/orders/${encodeURIComponent(order.order_number)}/returns`)},{method:'POST',body:body,credentials:'same-origin',headers:{'x-shopper-csrf':token(),accept:'application/json'}})
.then(function(r){return r.json().catch(function(){return {};}).then(function(b){return {ok:r.ok,body:b};});})
.then(function(r){button.disabled=false;if(!r.ok){var f=r.body.fields;return show((f&&(f.proof||f.items||f.reason))||r.body.error||'Please check the details and try again.');}
form.hidden=true;done.hidden=false;})
.catch(function(){button.disabled=false;show('We couldn’t reach the store. Check your connection and try again.');});});
})();</script>`);
  return html`${STYLE}<section class="ret stack">
<div><h1>Return an item</h1><p class="muted">Order ${order.order_number}. You can ask for a return until ${dateText(deadline)}.</p></div>
<form id="return-form" class="stack" novalidate>
<div class="panel"><h2>What are you returning?</h2>
${lines.map((l) => html`<div class="pick" data-line><input type="checkbox" id="line-${l.id}" value="${l.id}"${lines.length === 1 ? raw(' checked') : ''}><label for="line-${l.id}">${l.name}${l.option_value ? html` · ${l.option_value}` : ''}<span class="muted small">${formatRupees(Number(l.price_paise))} each</span></label>
<select aria-label="How many">${Array.from({ length: l.left }, (_, i) => html`<option value="${i + 1}">${i + 1}</option>`)}</select></div>`)}
</div>
<div class="panel"><label>What’s wrong with it?<textarea name="reason" maxlength="500" placeholder="For example: the seam is torn"></textarea></label>
<div class="choice" role="radiogroup" aria-label="What would you like"><label><input type="radio" name="resolution" value="refund" checked>A refund</label><label><input type="radio" name="resolution" value="exchange">An exchange</label></div></div>
<div class="panel"><label>${ASK[proof] ?? ASK.either}<input type="file" name="proof" accept="${ACCEPT[proof] ?? ACCEPT.either}" multiple></label>
<p class="muted small">Every return needs ${proof === 'video' ? 'a short video' : proof === 'photo' ? 'a photo' : 'a photo or short video'} of the item as it is now. Only the store sees it.</p></div>
<p id="return-error" class="error" role="alert" hidden></p>
<button class="btn wide" type="submit">Ask for a return</button>
</form>
<div id="return-done" class="done" hidden><strong>We have your request.</strong> The store will look at it and let you know. <a href="/account/orders/${encodeURIComponent(order.order_number)}">Back to your order</a></div>
</section>${script}`;
}

/** The page when nothing can be returned: no form (S-57). */
export function noReturnPage({ order, message }) {
  return html`<section class="stack"><h1>Returns</h1><p>${message}</p><p><a href="/account/orders/${encodeURIComponent(order.order_number)}">Back to your order</a></p></section>`;
}
