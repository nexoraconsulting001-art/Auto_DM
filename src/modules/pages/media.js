import { CATALOG_LIMITS as L } from '../../contracts/catalog.js';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';

/**
 * What a landing page shows for its reel, post or story (PRD 8.10), and keeping those addresses fresh. Instagram's media
 * addresses expire, so they are read again in the background, at most every 6 hours per page and never while the shopper
 * waits. A story's media is only ever an address: nothing is downloaded or re-hosted, and once the story has expired the
 * address is dropped and the page shows the owner's cover image or the first product's photo (4.14, K-31).
 */

const HOUR = 3_600_000;
const MEDIA_TYPES = new Set(['VIDEO', 'IMAGE', 'CAROUSEL_ALBUM']);
const httpsLink = (value) => (/^https:\/\/[^\s"'<>\\]{1,1990}$/i.test(String(value ?? '')) ? String(value) : '');

/** reel, post or story, from what Instagram calls the media. */
export function kindOfMedia(media) {
  const product = String(media?.media_product_type ?? '').toUpperCase();
  if (product === 'STORY') return 'story';
  if (product === 'REELS') return 'reel';
  return 'post';
}

/** The columns of `reels` a media object fills. `kind` decides the expiry: a story is gone 24 hours after it was posted. */
export function mediaColumns(media = {}, kind, now = new Date()) {
  const type = MEDIA_TYPES.has(media.media_type) ? media.media_type : '';
  const mediaUrl = httpsLink(media.media_url);
  const posted = media.timestamp && !Number.isNaN(Date.parse(media.timestamp)) ? new Date(media.timestamp) : null;
  const columns = {
    media_type: type,
    media_url: mediaUrl,
    thumbnail_url: httpsLink(media.thumbnail_url) || (type === 'VIDEO' ? '' : mediaUrl),
    video_url: type === 'VIDEO' ? mediaUrl : '',
    permalink: httpsLink(media.permalink),
    caption: String(media.caption ?? '').slice(0, 500),
    posted_at: posted,
    expires_at: null,
  };
  if (kind === 'story') {
    columns.posted_at = posted ?? now;
    columns.expires_at = new Date(columns.posted_at.getTime() + L.storyHours * HOUR);
    // A story that is already over keeps no address at all (4.14).
    if (columns.expires_at <= now) Object.assign(columns, { media_url: '', thumbnail_url: '', video_url: '' });
  }
  return columns;
}

export const storyExpired = (page, now = new Date()) => page.kind === 'story' && (!page.expires_at || new Date(page.expires_at) <= now);

const coverOf = (page) => (page.cover_media_id ? `/media/${page.cover_media_id}` : '');
const firstProductImage = (page) => page.products?.find((p) => p.image_url)?.image_url ?? '';

/**
 * The hero's media: { imageUrl, videoUrl, linkUrl }. media_url, else the thumbnail (video only), else a link to the post
 * itself. An expired story shows the cover or the first product's photo, and never the story.
 */
export function heroMedia(page, now = new Date()) {
  if (storyExpired(page, now)) return { imageUrl: coverOf(page) || firstProductImage(page), videoUrl: '', linkUrl: '' };
  const type = page.media_type || (page.video_url ? 'VIDEO' : '');
  // A story's permalink stops working with the story, so it is never offered as the way to watch.
  const linkUrl = page.kind === 'story' ? '' : page.permalink || '';
  if (type === 'VIDEO') {
    const videoUrl = page.media_url || page.video_url || '';
    const poster = page.thumbnail_url || coverOf(page) || firstProductImage(page);
    return videoUrl ? { imageUrl: poster, videoUrl, linkUrl: '' } : { imageUrl: poster, videoUrl: '', linkUrl };
  }
  const imageUrl = page.media_url || page.thumbnail_url || coverOf(page) || firstProductImage(page);
  return { imageUrl, videoUrl: '', linkUrl };
}

/** The image a share preview is drawn from: the owner's cover, the post's own picture (never a story's), then a product's. */
export function shareSource(page) {
  const cover = coverOf(page);
  if (cover) return cover;
  if (page.kind !== 'story') {
    const own = page.thumbnail_url || (page.media_type === 'VIDEO' ? '' : page.media_url);
    if (own) return own;
  }
  return firstProductImage(page);
}

/**
 * Returns refresh(page): reads the page's media again when it is due, in the background. Each page is read by one request
 * at a time, and a failure waits for the next due time.
 */
export function createMediaRefresher({ repos, ig, now = () => new Date() }) {
  const running = new Set();
  return function refresh(page, { onChange } = {}) {
    const key = `${tenantId()}:${page.id}`;
    if (running.has(key)) return null;
    const checked = new Date(page.media_checked_at ?? 0).getTime();
    const expired = storyExpired(page, now());
    // An expired story is only ever cleared, once: there is nothing left to read.
    if (expired && !(page.media_url || page.thumbnail_url || page.video_url)) return null;
    if (!expired && now().getTime() - checked < L.mediaRefreshHours * HOUR) return null;
    if (!expired && (page.channel !== 'instagram' || !ig?.getMedia)) return null;
    running.add(key);
    const work = (async () => {
      if (expired) {
        await repos.landingPages.clearStoryMedia(page.id);
        return;
      }
      const account = await repos.igAccounts.current();
      if (!account?.token) return repos.landingPages.touchMediaCheck(page.id);
      const media = await ig.getMedia(account, page.ig_media_id);
      if (!media) return repos.landingPages.touchMediaCheck(page.id);
      const columns = mediaColumns(media, page.kind, now());
      await repos.landingPages.updateMedia(page.id, { mediaUrl: columns.media_url, thumbnailUrl: columns.thumbnail_url, permalink: columns.permalink, mediaType: columns.media_type || page.media_type || '' });
      if (onChange) await onChange();
    })()
      .catch(async (err) => {
        log.warn('page.media_refresh_failed', { page: page.id, status: err?.status, code: err?.code });
        await repos.landingPages.touchMediaCheck(page.id).catch(() => {});
      })
      .finally(() => running.delete(key));
    return work;
  };
}
