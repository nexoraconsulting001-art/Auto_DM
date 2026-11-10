import { lazy } from 'react';
import { Clapperboard } from 'lucide-react';
import { staffWith } from '@contracts/access.js';

const ReelsPage = lazy(() => import('./ReelsPage.jsx'));
const ReelFormPage = lazy(() => import('./ReelFormPage.jsx'));

export default {
  name: 'reels',
  access: staffWith('automations'),
  nav: { to: '/reels', label: 'Reels', icon: Clapperboard, order: 30, primary: true },
  routes: [{ path: 'reels', element: <ReelsPage /> }, { path: 'reels/:id', element: <ReelFormPage /> }],
};
