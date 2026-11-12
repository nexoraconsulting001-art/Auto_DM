import { Power } from 'lucide-react';
import { NotBuilt } from '../../NotBuilt.jsx';

/** Every pause and switch with who set it, why and when (PRD 5.8). Routes: platform.pauses, switches, engageKill, requestRelease, approveRelease, pauseBusiness, resumeBusiness. */
function SwitchesPage() {
  return <NotBuilt title="Pauses">Every pause and switch with who set it, why and when (PRD 5.8).</NotBuilt>;
}

export default {
  name: 'switches',
  roles: ['super_admin', 'support'],
  nav: { to: '/switches', label: 'Pauses', icon: Power, order: 40 },
  routes: [{ path: 'switches', element: <SwitchesPage /> }],
};
