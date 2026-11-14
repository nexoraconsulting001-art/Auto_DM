import { PLAN_LABELS } from '../../lib/rules.js';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { BackLink, Badge, Banner, Button, ListCard, ListRow, PageHeader, Panel, SearchField, SelectField, TextField } from '../../../design/index.jsx';
import { useFeedback } from '../../../components/feedback.jsx';
import { useForm } from '../../../lib/forms.js';
import { Can, Facts, PagedRows, QueryState, When, useAct, useCan, useOne, usePlatformList } from '../../kit.jsx';
import { TIERS, createActivityTracker } from '../../lib/rules.js';
import { listBusinesses, loadBusiness } from '../../data.js';
import { api } from '../../api.js';
import { MetaAccessSheet, PauseSheet, PlanOverrideSheet, ResumeSheet } from './actions.jsx';
import { ImpersonateSheet, StartedNote } from '../impersonation/actions.jsx';

const statusTone = (business) => (business.status === 'active' ? 'good' : business.status === 'paused' ? 'warn' : 'neutral');

export function BusinessesPage() {
  const [search, setSearch] = useState('');
  const query = usePlatformList('businesses', listBusinesses);
  const needle = search.trim().toLowerCase();
  const shown = needle ? query.items.filter((b) => `${b.name} ${b.slug}`.toLowerCase().includes(needle)) : query.items;
  return (
    <div className="stack">
      <PageHeader
        eyebrow="Bhava Console"
        title="Businesses"
        actions={<Can route="platform.createBusiness"><Button as={Link} to="/businesses/new"><Plus size={18} aria-hidden="true" /> New business</Button></Can>}
      />
      <SearchField label="Search by name" value={search} onChange={(event) => setSearch(event.target.value)} />
      <PagedRows query={query} empty="No businesses yet" emptyText="Create the first one with New business." label="Loading businesses">
        {() => (
          shown.length ? (
            <ListCard>
              {shown.map((business) => (
                <ListRow
                  key={business.id}
                  as={Link}
                  to={`/businesses/${business.id}`}
                  title={business.name}
                  meta={[business.slug, PLAN_LABELS[business.plan] ?? business.plan].filter(Boolean).join(" · ")}
                  trailing={<Badge tone={statusTone(business)}>{business.status}</Badge>}
                />
              ))}
            </ListCard>
          ) : <p className="muted">Nothing loaded matches “{search}”. Load more rows or change the search.</p>
        )}
      </PagedRows>
    </div>
  );
}

const BLANK = { name: '', website: '', igHandle: '', plan: 'free', cycle: 'monthly', ownerName: '', ownerPhone: '', ownerEmail: '' };

/** Creates a business (5.5). The time the operator spends on this form is reported against the 10-minute target. */
export function NewBusinessPage() {
  const navigate = useNavigate();
  const act = useAct();
  const { toast } = useFeedback();
  const form = useForm(BLANK);
  const tracker = useRef(createActivityTracker());
  const [created, setCreated] = useState(null);
  useEffect(() => { tracker.current.touch(); }, []);
  const touch = () => tracker.current.touch();

  async function submit(event) {
    event.preventDefault();
    const missing = {};
    if (!form.values.name.trim()) missing.name = 'Enter the business name';
    if (!form.values.ownerName.trim()) missing.ownerName = 'Enter the owner’s name';
    if (!form.values.ownerPhone.trim()) missing.ownerPhone = 'Enter the owner’s phone';
    if (Object.keys(missing).length) return form.reject(missing);
    tracker.current.touch();
    const done = await form.run(async () => {
      const result = await act(() => api.createBusiness({ body: { ...form.values, name: form.values.name.trim() } }), 'The business is created.');
      setCreated(result);
      const spent = tracker.current.flush();
      if (spent) await api.recordOnboardingTime({ params: { id: result.tenant.id }, body: { step: 'form', ...spent } }).catch(() => {});
    });
    if (!done) toast('The business was not created.');
    return undefined;
  }

  if (created) {
    return (
      <div className="stack">
        <PageHeader eyebrow="Businesses" title={created.tenant.name} />
        <Banner tone="good">{created.tenant.name} is created.</Banner>
        <Panel title="What we read from the website">
          {created.draftKit
            ? <Facts rows={[['Logo', created.draftKit.logoUrl || 'None found'], ['Colours', Object.values(created.draftKit.colors).join(', ') || 'None found']]} />
            : <p className="muted">Nothing was read. Add the website later, or fill the brand by hand.</p>}
        </Panel>
        <Panel title="Products">
          {created.import
            ? <p>{created.import.canRetry ? 'The product import did not finish. You can retry it from the business page.' : 'The product import is running.'}</p>
            : <p className="muted">No import was started.</p>}
        </Panel>
        <div className="form-actions">
          <Button as={Link} to={`/onboarding/${created.tenant.id}`}>Open the onboarding workspace</Button>
          <Button as={Link} variant="outline" to={`/businesses/${created.tenant.id}`}>Open the business</Button>
          <Button variant="soft" onClick={() => navigate('/businesses')}>Back to the list</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <BackLink to="/businesses">Businesses</BackLink>
      <PageHeader eyebrow="Businesses" title="New business" />
      <form className="stack" onSubmit={submit} onChange={touch} noValidate>
        {form.message && <Banner tone="bad">{form.message}</Banner>}
        <Panel title="The business">
          <div className="stack">
            <TextField label="Business name" autoComplete="off" {...form.field('name')} required />
            <TextField label="Website" inputMode="url" autoComplete="off" hint="We read the brand and products from it." {...form.field('website')} />
            <TextField label="Instagram handle" autoComplete="off" {...form.field('igHandle')} />
            <SelectField label="Plan" {...form.field('plan')}>
              {TIERS.map((tier) => <option key={tier} value={tier}>{PLAN_LABELS[tier]}</option>)}
            </SelectField>
            <SelectField label="Billing cycle" {...form.field('cycle')}>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </SelectField>
          </div>
        </Panel>
        <Panel title="The owner">
          <div className="stack">
            <TextField label="Owner’s name" autoComplete="off" {...form.field('ownerName')} required />
            <TextField label="Owner’s phone" type="tel" inputMode="tel" autoComplete="off" {...form.field('ownerPhone')} required />
            <TextField label="Owner’s email" type="email" inputMode="email" autoComplete="off" {...form.field('ownerEmail')} />
          </div>
        </Panel>
        <Button type="submit" size="large" block loading={form.busy}>Create business</Button>
      </form>
    </div>
  );
}

export function BusinessPage() {
  const { id } = useParams();
  const can = useCan();
  const act = useAct();
  const { toast } = useFeedback();
  const query = useOne(['business', id], () => loadBusiness(id));
  const [sheet, setSheet] = useState('');
  const [started, setStarted] = useState(null);
  const [retrying, setRetrying] = useState(false);
  const close = () => setSheet('');

  async function retry() {
    setRetrying(true);
    try {
      await act(() => api.retryImport({ params: { id } }), 'The import is running again.');
    } catch (error) {
      toast(error.message);
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="stack">
      <BackLink to="/businesses">Businesses</BackLink>
      <QueryState query={query} label="Loading the business">
        {(business) => (
          <>
            <PageHeader eyebrow={business.slug} title={business.name} actions={<Badge tone={business.paused ? 'warn' : 'good'}>{business.paused ? 'Paused' : business.status}</Badge>} />
            {business.paused && <Banner tone="warn">Paused{business.pausedBy ? ` by ${business.pausedBy}` : ''}. Nothing sends until it is resumed.</Banner>}
            {business.reconnectNeeded && <Banner tone="bad">The owner has to reconnect Instagram.</Banner>}
            {business.partial && <Banner tone="info">This server does not send the full business details yet. This page shows what it can.</Banner>}
            <StartedNote started={started} name={business.name} />
            <Panel title="Details">
              <Facts rows={[
                ['Plan', PLAN_LABELS[business.plan] ?? business.plan],
                ['Website', business.website],
                ['Legal name', business.legalName],
                ['Meta access', business.partial ? '' : business.accessLevel === 'advanced' ? 'Advanced' : 'Standard'],
                ['Sending breaker', business.partial ? '' : business.breaker.replace('_', ' ')],
                ['Health score', business.partial ? '' : business.score === null ? 'Not checked yet' : `${business.score} of 100`],
                ['Created', business.createdAt ? <When key="c" value={business.createdAt} /> : ''],
              ]}
              />
            </Panel>
            <Panel title="Actions">
              <div className="form-actions">
                <Can route="platform.pauseBusiness">
                  {business.paused
                    ? <Button onClick={() => setSheet('resume')}>Resume business</Button>
                    : <Button variant="danger" onClick={() => setSheet('pause')}>Pause business</Button>}
                </Can>
                <Can route="platform.overridePlan"><Button variant="outline" onClick={() => setSheet('plan')}>Change plan</Button></Can>
                <Can route="platform.setMetaAccess"><Button variant="outline" onClick={() => setSheet('meta')}>Meta access level</Button></Can>
                <Can route="platform.impersonate"><Button variant="outline" onClick={() => setSheet('impersonate')}>Open as the owner</Button></Can>
                {can('platform.retryImport') && <Button variant="soft" loading={retrying} onClick={retry}>Retry product import</Button>}
              </div>
            </Panel>
            <Panel title="Go to">
              <ListCard>
                {can('platform.onboarding') && <ListRow as={Link} to={`/onboarding/${business.id}`} title="Onboarding workspace" />}
                {can('platform.businessHealth') && <ListRow as={Link} to={`/health/${business.id}`} title="Health checks" />}
                {can('platform.billing') && <ListRow as={Link} to={`/billing/${business.id}`} title="Plan and billing" />}
                {can('platform.tenantFlags') && <ListRow as={Link} to={`/flags?business=${business.id}`} title="Flags for this business" />}
              </ListCard>
            </Panel>
            <Can route="platform.pauseBusiness">
              <PauseSheet business={business} open={sheet === 'pause'} onClose={close} />
              <ResumeSheet business={business} open={sheet === 'resume'} onClose={close} />
            </Can>
            <Can route="platform.overridePlan"><PlanOverrideSheet tenantId={business.id} name={business.name} current={business.plan} open={sheet === 'plan'} onClose={close} /></Can>
            <Can route="platform.setMetaAccess"><MetaAccessSheet business={business} open={sheet === 'meta'} onClose={close} /></Can>
            <Can route="platform.impersonate"><ImpersonateSheet business={business} open={sheet === 'impersonate'} onClose={close} onStarted={setStarted} /></Can>
          </>
        )}
      </QueryState>
    </div>
  );
}
