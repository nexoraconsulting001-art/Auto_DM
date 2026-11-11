import { formatRupees } from '../../contracts/catalog.js';
import { html, raw } from '../../views/html.js';

/**
 * The shopper's points page (/account/points) and the page a referral link opens (/refer/:code), in the seller's brand
 * only (PRD 9.21). Points have no cash value outside checkout and can't be moved to anyone else; the page says so.
 */
const dateText = (at) => (at ? new Date(at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '');
const plural = (n) => `${n.toLocaleString('en-IN')} ${Math.abs(n) === 1 ? 'point' : 'points'}`;
const signed = (n) => `${n > 0 ? '+' : '−'}${Math.abs(n).toLocaleString('en-IN')}`;

const PAGE_CSS = [
  '.points-total{font-size:40px;font-weight:800;line-height:1.1;margin:0}',
  '.points-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}',
  '.points-list li{display:grid;grid-template-columns:1fr auto;gap:4px 12px;padding:10px 0;border-top:1px solid var(--line,#ddd)}',
  '.points-list .plus{color:var(--good,#17694A);font-weight:700}.points-list .minus{font-weight:700}.points-list .void{text-decoration:line-through;opacity:.6}',
  '.refer-link{font-family:ui-monospace,monospace;word-break:break-all;background:var(--chip,#eee);padding:10px 12px;border-radius:10px}',
].join('');

function describe(e) {
  const order = e.order_number ? ` ${e.order_number}` : '';
  switch (e.kind) {
    case 'earn':
      if (e.status === 'void') return `Order${order} was cancelled or refunded`;
      if (e.status === 'pending') return e.available_at ? `Earned on order${order} · usable from ${dateText(e.available_at)}` : `Earned on order${order} · usable after delivery and the return window`;
      return `Earned on order${order}`;
    case 'redeem': return `Used on order${order}`;
    case 'reverse': return `Taken back: order${order} was refunded`;
    case 'restore': return `Given back: order${order} was cancelled`;
    case 'expire': return 'Expired';
    case 'referral':
      if (e.status === 'void') return 'A friend’s first order was cancelled or refunded';
      return e.status === 'pending' ? 'A friend’s first order · usable after their return window' : 'A friend’s first order';
    default: return 'From the store';
  }
}

export function pointsPage({ account, settings, history, referralUrl }) {
  const worth = formatRupees(account.balance * settings.pointValuePaise);
  const earnRule = `Earn ${plural(settings.earnPoints)} for every ${formatRupees(settings.earnPerPaise)} you spend, after discounts and before delivery.`;
  const redeemRule = settings.maxRedeemPoints > 0
    ? `Each point takes ${formatRupees(settings.pointValuePaise)} off at checkout, up to ${plural(settings.maxRedeemPoints)} on one order.`
    : 'Points can’t be used at checkout right now.';
  return html`<style>${raw(PAGE_CSS)}</style>
<div class="stack">
<div class="panel"><span class="muted small">You have</span><p class="points-total">${plural(account.balance)}</p>
<p class="muted">Worth ${worth} at checkout.${account.pending ? html` ${plural(account.pending)} more are on the way.` : ''}</p></div>
<div class="panel"><h2 style="font-size:18px;margin:0">How it works</h2>
<p>${earnRule} New points can be used once the return window of the order has closed.</p>
<p>${redeemRule}</p>
${settings.expiryDays ? html`<p>Points expire ${settings.expiryDays} days after you get them.</p>` : ''}
<p class="muted small">Points have no cash value and can’t be moved to anyone else.</p></div>
${referralUrl ? html`<div class="panel"><h2 style="font-size:18px;margin:0">Invite a friend</h2>
<p>Share your link. When a friend places their first order through it and it is delivered, you get ${plural(settings.referrerPoints)} once their return window closes.</p>
<p class="refer-link" data-refer-link>${referralUrl}</p>
<button class="btn" type="button" data-copy="${referralUrl}">Copy link</button></div>` : ''}
<div class="panel"><h2 style="font-size:18px;margin:0">History</h2>
${history.length ? html`<ul class="points-list">${history.map((e) => html`<li><span>${describe(e)}<br><span class="muted small">${dateText(e.created_at)}</span></span><span class="${e.status === 'void' ? 'void' : e.points > 0 ? 'plus' : 'minus'}">${signed(e.points)}</span></li>`)}</ul>`
    : html`<p class="muted">Nothing yet. Your points will show here after your first order.</p>`}</div>
<a class="btn-quiet" href="/account">Back to your account</a>
</div>
${referralUrl ? html`<script>(function(){var b=document.querySelector('[data-copy]');if(!b)return;b.addEventListener('click',function(){var v=b.getAttribute('data-copy');if(navigator.clipboard)navigator.clipboard.writeText(v).then(function(){b.textContent='Copied';},function(){});});})();</script>` : ''}`;
}

export function invitePage({ own }) {
  return html`<div class="stack">
<div class="panel">${own
    ? html`<p>This is your own invite link. Share it with friends: you get points when their first order is delivered.</p><a class="btn" href="/account/points">See your points</a>`
    : html`<p>A friend invited you. Have a look around.</p><a class="btn wide" href="/shop">Start shopping</a>`}</div>
</div>`;
}
