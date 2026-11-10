// Suggesting which Facebook post is which Instagram reel (PRD 6.10): a pure function, so the edges can be exact.
import '../../../tools/net-guard.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SUGGESTIONS, captionSimilarity, suggestLinks, timeCloseness } from '../../../src/modules/facebook/match.js';

const at = (hours) => new Date(Date.UTC(2026, 9, 1) + hours * 3_600_000).toISOString();
const post = (id, message, hours = 0) => ({ id, message, postedAt: at(hours) });
const reel = (id, caption, hours = 0) => ({ id, caption, postedAt: at(hours) });

test('the same caption and the same moment is a near-certain match', () => {
  const [one] = suggestLinks({ posts: [post('p1', 'Summer kurta drop')], media: [reel('r1', 'Summer kurta drop')] });
  assert.deepEqual(one, { fbPostId: 'p1', igMediaId: 'r1', score: 1 });
});

test('captions are compared by their words: case, punctuation and hashtags do not matter', () => {
  assert.equal(captionSimilarity('Summer KURTA, drop!', 'summer kurta drop'), 1);
  assert.equal(captionSimilarity('#summer kurta', 'summer kurta'), 1);
  assert.equal(captionSimilarity('नई साड़ी', 'नई साड़ी'), 1);
});

test('nothing in common, or no words at all, is no similarity', () => {
  assert.equal(captionSimilarity('Blue shoes', 'Red bag'), 0);
  assert.equal(captionSimilarity('', 'Red bag'), 0);
  assert.equal(captionSimilarity('!!!', '...'), 0);
  assert.equal(captionSimilarity(undefined, null), 0);
});

test('posting time counts for less and less, and stops counting at 72 hours', () => {
  assert.equal(timeCloseness(at(0), at(0)), 1);
  assert.equal(timeCloseness(at(0), at(36)), 0.5);
  assert.equal(timeCloseness(at(0), at(-72)), 0);
  assert.equal(timeCloseness(at(0), at(500)), 0);
  assert.equal(timeCloseness(null, at(0)), 0);
  assert.equal(timeCloseness(at(0), 'not a time'), 0);
});

test('posting at the same time is not enough on its own', () => {
  assert.deepEqual(suggestLinks({ posts: [post('p1', 'Blue shoes')], media: [reel('r1', 'Red bag')] }), []);
});

test('the same caption posted again later goes to the copy posted closest', () => {
  const posts = [post('p1', 'Sale on now', 0)];
  const media = [reel('old', 'Sale on now', -200), reel('twin', 'Sale on now', 1)];
  assert.deepEqual(suggestLinks({ posts, media }).map((s) => s.igMediaId), ['twin']);
});

test('each post and each reel is suggested once, so taking them all cannot break one-to-one', () => {
  const posts = [post('p1', 'Sale on now', 0), post('p2', 'Sale on now', 2)];
  const media = [reel('r1', 'Sale on now', 0)];
  const out = suggestLinks({ posts, media });
  assert.equal(out.length, 1);
  assert.equal(out[0].fbPostId, 'p1');
});

test('what is already linked or was turned down is never offered', () => {
  const posts = [post('p1', 'Sale on now'), post('p2', 'New shoes in'), post('p3', 'Winter coat')];
  const media = [reel('r1', 'Sale on now'), reel('r2', 'New shoes in'), reel('r3', 'Winter coat')];
  const out = suggestLinks({ posts, media, confirmedPosts: new Set(['p1']), confirmedMedia: new Set(['r2']), rejected: new Set(['p3\nr3']) });
  assert.deepEqual(out, []);
});

test('the list is capped, and in a stable order', () => {
  const posts = Array.from({ length: MAX_SUGGESTIONS + 5 }, (_, i) => post(`p${String(i).padStart(3, '0')}`, `caption number ${i}`));
  const media = posts.map((p, i) => reel(`r${String(i).padStart(3, '0')}`, p.message));
  const first = suggestLinks({ posts, media });
  assert.equal(first.length, MAX_SUGGESTIONS);
  assert.deepEqual(suggestLinks({ posts: [...posts].reverse(), media: [...media].reverse() }), first);
  assert.ok(first.every((s) => s.score >= 0 && s.score <= 1));
});
