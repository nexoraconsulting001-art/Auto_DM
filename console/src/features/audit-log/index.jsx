import { lazy } from 'react';
import { ScrollText } from 'lucide-react';
import { OWNER_ONLY } from '@contracts/access.js';

const AuditLogPage = lazy(() => import('./AuditLogPage.jsx'));

export default {
  name: 'audit-log',
  access: OWNER_ONLY,
  nav: { to: '/audit-log', label: 'Audit log', icon: ScrollText, order: 90 },
  routes: [{ path: 'audit-log', element: <AuditLogPage /> }],
};
