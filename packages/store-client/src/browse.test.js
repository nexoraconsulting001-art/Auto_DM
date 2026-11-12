import { cardOf, createBrowse, createStoreClient, formatPaise, percentOff, pinnedFirst, plainText, safeUrl } from './index.js';

test('prices are whole paise, formatted and never worked out', () => {
  expect(formatPaise(129900)).toBe('₹1,299');
  expect(formatPaise(129950)).toBe('₹1,299.50');
  expect(formatPaise(0)).toBe('₹0');
  expect(formatPaise(5)).toBe('₹0.05');
  expect(formatPaise(12345678900)).toBe('₹12,34,56,789');
  expect(formatPaise(99900, { symbol: 'Rs ' })).toBe('Rs 999');
  expect(formatPaise(10.5)).toBe('');
  expect(formatPaise('1200')).toBe('');
  expect(formatPaise(null)).toBe('');
});

test('a discount is shown only when the server sent a higher compare price', () => {
  expect(percentOff(75000, 100000)).toBe(25);
  expect(percentOff(100000, 100000)).toBeNull();
  expect(percentOff(120000, 100000)).toBeNull();
  expect(percentOff(null, 100000)).toBeNull();
  expect(cardOf('https://shop.example', { slug: 'a', pricePaise: 500, comparePaise: 400 }).comparePaise).toBeNull();
});

test('only https addresses, and the store’s own paths, are ever loaded as images or videos', () => {
  const origin = 'https://shop.example';
  expect(safeUrl(origin, 'https://cdn.example/a.jpg')).toBe('https://cdn.example/a.jpg');
  expect(safeUrl(origin, '/media/a.jpg')).toBe('https://shop.example/media/a.jpg');
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'file:///etc/passwd', '//evil.example/a.jpg', 'http://cdn.example/a.jpg', 'https://x.example/a b.jpg', 'https://x.example/"onerror=1', '', null, 5]) expect(safeUrl(origin, bad)).toBe('');
  expect(safeUrl('http://localhost:4010', 'http://localhost:4010/m/a.jpg')).toBe('http://localhost:4010/m/a.jpg');
});

test('seller text is plain text: tags and scripts are removed, entities read', () => {
  expect(plainText('<b>Soft</b> cotton<script>alert(1)</script><br>Wash cold &amp; dry')).toBe('Soft cotton\nWash cold & dry');
  expect(plainText('<img src=x onerror=alert(1)>Hi')).toBe('Hi');
  expect(plainText('<p>One</p><p>Two</p>')).toBe('One\nTwo');
  expect(plainText(undefined)).toBe('');
});

test('pinned reels come first and every group keeps the seller’s order', () => {
  const reels = [{ slug: 'a' }, { slug: 'b', pinned: true }, { slug: 'c' }, { slug: 'd', pinned: true }];
  expect(pinnedFirst(reels).map((r) => r.slug)).toEqual(['b', 'd', 'a', 'c']);
  expect(pinnedFirst(pinnedFirst(reels)).map((r) => r.slug)).toEqual(['b', 'd', 'a', 'c']);
  expect(pinnedFirst(null)).toEqual([]);
});

function browseWith(answers) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const path = new URL(url).pathname;
    const body = answers[path];
    if (body === undefined) return { ok: false, status: 404, json: async () => ({ error: 'Not found', code: 'not_found' }) };
    return { ok: true, status: 200, json: async () => body };
  };
  const client = createStoreClient({ origin: 'https://shop.example', tenantId: 3, version: '1.0.0', platform: 'android', fetch });
  return { browse: createBrowse(client), calls };
}

test('a product is read as the server states it, with unsafe parts dropped', async () => {
  const { browse, calls } = browseWith({
    '/api/store/app/products/pot': {
      id: 9, slug: 'pot', name: '<i>Pot</i>', pricePaise: 49900, comparePaise: 59900, image: '/m/pot.jpg', inStock: true, rating: 4.5, ratingCount: 3,
      description: '<script>x</script>Hand made', images: ['/m/1.jpg', 'javascript:1', 'https://cdn.example/2.jpg'],
      options: [{ name: 'Colour', values: ['Red', 'Blue'] }, { name: '', values: ['x'] }],
      variants: [{ id: 1, option: 'Red', pricePaise: 49900, inStock: true, image: '' }, { id: 2, option: 'Blue', pricePaise: 52900, inStock: false, image: '/m/b.jpg' }],
      maxQty: 4, reels: [{ slug: 'r1', title: 'T', image: '/m/r.jpg', videoUrl: 'data:video/mp4;base64,AA', pinned: false, productCount: 2 }],
    },
  });
  const product = await browse.product('pot');
  expect(product).toMatchObject({ name: 'Pot', pricePaise: 49900, comparePaise: 59900, description: 'Hand made', maxQty: 4, inStock: true });
  expect(product.images).toEqual(['https://shop.example/m/1.jpg', 'https://cdn.example/2.jpg']);
  expect(product.options).toEqual([{ name: 'Colour', values: ['Red', 'Blue'] }]);
  expect(product.variants.map((v) => v.inStock)).toEqual([true, false]);
  expect(product.reels[0].videoUrl).toBe('');
  expect(calls[0].headers.authorization).toBeUndefined();
  await expect(browse.product('gone')).rejects.toMatchObject({ code: 'not_found' });
});

test('an answer with missing parts still reads as empty lists, never a crash', async () => {
  const { browse } = browseWith({ '/api/store/app/home': {}, '/api/store/app/catalog': { items: [{ slug: '' }, null] } });
  expect(await browse.home()).toEqual({ blocks: [], categories: [], reels: [], products: [] });
  expect(await browse.catalog()).toEqual({ items: [], nextCursor: null });
});
