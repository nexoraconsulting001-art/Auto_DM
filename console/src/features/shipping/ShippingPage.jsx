import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { staffWith } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { BackLink, Badge, Banner, Button, EmptyState, FieldGroup, PageHeader, Panel, SelectField, TextField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useForm } from '../../lib/forms.js';
import { useAllowed, useRefresh } from '../../lib/query.js';
import { INDIAN_STATES, PINCODE, PINCODE_MESSAGE } from '../orders/shared/contract.js';
import { StoreScreen } from '../orders/shared/ui.jsx';
import { formToSettings, settingsToForm } from './form.js';

const MODES = [
  ['managed', 'Bhava’s courier account', 'We book pickups on our Shiprocket account, with your name and pickup address on the label. Charges are at cost, with no markup.'],
  ['own', 'Your own Shiprocket account', 'Pickups are booked on your account and Shiprocket bills you directly.'],
];

export const STATE_OPTIONS = Object.entries(INDIAN_STATES).map(([code, name]) => [String(code).padStart(2, '0'), name]).sort((a, b) => a[1].localeCompare(b[1]));

function SettingsForm({ settings }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const form = useForm(settingsToForm(settings));
  const changedMode = form.values.mode !== settings.mode;

  async function save(event) {
    event.preventDefault();
    const { body, errors } = formToSettings(form.values);
    if (errors) return form.reject(errors);
    const done = await form.run(() => api.shippingSettings.update(body));
    if (done) {
      toast('Shipping settings saved.');
      await refresh();
    }
    return undefined;
  }

  return (
    <form className="stack" onSubmit={save} noValidate aria-label="Shipping settings">
      <Panel title="Courier account">
        <fieldset className="store-choice">
          <legend className="sr-only">Courier account</legend>
          {MODES.map(([value, title, note]) => (
            <label key={value} className="store-option">
              <input type="radio" name="mode" value={value} checked={form.values.mode === value} onChange={() => form.set('mode', value)} />
              <span className="store-option-text">
                <span className="store-option-title">{title}</span>
                <span className="store-option-note">{note}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {changedMode && <Banner tone="info">A change applies to new shipments only. Parcels already booked stay where they are.</Banner>}
        {form.values.mode === 'managed' ? (
          <SelectField label="Courier charges are" {...form.field('chargeBilling')}>
            <option value="payout">Taken from your payouts</option>
            <option value="monthly">Billed to you each month</option>
          </SelectField>
        ) : (
          <FieldGroup>
            <TextField label="Shiprocket API email" type="email" autoComplete="off" {...form.field('ownEmail')} />
            <TextField label="Shiprocket API password" type="password" autoComplete="new-password" hint={settings.ownPasswordSet ? 'Saved. Type a new one to change it.' : 'Stored encrypted. It’s never shown again.'} {...form.field('ownPassword')} />
          </FieldGroup>
        )}
      </Panel>
      <Panel title="Pickup address" action={settings.pickupRegistered ? <Badge tone="good">Registered</Badge> : <Badge tone="warn">Not registered yet</Badge>}>
        <p className="muted">Where the courier collects parcels. It is printed on the label as the shipper’s address.</p>
        <FieldGroup>
          <TextField label="Name on the label" maxLength={80} {...form.field('pickupName')} />
          <TextField label="Phone for the courier" type="tel" maxLength={16} {...form.field('pickupPhone')} />
          <TextField label="Address" maxLength={200} autoComplete="address-line1" {...form.field('pickupLine1')} />
          <TextField label="Address line 2 (optional)" maxLength={200} autoComplete="address-line2" {...form.field('pickupLine2')} />
          <TextField label="City" maxLength={60} autoComplete="address-level2" {...form.field('pickupCity')} />
          <SelectField label="State" {...form.field('pickupStateCode')}>
            <option value="">Pick a state</option>
            {STATE_OPTIONS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </SelectField>
          <TextField label="PIN code" inputMode="numeric" maxLength={6} autoComplete="postal-code" {...form.field('pickupPincode')} />
        </FieldGroup>
      </Panel>
      {form.message && <Banner tone="bad">{form.message}</Banner>}
      <Button type="submit" block size="large" loading={form.busy}>Save shipping settings</Button>
    </form>
  );
}

/** Can the courier reach a PIN code, and is cash on delivery offered there. */
function Serviceability() {
  const [pin, setPin] = useState('');
  const [asked, setAsked] = useState('');
  const result = useQuery({ queryKey: ['serviceability', asked], queryFn: () => api.shipping.serviceability({ pincode: asked }), enabled: Boolean(asked) });
  const [error, setError] = useState('');

  function check(event) {
    event.preventDefault();
    if (!PINCODE.test(pin.trim())) return setError(PINCODE_MESSAGE);
    setError('');
    return setAsked(pin.trim());
  }

  return (
    <Panel title="Check a PIN code">
      <form className="stack" onSubmit={check} noValidate>
        <div className="inline-field">
          <FieldGroup><TextField label="PIN code to check" inputMode="numeric" maxLength={6} value={pin} error={error} onChange={(event) => setPin(event.target.value)} /></FieldGroup>
          <Button type="submit" variant="soft" loading={result.isFetching}>Check</Button>
        </div>
      </form>
      {asked && (
        <StoreScreen query={result} label="Checking this PIN code" errorTitle="We couldn’t check this PIN code">
          {(data) => (
            <Banner tone={data.serviceable ? 'good' : 'warn'}>
              <strong>{data.pincode}:</strong> {data.message || (data.serviceable ? 'The courier delivers here.' : 'The courier doesn’t deliver here.')} {data.serviceable ? (data.cod ? 'Cash on delivery is offered.' : 'No cash on delivery.') : ''}
            </Banner>
          )}
        </StoreScreen>
      )}
    </Panel>
  );
}

export default function ShippingPage() {
  const allowed = useAllowed();
  const settings = useQuery({ queryKey: ['shipping-settings'], queryFn: api.shippingSettings.get });
  return (
    <>
      <BackLink to="/store-settings">Store setup</BackLink>
      <PageHeader title="Shipping" />
      <StoreScreen query={settings} label="Loading your shipping settings" errorTitle="We couldn’t load your shipping settings">
        {(data) => (data ? <SettingsForm key={JSON.stringify(data)} settings={data} /> : <EmptyState title="No shipping settings yet">Add your pickup address to start.</EmptyState>)}
      </StoreScreen>
      {allowed(staffWith('orders')) && <Serviceability />}
    </>
  );
}
