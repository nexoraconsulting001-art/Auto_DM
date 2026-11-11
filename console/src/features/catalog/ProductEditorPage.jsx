import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { useFeedback } from '../../components/feedback.jsx';
import { BackLink, Banner, Button, PageHeader, Panel } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { useForm } from '../../lib/forms.js';
import { fetchAll, useRefresh } from '../../lib/query.js';
import { ProductForm } from './ProductForm.jsx';
import { EMPTY_PRODUCT, RENAME, changedFields, draftToForm, fetchNote, formToProduct, isImported, needsAttention, priceChangeNote, productToForm, sourceText } from './form.js';
import { Screen } from './shared/ui.jsx';

const EDITED_TEXT = { name: 'name', description: 'description', images: 'photos', categories: 'categories', tags: 'tags', options: 'options' };

/** Where an imported product came from, what the last check of its page found, and the two things the owner can do about it. */
function ImportedPanel({ product }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState('');

  async function run(name, action, done) {
    setBusy(name);
    setProblem('');
    try {
      await action();
      toast(done);
      await refresh();
    } catch (failure) {
      setProblem(failure.message);
    } finally {
      setBusy('');
    }
  }

  const note = fetchNote(product);
  const priceNote = priceChangeNote(product);
  const kept = product.ownerEdited.map((field) => EDITED_TEXT[field] ?? field);
  return (
    <Panel title="From your website">
      <p className="muted">
        {sourceText(product.source)}.{' '}
        {product.lastCheck ? `Last checked ${formatDateTime(product.lastCheck.at)}.` : product.fetchedAt ? `Last read ${formatDateTime(product.fetchedAt)}.` : 'Not checked yet.'}
      </p>
      {note && <Banner tone={needsAttention(product) ? 'bad' : 'warn'}>{note}</Banner>}
      {priceNote && (
        <Banner tone="warn">
          {priceNote}{' '}
          <button type="button" className="p3-link" disabled={busy !== ''} onClick={() => run('price', () => api.products.update(product.id, { pricePaise: product.pricePaise }), 'Price kept.')}>Keep this price</button>
        </Banner>
      )}
      {kept.length > 0 && <p className="field-hint">Your own {kept.join(', ')} stay as you set them when this product is imported again.</p>}
      {!product.priceManual && <p className="field-hint">The price follows your website. Type a price above to set your own; we won’t change it after that.</p>}
      {problem && <Banner tone="bad">{problem}</Banner>}
      {product.externalUrl && (
        <Button variant="soft" loading={busy === 'recheck'} onClick={() => run('recheck', () => api.products.recheck(product.id), 'We’ll check its page in a moment.')}>
          <RefreshCw size={16} strokeWidth={2} aria-hidden="true" />Check its page now
        </Button>
      )}
    </Panel>
  );
}

function ProductEditor({ product, draft, categories }) {
  const navigate = useNavigate();
  const { toast, confirm } = useFeedback();
  const refresh = useRefresh();
  const form = useForm(product ? productToForm(product) : draft ? draftToForm(draft) : { ...EMPTY_PRODUCT }, { rename: RENAME });

  async function save(event) {
    event.preventDefault();
    const { body, errors } = formToProduct(form.values);
    if (errors) return form.reject(errors);
    return form.run(async () => {
      if (product) {
        const changes = changedFields(formToProduct(productToForm(product)).body ?? {}, body);
        if (Object.keys(changes).length) await api.products.update(product.id, changes);
        toast('Saved.');
        await refresh();
        return;
      }
      const saved = await api.products.create(body);
      toast('Product added.');
      await refresh();
      navigate(`/catalog/${saved.id}`, { replace: true });
    });
  }

  async function remove() {
    const yes = await confirm({ title: `Delete ${product.name}?`, text: 'This can’t be undone. A product that has been ordered can only be archived.', confirm: 'Delete product' });
    if (!yes) return;
    await form.run(async () => {
      await api.products.remove(product.id);
      toast('Product deleted.');
      await refresh({ leaving: true });
      navigate('/catalog', { replace: true });
    });
  }

  return (
    <>
      <BackLink to="/catalog">Catalog</BackLink>
      <PageHeader title={product ? product.name : 'Add product'} actions={product?.active ? <Button as="a" variant="outline" href={`/p/${product.slug}`} target="_blank" rel="noreferrer">View in store</Button> : undefined} />
      {draft && !product && <Banner tone="info">We filled in what we could read from the page. Check each detail before you save.</Banner>}
      {product && isImported(product) && <ImportedPanel product={product} />}
      <form className="stack" onSubmit={save} noValidate>
        <ProductForm form={form} categories={categories} />
        {form.message && <Banner tone="bad">{form.message}</Banner>}
        <div className="form-actions">
          <Button type="submit" size="large" block loading={form.busy}>{product ? 'Save product' : 'Add product'}</Button>
          <Button as={Link} variant="outline" size="large" block to="/catalog">Cancel</Button>
        </div>
      </form>
      {product && <Button variant="danger" onClick={remove}>Delete product</Button>}
    </>
  );
}

export default function ProductEditorPage() {
  const { id } = useParams();
  const location = useLocation();
  const categories = useQuery({ queryKey: ['categories', 'all'], queryFn: () => fetchAll(api.categories.list) });
  const product = useQuery({ queryKey: ['products', id], queryFn: () => api.products.get(id), enabled: id !== undefined });
  // A link that couldn't be imported hands over whatever was read, so the owner starts from that and not from nothing (8.7).
  if (id === undefined) return <ProductEditor draft={location.state?.draft ?? null} categories={categories} />;
  return (
    <Screen query={product} detail label="Loading this product" errorTitle="We couldn’t load this product">
      {(data) => <ProductEditor key={`${data.id}-${data.updatedAt}`} product={data} categories={categories} />}
    </Screen>
  );
}
