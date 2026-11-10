import { TRAFFIC_PATHS } from '../../contracts/analytics.js';

/**
 * The script on every buyer page, served from the seller's own domain (7.10). It reports what the page does and nothing about who: no name, no form field,
 * no search text. Taps on outside links are recorded by the page and the link itself is left alone, so there is never a redirect.
 */
export const TRAFFIC_SCRIPT = `(function () {
  var d = document, w = window, me = d.currentScript, o = (me && me.dataset) || {};
  var q = new URLSearchParams(location.search);
  var kind = o.k || 'other', ref = o.r || '', commerce = !!o.c, pageEvent = o.e || '';
  function rnd() {
    var a = new Uint8Array(12);
    (w.crypto || w.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  var tab;
  try { tab = sessionStorage.getItem('_s') || rnd(); sessionStorage.setItem('_s', tab); } catch (e) { tab = rnd(); }
  function p(name) { return (q.get(name) || '').slice(0, 200); }
  function send(name, extra) {
    var body = { name: name, path: location.pathname.slice(0, 500), pageKind: kind, pageRef: ref.slice(0, 200), referrer: d.referrer.slice(0, 500), src: p('src').slice(0, 40),
      utm: { source: p('utm_source'), medium: p('utm_medium'), campaign: p('utm_campaign'), content: p('utm_content') } };
    for (var key in extra) body[key] = extra[key];
    try {
      fetch('${TRAFFIC_PATHS.event}?v=' + tab, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive: true, credentials: 'same-origin' }).catch(function () {});
    } catch (e) {}
  }
  function tag(metaName, googleName, id, params) {
    if (w.fbq) w.fbq('track', metaName, params || {}, { eventID: id });
    if (w.gtag) w.gtag('event', googleName, Object.assign({ event_id: id }, params || {}));
  }

  send('page_view', { eventId: pageEvent });
  tag('PageView', 'page_view', pageEvent);
  if (kind === 'landing') send('landing_view', {});
  if (kind === 'category') send('category_view', {});
  if (kind === 'product') { var viewId = rnd(); send('product_view', { eventId: viewId }); tag('ViewContent', 'view_item', viewId); }
  if (kind === 'checkout') { var checkoutId = rnd(); send('checkout_started', { eventId: checkoutId }); if (commerce) tag('InitiateCheckout', 'begin_checkout', checkoutId); }

  function addedToCart(productId) {
    var id = rnd(), extra = { eventId: id };
    if (productId) extra.productId = productId;
    send('add_to_cart', extra);
    if (commerce) tag('AddToCart', 'add_to_cart', id);
  }
  function hasOptions(id) {
    var list = (w.STORE && w.STORE.products) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return !!(list[i].options && list[i].options.length);
    return false;
  }
  d.addEventListener('submit', function (e) {
    var form = e.target;
    if (form.matches && form.matches('[data-sheet] form, [data-pdp-form]')) addedToCart(0);
  }, true);
  d.addEventListener('click', function (e) {
    var el = e.target && e.target.closest && e.target.closest('a[href], [data-add]');
    if (!el) return;
    if (el.hasAttribute('data-add')) {
      var id = Number(el.getAttribute('data-add'));
      if (id && !hasOptions(id)) addedToCart(id);
      return;
    }
    var url;
    try { url = new URL(el.href); } catch (err) { return; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (url.host !== location.host) {
      var chat = /(^|\\.)wa\\.me$|(^|\\.)whatsapp\\.com$/i.test(url.hostname);
      send(chat ? 'whatsapp_tap' : 'outbound_tap', { outboundHost: url.hostname.slice(0, 253) });
      return;
    }
    var m = /\\/p\\/([^\\/?#]+)/.exec(url.pathname);
    if (m) send('product_tap', { pageKind: 'product', pageRef: decodeURIComponent(m[1]).slice(0, 200) });
  }, true);

  var shownAt = Date.now(), engaged = 0;
  d.addEventListener('visibilitychange', function () {
    if (d.visibilityState === 'hidden') {
      engaged = Date.now() - shownAt;
      if (engaged > 0) send('page_view', { eventId: pageEvent, engagedMs: Math.min(engaged, 86400000) });
    } else {
      shownAt = Date.now();
    }
  });
})();
`;
