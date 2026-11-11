import { Link } from 'react-router-dom';
import { MANAGERS } from '@contracts/access.js';
import { Button, Chip, ChipRow, EmptyState, ListCard, ListRow, LoadMore, PageHeader } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime, plural } from '../../lib/format.js';
import { useAllowed, useFilters, usePagedList } from '../../lib/query.js';
import { ORDER_AREA } from '../orders/shared/areas.js';
import { RETURN_STATUSES } from '../orders/shared/contract.js';
import { RETURN_SHOW } from '../orders/shared/filters.js';
import { RETURN } from '../orders/shared/labels.js';
import { StatusBadge, StoreScreen, StoreTabs } from '../orders/shared/ui.jsx';

export const RESOLUTION_LABELS = Object.freeze({ refund: 'Wants a refund', exchange: 'Wants an exchange' });

export default function ReturnsPage() {
  const allowed = useAllowed();
  const [params, setFilter] = useFilters();
  const status = RETURN_STATUSES.includes(params.get('status')) ? params.get('status') : '';
  const returns = usePagedList('returns', api.returns.list, { status: status || undefined });

  return (
    <>
      <PageHeader title="Returns" actions={allowed(MANAGERS) ? <Button as={Link} variant="soft" to="/returns/settings">Return rules</Button> : null} />
      <StoreTabs label="Orders area" tabs={ORDER_AREA} current="/returns" />
      <ChipRow label="Filter returns">
        <Chip pressed={!status} onClick={() => setFilter('status', '')}>All</Chip>
        {RETURN_SHOW.map((key) => <Chip key={key} pressed={status === key} onClick={() => setFilter('status', key)}>{RETURN[key].label}</Chip>)}
      </ChipRow>
      <StoreScreen query={returns} label="Loading your returns" errorTitle="We couldn’t load your returns">
        {() => (returns.items.length ? (
          <>
            <ListCard aria-label="Returns">
              {returns.items.map((item) => (
                <ListRow
                  key={item.id}
                  as={Link}
                  to={`/returns/${item.id}`}
                  title={`Order ${item.orderNumber}`}
                  meta={`${RESOLUTION_LABELS[item.resolution] ?? item.resolution} · ${plural(item.items.reduce((sum, line) => sum + line.qty, 0), 'item')} · ${formatDateTime(item.createdAt)}`}
                  trailing={<StatusBadge table={RETURN} status={item.status} />}
                />
              ))}
            </ListCard>
            <LoadMore query={returns} />
          </>
        ) : (
          <EmptyState title={status ? 'No returns match' : 'No returns yet'}>
            {status ? 'Try another filter.' : 'Customers ask for returns from their account, with a photo or video of the item.'}
          </EmptyState>
        ))}
      </StoreScreen>
    </>
  );
}
