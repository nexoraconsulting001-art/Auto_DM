import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { OWNER_ONLY } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { Badge, Banner, Button, FieldGroup, Loadable, PageHeader, Panel, TextAreaField, TextField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useForm } from '../../lib/forms.js';
import { useAllowed, useRefresh } from '../../lib/query.js';
import { RENAME, formToSettings, settingsToForm } from './form.js';

function InstagramPanel() {
  const setup = useQuery({ queryKey: ['setup'], queryFn: api.settings.setup });
  return (
    <Panel title="Instagram connection">
      <Loadable query={setup} label="Checking your connection" errorTitle="We couldn’t check your connection">
        {({ instagram, storeUrl, testMode }) => (
          <dl className="facts">
            <div>
              <dt>Account</dt>
              <dd>{instagram.connected ? `@${instagram.username}` : <Badge tone="warn">Not connected</Badge>}</dd>
            </div>
            <div>
              <dt>Store links in DMs use</dt>
              <dd className="facts-long">{storeUrl}</dd>
            </div>
            <div>
              <dt>Sending DMs</dt>
              <dd>{testMode ? <Badge tone="warn">Test mode: DMs are only logged</Badge> : <Badge tone="good">Live</Badge>}</dd>
            </div>
          </dl>
        )}
      </Loadable>
    </Panel>
  );
}

function PaymentForm({ settings }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const form = useForm({ upiId: settings.upiId, upiPayee: settings.upiPayee });

  async function save(event) {
    event.preventDefault();
    const saved = await form.run(() => api.settings.updatePayment({ upiId: form.values.upiId.trim(), upiPayee: form.values.upiPayee.trim() }));
    if (saved) {
      toast('Payment details saved.');
      await refresh();
    }
  }

  return (
    <Panel title="Payment QR">
      <form className="stack" onSubmit={save} noValidate>
        <p className="muted">Payments aren’t live yet. Customers see a QR with the order amount and confirm themselves; you mark orders as paid.</p>
        <FieldGroup>
          <TextField label="UPI ID shown on the QR" maxLength={120} {...form.field('upiId')} />
          <TextField label="Payee name" maxLength={120} {...form.field('upiPayee')} />
        </FieldGroup>
        {form.message && <Banner tone="bad">{form.message}</Banner>}
        <Button type="submit" loading={form.busy}>Save payment details</Button>
      </form>
    </Panel>
  );
}

function SettingsForm({ settings }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const form = useForm(settingsToForm(settings), { rename: RENAME });

  async function save(event) {
    event.preventDefault();
    const { body, errors } = formToSettings(form.values);
    if (errors) return form.reject(errors);
    return form.run(async () => {
      await api.settings.update(body);
      toast('Settings saved.');
      await refresh();
    });
  }

  return (
    <form className="stack" onSubmit={save} noValidate>
      <Panel title="Store">
        <FieldGroup>
          <TextField label="Store name" maxLength={120} required {...form.field('storeName')} />
          <TextField label="Tagline" maxLength={400} {...form.field('tagline')} />
          <TextField label="Instagram handle" maxLength={60} placeholder="yourshop" {...form.field('instagramHandle')} />
        </FieldGroup>
        <p className="muted">Your logo, colours and fonts are in <Link to="/brand-kit">Brand kit</Link>.</p>
      </Panel>

      <Panel title="Home and About pages">
        <p className="muted">The words shoppers see first. Open your store to see the result.</p>
        <FieldGroup>
          <TextField label="Small line above the title" {...form.field('heroKicker')} />
          <TextField label="Home page title" {...form.field('heroTitle')} />
          <TextAreaField label="Home page subtitle" rows={2} {...form.field('heroSubtitle')} />
          <TextAreaField label="Why shop with us" rows={4} hint="One point per line, up to 5" {...form.field('trustPoints')} />
          <TextField label="Bulk order title" {...form.field('bulkTitle')} />
          <TextField label="Bulk order text" {...form.field('bulkText')} />
          <TextAreaField label="About page" rows={5} hint="Leave a blank line between paragraphs" {...form.field('aboutText')} />
          <TextField label="GSTIN" maxLength={20} hint="Optional, shown in the footer" {...form.field('gstin')} />
        </FieldGroup>
      </Panel>

      <Panel title="Delivery">
        <FieldGroup>
          <TextField label="Delivery fee (₹)" inputMode="decimal" {...form.field('shippingFee')} />
          <TextField label="Free delivery from (₹)" inputMode="decimal" hint="0 means never free" {...form.field('freeShippingAbove')} />
        </FieldGroup>
      </Panel>

      <Panel title="Support">
        <FieldGroup>
          <TextField label="WhatsApp number" inputMode="numeric" maxLength={20} placeholder="919876543210" {...form.field('supportWhatsapp')} />
          <TextField label="Email" type="email" inputMode="email" maxLength={120} {...form.field('supportEmail')} />
        </FieldGroup>
      </Panel>

      {form.message && <Banner tone="bad">{form.message}</Banner>}
      <div className="form-actions">
        <Button type="submit" size="large" block loading={form.busy}>Save settings</Button>
      </div>
    </form>
  );
}

export default function SettingsPage() {
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings.get });
  const allowed = useAllowed();
  return (
    <>
      <PageHeader title="Settings" />
      <Loadable query={settings} label="Loading your settings" errorTitle="We couldn’t load your settings">
        {(data) => (
          <>
            <SettingsForm settings={data} />
            {allowed(OWNER_ONLY) && <PaymentForm settings={data} />}
            <InstagramPanel />
          </>
        )}
      </Loadable>
    </>
  );
}
