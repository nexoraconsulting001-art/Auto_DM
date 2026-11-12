import { ScrollText } from 'lucide-react';
import { NotBuilt } from '../../NotBuilt.jsx';

/** What Bhava’s team did, in every business (PRD 5.14). Route: platform.auditLog. */
function AuditPage() {
  return <NotBuilt title="Audit">What Bhava’s team did, in every business (PRD 5.14).</NotBuilt>;
}

export default {
  name: 'audit',
  roles: ['super_admin', 'support'],
  nav: { to: '/audit', label: 'Audit', icon: ScrollText, order: 120 },
  routes: [{ path: 'audit', element: <AuditPage /> }],
};
