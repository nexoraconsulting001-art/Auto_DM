import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Download, Plus } from 'lucide-react';
import { Banner, Button, Chip, ChipRow, EmptyState, FieldGroup, ListCard, ListRow, LoadMore, PageHeader, SearchField, SelectField, Thumb } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { plural } from '../../lib/format.js';
import { fetchAll, useFilters, usePagedList, useSearchBox } from '../../lib/query.js';
import { CATALOG_TABS, SOURCE_CHOICES, STATUS_TABS, cardPrice, productBadges, sourceText } from './form.js';
import { AreaTabs, Badges, Screen } from './shared/ui.jsx';

function ProductRow({ product }) {
  const card = cardPrice(product);
  const details = [
    product.source !== 'manual' && sourceText(product.source),
    product.reelCount > 0 && `On ${plural(product.reelCount, 'page')}`,
    product.categoryNames.join(', '),
  ].filter(Boolean).join(' · ');
  return (
    <ListRow
      as={Link}
      to={`/catalog/${product.id}`}
      leading={<Thumb src={product.images[0]} alt="" />}
      title={product.name}
      meta={details}
      trailing={(
        <span className="row-end">
          <span className="row-money">
            {card.price}
            {card.strike && <s className="row-strike">{card.strike}</s>}
            {card.off && <span className="p3-off">{card.off}</span>}
          </span>
          <Badges items={productBadges(product)} />
        </span>
      )}
    />
  );
}

/** How many products are hidden from shoppers until the owner looks (8.5, 8.8), with the way to see them. */
function AttentionNotice({ onShow }) {
  const settings = useQuery({ queryKey: ['catalog', 'settings'], queryFn: () => api.catalogSettings.get() });
  const count = settings.data?.attentionCount ?? 0;
  if (!count) return null;
  return (
    <Banner tone="warn">
      {plural(count, 'product needs', 'products need')} attention: the page on your site is gone, so shoppers can’t see {count === 1 ? 'it' : 'them'}.{' '}
      <button type="button" className="p3-link" onClick={onShow}>Show {count === 1 ? 'it' : 'them'}</button>
    </Banner>
  );
}

export default function CatalogPage() {
  const [params, setFilter] = useFilters();
  const status = STATUS_TABS.some(([key]) => key === params.get('status')) ? params.get('status') : 'all';
  const source = SOURCE_CHOICES.some(([key]) => key === params.get('source')) ? params.get('source') : '';
  const category = /^\d+$/.test(params.get('category') ?? '') ? params.get('category') : '';
  const search = params.get('search') ?? '';
  const [text, setText] = useSearchBox(search, (value) => setFilter('search', value));

  const categories = useQuery({ queryKey: ['categories', 'all'], queryFn: () => fetchAll(api.categories.list) });
  const products = usePagedList('products', api.products.list, { status, category: category || undefined, source: source || undefined, search: search || undefined });
  const filtered = status !== 'all' || category || source || search;
  const actions = (
    <span className="row-actions">
      <Button as={Link} variant="soft" to="/imports"><Download size={16} strokeWidth={2} aria-hidden="true" />Import</Button>
      <Button as={Link} to="/catalog/new"><Plus size={16} strokeWidth={2} aria-hidden="true" />Add product</Button>
    </span>
  );

  return (
    <>
      <PageHeader title="Catalog" actions={actions} />
      <AreaTabs label="Catalog pages" tabs={CATALOG_TABS} current="/catalog" />
      {status !== 'attention' && <AttentionNotice onShow={() => setFilter('status', 'attention')} />}
      <div className="filters">
        <ChipRow label="Filter by status">
          {STATUS_TABS.map(([key, label]) => <Chip key={key} pressed={status === key} onClick={() => setFilter('status', key === 'all' ? '' : key)}>{label}</Chip>)}
        </ChipRow>
        <SearchField label="Search products" value={text} onChange={(event) => setText(event.target.value)} />
        <FieldGroup>
          <SelectField label="Where it came from" value={source} onChange={(event) => setFilter('source', event.target.value)}>
            {SOURCE_CHOICES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </SelectField>
          {categories.data?.length > 0 && (
            <SelectField label="Category" value={category} onChange={(event) => setFilter('category', event.target.value)}>
              <option value="">All categories</option>
              {categories.data.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </SelectField>
          )}
        </FieldGroup>
      </div>
      <Screen query={products} label="Loading your catalog" errorTitle="We couldn’t load your catalog">
        {() => (products.items.length ? (
          <>
            <ListCard aria-label="Products">{products.items.map((product) => <ProductRow key={product.id} product={product} />)}</ListCard>
            <LoadMore query={products} />
          </>
        ) : (
          <EmptyState
            title={filtered ? 'No products match' : 'Your catalog is empty'}
            action={filtered ? undefined : (
              <span className="row-actions">
                <Button as={Link} variant="soft" to="/catalog/new">Add your first product</Button>
                <Button as={Link} variant="outline" to="/imports">Import from your website</Button>
              </span>
            )}
          >
            {filtered ? 'Try another search or filter.' : 'Add what you sell by hand, or bring it in from your website, then show it on your pages.'}
          </EmptyState>
        ))}
      </Screen>
    </>
  );
}
