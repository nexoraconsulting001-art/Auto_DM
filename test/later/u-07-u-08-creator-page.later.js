// PRD 2 and 8.14: the Free creator page and its made-with mark. Moved unchanged from test/p0/spec-p0/white-label.test.js,
// because the creator page is built in Phase 7, which this run does not build. See requirements/later.json.
// The name ends in .later.js so no runner picks it up. To bring it back, rename it to *.test.js under the phase that builds the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addBusiness, addReel, assertBuyerPageClean, hit, need, noPlatformName, setPlan, startWorld } from '../p0/spec-p0/support.js';
import { buyerPaths } from '../p0/spec-p0/surfaces.js';

const REEL = '17900000000000030';

async function creator(t) {
  const app = await startWorld(t);
  const priya = await addBusiness(app, { slug: 'priya', name: 'Priya Styles', plan: 'free' });
  await addReel(priya, REEL);
  return { app, priya, page: () => hit(app, buyerPaths.creatorPage('priya'), { host: priya.host }) };
}

const MARK = /Made with Bhava/i;

test('U-07: a Free creator\'s page shows the made-with mark', async (t) => {
  const { page } = await creator(t);
  const res = need(await page(), 200, 'The creator page');
  assert.match(res.text, MARK);
});

test('U-08: upgrading from Free to Tier 1 removes the mark at once, and no buyer surface shows the platform', async (t) => {
  const { app, priya, page } = await creator(t);
  assert.match(need(await page(), 200, 'The creator page on Free').text, MARK);
  await setPlan(app, priya, 't1');
  const after = need(await page(), 200, 'The creator page after upgrading');
  assert.doesNotMatch(after.text, MARK);
  noPlatformName('The creator page after upgrading', after.text);
  noPlatformName('The creator page headers after upgrading', after.headers);
  for (const pathname of ['/', '/shop']) await assertBuyerPageClean(app, priya, pathname);
});
