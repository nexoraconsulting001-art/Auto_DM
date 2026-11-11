import { useQuery } from '@tanstack/react-query';
import { MANAGERS, OWNER_ONLY } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { BackLink, Banner, Button, EmptyState, FieldGroup, PageHeader, Panel, SelectField, TextAreaField, TextField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useForm } from '../../lib/forms.js';
import { useAllowed, useRefresh } from '../../lib/query.js';
import { INDIAN_STATES } from '../orders/shared/contract.js';
import { invoiceErrors } from '../orders/shared/rules.js';
import { Facts, StoreScreen } from '../orders/shared/ui.jsx';

const STATES = Object.entries(INDIAN_STATES).map(([code, name]) => [String(code).padStart(2, '0'), name]).sort((a, b) => a[1].localeCompare(b[1]));

function SettingsForm({ settings }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const form = useForm({ legalName: settings.legalName, gstin: settings.gstin, stateCode: settings.stateCode, address: settings.address, invoicePrefix: settings.invoicePrefix || 'INV' });

  async function save(event) {
    event.preventDefault();
    const errors = invoiceErrors(form.values);
    if (Object.keys(errors).length) return form.reject(errors);
    const body = {
      legalName: form.values.legalName.trim(),
      gstin: form.values.gstin.trim().toUpperCase(),
      stateCode: form.values.stateCode,
      address: form.values.address.trim(),
      invoicePrefix: form.values.invoicePrefix.trim().toUpperCase(),
    };
    const done = await form.run(() => api.invoiceSettings.update(body));
    if (done) {
      toast('GST details saved.');
      await refresh();
    }
    return undefined;
  }

  return (
    <form className="stack" onSubmit={save} noValidate aria-label="GST details">
      <FieldGroup>
        <TextField label="Legal name" maxLength={200} autoComplete="organization" {...form.field('legalName')} />
        <TextField label="GSTIN" hint="Leave empty if you aren’t registered: your documents are then bills of supply." maxLength={15} autoCapitalize="characters" {...form.field('gstin')} />
        <SelectField label="State" hint="Decides CGST and SGST, or IGST." {...form.field('stateCode')}>
          <option value="">Pick a state</option>
          {STATES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
        </SelectField>
        <TextAreaField label="Address on invoices" rows={3} maxLength={400} {...form.field('address')} />
        <TextField label="Invoice number prefix" hint="Up to 4 capital letters or digits. Numbers run per financial year with no gaps." maxLength={4} autoCapitalize="characters" {...form.field('invoicePrefix')} />
      </FieldGroup>
      {form.message && <Banner tone="bad">{form.message}</Banner>}
      <Button type="submit" block loading={form.busy}>Save GST details</Button>
    </form>
  );
}

export default function InvoiceSettingsPage() {
  const allowed = useAllowed();
  const settings = useQuery({ queryKey: ['invoice-settings'], queryFn: api.invoiceSettings.get, enabled: allowed(MANAGERS) });
  if (!allowed(MANAGERS)) return <EmptyState title="You don’t have access to this">Ask the owner of this business if you need it.</EmptyState>;
  return (
    <>
      <BackLink to="/invoices">Invoices</BackLink>
      <PageHeader title="GST details" />
      <Panel title="On every invoice">
        <StoreScreen query={settings} label="Loading your GST details" errorTitle="We couldn’t load your GST details">
          {(data) => (allowed(OWNER_ONLY) ? <SettingsForm key={JSON.stringify(data)} settings={data} /> : (
            <>
              <Facts rows={[['Legal name', data.legalName || 'Not set'], ['GSTIN', data.gstin || 'Not registered'], ['State', INDIAN_STATES[data.stateCode] ?? INDIAN_STATES[Number(data.stateCode)] ?? 'Not set'], ['Prefix', data.invoicePrefix]]} />
              <p className="field-hint">Only the owner changes these.</p>
            </>
          ))}
        </StoreScreen>
      </Panel>
    </>
  );
}
