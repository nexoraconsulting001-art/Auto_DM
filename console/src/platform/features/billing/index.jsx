import { CreditCard } from 'lucide-react';
import { NotBuilt } from '../../NotBuilt.jsx';

/** A business’s plan, invoices and holds, and Bhava’s billing settings (PRD 5.12). Routes: platform.billing, overridePlan, createCreditNote, suspendBilling, resumeBilling, billingSettings. */
function BillingPage() {
  return <NotBuilt title="Billing">A business’s plan, invoices and holds, and Bhava’s billing settings (PRD 5.12).</NotBuilt>;
}

export default {
  name: 'billing',
  roles: ['super_admin', 'support'],
  nav: { to: '/billing', label: 'Billing', icon: CreditCard, order: 70 },
  routes: [{ path: 'billing', element: <BillingPage /> }],
};
