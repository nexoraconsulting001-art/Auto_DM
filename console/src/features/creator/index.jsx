import { lazy } from 'react';
import { UserRound } from 'lucide-react';
import { MANAGERS } from '@contracts/access.js';

const CreatorPage = lazy(() => import('./CreatorPage.jsx'));

/** The creator page (PRD 8.14): the one link for the Instagram bio, with a shelf of reels for each category. */
export default {
  name: 'creator',
  access: MANAGERS,
  nav: { to: '/creator-page', label: 'Creator page', icon: UserRound, order: 23 },
  routes: [{ path: 'creator-page', element: <CreatorPage /> }],
};
