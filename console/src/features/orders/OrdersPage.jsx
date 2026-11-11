import { Link } from 'react-router-dom';
import { Chip, ChipRow, EmptyState, FieldGroup, ListCard, ListRow, LoadMore, Loadable, PageHeader, SearchField, SelectField, TextField, Toggle } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime, formatPaise, plural } from '../../lib/format.js';
import { useFilters, usePagedList, useSearchBox } from '../../lib/query.js';
import { OrderStatusBadge } from './OrderStatusBadge.jsx';
import { ORDER_STATUS } from './status.js';
import { ORDER_AREA } from './shared/areas.js';
import { FULFILMENT_STATUSES, PAYMENT_STATUSES } from './shared/contract.js';
import { FULFILMENT, PAYMENT } from './shared/labels.js';
import { orderBadges } from './shared/rules.js';
import { Badges, StoreTabs } from './shared/ui.jsx';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function MoreFilters({ params, setFilter }) {
  const fulfilment = params.get('fulfilment') ?? '';
  const payment = params.get('payment') ?? '';
  const open = Boolean(fulfilment || payment || params.get('held') || params.get('from') || params.get('to'));
  return (
    <details className="store-more" open={open}>
      <summary>More filters</summary>
      <FieldGroup>
        <SelectField label="Where the parcel is" value={fulfilment} onChange={(event) => setFilter('fulfilment', event.target.value)}>
          <option value="">Any</option>
          {FULFILMENT_STATUSES.map((key) => <option key={key} value={key}>{FULFILMENT[key].label}</option>)}
        </SelectField>
        <SelectField label="Where the money is" value={payment} onChange={(event) => setFilter('payment', event.target.value)}>
          <option value="">Any</option>
          {PAYMENT_STATUSES.map((key) => <option key={key} value={key}>{PAYMENT[key].label}</option>)}
        </SelectField>
        <div className="store-grid-2">
          <TextField label="Placed from" type="date" value={params.get('from') ?? ''} onChange={(event) => setFilter('from', event.target.value)} />
          <TextField label="Placed until" type="date" value={params.get('to') ?? ''} onChange={(event) => setFilter('to', event.target.value)} />
        </div>
      </FieldGroup>
      <Toggle label="Only orders on hold" checked={params.get('held') === 'true'} onChange={(event) => setFilter('held', event.target.checked ? 'true' : '')} />
    </details>
  );
}

export default function OrdersPage() {
  const [params, setFilter] = useFilters();
  const status = ORDER_STATUS[params.get('status')] ? params.get('status') : '';
  const search = params.get('search') ?? '';
  const fulfilment = FULFILMENT[params.get('fulfilment')] ? params.get('fulfilment') : '';
  const payment = PAYMENT[params.get('payment')] ? params.get('payment') : '';
  const held = params.get('held') === 'true' ? 'true' : '';
  const from = DATE.test(params.get('from') ?? '') ? params.get('from') : '';
  const to = DATE.test(params.get('to') ?? '') ? params.get('to') : '';
  const [text, setText] = useSearchBox(search, (value) => setFilter('search', value));
  const filters = { status, search, fulfilment, payment, held, from, to };
  const orders = usePagedList('orders', api.orders.list, Object.fromEntries(Object.entries(filters).map(([key, value]) => [key, value || undefined])));
  const filtered = Object.values(filters).some(Boolean);

  return (
    <>
      <PageHeader title="Orders" />
      <StoreTabs label="Orders area" tabs={ORDER_AREA} current="/orders" />
      <div className="filters">
        <ChipRow label="Filter by status">
          <Chip pressed={!status} onClick={() => setFilter('status', '')}>All</Chip>
          {Object.entries(ORDER_STATUS).map(([key, { label }]) => (
            <Chip key={key} pressed={status === key} onClick={() => setFilter('status', key)}>{label}</Chip>
          ))}
        </ChipRow>
        <SearchField label="Order no., name or phone" value={text} onChange={(event) => setText(event.target.value)} />
        <MoreFilters params={params} setFilter={setFilter} />
      </div>
      <Loadable query={orders} label="Loading your orders" errorTitle="We couldn’t load your orders">
        {() => (orders.items.length ? (
          <>
            <ListCard>
              {orders.items.map((order) => {
                const badges = orderBadges(order);
                return (
                  <ListRow
                    key={order.id}
                    as={Link}
                    to={`/orders/${order.id}`}
                    title={order.orderNumber}
                    meta={`${order.customerName}${order.city ? `, ${order.city}` : ''} · ${formatDateTime(order.createdAt)} · ${plural(order.itemCount, 'item')}`}
                    trailing={(
                      <span className="row-end">
                        <span className="row-money">{formatPaise(order.totalPaise)}</span>
                        {badges ? <Badges items={badges} /> : <OrderStatusBadge status={order.status} />}
                      </span>
                    )}
                  />
                );
              })}
            </ListCard>
            <LoadMore query={orders} />
          </>
        ) : (
          <EmptyState title={filtered ? 'No orders match' : 'No orders yet'}>
            {filtered ? 'Try another status, filter or search.' : 'They’ll appear here as soon as someone checks out.'}
          </EmptyState>
        ))}
      </Loadable>
    </>
  );
}
