import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BackLink, Badge, Button, Card, EmptyState, ErrorState, FieldGroup, PageHeader, Spinner, TextField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { useFilters } from '../../lib/query.js';
import { describeOutcome } from '../compliance/reasons.js';
import './inbox.css';

const COMMENT_ID_MAX = 80;

function Answer({ commentId }) {
  const answer = useQuery({ queryKey: ['why-no-dm', commentId], queryFn: () => api.compliance.whyNoDm({ commentId }), retry: false });
  if (answer.isPending) return <Spinner label="Looking it up" />;
  if (answer.isError) {
    if (answer.error.status === 404) return <EmptyState title="Nothing recorded for that comment">We keep these for 90 days. Check the comment ID and try again.</EmptyState>;
    return <ErrorState title="We couldn’t look that up" error={answer.error} onRetry={() => answer.refetch()} />;
  }
  const { label, tone } = describeOutcome(answer.data.outcome);
  return (
    <Card aria-label="The answer">
      <div className="why-answer">
        <Badge tone={tone}>{label}</Badge>
        <p>
          {answer.data.explanation}
          {answer.data.reason && <code className="why-code">{answer.data.reason}</code>}
        </p>
        <p className="muted">{formatDateTime(answer.data.at)}</p>
      </div>
    </Card>
  );
}

export default function WhyNoDmPage() {
  const [params, setFilter] = useFilters();
  const asked = (params.get('commentId') ?? '').trim().slice(0, COMMENT_ID_MAX);
  const [draft, setDraft] = useState(asked);
  useEffect(() => setDraft(asked), [asked]);

  function submit(event) {
    event.preventDefault();
    setFilter('commentId', draft.trim());
  }

  return (
    <>
      <BackLink to="/inbox">Inbox</BackLink>
      <PageHeader title="Why no DM?" />
      <p className="lead">Paste a comment’s ID to see what we decided about it, and why.</p>
      <form className="inline-field" onSubmit={submit} noValidate>
        <FieldGroup>
          <TextField label="Comment ID" autoComplete="off" maxLength={COMMENT_ID_MAX} value={draft} onChange={(event) => setDraft(event.target.value)} />
        </FieldGroup>
        <Button type="submit" variant="soft" disabled={!draft.trim()}>Look up</Button>
      </form>
      {asked
        ? <Answer key={asked} commentId={asked} />
        : <EmptyState title="Nothing to look up yet">The compliance log links here from each comment it mentions.</EmptyState>}
    </>
  );
}
