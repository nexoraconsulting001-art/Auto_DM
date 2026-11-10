import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleComment, matchesKeyword } from '../src/handler.js';
import { forAccount } from '../src/instagram.js';
import { REEL_ID, fakeIg, seedReel, setup } from './helpers.js';

const comment = (id, text, user = 'u1', media = REEL_ID) => ({ id, text, media: { id: media }, from: { id: user, username: 'asha' } });
const storeUrl = (slug) => `https://shop.test/r/${slug}?src=dm`;

async function ctx(opts = {}) {
  const { repos } = await setup();
  await seedReel(repos, opts);
  const ig = fakeIg(opts);
  return { repos, ig, deps: { repos, ig: forAccount(ig, { igUserId: 'ME', token: 't' }), ownIds: new Set(['ME']), storeUrl, oneDmPerUser: opts.oneDmPerUser } };
}

test('a keyword comment gets a DM with a button to the reel store, and is logged', async () => {
  const { repos, ig, deps } = await ctx();
  assert.equal(await handleComment(comment('c1', 'LINK please'), deps), 'sent');
  assert.deepEqual(ig.calls[0], ['button', 'c1', 'Hey @asha! Here’s everything from the reel 👇', 'https://shop.test/r/brunch-edit?src=dm', 'Shop now']);
  const [row] = await repos.activity.list();
  assert.equal(row.result, 'sent');
  assert.equal(row.username, 'asha');
});

test('skips wrong keyword, unknown reel and own comments; repeat comments still get a DM', async () => {
  const { ig, deps } = await ctx();
  assert.equal(await handleComment(comment('c1', 'nice video'), deps), 'skip:no-keyword');
  assert.equal(await handleComment(comment('c2', 'LINK', 'u1', '999'), deps), 'skip:unmapped-reel');
  assert.equal(await handleComment(comment('c3', 'LINK', 'ME'), deps), 'skip:own-comment');
  assert.equal(await handleComment(comment('c4', 'LINK'), deps), 'sent');
  assert.equal(await handleComment(comment('c5', 'LINK again'), deps), 'sent');
  assert.equal(ig.calls.filter((c) => c[0] === 'button').length, 2);
});

test('a webhook delivered twice (even concurrently) sends only one DM', async () => {
  const { ig, deps } = await ctx();
  const results = await Promise.all([handleComment(comment('c1', 'LINK'), deps), handleComment(comment('c1', 'LINK'), deps)]);
  assert.deepEqual(results.sort(), ['sent', 'skip:duplicate-comment']);
  assert.equal(await handleComment(comment('c1', 'LINK'), deps), 'skip:duplicate-comment');
  assert.equal(ig.calls.length, 1);
});

test('paused reels send nothing', async () => {
  const { deps } = await ctx({ active: '' });
  assert.equal(await handleComment(comment('c1', 'LINK'), deps), 'skip:unmapped-reel');
});

test('ONE_DM_PER_USER limits each person to one DM per reel', async () => {
  const { deps } = await ctx({ oneDmPerUser: true });
  assert.equal(await handleComment(comment('c1', 'LINK'), deps), 'sent');
  assert.equal(await handleComment(comment('c2', 'LINK'), deps), 'skip:already-sent-to-user');
});

test('falls back to plain text with the link when the button is rejected', async () => {
  const { ig, deps } = await ctx({ failButton: true });
  assert.equal(await handleComment(comment('c1', 'LINK'), deps), 'sent');
  assert.deepEqual(ig.calls[0], ['text', 'c1', 'Hey @asha! Here’s everything from the reel 👇\nhttps://shop.test/r/brunch-edit?src=dm']);
});

test('keyword matching is case-insensitive and whole-word', () => {
  assert.ok(matchesKeyword('Link 🙏', ['LINK']));
  assert.ok(matchesKeyword('send me the #link', ['LINK']));
  assert.ok(!matchesKeyword('linkedin', ['LINK']));
});
