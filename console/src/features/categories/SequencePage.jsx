import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ChevronDown, ChevronUp, Pin, Plus } from 'lucide-react';
import { useFeedback } from '../../components/feedback.jsx';
import { BackLink, Badge, Banner, Button, Chip, ChipRow, EmptyState, ErrorState, FieldGroup, IconButton, PageHeader, Panel, SelectField, Sheet, Spinner, TextField, Thumb, Toggle } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { plural } from '../../lib/format.js';
import { fetchAll, useRefresh } from '../../lib/query.js';
import { toLocalInput } from '../catalog/shared/time.js';
import { PlanState, Screen, isPlanRefusal } from '../catalog/shared/ui.jsx';
import { EMPTY_RULE, JOIN_CHOICES, MATCH_CHOICES, canMove, inShownOrder, moveReel, orderChanged, reelKind, reelNotes, reelTitle, ruleBody, ruleState, ruleText, sequenceBody, windowBody } from './sequence.js';

/** The other categories, as chips: the order of each is arranged on its own. */
function CategoryChips({ categories, current }) {
  if (!categories.data?.length) return null;
  return (
    <nav className="chip-row p3-tabs" aria-label="Category">
      {categories.data.map((category) => (
        <Link key={category.id} className="chip" to={`/categories/${category.id}/reels`} aria-current={category.id === current ? 'page' : undefined}>
          {category.name} · {category.reelCount}
        </Link>
      ))}
    </nav>
  );
}

/** When this reel shows in this category only (K-46). Both empty clears the window. */
function WindowForm({ item, busy, onSave, onClose }) {
  const [startsAt, setStartsAt] = useState(toLocalInput(item.startsAt));
  const [endsAt, setEndsAt] = useState(toLocalInput(item.endsAt));
  const [errors, setErrors] = useState({});

  function submit(event) {
    event.preventDefault();
    const { body, errors: found } = windowBody(item.pageId, startsAt, endsAt);
    if (found) return setErrors(found);
    setErrors({});
    return onSave(body);
  }

  return (
    <form className="stack" onSubmit={submit} noValidate aria-label={`When ${reelTitle(item)} shows`}>
      <FieldGroup>
        <TextField label="Show from" type="datetime-local" hint="Empty: from now" value={startsAt} error={errors.startsAt} onChange={(event) => setStartsAt(event.target.value)} />
        <TextField label="Show until" type="datetime-local" hint="Empty: no end" value={endsAt} error={errors.endsAt} onChange={(event) => setEndsAt(event.target.value)} />
      </FieldGroup>
      <div className="row-actions">
        <Button type="submit" variant="soft" loading={busy}>Save times</Button>
        <Button variant="outline" onClick={onClose}>Close</Button>
      </div>
    </form>
  );
}

function ReelRow({ item, index, items, busy, timing, onMove, onPin, onRemove, onTiming, onSaveWindow }) {
  const title = reelTitle(item);
  return (
    <li className={`rank p3-seq-row${item.pinned ? ' rank-first' : ''}`}>
      <span className="rank-number" aria-hidden="true">{item.pinned ? <Pin size={14} strokeWidth={2.4} /> : index + 1}</span>
      <div className="rank-card">
        <div className="p3-seq-main">
          <div className="p3-seq-top">
            <Thumb src={item.thumbnailUrl} tall />
            <span className="list-row-main">
              <Link className="list-row-title" to={`/pages/${item.pageId}`}>{title}</Link>
              <span className="list-row-meta">{reelKind(item)}{item.pinned ? ' · Pinned' : ''}</span>
              {reelNotes(item).map((note) => <span key={note} className="list-row-meta">{note}</span>)}
              {!item.live && <span><Badge tone="warn">Not showing</Badge></span>}
            </span>
          </div>
          <div className="p3-seq-actions">
            <Button variant="soft" disabled={busy} aria-label={`${item.pinned ? 'Unpin' : 'Pin to top:'} ${title}`} onClick={() => onPin(item)}>{item.pinned ? 'Unpin' : 'Pin to top'}</Button>
            <Button variant="soft" disabled={busy} aria-expanded={timing} aria-label={`Timing of ${title}`} onClick={() => onTiming(item)}>Timing</Button>
            <Button variant="outline" disabled={busy} aria-label={`Take out ${title}`} onClick={() => onRemove(item)}>Take out</Button>
          </div>
          {timing && <WindowForm item={item} busy={busy} onSave={onSaveWindow} onClose={() => onTiming(null)} />}
        </div>
        <span className="rank-tools">
          <IconButton label={`Move ${title} up`} disabled={busy || !canMove(items, item.pageId, -1)} onClick={() => onMove(item, -1)}><ChevronUp size={18} aria-hidden="true" /></IconButton>
          <IconButton label={`Move ${title} down`} disabled={busy || !canMove(items, item.pageId, 1)} onClick={() => onMove(item, 1)}><ChevronDown size={18} aria-hidden="true" /></IconButton>
        </span>
      </div>
    </li>
  );
}

/** Landing pages that aren't in this category yet, to add at the top or the bottom. */
function AddReel({ taken, busy, onAdd }) {
  const sheet = useRef(null);
  const [opened, setOpened] = useState(false);
  const pages = useQuery({ queryKey: ['pages', 'all'], queryFn: () => fetchAll(api.pages.list), enabled: opened });
  const open = () => {
    setOpened(true);
    sheet.current?.showModal();
  };
  const free = (pages.data ?? []).filter((page) => !taken.has(page.id));
  const add = async (page, at) => {
    sheet.current?.close();
    await onAdd(page.id, at);
  };
  return (
    <>
      <Button variant="soft" block disabled={busy} onClick={open}><Plus size={16} strokeWidth={2} aria-hidden="true" />Add a reel or post</Button>
      <Sheet ref={sheet} title="Add to this category">
        {opened && pages.isPending && <Spinner label="Loading your pages" />}
        {pages.isError && <ErrorState title="We couldn’t load your pages" error={pages.error} onRetry={() => pages.refetch()} />}
        {pages.data && free.length === 0 && (
          <EmptyState title={pages.data.length ? 'Every page is already here' : 'No landing pages yet'} action={<Button as={Link} variant="soft" to="/pages/new">Make a page</Button>}>
            A reel or post joins a category once it has a landing page.
          </EmptyState>
        )}
        {free.length > 0 && (
          <ul className="catalog">
            {free.map((page) => {
              const title = page.headline || `/r/${page.slug}`;
              return (
                <li key={page.id} className="catalog-row">
                  <Thumb src={page.thumbnailUrl} />
                  <span className="list-row-main">
                    <span className="list-row-title">{title}</span>
                    <span className="list-row-meta">{page.active ? 'Live' : 'Off'}</span>
                  </span>
                  <Button variant="soft" aria-label={`Add ${title} at the top`} onClick={() => add(page, 'top')}>Top</Button>
                  <Button variant="outline" aria-label={`Add ${title} at the bottom`} onClick={() => add(page, 'bottom')}>Bottom</Button>
                </li>
              );
            })}
          </ul>
        )}
      </Sheet>
    </>
  );
}

/** The order, arranged here and saved as a whole. Everything else (pin, timing, taking out, adding) is saved as it is done. */
function Sequence({ category, sequence }) {
  const { toast, confirm } = useFeedback();
  const refresh = useRefresh();
  const saved = inShownOrder(sequence.items);
  const [arranged, setArranged] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const [timingFor, setTimingFor] = useState(null);
  const changed = orderChanged(saved, arranged);

  /** Runs one change. An order that was moved but not saved goes first, so nothing the owner arranged is lost. */
  async function run(action, done) {
    setBusy(true);
    setFailure(null);
    try {
      if (changed) await api.categories.setReels(category.id, sequenceBody(arranged));
      if (action) await action();
      toast(done);
      await refresh();
      return true;
    } catch (problem) {
      // Someone else changed this category meanwhile: say so, and show what is there now.
      if (problem.status === 409) {
        toast(problem.message);
        await refresh();
      } else setFailure(problem);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function remove(item) {
    const yes = await confirm({ title: `Take ${reelTitle(item)} out of ${category.name}?`, text: 'Its page stays. No rule will add it back to this category.', confirm: 'Take it out' });
    if (yes) await run(() => api.categories.removeReel(category.id, { pageId: item.pageId }), 'Taken out.');
  }

  async function saveWindow(body) {
    if (await run(() => api.categories.schedule(category.id, body), body.startsAt || body.endsAt ? 'Times saved.' : 'Times cleared.')) setTimingFor(null);
  }

  return (
    <Panel title={`${plural(arranged.length, 'reel')} · this order shows everywhere`}>
      {failure && (isPlanRefusal(failure) ? <PlanState error={failure} /> : <Banner tone="bad">{failure.message}</Banner>)}
      {arranged.length ? (
        <ol className="rank-list" aria-label="Reel order">
          {arranged.map((item, index) => (
            <ReelRow
              key={item.pageId}
              item={item}
              index={index}
              items={arranged}
              busy={busy}
              timing={timingFor === item.pageId}
              onMove={(reel, delta) => setArranged((current) => moveReel(current, reel.pageId, delta))}
              onPin={(reel) => run(() => (reel.pinned ? api.categories.unpin : api.categories.pin)(category.id, { pageId: reel.pageId }), reel.pinned ? 'Unpinned. It is back in its old place.' : 'Pinned to the top.')}
              onRemove={remove}
              onTiming={(reel) => setTimingFor(reel && timingFor !== reel.pageId ? reel.pageId : null)}
              onSaveWindow={saveWindow}
            />
          ))}
        </ol>
      ) : (
        <EmptyState title="No reels in this category yet">Add a reel or post below, or set a rule so new ones join by themselves.</EmptyState>
      )}
      {changed && <p className="field-hint" role="status">You moved reels. Save the order to put it in effect.</p>}
      {arranged.length > 1 && <Button size="large" block loading={busy} disabled={!changed} onClick={() => run(null, 'Order saved.')}>{changed ? 'Save order' : 'Order saved'}</Button>}
      <AddReel taken={new Set(arranged.map((item) => item.pageId))} busy={busy} onAdd={(pageId, at) => run(() => api.categories.addReel(category.id, { pageId, at }), 'Added.')} />
    </Panel>
  );
}

function RuleRow({ rule, categories, busy, onChange, onApply, onRemove }) {
  const text = ruleText(rule, categories);
  return (
    <li className="p3-rule">
      <span className="list-row-title">{text}</span>
      <span className="list-row-meta">{ruleState(rule)}</span>
      <Toggle label="Rule is on" checked={rule.active} disabled={busy} onChange={(event) => onChange(rule, { active: event.target.checked })} />
      <SelectField label="New reels join" value={rule.joinAt} disabled={busy} onChange={(event) => onChange(rule, { joinAt: event.target.value })}>
        {JOIN_CHOICES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </SelectField>
      <div className="row-actions">
        <Button variant="soft" disabled={busy} aria-label={`Apply to existing reels: ${text}`} onClick={() => onApply(rule)}>Apply to existing reels</Button>
        <Button variant="outline" disabled={busy} aria-label={`Delete the rule: ${text}`} onClick={() => onRemove(rule)}>Delete</Button>
      </div>
    </li>
  );
}

/** Rules that put new reels into this category by themselves. A reel the owner took out is never added back. */
function Rules({ category, categories }) {
  const { toast, confirm } = useFeedback();
  const refresh = useRefresh();
  const rules = useQuery({ queryKey: ['categories', category.id, 'rules'], queryFn: () => api.categories.rules(category.id).then((answer) => answer.items) });
  const [form, setForm] = useState({ ...EMPTY_RULE });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const others = (categories.data ?? []);

  async function run(action, done) {
    setBusy(true);
    setFailure(null);
    try {
      const answer = await action();
      toast(typeof done === 'function' ? done(answer) : done);
      await refresh();
      return true;
    } catch (problem) {
      setFailure(problem);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(event) {
    event.preventDefault();
    const { body, errors: found } = ruleBody(form);
    if (found) return setErrors(found);
    setErrors({});
    if (await run(() => api.categories.addRule(category.id, body), 'Rule added. It works on reels posted from now on.')) setForm({ ...EMPTY_RULE });
    return undefined;
  }

  async function remove(rule) {
    const yes = await confirm({ title: 'Delete this rule?', text: 'Reels it already added stay in the category.', confirm: 'Delete rule' });
    if (yes) await run(() => api.categoryRules.remove(rule.id), 'Rule deleted.');
  }

  return (
    <Panel title="Auto-join rules">
      <p className="muted">A rule adds each new reel that matches it to this category. Reels you took out are never added back.</p>
      <Screen query={rules} label="Loading the rules" errorTitle="We couldn’t load the rules">
        {(items) => (items.length ? (
          <ul className="p3-items" aria-label="Rules">
            {items.map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                categories={others}
                busy={busy}
                onChange={(target, change) => run(() => api.categoryRules.update(target.id, change), 'Rule saved.')}
                onApply={(target) => run(() => api.categoryRules.apply(target.id), (answer) => (answer.added ? `${plural(answer.added, 'reel')} added.` : 'No other reels match.'))}
                onRemove={remove}
              />
            ))}
          </ul>
        ) : <EmptyState title="No rules yet">Without a rule, you add each reel to this category yourself.</EmptyState>)}
      </Screen>
      {failure && (isPlanRefusal(failure) ? <PlanState error={failure} /> : <Banner tone="bad">{failure.message}</Banner>)}
      {!isPlanRefusal(rules.error) && (
      <form className="stack" onSubmit={add} noValidate aria-label="Add a rule">
        <FieldGroup>
          <SelectField label="Add new reels that have" value={form.match} onChange={(event) => setForm({ ...form, match: event.target.value })}>
            {MATCH_CHOICES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </SelectField>
          {form.match === 'product_category' ? (
            <SelectField label="Category of the product" value={form.productCategoryId} error={errors.productCategoryId} onChange={(event) => setForm({ ...form, productCategoryId: event.target.value })}>
              <option value="">Pick a category</option>
              {others.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </SelectField>
          ) : (
            <TextField label={form.match === 'hashtag' ? 'Hashtag' : 'Word'} maxLength={100} placeholder={form.match === 'hashtag' ? '#diwali' : 'diwali'} value={form.value} error={errors.value} onChange={(event) => setForm({ ...form, value: event.target.value })} />
          )}
          <SelectField label="They join" value={form.joinAt} onChange={(event) => setForm({ ...form, joinAt: event.target.value })}>
            {JOIN_CHOICES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </SelectField>
        </FieldGroup>
        <Button type="submit" variant="soft" loading={busy}>Add rule</Button>
      </form>
      )}
    </Panel>
  );
}

function Loaded({ category, categories }) {
  const sequence = useQuery({ queryKey: ['categories', category.id, 'reels'], queryFn: () => api.categories.reels(category.id) });
  return (
    <>
      <PageHeader eyebrow="Reel order" title={category.name} actions={category.visible ? <Button as="a" variant="outline" href={`/c/${category.slug}`} target="_blank" rel="noreferrer">Open store</Button> : <Badge>Hidden</Badge>} />
      <CategoryChips categories={categories} current={category.id} />
      <Screen query={sequence} label="Loading the reel order" errorTitle="We couldn’t load the reel order">
        {(data) => <Sequence key={sequence.dataUpdatedAt} category={category} sequence={data} />}
      </Screen>
      {!isPlanRefusal(sequence.error) && <Rules category={category} categories={categories} />}
    </>
  );
}

export default function SequencePage() {
  const { id } = useParams();
  const category = useQuery({ queryKey: ['categories', id], queryFn: () => api.categories.get(id) });
  const categories = useQuery({ queryKey: ['categories', 'all'], queryFn: () => fetchAll(api.categories.list) });
  return (
    <>
      <BackLink to="/categories">Categories</BackLink>
      <Screen query={category} detail label="Loading this category" errorTitle="We couldn’t load this category">
        {(data) => <Loaded key={data.id} category={data} categories={categories} />}
      </Screen>
    </>
  );
}
