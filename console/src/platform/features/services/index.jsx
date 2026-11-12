import { Wrench } from 'lucide-react';
import { NotBuilt } from '../../NotBuilt.jsx';

/** Managed services: engagements, sessions with a task reference, and the changes made (PRD 5.17). Routes: platform.services, serviceSessions, startServiceSession, endServiceSession, serviceChanges. */
function ServicesPage() {
  return <NotBuilt title="Services">Managed services: engagements, sessions with a task reference, and the changes made (PRD 5.17).</NotBuilt>;
}

export default {
  name: 'services',
  roles: ['super_admin', 'service_operator'],
  nav: { to: '/services', label: 'Services', icon: Wrench, order: 60 },
  routes: [{ path: 'services', element: <ServicesPage /> }],
};
