import { reportError } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { esc } from '../../views/html.js';
import { isBuyerPage } from '../traffic/page-kinds.js';

/**
 * The install banner on buyer pages (PRD 10.12), wrapped into the HTML answer the way the traffic module adds its script:
 * no view changes, no script, nothing that calls home, no platform name. Only for a phone whose platform's app is live
 * (app_submissions.state, the plan's app.<platform>, an app_configs row):
 *
 *   iOS       <meta name="apple-itunes-app" content="app-id=<digits of the store link>, app-argument=<this page's URL>">, and in
 *             an in-app browser (Instagram's, Facebook's), where Safari's own banner never shows, one banner linking the App
 *             Store page, which reads "Open" on a phone that has the app
 *   Android   one banner linking intent://<host><path>#Intent;scheme=https;package=<package>;S.browser_fallback_url=<store>;end
 *
 * The banner is in the seller's brand: the buyer page's own colour and font variables (brandCss), the app's own name.
 *
 * On /order/:token?app=1 (the payment page the app opened in a browser tab) the banner reads "Back to the app" and links
 * <url_scheme>://order/<token>. That one needs the app to exist for the phone's platform, not to be live: the app is what
 * opened the tab, and a build in review must be able to come back to itself.
 */
const FEATURE = Object.freeze({ android: 'app.android', ios: 'app.ios' });
const ORDER_PAGE = /^\/order\/([A-Za-z0-9_-]{8,100})$/;

/** True for Instagram's and Facebook's in-app browsers, where a DM link usually opens. */
export const inAppBrowser = (agent) => /\b(Instagram|FBAN|FBAV|FB_IAB|FBIOS)\b/.test(String(agent ?? '').slice(0, 512));

/** The phone's platform from its user agent, or null for anything else. */
export function platformOfAgent(agent) {
  const text = String(agent ?? '').slice(0, 512);
  if (/\b(iPhone|iPad|iPod)\b/.test(text)) return 'ios';
  if (/\bAndroid\b/.test(text)) return 'android';
  return null;
}

async function appState(ctx, platform) {
  const [row] = await ctx.db.query(
    `SELECT c.app_name, c.short_name, c.android_package, c.ios_bundle_id, c.url_scheme, c.android_store_url, c.ios_store_url, s.state, s.store_url
     FROM app_configs c LEFT JOIN app_submissions s ON s.tenant_id = c.tenant_id AND s.platform = $2
     WHERE c.tenant_id = $1`,
    [tenantId(), platform],
  );
  if (!row) return null;
  if (!(await ctx.repos.entitlements.can(FEATURE[platform]))) return null;
  return row;
}

// The buyer page's own variables (src/modules/brand/theme.js brandCss); system colours only where a page has none.
const bar = (label, href, text) => `<div data-app-banner style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;`
  + `background:var(--mist,var(--paper,Canvas));color:var(--ink,CanvasText);border-bottom:1px solid var(--line,GrayText);font-family:var(--body,inherit);font-size:14px;line-height:1.3">`
  + `<span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(label)}</span>`
  + `<a href="${esc(href)}" rel="nofollow" style="flex:none;padding:8px 14px;border-radius:999px;background:var(--gold,CanvasText);color:var(--on-gold,Canvas);`
  + `text-decoration:none;font-weight:600">${esc(text)}</a></div>`;

/** What to add to this page, or null. Pure apart from its inputs. */
export function bannerFor({ platform, state, host, path, originalUrl, protocol, query, inApp = false }) {
  if (!state) return null;
  const label = state.short_name || state.app_name || '';
  const order = ORDER_PAGE.exec(path);
  if (order && String(query?.app ?? '') === '1') {
    const own = platform === 'android' ? state.android_package : state.ios_bundle_id;
    if (!state.url_scheme || !own) return null;
    return { body: bar(label, `${state.url_scheme}://order/${order[1]}`, 'Back to the app') };
  }
  if (state.state !== 'live') return null;
  if (platform === 'ios') {
    const store = state.ios_store_url || state.store_url || '';
    const appId = /^https:\/\/apps\.apple\.com\/[^?#]*\bid(\d{5,15})(?:[/?#]|$)/.exec(store)?.[1];
    if (!appId) return null;
    const head = `<meta name="apple-itunes-app" content="${esc(`app-id=${appId}, app-argument=${protocol}://${host}${originalUrl}`)}">`;
    return inApp ? { head, body: bar(label, store, 'Open in app') } : { head };
  }
  if (!state.android_package) return null;
  const store = state.android_store_url || state.store_url || `https://play.google.com/store/apps/details?id=${state.android_package}`;
  const intent = `intent://${host}${String(originalUrl).replaceAll('#', '%23')}#Intent;scheme=https;package=${state.android_package};S.browser_fallback_url=${encodeURIComponent(store)};end`;
  return { body: bar(label, intent, 'Open in app') };
}

function insertAfterBodyTag(html, addition) {
  const match = /<body\b[^>]*>/i.exec(html);
  return match ? html.slice(0, match.index + match[0].length) + addition + html.slice(match.index + match[0].length) : html;
}

function insertBeforeHeadEnd(html, addition) {
  const at = html.toLowerCase().lastIndexOf('</head>');
  return at === -1 ? html : html.slice(0, at) + addition + html.slice(at);
}

/** The middleware: decides before the page renders (one read), and adds to the HTML as it is sent. */
export function bannerMiddleware(ctx) {
  return async (req, res, next) => {
    if (req.method !== 'GET' || !isBuyerPage(req.path) || req.path.startsWith('/.well-known/') || req.appSession || req.get('x-app')) return next();
    const platform = platformOfAgent(req.get('user-agent'));
    if (!platform) return next();
    let banner = null;
    try {
      const state = await appState(ctx, platform);
      banner = bannerFor({ platform, state, host: req.hostname, path: req.path, originalUrl: req.originalUrl, protocol: req.protocol, query: req.query, inApp: inAppBrowser(req.get('user-agent')) });
    } catch (err) {
      // A banner never takes a page down.
      reportError(err, { msg: 'app_links.banner_failed' });
    }
    if (!banner) return next();
    const send = res.send.bind(res);
    res.send = (body) => {
      res.send = send;
      const type = res.get('content-type');
      const html = typeof body === 'string' && (type ? /text\/html/i.test(type) : /^\s*<(!doctype html|html)/i.test(body));
      if (!html || res.statusCode !== 200) return send(body);
      let out = body;
      if (banner.head) out = insertBeforeHeadEnd(out, banner.head);
      if (banner.body) out = insertAfterBodyTag(out, banner.body);
      return send(out);
    };
    return next();
  };
}
