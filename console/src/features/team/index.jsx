import { lazy } from 'react';
import { Users } from 'lucide-react';
import { OWNER_ONLY } from '@contracts/access.js';

const TeamPage = lazy(() => import('./TeamPage.jsx'));

/** Settings > Team (PRD 5.11): owner only, as every team route is. The path is the one the server's team notice links to. */
export default {
  name: 'team',
  access: OWNER_ONLY,
  nav: { to: '/settings/team', label: 'Team', icon: Users, order: 75 },
  routes: [{ path: 'settings/team', element: <TeamPage /> }],
};
