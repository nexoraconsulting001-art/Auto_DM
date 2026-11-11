import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, EmptyState, ErrorState, NotFoundState, Spinner, TextField } from '../../../design/index.jsx';
import { useFeedback } from '../../../components/feedback.jsx';
import { formatDateTime, formatPaise } from '../../../lib/format.js';
import { useRefresh } from '../../../lib/query.js';
import { PLAN_REASONS } from './contract.js';
import { statusOf } from './labels.js';

export { freshKey, toSigned, toWhole } from './rules.js';
import './store.css';

/**
 * What every Phase 4 store screen shares: the states (loading, not on the plan, missing, not switched on, failed), the
 * tabs between the pages of one area, status badges, the timeline, and one way to run a change and say how it went.
 */

/** The API's refusal for a feature the business's plan lacks: a 403 whose reason says so. */
export const isPlanRefusal = (error) => error?.status === 403 && PLAN_REASONS.includes(error?.reason);
const isMissing = (error) => error?.status === 404;
const notBuilt = (error) => error?.status === 501;

/** A feature the plan doesn't include reads as that, never as a failure. The server's own sentence says which feature. */
export function PlanState({ error }) {
  return (
    <EmptyState title="This isn’t on your plan">
      {error?.message || 'This needs a higher plan.'} Ask the Bhava team about a plan that includes it.
    </EmptyState>
  );
}

/**
 * The states every store screen has, in one place. `children` is called with the loaded data. Pass `detail` on a page
 * about one thing, so a missing thing reads as a page that isn't there.
 */
export function StoreScreen({ query, label, errorTitle, detail, children }) {
  if (query.isPending) return <Spinner label={label} />;
  if (query.isError) {
    if (isPlanRefusal(query.error)) return <PlanState error={query.error} />;
    if (detail && isMissing(query.error)) return <NotFoundState />;
    if (notBuilt(query.error)) return <EmptyState title="This isn’t switched on yet">It will appear here as soon as it is ready for your business.</EmptyState>;
    return <ErrorState title={errorTitle} error={query.error} onRetry={() => query.refetch()} />;
  }
  return children(query.data);
}

/** Links between the pages of one area, as a row of pills that scrolls sideways on a phone. `tabs` is [[to, text]]. */
export function StoreTabs({ label, tabs, current }) {
  return (
    <nav className="chip-row store-tabs" aria-label={label}>
      {tabs.filter(Boolean).map(([to, text]) => <Link key={to} className="chip" to={to} aria-current={to === current ? 'page' : undefined}>{text}</Link>)}
    </nav>
  );
}

/** One status from one of the tables in labels.js. */
export function StatusBadge({ table, status }) {
  const { label, tone } = statusOf(table, status);
  return label ? <Badge tone={tone}>{label}</Badge> : null;
}

/** A row of small badges; nothing when there are none. Each is { tone, text }. */
export function Badges({ items }) {
  const shown = items.filter(Boolean);
  if (!shown.length) return null;
  return <span className="store-badges">{shown.map((item) => <Badge key={item.text} tone={item.tone}>{item.text}</Badge>)}</span>;
}

/** Label and value pairs. Rows whose value is null, undefined or false are left out. */
export function Facts({ rows, className = 'facts' }) {
  return (
    <dl className={className}>
      {rows.filter((row) => row && row[1] !== null && row[1] !== undefined && row[1] !== false).map(([term, value, grand]) => (
        <div key={term} className={grand ? 'totals-grand' : undefined}><dt>{term}</dt><dd>{value}</dd></div>
      ))}
    </dl>
  );
}

/** What happened, newest last, as a journey down the page: each { key, title, meta, note }. */
export function Timeline({ items, label }) {
  return (
    <ol className="store-timeline" aria-label={label}>
      {items.map((item, index) => (
        <li key={item.key} className="store-timeline-step" aria-current={index === items.length - 1 ? 'step' : undefined}>
          <span className="store-timeline-dot" aria-hidden="true" />
          <span className="store-timeline-body">
            <span className="store-timeline-title">{item.title}</span>
            {item.meta && <span className="store-timeline-meta">{item.meta}</span>}
            {item.note && <span className="store-timeline-note">{item.note}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** A money field in rupees. The form keeps the text; rupeesToPaise turns it into paise when it is saved. */
export function RupeeField({ label, ...rest }) {
  return <TextField label={`${label} (₹)`} inputMode="decimal" autoComplete="off" {...rest} />;
}

/** A whole-number field. */
export function NumberField(props) {
  return <TextField inputMode="numeric" autoComplete="off" {...props} />;
}

export const money = (paise) => formatPaise(paise);
export const when = (value) => (value ? formatDateTime(value) : '');

/**
 * Runs one change: shows the problem if it fails, says so if it works, and refreshes what is on screen. `busy` names the
 * change running, so only its own button spins.
 */
export function useAction() {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState('');

  const run = useCallback(async (name, action, done) => {
    setBusy(name);
    setProblem('');
    try {
      const result = await action();
      if (done) toast(done);
      await refresh();
      return result ?? true;
    } catch (error) {
      setProblem(error.message);
      return null;
    } finally {
      setBusy('');
    }
  }, [toast, refresh]);

  return { busy, problem, setProblem, run };
}

/** Stars as text a screen reader can say, and as marks. */
export function Stars({ rating }) {
  return (
    <span className="store-stars" role="img" aria-label={`${rating} out of 5 stars`}>
      {'★'.repeat(rating)}<span className="store-stars-off">{'★'.repeat(5 - rating)}</span>
    </span>
  );
}
