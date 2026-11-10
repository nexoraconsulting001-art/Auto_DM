/** Which buyer page an address is, so a view needs no change to count. Later phases add their paths here. */
const NOT_BUYER_PAGE = /^\/(admin|api|login|logout|signup|account|static|media|webhook|health|healthz|readyz|metrics|oauth|meta|tls|report-files|reporting|_t)(\/|$)/i;

export const isBuyerPage = (path) => !NOT_BUYER_PAGE.test(path);

export function pageOf(path) {
  const parts = path.split('/').filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  if (!parts.length) return { kind: 'store', ref: '' };
  const [first, second, third, fourth] = parts;
  if (first === 'r' && second && third === 'p' && fourth) return { kind: 'product', ref: fourth };
  if (first === 'r' && second) return { kind: 'landing', ref: second };
  if (first === 'p' && second) return { kind: 'product', ref: second };
  if (first === 'c' && second) return { kind: 'category', ref: second };
  if (first === 'shop' || first === 'reels') return { kind: 'store', ref: first };
  if (first === 'bio') return { kind: 'link_in_bio', ref: second ?? '' };
  if (first === 'creator') return { kind: 'creator', ref: second ?? '' };
  if (first === 'checkout') return { kind: 'checkout', ref: '' };
  if (first === 'order') return { kind: 'other', ref: 'order', noTags: true };
  return { kind: 'other', ref: first.slice(0, 200) };
}

/** A path as it may be stored: an order's page carries its private token in the address, so only "/order" is kept. */
export function storablePath(path) {
  const clean = String(path).split(/[?#]/)[0].slice(0, 500) || '/';
  return /^\/order(\/|$)/i.test(clean) ? '/order' : clean;
}
