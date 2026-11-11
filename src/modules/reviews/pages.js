import { STORE_LIMITS } from '../../contracts/orders.js';
import { safeHref } from '../../views/buyer/index.js';
import { html, raw } from '../../views/html.js';

/**
 * What a product page shows of its reviews (PRD 9.19): the average and the count of approved reviews, the newest of them, and
 * a form for a shopper who received the product and hasn't reviewed it on that order. Everything a shopper wrote is escaped
 * by html``; nothing here is the platform's. The form posts with the store's own script (REVIEWS_JS): JSON, or multipart
 * when the shopper adds photos.
 */
export const REVIEWS_SCRIPT = '/store/reviews.js';
export const REVIEWS_ASSET_VERSION = '2';
export const SHOWN_ON_PAGE = 5;

const REVIEWS_CSS = [
  '.reviews{display:flex;flex-direction:column;gap:14px}',
  '.reviews .stars{color:var(--accent,#b8860b);letter-spacing:2px}',
  '.reviews .review{border-top:1px solid var(--line,#ddd);padding-top:12px;display:flex;flex-direction:column;gap:6px}',
  '.reviews .reply{border-left:3px solid var(--line-strong,#ccc);padding-left:10px;font-size:14px}',
  '.reviews .rate{display:flex;gap:8px;flex-wrap:wrap}.reviews .rate label{flex-direction:row;align-items:center;gap:6px;font-weight:600}',
  '.reviews .rate input{width:20px;min-height:20px}',
  '.reviews p{white-space:pre-line;margin:0}',
  '.reviews .shots{display:flex;gap:8px}.reviews .shots img{width:72px;height:72px;object-fit:cover;border-radius:8px;background:var(--chip,#eee)}',
  '.reviews input[type=file]{min-height:auto;padding:8px}',
].join('');

export const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
const dateText = (at) => new Date(at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/** "4.5 out of 5 · 2 reviews", or that there are none yet. */
export function summaryText({ count, average }) {
  if (!count) return 'No reviews yet';
  return `${average.toFixed(1)} out of 5 · ${count} ${count === 1 ? 'review' : 'reviews'}`;
}

function reviewItem(r) {
  return html`<article class="review"><div class="row between"><span class="stars" aria-label="${r.rating} out of 5">${stars(r.rating)}</span><span class="muted small">${dateText(r.createdAt)}</span></div>
${r.body ? html`<p>${r.body}</p>` : ''}
${r.photos?.length ? html`<div class="shots">${r.photos.map(safeHref).filter(Boolean).map((src) => html`<img src="${src}" alt="A buyer’s photo" width="72" height="72" loading="lazy">`)}</div>` : ''}
<span class="muted small">${r.displayName || 'A verified buyer'}</span>
${r.reply ? html`<div class="reply"><b>Reply from the store</b><p>${r.reply}</p></div>` : ''}</article>`;
}

function reviewForm(productId, orderNumber) {
  const choices = [5, 4, 3, 2, 1].map((n) => html`<label><input type="radio" name="rating" value="${n}"> <span aria-label="${n} out of 5">${stars(n)}</span></label>`);
  return html`<form class="panel" data-review-form data-product="${productId}" data-order="${orderNumber}" novalidate>
<h3 style="margin:0">Write a review</h3>
<fieldset class="rate" style="border:0;padding:0;margin:0"><legend class="small">Your rating</legend>${choices}</fieldset>
<label>What did you think? <span class="muted small">(optional)</span><textarea name="body" maxlength="${STORE_LIMITS.review.textChars}" rows="4"></textarea></label>
<label>Photos <span class="muted small">(optional, up to ${STORE_LIMITS.review.photos})</span><input type="file" name="photos" accept="image/jpeg,image/png,image/webp,image/gif" multiple></label>
<button class="btn" type="submit">Send review</button>
<p class="error" data-review-error hidden role="alert"></p>
<p class="notice-box" data-review-done hidden role="status">Thank you. Your review will appear once the store has checked it.</p>
</form>`;
}

/** The section put after the product's own: summary, newest reviews, and the form when this shopper may write one. */
export function reviewsSection({ product, summary, reviews, orderNumber }) {
  return html`<style>${raw(REVIEWS_CSS)}</style><section class="section reviews" aria-labelledby="reviews-h" data-reviews="${product.id}">
<div><span class="kicker">Reviews</span><h2 id="reviews-h">What buyers say</h2></div>
<p class="row"><b>${summary.count ? html`<span class="stars" aria-hidden="true">${stars(Math.round(summary.average))}</span> ` : ''}${summaryText(summary)}</b></p>
${reviews.map(reviewItem)}
${orderNumber ? reviewForm(product.id, orderNumber) : ''}
</section>${orderNumber ? html`<script src="${REVIEWS_SCRIPT}?v=${REVIEWS_ASSET_VERSION}" defer></script>` : ''}`;
}

export const REVIEWS_JS = `(() => {
  'use strict';
  const form = document.querySelector('form[data-review-form]');
  if (!form) return;
  const meta = (n) => (document.querySelector('meta[name="' + n + '"]') || {}).content || '';
  const error = form.querySelector('[data-review-error]');
  const done = form.querySelector('[data-review-done]');
  const say = (text) => { error.textContent = text; error.hidden = !text; };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const picked = form.querySelector('input[name="rating"]:checked');
    if (!picked) { say('Choose from 1 to 5 stars.'); return; }
    say('');
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    const headers = { accept: 'application/json', 'content-type': 'application/json' };
    if (meta('csrf-token')) headers['x-csrf-token'] = meta('csrf-token');
    if (meta('shopper-csrf')) headers['x-shopper-csrf'] = meta('shopper-csrf');
    const fields = { orderNumber: form.dataset.order, productId: Number(form.dataset.product), rating: Number(picked.value), body: form.querySelector('textarea[name="body"]').value.trim() };
    const files = [...(form.querySelector('input[name="photos"]') || {}).files || []];
    if (files.length > ${STORE_LIMITS.review.photos}) { say('Add up to ${STORE_LIMITS.review.photos} photos.'); button.disabled = false; return; }
    let sent;
    if (files.length) {
      sent = new FormData();
      Object.entries(fields).forEach(([k, v]) => sent.append(k, String(v)));
      files.forEach((f) => sent.append('photos', f));
      delete headers['content-type'];
    } else sent = JSON.stringify(fields);
    try {
      const res = await fetch('/api/store/reviews', { method: 'POST', headers, credentials: 'same-origin', body: sent });
      let data = {};
      try { data = await res.json(); } catch (err) { data = {}; }
      if (res.ok) {
        [...form.querySelectorAll('fieldset, label, button, h3')].forEach((el) => { el.hidden = true; });
        done.hidden = false;
        return;
      }
      say(data.error || 'Your review didn’t send. Please try again.');
    } catch (err) {
      say('Your review didn’t send. Please try again.');
    }
    button.disabled = false;
  });
})();
`;
