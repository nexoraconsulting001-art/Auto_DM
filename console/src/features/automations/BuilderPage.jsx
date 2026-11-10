import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Check, Circle, X } from 'lucide-react';
import { MANAGERS } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { BackLink, Badge, Banner, Button, FieldGroup, Loadable, PageHeader, Panel, SelectField, TextField, Toggle } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { describeFailure, useForm } from '../../lib/forms.js';
import { useAllowed, useRefresh } from '../../lib/query.js';
import { useSession } from '../../lib/session.jsx';
import { STATES, STATE_ACTIONS, STATE_DONE, TRACKING, TRIGGERS, addKeywords, automationToForm, changeTrigger, draftWarnings, formToAutomation, launchChecks, newForm, publicReplyProblem, stateMoves, triggerOf } from './form.js';
import { LinkPanel, LinkStatus } from './LinkPanel.jsx';
import { MediaPicker } from './MediaPicker.jsx';
import { DmPreview, FollowupFields, MessagePanel, useActiveVariant } from './MessagePanel.jsx';
import { StatsPanel, TestersPanel } from './TestingPanels.jsx';
import './automations.css';

const NEW = 'new';
const FREE_PLAN = 'free';
const GOES_OUT = new Set(['test', 'live']);

function Step({ number, title, sub, children }) {
  return (
    <section className="card" aria-labelledby={`step-${number}`}>
      <div className="step-head">
        <span className="step-number" aria-hidden="true">{number}</span>
        <div className="step-titles">
          <h2 id={`step-${number}`}>{title}</h2>
          <span className="step-sub">{sub}</span>
        </div>
      </div>
      {children}
    </section>
  );
}

function Keywords({ form }) {
  const { keywords, keywordDraft } = form.values;
  const commit = () => {
    form.set('keywords', addKeywords(keywords, keywordDraft));
    form.set('keywordDraft', '');
  };
  return (
    <div className="stack">
      {keywords.length > 0 && (
        <div className="keyword-list">
          {keywords.map((word) => (
            <span key={word} className="keyword">
              {word}
              <button type="button" className="keyword-remove" aria-label={`Remove keyword ${word}`} onClick={() => form.set('keywords', keywords.filter((other) => other !== word))}><X size={14} aria-hidden="true" /></button>
            </span>
          ))}
        </div>
      )}
      <FieldGroup>
        <TextField
          label="Add a keyword"
          placeholder="LINK, SHOP"
          maxLength={60}
          value={keywordDraft}
          error={form.errors.keywords}
          onChange={(event) => form.set('keywordDraft', event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault();
              commit();
            }
          }}
        />
      </FieldGroup>
    </div>
  );
}

function Matching({ form }) {
  const { triggerType, matchMode } = form.values;
  const trigger = triggerOf(triggerType);
  const everyLabel = triggerType === 'comment' ? 'Reply to every comment' : 'Reply to every message';
  return (
    <>
      {matchMode === 'keywords' && <Keywords form={form} />}
      <Toggle label={everyLabel} checked={matchMode === 'any'} onChange={(event) => form.set('matchMode', event.target.checked ? 'any' : 'keywords')} />
      {matchMode === 'any' && triggerType === 'comment' && (
        <>
          <Toggle label="I understand this can look like spam" {...form.toggle('anyModeAcknowledged')} />
          {form.errors.anyModeAcknowledged && <span className="field-error">{form.errors.anyModeAcknowledged}</span>}
        </>
      )}
      {trigger.value === 'story_reply' && <Toggle label="Include emoji reactions" {...form.toggle('includeReactions')} />}
      {trigger.value === 'dm_keyword' && (
        <FieldGroup>
          <TextField label="Priority" inputMode="numeric" hint="When two match, the higher number answers." {...form.field('priority')} />
        </FieldGroup>
      )}
    </>
  );
}

function PublicReplies({ form, replyCount }) {
  const allowed = useAllowed();
  const problem = form.errors.publicReplyEnabled || publicReplyProblem(form.values, replyCount);
  return (
    <>
      <Toggle label="Public replies" {...form.toggle('publicReplyEnabled')} />
      <p className="field-hint">Off by default. Replying in public is the most common reason accounts get flagged.</p>
      {problem && <span className="field-error">{problem}</span>}
      {problem && allowed(MANAGERS) && <Link className="panel-link" to="/brand-kit">Write them in your brand kit</Link>}
    </>
  );
}

function Schedule({ form }) {
  return (
    <Panel title="Schedule">
      <p className="muted">Optional. Times are India time.</p>
      <FieldGroup>
        <TextField label="Starts" type="datetime-local" {...form.field('startsAt')} />
        <TextField label="Ends" type="datetime-local" {...form.field('endsAt')} />
      </FieldGroup>
      <div className="schedule-pair">
        <FieldGroup><TextField label="Daily from" type="time" {...form.field('dailyStart')} /></FieldGroup>
        <FieldGroup><TextField label="Daily until" type="time" {...form.field('dailyEnd')} /></FieldGroup>
      </div>
      <FieldGroup>
        <SelectField label="Outside those hours" {...form.field('outsideHours')}>
          <option value="hold">Hold it and send when open</option>
          <option value="skip">Skip it</option>
        </SelectField>
      </FieldGroup>
      {form.errors.schedule && <span className="field-error">{form.errors.schedule}</span>}
    </Panel>
  );
}

function Checks({ checks }) {
  const passed = checks.filter((check) => check.ok).length;
  return (
    <Panel title="Before you launch" action={<Badge tone={passed === checks.length ? 'good' : 'warn'}>{passed} of {checks.length}</Badge>}>
      <ul className="check-list">
        {checks.map((check) => (
          <li key={check.label} className={`check${check.ok ? ' check-ok' : ''}`}>
            {check.ok ? <Check size={16} strokeWidth={2.4} aria-hidden="true" /> : <Circle size={16} strokeWidth={1.8} aria-hidden="true" />}
            <span>{check.label}<span className="sr-only">{check.ok ? ': done' : ': not yet'}</span></span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** Saves the per-reel ids next to the automation. Each one answers with its own warnings, such as two reels sharing an id (PRD 6.6). */
async function saveTracking(values, rows) {
  if (values.media.length !== 1) return [];
  const mediaId = values.media[0].id;
  const wanted = [[TRACKING[values.linkType]?.kind, values.trackingId], ['discount_code', values.discountCode]].filter(([kind]) => kind);
  const warnings = [];
  for (const [kind, typed] of wanted) {
    const value = typed.trim();
    const row = rows.find((candidate) => candidate.kind === kind);
    if (value) {
      const saved = row ? await api.measurementIds.update(row.id, { value }) : await api.measurementIds.create({ mediaId, kind, value });
      warnings.push(...saved.warnings);
    } else if (row) {
      await api.measurementIds.remove(row.id);
    }
  }
  return warnings;
}

function Editor({ automation }) {
  const navigate = useNavigate();
  const { state: landed } = useLocation();
  const { session } = useSession();
  const { toast, confirm } = useFeedback();
  const allowed = useAllowed();
  const refresh = useRefresh();
  const measurementRows = useRef([]);
  const form = useForm(automation ? automationToForm(automation) : newForm());
  const [problem, setProblem] = useState(landed?.problem ?? '');
  const [saveWarnings, setSaveWarnings] = useState(landed?.warnings ?? []);
  const [moving, setMoving] = useState(false);
  const message = useActiveVariant(form);

  // The brand kit is the owner's and managers', and the server checks the replies for everyone else.
  const kit = useQuery({ queryKey: ['brand-kit'], queryFn: () => api.brandKit.get(), enabled: allowed(MANAGERS), retry: false });
  const replyCount = kit.data ? kit.data.publicReplyVariants.length : null;

  const { values } = form;
  const trigger = triggerOf(values.triggerType);
  const state = automation?.state ?? 'draft';
  const warnings = draftWarnings(values);
  const canOneTap = session.business.plan !== FREE_PLAN;

  // What arrived from the save on the page before has been read. A reload shouldn't show it again.
  useEffect(() => {
    if (landed) navigate('.', { replace: true, state: null });
  }, [landed, navigate]);

  // One tap can't stay selected on a plan without it, for example after a downgrade.
  const stuckOnOneTap = !canOneTap && values.linkMode === 'one_tap';
  useEffect(() => {
    if (stuckOnOneTap) form.set('linkMode', 'two_tap');
  }, [stuckOnOneTap, form.set]);

  /** Saves the form. Null when it couldn't, with the reasons already on the screen. */
  async function persist() {
    const { body, errors } = formToAutomation(values, { replyCount });
    if (errors) {
      form.reject(errors);
      return null;
    }
    form.set('keywords', body.keywords);
    form.set('keywordDraft', '');
    setProblem('');
    let saved = null;
    let refused = null;
    await form.run(async () => {
      try {
        saved = automation ? await api.automations.update(automation.id, body) : await api.automations.create(body);
      } catch (error) {
        if (Object.keys(error.fields ?? {}).length === 0) throw error;
        refused = describeFailure(error).fields;
      }
    });
    if (refused) form.reject(refused);
    return saved;
  }

  /** The automation is safe by now, so a tracking id that can't be saved is reported without undoing anything. */
  async function persistTracking() {
    try {
      return { warnings: await saveTracking(values, measurementRows.current), problem: '' };
    } catch (error) {
      return { warnings: [], problem: `Saved, but the tracking ID wasn’t: ${error.message}` };
    }
  }

  async function moveTo(id, next) {
    try {
      await api.automations.setState(id, { state: next });
      toast(STATE_DONE[next]);
      return '';
    } catch (error) {
      return error.message;
    }
  }

  async function submit(next) {
    if (next === 'live') {
      const yes = await confirm({ title: 'Go live?', text: 'Real followers will start getting this DM.', confirm: 'Go live', cancel: 'Not yet', tone: 'primary' });
      if (!yes) return;
    }
    setMoving(true);
    try {
      const saved = await persist();
      if (!saved) return;
      const tracking = await persistTracking();
      const moved = next ? await moveTo(saved.id, next) : '';
      if (!next) toast('Saved.');
      const failure = moved || tracking.problem;
      await refresh();
      if (automation) {
        setProblem(failure);
        setSaveWarnings(tracking.warnings);
      } else {
        // A new page for the saved automation, so a second Save can't create a second one.
        navigate(`/automations/${saved.id}`, { replace: true, state: { problem: failure, warnings: tracking.warnings } });
      }
    } finally {
      setMoving(false);
    }
  }

  async function move(next) {
    if (GOES_OUT.has(next)) {
      await submit(next);
      return;
    }
    setMoving(true);
    const failure = await moveTo(automation.id, next);
    setProblem(failure);
    await refresh();
    setMoving(false);
  }

  async function remove() {
    const yes = await confirm({ title: 'Delete this automation?', text: 'It stops at once and waiting messages are cancelled. This can’t be undone.', confirm: 'Delete' });
    if (!yes) return;
    setMoving(true);
    try {
      await api.automations.remove(automation.id);
      toast('Automation deleted.');
      await refresh({ leaving: true });
      navigate('/automations', { replace: true });
    } catch (error) {
      setProblem(error.message);
    } finally {
      setMoving(false);
    }
  }

  function onSubmit(event) {
    event.preventDefault();
    submit(null);
  }

  const banner = problem || form.message;
  const rememberRows = useCallback((rows) => { measurementRows.current = rows; }, []);
  const moves = automation ? stateMoves(state) : ['test', 'live'];
  const primaryMoves = moves.filter((next) => next !== 'archived');
  const busy = form.busy || moving;
  const shownWarnings = [...warnings, ...saveWarnings.filter((warning) => !warnings.some((other) => other.code === warning.code))];

  return (
    <>
      <BackLink to="/automations">DM automations</BackLink>
      <PageHeader title={automation ? 'Edit automation' : 'New automation'} actions={<Badge tone={STATES[state].tone}>{STATES[state].label}</Badge>} />
      <form className="stack" onSubmit={onSubmit} noValidate>
        <FieldGroup>
          <TextField label="Name" maxLength={120} placeholder="Diwali spice box" hint="Only you see this." {...form.field('name')} />
        </FieldGroup>

        {trigger.usesMedia && !values.anyStory && <MediaPicker form={form} automationId={automation?.id ?? null} />}

        <Step number={1} title="When someone…" sub="Choose where to listen">
          <FieldGroup>
            <SelectField
              label="Start this on"
              {...form.field('triggerType')}
              onChange={(event) => Object.entries(changeTrigger(values, event.target.value)).forEach(([name, value]) => form.set(name, value))}
            >
              {TRIGGERS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
            </SelectField>
          </FieldGroup>
          {values.triggerType === 'story_reply' && <Toggle label="Any story, not just one" {...form.toggle('anyStory')} />}
        </Step>

        {trigger.keywords !== 'none' && (
          <Step number={2} title="…says" sub="Whole words, any case">
            <Matching form={form} />
          </Step>
        )}

        <Step number={trigger.keywords === 'none' ? 2 : 3} title="Reply with" sub="Variants rotate so every DM reads fresh">
          <MessagePanel form={form} message={message} />
          <LinkPanel form={form} canOneTap={canOneTap} saved={automation} onMeasurementRows={rememberRows} />
          {automation && <LinkStatus status={automation.linkStatus} />}
        </Step>

        <DmPreview form={form} message={message} />

        <Panel title="Extras">
          {trigger.value === 'comment' && <PublicReplies form={form} replyCount={replyCount} />}
          <Toggle label="Send a follow-up" {...form.toggle('followupEnabled')} />
          {values.followupEnabled && <FollowupFields form={form} />}
          <Toggle label="Dry run for this automation" {...form.toggle('dryRun')} />
          <p className="field-hint">Every rule runs and is logged, and nothing is sent.</p>
        </Panel>

        <Schedule form={form} />
        <Checks checks={launchChecks(values, { replyCount })} />

        {shownWarnings.length > 0 && (
          <div className="warning-list">
            {shownWarnings.map((warning) => <Banner key={warning.code} tone="warn">{warning.message}</Banner>)}
          </div>
        )}
        {banner && <Banner tone="bad">{banner}</Banner>}

        <div className="form-actions">
          <Button type="submit" size="large" block variant={automation ? 'primary' : 'soft'} loading={busy}>Save</Button>
          {primaryMoves.map((next) => (
            <Button key={next} size="large" block variant={next === 'live' ? 'primary' : 'outline'} loading={busy} onClick={() => move(next)}>{STATE_ACTIONS[next]}</Button>
          ))}
        </div>
      </form>

      {automation && <TestersPanel automation={automation} />}
      {automation && <StatsPanel automation={automation} />}
      {automation && (
        <div className="danger-row">
          {moves.includes('archived') && <Button variant="outline" loading={busy} onClick={() => move('archived')}>{STATE_ACTIONS.archived}</Button>}
          <Button variant="danger" loading={busy} onClick={remove}>Delete</Button>
        </div>
      )}
    </>
  );
}

export default function BuilderPage() {
  const { id } = useParams();
  const isNew = id === NEW;
  const automation = useQuery({ queryKey: ['automations', id], queryFn: () => api.automations.get(id), enabled: !isNew });
  if (isNew) return <Editor key={NEW} automation={null} />;
  return (
    <Loadable query={automation} detail label="Loading this automation" errorTitle="We couldn’t load this automation">
      {(found) => <Editor key={found.id} automation={found} />}
    </Loadable>
  );
}
