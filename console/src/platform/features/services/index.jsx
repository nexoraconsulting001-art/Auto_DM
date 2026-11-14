import { Wrench } from 'lucide-react';
import { screen } from '../../lazy.js';

const load = () => import('./pages.jsx');
const ServicesPage = screen(load, 'ServicesPage');

export default {
  name: 'services',
  roles: ['super_admin', 'service_operator'],
  nav: { to: '/services', label: 'Services', icon: Wrench, order: 60 },
  routes: [
    { path: 'services', element: <ServicesPage /> },
  ],
};
