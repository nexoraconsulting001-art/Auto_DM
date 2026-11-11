import { useQuery } from '@tanstack/react-query';
import { MANAGERS } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { BackLink, Banner, Button, EmptyState, FieldGroup, PageHeader, Panel, Toggle } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useForm } from '../../lib/forms.js';
import { fetchAll, useAllowed, useRefresh } from '../../lib/query.js';
import { RETURN_WINDOW_DAYS } from '../orders/shared/contract.js';
import { NumberField, StoreScreen, toWhole } from '../orders/shared/ui.jsx';

const PROOFS = [['photo', 'A photo'], ['video', 'A short video'], ['either', 'A photo or a video']];

function Categories({ picked, onChange }) {
  const categories = useQuery({ queryKey: ['categories', 'all'], queryFn: () => fetchAll(api.categories.list) });
  return (
    <StoreScreen query={categories} label="Loading your categories" errorTitle="We couldn’t load your categories">
      {(list) => (list.length ? (
        <fieldset className="store-checks">
          <legend>Which categories can be returned</legend>
          <p className="field-hint">Pick none for every product.</p>
          {list.map((category) => (
            <label key={category.id} className="store-check">
              <input type="checkbox" checked={picked.includes(category.id)} onChange={(event) => onChange(event.target.checked ? [...picked, category.id] : picked.filter((id) => id !== category.id))} />
              {category.name}
            </label>
          ))}
        </fieldset>
      ) : <EmptyState title="No categories yet">Every product can be returned.</EmptyState>)}
    </StoreScreen>
  );
}

function SettingsForm({ settings }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const form = useForm({ enabled: settings.enabled, windowDays: String(settings.windowDays), proof: settings.proof, eligibleCategoryIds: settings.eligibleCategoryIds });

  async function save(event) {
    event.preventDefault();
    const windowDays = toWhole(form.values.windowDays);
    if (!Number.isInteger(windowDays) || windowDays < RETURN_WINDOW_DAYS.min || windowDays > RETURN_WINDOW_DAYS.max) return form.reject({ windowDays: `Enter ${RETURN_WINDOW_DAYS.min} to ${RETURN_WINDOW_DAYS.max} days` });
    const done = await form.run(() => api.returnSettings.update({ enabled: form.values.enabled, windowDays, proof: form.values.proof, eligibleCategoryIds: form.values.eligibleCategoryIds }));
    if (done) {
      toast('Return rules saved.');
      await refresh();
    }
    return undefined;
  }

  return (
    <form className="stack" onSubmit={save} noValidate aria-label="Return rules">
      <Panel title="Returns">
        <Toggle label="Customers can ask for a return" {...form.toggle('enabled')} />
        <FieldGroup>
          <NumberField label="Days after delivery" hint="After this the return option isn’t shown. 0 to 90." {...form.field('windowDays')} />
        </FieldGroup>
        <fieldset className="store-choice">
          <legend>Proof the customer must add</legend>
          {PROOFS.map(([value, label]) => (
            <label key={value} className="store-option">
              <input type="radio" name="proof" value={value} checked={form.values.proof === value} onChange={() => form.set('proof', value)} />
              <span className="store-option-text"><span className="store-option-title">{label}</span></span>
            </label>
          ))}
        </fieldset>
      </Panel>
      <Panel title="What can be returned">
        <Categories picked={form.values.eligibleCategoryIds} onChange={(ids) => form.set('eligibleCategoryIds', ids)} />
      </Panel>
      {form.message && <Banner tone="bad">{form.message}</Banner>}
      <Button type="submit" block size="large" loading={form.busy}>Save return rules</Button>
    </form>
  );
}

export default function ReturnSettingsPage() {
  const allowed = useAllowed();
  const settings = useQuery({ queryKey: ['return-settings'], queryFn: api.returnSettings.get, enabled: allowed(MANAGERS) });
  if (!allowed(MANAGERS)) return <EmptyState title="You don’t have access to this">Ask the owner of this business if you need it.</EmptyState>;
  return (
    <>
      <BackLink to="/returns">Returns</BackLink>
      <PageHeader title="Return rules" />
      <StoreScreen query={settings} label="Loading your return rules" errorTitle="We couldn’t load your return rules">
        {(data) => <SettingsForm key={JSON.stringify(data)} settings={data} />}
      </StoreScreen>
    </>
  );
}
