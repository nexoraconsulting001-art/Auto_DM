import { notBuilt } from '../not-built.js';

/** PRD 7.10 and 7.14: visits on the seller's own pages, and the seller's own pixels. Tags ask platform.consent before anything loads or is sent. */
export const traffic = {
  name: 'traffic',
  api: () => notBuilt(
    'traffic.summary', 'traffic.sources', 'traffic.trend', 'traffic.heatmap', 'traffic.pages', 'traffic.breakdown', 'traffic.realtime',
    'tags.get', 'tags.update', 'tags.health',
  ),
};
