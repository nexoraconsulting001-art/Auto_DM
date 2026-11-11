import { Link, useLocation } from 'react-router-dom';
import { Button, EmptyState, ListCard, ListRow, LoadMore, PageHeader } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { useFilters, usePagedList } from '../../lib/query.js';
import { STOCK_AREA } from '../orders/shared/areas.js';
import { StoreScreen, StoreTabs } from '../orders/shared/ui.jsx';
import { MOVEMENT_REASONS, signed } from './form.js';

/** Every change to stock on hand and why: sales, cancellations, returns, imports and changes by hand. */
export default function MovementsPage() {
  const [params] = useFilters();
  const productId = /^\d+$/.test(params.get('productId') ?? '') ? params.get('productId') : '';
  const { state } = useLocation();
  const name = productId ? String(state?.name ?? '').slice(0, 120) : '';
  const movements = usePagedList('inventory-movements', api.inventory.movements, { productId: productId || undefined });

  return (
    <>
      <PageHeader title={name ? `Stock changes: ${name}` : 'Stock changes'} />
      <StoreTabs label="Stock area" tabs={STOCK_AREA} current="/inventory/movements" />
      {productId && <Button as={Link} variant="outline" to="/inventory/movements">Show every product</Button>}
      <StoreScreen query={movements} label="Loading the stock changes" errorTitle="We couldn’t load the stock changes">
        {() => (movements.items.length ? (
          <>
            <ListCard aria-label="Stock changes">
              {movements.items.map((movement) => (
                <ListRow
                  key={movement.id}
                  title={MOVEMENT_REASONS[movement.reason] ?? movement.reason}
                  meta={(
                    <>
                      {!productId && `Product ${movement.productId} · `}
                      {movement.actor} · {formatDateTime(movement.at)}
                      {movement.orderId && <> · <Link to={`/orders/${movement.orderId}`}>Open the order</Link></>}
                    </>
                  )}
                  trailing={<span className="row-money">{signed(movement.delta)}</span>}
                />
              ))}
            </ListCard>
            <LoadMore query={movements} />
          </>
        ) : (
          <EmptyState title="No stock changes yet">Sales, cancellations, returns and your own changes are listed here.</EmptyState>
        ))}
      </StoreScreen>
    </>
  );
}
