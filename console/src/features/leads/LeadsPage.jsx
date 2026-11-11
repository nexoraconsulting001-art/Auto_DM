import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Download } from 'lucide-react';
import { MANAGERS } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { Badge, Banner, Button, Chip, ChipRow, EmptyState, FieldGroup, LoadMore, PageHeader, Panel, SelectField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useAllowed, useFilters, usePagedList, useRefresh } from '../../lib/query.js';
import { AreaTabs, Badges, Screen } from '../catalog/shared/ui.jsx';
import { CONSENT_TABS, FORMAT_CHOICES, LEAD_TABS, SOURCE_TABS, activeChannels, consentBadges, downloadView, leadContact, leadLine, mayContact } from './form.js';

function LeadRow({ lead, canDelete, busy, onRevoke, onRemove }) {
  return (
    <li className="p3-lead">
      <div className="p3-item-head">
        <span className="list-row-title">{lead.firstName}</span>
        {!mayContact(lead) && <Badge tone="bad">Don’t contact</Badge>}
      </div>
      <span className="p3-lead-contact">{leadContact(lead)}</span>
      <span className="list-row-meta">{leadLine(lead)}</span>
      <Badges items={consentBadges(lead)} />
      <div className="row-actions">
        {lead.pageId && <Button as={Link} variant="soft" to={`/pages/${lead.pageId}`}>Open the page</Button>}
        {activeChannels(lead).length > 0 && <Button variant="outline" disabled={busy} aria-label={`They withdrew consent: ${lead.firstName}`} onClick={() => onRevoke(lead)}>They withdrew consent</Button>}
        {canDelete && <Button variant="danger" disabled={busy} aria-label={`Delete ${lead.firstName}`} onClick={() => onRemove(lead)}>Delete</Button>}
      </div>
    </li>
  );
}

function LeadList({ canDelete }) {
  const { toast, confirm } = useFeedback();
  const refresh = useRefresh();
  const [params, setFilter] = useFilters();
  const source = SOURCE_TABS.some(([key]) => key === params.get('source')) ? params.get('source') : 'all';
  const consent = CONSENT_TABS.some(([key]) => key === params.get('consent')) ? params.get('consent') : 'all';
  const leads = usePagedList('leads', api.leads.list, { source, consent });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const filtered = source !== 'all' || consent !== 'all';

  async function run(action, done) {
    setBusy(true);
    setProblem('');
    try {
      await action();
      toast(done);
      await refresh();
    } catch (failure) {
      setProblem(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(lead) {
    const yes = await confirm({
      title: `Record that ${lead.firstName} withdrew consent?`,
      text: 'Use this when they told you some other way, such as in a call. They are never contacted for marketing again, and this can’t be undone.',
      confirm: 'Record it',
      cancel: 'Not now',
    });
    if (yes) await run(() => api.leads.revokeConsent(lead.id, {}), 'Recorded. They won’t be contacted.');
  }

  async function remove(lead) {
    const yes = await confirm({ title: `Delete ${lead.firstName}?`, text: 'Their details and consent record are removed for good.', confirm: 'Delete lead' });
    if (yes) await run(() => api.leads.remove(lead.id), 'Lead deleted.');
  }

  return (
    <>
      <div className="filters">
        <ChipRow label="Filter by where they came from">
          {SOURCE_TABS.map(([key, label]) => <Chip key={key} pressed={source === key} onClick={() => setFilter('source', key === 'all' ? '' : key)}>{label}</Chip>)}
        </ChipRow>
        <ChipRow label="Filter by consent">
          {CONSENT_TABS.map(([key, label]) => <Chip key={key} pressed={consent === key} onClick={() => setFilter('consent', key === 'all' ? '' : key)}>{label}</Chip>)}
        </ChipRow>
      </div>
      {problem && <Banner tone="bad">{problem}</Banner>}
      <Screen query={leads} label="Loading your leads" errorTitle="We couldn’t load your leads">
        {() => (leads.items.length ? (
          <>
            <ul className="p3-leads" aria-label="Leads">
              {leads.items.map((lead) => <LeadRow key={lead.id} lead={lead} canDelete={canDelete} busy={busy} onRevoke={revoke} onRemove={remove} />)}
            </ul>
            <LoadMore query={leads} />
          </>
        ) : (
          <EmptyState title={filtered ? 'No leads match' : 'No leads yet'}>
            {filtered ? 'Try another filter.' : 'When a shopper fills in the form on one of your pages, they show here with what they agreed to.'}
          </EmptyState>
        ))}
      </Screen>
    </>
  );
}

/** A file of this business's leads. Each one made is written to the audit log, and the file is kept for a short time only. */
function Downloads() {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const downloads = usePagedList('lead-downloads', api.leadDownloads.list);
  const [format, setFormat] = useState('xlsx');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  async function make() {
    setBusy(true);
    setProblem('');
    try {
      const made = await api.leadDownloads.create({ format });
      if (made.status === 'failed') setProblem('We couldn’t make that file. Please try again.');
      else toast('Your file is ready below.');
      await refresh();
    } catch (failure) {
      setProblem(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Download your leads">
      <p className="muted">A file of every lead with what they agreed to and when. Each download is recorded in your audit log.</p>
      <div className="inline-field">
        <FieldGroup>
          <SelectField label="File type" value={format} onChange={(event) => setFormat(event.target.value)}>
            {FORMAT_CHOICES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </SelectField>
        </FieldGroup>
        <Button variant="soft" loading={busy} onClick={make}><Download size={16} strokeWidth={2} aria-hidden="true" />Make file</Button>
      </div>
      {problem && <Banner tone="bad">{problem}</Banner>}
      <Screen query={downloads} label="Loading your files" errorTitle="We couldn’t load your files">
        {() => (downloads.items.length ? (
          <>
            <ul className="p3-items" aria-label="Files">
              {downloads.items.map((download) => {
                const view = downloadView(download);
                return (
                  <li key={download.id} className="p3-item">
                    <div className="p3-item-head">
                      <span className="list-row-title">{view.title}</span>
                      <Badge tone={view.tone}>{view.text}</Badge>
                    </div>
                    <span className="list-row-meta">{view.meta}</span>
                    {view.href && <div className="row-actions"><Button as="a" variant="soft" href={view.href} download>Download</Button></div>}
                  </li>
                );
              })}
            </ul>
            <LoadMore query={downloads} />
          </>
        ) : <EmptyState title="No files yet">Make a file to keep your leads in a spreadsheet.</EmptyState>)}
      </Screen>
    </Panel>
  );
}

export default function LeadsPage() {
  const allowed = useAllowed();
  const canManage = allowed(MANAGERS);
  return (
    <>
      <PageHeader title="Leads" />
      {canManage && <AreaTabs label="Leads pages" tabs={LEAD_TABS} current="/leads" />}
      <p className="lead">People who left their details on your pages. Contact them only in the ways they agreed to.</p>
      <LeadList canDelete={canManage} />
      {canManage && <Downloads />}
    </>
  );
}
