import { lazy } from 'react';
import { Paintbrush } from 'lucide-react';
import { MANAGERS } from '@contracts/access.js';

const ThemePage = lazy(() => import('./ThemePage.jsx'));

/** Picking the look of the seller's buyer pages (PRD 5.19, 8.9). The screen is Bhava's; only buyer pages wear the look. */
export default {
  name: 'themes',
  access: MANAGERS,
  nav: { to: '/look', label: 'Shop look', icon: Paintbrush, order: 79 },
  routes: [{ path: 'look', element: <ThemePage /> }],
};
