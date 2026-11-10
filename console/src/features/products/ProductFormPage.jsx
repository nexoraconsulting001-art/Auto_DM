import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useFeedback } from '../../components/feedback.jsx';
import { PhotoManager } from '../../components/images.jsx';
import { BackLink, Banner, Button, Chip, ErrorState, FieldGroup, Loadable, PageHeader, Panel, Spinner, TextAreaField, TextField, Toggle } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useForm } from '../../lib/forms.js';
import { fetchAll, useRefresh } from '../../lib/query.js';
import { EMPTY_PRODUCT, MAX_PHOTOS, RENAME, formToProduct, productToForm } from './form.js';

/** Which categories the product is in. If the list can't load, the product's categories are left as they are. */
function CategoryPicker({ categories, selected, onChange }) {
  if (categories.isPending) return <Spinner label="Loading your categories" />;
  if (categories.isError) return <ErrorState title="We couldn’t load your categories" error={categories.error} onRetry={() => categories.refetch()} />;
  if (!categories.data.length) return <p className="muted">No categories yet. <Link to="/categories/new">Add a category</Link> to group products in the shop.</p>;
  const flip = (id) => onChange((current) => (current.includes(id) ? current.filter((other) => other !== id) : [...current, id]));
  return (
    <div className="chip-wrap" role="group" aria-label="Categories">
      {categories.data.map((category) => (
        <Chip key={category.id} pressed={selected.includes(category.id)} onClick={() => flip(category.id)}>
          {category.name}{category.visible ? '' : ' (hidden)'}
        </Chip>
      ))}
    </div>
  );
}

function ProductEditor({ product, categories }) {
  const navigate = useNavigate();
  const { toast, confirm } = useFeedback();
  const refresh = useRefresh();
  const form = useForm(product ? productToForm(product) : { ...EMPTY_PRODUCT }, { rename: RENAME });

  async function save(event) {
    event.preventDefault();
    const { body, errors } = formToProduct(form.values);
    if (errors) return form.reject(errors);
    return form.run(async () => {
      const saved = product ? await api.products.update(product.id, body) : await api.products.create(body);
      toast(product ? 'Saved.' : 'Product added.');
      await refresh();
      if (!product) navigate(`/products/${saved.id}`, { replace: true });
    });
  }

  async function remove() {
    const yes = await confirm({ title: `Delete ${product.name}?`, text: 'This can’t be undone.', confirm: 'Delete product' });
    if (!yes) return;
    await form.run(async () => {
      await api.products.remove(product.id);
      toast('Product deleted.');
      await refresh({ leaving: true });
      navigate('/products', { replace: true });
    });
  }

  return (
    <>
      <BackLink to="/products">Products</BackLink>
      <PageHeader title={product ? product.name : 'Add product'} actions={product?.active ? <Button as="a" variant="outline" href={`/p/${product.slug}`}>View in store</Button> : undefined} />
      <form className="stack" onSubmit={save} noValidate>
        <Panel title="Details">
          <FieldGroup>
            <TextField label="Name" maxLength={120} required {...form.field('name')} />
            <TextAreaField label="Description" rows={4} hint="Shown on the product page. Leave a blank line between paragraphs." {...form.field('description')} />
            <TextField label="Price (₹)" inputMode="decimal" placeholder="1299" required {...form.field('price')} />
            <TextField label="MRP (₹)" inputMode="decimal" placeholder="1999" hint="Optional, shown crossed out" {...form.field('mrp')} />
          </FieldGroup>
        </Panel>

        <Panel title="Photos">
          <p className="muted">Up to {MAX_PHOTOS}. The first photo is used on product cards.</p>
          <PhotoManager images={form.values.images} onChange={(next) => form.set('images', next)} max={MAX_PHOTOS} error={form.errors.images} />
        </Panel>

        <Panel title="Options and stock">
          <FieldGroup>
            <TextField label="Option name" maxLength={40} hint="For example Size or Colour" {...form.field('optionLabel')} />
            <TextField label="Choices" placeholder="S, M, L, XL" hint="Separate with commas. Leave empty if none." {...form.field('optionValues')} />
            <TextField label="Stock" inputMode="numeric" hint="Leave empty for unlimited" {...form.field('stock')} />
          </FieldGroup>
          <Toggle label="Show in stores" {...form.toggle('active')} />
        </Panel>

        <Panel title="Where it shows">
          <CategoryPicker categories={categories} selected={form.values.categoryIds} onChange={(next) => form.set('categoryIds', next)} />
          <Toggle label="Featured on the home page" {...form.toggle('featured')} />
        </Panel>

        {form.message && <Banner tone="bad">{form.message}</Banner>}
        <div className="form-actions">
          <Button type="submit" size="large" block loading={form.busy}>{product ? 'Save product' : 'Add product'}</Button>
          <Button as={Link} variant="outline" size="large" block to="/products">Cancel</Button>
        </div>
      </form>
      {product && <Button variant="danger" onClick={remove}>Delete product</Button>}
    </>
  );
}

export default function ProductFormPage() {
  const { id } = useParams();
  const categories = useQuery({ queryKey: ['categories', 'all'], queryFn: () => fetchAll(api.categories.list) });
  const product = useQuery({ queryKey: ['products', id], queryFn: () => api.products.get(id), enabled: id !== undefined });
  if (id === undefined) return <ProductEditor categories={categories} />;
  return (
    <Loadable query={product} detail label="Loading this product" errorTitle="We couldn’t load this product">
      {(data) => <ProductEditor key={data.id} product={data} categories={categories} />}
    </Loadable>
  );
}
