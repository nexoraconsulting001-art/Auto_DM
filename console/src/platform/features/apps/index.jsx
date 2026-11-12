import { Smartphone } from 'lucide-react';
import { NotBuilt } from '../../NotBuilt.jsx';

/** Shopper app builds, store submissions and over-the-air updates (PRD 10). Routes: platform.appBatches, appSubmissions, appRejections, otaReleases and the rest of Phase 6. */
function AppsPage() {
  return <NotBuilt title="Apps">Shopper app builds, store submissions and over-the-air updates (PRD 10).</NotBuilt>;
}

export default {
  name: 'apps',
  roles: ['super_admin', 'support'],
  nav: { to: '/apps', label: 'Apps', icon: Smartphone, order: 100 },
  routes: [{ path: 'apps', element: <AppsPage /> }],
};
