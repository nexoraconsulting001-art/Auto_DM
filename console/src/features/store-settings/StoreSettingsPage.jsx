import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useFeedback } from '../../components/feedback.jsx';
import { Banner, Button, FieldGroup, ListCard, ListRow, PageHeader, Panel, TextAreaField, TextField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useForm } from '../../lib/forms.js';
import { useRefresh } from '../../lib/query.js';
import { useLoyaltyOn } from '../loyalty/useLoyalty.js';
import { StoreScreen } from '../orders/shared/ui.jsx';

/** Every store setting, one tap away. */
export const SETTING_LINKS = Object.freeze([
  ['/payments', 'Payments', 'Bhava-managed or your own gateway, and the ways shoppers pay'],
  ['/shipping', 'Shipping', 'Courier account and pickup address'],
  ['/invoices/settings', 'GST details', 'Legal name, GSTIN, state and invoice numbers'],
  ['/returns/settings', 'Return rules', 'Window, categories and the proof shoppers add'],
  ['/inventory', 'Stock alerts', 'When a product counts as running low'],
  ['/store-settings/messages', 'Messages to shoppers', 'Order updates and cart reminders by WhatsApp and email'],
  ['/store-settings/policies', 'Policy pages', 'Privacy, terms, refunds and shipping'],
  ['/store-settings/notice', 'Consent notice', 'What shoppers agree to, in English and Hindi'],
  ['/store-settings/shopify', 'Shopify', 'Keep products, stock and orders in step'],
]);
const LOYALTY_LINK = ['/loyalty/settings', 'Loyalty points', 'How points are earned and spent, and referrals'];

/** The grievance contact shown on the privacy page (9.18, S-62). */
function GrievanceForm({ privacy }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const form = useForm({ grievanceName: privacy.grievanceName, grievanceEmail: privacy.grievanceEmail, grievancePhone: privacy.grievancePhone, grievanceAddress: privacy.grievanceAddress });

  async function save(event) {
    event.preventDefault();
    const email = form.values.grievanceEmail.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return form.reject({ grievanceEmail: 'Enter a valid email' });
    const body = Object.fromEntries(Object.entries(form.values).map(([key, value]) => [key, value.trim()]));
    const done = await form.run(() => api.privacy.update(body));
    if (done) {
      toast('Grievance contact saved.');
      await refresh();
    }
    return undefined;
  }

  return (
    <form className="stack" onSubmit={save} noValidate aria-label="Grievance contact">
      <p className="muted">Shown on your privacy page, for shoppers with a complaint about their data.</p>
      <FieldGroup>
        <TextField label="Name" maxLength={120} {...form.field('grievanceName')} />
        <TextField label="Email" type="email" maxLength={120} {...form.field('grievanceEmail')} />
        <TextField label="Phone" type="tel" maxLength={20} {...form.field('grievancePhone')} />
        <TextAreaField label="Postal address" rows={2} maxLength={400} {...form.field('grievanceAddress')} />
      </FieldGroup>
      {form.message && <Banner tone="bad">{form.message}</Banner>}
      <Button type="submit" variant="soft" loading={form.busy}>Save contact</Button>
    </form>
  );
}

export default function StoreSettingsPage() {
  const loyaltyOn = useLoyaltyOn();
  const privacy = useQuery({ queryKey: ['privacy'], queryFn: api.privacy.get });
  const links = loyaltyOn ? [...SETTING_LINKS.slice(0, 5), LOYALTY_LINK, ...SETTING_LINKS.slice(5)] : SETTING_LINKS;
  return (
    <>
      <PageHeader title="Store setup" />
      <ListCard aria-label="Store setup">
        {links.map(([to, title, meta]) => <ListRow key={to} as={Link} to={to} title={title} meta={meta} />)}
      </ListCard>
      <Panel title="Grievance contact">
        <StoreScreen query={privacy} label="Loading your grievance contact" errorTitle="We couldn’t load your grievance contact">
          {(data) => <GrievanceForm key={JSON.stringify(data)} privacy={data} />}
        </StoreScreen>
      </Panel>
    </>
  );
}
