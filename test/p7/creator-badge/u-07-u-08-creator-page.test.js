// PRD 2, 3 and 8.14: the Free creator page and its made-with mark (U-07, U-08). Moved from test/later, where it waited for
// Phase 7; the test for the clean DM stays in test/p0/spec-p0/white-label.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addBusiness, addReel, assertBuyerPageClean, hit, need, noPlatformName, setPlan, signIn, startWorld } from '../../p0/spec-p0/support.js';
import { buyerPaths } from '../../p0/spec-p0/surfaces.js';

const REEL = '17900000000000030';

async function creator(t) {
  const app = await startWorld(t);
  const priya = await addBusiness(app, { slug: 'priya', name: 'Priya Styles', plan: 'free' });
  await addReel(priya, REEL);
  // The creator page is the business's own to switch on (8.14): the owner names it and turns it on, as in the console.
  const token = await signIn(app, priya);
  need(await hit(app, '/api/v1/creator-page', { host: priya.host, method: 'PATCH', token, body: { slug: 'priya', enabled: true } }), 200, 'Turning the creator page on');
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
