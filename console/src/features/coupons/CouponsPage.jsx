import { Link } from 'react-router-dom';
import { Badge, Button, Chip, ChipRow, EmptyState, ListCard, ListRow, LoadMore, PageHeader, SearchField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { plural } from '../../lib/format.js';
import { useFilters, usePagedList, useSearchBox } from '../../lib/query.js';
import { COUPON_SHOW as SHOW } from '../orders/shared/filters.js';
import { StoreScreen } from '../orders/shared/ui.jsx';
import { couponState, couponSummary } from './form.js';

export default function CouponsPage() {
  const [params, setFilter] = useFilters();
  const show = SHOW.some(([key]) => key === params.get('show')) ? params.get('show') : 'all';
  const search = params.get('search') ?? '';
  const [text, setText] = useSearchBox(search, (value) => setFilter('search', value));
  const coupons = usePagedList('coupons', api.coupons.list, { show, search: search || undefined });

  return (
    <>
      <PageHeader title="Coupons" actions={<Button as={Link} to="/coupons/new">New coupon</Button>} />
      <div className="filters">
        <ChipRow label="Filter coupons">
          {SHOW.map(([key, label]) => <Chip key={key} pressed={show === key} onClick={() => setFilter('show', key === 'all' ? '' : key)}>{label}</Chip>)}
        </ChipRow>
        <SearchField label="Search by code" value={text} onChange={(event) => setText(event.target.value)} />
      </div>
      <StoreScreen query={coupons} label="Loading your coupons" errorTitle="We couldn’t load your coupons">
        {() => (coupons.items.length ? (
          <>
            <ListCard aria-label="Coupons">
              {coupons.items.map((coupon) => {
                const state = couponState(coupon);
                return (
                  <ListRow
                    key={coupon.id}
                    as={Link}
                    to={`/coupons/${coupon.id}`}
                    title={<span className="coupon-code">{coupon.code}</span>}
                    meta={`${couponSummary(coupon)} · used ${plural(coupon.usedCount, 'time')}${coupon.maxUses ? ` of ${coupon.maxUses}` : ''}`}
                    trailing={<Badge tone={state.tone}>{state.text}</Badge>}
                  />
                );
              })}
            </ListCard>
            <LoadMore query={coupons} />
          </>
        ) : (
          <EmptyState title={show !== 'all' || search ? 'No coupons match' : 'No coupons yet'} action={show === 'all' && !search ? <Button as={Link} to="/coupons/new">Make your first coupon</Button> : null}>
            {show !== 'all' || search ? 'Try another filter or code.' : 'Make a code for a reel or story, and see how much it sold.'}
          </EmptyState>
        ))}
      </StoreScreen>
    </>
  );
}
