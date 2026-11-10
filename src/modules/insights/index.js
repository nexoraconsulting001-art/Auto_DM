import { notBuilt } from '../not-built.js';

/** PRD 7.1 to 7.5, 7.8, 7.15: the per-business insights cache and its polling, the funnel per reel, post and story, top content, and destination figures. */
export const insights = {
  name: 'insights',
  api: () => notBuilt(
    'insights.status', 'insights.account', 'insights.audience', 'insights.media', 'insights.mediaDetail', 'insights.stories',
    'insights.funnels', 'insights.funnel', 'insights.top', 'insights.bestTime', 'insights.refresh',
    'destinations.connections', 'destinations.setSiteTag', 'destinations.reports', 'destinations.uploadReport',
  ),
};
