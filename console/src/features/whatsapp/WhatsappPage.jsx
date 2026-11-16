import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, Banner, Button, EmptyState, LoadMore, PageHeader, Panel, SelectField, Spinner, TextAreaField, TextField, Toggle } from '../../design/index.jsx';
import { useFeedback } from '../../components/feedback.jsx';
import { api } from '../../lib/api/index.js';
import { formatDate } from '../../lib/format.js';
import { fetchAll, usePagedList, useRefresh } from '../../lib/query.js';
import { useSession } from '../../lib/session.jsx';
import { Screen } from '../catalog/shared/ui.jsx';
import { isCancelled, useFresh } from '../account/fresh.jsx';
import { UpgradePrompt } from '../billing/UpgradePrompt.jsx';
import { isPlanProblem } from '../billing/contract.js';
import '../billing/billing.css';
import { runEmbeddedSignup } from './embedded.js';
import { LIMITS, OPTIN_PURPOSES, PURPOSE_WORDS, SOURCE_WORDS, STATUS_WORDS, blankSet, checkSets, fromServer, move, toServer } from './model.js';

function Connection({ status, owner, onPlan }) {
  const fresh = useFresh();
  const { confirm, toast } = useFeedback();
  const refresh = useRefresh();
  const [busy, setBusy] = useState('');
  const word = status.status ? STATUS_WORDS[status.status] : null;

  async function connect() {
    setBusy('connect');
    try {
      const start = await fresh.run(() => api.whatsapp.connectStart());
      const done = await runEmbeddedSignup(start);
      if (!done) return;
      await fresh.run(() => api.whatsapp.connectFinish({ code: done.code, state: start.state, wabaId: done.wabaId, phoneNumberId: done.phoneNumberId }));
      toast('WhatsApp is connected.');
      await refresh();
    } catch (error) {
      if (isPlanProblem(error)) onPlan(error);
      else if (!isCancelled(error)) toast(error.message);
    } finally {
      setBusy('');
    }
  }

  async function disconnect() {
    if (!(await confirm({ title: 'Disconnect WhatsApp?', text: 'Keyword replies stop. Your opt-ins are kept.', confirm: 'Disconnect' }))) return;
    setBusy('disconnect');
    try {
      await fresh.run(() => api.whatsapp.disconnect());
      toast('WhatsApp is disconnected.');
      await refresh();
    } catch (error) {
      if (!isCancelled(error)) toast(error.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <Panel title="Your WhatsApp number">
      <div className="p7-stack">
        {status.connected ? (
          <>
            <div className="p7-row"><strong className="grow">{status.displayName || 'WhatsApp Business'}</strong>{word && <Badge tone={word.tone}>{word.label}</Badge>}</div>
            <p className="p7-meta">{status.displayNumber}{status.connectedAt ? ` · connected ${formatDate(status.connectedAt)}` : ''}</p>
            {owner && <Button variant="outline" loading={busy === 'disconnect'} onClick={disconnect}>Disconnect</Button>}
          </>
        ) : (
          <>
            <p className="p7-meta">Connect your own WhatsApp Business number through Meta’s official sign-up. Replies go out from your number and your name.</p>
            {!status.signupReady && <Banner tone="warn">WhatsApp sign-up is not switched on for Bhava yet. Ask the Bhava team.</Banner>}
            {owner ? <Button size="large" block disabled={!status.signupReady} loading={busy === 'connect'} onClick={connect}>Connect WhatsApp</Button> : <p className="p7-meta">Ask the owner to connect WhatsApp.</p>}
          </>
        )}
      </div>
    </Panel>
  );
}

function KeywordRow({ set, index, count, errors, reels, onChange, onMove, onRemove }) {
  const at = (field) => errors[`${index}.${field}`];
  return (
    <li className="p7-item" data-testid="keyword-set">
      <div className="p7-stack grow">
        <TextField label={`Keywords for set ${index + 1}`} hint="Separate with commas." value={set.keywordsText} onChange={(event) => onChange({ keywordsText: event.target.value })} error={at('keywords')} />
        <SelectField label="Answer with" value={set.target} onChange={(event) => onChange({ target: event.target.value })}>
          <option value="link">A link</option>
          <option value="reel">One of my reels</option>
        </SelectField>
        {set.target === 'link'
          ? <TextField label="Link" inputMode="url" value={set.linkUrl} onChange={(event) => onChange({ linkUrl: event.target.value })} error={at('linkUrl')} />
          : (
            <SelectField label="Reel" value={set.reelId} onChange={(event) => onChange({ reelId: event.target.value })} error={at('reelId')}>
              <option value="">Pick a reel</option>
              {reels.map((reel) => <option key={reel.id} value={reel.id}>{reel.headline || reel.slug}</option>)}
            </SelectField>
          )}
        <TextAreaField label="Message (optional)" rows={2} hint="Write {link} where the link should go." value={set.message} onChange={(event) => onChange({ message: event.target.value })} error={at('message')} />
        <Toggle label="On" checked={set.active} onChange={(event) => onChange({ active: event.target.checked })} />
        <div className="p7-row">
          <Button variant="outline" disabled={index === 0} aria-label={`Move set ${index + 1} up`} onClick={() => onMove(-1)}>Up</Button>
          <Button variant="outline" disabled={index === count - 1} aria-label={`Move set ${index + 1} down`} onClick={() => onMove(1)}>Down</Button>
          <Button variant="outline" aria-label={`Remove set ${index + 1}`} onClick={onRemove}>Remove</Button>
        </div>
      </div>
    </li>
  );
}

function KeywordsEditor({ server, onPlan }) {
  const refresh = useRefresh();
  const { toast } = useFeedback();
  const reels = useQuery({ queryKey: ['whatsapp', 'reels'], queryFn: () => fetchAll(api.reels.list) });
  const [sets, setSets] = useState(() => server.items.map(fromServer));
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const change = (index, patch) => setSets((current) => current.map((set, i) => (i === index ? { ...set, ...patch } : set)));

  async function save() {
    const found = checkSets(sets);
    setErrors(found);
    setMessage(Object.keys(found).length ? 'Please check the highlighted details.' : '');
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      const saved = await api.whatsapp.saveKeywords({ items: sets.map(toServer) });
      setSets(saved.items.map(fromServer));
      toast('Keyword replies saved.');
      await refresh();
    } catch (error) {
      if (isPlanProblem(error)) onPlan(error);
      else setMessage(error.message);
      const rows = {};
      for (const [path, text] of Object.entries(error.fields ?? {})) {
        const [, index, field] = path.match(/^items\.(\d+)\.(\w+)/) ?? [];
        if (index !== undefined) rows[`${index}.${field}`] = text;
      }
      setErrors(rows);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Keyword replies" action={<Button variant="soft" disabled={sets.length >= LIMITS.keywordSets} onClick={() => setSets((current) => [...current, blankSet()])}>Add a keyword set</Button>}>
      <p className="p7-meta">When someone sends one of these words to your WhatsApp number, they get your link. The first matching set wins, so order matters.</p>
      {message && <Banner tone="bad">{message}</Banner>}
      {sets.length === 0 && <EmptyState title="No keyword sets yet">Add a set to reply to a word such as LINK.</EmptyState>}
      {sets.length > 0 && (
        <ol className="p7-list" aria-label="Keyword sets">
          {sets.map((set, index) => (
            <KeywordRow key={set.key} set={set} index={index} count={sets.length} errors={errors} reels={reels.data ?? []} onChange={(patch) => change(index, patch)} onMove={(by) => setSets((current) => move(current, index, index + by))} onRemove={() => setSets((current) => current.filter((_, i) => i !== index))} />
          ))}
        </ol>
      )}
      <Button size="large" block loading={busy} onClick={save}>Save keyword replies</Button>
    </Panel>
  );
}

function Optins() {
  const [purpose, setPurpose] = useState('');
  const list = usePagedList('whatsapp-optins', api.whatsapp.optins, purpose ? { purpose } : {}, { retry: false });
  return (
    <Panel title="Who opted in">
      <p className="p7-meta">People who said yes to WhatsApp messages. Phone numbers are not shown here.</p>
      <SelectField label="Show" value={purpose} onChange={(event) => setPurpose(event.target.value)}>
        <option value="">All</option>
        {OPTIN_PURPOSES.map((name) => <option key={name} value={name}>{PURPOSE_WORDS[name]}</option>)}
      </SelectField>
      {list.isPending && <Spinner label="Loading opt-ins" />}
      {list.isError && <Banner tone="bad">We could not load opt-ins. {list.error.message}</Banner>}
      {!list.isPending && !list.isError && list.items.length === 0 && <EmptyState title="No opt-ins yet">They appear when buyers say yes at checkout, on a form or by a keyword.</EmptyState>}
      {list.items.length > 0 && (
        <ul className="p7-list" aria-label="Opt-ins">
          {list.items.map((item) => (
            <li key={item.id} className="p7-item" data-testid="optin">
              <span className="grow"><strong>{PURPOSE_WORDS[item.purpose] ?? item.purpose}</strong><span className="p7-meta">{SOURCE_WORDS[item.source] ?? item.source} · {formatDate(item.optedInAt)}</span></span>
              {item.withdrawnAt ? <Badge tone="warn">Withdrawn {formatDate(item.withdrawnAt)}</Badge> : <Badge tone="good">Opted in</Badge>}
            </li>
          ))}
        </ul>
      )}
      <LoadMore query={list} />
    </Panel>
  );
}

export default function WhatsappPage() {
  const { session } = useSession();
  const status = useQuery({ queryKey: ['whatsapp', 'status'], queryFn: () => api.whatsapp.status() });
  const keywords = useQuery({ queryKey: ['whatsapp', 'keywords'], queryFn: () => api.whatsapp.keywords() });
  const [plan, setPlan] = useState(null);
  return (
    <div className="p7-stack">
      <PageHeader eyebrow="Automations" title="WhatsApp" />
      <UpgradePrompt error={plan} />
      <Screen query={status} label="Loading WhatsApp" errorTitle="We couldn’t load WhatsApp">
        {(data) => <Connection status={data} owner={session.user.role === 'owner'} onPlan={setPlan} />}
      </Screen>
      <Screen query={keywords} label="Loading keyword replies" errorTitle="We couldn’t load keyword replies">
        {(data) => <KeywordsEditor key={JSON.stringify(data.items.map((item) => item.id))} server={data} onPlan={setPlan} />}
      </Screen>
      <Optins />
    </div>
  );
}
