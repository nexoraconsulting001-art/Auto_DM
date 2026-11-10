import { lazy } from 'react';
import { Package } from 'lucide-react';
import { staffWith } from '@contracts/access.js';

const ProductsPage = lazy(() => import('./ProductsPage.jsx'));
const ProductFormPage = lazy(() => import('./ProductFormPage.jsx'));

export default {
  name: 'products',
  access: staffWith('catalog'),
  nav: { to: '/products', label: 'Products', icon: Package, order: 20, primary: true },
  routes: [
    { path: 'products', element: <ProductsPage /> },
    { path: 'products/new', element: <ProductFormPage /> },
    { path: 'products/:id', element: <ProductFormPage /> },
  ],
};
