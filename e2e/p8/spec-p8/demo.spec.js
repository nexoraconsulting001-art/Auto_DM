// Q-10: each demo script is walked end to end in a browser on the seeded data. Every step that names an address is opened as the
// person the script is for (the owner on the console, a shopper on the business's own host), every control it names must be
// on the screen, and a step that no longer matches the product fails here. The text checks (numbering, topics, what is simulated)
// are in test/p8/spec-p8/demo-kit.test.js.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

process.env.PLATFORM_DOMAIN = 'shops.example';
const { PHONE, expectHealthy, openWorld, ownWorker, signInWithCode } = await import('../../p5/console/support.js');
const { seedShowcase, loadShowcase } = await import('../../../scripts/showcase.js');
const { repoRoot, filesUnder, read } = await import('../../../test/p8/spec-p8/support.js');

test.use({ viewport: PHONE, ...ownWorker('P8Demo') });

const businesses = loadShowcase();
const scripts = filesUnder('docs/showcase', { ext: ['.md'] }).filter((f) => !/readme|index/i.test(path.basename(f)));
const STEP = /^\s*(\d{1,3})[.)]\s+(.+)$/;
const steps = (text) => text.split(/\r?\n/).map((l) => STEP.exec(l)).filter(Boolean).map((m) => ({ n: Number(m[1]), text: m[2], tokens: [...m[2].matchAll(/`([^`]+)`/g)].map((t) => t[1].trim()) }));
const isRoute = (t) => /^\/[A-Za-z0-9/_-]*$/.test(t);
const ownerOf = (text, index) => businesses.find((b) => text.includes(b.seed.business.name) || text.includes(b.seed.business.slug)) ?? businesses[index % businesses.length];

let world;
let seeded;
test.beforeAll(async () => {
  test.setTimeout(600_000);
  world = await openWorld();
  seeded = await seedShowcase({ db: world.app.db, repos: world.app.platform, ctx: world.app.ctx, businesses });
});
test.afterAll(async () => {
  await world?.close();
});

test('Q-10: there is one script per business to walk', () => {
  expect(scripts.length, 'docs/showcase holds a script for every business').toBeGreaterThanOrEqual(businesses.length);
  for (const file of scripts) expect(steps(fs.readFileSync(path.join(repoRoot, file), 'utf8')).length, file).toBeGreaterThanOrEqual(10);
});

for (const [index, file] of scripts.entries()) {
  test(`Q-10: ${path.basename(file)} is walked step by step in the browser on the seeded data`, async ({ page, browser }) => {
    test.setTimeout(600_000);
    const text = read(file);
    const business = ownerOf(text, index);
    const result = seeded.find((r) => r.key === business.key);
    const phone = business.seed.business.owner.phone;
    await signInWithCode(page, world, phone, { url: world.signInUrl('/admin') });
    const shopper = await browser.newContext({ viewport: PHONE, extraHTTPHeaders: { 'x-forwarded-host': `${result.slug}.shops.example` } });
    const buyer = await shopper.newPage();
    const walked = [];
    for (const step of steps(text)) {
      const routes = step.tokens.filter(isRoute);
      const labels = step.tokens.filter((t) => !isRoute(t) && !/[<{>}$]/.test(t));
      for (const route of routes) {
        if (/[<{>}$]/.test(route)) continue;
        const onConsole = route.startsWith('/admin');
        const target = onConsole ? page : buyer;
        const response = await target.goto(onConsole ? world.signInUrl(route) : `${world.shopUrl(route)}`);
        const where = `${path.basename(file)} step ${step.n}: ${route}`;
        expect(response?.status() ?? 200, `${where} answered`).toBeLessThan(400);
        const body = (await target.locator('body').innerText()).trim();
        expect(body.length, `${where} is not blank`).toBeGreaterThan(20);
        expect(body, `${where} is not an error page`).not.toMatch(/page not found|not found|something went wrong|cannot get/i);
        if (onConsole) {
          await expect(target, `${where} stayed signed in`).not.toHaveURL(/sign-?in/i);
          await expect(target.getByRole('navigation', { name: 'Main' }).first(), where).toBeAttached();
        } else {
          expect(body, `${where}: a buyer sees the seller's brand`).not.toMatch(/bhava/i);
        }
        for (const label of labels) await expect(target.getByText(label, { exact: false }).first(), `${where}: "${label}" is on the screen`).toBeVisible();
        walked.push(route);
      }
      if (!routes.length) for (const label of labels) {
        // A step that only names a control: it must exist somewhere on the console or the buyer's page the script is on.
        const found = (await page.getByText(label, { exact: false }).count()) + (await buyer.getByText(label, { exact: false }).count());
        const inSource = filesUnder('console/src', { ext: ['.jsx', '.js'] }).some((f) => read(f).includes(label)) || filesUnder('src', { ext: ['.js', '.html'] }).some((f) => read(f).includes(label));
        expect(found > 0 || inSource, `${path.basename(file)} step ${step.n}: "${label}" is gone from the product`).toBe(true);
      }
    }
    expect(walked.length, 'the script names addresses to open').toBeGreaterThanOrEqual(5);
    await expectHealthy(page);
    await shopper.close();
  });
}
