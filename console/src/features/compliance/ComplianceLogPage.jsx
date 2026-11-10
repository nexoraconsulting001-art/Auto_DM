import { Link } from 'react-router-dom';
import { staffWith } from '@contracts/access.js';
import { BackLink, Badge, Button, Chip, ChipRow, EmptyState, FieldGroup, ListCard, Loadable, LoadMore, PageHeader, SelectField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { useAllowed, useFilters, usePagedList } from '../../lib/query.js';
import { logFilters } from './notices.js';
import { OUTCOME_CODES, REASON_LIST, describeKind, describeOutcome, describeReason, isOutcome } from './reasons.js';
import './compliance.css';

function LogRow({ row, canAsk }) {
  const { label, tone } = describeOutcome(row.outcome);
  return (
    <div className="list-row">
      <span className="list-row-main">
        <span className="list-row-title">{describeReason(row.reason || row.outcome)}</span>
        <span className="list-row-meta log-row-meta">
          <span>{describeKind(row.kind)}, {row.channel === 'facebook' ? 'Facebook' : 'Instagram'}, {formatDateTime(row.at)}</span>
          {row.reason && <code className="log-code">{row.reason}</code>}
          {(row.automationId || (row.commentId && canAsk)) && (
            <span className="log-links">
              {row.automationId && <Link to={`/automations/${row.automationId}`}>Open automation</Link>}
              {row.commentId && canAsk && <Link to={`/inbox/why-no-dm?commentId=${encodeURIComponent(row.commentId)}`}>Why no DM?</Link>}
            </span>
          )}
        </span>
      </span>
      <Badge tone={tone}>{label}</Badge>
    </div>
  );
}

export default function ComplianceLogPage() {
  const allowed = useAllowed();
  const [params, setFilter] = useFilters();
  const filters = logFilters(params);
  const log = usePagedList('compliance-log', api.compliance.activity, filters);
  const filtered = Object.keys(filters).length > 0;
  return (
    <>
      <BackLink to="/compliance">Compliance</BackLink>
      <PageHeader title="Compliance log" />
      <p className="lead">Every decision about a message, newest first. People are never named here.</p>
      <div className="filters">
        <ChipRow label="Filter by what happened">
          <Chip pressed={!filters.outcome} onClick={() => setFilter('outcome', '')}>All</Chip>
          {OUTCOME_CODES.map((code) => <Chip key={code} pressed={filters.outcome === code} onClick={() => setFilter('outcome', code)}>{describeOutcome(code).label}</Chip>)}
        </ChipRow>
        <FieldGroup>
          <SelectField label="Reason" value={filters.reason ?? ''} onChange={(event) => setFilter('reason', event.target.value)}>
            <option value="">Any reason</option>
            {REASON_LIST.filter((code) => !isOutcome(code)).map((code) => <option key={code} value={code}>{describeReason(code)}</option>)}
          </SelectField>
        </FieldGroup>
      </div>
      <Loadable query={log} label="Loading the compliance log" errorTitle="We couldn’t load the compliance log">
        {() => (log.items.length ? (
          <>
            <ListCard>{log.items.map((row) => <LogRow key={row.id} row={row} canAsk={allowed(staffWith('inbox'))} />)}</ListCard>
            <LoadMore query={log} />
          </>
        ) : (
          <EmptyState title={filtered ? 'Nothing matches' : 'Nothing logged yet'} action={filtered ? <Button as={Link} variant="soft" to="/compliance/log">Show everything</Button> : undefined}>
            {filtered ? 'Try another filter.' : 'Decisions appear here as soon as your automations start working.'}
          </EmptyState>
        ))}
      </Loadable>
    </>
  );
}
