import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Check } from 'lucide-react';
import { useFeedback } from '../../components/feedback.jsx';
import { SingleImage } from '../../components/images.jsx';
import { Badge, Banner, Button, EmptyState, FieldGroup, LoadMore, PageHeader, Panel, TextField, Toggle } from '../../design/index.jsx';
import { SESSION_KEY, api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { useForm } from '../../lib/forms.js';
import { usePagedList, useRefresh } from '../../lib/query.js';
import { THEME_TEXT } from '../catalog/shared/limits.js';
import { Screen, WordList } from '../catalog/shared/ui.jsx';
import { LookMini, LookPreview } from './LookPreview.jsx';
import { accentNote, siteBody, siteReadView, textBody, themeToText } from './form.js';

/** The looks, as a list of radio cards: a miniature, the name, what it is made for, its colours and its heading font. */
function LookPicker({ presets, picked, current, onPick }) {
  return (
    <div className="p3-looks" role="radiogroup" aria-label="Pick a look">
      {presets.map((look) => {
        const on = look.code === picked;
        return (
          <button key={look.code} type="button" role="radio" aria-checked={on} className="p3-look" onClick={() => onPick(look.code)}>
            <LookMini look={look} />
            <span className="p3-look-text">
              <span className="p3-look-name">{look.name}</span>
              {look.madeFor && <span className="p3-look-for">{look.madeFor}</span>}
              <span className="p3-look-swatches" aria-hidden="true">
                {['primary', 'accent', 'ground'].map((key) => <span key={key} className="p3-look-swatch" style={{ background: look.colors[key] }} />)}
              </span>
              <span className="p3-look-for">Headings in {look.headingFont}</span>
              {look.code === current && <span><Badge tone="good">Your look now</Badge></span>}
            </span>
            {on && <span className="look-tick" aria-hidden="true"><Check size={14} strokeWidth={2.4} /></span>}
          </button>
        );
      })}
    </div>
  );
}

/** Pick a look, see it, use it (F-102). Only the look changes: products, pages, links and orders stay exactly as they are (F-103). */
function ChooseLook({ theme, presets }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const [picked, setPicked] = useState(theme.preset);
  const [tuneAccent, setTuneAccent] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const look = presets.find((preset) => preset.code === picked);
  // The look in use shows as it really is, with the seller's own colours; another shows as the preset comes.
  const shown = look && picked !== theme.preset ? look : { ...theme, name: theme.presetName };
  const own = picked === theme.preset ? { sealText: theme.sealText, tickerItems: theme.tickerItems } : {};

  async function use() {
    setBusy(true);
    setProblem('');
    try {
      await api.themes.choose({ preset: picked, tuneAccent });
      toast(`Your shop now wears ${look?.name ?? 'this look'}.`);
      await refresh();
    } catch (failure) {
      setProblem(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Panel title="Pick a look made for what you sell">
        <p className="muted">Your logo, products and reels slot right in. Switch any time; nothing else changes.</p>
        {presets.length ? <LookPicker presets={presets} picked={picked} current={theme.preset} onPick={setPicked} />
          : <EmptyState title="No looks to pick from yet">Your shop keeps the look it has. New looks appear here as soon as they are ready.</EmptyState>}
      </Panel>
      <Panel title="How shoppers see it">
        <LookPreview look={shown} own={own} />
        <p className="field-hint">Headings in {shown.headingFont}, text in {shown.bodyFont}. {picked === theme.preset ? accentNote(theme) : ''}</p>
        {look && (
          <>
            <Toggle label="Tune the accent colour from my logo" checked={tuneAccent} onChange={(event) => setTuneAccent(event.target.checked)} />
            <p className="field-hint">With no logo we use your Instagram photo. The colour is darkened until it is easy to read.</p>
            {problem && <Banner tone="bad">{problem}</Banner>}
            <Button size="large" block loading={busy} onClick={use}>{picked === theme.preset ? `Apply ${look.name} again` : `Use ${look.name}`}</Button>
          </>
        )}
      </Panel>
    </>
  );
}

/** The logo lives in the brand kit; here it is one upload, because the accent colour is tuned from it. */
function Logo({ theme }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const queries = useQueryClient();
  const [problem, setProblem] = useState('');

  async function change(logoUrl) {
    setProblem('');
    try {
      await api.brandKit.update({ logoUrl });
      toast(logoUrl ? 'Logo saved.' : 'Logo removed.');
      await refresh();
      await queries.invalidateQueries({ queryKey: SESSION_KEY }); // the logo in the workspace switcher
    } catch (failure) {
      setProblem(failure.message);
    }
  }

  return (
    <Panel title={theme.logoUrl ? 'Your logo' : 'Add your logo'} action={<Link className="panel-link" to="/brand-kit">Colours and fonts</Link>}>
      <p className="muted">We pull colours from it to tune your look. No logo? We use your Instagram photo.</p>
      <SingleImage label="Logo" value={theme.logoUrl} onChange={change} error={problem} />
    </Panel>
  );
}

/** The seller's own seal words and ticker lines (F-106). Empty keeps the look's own. */
function OwnWords({ theme }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const form = useForm(themeToText(theme));

  async function save(event) {
    event.preventDefault();
    const { body, errors } = textBody(form.values);
    if (errors) return form.reject(errors);
    return form.run(async () => {
      await api.themes.updateText(body);
      toast('Words saved.');
      await refresh();
    });
  }

  return (
    <form className="stack" onSubmit={save} noValidate>
      <Panel title="Your own words">
        <p className="muted">Each look comes with a seal and a moving strip of short lines. Write your own, or leave them empty to keep the look’s.</p>
        <FieldGroup>
          <TextField label="Seal words" maxLength={THEME_TEXT.sealText} placeholder={theme.slots.sealText} hint="Shown in the small badge on your pages." {...form.field('sealText')} />
        </FieldGroup>
        <WordList
          label="Strip lines"
          values={form.values.tickerItems}
          max={THEME_TEXT.tickerItems}
          maxLength={THEME_TEXT.tickerItem}
          placeholder={theme.slots.tickerItems[0] ?? 'Free delivery'}
          hint={`Up to ${THEME_TEXT.tickerItems} short lines. Press Enter after each.`}
          error={form.errors.tickerItems}
          onChange={(items) => form.set('tickerItems', items)}
        />
        {form.message && <Banner tone="bad">{form.message}</Banner>}
        <Button type="submit" loading={form.busy}>Save words</Button>
      </Panel>
    </form>
  );
}

function SiteReadRow({ read, onApply, busy }) {
  const view = siteReadView(read);
  return (
    <li className="p3-item">
      <div className="p3-item-head">
        <span className="list-row-title">{read.website}</span>
        <Badge tone={view.tone}>{view.applied ? 'In use' : view.badge}</Badge>
      </div>
      <span className="list-row-meta">Read {formatDateTime(read.createdAt)}{view.applied ? `, used ${formatDateTime(read.appliedAt)}` : ''}</span>
      {!view.applied && <p className="p3-item-message">{view.title}. {view.text}</p>}
      {view.usable && (
        <span className="p3-look-swatches" role="img" aria-label="The colours we read">
          {['primary', 'accent', 'ground', 'ink'].filter((key) => read.colors[key]).map((key) => <span key={key} className="p3-look-swatch" style={{ background: read.colors[key] }} />)}
        </span>
      )}
      {(read.headingFont || read.bodyFont) && <span className="field-hint">Headings in {read.headingFont || 'the look’s font'}, text in {read.bodyFont || 'the look’s font'}.</span>}
      {read.notes.map((note) => <span key={note} className="field-hint">{note}</span>)}
      {view.usable && <div className="row-actions"><Button variant="soft" loading={busy} onClick={() => onApply(read)}>{view.applied ? 'Use these again' : 'Use these colours and fonts'}</Button></div>}
    </li>
  );
}

/** Reading a look from the seller's own website (8.9): its colours, fonts and logo, kept for our team to check. */
function FromWebsite({ theme }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const [website, setWebsite] = useState(theme.website ?? '');
  const [state, setState] = useState({ busy: '', error: '', problem: '' });
  const reads = usePagedList('theme-site-reads', api.themes.siteReads);

  async function read(event) {
    event.preventDefault();
    const { body, error } = siteBody(website);
    if (error) return setState({ busy: '', error, problem: '' });
    setState({ busy: 'read', error: '', problem: '' });
    try {
      await api.themes.readSite(body);
      await refresh();
      return setState({ busy: '', error: '', problem: '' });
    } catch (failure) {
      return setState({ busy: '', error: failure.fields?.website ?? '', problem: failure.fields?.website ? '' : failure.message });
    }
  }

  async function apply(siteRead) {
    setState({ busy: `apply-${siteRead.id}`, error: '', problem: '' });
    try {
      await api.themes.applySiteRead(siteRead.id);
      toast('Your shop now wears your website’s look.');
      await refresh();
      setState({ busy: '', error: '', problem: '' });
    } catch (failure) {
      setState({ busy: '', error: '', problem: failure.message });
    }
  }

  return (
    <Panel title="Have a website? Match it">
      <p className="muted">We read your website’s colours, fonts and logo so your pages look like it. Colours that are hard to read are fixed, and we tell you which.</p>
      <form className="stack" onSubmit={read} noValidate>
        <FieldGroup>
          <TextField label="Your website" inputMode="url" placeholder="yourshop.com" value={website} error={state.error} onChange={(event) => setWebsite(event.target.value)} />
        </FieldGroup>
        <Button type="submit" variant="soft" loading={state.busy === 'read'}>{state.busy === 'read' ? 'Reading your website…' : 'Read my website'}</Button>
      </form>
      {state.problem && <Banner tone="bad">{state.problem}</Banner>}
      <Screen query={reads} label="Loading what we read before" errorTitle="We couldn’t load what we read before">
        {() => (reads.items.length ? (
          <>
            <ul className="p3-items" aria-label="Websites we read">{reads.items.map((item) => <SiteReadRow key={item.id} read={item} busy={state.busy === `apply-${item.id}`} onApply={apply} />)}</ul>
            <LoadMore query={reads} />
          </>
        ) : <EmptyState title="No website read yet">No website? No problem: the looks above need nothing from you.</EmptyState>)}
      </Screen>
    </Panel>
  );
}

function Look({ theme }) {
  const presets = useQuery({ queryKey: ['theme', 'presets'], queryFn: () => api.themes.presets().then((answer) => answer.items) });
  return (
    <>
      {theme.check && <Banner tone="info">Our team is checking the look we read from your website. Your pages work meanwhile.</Banner>}
      {theme.notes.length > 0 && (
        <Banner tone="warn">
          {theme.notes.join(' ')}
        </Banner>
      )}
      <Screen query={presets} label="Loading the looks" errorTitle="We couldn’t load the looks">
        {(items) => <ChooseLook key={theme.preset} theme={theme} presets={items} />}
      </Screen>
      <Logo theme={theme} />
      <OwnWords key={`${theme.sealText}|${theme.tickerItems.join('|')}`} theme={theme} />
      <FromWebsite theme={theme} />
    </>
  );
}

export default function ThemePage() {
  const theme = useQuery({ queryKey: ['theme'], queryFn: () => api.themes.get() });
  return (
    <>
      <PageHeader eyebrow="For your shoppers" title="Your shop’s look" />
      <p className="lead">This is how your pages look to shoppers. Your console stays the same.</p>
      <Screen query={theme} label="Loading your look" errorTitle="We couldn’t load your look">
        {(data) => <Look theme={data} />}
      </Screen>
    </>
  );
}
