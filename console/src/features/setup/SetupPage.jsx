import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Badge, Banner, Button, EmptyState, FieldGroup, PageHeader, Panel, Ring, SelectField, Sheet, TextField } from '../../design/index.jsx';
import { useFeedback } from '../../components/feedback.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { useForm } from '../../lib/forms.js';
import { useRefresh } from '../../lib/query.js';
import { useSession } from '../../lib/session.jsx';
import { Screen } from '../catalog/shared/ui.jsx';
import { isCancelled, useFresh } from '../account/fresh.jsx';
import { safeFileUrl } from '../billing/contract.js';
import '../billing/billing.css';
import { EMPTY_PICKUP, KYC_WORDS, OWN_KEY_PROVIDERS, PROVIDER_LABELS, TERMS_VERSION, checkKeys, checkPickup, progress, statusView } from './model.js';

function PickupSheet({ onClose, onSaved }) {
  const dialog = useRef(null);
  const form = useForm(EMPTY_PICKUP);
  useEffect(() => {
    if (!dialog.current.open) dialog.current.showModal();
  }, []);
  async function submit(event) {
    event.preventDefault();
    const found = checkPickup(form.values);
    if (Object.keys(found).length) return form.reject(found);
    const ok = await form.run(() => api.setup.pickupAddress(Object.fromEntries(Object.entries(form.values).map(([key, value]) => [key, value.trim()]))));
    if (ok) {
      dialog.current.close();
      onSaved();
    }
    return ok;
  }
  return (
    <Sheet ref={dialog} title="Pickup address" onClose={onClose}>
      <form className="p7-stack" onSubmit={submit} noValidate>
        <p className="sheet-text">Couriers collect your parcels from here.</p>
        {form.message && <Banner tone="bad">{form.message}</Banner>}
        <FieldGroup>
          <TextField label="Contact name" autoComplete="name" {...form.field('name')} />
          <TextField label="Mobile number" inputMode="numeric" autoComplete="tel-national" maxLength={10} {...form.field('phone')} />
          <TextField label="Email (optional)" type="email" autoComplete="email" {...form.field('email')} />
          <TextField label="Address line 1" autoComplete="address-line1" {...form.field('line1')} />
          <TextField label="Address line 2 (optional)" autoComplete="address-line2" {...form.field('line2')} />
          <TextField label="City" autoComplete="address-level2" {...form.field('city')} />
          <TextField label="State" autoComplete="address-level1" {...form.field('state')} />
          <TextField label="Pincode" inputMode="numeric" autoComplete="postal-code" maxLength={6} {...form.field('pincode')} />
        </FieldGroup>
        <div className="sheet-actions">
          <Button variant="outline" onClick={() => dialog.current.close()}>Cancel</Button>
          <Button type="submit" loading={form.busy}>Save address</Button>
        </div>
      </form>
    </Sheet>
  );
}

function KeysSheet({ fresh, onClose, onSaved }) {
  const dialog = useRef(null);
  const form = useForm({ provider: 'razorpay', keyId: '', keySecret: '' });
  useEffect(() => {
    if (!dialog.current.open) dialog.current.showModal();
  }, []);
  async function submit(event) {
    event.preventDefault();
    const found = checkKeys(form.values);
    if (Object.keys(found).length) return form.reject(found);
    const ok = await form.run(async () => {
      try {
        await fresh.run(() => api.setup.ownKeys({ provider: form.values.provider, keyId: form.values.keyId.trim(), keySecret: form.values.keySecret }));
      } catch (error) {
        if (isCancelled(error)) return;
        throw error;
      }
    });
    if (ok) {
      dialog.current.close();
      onSaved();
    }
    return ok;
  }
  return (
    <Sheet ref={dialog} title="Your own account" onClose={onClose}>
      <form className="p7-stack" onSubmit={submit} noValidate>
        <p className="sheet-text">We test the keys first. Keys that fail the test are not saved, and Bhava’s own setup stays on. The secret is never shown again.</p>
        {form.message && <Banner tone="bad">{form.message}</Banner>}
        <FieldGroup>
          <SelectField label="Provider" {...form.field('provider')}>
            {OWN_KEY_PROVIDERS.map((name) => <option key={name} value={name}>{PROVIDER_LABELS[name]}</option>)}
          </SelectField>
          <TextField label={form.values.provider === 'shiprocket' ? 'Login email' : 'Key id'} autoComplete="off" {...form.field('keyId')} />
          <TextField label={form.values.provider === 'shiprocket' ? 'Password' : 'Key secret'} type="password" autoComplete="off" {...form.field('keySecret')} />
        </FieldGroup>
        <div className="sheet-actions">
          <Button variant="outline" onClick={() => dialog.current.close()}>Cancel</Button>
          <Button type="submit" loading={form.busy}>Test and save</Button>
        </div>
      </form>
    </Sheet>
  );
}

function StepRow({ step, owner, act, busy }) {
  const view = statusView(step.status);
  const fix = step.status !== 'done' ? step.fix : '';
  return (
    <li className="p7-item" data-testid={`step-${step.step}`} data-status={step.status}>
      <span className="grow">
        <span className="p7-step-title"><strong>{step.label}</strong><Badge tone={view.tone}>{view.badge}</Badge>{!step.required && <Badge>Optional</Badge>}</span>
        {step.reason && <span className="p7-meta">{step.reason}</span>}
        {step.checkedAt && <span className="p7-meta">Checked {formatDateTime(step.checkedAt)}</span>}
      </span>
      {fix === 'reconnect' && <Button as={Link} variant="soft" to="/connect">Reconnect</Button>}
      {fix === 'kyc' && owner && <Button variant="soft" loading={busy === 'kyc'} onClick={() => act('kyc')}>Continue on Razorpay</Button>}
      {fix === 'pickup' && owner && <Button variant="soft" onClick={() => act('pickup')}>Add address</Button>}
      {fix === 'keys' && owner && <Button variant="soft" onClick={() => act('keys')}>Add keys</Button>}
      {fix === 'terms' && owner && <Button variant="soft" loading={busy === 'terms'} onClick={() => act('terms')}>Accept terms</Button>}
      {fix === 'dns' && <span className="p7-meta">Add the record at your domain provider, then check again.</span>}
      <Button variant="outline" aria-label={`Check ${step.label} again`} loading={busy === `check-${step.step}`} onClick={() => act(`check-${step.step}`)}>Check</Button>
    </li>
  );
}

function Checklist({ checklist }) {
  const { session } = useSession();
  const owner = session.user.role === 'owner';
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const fresh = useFresh();
  const [busy, setBusy] = useState('');
  const [sheet, setSheet] = useState('');
  const { done, total, next } = progress(checklist);

  async function act(what) {
    if (what === 'pickup' || what === 'keys') return setSheet(what);
    setBusy(what);
    try {
      if (what === 'kyc') {
        const link = await api.setup.kycLink();
        if (safeFileUrl(link.url)) window.location.assign(link.url);
      } else if (what === 'terms') {
        await api.setup.acceptTerms({ version: TERMS_VERSION });
        toast('Terms accepted.');
      } else if (what === 'all') {
        await api.setup.check({});
        toast('Checked just now.');
      } else {
        await api.setup.check({ step: what.replace('check-', '') });
      }
      await refresh();
    } catch (error) {
      toast(error.message);
    } finally {
      setBusy('');
    }
    return undefined;
  }

  return (
    <>
      <Panel title="Your progress">
        <div className="p7-row">
          <Ring done={done} total={total} label={`${done} of ${total} required steps done`} />
          <div className="grow">
            <strong>{checklist.done ? 'You are ready' : `${total - done} ${total - done === 1 ? 'step' : 'steps'} to go`}</strong>
            <p className="p7-meta">{checklist.done ? 'Everything required is done.' : next ? `Next: ${next.label}` : ''}</p>
          </div>
          <Button variant="outline" loading={busy === 'all'} onClick={() => act('all')}>Check all</Button>
        </div>
        {!checklist.checkoutOpen && checklist.steps.some((step) => step.step === 'payments') && <Banner tone="info">Checkout opens for your buyers once payments are verified.</Banner>}
        {checklist.kyc && <p className="p7-meta" data-testid="kyc-status">KYC: {KYC_WORDS[checklist.kyc.status] ?? checklist.kyc.status}{checklist.kyc.reason ? ` ${checklist.kyc.reason}` : ''}</p>}
      </Panel>
      <Panel title="Your steps">
        {checklist.steps.length === 0 ? <EmptyState title="No steps for your plan">Nothing to set up right now.</EmptyState> : (
          <ul className="p7-list" aria-label="Setup steps">
            {checklist.steps.map((step) => <StepRow key={step.step} step={step} owner={owner} act={act} busy={busy} />)}
          </ul>
        )}
        <p className="p7-meta">We only use Meta’s official login. We never ask for your Instagram password.</p>
      </Panel>
      {sheet === 'pickup' && <PickupSheet onClose={() => setSheet('')} onSaved={async () => { toast('Pickup address saved.'); await refresh(); }} />}
      {sheet === 'keys' && <KeysSheet fresh={fresh} onClose={() => setSheet('')} onSaved={async () => { toast('Your keys passed the test and are saved.'); await refresh(); }} />}
      {fresh.sheet}
    </>
  );
}

export default function SetupPage() {
  const checklist = useQuery({ queryKey: ['setup'], queryFn: () => api.setup.get(), refetchInterval: (query) => (query.state.data?.steps.some((step) => step.status === 'waiting') ? 15_000 : false) });
  return (
    <div className="p7-stack">
      <PageHeader eyebrow="Getting set up" title="Setup checklist" />
      <Screen query={checklist} label="Loading your checklist" errorTitle="We couldn’t load your checklist">
        {(data) => <Checklist checklist={data} />}
      </Screen>
    </div>
  );
}
