import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Badge, Banner, Button, Chip, ChipRow, EmptyState, ListCard, ListRow, Loadable, LoadMore, PageHeader } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDate, plural } from '../../lib/format.js';
import { useFilters, usePagedList } from '../../lib/query.js';
import { NoticeList } from '../compliance/StatusNotices.jsx';
import { useStatusNotices } from '../compliance/useStatus.js';
import { PLAN_REFUSAL_TITLE, UPGRADE_PATH } from '../billing/contract.js';
import { STATES, triggerOf } from './form.js';
import './automations.css';

function summary(row) {
  const reach = row.mediaCount > 0 ? plural(row.mediaCount, 'post') : triggerOf(row.triggerType).short;
  return `${reach}, ${row.linkMode === 'two_tap' ? 'two taps' : 'one tap'}, ${plural(row.sends, 'DM')} sent. Changed ${formatDate(row.updatedAt)}.`;
}

/**
 * The plan's automation limit once it is reached (PRD 5.7, F-123): how many the plan includes, that all are in use, and
 * the upgrade. Read from billing.features and the automations that count against it (everything but archived, as the
 * server counts). Nothing is shown below the limit or on a plan with none; the server still refuses a fourth either way
 * (403 plan.limit_reached, which raises the console's upgrade bar).
 */
function useAutomationLimit() {
  const features = useQuery({ queryKey: ['billing', 'features'], queryFn: () => api.billing.features(), retry: false, staleTime: 60_000 });
  const limit = features.data?.features?.automations?.limit ?? null;
  const counted = useQuery({
    queryKey: ['automations', 'counted', limit],
    queryFn: () => api.automations.list({ limit: 100 }),
    enabled: Number.isInteger(limit),
    retry: false,
    staleTime: 15_000,
  });
  if (!Number.isInteger(limit) || !counted.data) return null;
  const used = counted.data.items.filter((row) => row.state !== 'archived').length;
  return used >= limit ? { limit, used } : null;
}

export default function AutomationsPage() {
  const notices = useStatusNotices();
  const [params, setFilter] = useFilters();
  const state = Object.hasOwn(STATES, params.get('state') ?? '') ? params.get('state') : '';
  const list = usePagedList('automations', api.automations.list, state ? { state } : {});
  const full = useAutomationLimit();
  return (
    <>
      <PageHeader title="DM automations" actions={<Button as={Link} to="/automations/new">New automation</Button>} />
      <p className="lead">A comment, story reply or DM comes in, and the right message goes back by itself.</p>
      <NoticeList notices={notices} />
      {full && (
        <Banner tone="warn">
          <strong>{PLAN_REFUSAL_TITLE}.</strong> Your plan includes {plural(full.limit, 'automation')}, and {full.used} are in use. Upgrade to add more, or archive one. <Link to={UPGRADE_PATH}>See plans</Link>
        </Banner>
      )}
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
