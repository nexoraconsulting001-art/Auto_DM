import { Download } from 'lucide-react';
import { NotBuilt } from '../../NotBuilt.jsx';

/** Raw exports, each with a reason and an expiry (PRD 7). Route: platform.rawExport. */
function ExportsPage() {
  return <NotBuilt title="Exports">Raw exports, each with a reason and an expiry (PRD 7).</NotBuilt>;
}

export default {
  name: 'exports',
  roles: ['super_admin'],
  nav: { to: '/exports', label: 'Exports', icon: Download, order: 110 },
  routes: [{ path: 'exports', element: <ExportsPage /> }],
};
