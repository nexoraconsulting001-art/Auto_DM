import { lazy } from 'react';
import { Inbox } from 'lucide-react';
import { staffWith } from '@contracts/access.js';

const InboxPage = lazy(() => import('./InboxPage.jsx'));
const ThreadPage = lazy(() => import('./ThreadPage.jsx'));
const NeedsHumanPage = lazy(() => import('./NeedsHumanPage.jsx'));
const WhyNoDmPage = lazy(() => import('./WhyNoDmPage.jsx'));

export default {
  name: 'inbox',
  access: staffWith('inbox'),
  nav: { to: '/inbox', label: 'Inbox', icon: Inbox, order: 32 },
  routes: [
    { path: 'inbox', element: <InboxPage /> },
    { path: 'inbox/threads/:id', element: <ThreadPage /> },
    { path: 'inbox/needs-human', element: <NeedsHumanPage /> },
    { path: 'inbox/why-no-dm', element: <WhyNoDmPage /> },
  ],
};
