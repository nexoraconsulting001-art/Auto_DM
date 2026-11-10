import { lazy } from 'react';
import { BarChart3 } from 'lucide-react';
import { staffWith } from '@contracts/access.js';

const AccountPage = lazy(() => import('./AccountPage.jsx'));
const ContentPage = lazy(() => import('./ContentPage.jsx'));
const MediaPage = lazy(() => import('./MediaPage.jsx'));
const StoriesPage = lazy(() => import('./StoriesPage.jsx'));
const AudiencePage = lazy(() => import('./AudiencePage.jsx'));
const TopPage = lazy(() => import('./TopPage.jsx'));
const FunnelsPage = lazy(() => import('./FunnelsPage.jsx'));
const FunnelPage = lazy(() => import('./FunnelPage.jsx'));
const SourcesPage = lazy(() => import('./SourcesPage.jsx'));

/** Instagram and Facebook insights and the Bhava funnel (PRD 7.1 to 7.5, 7.15). Every screen reads the cache: opening one never calls Meta. */
export default {
  name: 'insights',
  access: staffWith('analytics'),
  nav: { to: '/analytics', label: 'Insights', icon: BarChart3, order: 33 },
  routes: [
    { path: 'analytics', element: <AccountPage /> },
    { path: 'analytics/content', element: <ContentPage /> },
    { path: 'analytics/content/:id', element: <MediaPage /> },
    { path: 'analytics/stories', element: <StoriesPage /> },
    { path: 'analytics/audience', element: <AudiencePage /> },
    { path: 'analytics/top', element: <TopPage /> },
    { path: 'analytics/funnels', element: <FunnelsPage /> },
    { path: 'analytics/funnels/:id', element: <FunnelPage /> },
    { path: 'analytics/sources', element: <SourcesPage /> },
  ],
};
