import { useQuery } from '@tanstack/react-query';
import { useFeedback } from '../../components/feedback.jsx';
import { BackLink, Banner, Button, EmptyState, PageHeader, Panel, TextAreaField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { useForm } from '../../lib/forms.js';
import { useRefresh } from '../../lib/query.js';
import { POLICY_KINDS } from '../orders/shared/contract.js';
import { POLICY_LABELS } from '../orders/shared/labels.js';
import { StoreScreen } from '../orders/shared/ui.jsx';

const MAX_POLICY = 40000;

/** One policy page, on the business's own domain (9.18, S-61). */
function PolicyForm({ policy }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const form = useForm({ body: policy.body });

  async function save(event) {
    event.preventDefault();
    const done = await form.run(() => api.policies.save({ kind: policy.kind, body: form.values.body }));
    if (done) {
      toast(`${POLICY_LABELS[policy.kind]} saved.`);
      await refresh();
    }
  }

  return (
    <Panel title={POLICY_LABELS[policy.kind] ?? policy.kind}>
      <form className="stack" onSubmit={save} aria-label={POLICY_LABELS[policy.kind]}>
        <TextAreaField label={`Text of your ${(POLICY_LABELS[policy.kind] ?? policy.kind).toLowerCase()}`} rows={8} maxLength={MAX_POLICY} hint={policy.updatedAt ? `Last saved ${formatDateTime(policy.updatedAt)}.` : 'Empty pages show a short standard text.'} {...form.field('body')} />
        {form.message && <Banner tone="bad">{form.message}</Banner>}
        <div className="row-actions">
          <Button type="submit" variant="soft" loading={form.busy}>Save</Button>
          {policy.url && <Button as="a" variant="outline" href={policy.url} target="_blank" rel="noopener">View the page</Button>}
        </div>
      </form>
    </Panel>
  );
}

export default function PoliciesPage() {
  const policies = useQuery({ queryKey: ['policies'], queryFn: api.policies.all });
  return (
    <>
      <BackLink to="/store-settings">Store setup</BackLink>
      <PageHeader title="Policy pages" />
      <p className="lead">Shown on your own domain, in your store’s name. Shoppers can open them without signing in.</p>
      <StoreScreen query={policies} label="Loading your policy pages" errorTitle="We couldn’t load your policy pages">
        {({ items }) => {
          const byKind = new Map(items.map((policy) => [policy.kind, policy]));
          const all = POLICY_KINDS.map((kind) => byKind.get(kind) ?? { kind, body: '', url: '', updatedAt: null });
          return all.length ? <div className="stack">{all.map((policy) => <PolicyForm key={`${policy.kind}-${policy.updatedAt}`} policy={policy} />)}</div> : <EmptyState title="No policy pages">They appear here once your store is set up.</EmptyState>;
        }}
      </StoreScreen>
    </>
  );
}
