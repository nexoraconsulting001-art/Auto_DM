import { Building2 } from 'lucide-react';
import { screen } from '../../lazy.js';

const load = () => import('./pages.jsx');
const BusinessesPage = screen(load, 'BusinessesPage');
const NewBusinessPage = screen(load, 'NewBusinessPage');
const BusinessPage = screen(load, 'BusinessPage');

export default {
  name: 'businesses',
  roles: ['super_admin', 'support', 'onboarding'],
  nav: { to: '/businesses', label: 'Businesses', icon: Building2, order: 10 },
  routes: [
    { path: 'businesses', element: <BusinessesPage /> },
    { path: 'businesses/new', element: <NewBusinessPage /> },
    { path: 'businesses/:id', element: <BusinessPage /> },
  ],
};
