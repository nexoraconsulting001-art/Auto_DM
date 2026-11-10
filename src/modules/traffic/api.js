import { ApiError } from '../../contracts/api/index.js';
import { servicesFor } from './services.js';

/** The routes the contract gives this module (7.10, 7.14). */
export function trafficApi(ctx) {
  const on = () => servicesFor(ctx);
  return {
    'traffic.summary': ({ query, user }) => on().reads.summary(query, user),
    'traffic.sources': ({ query, user }) => on().reads.sources(query, user),
    'traffic.trend': ({ query, user }) => on().reads.trend(query, user),
    'traffic.heatmap': ({ query, user }) => on().reads.heatmap(query, user),
    'traffic.pages': ({ query, user }) => on().reads.pages(query, user),
    'traffic.breakdown': ({ query, user }) => on().reads.breakdown(query, user),
    'traffic.realtime': () => on().reads.realtime(),
    'tags.get': () => on().tags.view(),
    'tags.update': ({ body, user }) => on().tags.update(body, user),
    'tags.health': () => on().tags.health(),
  };
}

/**
 * Explore, saved views, custom funnels, cohorts, the per-content funnel and destination figures (7.4, 7.11, 7.12, 7.15). This track builds them, but the contract
 * lists their route ids under the insights and reports modules, so they are answered through adoptContractStubs in index.js.
 */
export function analyticsApi(ctx) {
  const on = () => servicesFor(ctx);
  const { repos } = ctx;
  // Returning null is a 404: another business's id and an id that doesn't exist get the same answer (N-55).
  return {
    'explore.catalog': ({ user }) => on().explore.catalog(user),
    'explore.query': ({ body, user }) => on().explore.query(body, { user }),

    'savedViews.list': ({ query, user }) => repos.savedViews.list(query, user),
    'savedViews.create': ({ body, user }) => repos.savedViews.create(body, user),
    'savedViews.get': ({ params, user }) => repos.savedViews.get(params.id, user),
    'savedViews.update': ({ params, body, user }) => repos.savedViews.update(params.id, body, user),
    'savedViews.remove': async ({ params, user }) => (await repos.savedViews.remove(params.id, user)) || notFound(),
    'savedViews.pin': ({ params, user }) => repos.savedViews.pin(params.id, user),
    'savedViews.unpin': async ({ params, user }) => {
      await repos.savedViews.unpin(params.id, user);
    },
    'dashboard.cards': async ({ user }) => {
      const views = await repos.savedViews.pinned(user);
      const items = [];
      for (const view of views) items.push({ view, result: await on().explore.query(view.definition, { user }) });
      return { items };
    },

    'funnels.list': ({ query }) => repos.customFunnels.list(query),
    'funnels.create': ({ body, user }) => repos.customFunnels.create(body, user),
    'funnels.get': ({ params }) => repos.customFunnels.get(params.id),
    'funnels.update': ({ params, body }) => repos.customFunnels.update(params.id, body),
    'funnels.remove': async ({ params }) => (await repos.customFunnels.remove(params.id)) || notFound(),
    'funnels.results': ({ params, query }) => on().funnelResults.results(params.id, query),

    'cohorts.get': ({ query }) => on().cohorts.get(query),

    'insights.funnels': ({ query, user }) => on().contentFunnels.list(query, user),
    'insights.funnel': ({ params, user }) => on().contentFunnels.one(params.id, user),

    'destinations.connections': () => on().destinations.connections(),
    'destinations.setSiteTag': ({ body, req }) => on().destinations.setSiteTag(body, req.hostname),
    'destinations.reports': ({ query }) => on().destinations.reports(query),
    'destinations.uploadReport': ({ query, file, user }) => on().destinations.upload(query, file, user),
  };
}

function notFound() {
  throw new ApiError('not_found');
}
