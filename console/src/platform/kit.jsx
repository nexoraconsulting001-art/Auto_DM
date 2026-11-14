import { SESSION_KEY } from './api.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { Badge, Button, EmptyState, ErrorState, LoadMore, SelectField, Sheet, Spinner, TextAreaField } from '../design/index.jsx';
import { useFeedback } from '../components/feedback.jsx';
import { formatDateTime } from '../lib/format.js';
import { countdown, maskSecret, reasonProblem } from './lib/rules.js';
import { isMissing, listBusinesses } from './data.js';
import { allPlatformPages, mayCall } from './api.js';
import { usePlatformSession } from './session.jsx';

/** One list from the platform API, page by page: `list` is a client method such as api.businesses. */
export function usePlatformList(key, list, filters = {}, options = {}) {
  const query = useInfiniteQuery({
    queryKey: ['p', key, 'list', filters],
    queryFn: ({ pageParam }) => list({ query: { limit: 25, ...filters, cursor: pageParam } }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    ...options,
  });
  return Object.assign(query, { items: query.data?.pages.flatMap((page) => page.items) ?? [] });
}

/** A failure, in words: a part the server does not have yet reads as that, and anything else as the server's own answer. */
export function Failed({ error, onRetry }) {
  if (isMissing(error)) {
    return <EmptyState title="Not available on this server yet">This part of the console is built, but the server has not got what it needs. Nothing is wrong with your account.</EmptyState>;
  }
  return <ErrorState error={error} onRetry={onRetry} />;
}

/** A list's three states and its end: loading, failed (with the server's own words), empty, then the rows. */
export function PagedRows({ query, empty, emptyText, label = 'Loading', children }) {
  if (query.isPending) return <Spinner label={label} />;
  if (query.isError) return <Failed error={query.error} onRetry={() => query.refetch()} />;
  if (!query.items.length) return <EmptyState title={empty}>{emptyText}</EmptyState>;
  return (
    <>
      {children(query.items)}
      <LoadMore query={query} />
    </>
  );
}

/** One thing from the platform API with the three states in one place. */
export function useOne(key, load, options = {}) {
  return useQuery({ queryKey: ['p', ...key], queryFn: load, ...options });
}

export function QueryState({ query, label, children }) {
  if (query.isPending) return <Spinner label={label} />;
  if (query.isError) return <Failed error={query.error} onRetry={() => query.refetch()} />;
  return children(query.data);
}

/** Runs a change, then refreshes whatever is on screen and says it is done. Failures go to the caller to show. */
export function useAct() {
  const queries = useQueryClient();
  const { toast } = useFeedback();
  return useCallback(async (work, done) => {
    const result = await work();
    await queries.invalidateQueries({ predicate: (query) => query.queryKey[0] !== SESSION_KEY[0] });
    if (done) toast(done);
    return result;
  }, [queries, toast]);
}

/** Shows what is inside only to a role the route table allows: the rest is absent, not greyed out. */
export function Can({ route, children, fallback = null }) {
  const { session } = usePlatformSession();
  return mayCall(session?.user, route) ? children : fallback;
}

export function useCan() {
  const { session } = usePlatformSession();
  return useCallback((route) => mayCall(session?.user, route), [session]);
}

export function useNow(every = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}

export function When({ value, empty = '—' }) {
  if (!value) return empty;
  return <time dateTime={value}>{formatDateTime(value)}</time>;
}

/** A label and its value, one to a line. Rows with no value are left out. */
export function Facts({ rows }) {
  return (
    <dl className="facts">
      {rows.filter(([, value]) => value !== undefined && value !== null && value !== '').map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd className="facts-long">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function StatusBadge({ tone = 'neutral', children }) {
  return <Badge tone={tone}>{children}</Badge>;
}

/** A secret on screen: only its first characters, with a button that copies the whole of it. */
export function Secret({ value, label = 'Secret' }) {
  const { toast } = useFeedback();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast('Copied');
    } catch {
      toast('Copy didn’t work here. Try again from a secure page.');
    }
  };
  return (
    <span className="pc-secret-row">
      <code className="pc-masked" data-testid="masked-secret" aria-label={`${label}, hidden`}>{maskSecret(value)}</code>
      <Button variant="soft" onClick={copy} aria-label={`Copy ${label.toLowerCase()}`}><Copy size={16} aria-hidden="true" /> Copy</Button>
    </span>
  );
}

/** m:ss left of a session, counting down once a second. */
export function Countdown({ until, label = 'left' }) {
  const now = useNow(1000);
  const left = countdown(until, now);
  return <span className="pc-countdown" data-testid="countdown" role="timer" aria-label={left.over ? 'Ended' : `${left.label} ${label}`}>{left.over ? 'Ended' : `${left.label} ${label}`}</span>;
}

/**
 * A confirmation sheet for a change that must say why. The button stays off until the reason is written; pressing Enter
 * on an empty reason shows the same words the server would. Extra fields go in `children`, and `valid` holds the button until they are right.
 */
export function ActionSheet({ open, title, intro, submitLabel = 'Confirm', tone = 'primary', needsReason = true, reasonLabel = 'Reason', valid = true, onClose, onSubmit, children }) {
  const ref = useRef(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setText('');
      setError('');
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const blocked = (needsReason && reasonProblem(text) !== '') || !valid;

  async function submit(event) {
    event.preventDefault();
    const problem = needsReason ? reasonProblem(text) : '';
    if (problem) {
      setError(problem);
      return;
    }
    if (!valid) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit(text.trim());
      onClose();
    } catch (failure) {
      setError(failure?.message || 'That didn’t work. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet ref={ref} title={title} onClose={onClose}>
      <form className="stack" onSubmit={submit} noValidate>
        {intro && <p className="sheet-text">{intro}</p>}
        {children}
        {needsReason && (
          <TextAreaField label={reasonLabel} rows={3} maxLength={500} value={text} onChange={(event) => { setText(event.target.value); setError(''); }} error={error && reasonProblem(text) ? error : undefined} required />
        )}
        {error && !(needsReason && reasonProblem(text)) && <div className="field-error" role="alert">{error}</div>}
        <div className="sheet-actions">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant={tone} loading={busy} disabled={blocked}>{submitLabel}</Button>
        </div>
      </form>
    </Sheet>
  );
}

/** Every business, for a picker: the first few hundred, whole pages at a time. */
export function useBusinessOptions() {
  return useQuery({
    queryKey: ['p', 'businesses', 'options'],
    queryFn: async () => {
      const found = [];
      for await (const business of allPlatformPages(listBusinesses, { limit: 100 })) {
        found.push(business);
        if (found.length >= 500) break;
      }
      return found;
    },
    staleTime: 30_000,
  });
}

export function BusinessSelect({ label = 'Business', value, onChange, ...rest }) {
  const query = useBusinessOptions();
  if (query.isPending) return <Spinner label="Loading businesses" />;
  if (query.isError) return <Failed error={query.error} onRetry={() => query.refetch()} />;
  return (
    <SelectField label={label} value={value ?? ''} onChange={(event) => onChange(event.target.value)} {...rest}>
      <option value="">Choose a business</option>
      {query.data.map((business) => <option key={business.id} value={business.id}>{business.name}</option>)}
    </SelectField>
  );
}

/** What the server said, or what to do about it, for a failed page's state. */
export const refusalText = (error) => error?.message || 'That didn’t work. Try again.';
