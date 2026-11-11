import { lazy } from 'react';
import { Tags } from 'lucide-react';
import { staffWith } from '@contracts/access.js';

const CategoriesPage = lazy(() => import('./CategoriesPage.jsx'));
const CategoryFormPage = lazy(() => import('./CategoryFormPage.jsx'));
const SequencePage = lazy(() => import('./SequencePage.jsx'));

/** Categories (PRD 8.1) and the one stored order of reels each has (8.13). */
export default {
  name: 'categories',
  access: staffWith('catalog'),
  nav: { to: '/categories', label: 'Categories', icon: Tags, order: 40 },
  routes: [
    { path: 'categories', element: <CategoriesPage /> },
    { path: 'categories/new', element: <CategoryFormPage /> },
    { path: 'categories/:id', element: <CategoryFormPage /> },
    { path: 'categories/:id/reels', element: <SequencePage /> },
  ],
};
