import { createMetaHttp } from '../meta/http.js';
import { DEFAULT_GRAPH_VERSION, metaUrls } from '../meta/index.js';

const POST_FIELDS = 'id,message,created_time,permalink_url';
const REEL_FIELDS = 'id,description,created_time,permalink_url';

/** Graph's largest page. The two lists are merged and paged on our side, so this is how far back the seller can look. */
export const RECENT_LIMIT = 100;

function when(value) {
  const at = value ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
}

/**
 * A feed webhook names a reel as <pageId>_<videoId>, the same as a post, while the reels list gives the video's id alone
 * (to confirm in a live check). Everything Bhava stores uses the webhook's form.
 */
const postId = (pageId, id) => (String(id).includes('_') ? String(id) : `${pageId}_${id}`);

/**
 * What a Page has published, for linking a Facebook post to its Instagram twin (PRD 6.10). Page reels have their own Graph
 * edge, which the Meta client doesn't read. Reads only: a message to anyone goes through compliance.send().
 *
 * A page is { pageId, token }. recent() resolves to [{ id, message, postedAt, permalink }], newest first, each id once.
 * Failures are MetaApiError. A reels list that can't be read costs the seller the reels and not the posts, except a dead token.
 */
export function createPageContent(config = {}, { env = process.env, onCall } = {}) {
  const urls = metaUrls(config, env);
  const version = config.graphVersion || DEFAULT_GRAPH_VERSION;
  const call = createMetaHttp({ timeoutMs: config.metaTimeoutMs, onCall });

  async function edge(page, name, fields, limit) {
    const { data } = await call({
      base: urls.facebookGraph, version, method: 'GET', pathname: `${encodeURIComponent(page.pageId)}/${name}`, query: { fields, limit: String(limit) }, token: page.token,
    });
    return Array.isArray(data.data) ? data.data : [];
  }

  /** Reels come back with a path, posts with a full address. A value that is neither is dropped rather than shown as a link. */
  function permalink(value) {
    const link = String(value ?? '');
    if (link.startsWith('/') && !link.startsWith('//')) return `${urls.facebookDialog}${link}`;
    return /^https?:\/\//i.test(link) ? link : '';
  }

  const item = (page, raw) => ({
    id: postId(page.pageId, raw.id),
    message: String(raw.message ?? raw.description ?? ''),
    postedAt: when(raw.created_time),
    permalink: permalink(raw.permalink_url),
  });

  return {
    async recent(page, { limit = RECENT_LIMIT } = {}) {
      const [posts, reels] = await Promise.all([
        edge(page, 'posts', POST_FIELDS, limit),
        edge(page, 'video_reels', REEL_FIELDS, limit).catch((err) => {
          if (err?.kind === 'token_invalid') throw err;
          return [];
        }),
      ]);
      const unique = new Map();
      for (const raw of [...posts, ...reels]) {
        if (raw?.id === undefined || raw?.id === null) continue;
        const entry = item(page, raw);
        if (!unique.has(entry.id)) unique.set(entry.id, entry);
      }
      return [...unique.values()].sort((a, b) => (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0) || a.id.localeCompare(b.id));
    },
  };
}
