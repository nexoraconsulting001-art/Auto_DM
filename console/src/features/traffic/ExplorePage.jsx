import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, Pin, PinOff, Plus, Save, Trash2, X } from 'lucide-react';
import { MANAGERS } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { Badge, Banner, Button, Chip, ChipRow, EmptyState, FieldGroup, IconButton, LoadMore, PageHeader, Panel, SelectField, Sheet, TextField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useAllowed, usePagedList } from '../../lib/query.js';
import { DEVICE_TYPES, FIGURE_TEXT, IN_APP_BROWSERS, TRAFFIC_SOURCES, VISITOR_TYPES } from '../insights/shared/catalog.js';
import { COMPARE_CHOICES, checkCustomRange, exploreBody, exploreCell, exploreForm } from '../insights/shared/figures.js';
import { DownloadButtons } from '../insights/shared/download.jsx';
import { AnalyticsLoadable, BarList, LastUpdated, LineChart, RangeBar, SourceTag, TrafficTabs } from '../insights/shared/ui.jsx';
import { WEEKDAY_NAMES, breakdownValue, formatDay, sourceLabel } from '../insights/shared/words.js';

const DEFAULT_FORM = Object.freeze(exploreForm({ metrics: ['sessions'], dimensions: ['source'], range: '28' }));

/** Values a seller picks from rather than types, where the catalogue knows them all. */
const KNOWN_VALUES = Object.freeze({
  source: TRAFFIC_SOURCES,
  device: DEVICE_TYPES,
  in_app: IN_APP_BROWSERS,
  visitor_type: VISITOR_TYPES,
  weekday: ['0', '1', '2', '3', '4', '5', '6'],
});

/** A labelled select that reads as part of the "Show … by … where …" sentence. */
function AskSelect({ label, value, onChange, children }) {
  const id = useId();
  return (
    <>
      <label className="sr-only" htmlFor={id}>{label}</label>
      <select id={id} className="an-select" value={value} onChange={(event) => onChange(event.target.value)}>{children}</select>
    </>
  );
}

function MetricOptions({ catalog, taken = [] }) {
  const groups = [['bhava', 'Measured by Bhava'], ['platform', 'From Instagram/Facebook'], ['destination', 'From the destination']];
  return groups.map(([source, title]) => {
    const metrics = catalog.metrics.filter((m) => m.source === source);
    if (!metrics.length) return null;
    return (
      <optgroup key={source} label={title}>
        {metrics.map((m) => <option key={m.name} value={m.name} disabled={!m.available || taken.includes(m.name)}>{m.available ? m.label : `${m.label} (${m.reason})`}</option>)}
      </optgroup>
    );
  });
}

function FilterRow({ filter, catalog, onChange, onRemove }) {
  const known = Object.hasOwn(KNOWN_VALUES, filter.dimension) ? KNOWN_VALUES[filter.dimension] : null;
  return (
    <div className="an-condition">
      <div className="an-condition-fields">
        <AskSelect label="Filter on" value={filter.dimension} onChange={(dimension) => onChange({ ...filter, dimension, value: '' })}>
          {catalog.dimensions.map((d) => <option key={d.name} value={d.name}>{d.label}</option>)}
        </AskSelect>
        <AskSelect label="Keep or leave out" value={filter.op} onChange={(op) => onChange({ ...filter, op })}>
          <option value="include">is</option>
          <option value="exclude">is not</option>
        </AskSelect>
        {known ? (
          <AskSelect label="Value" value={filter.value} onChange={(value) => onChange({ ...filter, value })}>
            <option value="">Choose…</option>
            {known.map((v) => <option key={v} value={v}>{breakdownValue(filter.dimension, v)}</option>)}
          </AskSelect>
        ) : (
          <>
            <label className="sr-only" htmlFor={`f-${filter.key}`}>Values, separated by commas</label>
            <input id={`f-${filter.key}`} className="an-text" placeholder={filter.dimension === 'date' ? 'YYYY-MM-DD' : 'Pune, Mumbai'} value={filter.value} maxLength={400} onChange={(event) => onChange({ ...filter, value: event.target.value })} />
          </>
        )}
      </div>
      <IconButton label="Remove this filter" onClick={onRemove}><X size={18} aria-hidden="true" /></IconButton>
    </div>
  );
}

/** The question, as a sentence: show these figures, by up to two breakdowns, where these filters hold (7.11). */
function Ask({ catalog, form, setForm, onShow }) {
  const nextKey = useRef(1);
  const set = (patch) => setForm((current) => ({ ...current, ...patch }));
  const [first, ...more] = form.metrics;
  const firstAvailable = catalog.metrics.find((m) => m.available)?.name ?? 'sessions';
  const compareProblem = form.compare === 'custom' && (form.compareFrom || form.compareTo) ? checkCustomRange(form.compareFrom, form.compareTo) : null;
  return (
    <Panel title="Ask a question">
      <div className="an-ask">
        <div className="an-ask-row">
          <span>Show</span>
          <AskSelect label="Figure to show" value={first ?? firstAvailable} onChange={(value) => set({ metrics: [value, ...more.filter((m) => m !== value)] })}>
            <MetricOptions catalog={catalog} />
          </AskSelect>
        </div>
        {more.map((metric, index) => (
          <div key={metric} className="an-ask-row">
            <span>and</span>
            <span className="an-condition">
              <AskSelect label={`Figure ${index + 2}`} value={metric} onChange={(value) => set({ metrics: form.metrics.map((m) => (m === metric ? value : m)) })}>
                <MetricOptions catalog={catalog} taken={form.metrics.filter((m) => m !== metric)} />
              </AskSelect>
              <IconButton label="Remove this figure" onClick={() => set({ metrics: form.metrics.filter((m) => m !== metric) })}><X size={18} aria-hidden="true" /></IconButton>
            </span>
          </div>
        ))}
        <div className="an-ask-row">
          <span>by</span>
          <AskSelect label="Break down by" value={form.dimensions[0] ?? ''} onChange={(value) => set({ dimensions: value ? [value, ...form.dimensions.slice(1).filter((d) => d !== value)] : [] })}>
            <option value="">Nothing: totals only</option>
            {catalog.dimensions.map((d) => <option key={d.name} value={d.name}>{d.label}</option>)}
          </AskSelect>
        </div>
        {form.dimensions[0] && (
          <div className="an-ask-row">
            <span>and</span>
            <AskSelect label="Then break down by" value={form.dimensions[1] ?? ''} onChange={(value) => set({ dimensions: value ? [form.dimensions[0], value] : [form.dimensions[0]] })}>
              <option value="">Nothing more</option>
              {catalog.dimensions.filter((d) => d.name !== form.dimensions[0]).map((d) => <option key={d.name} value={d.name}>{d.label}</option>)}
            </AskSelect>
          </div>
        )}
        {form.filters.map((filter, index) => (
          <div key={filter.key ?? index} className="an-ask-row">
            <span>{index === 0 ? 'where' : 'and'}</span>
            <FilterRow
              filter={{ ...filter, key: filter.key ?? index }}
              catalog={catalog}
              onChange={(next) => set({ filters: form.filters.map((f, i) => (i === index ? next : f)) })}
              onRemove={() => set({ filters: form.filters.filter((_, i) => i !== index) })}
            />
          </div>
        ))}
        {form.thresholds.map((threshold, index) => (
          <div key={`t${index}`} className="an-ask-row">
            <span>only</span>
            <span className="an-condition">
              <span className="an-condition-fields">
                <AskSelect label="Figure to limit by" value={threshold.metric} onChange={(metric) => set({ thresholds: form.thresholds.map((t, i) => (i === index ? { ...t, metric } : t)) })}>
                  <MetricOptions catalog={catalog} />
                </AskSelect>
                <AskSelect label="At least or at most" value={threshold.op} onChange={(op) => set({ thresholds: form.thresholds.map((t, i) => (i === index ? { ...t, op } : t)) })}>
                  <option value="gte">at least</option>
                  <option value="lte">at most</option>
                </AskSelect>
                <>
                  <label className="sr-only" htmlFor={`t-${index}`}>Amount</label>
                  <input id={`t-${index}`} className="an-text" type="number" min="0" inputMode="decimal" value={threshold.value} onChange={(event) => set({ thresholds: form.thresholds.map((t, i) => (i === index ? { ...t, value: event.target.value } : t)) })} />
                </>
              </span>
              <IconButton label="Remove this limit" onClick={() => set({ thresholds: form.thresholds.filter((_, i) => i !== index) })}><X size={18} aria-hidden="true" /></IconButton>
            </span>
          </div>
        ))}
      </div>
      <div className="chip-wrap">
        {form.metrics.length < 12 && (
          <Chip onClick={() => {
            const next = catalog.metrics.find((m) => m.available && !form.metrics.includes(m.name));
            if (next) set({ metrics: [...form.metrics, next.name] });
          }}
          >
            <Plus size={16} aria-hidden="true" />Figure
          </Chip>
        )}
        {form.filters.length < 10 && <Chip onClick={() => { nextKey.current += 1; set({ filters: [...form.filters, { key: `n${nextKey.current}`, dimension: 'source', op: 'include', value: '' }] }); }}><Plus size={16} aria-hidden="true" />Filter</Chip>}
        {form.thresholds.length < 3 && <Chip onClick={() => set({ thresholds: [...form.thresholds, { metric: form.metrics[0] ?? 'sessions', op: 'gte', value: '' }] })}><Plus size={16} aria-hidden="true" />Limit</Chip>}
      </div>
      <RangeBar query={{ range: form.range, from: form.from, to: form.to }} asked={form.range} onChange={(range) => set({ range: range.range, from: range.from ?? '', to: range.to ?? '' })} />
      <FieldGroup>
        <SelectField label="Compare with" value={form.compare} onChange={(event) => set({ compare: event.target.value })}>
          {COMPARE_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </SelectField>
        {form.compare === 'custom' && (
          <>
            <TextField label="Compare from" type="date" value={form.compareFrom} error={compareProblem?.from} onChange={(event) => set({ compareFrom: event.target.value })} />
            <TextField label="Compare to" type="date" value={form.compareTo} error={compareProblem?.to} onChange={(event) => set({ compareTo: event.target.value })} />
          </>
        )}
      </FieldGroup>
      <ChipRow label="Show as">
        {[['table', 'Table'], ['line', 'Line'], ['bar', 'Bars']].map(([value, label]) => <Chip key={value} pressed={form.chart === value} onClick={() => set({ chart: value })}>{label}</Chip>)}
      </ChipRow>
      <Button size="large" block onClick={onShow}>Show</Button>
    </Panel>
  );
}

function cellText(metric, cell) {
  return exploreCell(metric, cell);
}

const dimensionLabel = (catalog, name) => catalog.dimensions.find((d) => d.name === name)?.label ?? name;
const rowLabel = (name, value) => (name === 'weekday' && /^[0-6]$/.test(value) ? WEEKDAY_NAMES[Number(value)] : breakdownValue(name, value));

function ResultTable({ result, catalog, body, onSort }) {
  const dims = body.dimensions;
  const comparing = Boolean(result.compareFrom);
  const sortMark = (name) => (body.sortBy === name ? (body.sortDirection === 'asc' ? <ArrowUp size={14} aria-hidden="true" /> : <ArrowDown size={14} aria-hidden="true" />) : null);
  const ariaSort = (name) => (body.sortBy === name ? (body.sortDirection === 'asc' ? 'ascending' : 'descending') : undefined);
  return (
    <div className="an-table-wrap">
      <table className="an-table">
        <caption className="sr-only">{`Results from ${result.from} to ${result.to}${comparing ? `, compared with ${result.compareFrom} to ${result.compareTo}` : ''}`}</caption>
        <thead>
          <tr>
            {dims.length ? dims.map((d) => (
              <th key={d} scope="col" aria-sort={ariaSort(d)}><button type="button" className="an-sort" onClick={() => onSort(d)}>{dimensionLabel(catalog, d)}{sortMark(d)}</button></th>
            )) : <th scope="col">Total</th>}
            {result.columns.map((c) => (
              <th key={c.metric} scope="col" aria-sort={ariaSort(c.metric)}>
                <button type="button" className="an-sort" onClick={() => onSort(c.metric)}>{c.label}{sortMark(c.metric)}</button>
                <span className="an-col-source">{sourceLabel(c.source)}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(dims.length ? result.rows : []).map((row, index) => (
            <tr key={dims.map((d) => row.dimensions[d]).join('|') || index}>
              {dims.map((d, i) => (i === 0 ? <th key={d} scope="row">{rowLabel(d, row.dimensions[d])}</th> : <td key={d}>{rowLabel(d, row.dimensions[d])}</td>))}
              {result.columns.map((c) => {
                const text = cellText(c.metric, row.metrics[c.metric]);
                return <td key={c.metric}>{text.value}{comparing && text.change && <span className="an-cell-change">{text.change}</span>}</td>;
              })}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={Math.max(1, dims.length)}>Total</th>
            {result.columns.map((c) => {
              const text = cellText(c.metric, result.totals[c.metric]);
              return <td key={c.metric}>{text.value}{comparing && text.change && <span className="an-cell-change">{text.change}</span>}</td>;
            })}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function ResultChart({ result, body }) {
  const metric = result.columns[0]?.metric;
  const dim = body.dimensions[0];
  if (!metric || !dim) return <p className="muted">Choose a breakdown to draw a chart.</p>;
  if (body.chart === 'line') {
    if (dim !== 'date') return <p className="muted">A line needs “Date” as the first breakdown. Showing bars instead.</p>;
    const days = [...result.rows].sort((a, b) => (a.dimensions.date < b.dimensions.date ? -1 : 1)).map((row) => ({ day: row.dimensions.date, value: row.metrics[metric]?.value ?? null }));
    return <LineChart days={days} label={result.columns[0].label} />;
  }
  const items = result.rows.slice(0, 20).map((row) => ({ key: JSON.stringify(row.dimensions), label: rowLabel(dim, row.dimensions[dim]), value: row.metrics[metric]?.value ?? 0 }));
  return <BarList label={result.columns[0].label} items={items} format={(v) => cellText(metric, { value: v, lowVolume: false }).value} />;
}

function Result({ result, catalog, body, onSort, onPage }) {
  const hidden = result.hiddenMetrics.map((name) => catalog.metrics.find((m) => m.name === name)).filter(Boolean);
  return (
    <>
      {hidden.length > 0 && <Banner tone="info">{`Not shown: ${hidden.map((m) => `${m.label} (${m.reason ?? FIGURE_TEXT.ownerOnly})`).join(', ')}.`}</Banner>}
      <p className="muted">{`${formatDay(result.from, { year: true })} to ${formatDay(result.to, { year: true })}${result.compareFrom ? `, compared with ${formatDay(result.compareFrom, { year: true })} to ${formatDay(result.compareTo, { year: true })}` : ''}. Figures from different sources sit side by side and are never added together.`}</p>
      {body.chart !== 'table' && <ResultChart result={result} body={body} />}
      {result.columns.length ? <ResultTable result={result} catalog={catalog} body={body} onSort={onSort} /> : <EmptyState title="Nothing you can see here">Every figure you chose is hidden for your role or plan.</EmptyState>}
      {body.dimensions.length > 0 && !result.rows.length && <p className="muted">{`${FIGURE_TEXT.noData} for these dates and filters.`}</p>}
      <div className="row-actions">
        {onPage.previous && <Button variant="soft" onClick={onPage.previous}>Previous 100 rows</Button>}
        {result.nextPage && <Button variant="soft" onClick={() => onPage.next(result.nextPage)}>Next 100 rows</Button>}
      </div>
      <LastUpdated at={result.lastUpdatedAt} prefix="Worked out" />
    </>
  );
}

function SaveView({ body, onSaved }) {
  const sheet = useRef(null);
  const { toast } = useFeedback();
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState('private');
  const [problem, setProblem] = useState('');
  const save = useMutation({
    mutationFn: () => api.savedViews.create({ name: name.trim(), visibility, definition: body }),
    onSuccess: async (view) => {
      sheet.current?.close();
      setName('');
      toast('View saved.');
      await onSaved(view);
    },
    onError: (error) => setProblem(error.fields?.name ?? error.message),
  });
  return (
    <>
      <Button variant="soft" onClick={() => { setProblem(''); sheet.current?.showModal(); }}><Save size={16} strokeWidth={1.8} aria-hidden="true" />Save view</Button>
      <Sheet ref={sheet} title="Save this view">
        <form className="an-form" onSubmit={(event) => { event.preventDefault(); if (!name.trim()) setProblem('Name this view'); else save.mutate(); }} noValidate>
          <FieldGroup>
            <TextField label="Name" maxLength={80} value={name} error={problem || undefined} onChange={(event) => setName(event.target.value)} />
            <SelectField label="Who can see it" value={visibility} onChange={(event) => setVisibility(event.target.value)}>
              <option value="private">Only me</option>
              <option value="team">My team</option>
            </SelectField>
          </FieldGroup>
          <p className="muted">Shared views respect each person’s access: someone who can’t see revenue won’t see it here either.</p>
          <div className="sheet-actions">
            <Button variant="outline" onClick={() => sheet.current?.close()}>Cancel</Button>
            <Button type="submit" loading={save.isPending}>Save view</Button>
          </div>
        </form>
      </Sheet>
    </>
  );
}

function SavedViews({ onOpen }) {
  const { confirm, toast } = useFeedback();
  const queries = useQueryClient();
  const views = usePagedList('saved-views', api.savedViews.list);
  const refresh = () => Promise.all([queries.invalidateQueries({ queryKey: ['saved-views'] }), queries.invalidateQueries({ queryKey: ['dashboard'] })]);
  const act = useMutation({
    mutationFn: ({ action, view }) => (action === 'pin' ? api.savedViews.pin(view.id) : action === 'unpin' ? api.savedViews.unpin(view.id) : api.savedViews.remove(view.id)),
    onSuccess: async (_, { action }) => {
      toast(action === 'pin' ? 'Pinned to Home.' : action === 'unpin' ? 'Taken off Home.' : 'View deleted.');
      await refresh();
    },
    onError: (error) => toast(error.message),
  });
  async function remove(view) {
    if (await confirm({ title: `Delete “${view.name}”?`, text: 'The view goes for everyone it was shared with. This can’t be undone.', confirm: 'Delete view' })) act.mutate({ action: 'remove', view });
  }
  return (
    <Panel title="Saved views">
      <AnalyticsLoadable query={views} label="Loading saved views" errorTitle="We couldn’t load saved views">
        {() => (views.items.length ? (
          <>
            <div className="an-rows">
              {views.items.map((view) => (
                <div key={view.id} className="an-row">
                  <span className="an-row-main">
                    <button type="button" className="an-sort an-row-title" onClick={() => onOpen(view)}>{view.name}</button>
                    <span className="an-badges">
                      <Badge tone={view.visibility === 'team' ? 'neel' : 'neutral'}>{view.visibility === 'team' ? 'Team' : 'Only you'}</Badge>
                      {view.pinned && <Badge tone="warn">On Home</Badge>}
                    </span>
                  </span>
                  <span className="row-actions">
                    <IconButton label={view.pinned ? `Take ${view.name} off Home` : `Pin ${view.name} to Home`} onClick={() => act.mutate({ action: view.pinned ? 'unpin' : 'pin', view })}>
                      {view.pinned ? <PinOff size={18} aria-hidden="true" /> : <Pin size={18} aria-hidden="true" />}
                    </IconButton>
                    {view.mine && <IconButton label={`Delete ${view.name}`} onClick={() => remove(view)}><Trash2 size={18} aria-hidden="true" /></IconButton>}
                  </span>
                </div>
              ))}
            </div>
            <LoadMore query={views} />
          </>
        ) : <EmptyState title="No saved views yet">Save a question to come back to it, share it with your team, or pin it to Home.</EmptyState>)}
      </AnalyticsLoadable>
    </Panel>
  );
}

/** Explore (7.11): any figure by any breakdown, from the catalogue only, so nothing can ever name one visitor. */
export default function ExplorePage() {
  const allowed = useAllowed();
  const queries = useQueryClient();
  const [params, setParams] = useSearchParams();
  const catalog = useQuery({ queryKey: ['explore', 'catalog'], queryFn: () => api.explore.catalog(), staleTime: 5 * 60_000 });
  const [form, setForm] = useState(DEFAULT_FORM);
  const [applied, setApplied] = useState(null);
  const [pages, setPages] = useState([]);
  const [savedId, setSavedId] = useState(null);
  const viewId = params.get('view');

  const names = useMemo(() => (catalog.data ? { metricNames: catalog.data.metrics.map((m) => m.name), dimensionNames: catalog.data.dimensions.map((d) => d.name) } : null), [catalog.data]);
  const asked = useQuery({ queryKey: ['saved-views', 'one', viewId], queryFn: () => api.savedViews.get(Number(viewId)), enabled: /^\d{1,9}$/.test(viewId ?? ''), retry: false });

  // A saved view in the address opens as it was saved; otherwise the first question is sessions by source.
  useEffect(() => {
    if (!names) return;
    if (asked.data && savedId !== asked.data.id) {
      const next = exploreForm(asked.data.definition);
      setForm(next);
      setApplied(exploreBody(next, names));
      setPages([]);
      setSavedId(asked.data.id);
    } else if (!applied && !viewId) {
      setApplied(exploreBody(DEFAULT_FORM, names));
    }
  }, [names, asked.data, savedId, applied, viewId]);

  const page = pages.at(-1);
  const result = useQuery({
    queryKey: ['explore', 'result', applied, page ?? ''],
    queryFn: () => api.explore.query({ ...applied, ...(page ? { page } : {}) }),
    enabled: Boolean(applied && applied.metrics.length),
    placeholderData: keepPreviousData,
  });

  function show() {
    const body = exploreBody(form, names);
    if (!body.metrics.length) return;
    setApplied(body);
    setPages([]);
  }

  function sort(name) {
    setApplied((current) => ({ ...current, sortBy: name, sortDirection: current.sortBy === name && current.sortDirection === 'desc' ? 'asc' : 'desc' }));
    setPages([]);
  }

  function open(view) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set('view', String(view.id));
      return next;
    }, { replace: true });
    setSavedId(null);
  }

  return (
    <>
      <PageHeader eyebrow="Traffic" title="Explore" />
      <TrafficTabs />
      <AnalyticsLoadable query={catalog} label="Loading what you can ask" errorTitle="We couldn’t load what you can ask">
        {(data) => (
          <>
            <Ask catalog={data} form={form} setForm={setForm} onShow={show} />
            <Panel title="Answer" action={applied ? <span className="an-badges">{[...new Set((result.data?.columns ?? []).map((c) => c.source))].map((s) => <SourceTag key={s} source={s} />)}</span> : null}>
              {applied ? (
                <AnalyticsLoadable query={result} label="Working it out" errorTitle="We couldn’t work that out">
                  {(answer) => <Result result={answer} catalog={data} body={applied} onSort={sort} onPage={{ next: (p) => setPages((list) => [...list, p]), previous: pages.length ? () => setPages((list) => list.slice(0, -1)) : null }} />}
                </AnalyticsLoadable>
              ) : <EmptyState title="Ask a question above">Choose a figure and a breakdown, then tap Show.</EmptyState>}
              {applied && (
                <div className="an-actions">
                  <SaveView body={applied} onSaved={async (view) => { await queries.invalidateQueries({ queryKey: ['saved-views'] }); open(view); }} />
                  {allowed(MANAGERS) && savedId
                    ? <Button as={Link} variant="primary" to={`/reports/scheduled?view=${savedId}`}>Schedule a report</Button>
                    : <span className="muted">{allowed(MANAGERS) ? 'Save the view to schedule it as a report.' : ''}</span>}
                </div>
              )}
              {applied && <DownloadButtons label="Download this answer" request={() => ({ source: 'explore', query: applied })} />}
            </Panel>
            <SavedViews onOpen={open} />
          </>
        )}
      </AnalyticsLoadable>
    </>
  );
}
