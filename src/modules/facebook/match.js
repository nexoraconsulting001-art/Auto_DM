const HOUR = 3_600_000;
const CAPTION_WEIGHT = 0.75;
const TIME_WEIGHT = 0.25;
/** Cross-posted copies go up together. Past this gap the posting time says nothing either way. */
const TIME_HORIZON_MS = 72 * HOUR;
/** Half the words in common. Time alone never suggests a pair: many posts go up at about the same time. */
const MIN_CAPTION = 0.5;
export const MAX_SUGGESTIONS = 50;

const wordsOf = (text) => new Set(String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

/** Shared words over all words, 0 to 1. Two captions with no words at all match nothing. */
export function captionSimilarity(a, b) {
  const [left, right] = [wordsOf(a), wordsOf(b)];
  if (!left.size || !right.size) return 0;
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / (left.size + right.size - shared);
}

/** 1 for the same moment, falling to 0 at the horizon. 0 when either time is unknown. */
export function timeCloseness(a, b) {
  if (!a || !b) return 0;
  const gap = Math.abs(new Date(a).getTime() - new Date(b).getTime());
  return Number.isNaN(gap) ? 0 : Math.max(0, 1 - gap / TIME_HORIZON_MS);
}

/**
 * Which Facebook post looks like which Instagram reel or post (PRD 6.10), best first. Only a suggestion: the owner confirms.
 *
 *   posts: [{ id, message, postedAt }]       media: [{ id, caption, postedAt }]
 *   confirmedPosts, confirmedMedia: Sets     what is already linked, so it is never offered
 *   rejected: Set of `${postId}\n${mediaId}` what the owner has already turned down
 *
 * Each post and each reel appears at most once, so taking every suggestion can't break the one-to-one rule.
 */
export function suggestLinks({ posts, media, confirmedPosts = new Set(), confirmedMedia = new Set(), rejected = new Set() }) {
  const pairs = [];
  for (const post of posts) {
    if (confirmedPosts.has(post.id)) continue;
    for (const item of media) {
      if (confirmedMedia.has(item.id) || rejected.has(`${post.id}\n${item.id}`)) continue;
      const caption = captionSimilarity(post.message, item.caption);
      if (caption < MIN_CAPTION) continue;
      pairs.push({ fbPostId: post.id, igMediaId: item.id, score: Number((CAPTION_WEIGHT * caption + TIME_WEIGHT * timeCloseness(post.postedAt, item.postedAt)).toFixed(3)) });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.fbPostId.localeCompare(b.fbPostId) || a.igMediaId.localeCompare(b.igMediaId));
  const [usedPosts, usedMedia] = [new Set(), new Set()];
  const picked = [];
  for (const pair of pairs) {
    if (usedPosts.has(pair.fbPostId) || usedMedia.has(pair.igMediaId)) continue;
    usedPosts.add(pair.fbPostId);
    usedMedia.add(pair.igMediaId);
    picked.push(pair);
    if (picked.length === MAX_SUGGESTIONS) break;
  }
  return picked;
}
