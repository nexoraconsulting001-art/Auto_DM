import { Eye } from 'lucide-react';
import { NotBuilt } from '../../NotBuilt.jsx';

/** Open a business as its owner, read-only unless confirmed, for 30 minutes (PRD 5.10). Routes: platform.impersonate, impersonations, confirmImpersonationWrite, endImpersonation. */
function ImpersonationPage() {
  return <NotBuilt title="Impersonation">Open a business as its owner, read-only unless confirmed, for 30 minutes (PRD 5.10).</NotBuilt>;
}

export default {
  name: 'impersonation',
  roles: ['super_admin', 'support'],
  nav: { to: '/impersonation', label: 'Impersonation', icon: Eye, order: 50 },
  routes: [{ path: 'impersonation', element: <ImpersonationPage /> }],
};
