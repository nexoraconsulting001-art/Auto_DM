import { Link } from 'react-router-dom';
import { staffWith } from '@contracts/access.js';
import { EmptyState, ListCard, ListRow, LoadMore, PageHeader } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { plural } from '../../lib/format.js';
import { useAllowed, usePagedList } from '../../lib/query.js';
import { REVIEW_AREA } from '../orders/shared/areas.js';
import { StoreScreen, StoreTabs } from '../orders/shared/ui.jsx';

/** How many shoppers saved each product (9.20). Never who: the API sends counts only (S-86). */
export default function SavesPage() {
  const allowed = useAllowed();
  const canSee = allowed(staffWith('analytics'));
  const saves = usePagedList('wishlist', api.wishlist.counts, {}, { enabled: canSee });
  if (!canSee) return <EmptyState title="You don’t have access to this">Ask the owner of this business if you need it.</EmptyState>;
  return (
    <>
      <PageHeader title="Saved by shoppers" />
      <StoreTabs label="Reviews area" tabs={REVIEW_AREA} current="/reviews/saves" />
      <p className="lead">How many shoppers saved each product to their wishlist. You see the count only, never who.</p>
      <StoreScreen query={saves} label="Loading the saves" errorTitle="We couldn’t load the saves">
        {() => (saves.items.length ? (
          <>
            <ListCard aria-label="Saves per product">
              {saves.items.map((item) => (
                <ListRow key={item.productId} as={Link} to={`/catalog/${item.productId}`} title={item.name} trailing={<span className="row-money">{plural(item.saves, 'save')}</span>} />
              ))}
            </ListCard>
            <LoadMore query={saves} />
          </>
        ) : (
          <EmptyState title="Nothing saved yet">When shoppers tap the heart on a product, the count shows here.</EmptyState>
        ))}
      </StoreScreen>
    </>
  );
}
