import { useState } from 'react';
import { Banner, Button, PageHeader, Panel, TextAreaField, TextField, Toggle } from '../../../design/index.jsx';
import { Facts, When, useAct } from '../../kit.jsx';
import { EXPORT_TABLES, parseIds, reasonProblem } from '../../lib/rules.js';
import { api } from '../../api.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Raw rows for a set of businesses and a span of days, for a reason (super admin only). The server limits and audits it. */
export function ExportsPage() {
  const act = useAct();
  const [tables, setTables] = useState({});
  const [ids, setIds] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const chosen = EXPORT_TABLES.filter((table) => tables[table.value]).map((table) => table.value);
  const tenantIds = parseIds(ids);
  const problems = {
    tables: chosen.length ? '' : 'Choose at least one table',
    ids: tenantIds === null ? 'Use business numbers separated by commas or spaces' : tenantIds.length === 0 ? 'Enter at least one business number' : tenantIds.length > 1000 ? 'At most 1000 businesses' : '',
    from: DAY.test(from) ? '' : 'Choose the first day',
    to: !DAY.test(to) ? 'Choose the last day' : DAY.test(from) && to < from ? 'The last day is before the first' : '',
    reason: reasonProblem(reason),
  };
  const ready = Object.values(problems).every((problem) => problem === '');

  async function submit(event) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(await act(() => api.rawExport({ body: { reason: reason.trim(), tables: chosen, tenantIds, from, to } })));
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <PageHeader eyebrow="Bhava Console" title="Raw exports" />
      <p className="muted">Raw rows leave the platform only here, for a stated reason. Each export is on the audit log.</p>
      {error && <Banner tone="bad">{error}</Banner>}
      {result && (
        <Banner tone="good">
          <div data-testid="export-result">
            <Facts rows={[['Rows', String(result.rowCount)], ['Kept until', <When key="e" value={result.expiresAt} />]]} />
          </div>
        </Banner>
      )}
      <form className="stack" onSubmit={submit} noValidate>
        <Panel title="What">
          <fieldset className="pc-fieldset">
            <legend className="field-label">Tables</legend>
            {EXPORT_TABLES.map((table) => (
              <Toggle key={table.value} label={table.label} checked={Boolean(tables[table.value])} onChange={(event) => setTables((current) => ({ ...current, [table.value]: event.target.checked }))} />
            ))}
          </fieldset>
          <TextAreaField label="Business numbers" hint="Separated by commas or spaces. Up to 1000." rows={2} value={ids} onChange={(event) => setIds(event.target.value)} error={ids && problems.ids ? problems.ids : undefined} />
        </Panel>
        <Panel title="When">
          <div className="stack">
            <TextField label="From" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            <TextField label="To" type="date" value={to} onChange={(event) => setTo(event.target.value)} error={to && problems.to ? problems.to : undefined} />
          </div>
        </Panel>
        <Panel title="Why">
          <TextAreaField label="Reason" rows={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} required />
        </Panel>
        <Button type="submit" size="large" block loading={busy} disabled={!ready}>Make the export</Button>
      </form>
    </div>
  );
}
