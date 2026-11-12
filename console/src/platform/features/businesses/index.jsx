import { Building2 } from 'lucide-react';
import { NotBuilt } from '../../NotBuilt.jsx';

/** Create a business, read its brand and import its products (PRD 5.5). Routes: platform.businesses, createBusiness, business, retryImport. */
function BusinessesPage() {
  return <NotBuilt title="Businesses">Create a business, read its brand and import its products (PRD 5.5).</NotBuilt>;
}

export default {
  name: 'businesses',
  roles: ['super_admin', 'support', 'onboarding'],
  nav: { to: '/businesses', label: 'Businesses', icon: Building2, order: 10 },
  routes: [{ path: 'businesses', element: <BusinessesPage /> }],
};
