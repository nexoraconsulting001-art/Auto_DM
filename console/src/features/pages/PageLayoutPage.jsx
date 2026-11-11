import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { MANAGERS } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { Badge, Banner, Button, Chip, ChipRow, EmptyState, FieldGroup, IconButton, PageHeader, Panel, SelectField, TextAreaField, TextField, Toggle } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { moveItem } from '../../lib/lists.js';
import { useAllowed, useFilters, useRefresh } from '../../lib/query.js';
import { AreaTabs, Screen } from '../catalog/shared/ui.jsx';
import { BLOCK_FIELDS, BLOCK_TEXT, PAGE_TABS, SURFACES, addableBlocks, layoutToRows, newRow, rowsToLayout, standardRows } from './form.js';

function BlockSettings({ row, onChange }) {
  const fields = BLOCK_FIELDS[row.block] ?? [];
  if (!fields.length) return null;
  return (
    <FieldGroup>
      {fields.map((field) => {
        const shared = { label: field.label, hint: field.hint, value: row.values[field.name] ?? '', onChange: (event) => onChange(field.name, event.target.value) };
        if (field.kind === 'lines') return <TextAreaField key={field.name} rows={3} {...shared} />;
        if (field.kind === 'time') return <TextField key={field.name} type="datetime-local" {...shared} />;
        return <TextField key={field.name} maxLength={field.max ?? 1000} {...shared} />;
      })}
    </FieldGroup>
  );
}

/** One surface's blocks, in order. The same blocks are there for every business; where they sit and what they say is this one's (F-98). */
function LayoutEditor({ surface, layout }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const [rows, setRows] = useState(() => layoutToRows(layout));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [adding, setAdding] = useState('');
  const addable = addableBlocks(surface, rows);
  const setRow = (key, change) => setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));

  async function save() {
    const { body, error } = rowsToLayout(surface, rows);
    if (error) {
      setProblem(error);
      return;
    }
    setBusy(true);
    setProblem('');
    try {
      await api.pageBlocks.save(body);
      toast('Layout saved.');
      await refresh();
    } catch (failure) {
      setProblem(Object.values(failure.fields ?? {})[0] ?? failure.message);
    } finally {
      setBusy(false);
    }
  }

  function add() {
    setRows((current) => [...current, newRow(adding, current)]);
    setAdding('');
  }

  function backToStandard() {
    setRows(standardRows(surface));
    setProblem('');
  }

  return (
    <div className="stack">
      <p className="muted" role="status">{layout.custom ? 'This is your own layout.' : 'This is the standard layout. Change it and save to make it yours.'}</p>
      {rows.length === 0 ? <EmptyState title="No blocks on this page">Add a block below, or go back to the standard layout.</EmptyState> : (
        <ol className="p3-blocks" aria-label="Blocks in order">
          {rows.map((row, index) => {
            const [name, about] = BLOCK_TEXT[row.block] ?? [row.block, ''];
            return (
              <li key={row.key} className={`p3-block${row.visible ? '' : ' p3-block-off'}`}>
                <div className="p3-block-head">
                  <span className="list-row-main">
                    <span className="list-row-title">{name}</span>
                    <span className="list-row-meta">{about}</span>
                  </span>
                  {!row.visible && <Badge>Hidden</Badge>}
                  <span className="p3-block-tools">
                    <IconButton label={`Move ${name} up`} disabled={index === 0} onClick={() => setRows((current) => moveItem(current, index, -1))}><ChevronUp size={18} aria-hidden="true" /></IconButton>
                    <IconButton label={`Move ${name} down`} disabled={index === rows.length - 1} onClick={() => setRows((current) => moveItem(current, index, 1))}><ChevronDown size={18} aria-hidden="true" /></IconButton>
                    <IconButton label={`Remove ${name}`} onClick={() => setRows((current) => current.filter((other) => other.key !== row.key))}><Trash2 size={16} aria-hidden="true" /></IconButton>
                  </span>
                </div>
                <Toggle label={`Show ${name.toLowerCase()}`} checked={row.visible} onChange={(event) => setRow(row.key, { visible: event.target.checked })} />
                <BlockSettings row={row} onChange={(field, value) => setRow(row.key, { values: { ...row.values, [field]: value } })} />
              </li>
            );
          })}
        </ol>
      )}
      {addable.length > 0 && (
        <div className="inline-field">
          <FieldGroup>
            <SelectField label="Add a block" value={adding} onChange={(event) => setAdding(event.target.value)}>
              <option value="">Pick a block</option>
              {addable.map((block) => <option key={block} value={block}>{BLOCK_TEXT[block]?.[0] ?? block}</option>)}
            </SelectField>
          </FieldGroup>
          <Button variant="soft" disabled={!adding} onClick={add}>Add</Button>
        </div>
      )}
      {problem && <Banner tone="bad">{problem}</Banner>}
      <div className="form-actions">
        <Button size="large" block loading={busy} onClick={save}>Save layout</Button>
        <Button variant="outline" size="large" block onClick={backToStandard}>Back to the standard layout</Button>
      </div>
    </div>
  );
}

export default function PageLayoutPage() {
  const allowed = useAllowed();
  const canManage = allowed(MANAGERS);
  const [params, setFilter] = useFilters();
  const surface = SURFACES.some(([key]) => key === params.get('surface')) ? params.get('surface') : 'landing';
  const layout = useQuery({ queryKey: ['pages', 'blocks', surface], queryFn: () => api.pageBlocks.get({ surface }), enabled: canManage });
  return (
    <>
      <PageHeader title="Page layout" />
      <AreaTabs label="Landing page settings" tabs={PAGE_TABS} current="/pages/layout" />
      {canManage ? (
        <>
          <p className="lead">Choose which blocks your pages show, and in what order. Your look stays the same; only the order changes.</p>
          <ChipRow label="Which page">
            {SURFACES.map(([key, label]) => <Chip key={key} pressed={surface === key} onClick={() => setFilter('surface', key === 'landing' ? '' : key)}>{label}</Chip>)}
          </ChipRow>
          <Panel title="Blocks">
            <Screen query={layout} label="Loading this layout" errorTitle="We couldn’t load this layout">
              {(data) => <LayoutEditor key={`${surface}-${layout.dataUpdatedAt}`} surface={surface} layout={data} />}
            </Screen>
          </Panel>
        </>
      ) : <EmptyState title="Only the owner or a manager can change this">Ask them to change how your pages are laid out.</EmptyState>}
    </>
  );
}
