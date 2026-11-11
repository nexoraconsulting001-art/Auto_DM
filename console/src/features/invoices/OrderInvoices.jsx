import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Button, EmptyState, Panel } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDate, formatPaise } from '../../lib/format.js';
import { DOC_TYPES, taxLine } from '../orders/shared/rules.js';
import { StoreScreen } from '../orders/shared/ui.jsx';

export function InvoiceLine({ invoice, showOrder }) {
  return (
    <div className="order-line">
      <div className="order-line-head">
        <span className="order-line-title">{DOC_TYPES[invoice.docType] ?? invoice.docType} {invoice.number}</span>
        <span className="row-money">{formatPaise(invoice.totalPaise)}</span>
      </div>
      <span className="order-line-meta">
        {formatDate(invoice.issuedAt)} · Taxable {formatPaise(invoice.taxablePaise)} · {taxLine(invoice)}
        {invoice.balancePaise ? ` · ${formatPaise(invoice.advancePaise)} paid ahead, ${formatPaise(invoice.balancePaise)} at the door` : ''}
      </span>
      <div className="row-actions">
        {invoice.fileUrl && <Button as="a" variant="soft" href={invoice.fileUrl} target="_blank" rel="noopener">Open the PDF</Button>}
        {showOrder && <Button as={Link} variant="outline" to={`/orders/${invoice.orderId}`}>Open the order</Button>}
      </div>
    </div>
  );
}

export function OrderInvoices({ order }) {
  const invoices = useQuery({ queryKey: ['invoices', 'order', String(order.id)], queryFn: () => api.invoices.list({ orderId: order.id, limit: 20 }) });
  return (
    <Panel title="Invoices">
      <StoreScreen query={invoices} label="Loading the invoices" errorTitle="We couldn’t load the invoices">
        {({ items }) => (items.length
          ? <div>{items.map((invoice) => <InvoiceLine key={invoice.id} invoice={invoice} />)}</div>
          : <EmptyState title="No invoice yet">{order.paymentMode === 'cod' ? 'It is made when the order is delivered.' : 'It is made when the order is paid.'}</EmptyState>)}
      </StoreScreen>
    </Panel>
  );
}
