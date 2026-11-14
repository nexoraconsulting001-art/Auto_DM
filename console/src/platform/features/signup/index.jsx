import { UserPlus } from 'lucide-react';
import { screen } from '../../lazy.js';

const load = () => import('./pages.jsx');
const SignupPage = screen(load, 'SignupPage');

export default {
  name: 'signup',
  roles: ['super_admin', 'support'],
  nav: { to: '/signup', label: 'Sign-up', icon: UserPlus, order: 90 },
  routes: [
    { path: 'signup', element: <SignupPage /> },
  ],
};
