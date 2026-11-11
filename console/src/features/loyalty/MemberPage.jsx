import { useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { OWNER_ONLY } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { BackLink, Banner, Button, EmptyState, FieldGroup, ListCard, ListRow, LoadMore, PageHeader, Panel, TextField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDate, formatDateTime } from '../../lib/format.js';
import { useForm } from '../../lib/forms.js';
import { useAllowed, usePagedList, useRefresh } from '../../lib/query.js';
import { LOYALTY_ENTRY, LOYALTY_KIND_LABELS } from '../orders/shared/labels.js';
import { StoreScreen, toSigned } from '../orders/shared/ui.jsx';

/** The owner adds or takes away points by hand, saying why (owner only). */
function Adjust({ shopperId, onDone }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const form = useForm({ points: '', note: '' });

  async function submit(event) {
    event.preventDefault();
    const points = toSigned(form.values.points);
    const found = {};
    if (!Number.isInteger(points) || points === 0 || Math.abs(points) > 1_000_000) found.points = 'Enter points to add, or a minus number to take away';
    if (!form.values.note.trim()) found.note = 'Say why';
    if (Object.keys(found).length) return form.reject(found);
    let member = null;
    const done = await form.run(async () => {
      member = await api.loyalty.adjust(shopperId, { points, note: form.values.note.trim() });
    });
    if (done) {
      form.set('points', '');
      form.set('note', '');
      toast(`Balance is now ${member?.balance ?? ''} points.`);
      onDone(member);
      await refresh();
    }
    return undefined;
  }

  return (
    <Panel title="Change points">
      <form className="stack" onSubmit={submit} noValidate>
        <FieldGroup>
          <TextField label="Points" inputMode="numeric" placeholder="e.g. 50 or -20" {...form.field('points')} />
          <TextField label="Why" maxLength={200} {...form.field('note')} />
        </FieldGroup>
        {form.message && <Banner tone="bad">{form.message}</Banner>}
        <Button type="submit" variant="soft" loading={form.busy}>Change points</Button>
      </form>
    </Panel>
  );
}

export default function MemberPage() {
  const { id } = useParams();
  const { state } = useLocation();
  const allowed = useAllowed();
  const ledger = usePagedList(`loyalty-ledger-${id}`, (query) => api.loyalty.ledger(id, query));
  const [balance, setBalance] = useState(null);
  const name = state?.name || `Customer ${id}`;

  return (
    <>
      <BackLink to="/loyalty">Loyalty points</BackLink>
      <PageHeader title={name} />
      {balance !== null && <p className="lead">Balance: {balance} points.</p>}
      <StoreScreen query={ledger} detail label="Loading their points" errorTitle="We couldn’t load their points">
        {() => (ledger.items.length ? (
          <>
            <ListCard aria-label="Points history">
              {ledger.items.map((entry) => (
                <ListRow
                  key={entry.id}
                  title={`${LOYALTY_KIND_LABELS[entry.kind] ?? entry.kind}${LOYALTY_ENTRY[entry.status] ? `, ${LOYALTY_ENTRY[entry.status].toLowerCase()}` : ''}`}
                  meta={[formatDateTime(entry.at), entry.status === 'pending' && entry.availableAt ? `Posts ${formatDate(entry.availableAt)}` : '', entry.expiresAt ? `Expires ${formatDate(entry.expiresAt)}` : '', entry.orderId ? `Order ${entry.orderId}` : ''].filter(Boolean).join(' · ')}
                  trailing={<span className="row-money">{entry.points > 0 ? `+${entry.points}` : `−${Math.abs(entry.points)}`}</span>}
                />
              ))}
            </ListCard>
            <LoadMore query={ledger} />
          </>
        ) : <EmptyState title="No points yet">Points earned, spent and changed by you show here.</EmptyState>)}
      </StoreScreen>
      {allowed(OWNER_ONLY) && <Adjust shopperId={id} onDone={(member) => setBalance(member?.balance ?? null)} />}
    </>
  );
}
