import { ScrollText } from 'lucide-react';
import { screen } from '../../lazy.js';

const load = () => import('./pages.jsx');
const AuditPage = screen(load, 'AuditPage');

export default {
  name: 'audit',
  roles: ['super_admin', 'support'],
  nav: { to: '/audit', label: 'Audit', icon: ScrollText, order: 120 },
  routes: [
    { path: 'audit', element: <AuditPage /> },
  ],
};
