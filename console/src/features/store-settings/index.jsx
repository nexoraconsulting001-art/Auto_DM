import { lazy } from 'react';
import { Store } from 'lucide-react';
import { MANAGERS } from '@contracts/access.js';

const StoreSettingsPage = lazy(() => import('./StoreSettingsPage.jsx'));
const MessagesPage = lazy(() => import('./MessagesPage.jsx'));
const PoliciesPage = lazy(() => import('./PoliciesPage.jsx'));
const NoticePage = lazy(() => import('./NoticePage.jsx'));
const ShopifyPage = lazy(() => import('./ShopifyPage.jsx'));

/**
 * The store's settings in one place (PRD 9): how it is paid and ships, GST, returns, messages to shoppers by WhatsApp and
 * email (9.15, 9.16), policy pages and the grievance contact (9.18), the consent notice, and Shopify sync (9.11).
 */
export default {
  name: 'store-settings',
  access: MANAGERS,
  nav: { to: '/store-settings', label: 'Store setup', icon: Store, order: 72 },
  routes: [
    { path: 'store-settings', element: <StoreSettingsPage /> },
    { path: 'store-settings/messages', element: <MessagesPage /> },
    { path: 'store-settings/policies', element: <PoliciesPage /> },
    { path: 'store-settings/notice', element: <NoticePage /> },
    { path: 'store-settings/shopify', element: <ShopifyPage /> },
  ],
};
