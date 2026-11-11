/**
 * The checkout page's script (PRD 9.5). It sends the bag's lines, the address, the way of paying and any code, and shows
 * what the server answers: it never works out an amount itself. One idempotency key per attempt, kept for this tab, makes a
 * second tap the same order (S-15). Cash on delivery asks for the WhatsApp code first and places the order only after it
 * (S-94); three wrong codes and the shopper asks for a new one or pays online (S-95).
 */
export const CHECKOUT_JS = `(() => {
  'use strict';
  const B = window.StoreBag;
  const root = document.querySelector('[data-checkout-page]');
  if (!B || !root) return;
  const $ = (s, r = root) => r.querySelector(s);
  const $$ = (s, r = root) => [...r.querySelectorAll(s)];
  let data = {};
  try { data = JSON.parse(document.getElementById('store-data').textContent); } catch {}
  const form = $('form[data-checkout-form]');
  const errorBox = $('[data-error]');
  const KEY = 'store:checkout-key';
  function attemptKey() {
    try {
      let k = sessionStorage.getItem(KEY);
      if (!k) { k = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^\\w-]/g, ''); sessionStorage.setItem(KEY, k); }
      return k;
    } catch { return 'k' + Date.now(); }
  }
  const field = (name) => form.elements[name];
  const value = (name) => String(field(name)?.value ?? '').trim();
  function chosenAddress() {
    const saved = form.querySelector('input[name="addressId"]:checked');
    if (saved && saved.value !== 'new') return { addressId: Number(saved.value) };
    const a = { name: value('name'), phone: value('phone'), line1: value('line1'), line2: value('line2'), landmark: value('landmark'), city: value('city'), stateCode: value('stateCode'), pincode: value('pincode') };
    const complete = a.name.length >= 2 && a.phone.length >= 8 && a.line1.length >= 3 && a.city && /^[0-9]{2}$/.test(a.stateCode) && /^[1-9][0-9]{5}$/.test(a.pincode);
    return complete ? { address: a } : {};
  }
  const mode = () => form.querySelector('input[name="paymentMode"]:checked')?.value;
  function base() {
    const bag = B.read();
    const out = { lines: bag.lines, ...chosenAddress(), couponCode: value('couponCode') };
    if (value('email')) out.email = value('email');
    if (mode()) out.paymentMode = mode();
    return out;
  }
  function show(message) { errorBox.textContent = message || ''; errorBox.hidden = !message; }
  function fieldErrors(fields) {
    $$('[data-field-error]').forEach((el) => { el.textContent = ''; el.hidden = true; });
    for (const [name, message] of Object.entries(fields || {})) {
      const el = $('[data-field-error="' + name.replace(/^address\\./, '') + '"]');
      if (el) { el.textContent = message; el.hidden = false; }
    }
  }

  function render(q) {
    const list = $('[data-lines]');
    list.replaceChildren(...q.lines.map((l) => {
      const li = document.createElement('li');
      li.className = 'line' + (l.state === 'ok' || l.state === 'capped' ? '' : ' off');
      const img = document.createElement(l.image ? 'img' : 'span');
      if (l.image) { img.src = l.image; img.alt = ''; img.width = 64; img.height = 76; } else img.className = 'ph';
      const mid = document.createElement('div');
      const b = document.createElement('b'); b.textContent = l.name || 'Item';
      const s = document.createElement('div'); s.className = 'muted small';
      s.textContent = [l.option, l.state === 'sold_out' ? 'Sold out' : l.state === 'inactive' ? 'No longer available' : 'Qty ' + l.qty].filter(Boolean).join(' · ');
      mid.append(b, s);
      const amt = document.createElement('b'); amt.textContent = l.linePaise ? B.money(l.linePaise) : '';
      li.append(img, mid, amt);
      return li;
    }));
    const set = (name, paise, show = true) => { const row = $('[data-row="' + name + '"]'); if (!row) return; row.hidden = !show; $('[data-amount]', row).textContent = B.money(paise); };
    set('subtotal', q.subtotalPaise);
    set('discount', q.discountPaise, q.discountPaise > 0);
    set('loyalty', q.loyaltyPaise, q.loyaltyPaise > 0);
    set('shipping', q.shippingPaise);
    if (!q.shippingPaise) $('[data-row="shipping"] [data-amount]').textContent = 'Free';
    set('codFee', q.codFeePaise, q.codFeePaise > 0);
    set('total', q.totalPaise);
    set('advance', q.advancePaise, q.advancePaise > 0);
    set('balance', q.balancePaise, q.advancePaise > 0 || mode() === 'cod');
    set('tax', q.taxPaise, q.taxPaise > 0);
    for (const m of q.paymentModes) {
      const input = form.querySelector('input[name="paymentMode"][value="' + m.mode + '"]');
      if (!input) continue;
      input.disabled = !m.available;
      if (!m.available && input.checked) input.checked = false;
      const why = $('[data-mode-reason="' + m.mode + '"]');
      if (why) { why.textContent = m.available ? '' : m.reason; why.hidden = m.available; }
    }
    const notes = $('[data-notices]');
    notes.textContent = q.notices.join(' ');
    notes.hidden = !q.notices.length;
    const coupon = $('[data-coupon-message]');
    coupon.textContent = q.coupon ? q.coupon.message : '';
    coupon.hidden = !q.coupon;
    const canBuy = q.lines.some((l) => l.state === 'ok' || l.state === 'capped');
    $('[data-place]').disabled = !canBuy;
    if (!B.read().lines.length) { $('[data-empty]').hidden = false; form.hidden = true; }
  }

  let quoting = 0;
  async function quote() {
    const mine = ++quoting;
    const res = await B.api('POST', '/api/store/checkout/quote', base());
    if (mine !== quoting) return;
    if (!res.ok) { show(res.data.error || 'We couldn’t work out your total. Please try again.'); fieldErrors(res.data.fields); return; }
    show('');
    render(res.data);
  }

  function consent() {
    const box = (name) => Boolean(field(name)?.checked);
    return { noticeVersion: Number(data.noticeVersion) || 1, orderUpdates: { whatsapp: box('updatesWhatsapp'), email: box('updatesEmail') }, marketing: { whatsapp: box('offersWhatsapp'), email: box('offersEmail') } };
  }
  function phoneOf(body) {
    if (body.address) return body.address.phone;
    const saved = form.querySelector('input[name="addressId"]:checked');
    return saved?.dataset.phone || '';
  }

  async function place() {
    show('');
    if (!field('acceptTerms').checked) { show('Please accept the terms to place your order.'); return; }
    const body = base();
    if (!body.paymentMode) { show('Choose how you’d like to pay.'); return; }
    if (!body.address && !body.addressId) { show('Enter your delivery address.'); return; }
    const bag = B.read();
    const send = { ...body, idempotencyKey: attemptKey(), acceptTerms: true, consent: consent(), saveDetails: Boolean(field('saveDetails')?.checked) };
    if (bag.ref?.pageSlug) send.pageSlug = String(bag.ref.pageSlug).slice(0, 120);
    if (bag.ref?.utm && typeof bag.ref.utm === 'object') send.utm = bag.ref.utm;
    const button = $('[data-place]');
    button.disabled = true;
    try {
      const res = await B.api('POST', '/api/store/checkout', send);
      if (res.ok && res.data.next === 'verify_phone') return verify(phoneOf(send));
      if (res.ok && res.data.token) {
        B.clear();
        try { sessionStorage.removeItem(KEY); } catch {}
        location.assign('/order/' + encodeURIComponent(res.data.token));
        return;
      }
      if (res.data.quote) render(res.data.quote);
      fieldErrors(res.data.fields);
      show(res.data.error || 'We couldn’t place your order. Please try again.');
    } catch {
      show('We couldn’t reach the store. Check your connection and tap Place order again: you won’t be charged twice.');
    } finally {
      button.disabled = false;
    }
  }

  // ---- the cash-on-delivery code ----
  const panel = $('[data-verify]');
  async function sendCode(phone) {
    const res = await B.api('POST', '/api/store/otp/send', { phone, purpose: 'cod', checkoutKey: attemptKey() });
    $('[data-verify-status]').textContent = res.ok ? 'We sent a 6-digit code on WhatsApp.' : res.data.error || 'We couldn’t send the code. Try again, or pay online.';
  }
  function verify(phone) {
    panel.hidden = false;
    panel.dataset.phone = phone;
    $('[name="code"]', panel).value = '';
    $('[name="code"]', panel).focus();
    sendCode(phone).catch(() => {});
  }
  $('[data-verify-submit]').addEventListener('click', async () => {
    const code = $('[name="code"]', panel).value.trim();
    const res = await B.api('POST', '/api/store/otp/verify', { phone: panel.dataset.phone, purpose: 'cod', code, checkoutKey: attemptKey() });
    if (!res.ok) { $('[data-verify-status]').textContent = res.data.error || 'That code isn’t right.'; return; }
    panel.hidden = true;
    place();
  });
  $('[data-verify-resend]').addEventListener('click', () => sendCode(panel.dataset.phone).catch(() => {}));
  $('[data-verify-online]').addEventListener('click', () => {
    panel.hidden = true;
    const online = form.querySelector('input[name="paymentMode"][value="prepaid"]');
    if (online && !online.disabled) online.checked = true;
    quote();
  });

  // Switching to a saved address hides the form; "new address" shows it.
  function addressForm() {
    const saved = form.querySelector('input[name="addressId"]:checked');
    const fields = $('[data-address-fields]');
    if (fields) fields.hidden = Boolean(saved && saved.value !== 'new');
  }
  form.addEventListener('change', (e) => { if (e.target.name === 'addressId') addressForm(); if (['addressId', 'paymentMode', 'pincode', 'stateCode'].includes(e.target.name)) quote(); });
  form.addEventListener('submit', (e) => { e.preventDefault(); place(); });
  $('[data-apply-coupon]').addEventListener('click', () => quote());
  let timer = 0;
  form.addEventListener('input', (e) => { if (['phone', 'pincode'].includes(e.target.name)) { clearTimeout(timer); timer = setTimeout(quote, 500); } });
  document.addEventListener('bag:changed', quote);
  addressForm();
  quote();
})();
`;
