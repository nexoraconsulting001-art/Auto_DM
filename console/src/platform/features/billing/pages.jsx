import { PLAN_LABELS } from '../../lib/rules.js';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BackLink, Badge, Banner, Button, ListCard, ListRow, PageHeader, Panel, SelectField, TextField, Toggle } from '../../../design/index.jsx';
import { formatPaise, rupeesToPaise } from '../../../lib/format.js';
import { ActionSheet, Can, Facts, PagedRows, QueryState, When, useAct, useCan, useOne, usePlatformList } from '../../kit.jsx';
import { word } from '../../lib/rules.js';
import { listBusinesses } from '../../data.js';
import { api } from '../../api.js';
import { PlanOverrideSheet } from '../businesses/actions.jsx';

const STATUS_TONE = { active: 'good', past_due: 'warn', grace: 'warn', suspended: 'bad', cancelled: 'neutral' };

export function BillingPage() {
  const can = useCan();
  const query = usePlatformList('businesses', listBusinesses);
  return (
    <div className="stack">
      <PageHeader eyebrow="Bhava Console" title="Billing" />
      {can('platform.billingSettings') && <ListCard><ListRow as={Link} to="/billing/settings" title="Bhava’s billing details" meta="Legal name, GSTIN, tax, statement day and grace" /></ListCard>}
      <PagedRows query={query} empty="No businesses yet" emptyText="A business’s plan and billing opens from here." label="Loading businesses">
        {(items) => (
          <ListCard>
            {items.map((business) => (
              <ListRow key={business.id} as={Link} to={`/billing/${business.id}`} title={business.name} meta={PLAN_LABELS[business.plan] ?? business.plan} />
            ))}
          </ListCard>
        )}
      </PagedRows>
    </div>
  );
}

function CreditNoteSheet({ tenantId, open, onClose, onIssued }) {
  const act = useAct();
  const [invoice, setInvoice] = useState('');
  const [amount, setAmount] = useState('');
  const paise = rupeesToPaise(amount);
  const id = /^\d+$/.test(invoice.trim()) ? Number(invoice.trim()) : 0;
  const valid = id > 0 && !Number.isNaN(paise);
  return (
    <ActionSheet
      open={open}
      title="Issue a credit note"
      intro="Corrects an invoice that was already issued. Leave the amount empty to reverse the whole invoice. It can never be more than what is left of it."
      submitLabel="Issue credit note"
      valid={valid}
      onClose={onClose}
      onSubmit={async (reason) => onIssued(await act(() => api.createCreditNote({ params: { id: tenantId }, body: { invoiceId: id, ...(paise ? { taxablePaise: paise } : {}), reason } }), 'The credit note is issued.'))}
    >
      <TextField label="Invoice number (its id)" inputMode="numeric" value={invoice} onChange={(event) => setInvoice(event.target.value)} required />
      <TextField label="Amount before tax, in rupees" inputMode="decimal" hint="Empty reverses the whole invoice." value={amount} onChange={(event) => setAmount(event.target.value)} error={Number.isNaN(paise) ? 'Enter an amount like 499 or 499.50' : undefined} />
    </ActionSheet>
  );
}

export function BusinessBillingPage() {
  const { id } = useParams();
  const can = useCan();
  const act = useAct();
  const query = useOne(['billing', id], () => api.billing({ params: { id } }));
  const [sheet, setSheet] = useState('');
  const [note, setNote] = useState(null);
  const close = () => setSheet('');

  return (
    <div className="stack">
      <BackLink to="/billing">Billing</BackLink>
      <QueryState query={query} label="Loading billing">
        {(billing) => (
          <>
            <PageHeader eyebrow="Billing" title={PLAN_LABELS[billing.plan] ?? billing.plan} actions={billing.status && <Badge tone={STATUS_TONE[billing.status]}>{word('subscription', billing.status)}</Badge>} />
            {billing.status === 'suspended' && <Banner tone="bad">Billing is suspended. The business is not charged and its plan features follow the grace rules.</Banner>}
            {note && <Banner tone="good">Credit note {note.number} is issued for {formatPaise(note.totalPaise)}.</Banner>}
            <Panel title="Subscription">
              <Facts rows={[
                ['Plan', PLAN_LABELS[billing.plan] ?? billing.plan],
                ['Cycle', billing.cycle === 'yearly' ? 'Yearly' : 'Monthly'],
                ['Status', billing.status ? word('subscription', billing.status) : 'No subscription'],
                ['Period ends', <When key="p" value={billing.periodEnd} />],
                ['Grace until', billing.graceUntil ? <When key="g" value={billing.graceUntil} /> : ''],
                ['Offer', billing.offerCode],
              ]}
              />
            </Panel>
            <Panel title="Add-ons and packs">
              {billing.items.length ? (
                <ListCard>
                  {billing.items.map((item) => (
                    <ListRow key={item.id} title={item.name} meta={`${item.quantity} × ${formatPaise(item.unitPricePaise)} · ${item.cycle}${item.endsAt ? '' : ''}`} trailing={<Badge>{item.kind}</Badge>} />
                  ))}
                </ListCard>
              ) : <p className="muted">Nothing extra is billed.</p>}
            </Panel>
            {billing.overrides.length > 0 && (
              <Panel title="Features set by hand">
                <Facts rows={billing.overrides.map((o) => [o.feature, `${o.enabled ? 'On' : 'Off'}${o.limit === null ? '' : `, limit ${o.limit}`}`])} />
              </Panel>
            )}
            <Panel title="Changes">
              {billing.changes.length ? (
                <ListCard>
                  {billing.changes.map((change, index) => (
                    <ListRow
                      key={`${change.at}-${index}`}
                      title={`${PLAN_LABELS[change.fromPlan] ?? change.fromPlan} to ${PLAN_LABELS[change.toPlan] ?? change.toPlan}`}
                      meta={<>{change.actor} · {change.source}{change.reason ? ` · ${change.reason}` : ''} · <When value={change.at} /></>}
                    />
                  ))}
                </ListCard>
              ) : <p className="muted">No plan changes yet.</p>}
            </Panel>
            <Panel title="Actions">
              <div className="form-actions">
                <Can route="platform.overridePlan"><Button variant="outline" onClick={() => setSheet('plan')}>Change plan</Button></Can>
                <Can route="platform.createCreditNote"><Button variant="outline" onClick={() => setSheet('credit')}>Issue a credit note</Button></Can>
                {can('platform.suspendBilling') && billing.status !== 'suspended' && <Button variant="danger" onClick={() => setSheet('suspend')}>Suspend billing</Button>}
                {can('platform.resumeBilling') && billing.status === 'suspended' && <Button onClick={() => setSheet('resume')}>Resume billing</Button>}
              </div>
            </Panel>
            <Can route="platform.overridePlan"><PlanOverrideSheet tenantId={Number(id)} name="this business" current={billing.plan} open={sheet === 'plan'} onClose={close} /></Can>
            <Can route="platform.createCreditNote"><CreditNoteSheet tenantId={id} open={sheet === 'credit'} onClose={close} onIssued={setNote} /></Can>
            <ActionSheet
              open={sheet === 'suspend'}
              title="Suspend billing"
              intro="No charge is made until billing is resumed."
              submitLabel="Suspend billing"
              tone="danger"
              onClose={close}
              onSubmit={(reason) => act(() => api.suspendBilling({ params: { id }, body: { reason } }), 'Billing is suspended.')}
            />
            <ActionSheet
              open={sheet === 'resume'}
              title="Resume billing"
              submitLabel="Resume billing"
              onClose={close}
              onSubmit={(reason) => act(() => api.resumeBilling({ params: { id }, body: { reason } }), 'Billing is running again.')}
            />
          </>
        )}
      </QueryState>
    </div>
  );
}

export function BillingSettingsPage() {
  const query = useOne(['billing-settings'], () => api.billingSettings());
  const can = useCan();
  const act = useAct();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  const set = (name) => (event) => setDraft((current) => ({ ...current, [name]: event.target.type === 'checkbox' ? event.target.checked : event.target.value }));
  return (
    <div className="stack">
      <BackLink to="/billing">Billing</BackLink>
      <PageHeader eyebrow="Billing" title="Bhava’s billing details" />
      <QueryState query={query} label="Loading billing details">
        {(settings) => (
          <>
            <Panel title="On every invoice">
              <Facts rows={[
                ['Legal name', settings.legalName],
                ['GSTIN', settings.gstin],
                ['State code', settings.stateCode],
                ['Address', settings.address],
                ['SAC', settings.sac],
                ['Tax rate', `${settings.taxRateBp / 100}%`],
                ['Statement day', String(settings.statementDay)],
                ['Grace days', String(settings.graceDays)],
                ['After grace', settings.afterGrace === 'suspend' ? 'Suspend' : 'Move to Free'],
                ['Proration', settings.proration === 'daily' ? 'By the day' : 'None'],
                ['Free can buy packs', settings.freeCanBuyPacks ? 'Yes' : 'No'],
                ['Referral reward', formatPaise(settings.referralRewardPaise)],
              ]}
              />
            </Panel>
            {can('platform.saveBillingSettings') && (
              <>
                <Button variant="outline" onClick={() => { setDraft({ legalName: settings.legalName, gstin: settings.gstin, graceDays: String(settings.graceDays), afterGrace: settings.afterGrace, freeCanBuyPacks: settings.freeCanBuyPacks }); setOpen(true); }}>Change these details</Button>
                <ActionSheet
                  open={open}
                  title="Change billing details"
                  submitLabel="Save details"
                  valid={Boolean(draft) && /^\d{1,2}$/.test(String(draft.graceDays))}
                  onClose={() => setOpen(false)}
                  onSubmit={(reason) => act(() => api.saveBillingSettings({ body: { legalName: draft.legalName, gstin: draft.gstin, graceDays: Number(draft.graceDays), afterGrace: draft.afterGrace, freeCanBuyPacks: draft.freeCanBuyPacks, reason } }), 'The billing details are saved.')}
                >
                  {draft && (
                    <>
                      <TextField label="Legal name" value={draft.legalName} onChange={set('legalName')} />
                      <TextField label="GSTIN" value={draft.gstin} onChange={set('gstin')} />
                      <TextField label="Grace days" inputMode="numeric" value={draft.graceDays} onChange={set('graceDays')} />
                      <SelectField label="After grace" value={draft.afterGrace} onChange={set('afterGrace')}>
                        <option value="suspend">Suspend</option>
                        <option value="move_to_free">Move to Free</option>
                      </SelectField>
                      <Toggle label="Free can buy packs" checked={draft.freeCanBuyPacks} onChange={set('freeCanBuyPacks')} />
                    </>
                  )}
                </ActionSheet>
              </>
            )}
          </>
        )}
      </QueryState>
    </div>
  );
}
