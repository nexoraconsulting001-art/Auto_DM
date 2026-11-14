import CreditCard from 'lucide-react-native/icons/credit-card';
import { OWNER_ONLY } from '@bhava/app-core/access';
import BillingScreen from './BillingScreen.js';
import { InvoicesScreen, StatementsScreen } from './RecordsScreens.js';
import strings from './strings.js';

/**
 * Plan and billing (PRD 3, 5.7, 5.12): the plan, the live DM meter, packs, upgrade and downgrade, invoices and statements.
 * The owner's alone. Prices, tax and the offer come from the server; no call carries an amount and the app has no card
 * field: a payment opens the provider's hosted page in the system browser. Every buy, upgrade and pack button sits behind
 * the one build setting BILLING_ACTIONS (./actions.js). A change of money asks for a fresh check (fingerprint, face or a code).
 */
export default {
  name: 'billing',
  access: OWNER_ONLY,
  feature: null,
  routeIds: [
    'billing.plan', 'billing.catalog', 'billing.change', 'billing.addItem', 'billing.removeItem', 'billing.usage', 'billing.invoices', 'billing.invoiceFile',
    'billing.statements', 'billing.statementFile', 'billing.paymentMethod', 'billing.features',
  ],
  screens: [
    { name: 'index', path: 'billing', title: 'billing.title', component: BillingScreen },
    { name: 'invoices', path: 'billing/invoices', title: 'billing.invoices.title', component: InvoicesScreen },
    { name: 'statements', path: 'billing/statements', title: 'billing.statements.title', component: StatementsScreen },
  ],
  nav: { label: 'billing.title', order: 90, icon: CreditCard },
  strings,
};
