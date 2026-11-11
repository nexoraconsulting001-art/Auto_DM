import { Link } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import { PhotoManager } from '../../components/images.jsx';
import { Button, Chip, ErrorState, FieldGroup, IconButton, Panel, SelectField, Spinner, TextAreaField, TextField, Toggle } from '../../design/index.jsx';
import { WHATSAPP_CHOICES, variantLabel, variantsFor } from './form.js';
import { CATALOG } from './shared/limits.js';
import { WordList } from './shared/ui.jsx';

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

/** What a screen reader says for each photo. Kept by photo, so it follows the photo when the order changes. */
function AltTexts({ form }) {
  const { images, alts } = form.values;
  if (!images.length) return null;
  return (
    <FieldGroup>
      {images.map((url, index) => (
        <TextField
          key={url}
          label={`Describe photo ${index + 1}`}
          hint={index === 0 ? 'Optional. Read out to shoppers who can’t see the photo.' : undefined}
          maxLength={200}
          value={alts[url] ?? ''}
          onChange={(event) => form.set('alts', (current) => ({ ...current, [url]: event.target.value }))}
        />
      ))}
    </FieldGroup>
  );
}

function Variant({ variant, index, photos, onChange, onRemove }) {
  const label = variantLabel(variant);
  const set = (key) => (event) => onChange(index, key, event.target.value);
  return (
    <fieldset className="p3-variant">
      <legend>{label}</legend>
      <FieldGroup>
        <TextField label="Price (₹)" inputMode="decimal" value={variant.price} onChange={set('price')} />
        <TextField label="MRP (₹)" inputMode="decimal" hint="Optional, shown crossed out" value={variant.mrp} onChange={set('mrp')} />
        <TextField label="SKU" maxLength={100} hint="Optional. Your own code for this variant." value={variant.sku} onChange={set('sku')} />
        {photos > 0 && (
          <SelectField label="Photo" value={variant.imageIndex ?? ''} onChange={(event) => onChange(index, 'imageIndex', event.target.value === '' ? null : Number(event.target.value))}>
            <option value="">The product’s cover photo</option>
            {Array.from({ length: photos }, (_, i) => <option key={i} value={i}>Photo {i + 1}</option>)}
          </SelectField>
        )}
      </FieldGroup>
      <div className="p3-variant-foot">
        <Toggle label="In stock" checked={variant.inStock} onChange={(event) => onChange(index, 'inStock', event.target.checked)} />
        <IconButton label={`Remove ${label}`} onClick={() => onRemove(index)}><Trash2 size={16} aria-hidden="true" /></IconButton>
      </div>
    </fieldset>
  );
}

/** Up to three options, such as Size and Colour, and one variant for each combination with its own price, SKU and stock. */
function OptionsEditor({ form }) {
  const { options, variants, price, mrp, images } = form.values;

  function setOptions(next) {
    form.set('options', next);
    form.set('variants', (current) => variantsFor(next, current, { price, mrp }));
  }
  const setOption = (index, change) => setOptions(options.map((option, i) => (i === index ? { ...option, ...change } : option)));
  const setVariant = (index, key, value) => form.set('variants', (current) => current.map((variant, i) => (i === index ? { ...variant, [key]: value } : variant)));

  return (
    <Panel title="Options and variants">
      <p className="muted">For a product that comes in sizes or colours. Each combination gets its own price, SKU and stock.</p>
      {options.map((option, index) => (
        <div key={index} className="p3-option">
          <div className="inline-field">
            <FieldGroup>
              <TextField label={`Option ${index + 1}`} maxLength={40} placeholder="Size" value={option.name} onChange={(event) => setOption(index, { name: event.target.value })} />
            </FieldGroup>
            <IconButton label={`Remove option ${index + 1}`} onClick={() => setOptions(options.filter((_, i) => i !== index))}><Trash2 size={16} aria-hidden="true" /></IconButton>
          </div>
          <WordList
            label={`Values of ${option.name.trim() || `option ${index + 1}`}`}
            values={option.values}
            max={CATALOG.optionValues}
            placeholder="S, M, L"
            hint="Type a value and press Enter, or separate several with commas."
            onChange={(values) => setOption(index, { values })}
          />
        </div>
      ))}
      {form.errors.options && <p className="field-error" role="alert">{form.errors.options}</p>}
      {options.length < CATALOG.options && (
        <Button variant="soft" onClick={() => setOptions([...options, { name: '', values: [] }])}><Plus size={16} strokeWidth={2} aria-hidden="true" />Add an option</Button>
      )}
      {variants.length > 0 && (
        <div className="stack" role="group" aria-label="Variants">
          {variants.map((variant, index) => (
            <Variant key={variantLabel(variant)} variant={variant} index={index} photos={images.length} onChange={setVariant} onRemove={(at) => form.set('variants', (current) => current.filter((_, i) => i !== at))} />
          ))}
        </div>
      )}
      {form.errors.variants && <p className="field-error" role="alert">{form.errors.variants}</p>}
      {options.length === 0 && (
        <FieldGroup>
          <TextField label="SKU" maxLength={100} hint="Optional. Your own code for this product." {...form.field('sku')} />
        </FieldGroup>
      )}
    </Panel>
  );
}

/**
 * Every field of a product, for the editor and for checking an imported draft before it is saved. `form` is a useForm of the
 * values in form.js; `categories` is the query of every category.
 */
export function ProductForm({ form, categories }) {
  return (
    <>
      <Panel title="Details">
        <FieldGroup>
          <TextField label="Name" maxLength={CATALOG.nameLength} required {...form.field('name')} />
          <TextAreaField label="Description" rows={4} maxLength={CATALOG.descriptionLength} hint="Shown on the product page. Leave a blank line between paragraphs." {...form.field('description')} />
          <TextField label="Price (₹)" inputMode="decimal" placeholder="1299" required {...form.field('price')} />
          <TextField label="MRP (₹)" inputMode="decimal" placeholder="1999" hint="Optional, shown crossed out. It can’t be lower than the price." {...form.field('mrp')} />
        </FieldGroup>
      </Panel>

      <Panel title="Where shoppers buy it">
        <FieldGroup>
          <TextField label="Product link on your website" type="url" inputMode="url" placeholder="https://" hint="Optional. Buttons on your pages open this address directly." {...form.field('externalUrl')} />
        </FieldGroup>
        <SelectField label="Order on WhatsApp button" {...form.field('whatsappOrder')}>
          {WHATSAPP_CHOICES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </SelectField>
      </Panel>

      <Panel title="Photos">
        <p className="muted">Up to {CATALOG.images}. The first photo is used on product cards.</p>
        <PhotoManager images={form.values.images} onChange={(next) => form.set('images', next)} max={CATALOG.images} error={form.errors.images} />
        <AltTexts form={form} />
      </Panel>

      <OptionsEditor form={form} />

      <Panel title="Stock">
        <Toggle label="In stock" {...form.toggle('inStock')} />
        <FieldGroup>
          <TextField label="Stock count" inputMode="numeric" hint="Optional. Leave empty if you don’t count stock." {...form.field('stock')} />
        </FieldGroup>
      </Panel>

      <Panel title="Where it shows">
        <CategoryPicker categories={categories} selected={form.values.categoryIds} onChange={(next) => form.set('categoryIds', next)} />
        <WordList label="Tags" values={form.values.tags} max={CATALOG.tags} maxLength={40} placeholder="festive, gifting" hint="Optional. Helps you find products later." error={form.errors.tags} onChange={(tags) => form.set('tags', tags)} />
        <Toggle label="Show in stores" {...form.toggle('active')} />
        <Toggle label="Featured on the home page" {...form.toggle('featured')} />
      </Panel>
    </>
  );
}
