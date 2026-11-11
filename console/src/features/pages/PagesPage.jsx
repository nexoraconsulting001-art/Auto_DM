import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { MANAGERS } from '@contracts/access.js';
import { Badge, Button, Chip, ChipRow, EmptyState, ListCard, ListRow, LoadMore, PageHeader, SearchField, Thumb } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useAllowed, useFilters, usePagedList, useSearchBox } from '../../lib/query.js';
import { AreaTabs, Screen } from '../catalog/shared/ui.jsx';
import { KIND_TABS, PAGE_TABS, STATUS_TABS, pageLine } from './form.js';

function PageRow({ page }) {
  return (
    <ListRow
      as={Link}
      to={`/pages/${page.id}`}
      leading={<Thumb src={page.thumbnailUrl} alt="" tall />}
      title={page.headline || `/r/${page.slug}`}
      meta={pageLine(page)}
      trailing={page.active ? <Badge tone="good">Live</Badge> : <Badge>Off</Badge>}
    />
  );
}

export default function PagesPage() {
  const allowed = useAllowed();
  const [params, setFilter] = useFilters();
  const kind = KIND_TABS.some(([key]) => key === params.get('kind')) ? params.get('kind') : 'all';
  const status = STATUS_TABS.some(([key]) => key === params.get('status')) ? params.get('status') : 'all';
  const search = params.get('search') ?? '';
  const [text, setText] = useSearchBox(search, (value) => setFilter('search', value));
  const pages = usePagedList('pages', api.pages.list, { kind, status, search: search || undefined });
  const filtered = kind !== 'all' || status !== 'all' || search;
  const add = <Button as={Link} to="/pages/new"><Plus size={16} strokeWidth={2} aria-hidden="true" />New page</Button>;

  return (
    <>
      <PageHeader title="Landing pages" actions={add} />
      {allowed(MANAGERS) && <AreaTabs label="Landing page settings" tabs={PAGE_TABS} current="/pages" />}
      <p className="lead">One page for each reel, post or story, on your own web address. Its link is what your automatic replies send.</p>
      <div className="filters">
        <ChipRow label="Filter by kind">
          {KIND_TABS.map(([key, label]) => <Chip key={key} pressed={kind === key} onClick={() => setFilter('kind', key === 'all' ? '' : key)}>{label}</Chip>)}
        </ChipRow>
        <ChipRow label="Filter by status">
          {STATUS_TABS.map(([key, label]) => <Chip key={key} pressed={status === key} onClick={() => setFilter('status', key === 'all' ? '' : key)}>{label}</Chip>)}
        </ChipRow>
        <SearchField label="Search pages" value={text} onChange={(event) => setText(event.target.value)} />
      </div>
      <Screen query={pages} label="Loading your pages" errorTitle="We couldn’t load your pages">
        {() => (pages.items.length ? (
          <>
            <ListCard aria-label="Landing pages">{pages.items.map((page) => <PageRow key={page.id} page={page} />)}</ListCard>
            <LoadMore query={pages} />
          </>
        ) : (
          <EmptyState title={filtered ? 'No pages match' : 'No landing pages yet'} action={filtered ? undefined : <Button as={Link} variant="soft" to="/pages/new">Make your first page</Button>}>
            {filtered ? 'Try another search or filter.' : 'Pick a reel or post, choose the products it shows, and its page is ready to share.'}
          </EmptyState>
        ))}
      </Screen>
    </>
  );
}
