import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Badge, EmptyState, ListCard, ListRow, LoadMore, PageHeader, Panel, Stat, TextField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime, formatPaise } from '../../lib/format.js';
import { useFilters, usePagedList } from '../../lib/query.js';
import { PAYMENT_AREA } from '../orders/shared/areas.js';
import { SETTLEMENT } from '../orders/shared/labels.js';
import { StoreScreen, StoreTabs } from '../orders/shared/ui.jsx';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The statement (9.6): what each order earned, and every charge at cost with no markup, for the dates chosen. */
function Summary({ from, to }) {
  const summary = useQuery({ queryKey: ['settlements', 'summary', from, to], queryFn: () => api.settlements.summary({ from: from || undefined, to: to || undefined }) });
  return (
    <Panel title="For these dates">
      <StoreScreen query={summary} label="Loading the totals" errorTitle="We couldn’t load the totals">
        {(data) => (
          <>
            <div className="store-stats">
              <Stat value={formatPaise(data.salesPaise)} label="Sales" />
              <Stat value={formatPaise(data.gatewayFeesPaise)} label="Gateway fees, at cost" />
              <Stat value={formatPaise(data.shippingChargesPaise)} label="Courier charges, at cost" />
              <Stat value={formatPaise(data.refundsPaise)} label="Refunds" />
              {data.recoverablePaise > 0
                ? <Stat value={formatPaise(data.recoverablePaise)} label="To recover from you" />
                : <Stat value={formatPaise(data.payablePaise)} label="Paid to you" />}
              <Stat value={String(data.inReview)} label="Lines in review" />
            </div>
            <p className="field-hint">Bhava takes no commission on sales. {data.from && data.to ? `From ${data.from} to ${data.to}.` : ''}</p>
          </>
        )}
      </StoreScreen>
    </Panel>
  );
}

export default function StatementPage() {
  const [params, setFilter] = useFilters();
  const from = DATE.test(params.get('from') ?? '') ? params.get('from') : '';
  const to = DATE.test(params.get('to') ?? '') ? params.get('to') : '';
  const orderId = /^\d+$/.test(params.get('orderId') ?? '') ? params.get('orderId') : '';
  const lines = usePagedList('settlements', api.settlements.list, { from: from || undefined, to: to || undefined, orderId: orderId || undefined });

  return (
    <>
      <PageHeader title="Statement" />
      <StoreTabs label="Payments area" tabs={PAYMENT_AREA} current="/payments/statement" />
      <div className="store-grid-2">
        <TextField label="From" type="date" value={from} onChange={(event) => setFilter('from', event.target.value)} />
        <TextField label="Until" type="date" value={to} onChange={(event) => setFilter('to', event.target.value)} />
      </div>
      <Summary from={from} to={to} />
      <StoreScreen query={lines} label="Loading your statement" errorTitle="We couldn’t load your statement">
        {() => (lines.items.length ? (
          <>
            <ListCard aria-label="Statement lines">
              {lines.items.map((line) => (
                <ListRow
                  key={line.id}
                  as={Link}
                  to={`/orders/${line.orderId}`}
                  title={SETTLEMENT[line.kind] ?? line.kind}
                  meta={`Order ${line.orderNumber} · ${formatDateTime(line.at)}`}
                  trailing={(
                    <span className="row-end">
                      <span className="row-money">{line.creditPaise ? `+${formatPaise(line.creditPaise)}` : `−${formatPaise(line.debitPaise)}`}</span>
                      {line.status === 'review' && <Badge tone="bad">In review</Badge>}
                    </span>
                  )}
                />
              ))}
            </ListCard>
            <LoadMore query={lines} />
          </>
        ) : (
          <EmptyState title={from || to || orderId ? 'Nothing for these dates' : 'No payments yet'}>
            Each order’s sale, fees, courier charge and refunds show here once it is paid.
          </EmptyState>
        ))}
      </StoreScreen>
    </>
  );
}
