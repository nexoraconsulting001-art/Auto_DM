import { Link } from 'react-router-dom';
import { Badge, Button, Chip, ChipRow, EmptyState, ListCard, ListRow, Loadable, LoadMore, PageHeader } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDate, plural } from '../../lib/format.js';
import { useFilters, usePagedList } from '../../lib/query.js';
import { NoticeList } from '../compliance/StatusNotices.jsx';
import { useStatusNotices } from '../compliance/useStatus.js';
import { STATES, triggerOf } from './form.js';
import './automations.css';

function summary(row) {
  const reach = row.mediaCount > 0 ? plural(row.mediaCount, 'post') : triggerOf(row.triggerType).short;
  return `${reach}, ${row.linkMode === 'two_tap' ? 'two taps' : 'one tap'}, ${plural(row.sends, 'DM')} sent. Changed ${formatDate(row.updatedAt)}.`;
}

export default function AutomationsPage() {
  const notices = useStatusNotices();
  const [params, setFilter] = useFilters();
  const state = Object.hasOwn(STATES, params.get('state') ?? '') ? params.get('state') : '';
  const list = usePagedList('automations', api.automations.list, state ? { state } : {});
  return (
    <>
      <PageHeader title="DM automations" actions={<Button as={Link} to="/automations/new">New automation</Button>} />
      <p className="lead">A comment, story reply or DM comes in, and the right message goes back by itself.</p>
      <NoticeList notices={notices} />
      <ChipRow label="Filter by state">
        <Chip pressed={!state} onClick={() => setFilter('state', '')}>All</Chip>
        {Object.entries(STATES).map(([value, { label }]) => <Chip key={value} pressed={state === value} onClick={() => setFilter('state', value)}>{label}</Chip>)}
      </ChipRow>
      <Loadable query={list} label="Loading your automations" errorTitle="We couldn’t load your automations">
        {() => (list.items.length ? (
          <>
            <ListCard>
              {list.items.map((row) => (
                <ListRow key={row.id} as={Link} to={`/automations/${row.id}`} title={row.name} meta={summary(row)} trailing={<Badge tone={STATES[row.state].tone}>{STATES[row.state].label}</Badge>} />
              ))}
            </ListCard>
            <LoadMore query={list} />
          </>
        ) : (
          <EmptyState title={state ? 'Nothing in this view' : 'No automations yet'} action={state ? undefined : <Button as={Link} variant="soft" to="/automations/new">Set up your first one</Button>}>
            {state ? 'Try another filter.' : 'Pick a reel, choose a keyword, and write the DM.'}
          </EmptyState>
        ))}
      </Loadable>
    </>
  );
}
