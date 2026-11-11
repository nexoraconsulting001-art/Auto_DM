import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { CopyButton } from '../../components/copy.jsx';
import { useFeedback } from '../../components/feedback.jsx';
import { BackLink, Badge, Banner, Button, PageHeader, Panel, Thumb } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDate } from '../../lib/format.js';
import { useForm } from '../../lib/forms.js';
import { fetchAll, useRefresh } from '../../lib/query.js';
import { PlanState, Screen, isPlanRefusal } from '../catalog/shared/ui.jsx';
import { PageFields } from './PageFields.jsx';
import { RENAME, formToPage, kindText, pageToForm, pageWarning } from './form.js';

/** The page's own address: what the automatic reply sends. It is on the seller's web address and opens with no hop (K-32). */
function PageAddress({ page }) {
  return (
    <Panel title="This page’s link">
      <p className="muted">Your automatic replies send this link. It opens the page directly, on your own web address.</p>
      <div className="p3-address">
        <span className="p3-address-text">{page.url}</span>
        <CopyButton text={page.url} label="Copy link" />
        <Button as="a" variant="outline" href={page.url} target="_blank" rel="noreferrer"><ExternalLink size={16} strokeWidth={1.8} aria-hidden="true" />Open</Button>
      </div>
    </Panel>
  );
}

function AboutPost({ page }) {
  const ended = page.kind === 'story' && page.expiresAt && Date.parse(page.expiresAt) <= Date.now();
  return (
    <Panel title="The post">
      <div className="reel-about">
        <Thumb src={page.thumbnailUrl || page.coverUrl} alt="" tall />
        <div className="reel-about-text">
          <span className="list-row-title">{kindText(page)}</span>
          <span className="list-row-meta">{page.postedAt ? `Posted ${formatDate(page.postedAt)}` : 'Posting date not known'}</span>
          {page.kind === 'story' && page.expiresAt && <span className="list-row-meta">{ended ? 'The story has ended' : `Up until ${formatDate(page.expiresAt)}`}</span>}
          {page.permalink && <a className="panel-link" href={page.permalink} target="_blank" rel="noreferrer">See it on {page.channel === 'facebook' ? 'Facebook' : 'Instagram'}</a>}
        </div>
      </div>
    </Panel>
  );
}

function PageEditor({ page, catalog, categories }) {
  const navigate = useNavigate();
  const { toast, confirm } = useFeedback();
  const refresh = useRefresh();
  const [refusal, setRefusal] = useState(null);
  const form = useForm(pageToForm(page), { rename: RENAME });
  const warning = pageWarning({ ...page, active: form.values.active, coverUrl: form.values.coverUrl, products: form.values.products });

  async function save(event) {
    event.preventDefault();
    setRefusal(null);
    const { body, errors } = formToPage(form.values, { limit: page.productLimit });
    if (errors) return form.reject(errors);
    return form.run(async () => {
      try {
        await api.pages.update(page.id, body);
        toast('Page saved.');
        await refresh();
      } catch (failure) {
        // More products than the plan shows is a plan matter (K-41): said as that, in place of the form's own message.
        if (isPlanRefusal(failure)) setRefusal(failure);
        throw failure;
      }
    });
  }

  async function remove() {
    const yes = await confirm({ title: 'Delete this page?', text: 'Its link stops working, and replies that send it will have nothing to open. This can’t be undone.', confirm: 'Delete page' });
    if (!yes) return;
    await form.run(async () => {
      await api.pages.remove(page.id);
      toast('Page deleted.');
      await refresh({ leaving: true });
      navigate('/pages', { replace: true });
    });
  }

  return (
    <>
      <BackLink to="/pages">Landing pages</BackLink>
      <PageHeader eyebrow={kindText(page)} title={page.headline || `/r/${page.slug}`} actions={page.active ? <Badge tone="good">Live</Badge> : <Badge>Off</Badge>} />
      {warning && <Banner tone="warn">{warning}</Banner>}
      <PageAddress page={page} />
      <AboutPost page={page} />
      <form className="stack" onSubmit={save} noValidate>
        <PageFields form={form} catalog={catalog} categories={categories} kind={page.kind} limit={page.productLimit} />
        {refusal ? <PlanState error={refusal} /> : form.message && <Banner tone="bad">{form.message}</Banner>}
        <div className="form-actions">
          <Button type="submit" size="large" block loading={form.busy}>Save page</Button>
          <Button as={Link} variant="outline" size="large" block to="/pages">Cancel</Button>
        </div>
      </form>
      <Button variant="danger" onClick={remove}>Delete page</Button>
    </>
  );
}

export default function PageEditorPage() {
  const { id } = useParams();
  const page = useQuery({ queryKey: ['pages', id], queryFn: () => api.pages.get(id) });
  const catalog = useQuery({ queryKey: ['products', 'all'], queryFn: () => fetchAll(api.products.list) });
  const categories = useQuery({ queryKey: ['categories', 'all'], queryFn: () => fetchAll(api.categories.list) });
  return (
    <Screen query={page} detail label="Loading this page" errorTitle="We couldn’t load this page">
      {(data) => <PageEditor key={`${data.id}-${data.updatedAt}`} page={data} catalog={catalog} categories={categories} />}
    </Screen>
  );
}
