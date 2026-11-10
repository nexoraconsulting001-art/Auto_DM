import { lazy } from 'react';
import { Tags } from 'lucide-react';
import { staffWith } from '@contracts/access.js';

const CategoriesPage = lazy(() => import('./CategoriesPage.jsx'));
const CategoryFormPage = lazy(() => import('./CategoryFormPage.jsx'));

export default {
  name: 'categories',
  access: staffWith('catalog'),
  nav: { to: '/categories', label: 'Categories', icon: Tags, order: 40 },
  routes: [
    { path: 'categories', element: <CategoriesPage /> },
    { path: 'categories/new', element: <CategoryFormPage /> },
    { path: 'categories/:id', element: <CategoryFormPage /> },
  ],
};
