import { Flag } from 'lucide-react';
import { NotBuilt } from '../../NotBuilt.jsx';

/** Feature flags, for all and per business (PRD 5.7). Routes: platform.flags, saveFlag, tenantFlags, setTenantFlag. */
function FlagsPage() {
  return <NotBuilt title="Flags">Feature flags, for all and per business (PRD 5.7).</NotBuilt>;
}

export default {
  name: 'flags',
  roles: ['super_admin', 'support'],
  nav: { to: '/flags', label: 'Flags', icon: Flag, order: 80 },
  routes: [{ path: 'flags', element: <FlagsPage /> }],
};
