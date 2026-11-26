import crypto from 'node:crypto';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { shareSource } from './media.js';

/**
 * Share previews (PRD 8.12): one 1200 x 630 image per landing page, drawn on the brand's ground colour and stored as a new
 * media file each time what it shows changes. A new file has a new address, so a crawler that caches by address can never show
 * the old picture (K-39). The image is made when the page is saved, or in the background after a visit finds it out of date:
 * a page view itself never waits for an outside call.
 */

const RETRY_AFTER_MS = 10 * 60_000;
const MEDIA_PATH = /^\/media\/([0-9a-f-]{36})$/i;

export const previewTarget = (page) => `page:${page.id}`;

/** What the image is drawn from, as a short hash: change the picture or the ground colour and the version changes. */
export function previewVersion(page, theme) {
  return crypto.createHash('sha256').update(JSON.stringify([shareSource(page), theme.colors.ground])).digest('hex').slice(0, 16);
}

/** The same version rule for any target (a creator page, a shelf): the picture and the ground colour. */
export const targetVersion = (source, ground) => crypto.createHash('sha256').update(JSON.stringify([source || '', ground])).digest('hex').slice(0, 16);

export function createSharePreviews({ repos, platform }) {
  const running = new Map();
  // When a picture last couldn't be read, so a busy page doesn't ask its source again on every view. Kept small.
  const failedAt = new Map();
  const noteFailure = (key) => {
    if (failedAt.size > 5000) failedAt.clear();
    failedAt.set(key, Date.now());
  };

  async function sourceBytes(source) {
    if (!source) return null;
    const own = MEDIA_PATH.exec(source);
    if (own) return (await repos.media.get(own[1]))?.data ?? null;
    if (!/^https?:\/\//i.test(source)) return null;
    return (await platform.fetcher.image(source)).buffer;
  }

  /** Draws and stores the preview now. Returns the saved row, or null when there was nothing to draw it with. */
  function build(page, theme) {
    return buildTarget({ target: previewTarget(page), source: shareSource(page), ground: theme.colors.ground, title: page.headline ?? '', description: page.description ?? '', label: page.id });
  }

  /** The same for any target: { target, source (a /media link or an http(s) address, or ''), ground, title, description }. */
  async function buildTarget({ target, source, ground, title = '', description = '', label = target }) {
    const version = targetVersion(source, ground);
    const key = `${tenantId()}:${target}:${version}`;
    if (running.has(key)) return running.get(key);
    const work = (async () => {
      let image = null;
      let unread = false;
      try {
        image = await sourceBytes(source);
      } catch (err) {
        // The picture couldn't be read (gone, too large, the site is busy). An earlier preview stays; with none, the preview is
        // the plain ground colour, kept under another version so the picture is tried again later.
        log.warn('page.share_source_failed', { page: label, code: err?.code ?? 'error' });
        noteFailure(key);
        unread = true;
        const earlier = await repos.sharePreviews.get(target);
        if (earlier?.media_id) return earlier;
      }
      let drawn;
      try {
        drawn = await platform.images.sharePreview({ image, background: ground });
      } catch {
        unread = true;
        drawn = await platform.images.sharePreview({ image: null, background: ground });
      }
      const stored = unread ? crypto.createHash('sha256').update(`plain:${version}`).digest('hex').slice(0, 16) : version;
      const mediaId = await repos.media.save(drawn.buffer, drawn.contentType);
      const replaced = await repos.sharePreviews.put(target, { version: stored, mediaId, width: drawn.width, height: drawn.height, title, description });
      if (replaced) await repos.sharePreviews.removeMedia(replaced);
      return repos.sharePreviews.get(target);
    })().finally(() => running.delete(key));
    running.set(key, work);
    return work;
  }

  return {
    build,
    buildTarget,
    /**
     * The preview for the creator page or a shelf: { url, width, height }, or null. A stored one is returned even if out of date
     * (a new one is drawn in the background). With none yet, one drawn only from this business's own file, or from nothing, is made
     * now (no outside call); a picture on another site is fetched in the background, for the next view.
     */
    async forTarget({ target, source, ground, title = '', description = '' }) {
      const row = await repos.sharePreviews.get(target);
      const version = targetVersion(source, ground);
      const args = { target, source, ground, title, description };
      let plain = null;
      if (row?.version !== version) {
        const key = `${tenantId()}:${target}:${version}`;
        if (!row?.media_id && (!source || MEDIA_PATH.test(source))) {
          const made = await buildTarget(args).catch(() => null);
          return made?.media_id ? { url: `/media/${made.media_id}`, width: made.width, height: made.height } : null;
        }
        if (!row?.media_id) {
          // A picture on another site is never fetched while a visitor waits: the first view gets the plain card in the brand's colour
          // (the right size, so the share tags are complete), and the real picture is drawn in the background for the next view.
          const made = await buildTarget({ ...args, source: '' }).catch(() => null);
          if (made?.media_id) plain = { url: `/media/${made.media_id}`, width: made.width, height: made.height };
        }
        if (!(Date.now() - (failedAt.get(key) ?? 0) < RETRY_AFTER_MS)) {
          buildTarget(args).catch((err) => {
            noteFailure(key);
            log.warn('page.share_preview_failed', { page: target, code: err?.code ?? 'error' });
          });
        }
      }
      return row?.media_id ? { url: `/media/${row.media_id}`, width: row.width, height: row.height } : plain;
    },
    /**
     * The preview to put in the page's head right now: the stored one, even if out of date. When it is out of date a new one
     * is drawn in the background, for the next fetch.
     */
    async forPage(page, theme) {
      const row = await repos.sharePreviews.get(previewTarget(page));
      const version = previewVersion(page, theme);
      if (row?.version !== version) {
        const key = `${tenantId()}:${previewTarget(page)}:${version}`;
        if (!(Date.now() - (failedAt.get(key) ?? 0) < RETRY_AFTER_MS)) {
          build(page, theme).catch((err) => {
            noteFailure(key);
            log.warn('page.share_preview_failed', { page: page.id, code: err?.code ?? 'error' });
          });
        }
      }
      return row?.media_id ? row : null;
    },
    /** Removes a deleted page's preview image. */
    async forget(mediaId) {
      if (mediaId) await repos.sharePreviews.removeMedia(mediaId);
    },
  };
}
