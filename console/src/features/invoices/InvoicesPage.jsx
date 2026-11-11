import { Link } from 'react-router-dom';
import { MANAGERS } from '@contracts/access.js';
import { Button, EmptyState, LoadMore, PageHeader, Panel } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useAllowed, useFilters, usePagedList } from '../../lib/query.js';
import { ORDER_AREA } from '../orders/shared/areas.js';
import { StoreScreen, StoreTabs } from '../orders/shared/ui.jsx';
import { InvoiceLine } from './OrderInvoices.jsx';

export default function InvoicesPage() {
  const allowed = useAllowed();
  const [params, setFilter] = useFilters();
  const orderId = /^\d+$/.test(params.get('orderId') ?? '') ? params.get('orderId') : '';
  const invoices = usePagedList('invoices', api.invoices.list, { orderId: orderId || undefined });

  return (
    <>
      <PageHeader title="Invoices" actions={allowed(MANAGERS) ? <Button as={Link} variant="soft" to="/invoices/settings">GST details</Button> : null} />
      <StoreTabs label="Orders area" tabs={ORDER_AREA} current="/invoices" />
      <p className="lead">Made for you: a tax invoice when an order is paid, or delivered for cash on delivery, and a credit note for each refund.</p>
      {orderId && <Button variant="outline" onClick={() => setFilter('orderId', '')}>Show every invoice</Button>}
      <StoreScreen query={invoices} label="Loading your invoices" errorTitle="We couldn’t load your invoices">
        {() => (invoices.items.length ? (
          <>
            <Panel aria-label="Your invoices">
              {invoices.items.map((invoice) => <InvoiceLine key={invoice.id} invoice={invoice} showOrder />)}
            </Panel>
            <LoadMore query={invoices} />
          </>
        ) : (
          <EmptyState title="No invoices yet">The first one is made when an order is paid.</EmptyState>
        ))}
      </StoreScreen>
    </>
  );
}
