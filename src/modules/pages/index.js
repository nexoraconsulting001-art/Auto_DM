import { notBuilt } from '../not-built.js';

/**
 * PRD 8.10 to 8.12 and the block layout of 5.18: a landing page per automated reel, post or story (rows of `reels`, migration
 * 302), the WhatsApp order button, share previews and robots.txt. Buyer pages are BUYER_ROUTES in src/contracts/buyer-pages.js,
 * mounted in routes(app, ctx) and drawn with the shared layout in src/views/buyer. The reels.* routes stay with admin-api; take
 * one over with takesOver(ctx) if this module must answer it.
 */
export const pages = {
  name: 'pages',
  api: () => notBuilt(
    'pages.list', 'pages.create', 'pages.media', 'pages.get', 'pages.update', 'pages.remove',
    'pageSettings.get', 'pageSettings.update', 'pageBlocks.get', 'pageBlocks.save',
  ),
};
