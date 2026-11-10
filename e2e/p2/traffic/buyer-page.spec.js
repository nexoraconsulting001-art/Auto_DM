// A real browser on a phone: what a buyer page sends, and what it must not, with the seller's pixels off, on without consent, and on with it.
import { expect, test } from '@playwright/test';
import { TAG_HOSTS } from '../../../src/contracts/analytics.js';
import { seedReel } from '../../../test/helpers.js';
import { api, startTraffic } from '../../../test/p2/traffic/support.js';

const yes = { built: true, analyticsAndAds: async () => ({ granted: true, answered: true, reason: 'accepted' }) };
const TAG_ORIGINS = [...TAG_HOSTS.meta, ...TAG_HOSTS.ga4];

const pixelOn = (world) => api(world, '/tags', { method: 'PATCH', body: { meta: { enabled: true, pixelId: '1234567890' }, ga4: { enabled: true, measurementId: 'G-ABC123' } } });

/** Every request the page tries to make to Meta or Google. They can't actually leave: the test browser has no route out. */
function watchTags(page) {
  const seen = [];
  page.on('request', (request) => {
    if (TAG_ORIGINS.some((origin) => request.url().startsWith(origin))) seen.push(request.url());
  });
  return seen;
}

test('a shopper\'s visit is counted, taps are recorded, and no tag or outside host is touched', async ({ page }) => {
  const world = await startTraffic({ at: Date.now() });
  try {
    const { reel, products } = await seedReel(world.repos, { n: 2 });
    const tags = watchTags(page);
    const hits = [];
    page.on('request', (request) => {
      if (request.url().includes('/_t/e')) hits.push(request.postDataJSON());
    });

    const [response, document_] = await Promise.all([page.waitForResponse((r) => r.url().includes('/_t/e')), page.goto(`${world.base}/r/${reel.slug}?utm_source=instagram&utm_medium=dm&utm_campaign=brunch`)]);
    expect(response.status()).toBe(204);
    for (const origin of TAG_ORIGINS) expect(document_.headers()['content-security-policy']).not.toContain(origin);
    await expect.poll(() => hits.map((h) => h.name).sort()).toEqual(['landing_view', 'page_view']);
    expect(hits[0].utm.medium).toBe('dm');
    expect(hits.every((h) => !JSON.stringify(h).includes('phone'))).toBe(true);
    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === '_vid')?.httpOnly).toBe(true);

    await page.evaluate(() => document.addEventListener('click', (e) => e.preventDefault(), { once: true }));
    await page.locator(`a[href*="/p/${products[0].slug}"]`).first().click();
    await expect.poll(() => hits.map((h) => h.name)).toContain('product_tap');

    await expect.poll(async () => (await api(world, '/traffic/summary')).body.sessions.value).toBe(1);
    const sources = (await api(world, '/traffic/sources')).body;
    expect(sources.items[0].source).toBe('instagram_comment_dm');
    expect(tags).toEqual([]);
    expect(await page.content()).not.toMatch(/bhava/i);
  } finally {
    world.close();
  }
});

test('pixels on but no answer to the banner: the policy may name the hosts, and nothing goes to them', async ({ page }) => {
  const world = await startTraffic({ at: Date.now() });
  try {
    const { reel } = await seedReel(world.repos);
    await pixelOn(world);
    const tags = watchTags(page);
    await Promise.all([page.waitForResponse((r) => r.url().includes('/_t/e')), page.goto(`${world.base}/r/${reel.slug}`)]);
    expect(tags).toEqual([]);
    expect(await page.evaluate(() => typeof window.fbq)).toBe('undefined');
    await expect.poll(async () => (await api(world, '/traffic/summary')).body.sessions.value).toBe(1);
  } finally {
    world.close();
  }
});

test('with consent, the seller\'s tags are asked for, and the browser and server share one event id', async ({ page }) => {
  const world = await startTraffic({ at: Date.now(), consent: yes });
  try {
    const { reel } = await seedReel(world.repos);
    await pixelOn(world);
    const tags = watchTags(page);
    await Promise.all([page.waitForResponse((r) => r.url().includes('/_t/e')), page.goto(`${world.base}/r/${reel.slug}`)]);
    await expect.poll(() => tags.some((url) => url.includes('fbevents.js'))).toBe(true);
    await expect.poll(() => tags.some((url) => url.includes('gtag/js?id=G-ABC123'))).toBe(true);
    const shared = await page.evaluate(() => {
      const fromScript = document.querySelector('script[data-e]').dataset.e;
      const pageView = window.fbq.queue.find((call) => call[0] === 'track' && call[1] === 'PageView');
      return { fromScript, fromPixel: pageView?.[3]?.eventID };
    });
    expect(shared.fromPixel).toBe(shared.fromScript);
  } finally {
    world.close();
  }
});
