import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { MANAGERS } from '@contracts/access.js';
import { CopyButton } from '../../components/copy.jsx';
import { useFeedback } from '../../components/feedback.jsx';
import { Badge, Banner, Button, EmptyState, FieldGroup, ListRow, Loadable, LoadMore, Panel, SelectField, TextField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { useAllowed, usePagedList, useRefresh } from '../../lib/query.js';
import { describeOutcome, describeReason } from '../compliance/reasons.js';

function AddTester() {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const [label, setLabel] = useState('');
  const create = useMutation({
    mutationFn: () => api.testers.createCode({ label: label.trim() }),
    onSuccess: async () => {
      setLabel('');
      await refresh();
    },
    onError: (error) => toast(error.message),
  });
  return (
    <>
      <FieldGroup>
        <TextField label="Who is testing? (optional)" maxLength={60} autoComplete="off" value={label} onChange={(event) => setLabel(event.target.value)} />
      </FieldGroup>
      <Button variant="soft" loading={create.isPending} onClick={() => create.mutate()}>Add tester</Button>
      {create.data && (
        <Banner tone="good">
          <span className="stack">
            <span>Ask them to DM this code to your Instagram account before {formatDateTime(create.data.expiresAt)}.</span>
            <span className="tester-code">{create.data.code}</span>
            <CopyButton text={create.data.code} label="Copy code" />
          </span>
        </Banner>
      )}
    </>
  );
}

function SendTest({ automation, testers }) {
  const ready = testers.filter((tester) => tester.windowOpen);
  const [testerId, setTesterId] = useState('');
  const [variantLabel, setVariantLabel] = useState('');
  const chosen = testerId || String(ready[0]?.id ?? '');
  const send = useMutation({ mutationFn: () => api.automations.sendTest(automation.id, { testerId: Number(chosen), ...(variantLabel ? { variantLabel } : {}) }) });
  if (!ready.length) return <p className="muted">“Send test to me” works once a tester has messaged you in the last 24 hours.</p>;
  const outcome = send.data && describeOutcome(send.data.outcome);
  return (
    <>
      <FieldGroup>
        <SelectField label="Send to" value={chosen} onChange={(event) => setTesterId(event.target.value)}>
          {ready.map((tester) => <option key={tester.id} value={tester.id}>{tester.label || `Tester ${tester.id}`}</option>)}
        </SelectField>
        {automation.variants.length > 1 && (
          <SelectField label="Variant" value={variantLabel} onChange={(event) => setVariantLabel(event.target.value)}>
            <option value="">Any</option>
            {automation.variants.map((variant) => <option key={variant.label} value={variant.label}>{variant.label}</option>)}
          </SelectField>
        )}
      </FieldGroup>
      <Button variant="outline" loading={send.isPending} onClick={() => send.mutate()}>Send test to me</Button>
      {outcome && <Banner tone={outcome.tone === 'good' ? 'good' : 'warn'}>{outcome.label}. {describeReason(send.data.reason)}</Banner>}
      {send.isError && <Banner tone="bad">{send.error.message}</Banner>}
    </>
  );
}

export function TestersPanel({ automation }) {
  const allowed = useAllowed();
  const canManage = allowed(MANAGERS);
  const { confirm, toast } = useFeedback();
  const refresh = useRefresh();
  const testers = usePagedList('testers', api.testers.list, { limit: 50 });
  const remove = useMutation({
    mutationFn: (id) => api.testers.remove(id),
    onSuccess: () => refresh(),
    onError: (error) => toast(error.message),
  });
  async function askToRemove(tester) {
    if (await confirm({ title: 'Remove this tester?', text: 'They go back to being treated like anyone else.', confirm: 'Remove' })) remove.mutate(tester.id);
  }
  return (
    <Panel title="Test mode">
      <p className="muted">In Test, only your testers get real DMs. Everyone else is skipped, and nothing counts in your numbers.</p>
      <Loadable query={testers} label="Loading your testers" errorTitle="We couldn’t load your testers">
        {() => (
          <>
            {testers.items.length ? (
              <div className="row-list">
                {testers.items.map((tester) => (
                  <ListRow
                    key={tester.id}
                    title={tester.label || `Tester ${tester.id}`}
                    meta={tester.windowOpen ? 'Can get a test now' : 'Needs to message you first'}
                    trailing={canManage ? <Button variant="outline" onClick={() => askToRemove(tester)}>Remove</Button> : undefined}
                  />
                ))}
              </div>
            ) : <EmptyState title="No testers yet">Add someone who can DM your account from their own Instagram.</EmptyState>}
            <LoadMore query={testers} />
            <SendTest automation={automation} testers={testers.items} />
          </>
        )}
      </Loadable>
      {canManage && <AddTester />}
    </Panel>
  );
}

function ratePercent(rate) {
  return rate === null ? '' : `, ${(rate * 100).toFixed(1)}%`;
}

export function StatsPanel({ automation }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const stats = useQuery({ queryKey: ['automation-stats', automation.id], queryFn: () => api.automations.stats(automation.id) });
  const pick = useMutation({
    mutationFn: (variantId) => api.automations.pickWinner(automation.id, { variantId }),
    onSuccess: async () => {
      toast('Winner picked. All new DMs use it.');
      await refresh();
    },
    onError: (error) => toast(error.message),
  });
  return (
    <Panel title="How it’s doing">
      <Loadable query={stats} label="Loading the numbers" errorTitle="We couldn’t load the numbers">
        {(numbers) => (numbers.sends === 0
          ? <EmptyState title="No DMs sent yet">Numbers for each variant show up here.</EmptyState>
          : (
            <div className="variant-stats">
              {numbers.variants.map((variant) => {
                const winner = automation.winnerVariantId === variant.variantId;
                return (
                  <div key={variant.variantId} className="variant-stat">
                    <span>
                      <strong>Variant {variant.label}</strong>
                      <span className="muted"> {variant.sends} sent{variant.taps === null ? '' : `, ${variant.taps} taps`}{ratePercent(variant.rate)}</span>
                    </span>
                    {winner && <Badge tone="good">Winner</Badge>}
                    {!winner && variant.leader && <Badge tone="neel">Leading</Badge>}
                    {!winner && numbers.variants.length > 1 && <Button variant="outline" loading={pick.isPending} onClick={() => pick.mutate(variant.variantId)}>Pick {variant.label}</Button>}
                  </div>
                );
              })}
            </div>
          ))}
      </Loadable>
    </Panel>
  );
}
