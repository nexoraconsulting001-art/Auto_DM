import { lazy } from 'react';
import { LayoutTemplate } from 'lucide-react';
import { staffWith } from '@contracts/access.js';

const PagesPage = lazy(() => import('./PagesPage.jsx'));
const NewPagePage = lazy(() => import('./NewPagePage.jsx'));
const PageEditorPage = lazy(() => import('./PageEditorPage.jsx'));
const PageSettingsPage = lazy(() => import('./PageSettingsPage.jsx'));
const PageLayoutPage = lazy(() => import('./PageLayoutPage.jsx'));

/** A landing page for each reel, post or story (PRD 8.10), the WhatsApp order button (8.11) and each page's blocks (5.18). */
export default {
  name: 'pages',
  access: staffWith('catalog'),
  nav: { to: '/pages', label: 'Landing pages', icon: LayoutTemplate, order: 22 },
  routes: [
    { path: 'pages', element: <PagesPage /> },
    { path: 'pages/new', element: <NewPagePage /> },
    { path: 'pages/settings', element: <PageSettingsPage /> },
    { path: 'pages/layout', element: <PageLayoutPage /> },
    { path: 'pages/:id', element: <PageEditorPage /> },
  ],
};
