import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Check } from 'lucide-react';
import { useFeedback } from '../../components/feedback.jsx';
import { BackLink, Badge, Banner, Button, Chip, ChipRow, EmptyState, LoadMore, PageHeader, Panel, Thumb } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDate } from '../../lib/format.js';
import { useForm } from '../../lib/forms.js';
import { fetchAll, usePagedList, useRefresh } from '../../lib/query.js';
import { PlanState, Screen, isPlanRefusal } from '../catalog/shared/ui.jsx';
import { PageFields } from './PageFields.jsx';
import { EMPTY_PAGE, KIND_TABS, RENAME, kindText, newPageBody } from './form.js';

/** The account's reels, posts and live stories. One that already has a page links to it and can't be picked again. */
function MediaPicker({ picked, onPick, error }) {
  const [kind, setKind] = useState('all');
  const media = usePagedList('page-media', api.pages.media, { kind });
  return (
    <Panel title="Which post is this page for?">
      <ChipRow label="Filter your posts">
        {KIND_TABS.map(([key, label]) => <Chip key={key} pressed={kind === key} onClick={() => setKind(key)}>{label}</Chip>)}
      </ChipRow>
      <Screen query={media} label="Loading your posts" errorTitle="We couldn’t load your posts">
        {() => (media.items.length ? (
          <>
            <ul className="reel-cards p3-media" aria-label="Your posts">
              {media.items.map((item) => {
                const on = picked?.mediaId === item.mediaId;
                return (
                  <li key={item.mediaId} className={`reel-card${on ? ' p3-media-on' : ''}`}>
                    <span className="reel-card-picture">
                      <Thumb src={item.thumbnailUrl} alt="" tall />
                      {on && <span className="reel-card-status"><Badge tone="neel"><Check size={12} strokeWidth={3} aria-hidden="true" />Picked</Badge></span>}
                    </span>
                    <span className="reel-card-body">
                      <span className="reel-card-title">{item.caption.slice(0, 60) || 'No caption'}</span>
                      <span className="reel-card-meta">{kindText(item)}{item.postedAt ? ` · ${formatDate(item.postedAt)}` : ''}</span>
                      {item.pageId
                        ? <Button as={Link} variant="outline" to={`/pages/${item.pageId}`}>Open its page</Button>
                        : <Button variant={on ? 'primary' : 'soft'} aria-pressed={on} aria-label={`${on ? 'Picked' : 'Pick'} ${item.caption.slice(0, 40) || `this ${item.kind}`}`} onClick={() => onPick(item)}>{on ? 'Picked' : 'Pick'}</Button>}
                    </span>
                  </li>
                );
              })}
            </ul>
            <LoadMore query={media} />
          </>
        ) : (
          <EmptyState title={kind === 'all' ? 'No posts found' : 'None of that kind'}>
            {kind === 'story' ? 'Stories show here only while they are up, for 24 hours.' : 'Post a reel or a photo on your account and it will show here.'}
          </EmptyState>
        ))}
      </Screen>
      {error && <p className="field-error" role="alert">{error}</p>}
    </Panel>
  );
}

export default function NewPagePage() {
  const navigate = useNavigate();
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const [media, setMedia] = useState(null);
  const [refusal, setRefusal] = useState(null);
  const form = useForm({ ...EMPTY_PAGE }, { rename: RENAME });
  const catalog = useQuery({ queryKey: ['products', 'all'], queryFn: () => fetchAll(api.products.list) });
  const categories = useQuery({ queryKey: ['categories', 'all'], queryFn: () => fetchAll(api.categories.list) });

  async function save(event) {
    event.preventDefault();
    setRefusal(null);
    const { body, errors } = newPageBody(media, form.values);
    if (errors) return form.reject(errors);
    return form.run(async () => {
      try {
        const page = await api.pages.create(body);
        toast('Page made.');
        await refresh();
        navigate(`/pages/${page.id}`, { replace: true });
      } catch (failure) {
        // More products than the plan shows is a plan matter (K-41): said as that, beside the form's own message.
        if (isPlanRefusal(failure)) setRefusal(failure);
        throw failure;
      }
    });
  }

  return (
    <>
      <BackLink to="/pages">Landing pages</BackLink>
      <PageHeader title="New landing page" />
      <form className="stack" onSubmit={save} noValidate>
        <MediaPicker picked={media} onPick={setMedia} error={form.errors.media} />
        <PageFields form={form} catalog={catalog} categories={categories} kind={media?.kind} />
        {refusal ? <PlanState error={refusal} /> : form.message && <Banner tone="bad">{form.message}</Banner>}
        <div className="form-actions">
          <Button type="submit" size="large" block loading={form.busy}>Make the page</Button>
          <Button as={Link} variant="outline" size="large" block to="/pages">Cancel</Button>
        </div>
      </form>
    </>
  );
}
