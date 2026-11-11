import { Link } from 'react-router-dom';
import { SingleImage } from '../../components/images.jsx';
import { Chip, ErrorState, FieldGroup, Panel, SelectField, Spinner, TextAreaField, TextField, Toggle } from '../../design/index.jsx';
import { ProductPicker } from './ProductPicker.jsx';
import { LEAD_CHOICES, limitNote, productLimit } from './form.js';

function CategoryPicker({ categories, selected, onChange }) {
  if (categories.isPending) return <Spinner label="Loading your categories" />;
  if (categories.isError) return <ErrorState title="We couldn’t load your categories" error={categories.error} onRetry={() => categories.refetch()} />;
  if (!categories.data.length) return <p className="muted">No categories yet. <Link to="/categories/new">Add a category</Link> to group your reels.</p>;
  const flip = (id) => onChange((current) => (current.includes(id) ? current.filter((other) => other !== id) : [...current, id]));
  return (
    <div className="chip-wrap" role="group" aria-label="Categories">
      {categories.data.map((category) => <Chip key={category.id} pressed={selected.includes(category.id)} onClick={() => flip(category.id)}>{category.name}</Chip>)}
    </div>
  );
}

/** The fields a landing page has, for a new page and an existing one. `kind` decides whether a story's cover is asked for. */
export function PageFields({ form, catalog, categories, kind, limit }) {
  return (
    <>
      <Panel title="Products">
        <p className="muted">{limitNote(limit)}</p>
        <ProductPicker catalog={catalog} picked={form.values.products} max={productLimit(limit)} onChange={(next) => form.set('products', next)} error={form.errors.products} />
      </Panel>

      <Panel title="Words on the page">
        <FieldGroup>
          <TextField label="Headline" maxLength={200} hint="Optional. Shown at the top of the page." {...form.field('headline')} />
          <TextAreaField label="Description" rows={2} maxLength={300} hint="Optional. Also used when the link is shared." {...form.field('description')} />
          <TextField label="Link name" maxLength={60} hint="/r/…, made for you if empty. Changing it changes the page’s address." {...form.field('slug')} />
        </FieldGroup>
      </Panel>

      <Panel title="Where it shows">
        <CategoryPicker categories={categories} selected={form.values.categoryIds} onChange={(next) => form.set('categoryIds', next)} />
        <SelectField label="Lead form" {...form.field('leadForm')}>
          {LEAD_CHOICES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </SelectField>
        <Toggle label="Page is live" {...form.toggle('active')} />
      </Panel>

      {kind === 'story' && (
        <Panel title="Cover for when the story ends">
          <p className="muted">A story disappears after 24 hours. This picture takes its place on the page; the story itself is never copied.</p>
          <SingleImage label="Cover" value={form.values.coverUrl} onChange={(url) => form.set('coverUrl', url)} error={form.errors.coverUrl} />
        </Panel>
      )}
    </>
  );
}
