import { lazy } from 'react';
import { Palette } from 'lucide-react';
import { MANAGERS } from '@contracts/access.js';

const BrandKitPage = lazy(() => import('./BrandKitPage.jsx'));

export default {
  name: 'brand-kit',
  access: MANAGERS,
  nav: { to: '/brand-kit', label: 'Brand kit', icon: Palette, order: 80 },
  routes: [{ path: 'brand-kit', element: <BrandKitPage /> }],
};
