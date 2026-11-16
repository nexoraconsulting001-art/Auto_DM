import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, Banner, Button, EmptyState, LoadMore, PageHeader, Panel, SelectField, Spinner } from '../../design/index.jsx';
import { Sheet } from '../../design/index.jsx';
import { useFeedback } from '../../components/feedback.jsx';
import { api } from '../../lib/api/index.js';
import { formatDate, formatPaise, plural } from '../../lib/format.js';
import { usePagedList, useRefresh } from '../../lib/query.js';
import { Screen } from '../catalog/shared/ui.jsx';
import { isCancelled, useFresh } from '../account/fresh.jsx';
import { CYCLES, changeKind, meterView, newRequestKey, planNamed, priceFor, safeFileUrl, switchesOff, yearlySaving } from './contract.js';
import './billing.css';

const STATUS_WORDS = { active: 'Active', past_due: 'Payment overdue', grace: 'In grace period', suspended: 'Paused', cancelled: 'Cancelled' };
const cycleWord = (cycle) => (cycle === 'yearly' ? 'a year' : 'a month');

/** Money changes ask for a fresh check first (useFresh), and a payment goes through the provider's own page, never ours. */
function useMoney() {
  const fresh = useFresh();
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const [busy, setBusy] = useState('');
  async function run(name, action, done) {
    setBusy(name);
    try {
      const result = await fresh.run(action);
      await refresh();
      if (done) toast(typeof done === 'function' ? done(result) : done);
      return result;
    } catch (error) {
      if (!isCancelled(error)) toast(error.message);
      return null;
    } finally {
      setBusy('');
    }
  }
  const hosted = (url) => {
    if (safeFileUrl(url)) window.location.assign(url);
  };
  return { fresh, run, busy, hosted };
}

function PlanSummary({ plan }) {
  return (
    <Panel title="Your plan">
      <div className="p7-row">
        <h3 className="grow" data-testid="current-plan">{plan.planName}</h3>
        <Badge tone={plan.status === 'active' ? 'good' : 'warn'}>{STATUS_WORDS[plan.status] ?? plan.status}</Badge>
      </div>
      <p className="p7-meta">
        {plan.nextChargePaise > 0 ? `Next charge ${formatPaise(plan.nextChargePaise)} before tax` : 'Nothing is charged on this plan.'}
        {plan.periodEnd ? ` · period ends ${formatDate(plan.periodEnd)}` : ''}
        {plan.cycle === 'yearly' ? ' · billed yearly' : ''}
      </p>
      {plan.offer && <Banner tone="good">{plan.offer.name}: {plan.offer.percentOff}% off{plan.offer.forLife ? ' for as long as you stay' : ''}.</Banner>}
      {plan.nextPlan && <Banner tone="info">Moving to {plan.nextPlan}{plan.nextCycle ? `, billed ${plan.nextCycle}` : ''} when this period ends.</Banner>}
      {plan.graceUntil && <Banner tone="warn">Your payment did not go through. Everything stays on until {formatDate(plan.graceUntil)}. Update your payment method to keep it.</Banner>}
    </Panel>
  );
}

function ChangeSheet({ catalog, plan, target, onClose, money }) {
  const dialog = useRef(null);
  const [cycle, setCycle] = useState(plan.cycle);
  const [key] = useState(newRequestKey);
  useEffect(() => {
    if (!dialog.current.open) dialog.current.showModal();
  }, []);
  const chosen = planNamed(catalog, target);
  const kind = changeKind(catalog, plan.plan, target);
  const off = kind === 'downgrade' ? switchesOff(catalog, plan.plan, target) : [];

  async function confirm() {
    const result = await money.run('change', () => api.billing.change({ plan: target, cycle, requestKey: key }), (r) => (r.effective === 'now' ? `You are on ${chosen.name}.` : `You move to ${chosen.name} when this period ends.`));
    if (result?.checkoutUrl) money.hosted(result.checkoutUrl);
    else if (result) onClose();
  }

  return (
    <Sheet ref={dialog} title={`${kind === 'downgrade' ? 'Move down to' : 'Move up to'} ${chosen.name}`} onClose={onClose}>
      <div className="p7-stack">
        <SelectField label="Billing" value={cycle} onChange={(event) => setCycle(event.target.value)}>
          {CYCLES.map((name) => <option key={name} value={name}>{name === 'yearly' ? 'Yearly' : 'Monthly'}</option>)}
        </SelectField>
        <p className="p7-meta" data-testid="change-price">{formatPaise(priceFor(chosen, cycle))} {cycleWord(cycle)}, before tax. The exact amount is shown on the payment page.</p>
        {kind === 'downgrade' && <p className="p7-meta">A move down takes effect when your current period ends. Until then nothing changes.</p>}
        {off.length > 0 && (
          <Banner tone="warn">
            <span data-testid="switch-off">These switch off: {off.join(', ')}.</span>
          </Banner>
        )}
        {kind === 'downgrade' && off.length === 0 && <p className="p7-meta">Nothing you use switches off.</p>}
        <div className="sheet-actions">
          <Button variant="outline" onClick={() => dialog.current.close()}>Keep my plan</Button>
          <Button loading={money.busy === 'change'} onClick={confirm}>{kind === 'downgrade' ? 'Move down' : 'Upgrade'}</Button>
        </div>
      </div>
    </Sheet>
  );
}

function Plans({ plan, catalog, money }) {
  const [cycle, setCycle] = useState(plan.cycle);
  const [target, setTarget] = useState('');
  return (
    <Panel title="Plans">
      <div className="p7-stack">
        <div className="p7-cycle" role="group" aria-label="Billing period">
          {CYCLES.map((name) => (
            <Button key={name} variant={cycle === name ? 'primary' : 'outline'} aria-pressed={cycle === name} onClick={() => setCycle(name)}>{name === 'yearly' ? 'Yearly' : 'Monthly'}</Button>
          ))}
        </div>
        {catalog.offer && <Banner tone="good">{catalog.offer.name}: {catalog.offer.percentOff}% off for new paying accounts.</Banner>}
        <ul className="p7-list" aria-label="Plans">
          {catalog.plans.map((entry) => {
            const current = entry.code === plan.plan;
            const kind = changeKind(catalog, plan.plan, entry.code);
            const saving = yearlySaving(entry);
            return (
              <li key={entry.code} className="p7-plan" data-current={current} data-testid={`plan-${entry.code}`}>
                <h3>{entry.name}</h3>
                <span className="p7-price">{entry.monthlyPaise === 0 ? 'Free' : `${formatPaise(priceFor(entry, cycle))} ${cycleWord(cycle)}`}</span>
                <p className="p7-meta">{entry.includedDms === null ? 'No limit on automated DMs' : `${entry.includedDms} automated DMs a month`}</p>
                {cycle === 'yearly' && saving > 0 && <p className="p7-meta">You save {formatPaise(saving)} a year.</p>}
                {current ? <Badge tone="neel">Your plan</Badge> : <Button variant={kind === 'upgrade' ? 'primary' : 'outline'} aria-label={`${kind === 'upgrade' ? 'Upgrade' : 'Move down'} to ${entry.name}`} onClick={() => setTarget(entry.code)}>{kind === 'upgrade' ? 'Upgrade' : 'Move down'}</Button>}
              </li>
            );
          })}
        </ul>
        <p className="p7-meta">Prices exclude tax ({catalog.taxRateBp / 100}% GST is added at payment).</p>
      </div>
      {target && <ChangeSheet key={target} catalog={catalog} plan={plan} target={target} money={money} onClose={() => setTarget('')} />}
    </Panel>
  );
}

function Usage({ usage, catalog, money }) {
  const packs = catalog.addons.filter((addon) => addon.kind === 'pack' && addon.meter === 'dms');
  return (
    <Panel title="Usage this month">
      <div className="p7-stack">
        {usage.meters.map((meter) => {
          const view = meterView(meter);
          return (
            <div key={meter.meter} className="p7-meter" data-testid={`meter-${meter.meter}`}>
              <div className="p7-row"><strong className="grow">{view.label}</strong><Badge tone={view.tone}>{view.unlimited ? 'No limit' : `${meter.percent}%`}</Badge></div>
              <div className="p7-meter-bar"><div className="p7-meter-fill" data-tone={view.tone} style={{ width: `${view.percent}%` }} role="progressbar" aria-label={`${view.label} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.percent} /></div>
              <p className="p7-meta">{view.text}{meter.packUnits > 0 ? ` (includes ${meter.packUnits} from packs)` : ''}</p>
            </div>
          );
        })}
        <p className="p7-meta">Resets {formatDate(usage.resetsAt)}.</p>
        {usage.heldDms > 0 && <Banner tone="warn">{plural(usage.heldDms, 'automated DM')} waiting because this month’s DMs are used up. They go out when you add a pack or upgrade.</Banner>}
        {usage.canBuyPacks && packs.length > 0 && (
          <div className="p7-stack">
            <strong>Need more DMs this month?</strong>
            {packs.map((pack) => (
              <div key={pack.code} className="p7-item">
                <span className="grow"><strong>{pack.name}</strong><span className="p7-meta">{pack.units ? `${pack.units} DMs · ` : ''}{formatPaise(pack.pricePaise)} once</span></span>
                <Button variant="soft" disabled={!pack.available} loading={money.busy === pack.code} onClick={() => money.run(pack.code, async () => {
                  const added = await api.billing.addItem({ code: pack.code, quantity: 1, requestKey: newRequestKey() });
                  if (added.checkoutUrl) money.hosted(added.checkoutUrl);
                  return added;
                }, 'Pack added.')}>Buy pack</Button>
              </div>
            ))}
          </div>
        )}
        {!usage.canBuyPacks && <p className="p7-meta">Packs are available on paid plans.</p>}
      </div>
    </Panel>
  );
}

const WHY = { included: 'Included in your plan', needs_plan: 'Needs a higher plan', already_has: 'You have this' };

function Addons({ plan, catalog, money }) {
  const addons = catalog.addons.filter((addon) => addon.kind !== 'pack');
  const own = plan.items.filter((item) => item.kind !== 'pack');
  return (
    <Panel title="Add-ons">
      <div className="p7-stack">
        {own.length > 0 && (
          <ul className="p7-list" aria-label="Your add-ons">
            {own.map((item) => (
              <li key={item.id} className="p7-item">
                <span className="grow"><strong>{item.name}</strong><span className="p7-meta">{formatPaise(item.unitPricePaise)} {item.cycle === 'monthly' ? 'a month' : 'once'}{item.quantity > 1 ? ` × ${item.quantity}` : ''}</span></span>
                <Button variant="outline" aria-label={`Remove ${item.name}`} loading={money.busy === `rm${item.id}`} onClick={() => money.run(`rm${item.id}`, () => api.billing.removeItem(item.id), `${item.name} removed.`)}>Remove</Button>
              </li>
            ))}
          </ul>
        )}
        <ul className="p7-list" aria-label="Add-ons you can add">
          {addons.map((addon) => (
            <li key={addon.code} className="p7-item" data-testid={`addon-${addon.code}`}>
              <span className="grow"><strong>{addon.name}</strong><span className="p7-meta">{formatPaise(addon.pricePaise)} {addon.cycle === 'monthly' ? 'a month' : 'once'}{!addon.available && addon.unavailable ? ` · ${WHY[addon.unavailable]}` : ''}</span></span>
              {addon.available && <Button variant="soft" aria-label={`Add ${addon.name}`} loading={money.busy === addon.code} onClick={() => money.run(addon.code, async () => {
                const added = await api.billing.addItem({ code: addon.code, quantity: 1, requestKey: newRequestKey() });
                if (added.checkoutUrl) money.hosted(added.checkoutUrl);
                return added;
              }, `${addon.name} added.`)}>Add</Button>}
            </li>
          ))}
          {addons.length === 0 && <li><EmptyState title="No add-ons yet">Add-ons will appear here when they are available for your plan.</EmptyState></li>}
        </ul>
      </div>
    </Panel>
  );
}

async function openFile(load, toast) {
  try {
    const file = await load();
    if (safeFileUrl(file.fileUrl)) window.open(file.fileUrl, '_blank', 'noopener');
    else toast('That file is not available.');
  } catch (error) {
    toast(error.message);
  }
}

function Invoices() {
  const { toast } = useFeedback();
  const list = usePagedList('billing-invoices', api.billing.invoices, {}, { retry: false });
  return (
    <Panel title="Invoices">
      {list.isPending && <Spinner label="Loading your invoices" />}
      {list.isError && <Banner tone="bad">We could not load your invoices. {list.error.message}</Banner>}
      {!list.isPending && !list.isError && list.items.length === 0 && <EmptyState title="No invoices yet">Your first invoice appears here after your first payment.</EmptyState>}
      {list.items.length > 0 && (
        <ul className="p7-list" aria-label="Invoices">
          {list.items.map((invoice) => (
            <li key={invoice.id} className="p7-item" data-testid="invoice">
              <span className="grow"><strong>{invoice.docType === 'credit_note' ? 'Credit note' : 'Invoice'} {invoice.number}</strong><span className="p7-meta">{formatDate(invoice.issuedAt)} · {formatPaise(invoice.totalPaise)} with tax · {invoice.paid ? 'Paid' : 'Not paid'}</span></span>
              {/* The file is made the first time it is asked for (hasFile only says it is already kept), so the button is always there. */}
              <Button variant="outline" aria-label={`Download ${invoice.number}`} onClick={() => openFile(() => api.billing.invoiceFile(invoice.id), toast)}>Download</Button>
            </li>
          ))}
        </ul>
      )}
      <LoadMore query={list} />
    </Panel>
  );
}

function Statements() {
  const { toast } = useFeedback();
  const list = usePagedList('billing-statements', api.billing.statements, {}, { retry: false });
  return (
    <Panel title="Monthly statements">
      <p className="p7-meta">Your sales, refunds, gateway fees and payouts for each month. Bhava takes no share of your sales.</p>
      {list.isPending && <Spinner label="Loading your statements" />}
      {list.isError && <Banner tone="bad">We could not load your statements. {list.error.message}</Banner>}
      {!list.isPending && !list.isError && list.items.length === 0 && <EmptyState title="No statements yet">A statement is made after each month closes.</EmptyState>}
      {list.items.length > 0 && (
        <ul className="p7-list" aria-label="Statements">
          {list.items.map((statement) => (
            <li key={statement.id} className="p7-item" data-testid="statement">
              <span className="grow"><strong>{formatDate(statement.month)}</strong><span className="p7-meta">Closing balance {formatPaise(statement.closingBalance.amountPaise)} {statement.closingBalance.amountPaise === 0 ? '' : statement.closingBalance.owedTo === 'business' ? 'owed to you' : 'owed to Bhava'}</span></span>
              {<Button variant="outline" aria-label={`Download statement ${statement.month} as PDF`} onClick={() => openFile(() => api.billing.statementFile(statement.id, { format: 'pdf' }), toast)}>PDF</Button>}
              {<Button variant="outline" aria-label={`Download statement ${statement.month} as CSV`} onClick={() => openFile(() => api.billing.statementFile(statement.id, { format: 'csv' }), toast)}>CSV</Button>}
            </li>
          ))}
        </ul>
      )}
      <LoadMore query={list} />
    </Panel>
  );
}

function PaymentMethod({ plan, money }) {
  return (
    <Panel title="Payment method">
      <p className="p7-meta">{plan.hasPaymentMethod ? 'A payment method is saved.' : 'No payment method saved yet.'} It is added on the payment provider’s own page. Bhava never sees your card details.</p>
      <Button variant="soft" loading={money.busy === 'method'} onClick={async () => {
        const page = await money.run('method', () => api.billing.paymentMethod());
        if (page) money.hosted(page.url);
      }}>{plan.hasPaymentMethod ? 'Change payment method' : 'Add a payment method'}</Button>
    </Panel>
  );
}

export default function BillingPage() {
  const plan = useQuery({ queryKey: ['billing', 'plan'], queryFn: () => api.billing.plan() });
  const catalog = useQuery({ queryKey: ['billing', 'catalog'], queryFn: () => api.billing.catalog() });
  const usage = useQuery({ queryKey: ['billing', 'usage'], queryFn: () => api.billing.usage() });
  const money = useMoney();
  return (
    <div className="p7-stack">
      <PageHeader eyebrow="Account" title="Plan and billing" />
      <Screen query={plan} label="Loading your plan" errorTitle="We couldn’t load your plan">
        {(planData) => (
          <>
            <PlanSummary plan={planData} />
            <Screen query={catalog} label="Loading plans" errorTitle="We couldn’t load the plans">
              {(catalogData) => (
                <>
                  <Plans plan={planData} catalog={catalogData} money={money} />
                  <Screen query={usage} label="Loading your usage" errorTitle="We couldn’t load your usage">
                    {(usageData) => <Usage usage={usageData} catalog={catalogData} money={money} />}
                  </Screen>
                  <Addons plan={planData} catalog={catalogData} money={money} />
                </>
              )}
            </Screen>
            <PaymentMethod plan={planData} money={money} />
          </>
        )}
      </Screen>
      <Invoices />
      <Statements />
    </div>
  );
}
