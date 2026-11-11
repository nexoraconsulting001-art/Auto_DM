import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { MANAGERS } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { Badge, Banner, Button, Chip, ChipRow, EmptyState, FieldGroup, ListCard, LoadMore, PageHeader, Panel, SearchField, Sheet, TextField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useForm } from '../../lib/forms.js';
import { useAllowed, useFilters, usePagedList, useRefresh, useSearchBox } from '../../lib/query.js';
import { STOCK_AREA } from '../orders/shared/areas.js';
import { STOCK_SHOW as SHOW } from '../orders/shared/filters.js';
import { NumberField, StoreScreen, StoreTabs, toWhole } from '../orders/shared/ui.jsx';
import { ADJUST_WAYS, formToAdjust, lineToForm } from './form.js';

const lineName = (line) => `${line.name}${line.option ? `, ${line.option}` : ''}`;

function AdjustForm({ line, onDone }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const form = useForm(lineToForm(line), { rename: { stock: 'amount', delta: 'amount', lowStockThreshold: 'lowAt' } });

  async function save(event) {
    event.preventDefault();
    const { body, errors } = formToAdjust(form.values, line);
    if (errors) return form.reject(errors);
    if (body.stock === undefined && body.delta === undefined && body.lowStockThreshold === undefined) return onDone();
    const done = await form.run(() => api.inventory.adjust(body));
    if (done) {
      toast('Stock saved.');
      await refresh();
      onDone();
    }
    return undefined;
  }

  return (
    <form className="stack" onSubmit={save} noValidate>
      <p className="sheet-text">{line.reserved > 0 ? `${line.reserved} are held for orders being paid for. Stock can’t go below that.` : 'Nothing is held for orders right now.'}</p>
      <fieldset className="store-choice">
        <legend className="sr-only">How to change it</legend>
        {ADJUST_WAYS.map(([value, label]) => (
          <label key={value} className="store-option">
            <input type="radio" name="way" value={value} checked={form.values.way === value} onChange={() => form.set('way', value)} />
            <span className="store-option-text"><span className="store-option-title">{label}</span></span>
          </label>
        ))}
      </fieldset>
      <FieldGroup>
        {form.values.way === 'set' && <NumberField label="On hand" {...form.field('amount')} />}
        {form.values.way === 'move' && <TextField label="Add, or take away with a minus" inputMode="numeric" placeholder="e.g. 5 or -2" {...form.field('amount')} />}
        <NumberField label="Alert me when it falls to" hint="Leave empty for your usual level." {...form.field('lowAt')} />
        <TextField label="Note (optional)" maxLength={200} {...form.field('note')} />
      </FieldGroup>
      {form.message && <Banner tone="bad">{form.message}</Banner>}
      <div className="sheet-actions">
        <Button variant="outline" onClick={onDone}>Cancel</Button>
        <Button type="submit" loading={form.busy}>Save stock</Button>
      </div>
    </form>
  );
}

/** The level a line counts as running low at, unless it has its own. */
function Threshold() {
  const allowed = useAllowed();
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const settings = useQuery({ queryKey: ['inventory-settings'], queryFn: api.inventorySettings.get });
  const [value, setValue] = useState(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  async function save(event) {
    event.preventDefault();
    const level = toWhole(value);
    if (!Number.isInteger(level)) return setProblem('Enter a whole number, 0 or more');
    setBusy(true);
    setProblem('');
    try {
      await api.inventorySettings.update({ lowStockThreshold: level });
      toast('Alert level saved.');
      setValue(null);
      await refresh();
    } catch (error) {
      setProblem(error.message);
    } finally {
      setBusy(false);
    }
    return undefined;
  }

  return (
    <Panel title="Running low">
      <StoreScreen query={settings} label="Loading your alert level" errorTitle="We couldn’t load your alert level">
        {(data) => (allowed(MANAGERS) ? (
          <form className="inline-field" onSubmit={save} noValidate>
            <FieldGroup><NumberField label="Alert when stock falls to" error={problem} value={value ?? String(data.lowStockThreshold)} onChange={(event) => setValue(event.target.value)} /></FieldGroup>
            <Button type="submit" variant="soft" loading={busy}>Save</Button>
          </form>
        ) : <p className="muted">You’re alerted when stock falls to {data.lowStockThreshold}.</p>)}
      </StoreScreen>
    </Panel>
  );
}

export default function InventoryPage() {
  const [params, setFilter] = useFilters();
  const show = SHOW.some(([key]) => key === params.get('show')) ? params.get('show') : 'all';
  const search = params.get('search') ?? '';
  const [text, setText] = useSearchBox(search, (value) => setFilter('search', value));
  const lines = usePagedList('inventory', api.inventory.list, { show, search: search || undefined });
  const sheet = useRef(null);
  const [editing, setEditing] = useState(null);

  function edit(line) {
    setEditing(line);
    sheet.current?.showModal();
  }
  const close = () => {
    sheet.current?.close();
    setEditing(null);
  };

  return (
    <>
      <PageHeader title="Stock" />
      <StoreTabs label="Stock area" tabs={STOCK_AREA} current="/inventory" />
      <div className="filters">
        <ChipRow label="Filter stock">
          {SHOW.map(([key, label]) => <Chip key={key} pressed={show === key} onClick={() => setFilter('show', key === 'all' ? '' : key)}>{label}</Chip>)}
        </ChipRow>
        <SearchField label="Product name or SKU" value={text} onChange={(event) => setText(event.target.value)} />
      </div>
      <StoreScreen query={lines} label="Loading your stock" errorTitle="We couldn’t load your stock">
        {() => (lines.items.length ? (
          <>
            <ListCard aria-label="Stock">
              {lines.items.map((line) => (
                <div key={`${line.productId}-${line.variantId ?? 0}`} className="order-line">
                  <div className="order-line-head">
                    <span className="order-line-title">{lineName(line)}</span>
                    {line.stock !== null && line.available !== null && line.available <= 0 ? <Badge tone="bad">Sold out</Badge> : line.low ? <Badge tone="warn">Running low</Badge> : null}
                  </div>
                  <span className="stock-figures">
                    {line.stock === null ? <span><strong>Not counted</strong> (unlimited)</span> : (
                      <>
                        <span>On hand <strong>{line.stock}</strong></span>
                        <span>Held for orders <strong>{line.reserved}</strong></span>
                        <span>Can be sold <strong>{line.available}</strong></span>
                      </>
                    )}
                    {line.sku && <span>SKU {line.sku}</span>}
                  </span>
                  <div className="row-actions">
                    <Button variant="soft" aria-label={`Change stock of ${lineName(line)}`} onClick={() => edit(line)}>Change</Button>
                    <Button as={Link} variant="outline" to={`/inventory/movements?productId=${line.productId}`} state={{ name: line.name }} aria-label={`History of ${lineName(line)}`}>History</Button>
                  </div>
                </div>
              ))}
            </ListCard>
            <LoadMore query={lines} />
          </>
        ) : (
          <EmptyState title={show !== 'all' || search ? 'Nothing matches' : 'No products yet'}>
            {show === 'low' ? 'Nothing is running low.' : show === 'out' ? 'Nothing is sold out.' : search ? 'Try another name or SKU.' : 'Add products to your catalog to count their stock.'}
          </EmptyState>
        ))}
      </StoreScreen>
      <Threshold />
      <Sheet ref={sheet} title={editing ? `Stock of ${lineName(editing)}` : 'Stock'} onClose={() => setEditing(null)}>
        {editing && <AdjustForm key={`${editing.productId}-${editing.variantId}`} line={editing} onDone={close} />}
      </Sheet>
    </>
  );
}
