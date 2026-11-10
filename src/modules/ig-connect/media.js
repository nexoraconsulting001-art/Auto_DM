import { ApiError } from '../../contracts/api/index.js';
import { log } from '../../platform/log.js';

const MEDIA_TYPE = { REELS: 'reel', STORY: 'story' };
const typeOf = (media) => MEDIA_TYPE[media.media_product_type] ?? 'post';

function postedAt(value) {
  const at = value ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
}

/** Graph's cursors can hold characters a Bhava cursor can't, so they travel encoded. */
const encodeCursor = (after) => Buffer.from(after).toString('base64url');
const decodeCursor = (cursor) => (cursor ? Buffer.from(cursor, 'base64url').toString() : undefined);

/**
 * One page of the builder's grid (PRD 6.8), read live from Instagram. Nothing is stored, so story media is only ever a reference (PRD 4.14).
 * Stories have their own Graph edge, so "all" puts them ahead of the first page of posts and reels.
 */
export function createMediaList({ repos, meta }) {
  async function read(client, { type, limit, after }) {
    if (type === 'story') return { media: await client.listStories({ limit, after }), stories: null };
    const firstPageOfAll = type === 'all' && !after;
    const [media, stories] = await Promise.all([
      client.listMedia({ limit, after }),
      // A missing story edge must not cost the seller the grid (whether it exists under Instagram Login is to confirm).
      firstPageOfAll ? client.listStories({ limit }).catch(() => ({ data: [] })) : null,
    ]);
    return { media, stories };
  }

  return async function list({ type, limit, cursor }) {
    const account = await repos.igAccounts.current();
    if (!account) return { items: [], nextCursor: null };
    let answer;
    try {
      answer = await read(meta.client.forAccount(account), { type, limit, after: decodeCursor(cursor) });
    } catch (err) {
      if (err.kind === 'token_invalid') {
        await repos.igAccounts.loseToken(account.igUserId, 'token.rejected', { actor: 'system:media-list', details: { cause: 'read_refused', code: err.code ?? null } });
        throw new ApiError('conflict', 'Instagram stopped accepting your connection. Reconnect Instagram to see your posts.', { reason: 'paused.reconnect' });
      }
      log.warn('ig_media.read_failed', { kind: err.kind, status: err.status, code: err.code });
      throw new ApiError('conflict', 'Instagram isn’t answering right now. Try again in a moment.');
    }
    const media = [...(answer.stories?.data ?? []), ...(answer.media.data ?? [])].filter((m) => type === 'all' || typeOf(m) === type);
    const automations = await repos.igConnect.automationsForMedia(media.map((m) => String(m.id)));
    const after = answer.media.paging?.next ? answer.media.paging?.cursors?.after : null;
    return {
      items: media.map((m) => ({
        id: String(m.id),
        type: typeOf(m),
        caption: String(m.caption ?? ''),
        permalink: String(m.permalink ?? ''),
        thumbnailUrl: String(m.thumbnail_url ?? m.media_url ?? ''),
        postedAt: postedAt(m.timestamp),
        automationId: automations.get(String(m.id)) ?? null,
      })),
      nextCursor: after ? encodeCursor(after) : null,
    };
  };
}
