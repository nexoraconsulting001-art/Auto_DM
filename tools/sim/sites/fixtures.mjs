/**
 * The fixture websites tools/sim/sites serves, by host name. Every name is under .example, which never resolves on the
 * internet, and every address below is only ever handed to safeFetch's test transport: nothing connects to it.
 *
 * A site is { dns, pages }:
 *   dns    the lookup's answer: a list of addresses, or { sequence: [[...first], [...later]] } for an answer that changes
 *   pages  path -> { status?, type?, body?, headers?, delayMs?, hang?, redirect?, redirectFrom?, stream?: { bytes, chunk?, everyMs? } }
 *          body may be a string, a Buffer or (req) => string | Buffer. `redirect` answers 302 to that address;
 *          redirectFrom(rest) does the same with what it returns, or serves the page when it returns null.
 *          A path ending in /* matches everything under it; `rest` is the part after it. type '' sends no content-type.
 *
 * What is here, for import (8.3 to 8.8), theme-from-site (8.9) and safeFetch (8.2):
 *   shop.example         a small shop: homepage, JSON-LD product (rupee text, out of stock), ProductGroup with variants,
 *                        @graph, Open Graph only, OG price, title only, script in product text, images
 *   brand.example        a look to read: theme-color, CSS custom properties, button colours, Google Fonts, logo sources
 *   lowcontrast.example  a brand colour that fails contrast with white text (2.1:1)
 *   inject.example       colours and text carrying markup and script
 *   scriptonly.example   a page that is all JavaScript, with only an icon to read
 *   huge.example         5 MB page, the same streamed with no length, a compressed bomb, an oversized image
 *   slow.example         answers after 12 s, or never
 *   loop.example         endless redirects, and /hops/<n> for exactly n
 *   toprivate.example    redirects to private, metadata and odd-port addresses
 *   internal.example     a name that resolves to a private address
 *   mixed.example        a name with one public and one private answer
 *   rebind.example       a name whose answer flips to the metadata address after the first lookup
 *   malformed.example    broken HTML and JSON-LD, NUL bytes, deep nesting, a flood of tags
 *   wrongtype.example    pages and images served as the wrong type
 *   gone.example         404, 410 and 500 product pages, and one whose price a test can change
 *   api.example          a JSON product API of the kind a site adapter reads, with 404, HTML and broken answers
 */
import zlib from 'node:zlib';
import { png } from './png.mjs';

const MB = 1024 * 1024;
const html = (head, body = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
const jsonLd = (data) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
const image = (color, width = 1200, height = 1200) => ({ type: 'image/png', body: png({ width, height, color }) });

export const SITE_ADDRESSES = Object.freeze({
  public: '93.184.216.34',
  private: '10.0.0.5',
  metadata: '169.254.169.254',
});

function shop() {
  const brass = {
    '@context': 'https://schema.org', '@type': 'Product', name: 'Brass planter', description: 'Hand-beaten brass, 6 inch.',
    image: ['https://shop.example/img/brass.png'], sku: 'BR-6',
    offers: { '@type': 'Offer', price: '1,299.00', priceCurrency: 'INR', availability: 'https://schema.org/OutOfStock' },
  };
  const group = {
    '@context': 'https://schema.org', '@type': 'ProductGroup', name: 'Terracotta pot', productGroupID: 'TP', variesBy: ['size'],
    image: 'https://shop.example/img/terracotta.png',
    hasVariant: [
      { '@type': 'Product', name: 'Terracotta pot, small', sku: 'TP-S', size: 'Small', offers: { '@type': 'Offer', price: '499', priceCurrency: 'INR', availability: 'https://schema.org/OutOfStock' } },
      { '@type': 'Product', name: 'Terracotta pot, medium', sku: 'TP-M', size: 'Medium', offers: { '@type': 'Offer', price: '599', priceCurrency: 'INR', availability: 'https://schema.org/InStock' } },
    ],
  };
  const graph = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Organization', name: 'Leafy Corner', logo: 'https://shop.example/logo.png' },
      { '@type': 'Product', name: 'Hanging macrame', image: 'https://shop.example/img/macrame.png', offers: { '@type': 'Offer', price: 349, priceCurrency: 'INR', availability: 'InStock' } },
    ],
  };
  return {
    dns: [SITE_ADDRESSES.public],
    pages: {
      '/': { body: html('<title>Leafy Corner</title><meta property="og:site_name" content="Leafy Corner"><meta property="og:title" content="Leafy Corner"><meta property="og:image" content="https://shop.example/logo.png">', '<h1>Leafy Corner</h1>') },
      '/products/brass-planter': { body: html(`<title>Brass planter | Leafy Corner</title>${jsonLd(brass)}`) },
      '/products/terracotta-pot': { body: html(`<title>Terracotta pot | Leafy Corner</title>${jsonLd(group)}`) },
      '/products/macrame': { body: html(`<title>Hanging macrame | Leafy Corner</title>${jsonLd(graph)}`) },
      '/products/og-only': { body: html('<title>Jute basket | Leafy Corner</title><meta property="og:title" content="Jute basket"><meta property="og:image" content="https://shop.example/img/jute.png"><meta property="og:type" content="product">') },
      '/products/og-price': { body: html('<title>Cane tray | Leafy Corner</title><meta property="og:title" content="Cane tray"><meta property="og:image" content="https://shop.example/img/cane.png"><meta property="product:price:amount" content="799.00"><meta property="product:price:currency" content="INR">') },
      '/products/title-only': { body: html('<title>Steel bottle</title>', '<p>Nothing else here.</p>') },
      '/products/site-name': { body: html('<title>Leafy Corner</title><meta property="og:title" content="Leafy Corner"><meta property="og:image" content="https://shop.example/logo.png">') },
      '/products/script-in-text': {
        body: html(`<title>Clay lamp</title>${jsonLd({ '@type': 'Product', name: 'Clay lamp <script>alert(1)</script>', description: '<img src=x onerror=alert(2)>Warm light</p><script>steal()</script>', image: 'https://shop.example/img/lamp.png', offers: { price: '250', priceCurrency: 'INR' } })}`),
      },
      '/logo.png': image('#2F6B3A', 512, 512),
      '/img/*': { body: () => png({ width: 1200, height: 1200, color: '#C8794E' }), type: 'image/png' },
    },
  };
}

function brand() {
  return {
    dns: [SITE_ADDRESSES.public],
    pages: {
      '/': {
        body: html(
          '<title>Green Thumb</title><meta name="theme-color" content="#1F4D2B">'
            + '<link rel="preconnect" href="https://fonts.googleapis.com">'
            + '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=Inter:wght@400;600&display=swap">'
            + '<link rel="stylesheet" href="/theme.css"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest">'
            + '<style>:root{--color-primary:#1F4D2B;--color-text:#1A1A1A;--color-background:#FAF7F0}</style>'
            + jsonLd({ '@context': 'https://schema.org', '@type': 'Organization', name: 'Green Thumb', logo: { '@type': 'ImageObject', url: 'https://brand.example/brand-logo.png' } }),
          '<a class="btn button--primary" href="/shop">Shop now</a>',
        ),
      },
      '/theme.css': { type: 'text/css', body: '.btn,.button--primary{background:#1F4D2B;color:#FFFFFF;border-radius:4px}body{font-family:"Inter",sans-serif;color:#1A1A1A}h1,h2{font-family:"Playfair Display",serif}' },
      '/site.webmanifest': { type: 'application/manifest+json', body: JSON.stringify({ name: 'Green Thumb', theme_color: '#1F4D2B', background_color: '#FAF7F0', icons: [{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' }] }) },
      '/brand-logo.png': image('#1F4D2B', 600, 200),
      '/apple-touch-icon.png': image('#1F4D2B', 180, 180),
      '/icon-512.png': image('#1F4D2B', 512, 512),
    },
  };
}

function lowContrast() {
  return {
    dns: [SITE_ADDRESSES.public],
    pages: {
      '/': { body: html('<title>Mint Studio</title><meta name="theme-color" content="#8ABE9C"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Comic+Neue&display=swap"><style>.btn{background:#8ABE9C;color:#FFFFFF}</style>', '<a class="btn">Shop</a>') },
    },
  };
}

function inject() {
  const bad = 'red;}</style><script>alert(1)</script>';
  return {
    dns: [SITE_ADDRESSES.public],
    pages: {
      '/': { body: html(`<title>Inject &amp; Co</title><meta name="theme-color" content="${bad}"><style>:root{--color-primary:${bad};--brand:url(javascript:alert(1))}</style>`, `<button style="background:${bad}">Buy</button>`) },
      '/products/evil': { body: html(`<title>Evil</title>${jsonLd({ '@type': 'Product', name: '"><script>alert(1)</script>', description: '<iframe src="javascript:alert(1)"></iframe>', image: 'javascript:alert(1)', offers: { price: '100', priceCurrency: 'INR' } })}`) },
    },
  };
}

function scriptOnly() {
  return {
    dns: [SITE_ADDRESSES.public],
    pages: {
      '/': { body: html('<title>App Shop</title><link rel="apple-touch-icon" href="/icon.png"><script src="/bundle.js" defer></script>', '<div id="root"></div><noscript>Turn on JavaScript.</noscript>') },
      '/bundle.js': { type: 'text/javascript', body: 'document.getElementById("root").textContent = "Loaded";' },
      '/icon.png': image('#3355AA', 180, 180),
    },
  };
}

function huge() {
  const page = Buffer.alloc(5 * MB, 'a');
  return {
    dns: [SITE_ADDRESSES.public],
    pages: {
      '/': { body: page },
      '/stream': { stream: { bytes: 5 * MB } },
      '/gzip': { headers: { 'content-encoding': 'gzip' }, body: () => zlib.gzipSync(Buffer.alloc(20 * MB, ' ')) },
      '/big.png': { type: 'image/png', body: Buffer.concat([png({ width: 8, height: 8 }), Buffer.alloc(4 * MB)]) },
    },
  };
}

function slow() {
  return {
    dns: [SITE_ADDRESSES.public],
    pages: {
      '/': { delayMs: 12_000, body: html('<title>Slow</title>') },
      '/hang': { hang: true },
      '/drip': { stream: { bytes: 64 * 1024, chunk: 512, everyMs: 250 } },
    },
  };
}

function loop() {
  return {
    dns: [SITE_ADDRESSES.public],
    pages: {
      '/r/*': { redirectFrom: (rest) => `/r/${(Number(rest) || 0) + 1}` },
      '/hops/*': { redirectFrom: (rest) => { const [left] = String(rest).split('/'); const n = Number(left) || 0; return n > 0 ? `/hops/${n - 1}` : null; }, body: html('<title>Arrived</title><meta property="og:title" content="Arrived"><meta property="product:price:amount" content="10">') },
    },
  };
}

function toPrivate() {
  return {
    dns: [SITE_ADDRESSES.public],
    pages: {
      '/': { redirect: 'http://10.0.0.5/admin' },
      '/meta': { redirect: 'http://169.254.169.254/latest/meta-data/' },
      '/internal': { redirect: 'https://internal.example/' },
      '/port': { redirect: 'https://shop.example:8080/' },
      '/ftp': { redirect: 'ftp://shop.example/file' },
      '/loopback': { redirect: 'http://[::1]/' },
    },
  };
}

function malformed() {
  const deep = '['.repeat(20_000) + ']'.repeat(20_000);
  return {
    dns: [SITE_ADDRESSES.public],
    pages: {
      '/': { body: `<html><head><title>Broken<title><meta property="og:title" content="Half <meta content='x><script type="application/ld+json">{"@type":"Product","name":</script><body><div><div><p>\u0000NUL\u0000 inside<img src=` },
      '/deep': { body: html(`<title>Deep</title><script type="application/ld+json">${deep}</script>`) },
      '/flood': { body: html('<title>Flood</title>' + '<meta property="og:x" content="y">'.repeat(100_000)) },
      '/unclosed': { body: '<html><head><title>Open' + '<a '.repeat(50_000) },
    },
  };
}

function wrongType() {
  return {
    dns: [SITE_ADDRESSES.public],
    pages: {
      '/product': { type: 'application/octet-stream', body: html('<title>Mug</title><meta property="og:title" content="Mug"><meta property="product:price:amount" content="99">') },
      '/image.png': { type: 'image/png', body: html('<title>Not an image</title>') },
      '/html-as-image': { type: 'text/html', body: png({ width: 4, height: 4 }) },
      '/products.json': { type: 'text/html', body: JSON.stringify({ products: [] }) },
      '/no-type': { type: '', body: html('<title>No type</title>') },
    },
  };
}

function gone() {
  return {
    dns: [SITE_ADDRESSES.public],
    pages: {
      '/products/missing': { status: 404, body: html('<title>Not found</title>') },
      '/products/removed': { status: 410, body: html('<title>Gone</title>') },
      '/products/flaky': { status: 500, body: html('<title>Error</title>') },
      '/products/price': { body: html(`<title>Steel bottle</title>${jsonLd({ '@type': 'Product', name: 'Steel bottle', image: 'https://gone.example/img/bottle.png', offers: { price: '999', priceCurrency: 'INR', availability: 'InStock' } })}`) },
      '/img/*': { body: () => png({ width: 1200, height: 1200, color: '#6A7B8C' }), type: 'image/png' },
    },
  };
}

function api() {
  return {
    dns: [SITE_ADDRESSES.public],
    pages: {
      '/api/products/1': { type: 'application/json', body: JSON.stringify({ id: 1, title: 'Steel bottle', price: 349, mrp: 499, inStock: true, url: 'https://api.example/p/steel-bottle', images: ['https://api.example/img/1.png'] }) },
      '/api/products/missing': { status: 404, type: 'application/json', body: JSON.stringify({ error: 'not found' }) },
      '/api/products/html': { type: 'text/html', body: html('<title>Maintenance</title>') },
      '/api/products/broken': { type: 'application/json', body: '{"id": 2, "title": "Half' },
      '/img/*': { body: () => png({ width: 800, height: 800, color: '#AA3355' }), type: 'image/png' },
    },
  };
}

/** A fresh copy of every fixture site, by host. */
export function fixtureSites() {
  return {
    'shop.example': shop(),
    'brand.example': brand(),
    'lowcontrast.example': lowContrast(),
    'inject.example': inject(),
    'scriptonly.example': scriptOnly(),
    'huge.example': huge(),
    'slow.example': slow(),
    'loop.example': loop(),
    'toprivate.example': toPrivate(),
    'internal.example': { dns: [SITE_ADDRESSES.private], pages: { '/': { body: html('<title>Intranet</title>') } } },
    'mixed.example': { dns: [SITE_ADDRESSES.public, SITE_ADDRESSES.private], pages: { '/': { body: html('<title>Mixed</title>') } } },
    'rebind.example': { dns: { sequence: [[SITE_ADDRESSES.public], [SITE_ADDRESSES.metadata]] }, pages: { '/': { body: html('<title>Rebind</title><meta property="og:title" content="Rebind lamp"><meta property="product:price:amount" content="120">') } } },
    'malformed.example': malformed(),
    'wrongtype.example': wrongType(),
    'gone.example': gone(),
    'api.example': api(),
  };
}
