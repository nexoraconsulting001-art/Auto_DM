import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useFeedback } from '../../components/feedback.jsx';
import { SingleImage } from '../../components/images.jsx';
import { BackLink, Banner, Button, EmptyState, FieldGroup, ListRow, Loadable, PageHeader, Panel, Spinner, TextAreaField, TextField, Thumb, Toggle } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useForm } from '../../lib/forms.js';
import { fetchAll, useRefresh } from '../../lib/query.js';
import { EMPTY_CATEGORY, categoryToForm, formToCategory, nextPosition } from './form.js';

function ProductsInCategory({ category }) {
  const products = useQuery({ queryKey: ['products', 'in-category', category.id], queryFn: () => api.products.list({ category: category.id, limit: 30 }) });
  return (
    <Panel title="Products in this category" action={<Link className="panel-link" to={`/products?category=${category.id}`}>Manage</Link>}>
      <Loadable query={products} label="Loading its products" errorTitle="We couldn’t load its products">
        {({ items }) => (items.length ? (
          <div className="row-list">
            {items.map((product) => <ListRow key={product.id} as={Link} to={`/products/${product.id}`} leading={<Thumb src={product.images[0]} />} title={product.name} />)}
          </div>
        ) : <EmptyState title="No products yet">Pick this category on a product’s page to add it here.</EmptyState>)}
      </Loadable>
    </Panel>
  );
}

function CategoryEditor({ category, position }) {
  const navigate = useNavigate();
  const { toast, confirm } = useFeedback();
  const refresh = useRefresh();
  const form = useForm(category ? categoryToForm(category) : { ...EMPTY_CATEGORY, position: String(position ?? '') });

  async function save(event) {
    event.preventDefault();
    const { body, errors } = formToCategory(form.values);
    if (errors) return form.reject(errors);
    return form.run(async () => {
      const saved = category ? await api.categories.update(category.id, body) : await api.categories.create(body);
      toast('Category saved.');
      await refresh();
      if (!category) navigate(`/categories/${saved.id}`, { replace: true });
    });
  }

  async function remove() {
    const yes = await confirm({ title: `Delete ${category.name}?`, text: 'Its products stay in your catalog.', confirm: 'Delete category' });
    if (!yes) return;
    await form.run(async () => {
      await api.categories.remove(category.id);
      toast('Category deleted.');
      await refresh({ leaving: true });
      navigate('/categories', { replace: true });
    });
  }

  return (
    <>
      <BackLink to="/categories">Categories</BackLink>
      <PageHeader title={category ? category.name : 'Add category'} actions={category?.visible ? <Button as="a" variant="outline" href={`/c/${category.slug}`}>View in store</Button> : undefined} />
      <form className="stack" onSubmit={save} noValidate>
        <Panel title="Details">
          <FieldGroup>
            <TextField label="Name" maxLength={60} required {...form.field('name')} />
            <TextAreaField label="Short description" rows={2} maxLength={400} hint="Optional, shown at the top of the category page" {...form.field('description')} />
            <TextField label="Link name" maxLength={60} hint="/c/…, made from the name if empty" {...form.field('slug')} />
            <TextField label="Order" inputMode="numeric" hint="Lower numbers show first" {...form.field('position')} />
          </FieldGroup>
          <SingleImage label="Image" value={form.values.imageUrl} onChange={(url) => form.set('imageUrl', url)} error={form.errors.imageUrl} />
          <Toggle label="Show in the store" {...form.toggle('visible')} />
        </Panel>
        {form.message && <Banner tone="bad">{form.message}</Banner>}
        <div className="form-actions">
          <Button type="submit" size="large" block loading={form.busy}>{category ? 'Save category' : 'Add category'}</Button>
          <Button as={Link} variant="outline" size="large" block to="/categories">Cancel</Button>
        </div>
      </form>
      {category && <ProductsInCategory category={category} />}
      {category && <Button variant="danger" onClick={remove}>Delete category</Button>}
    </>
  );
}

function NewCategory() {
  const all = useQuery({ queryKey: ['categories', 'all'], queryFn: () => fetchAll(api.categories.list) });
  // The position is only a starting value, so a failed list still lets the seller add a category.
  if (all.isPending) return <Spinner label="Getting the form ready" />;
  return <CategoryEditor position={all.isError ? '' : nextPosition(all.data)} />;
}

export default function CategoryFormPage() {
  const { id } = useParams();
  const category = useQuery({ queryKey: ['categories', id], queryFn: () => api.categories.get(id), enabled: id !== undefined });
  if (id === undefined) return <NewCategory />;
  return (
    <Loadable query={category} detail label="Loading this category" errorTitle="We couldn’t load this category">
      {(data) => <CategoryEditor key={data.id} category={data} />}
    </Loadable>
  );
}
