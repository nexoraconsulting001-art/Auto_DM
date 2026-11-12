import { lazy } from 'react';
import { Smartphone } from 'lucide-react';
import { MANAGERS } from '@contracts/access.js';

const AppDetailsPage = lazy(() => import('./AppDetailsPage.jsx'));
const StoreAccountsPage = lazy(() => import('./StoreAccountsPage.jsx'));
const ListingPage = lazy(() => import('./ListingPage.jsx'));
const ReviewPage = lazy(() => import('./ReviewPage.jsx'));
const OffersPage = lazy(() => import('./OffersPage.jsx'));
const PushKeysPage = lazy(() => import('./PushKeysPage.jsx'));

/**
 * My app (PRD 10.7 to 10.14): the branded shopper app's details and builds, the store accounts, the store listing, review
 * status, offers by push and the push keys. The owner app has the same screens (apps/owner/src/features/app-publishing) and
 * lists these paths in its routeIds, so `npm run parity` stays green.
 */
export default {
  name: 'app-publishing',
  access: MANAGERS,
  nav: { to: '/my-app', label: 'My app', icon: Smartphone, order: 81 },
  routes: [
    { path: 'my-app', element: <AppDetailsPage /> },
    { path: 'my-app/stores', element: <StoreAccountsPage /> },
    { path: 'my-app/listing/:platform', element: <ListingPage /> },
    { path: 'my-app/review', element: <ReviewPage /> },
    { path: 'my-app/offers', element: <OffersPage /> },
    { path: 'my-app/push-keys', element: <PushKeysPage /> },
  ],
};
