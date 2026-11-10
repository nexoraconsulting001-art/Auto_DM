import { notBuilt } from '../not-built.js';

/**
 * PRD 6.10, behind config.facebookPages: connecting a Page (ctx.meta.facebookLogin), Page webhooks, and linking posts to
 * their Instagram twins. Provides repos.fbPages with get(pageId) -> { pageId, token, tokenVersion, status }, which compliance.send() uses.
 */
export const facebook = {
  name: 'facebook',
  api: () => notBuilt('facebook.connection', 'facebook.connect', 'facebook.disconnect', 'facebook.posts', 'facebook.links', 'facebook.suggestions', 'facebook.saveLink', 'facebook.removeLink'),
};
