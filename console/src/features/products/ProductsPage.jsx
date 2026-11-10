import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Badge, Button, Chip, ChipRow, EmptyState, FieldGroup, ListCard, ListRow, LoadMore, Loadable, PageHeader, SearchField, SelectField, Thumb } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatPaise } from '../../lib/format.js';
import { fetchAll, useFilters, usePagedList, useSearchBox } from '../../lib/query.js';

const TABS = [['all', 'All'], ['active', 'Active'], ['featured', 'Featured'], ['archived', 'Archived']];

const stockText = (stock) => (stock === null ? 'Unlimited stock' : stock === 0 ? 'Sold out' : `${stock} in stock`);

function ProductRow({ product }) {
  const details = [
    stockText(product.stock),
    product.reelCount > 0 && `In ${product.reelCount} reel${product.reelCount === 1 ? '' : 's'}`,
    product.categoryNames.join(', '),
  ].filter(Boolean).join(' · ');
  return (
    <ListRow
      as={Link}
      to={`/products/${product.id}`}
      leading={<Thumb src={product.images[0]} alt="" />}
      title={product.name}
      meta={details}
      trailing={(
        <span className="row-end">
          <span className="row-money">
            {formatPaise(product.pricePaise)}
            {product.mrpPaise > product.pricePaise && <s className="row-strike">{formatPaise(product.mrpPaise)}</s>}
          </span>
          {product.active ? (product.featured ? <Badge tone="neel">Featured</Badge> : <Badge tone="good">Active</Badge>) : <Badge>Archived</Badge>}
        </span>
      )}
    />
  );
}

export default function ProductsPage() {
  const [params, setFilter] = useFilters();
  const status = TABS.some(([key]) => key === params.get('status')) ? params.get('status') : 'all';
  const category = /^\d+$/.test(params.get('category') ?? '') ? params.get('category') : '';
  const search = params.get('search') ?? '';
  const [text, setText] = useSearchBox(search, (value) => setFilter('search', value));

  const categories = useQuery({ queryKey: ['categories', 'all'], queryFn: () => fetchAll(api.categories.list) });
  const products = usePagedList('products', api.products.list, { status, category: category || undefined, search: search || undefined });
  const filtered = status !== 'all' || category || search;
  const add = <Button as={Link} to="/products/new"><Plus size={16} strokeWidth={2} aria-hidden="true" />Add product</Button>;

  return (
    <>
      <PageHeader title="Products" actions={add} />
      <div className="filters">
        <ChipRow label="Filter by status">
          {TABS.map(([key, label]) => <Chip key={key} pressed={status === key} onClick={() => setFilter('status', key === 'all' ? '' : key)}>{label}</Chip>)}
        </ChipRow>
        <SearchField label="Search products" value={text} onChange={(event) => setText(event.target.value)} />
        {categories.data?.length > 0 && (
          <FieldGroup>
            <SelectField label="Category" value={category} onChange={(event) => setFilter('category', event.target.value)}>
              <option value="">All categories</option>
              {categories.data.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </SelectField>
          </FieldGroup>
        )}
      </div>
      <Loadable query={products} label="Loading your products" errorTitle="We couldn’t load your products">
        {() => (products.items.length ? (
          <>
            <ListCard>{products.items.map((product) => <ProductRow key={product.id} product={product} />)}</ListCard>
            <LoadMore query={products} />
          </>
        ) : (
          <EmptyState title={filtered ? 'No products match' : 'Your catalog is empty'} action={filtered ? undefined : <Button as={Link} variant="soft" to="/products/new">Add your first product</Button>}>
            {filtered ? 'Try another search or filter.' : 'Add what you sell, then link it to your reels.'}
          </EmptyState>
        ))}
      </Loadable>
    </>
  );
}
