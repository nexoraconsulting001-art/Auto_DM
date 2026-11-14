import { lazy } from 'react';
import { History } from 'lucide-react';
import { MANAGERS } from '@contracts/access.js';

const TeamFeedPage = lazy(() => import('./TeamFeedPage.jsx'));

/** The "Done by Bhava team" feed (PRD 5.17): what the team changed for the business, with undo, approve and reject. */
export default {
  name: 'team-feed',
  access: MANAGERS,
  nav: { to: '/team-feed', label: 'Done by Bhava team', icon: History, order: 86 },
  routes: [{ path: 'team-feed', element: <TeamFeedPage /> }],
};
