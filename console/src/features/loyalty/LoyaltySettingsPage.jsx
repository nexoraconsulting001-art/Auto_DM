import { useQuery } from '@tanstack/react-query';
import { MANAGERS } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { BackLink, Banner, Button, EmptyState, FieldGroup, PageHeader, Panel, Toggle } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useForm } from '../../lib/forms.js';
import { useAllowed, useRefresh } from '../../lib/query.js';
import { NumberField, RupeeField, StoreScreen } from '../orders/shared/ui.jsx';
import { LOYALTY_FIELDS, formToSettings, settingsToForm } from './form.js';

function SettingsForm({ settings }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const form = useForm(settingsToForm(settings), { rename: LOYALTY_FIELDS });

  async function save(event) {
    event.preventDefault();
    const { body, errors } = formToSettings(form.values);
    if (errors) return form.reject(errors);
    const done = await form.run(() => api.loyaltySettings.update(body));
    if (done) {
      toast('Point rules saved.');
      await refresh();
    }
    return undefined;
  }

  return (
    <form className="stack" onSubmit={save} noValidate aria-label="Point rules">
      <Panel title="Points">
        <Toggle label="Customers earn points" {...form.toggle('enabled')} />
        <FieldGroup>
          <div className="store-grid-2">
            <NumberField label="Points earned" {...form.field('earnPoints')} />
            <RupeeField label="For every" {...form.field('earnPer')} />
          </div>
          <RupeeField label="Each point is worth" {...form.field('pointValue')} />
          <NumberField label="Most points on one order" {...form.field('maxRedeemPoints')} />
          <NumberField label="Points expire after (days)" hint="Leave empty for never." {...form.field('expiryDays')} />
        </FieldGroup>
        <p className="field-hint">Earned on the amount after discounts, before delivery. Points stay pending until the return window closes, and have no cash value.</p>
      </Panel>
      <Panel title="Referrals">
        <Toggle label="Customers can invite friends" {...form.toggle('referralEnabled')} />
        <FieldGroup>
          <RupeeField label="Friend’s first-order reward" {...form.field('friendReward')} />
          <NumberField label="Points for the one who invited" hint="Given once the friend’s order is delivered and its return window closes." {...form.field('referrerPoints')} />
        </FieldGroup>
      </Panel>
      {form.message && <Banner tone="bad">{form.message}</Banner>}
      <Button type="submit" block size="large" loading={form.busy}>Save point rules</Button>
    </form>
  );
}

export default function LoyaltySettingsPage() {
  const allowed = useAllowed();
  const settings = useQuery({ queryKey: ['loyalty-settings'], queryFn: api.loyaltySettings.get, enabled: allowed(MANAGERS) });
  if (!allowed(MANAGERS)) return <EmptyState title="You don’t have access to this">Ask the owner of this business if you need it.</EmptyState>;
  return (
    <>
      <BackLink to="/loyalty">Loyalty points</BackLink>
      <PageHeader title="Point rules" />
      <StoreScreen query={settings} label="Loading your point rules" errorTitle="We couldn’t load your point rules">
        {(data) => (data.available
          ? <SettingsForm key={JSON.stringify(data)} settings={data} />
          : <EmptyState title="This isn’t on your plan">Loyalty points are an add-on. Ask the Bhava team to add them.</EmptyState>)}
      </StoreScreen>
    </>
  );
}
