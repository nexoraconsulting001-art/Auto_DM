import { Link } from 'react-router-dom';
import { Badge, EmptyState, ErrorState, NotFoundState, Spinner } from '../../../design/index.jsx';
import { PLAN_REASON } from './limits.js';
import './p3.css';

/** The API's refusal for a feature the business's plan lacks: a 403 whose reason says so. */
export const isPlanRefusal = (error) => error?.status === 403 && error?.reason === PLAN_REASON;
const isMissing = (error) => error?.status === 404;
const notBuilt = (error) => error?.status === 501;

/** A feature the plan doesn't include reads as that, never as a failure. The server's own sentence says which feature. */
export function PlanState({ error }) {
  return (
    <EmptyState title="This isn’t on your plan">
      {error?.message || 'This needs a higher plan.'} Ask the Bhava team about moving to a plan that includes it.
    </EmptyState>
  );
}

/**
 * The states every Phase 3 screen has, in one place: loading, not on the plan, not there, not switched on, failed. `children` is
 * called with the loaded data. Pass `detail` on a page about one thing, so a missing thing reads as a page that isn't there.
 */
export function Screen({ query, label, errorTitle, detail, children }) {
  if (query.isPending) return <Spinner label={label} />;
  if (query.isError) {
    if (isPlanRefusal(query.error)) return <PlanState error={query.error} />;
    if (detail && isMissing(query.error)) return <NotFoundState />;
    if (notBuilt(query.error)) return <EmptyState title="This isn’t switched on yet">It will appear here as soon as it is ready for your business.</EmptyState>;
    return <ErrorState title={errorTitle} error={query.error} onRetry={() => query.refetch()} />;
  }
  return children(query.data);
}

/** Links between the pages of one area, as a row of pills that scrolls sideways on a phone. */
export function AreaTabs({ label, tabs, current }) {
  return (
    <nav className="chip-row p3-tabs" aria-label={label}>
      {tabs.map(([to, text]) => <Link key={to} className="chip" to={to} aria-current={to === current ? 'page' : undefined}>{text}</Link>)}
    </nav>
  );
}

/** A list of small badges; nothing when the list is empty. Each is { tone, text }. */
export function Badges({ items }) {
  if (!items.length) return null;
  return <span className="p3-badges">{items.map((item) => <Badge key={item.text} tone={item.tone}>{item.text}</Badge>)}</span>;
}

/** A short list of words (tags, option values, ticker lines) with a box to add one. A comma or Enter adds. */
export function WordList({ label, values, onChange, max, maxLength = 60, placeholder, error, hint }) {
  const add = (input) => {
    const words = input.value.split(',').map((word) => word.trim().slice(0, maxLength)).filter(Boolean);
    if (!words.length) return;
    onChange([...new Set([...values, ...words])].slice(0, max));
    input.value = '';
  };
  const note = error || hint;
  return (
    <div className="p3-words">
      <span className="field-label">{label}</span>
      {values.length > 0 && (
        <ul className="keyword-list" aria-label={label}>
          {values.map((value) => (
            <li key={value} className="keyword">
              {value}
              <button type="button" className="keyword-remove" aria-label={`Remove ${value}`} onClick={() => onChange(values.filter((other) => other !== value))}>×</button>
            </li>
          ))}
        </ul>
      )}
      <input
        className="field-control p3-words-input"
        aria-label={`Add to ${label.toLowerCase()}`}
        placeholder={placeholder}
        disabled={values.length >= max}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ',') return;
          event.preventDefault();
          add(event.currentTarget);
        }}
        onBlur={(event) => add(event.currentTarget)}
      />
      {note && <span className={error ? 'field-error' : 'field-hint'} role={error ? 'alert' : undefined}>{note}</span>}
    </div>
  );
}
