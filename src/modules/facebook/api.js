import { createPageContent } from '../../adapters/facebook/index.js';
import { ApiError } from '../../contracts/api/index.js';
import { log } from '../../platform/log.js';
import { pageOf } from '../admin-api/paging.js';
import { suggestLinks } from './match.js';

const MEDIA_LOOKBACK = 50;
const MEDIA_CALL = 'media_list';
const NOT_THEIRS = new Set(['not_found', 'validation', 'permission']);

const notAvailable = () => new ApiError('conflict', 'Facebook isn’t available yet.');
const emptyList = () => ({ items: [], nextCursor: null });

/** What the console shows. With the flag off it reads as "no Facebook here" for everyone (PRD 6.10), whatever is in the table. */
export function connectionView(enabled, page) {
  if (!enabled || !page) return { enabled: Boolean(enabled), status: 'not_connected', pageId: null, pageName: '', tokenExpiresAt: null };
  return { enabled: true, status: page.status, pageId: page.pageId, pageName: page.name, tokenExpiresAt: page.tokenExpiresAt };
}

function mediaOf(answer) {
  return (answer.data ?? []).filter((m) => m.media_product_type !== 'STORY').map((m) => ({ id: String(m.id), caption: String(m.caption ?? ''), postedAt: m.timestamp ?? null }));
}

/** The handlers of the contract's facebook.* routes. `connect` is the business's connection flow. */
export function facebookApi(ctx, connect) {
  const { config, repos, meta, compliance } = ctx;
  const enabled = Boolean(config.facebookPages);
  const clock = () => new Date((config.complianceNow ?? Date.now)());
  let content;
  const pageContent = () => (content ??= createPageContent(config));

  const requireEnabled = () => {
    if (!enabled) throw notAvailable();
  };

  /** A call to Meta that isn't a message: it waits its turn behind the Page's messages (PRD 4.3), and failing never costs more than the answer. */
  async function read(channel, accountId, label, fetchIt) {
    const { allow } = await compliance.callAllowed(channel, accountId, MEDIA_CALL);
    if (!allow) throw new ApiError('conflict', `${label} is busy right now. Try again in a few minutes.`, { reason: 'rate.usage_header' });
    return fetchIt();
  }

  /** Reads through the Page. Meta refusing the token pauses Facebook here too, and only Facebook (FB-04). */
  async function readPage(page, fetchIt) {
    try {
      return await read('facebook', page.pageId, 'Facebook', fetchIt);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err.kind === 'token_invalid') {
        await repos.fbPages.markRejected(page.pageId, page.tokenVersion, { actor: 'system:facebook-read' });
        throw new ApiError('conflict', 'Facebook stopped accepting your connection. Reconnect your Page to see your posts.', { reason: 'paused.reconnect' });
      }
      log.warn('facebook.read_failed', { kind: err.kind, status: err.status, code: err.code });
      throw new ApiError('conflict', 'Facebook isn’t answering right now. Try again in a moment.');
    }
  }

  async function readInstagram(account, fetchIt) {
    try {
      return await read('instagram', account.igUserId, 'Instagram', fetchIt);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      log.warn('facebook.instagram_read_failed', { kind: err.kind, status: err.status, code: err.code });
      throw new ApiError('conflict', 'Instagram isn’t answering right now. Try again in a moment.');
    }
  }

  /** A post can only be linked on the business's own Page: its id begins with the Page's. Anyone else's is simply not there. */
  async function ownersPage(postId) {
    const page = await repos.fbPages.primary();
    if (!page || !postId.startsWith(`${page.pageId}_`)) throw new ApiError('not_found');
    return page;
  }

  /** The twin has to be this business's own, so a link can never reach another business's reel. Ids it already uses are known; anything else is asked of Instagram. */
  async function requireOwnMedia(igMediaId) {
    if (await repos.fbLinks.ownsMedia(igMediaId)) return;
    const refuse = () => new ApiError('validation_failed', 'That isn’t a reel or post on your Instagram.', { fields: { igMediaId: 'Pick one of your own reels or posts' } });
    const account = await repos.igAccounts.current();
    if (!account) throw refuse();
    let media;
    try {
      media = await meta.client.forAccount(account).getMedia(igMediaId);
    } catch (err) {
      // Instagram answers the same whether the id is another business's or doesn't exist, and so does this.
      if (NOT_THEIRS.has(err.kind)) throw refuse();
      log.warn('facebook.media_check_failed', { kind: err.kind, status: err.status, code: err.code });
      throw new ApiError('conflict', 'Instagram isn’t answering right now. Try again in a moment.');
    }
    if (String(media?.id ?? '') !== igMediaId) throw refuse();
  }

  return {
    'facebook.connection': async () => connectionView(enabled, enabled ? await repos.fbPages.primary() : null),

    'facebook.connect': ({ body, user, req }) => {
      requireEnabled();
      return connect().start({ user, returnTo: body.returnTo, req });
    },

    'facebook.disconnect': async ({ user }) => {
      if (!enabled) return;
      const page = await repos.fbPages.primary();
      if (page) await connect().disconnect(page.pageId, `user:${user.id}`);
    },

    'facebook.posts': async ({ query }) => {
      const page = enabled ? await repos.fbPages.current() : null;
      if (!page) return emptyList();
      const posts = await readPage(page, () => pageContent().recent(page));
      const linked = await repos.fbLinks.linkedTo(posts.map((post) => post.id));
      const shown = pageOf(posts, query, (post) => [-(post.postedAt?.getTime() ?? 0), post.id]);
      return { items: shown.items.map((post) => ({ ...post, linkedIgMediaId: linked.get(post.id) ?? null })), nextCursor: shown.nextCursor };
    },

    'facebook.links': async ({ query }) => {
      const page = enabled ? await repos.fbPages.primary() : null;
      return page ? repos.fbLinks.list({ pageId: page.pageId, ...query }) : emptyList();
    },

    'facebook.suggestions': async () => {
      const [page, account] = enabled ? await Promise.all([repos.fbPages.current(), repos.igAccounts.current()]) : [];
      if (!page || !account) return { items: [] };
      const [posts, media, decided] = await Promise.all([
        readPage(page, () => pageContent().recent(page)),
        readInstagram(account, () => meta.client.forAccount(account).listMedia({ limit: MEDIA_LOOKBACK })),
        repos.fbLinks.decided(page.pageId),
      ]);
      return { items: suggestLinks({ posts, media: mediaOf(media), ...decided }) };
    },

    'facebook.saveLink': async ({ params, body, user }) => {
      requireEnabled();
      const page = await ownersPage(params.id);
      await requireOwnMedia(body.igMediaId);
      return repos.fbLinks.save({ pageId: page.pageId, postId: params.id, igMediaId: body.igMediaId, userId: user.id, actor: `user:${user.id}`, at: clock() });
    },

    'facebook.removeLink': async ({ params, user }) => {
      requireEnabled();
      await ownersPage(params.id);
      if (!(await repos.fbLinks.remove(params.id, { actor: `user:${user.id}`, at: clock() }))) throw new ApiError('not_found');
    },
  };
}
