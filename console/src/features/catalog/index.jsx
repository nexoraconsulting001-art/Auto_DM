import { lazy } from 'react';
import { BookOpen } from 'lucide-react';
import { staffWith } from '@contracts/access.js';

const CatalogPage = lazy(() => import('./CatalogPage.jsx'));
const ProductEditorPage = lazy(() => import('./ProductEditorPage.jsx'));
const CatalogSettingsPage = lazy(() => import('./CatalogSettingsPage.jsx'));

/** The Phase 3 catalog (PRD 8.1): products with options, variants, their own web link and what the re-checks found. */
export default {
  name: 'catalog',
  access: staffWith('catalog'),
  nav: { to: '/catalog', label: 'Catalog', icon: BookOpen, order: 21 },
  routes: [
    { path: 'catalog', element: <CatalogPage /> },
    { path: 'catalog/new', element: <ProductEditorPage /> },
    { path: 'catalog/settings', element: <CatalogSettingsPage /> },
    { path: 'catalog/:id', element: <ProductEditorPage /> },
  ],
};
