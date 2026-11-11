import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { CopyButton } from '../../components/copy.jsx';
import { useFeedback } from '../../components/feedback.jsx';
import { SingleImage } from '../../components/images.jsx';
import { Badge, Banner, Button, EmptyState, FieldGroup, PageHeader, Panel, TextAreaField, TextField, Toggle } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { plural } from '../../lib/format.js';
import { useForm } from '../../lib/forms.js';
import { fetchAll, useRefresh } from '../../lib/query.js';
import { PlanState, Screen, isPlanRefusal } from '../catalog/shared/ui.jsx';
import { creatorState, creatorToForm, formToCreator, slugNote, slugProblem, tidySlug } from './form.js';

/** Asks the server whether a name is free, a moment after the owner stops typing. Nothing is asked for a name of the wrong shape. */
function useSlugCheck(typed, saved) {
  const [check, setCheck] = useState(null);
  const slug = tidySlug(typed);
  useEffect(() => {
    if (slug === saved || slugProblem(slug)) return undefined;
    let current = true;
    const timer = setTimeout(async () => {
      try {
        const answer = await api.creator.checkSlug({ slug });
        if (current) setCheck(answer);
      } catch {
        // The save checks again, so a check that fails here costs nothing.
      }
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [slug, saved]);
  return slug === saved ? null : check;
}

/** The link to put in the Instagram bio. The owner copies it there: we never change a bio. */
function BioLink({ page }) {
  if (!page.url) return <Banner tone="info">Choose a name below and save to get your page’s link.</Banner>;
  return (
    <Panel title="Your link for the bio">
      <p className="muted">Copy this into your Instagram bio and add it as your website. We never change your bio for you.</p>
      <div className="p3-address">
        <span className="p3-address-text">{page.url}</span>
        <CopyButton text={page.url} label="Copy link" />
        {page.enabled && <Button as="a" variant="outline" href={page.url} target="_blank" rel="noreferrer"><ExternalLink size={16} strokeWidth={1.8} aria-hidden="true" />Open</Button>}
      </div>
      {!page.enabled && <p className="field-hint">The page is off, so this link shows nothing yet. Switch it on below.</p>}
      {page.badge && <p className="field-hint">On the Free plan a small badge shows at the foot of this page. Paid plans show none.</p>}
    </Panel>
  );
}

/** The shelves come from the categories, in their order: said here, with the way to change them. */
function Shelves() {
  const categories = useQuery({ queryKey: ['categories', 'all'], queryFn: () => fetchAll(api.categories.list) });
  return (
    <Panel title="Shelves" action={<Link className="panel-link" to="/categories">Categories</Link>}>
      <p className="muted">Each category with reels is a shelf, in your category order. Reels in no category go on the last shelf.</p>
      <Screen query={categories} label="Loading your categories" errorTitle="We couldn’t load your categories">
        {(items) => {
          const shelves = items.filter((category) => category.visible);
          if (!shelves.length) return <EmptyState title="No shelves yet" action={<Button as={Link} variant="soft" to="/categories/new">Add a category</Button>}>Add a category and put reels in it to make a shelf.</EmptyState>;
          return (
            <ol className="p3-items" aria-label="Shelves in order">
              {shelves.map((category) => (
                <li key={category.id} className="p3-item">
                  <div className="p3-item-head">
                    <span className="list-row-title">{category.name}</span>
                    <span className="list-row-meta">{plural(category.reelCount ?? 0, 'reel')}</span>
                    <Link className="panel-link" to={`/categories/${category.id}/reels`} aria-label={`Reel order of ${category.name}`}>Reel order</Link>
                  </div>
                </li>
              ))}
            </ol>
          );
        }}
      </Screen>
    </Panel>
  );
}

function CreatorForm({ page }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const [refusal, setRefusal] = useState(null);
  const form = useForm(creatorToForm(page));
  const check = useSlugCheck(form.values.slug, page.slug);
  const note = slugNote(check, form.values.slug);

  async function save(event) {
    event.preventDefault();
    setRefusal(null);
    const { body, errors } = formToCreator(form.values);
    if (errors) return form.reject(errors);
    return form.run(async () => {
      try {
        await api.creator.update(body);
        toast('Creator page saved.');
        await refresh();
      } catch (failure) {
        if (isPlanRefusal(failure)) setRefusal(failure);
        throw failure;
      }
    });
  }

  return (
    <form className="stack" onSubmit={save} noValidate>
      <Panel title="Address">
        <FieldGroup>
          <TextField
            label="Page name"
            maxLength={40}
            autoCapitalize="none"
            spellCheck={false}
            placeholder="yourname"
            hint={note.hint || 'Your page is at /yourname on your web address. Lower-case letters, numbers and dashes.'}
            {...form.field('slug')}
            error={form.errors.slug || note.error}
          />
        </FieldGroup>
        {page.slug && tidySlug(form.values.slug) !== page.slug && <Banner tone="warn">Changing the name changes the link. Update your Instagram bio after you save.</Banner>}
        <Toggle label="Page is live" {...form.toggle('enabled')} />
      </Panel>

      <Panel title="At the top of the page">
        <SingleImage label="Photo" value={form.values.photoUrl} onChange={(url) => form.set('photoUrl', url)} error={form.errors.photoUrl} />
        <FieldGroup>
          <TextField label="Name shown" maxLength={80} hint="Empty uses your business’s name." {...form.field('displayName')} />
          <TextAreaField label="About" rows={3} maxLength={300} hint="Optional. A line or two about what you make or sell." {...form.field('bio')} />
          <TextField label="Your website" type="url" inputMode="url" placeholder="https://" hint="Optional. Shown as a link, opened directly." {...form.field('websiteUrl')} />
        </FieldGroup>
      </Panel>

      <Panel title="On the page">
        <FieldGroup>
          <TextField label="Name of the last shelf" maxLength={40} hint="Holds reels that are in no category." {...form.field('moreShelfTitle')} />
        </FieldGroup>
        <Toggle label="Show a WhatsApp button" {...form.toggle('showWhatsapp')} />
      </Panel>

      {refusal ? <PlanState error={refusal} /> : form.message && <Banner tone="bad">{form.message}</Banner>}
      <div className="form-actions">
        <Button type="submit" size="large" block loading={form.busy}>Save creator page</Button>
      </div>
    </form>
  );
}

function Loaded({ page }) {
  const state = creatorState(page);
  return (
    <>
      <PageHeader eyebrow="For your shoppers" title="Creator page" actions={<Badge tone={state.tone}>{state.text}</Badge>} />
      <p className="lead">One page for your bio link: your reels and posts on shelves, each opening its own page of products.</p>
      <BioLink page={page} />
      <CreatorForm key={page.updatedAt ?? 'new'} page={page} />
      <Shelves />
    </>
  );
}

export default function CreatorPage() {
  const page = useQuery({ queryKey: ['creator-page'], queryFn: () => api.creator.get() });
  return (
    <Screen query={page} label="Loading your creator page" errorTitle="We couldn’t load your creator page">
      {(data) => <Loaded page={data} />}
    </Screen>
  );
}
