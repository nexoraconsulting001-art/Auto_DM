import { lazy } from 'react';
import { Activity } from 'lucide-react';
import { staffWith } from '@contracts/access.js';

const TrafficPage = lazy(() => import('./TrafficPage.jsx'));
const TagsPage = lazy(() => import('./TagsPage.jsx'));
const ExplorePage = lazy(() => import('./ExplorePage.jsx'));
const FunnelListPage = lazy(() => import('./FunnelListPage.jsx'));
const FunnelEditPage = lazy(() => import('./FunnelEditPage.jsx'));
const FunnelResultsPage = lazy(() => import('./FunnelResultsPage.jsx'));
const CohortsPage = lazy(() => import('./CohortsPage.jsx'));

/** Visits to the seller's own pages, Explore, custom funnels, cohorts and pixels (PRD 7.10 to 7.12, 7.14). Aggregates only: nothing names a visitor. */
export default {
  name: 'traffic',
  access: staffWith('analytics'),
  nav: { to: '/traffic', label: 'Traffic', icon: Activity, order: 34 },
  routes: [
    { path: 'traffic', element: <TrafficPage /> },
    { path: 'traffic/tags', element: <TagsPage /> },
    { path: 'explore', element: <ExplorePage /> },
    { path: 'funnels', element: <FunnelListPage /> },
    { path: 'funnels/new', element: <FunnelEditPage /> },
    { path: 'funnels/:id', element: <FunnelResultsPage /> },
    { path: 'funnels/:id/edit', element: <FunnelEditPage /> },
    { path: 'cohorts', element: <CohortsPage /> },
  ],
};
