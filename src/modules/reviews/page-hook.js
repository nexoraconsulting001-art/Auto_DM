import { reportError } from '../../platform/log.js';

/**
 * Adds a part to a buyer page that another module draws (PRD 9.19 to 9.21): the reviews under a product, the wishlist
 * hearts on product cards, a link to the points page in the account. The storefront and the account page have no slot for
 * these, so the page is changed as it is sent, the way the traffic module adds its script. Shared by the reviews, wishlist
 * and loyalty modules.
 *
 *   hookPages(app, { name, paths?, when?(req), transform(html, { req, res }) -> html | Promise<html> })
 *
 * Only a GET that ends in a 200 HTML page is touched. A transform that fails is reported and the page goes out as it was:
 * an extra never takes a page down. Text a transform adds must be escaped by it; nothing here escapes.
 */
const HTML = /text\/html/i;

export function hookPages(app, { name, paths, when = () => true, transform }) {
  const hook = (req, res, next) => {
    if (req.method !== 'GET' || !when(req)) return next();
    const previous = res.send;
    res.send = function send(body) {
      res.send = previous;
      if (typeof body !== 'string' || res.statusCode !== 200 || !HTML.test(String(res.get('content-type') ?? ''))) return previous.call(res, body);
      Promise.resolve()
        .then(() => transform(body, { req, res }))
        .then(
          (out) => previous.call(res, typeof out === 'string' ? out : body),
          (err) => {
            reportError(err, { msg: `${name}.page_hook_failed` });
            previous.call(res, body);
          },
        );
      return res;
    };
    return next();
  };
  if (paths) app.get(paths, hook);
  else app.use(hook);
}

/** `html` with `addition` put just before the last `closing` tag, or at the end when there is none. */
export function insertBefore(html, closing, addition) {
  const at = html.toLowerCase().lastIndexOf(closing.toLowerCase());
  return at === -1 ? html + addition : html.slice(0, at) + addition + html.slice(at);
}

/** `html` with `addition` put just after the first `marker` (and the end of the element it opens, when `close` is given). */
export function insertAfter(html, marker, addition, close = '') {
  const start = html.indexOf(marker);
  if (start === -1) return null;
  if (!close) return html.slice(0, start + marker.length) + addition + html.slice(start + marker.length);
  const end = html.indexOf(close, start);
  if (end === -1) return null;
  return html.slice(0, end + close.length) + addition + html.slice(end + close.length);
}

/** Reads one cookie from a request, or ''. A badly encoded value is no value. */
export function cookieOf(req, name) {
  for (const part of String(req?.headers?.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return '';
      }
    }
  }
  return '';
}
