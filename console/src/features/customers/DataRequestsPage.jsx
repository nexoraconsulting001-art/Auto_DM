import { Link } from 'react-router-dom';
import { Chip, ChipRow, EmptyState, ListCard, LoadMore, PageHeader } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { useFilters, usePagedList } from '../../lib/query.js';
import { useLoyaltyOn } from '../loyalty/useLoyalty.js';
import { CUSTOMER_AREA, LOYALTY_TAB } from '../orders/shared/areas.js';
import { DATA_REQUEST_SHOW as SHOW } from '../orders/shared/filters.js';
import { DATA_REQUEST, DATA_REQUEST_KIND_LABELS, DATA_REQUEST_SOURCE } from '../orders/shared/labels.js';
import { summaryText } from '../orders/shared/rules.js';
import { StatusBadge, StoreScreen, StoreTabs } from '../orders/shared/ui.jsx';

/** Shoppers' requests to delete their data or have a copy (9.18), from their account, your grievance contact, or you. */
export default function DataRequestsPage() {
  const loyaltyOn = useLoyaltyOn();
  const [params, setFilter] = useFilters();
  const status = SHOW.some(([key]) => key === params.get('status')) ? params.get('status') : 'all';
  const requests = usePagedList('data-requests', api.dataRequests.list, { status });

  return (
    <>
      <PageHeader title="Data requests" />
      <StoreTabs label="Customers area" tabs={loyaltyOn ? [...CUSTOMER_AREA, LOYALTY_TAB] : CUSTOMER_AREA} current="/customers/data-requests" />
      <p className="lead">When a shopper asks for their data to be deleted, their personal details are removed and tax records are kept with them masked.</p>
      <ChipRow label="Filter data requests">
        {SHOW.map(([key, label]) => <Chip key={key} pressed={status === key} onClick={() => setFilter('status', key === 'all' ? '' : key)}>{label}</Chip>)}
      </ChipRow>
      <StoreScreen query={requests} label="Loading the data requests" errorTitle="We couldn’t load the data requests">
        {() => (requests.items.length ? (
          <>
            <ListCard aria-label="Data requests">
              {requests.items.map((request) => (
                <div key={request.id} className="order-line">
                  <div className="order-line-head">
                    <span className="order-line-title">{DATA_REQUEST_KIND_LABELS[request.kind] ?? request.kind}</span>
                    <StatusBadge table={DATA_REQUEST} status={request.status} />
                  </div>
                  <span className="order-line-meta">
                    {DATA_REQUEST_SOURCE[request.source] ?? request.source} · Asked {formatDateTime(request.requestedAt)}
                    {request.completedAt ? ` · Done ${formatDateTime(request.completedAt)}` : ''}
                  </span>
                  {summaryText(request.summary) && <span className="order-line-meta">{summaryText(request.summary)}</span>}
                  {request.shopperId && request.status !== 'completed' && <Link to={`/customers/shoppers/${request.shopperId}`}>Open the shopper</Link>}
                </div>
              ))}
            </ListCard>
            <LoadMore query={requests} />
          </>
        ) : (
          <EmptyState title={status === 'all' ? 'No data requests yet' : 'No requests match'}>
            Shoppers can ask from their account. You can also ask on their behalf from their page.
          </EmptyState>
        ))}
      </StoreScreen>
    </>
  );
}
