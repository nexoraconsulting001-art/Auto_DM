import { lazy } from 'react';
import { House } from 'lucide-react';
import { SIGNED_IN } from '@contracts/access.js';

const HomePage = lazy(() => import('./HomePage.jsx'));

export default {
  name: 'home',
  access: SIGNED_IN,
  nav: { to: '/', label: 'Home', icon: House, order: 0, primary: true },
  routes: [{ index: true, element: <HomePage /> }],
};
