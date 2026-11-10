import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { X } from 'lucide-react';
import { CopyButton } from '../../components/copy.jsx';
import { useFeedback } from '../../components/feedback.jsx';
import { Avatar, Badge, BackLink, Banner, Button, FieldGroup, Loadable, NotFoundState, PageHeader, Panel, Spinner, TextAreaField, TextField, Thumb, Toggle } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useForm } from '../../lib/forms.js';
import { isWebLink } from '../../lib/images.js';
import { fetchAll, useRefresh } from '../../lib/query.js';
import { useSession } from '../../lib/session.jsx';
import { MAX_BUTTON_TEXT, MAX_REEL_PRODUCTS, NEW_REEL, RENAME, addKeywords, formToReel, previewMessage, reelToForm } from './form.js';
import { ProductPicker } from './ProductPicker.jsx';

function KeywordInput({ form }) {
  const { keywords, keywordDraft } = form.values;
  const commit = () => {
    form.set('keywords', addKeywords(keywords, keywordDraft));
    form.set('keywordDraft', '');
  };
  return (
    <div className="stack">
      <div className="keyword-list">
        {keywords.map((word) => (
          <span key={word} className="keyword">
            {word}
            <button type="button" className="keyword-remove" aria-label={`Remove keyword ${word}`} onClick={() => form.set('keywords', keywords.filter((other) => other !== word))}><X size={14} aria-hidden="true" /></button>
          </span>
        ))}
      </div>
      <FieldGroup>
        <TextField
          label="Add a keyword"
          placeholder="LINK, SHOP"
          hint="A comment containing any of these gets the DM."
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

/** What the commenter gets. Only the seller's name appears here. */
function DmPreview({ message, button }) {
  const { session } = useSession();
  return (
    <Panel title="What they get in DMs">
      <div className="dm">
        <Avatar name={session.business.name} src={session.business.logoUrl} />
        <div className="dm-body">
          <span className="dm-name">{session.business.name}</span>
          <div className="dm-bubble">
            <p>{previewMessage(message) || 'Your message shows here.'}</p>
            <span className="dm-button">{button || 'Shop now'}</span>
          </div>
        </div>
      </div>
    </Panel>
  );
}

function ReelEditor({ id, reel, post, catalog }) {
  const navigate = useNavigate();
  const { toast, confirm } = useFeedback();
  const refresh = useRefresh();
  const form = useForm(reel ? reelToForm(reel) : { ...NEW_REEL }, { rename: RENAME });
  const media = {
    permalink: post?.permalink || reel?.permalink || '',
    thumbnailUrl: post?.thumbnailUrl || reel?.thumbnailUrl || '',
    caption: post?.caption || reel?.caption || '',
    videoUrl: reel?.videoUrl || '',
  };

  async function save(event) {
    event.preventDefault();
    const { body, errors } = formToReel(form.values, media);
    if (errors) return form.reject(errors);
    form.set('keywords', body.keywords);
    form.set('keywordDraft', '');
    return form.run(async () => {
      await api.reels.save(id, body);
      toast('Reel store saved. Comments with its keyword now get a DM with the store link.');
      await refresh();
    });
  }

  async function remove() {
    const yes = await confirm({ title: 'Remove this reel’s store?', text: 'Comments on it will stop getting DMs. Products stay in your catalog.', confirm: 'Remove reel store' });
    if (!yes) return;
    await form.run(async () => {
      await api.reels.remove(id);
      toast('Reel store removed.');
      await refresh({ leaving: true });
      navigate('/reels', { replace: true });
    });
  }

  return (
    <>
      <BackLink to="/reels">Reels</BackLink>
      <PageHeader
        title={reel ? 'Edit reel store' : 'Set up reel store'}
        actions={reel ? <span className="row-actions"><CopyButton text={reel.storeUrl} label="Copy store link" /><Button as="a" variant="outline" href={`/r/${reel.slug}?preview=1`} target="_blank" rel="noopener">Preview</Button></span> : undefined}
      />
      <div className="reel-about">
        <Thumb src={media.thumbnailUrl} tall alt="Reel thumbnail" />
        <div className="reel-about-text">
          {media.caption && <p>{media.caption.slice(0, 240)}</p>}
          {isWebLink(media.permalink) && <a href={media.permalink} target="_blank" rel="noopener">Open on Instagram</a>}
          <p className="field-hint">Post ID {id}</p>
        </div>
      </div>
      <form className="stack" onSubmit={save} noValidate>
        <Panel title="Store page">
          <FieldGroup>
            <TextField label="Headline" maxLength={200} placeholder="The Sunday brunch edit" hint="Big title on the store page" required {...form.field('headline')} />
            <TextField label="Store link name" maxLength={60} placeholder="sunday-brunch" hint="Made from the headline if empty" {...form.field('slug')} />
          </FieldGroup>
          <Toggle label="Live: sends DMs and shows the store" {...form.toggle('active')} />
        </Panel>

        <Panel title="Products" action={<Badge tone={form.values.products.length >= MAX_REEL_PRODUCTS ? 'warn' : 'neutral'}>{form.values.products.length} / {MAX_REEL_PRODUCTS}</Badge>}>
          <p className="muted">Pick 1 to {MAX_REEL_PRODUCTS}, in the order they appear in the reel.</p>
          <ProductPicker catalog={catalog} picked={form.values.products} onChange={(next) => form.set('products', next)} error={form.errors.products} />
        </Panel>

        <Panel title="When someone comments">
          <KeywordInput form={form} />
        </Panel>

        <Panel title="Reply with">
          <FieldGroup>
            <TextAreaField label="DM message" maxLength={1000} hint="{username} becomes the commenter’s name" {...form.field('dmMessage')} />
            <TextField label="Button text" maxLength={MAX_BUTTON_TEXT} hint={`Up to ${MAX_BUTTON_TEXT} characters`} {...form.field('buttonText')} />
          </FieldGroup>
          <Toggle label="Reply publicly too" {...form.toggle('publicReplyOn')} />
          <p className="field-hint">Off by default. Public replies are the most common reason accounts get flagged.</p>
          {form.values.publicReplyOn && (
            <FieldGroup>
              <TextField label="Public reply" maxLength={1000} placeholder="Sent you a DM" {...form.field('publicReply')} />
            </FieldGroup>
          )}
        </Panel>

        <DmPreview message={form.values.dmMessage} button={form.values.buttonText} />

        {form.message && <Banner tone="bad">{form.message}</Banner>}
        <div className="form-actions">
          <Button type="submit" size="large" block loading={form.busy}>{reel ? 'Save reel store' : 'Create reel store'}</Button>
          <Button as={Link} variant="outline" size="large" block to="/reels">Cancel</Button>
        </div>
      </form>
      {reel && <Button variant="danger" onClick={remove}>Remove reel store</Button>}
    </>
  );
}

export default function ReelFormPage() {
  const { id } = useParams();
  const { state } = useLocation();
  // Whether this post has a store comes from the list, so an ordinary first visit isn't a refused lookup in the logs.
  const stores = useQuery({ queryKey: ['reels', 'all'], queryFn: () => fetchAll(api.reels.list) });
  const hasStore = stores.data?.some((item) => item.id === id) ?? false;
  const reel = useQuery({ queryKey: ['reels', id], queryFn: () => api.reels.get(id), enabled: hasStore });
  const catalog = useQuery({ queryKey: ['products', 'all'], queryFn: () => fetchAll(api.products.list) });
  // The list hands over the post it came from. A reloaded page or a shared link looks it up instead.
  const needsLookup = stores.isSuccess && !hasStore && !state?.post;
  const posts = useQuery({ queryKey: ['instagram-posts', 'first'], queryFn: () => api.reels.instagramPosts({ limit: 50 }), enabled: needsLookup, retry: false });

  return (
    <Loadable query={stores} label="Loading this reel" errorTitle="We couldn’t load this reel">
      {() => {
        if (hasStore) {
          return (
            <Loadable query={reel} detail label="Loading this reel" errorTitle="We couldn’t load this reel">
              {(found) => <ReelEditor key={id} id={id} reel={found} post={state?.post} catalog={catalog} />}
            </Loadable>
          );
        }
        if (needsLookup && posts.isPending) return <Spinner label="Looking up this post" />;
        const post = state?.post ?? posts.data?.items.find((item) => item.id === id);
        if (!post) return <NotFoundState />;
        return <ReelEditor key={id} id={id} post={post} catalog={catalog} />;
      }}
    </Loadable>
  );
}
