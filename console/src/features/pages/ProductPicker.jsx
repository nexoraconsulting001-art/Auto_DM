import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { Button, ErrorState, IconButton, SearchField, Sheet, Spinner, Thumb } from '../../design/index.jsx';
import { formatPaise } from '../../lib/format.js';
import { moveItem } from '../../lib/lists.js';
import { pickedProduct } from './form.js';

function Catalog({ catalog, picked, max, onAdd }) {
  const [text, setText] = useState('');
  if (catalog.isPending) return <Spinner label="Loading your catalog" />;
  if (catalog.isError) return <ErrorState title="We couldn’t load your catalog" error={catalog.error} onRetry={() => catalog.refetch()} />;
  if (!catalog.data.length) return <p className="muted">Your catalog is empty. <Link to="/catalog/new">Add a product</Link> first.</p>;
  const needle = text.trim().toLowerCase();
  const matches = catalog.data.filter((product) => product.name.toLowerCase().includes(needle));
  const full = picked.length >= max;
  return (
    <div className="stack">
      <SearchField label="Search your catalog" value={text} onChange={(event) => setText(event.target.value)} />
      {full && <p className="field-hint" role="status">This page is full. Remove a product to add another.</p>}
      {matches.length === 0 && <p className="muted">No products match.</p>}
      <ul className="catalog">
        {matches.map((product) => {
          const taken = picked.some((other) => other.id === product.id);
          return (
            <li key={product.id} className="catalog-row">
              <Thumb src={product.images[0]} />
              <span className="list-row-main">
                <span className="list-row-title">{product.name}</span>
                <span className="list-row-meta">{formatPaise(product.display?.pricePaise ?? product.pricePaise)}{product.active ? '' : ', archived'}</span>
              </span>
              <Button variant={taken ? 'outline' : 'soft'} disabled={taken || full} aria-label={`${taken ? 'Added' : 'Add'} ${product.name}`} onClick={() => onAdd(pickedProduct(product))}>{taken ? 'Added' : 'Add'}</Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The products a landing page shows, in the order they appear in the post (K-30). `max` is what the plan allows (K-41). */
export function ProductPicker({ catalog, picked, max, onChange, error }) {
  const sheet = useRef(null);
  return (
    <div className="stack">
      {picked.length === 0 && <p className="muted">No products picked yet.</p>}
      {picked.length > 0 && (
        <ol className="picked" aria-label="Products on this page">
          {picked.map((product, index) => (
            <li key={product.id} className="picked-row">
              <span className="picked-number" aria-hidden="true">{index + 1}</span>
              <Thumb src={product.image} />
              <span className="list-row-main">
                <span className="list-row-title">{product.name}</span>
                <span className="list-row-meta">{formatPaise(product.pricePaise)}{product.active ? '' : ', archived (hidden from shoppers)'}{product.soldOut ? ', sold out' : ''}</span>
              </span>
              <span className="picked-tools">
                <IconButton label={`Move ${product.name} up`} disabled={index === 0} onClick={() => onChange((current) => moveItem(current, index, -1))}><ChevronUp size={18} aria-hidden="true" /></IconButton>
                <IconButton label={`Move ${product.name} down`} disabled={index === picked.length - 1} onClick={() => onChange((current) => moveItem(current, index, 1))}><ChevronDown size={18} aria-hidden="true" /></IconButton>
                <IconButton label={`Remove ${product.name}`} onClick={() => onChange((current) => current.filter((other) => other.id !== product.id))}><Trash2 size={16} aria-hidden="true" /></IconButton>
              </span>
            </li>
          ))}
        </ol>
      )}
      <Button variant="soft" block onClick={() => sheet.current?.showModal()}>Add from catalog</Button>
      {error && <p className="field-error" role="alert">{error}</p>}
      <Sheet ref={sheet} title="Add from catalog">
        <Catalog catalog={catalog} picked={picked} max={max} onAdd={(product) => onChange((current) => (current.length >= max || current.some((other) => other.id === product.id) ? current : [...current, product]))} />
      </Sheet>
    </div>
  );
}
