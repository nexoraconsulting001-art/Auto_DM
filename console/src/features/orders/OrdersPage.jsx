import { Link } from 'react-router-dom';
import { Chip, ChipRow, EmptyState, ListCard, ListRow, LoadMore, Loadable, PageHeader, SearchField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime, formatPaise, plural } from '../../lib/format.js';
import { useFilters, usePagedList, useSearchBox } from '../../lib/query.js';
import { OrderStatusBadge } from './OrderStatusBadge.jsx';
import { ORDER_STATUS } from './status.js';

export default function OrdersPage() {
  const [params, setFilter] = useFilters();
  const status = ORDER_STATUS[params.get('status')] ? params.get('status') : '';
  const search = params.get('search') ?? '';
  const [text, setText] = useSearchBox(search, (value) => setFilter('search', value));
  const orders = usePagedList('orders', api.orders.list, { status: status || undefined, search: search || undefined });

  return (
    <>
      <PageHeader title="Orders" />
      <div className="filters">
        <ChipRow label="Filter by status">
          <Chip pressed={!status} onClick={() => setFilter('status', '')}>All</Chip>
          {Object.entries(ORDER_STATUS).map(([key, { label }]) => (
            <Chip key={key} pressed={status === key} onClick={() => setFilter('status', key)}>{label}</Chip>
          ))}
        </ChipRow>
        <SearchField label="Order no., name or phone" value={text} onChange={(event) => setText(event.target.value)} />
      </div>
      <Loadable query={orders} label="Loading your orders" errorTitle="We couldn’t load your orders">
        {() => (orders.items.length ? (
          <>
            <ListCard>
              {orders.items.map((order) => (
                <ListRow
                  key={order.id}
                  as={Link}
                  to={`/orders/${order.id}`}
                  title={order.orderNumber}
                  meta={`${order.customerName}${order.city ? `, ${order.city}` : ''} · ${formatDateTime(order.createdAt)} · ${plural(order.itemCount, 'item')}`}
                  trailing={(
                    <span className="row-end">
                      <span className="row-money">{formatPaise(order.totalPaise)}</span>
                      <OrderStatusBadge status={order.status} />
                    </span>
                  )}
                />
              ))}
            </ListCard>
            <LoadMore query={orders} />
          </>
        ) : (
          <EmptyState title={status || search ? 'No orders match' : 'No orders yet'}>
            {status || search ? 'Try another status or search.' : 'They’ll appear here as soon as someone checks out.'}
          </EmptyState>
        ))}
      </Loadable>
    </>
  );
}
