import { PLAN_LABELS } from '../../lib/rules.js';
import { useState } from 'react';
import { Banner, SelectField, Toggle } from '../../../design/index.jsx';
import { ActionSheet, useAct } from '../../kit.jsx';
import { TIERS } from '../../lib/rules.js';
import { api } from '../../api.js';

/** Pauses a business: a reason is required, and whether billing and the store pause with it. */
export function PauseSheet({ business, open, onClose }) {
  const act = useAct();
  const [billing, setBilling] = useState(false);
  const [pauseStore, setPauseStore] = useState(false);
  return (
    <ActionSheet
      open={open}
      title={`Pause ${business.name}`}
      intro="Everything the business sends stops. The owner cannot lift a pause that Bhava set."
      submitLabel="Pause business"
      tone="danger"
      onClose={onClose}
      onSubmit={(reason) => act(() => api.pauseBusiness({ params: { id: business.id }, body: { reason, billing, pauseStore } }), 'The business is paused.')}
    >
      <Toggle label="Pause billing too" checked={billing} onChange={(event) => setBilling(event.target.checked)} />
      <Toggle label="Pause the store too" checked={pauseStore} onChange={(event) => setPauseStore(event.target.checked)} />
    </ActionSheet>
  );
}

export function ResumeSheet({ business, open, onClose }) {
  const act = useAct();
  return (
    <ActionSheet
      open={open}
      title={`Resume ${business.name}`}
      intro="Sending starts again straight away."
      submitLabel="Resume business"
      onClose={onClose}
      onSubmit={(reason) => act(() => api.resumeBusiness({ params: { id: business.id }, body: { reason } }), 'The business is running again.')}
    />
  );
}

/** Changes a plan without a payment. The change is audited and the owner is told (5.7). */
export function PlanOverrideSheet({ tenantId, name, current, open, onClose }) {
  const act = useAct();
  const [plan, setPlan] = useState(current ?? 'free');
  const [cycle, setCycle] = useState('monthly');
  return (
    <ActionSheet
      open={open}
      title={`Change the plan of ${name}`}
      intro="No payment is taken. The owner is told, and the change is on the audit log with your reason."
      submitLabel="Change plan"
      onClose={onClose}
      onSubmit={(reason) => act(() => api.overridePlan({ params: { id: tenantId }, body: { plan, cycle, reason } }), 'The plan is changed.')}
    >
      <SelectField label="Plan" value={plan} onChange={(event) => setPlan(event.target.value)}>
        {TIERS.map((tier) => <option key={tier} value={tier}>{PLAN_LABELS[tier]}</option>)}
      </SelectField>
      <SelectField label="Billing cycle" value={cycle} onChange={(event) => setCycle(event.target.value)}>
        <option value="monthly">Monthly</option>
        <option value="yearly">Yearly</option>
      </SelectField>
    </ActionSheet>
  );
}

export function MetaAccessSheet({ business, open, onClose }) {
  const act = useAct();
  const [level, setLevel] = useState(business.accessLevel);
  return (
    <ActionSheet
      open={open}
      title="Meta access level"
      needsReason={false}
      submitLabel="Save access level"
      onClose={onClose}
      onSubmit={() => act(() => api.setMetaAccess({ params: { id: business.id }, body: { accessLevel: level } }), 'The access level is saved.')}
    >
      <Banner tone="info">Advanced access lets the business message people who have not followed it. Set it only once Meta has approved it.</Banner>
      <SelectField label="Access level" value={level} onChange={(event) => setLevel(event.target.value)}>
        <option value="standard">Standard</option>
        <option value="advanced">Advanced</option>
      </SelectField>
    </ActionSheet>
  );
}
