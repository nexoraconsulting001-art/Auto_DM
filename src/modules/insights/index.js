import { notBuilt } from '../not-built.js';
import { ANALYTICS_LIMITS as L } from '../../contracts/analytics.js';
import { insightsApi } from './api.js';
import { createInsightsPoller } from './poller.js';
import { insightsRepo } from './repo.js';

const POLL_QUEUE = 'insights.poll';
const MINUTE = 60_000;

/**
 * Tracks a story known only from a reply, for an account whose login can't use /stories (7.3). A reply is to one of the business's own stories, so its figures can be read
 * until it expires; a mention is someone else's story, with no id to ask about, so it can't be tracked. Returns nothing, so the automations still handle the reply.
 */
async function trackRepliedStory(event, ctx) {
  if (event.type !== 'story_reply' || event.channel !== 'instagram' || !event.storyId) return;
  const account = await ctx.repos.insights.accountForIg(event.accountId);
  if (!account || account.stories_edge === 'available') return;
  const seen = +new Date(event.receivedAt ?? Date.now());
  const refs = await ctx.repos.insights.upsertMedia(account.id, [{ id: String(event.storyId), kind: 'story', caption: '', permalink: '', thumbnailUrl: '', postedAt: null, storyExpiresAt: seen + L.storyLifeMs, storyTracking: 'seen_only' }]);
  await ctx.repos.insights.ensureMediaPolls(account.id, [{ job: 'story', mediaRef: refs.get(String(event.storyId)), jitterSeconds: 0, dueAt: seen }]);
}

/** PRD 7.1 to 7.3, 7.5, 7.8: the per-business insights cache and its polling, top content and best time to post. The funnel and destination routes (7.4, 7.15) still answer 501 here until they are built. */
export const insights = {
  name: 'insights',
  repos: (db) => ({ insights: insightsRepo(db) }),
  api: (ctx) => ({
    ...notBuilt('insights.funnels', 'insights.funnel', 'destinations.connections', 'destinations.setSiteTag', 'destinations.reports', 'destinations.uploadReport'),
    ...insightsApi(ctx),
  }),
  onInboundEvent: trackRepliedStory,

  jobs(ctx) {
    const { queue } = ctx.platform;
    const poller = createInsightsPoller(ctx);
    queue.work(POLL_QUEUE, () => poller.tick());
    return async () => {
      await queue.every(POLL_QUEUE, MINUTE);
    };
  },
};
