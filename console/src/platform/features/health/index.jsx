import { HeartPulse } from 'lucide-react';
import { NotBuilt } from '../../NotBuilt.jsx';

/** Every business, worst first, with when each check last ran (PRD 5.9). Routes: platform.health, businessHealth, runHealth. */
function HealthPage() {
  return <NotBuilt title="Health">Every business, worst first, with when each check last ran (PRD 5.9).</NotBuilt>;
}

export default {
  name: 'health',
  roles: ['super_admin', 'support'],
  nav: { to: '/health', label: 'Health', icon: HeartPulse, order: 30 },
  routes: [{ path: 'health', element: <HealthPage /> }],
};
