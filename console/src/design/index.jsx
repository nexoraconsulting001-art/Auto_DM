import { forwardRef, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ImageOff, Search, X } from 'lucide-react';

/**
 * Base components of Neel and Haldi, mobile first. Tap targets are at least 44px. Build screens from these
 * and the names in tokens.css so every part of the console looks the same.
 */
const cx = (...names) => names.filter(Boolean).join(' ');

/** variant: primary, soft, outline, accent or danger. size: large for the main action of a screen. Pass `as={Link}` for a link. */
export function Button({ as: Tag = 'button', variant = 'primary', size, block, loading, disabled, className, children, ...rest }) {
  const buttonProps = Tag === 'button' ? { type: 'button', disabled: disabled || loading } : {};
  return (
    <Tag className={cx('btn', `btn-${variant}`, size === 'large' && 'btn-large', block && 'btn-block', className)} aria-busy={loading || undefined} {...buttonProps} {...rest}>
      {children}
    </Tag>
  );
}

/** `label` is required: an icon alone says nothing to a screen reader. */
export function IconButton({ label, children, className, ...rest }) {
  return <button type="button" className={cx('icon-btn', className)} aria-label={label} {...rest}>{children}</button>;
}

/** Holds one or more fields in a single rounded group. */
export function FieldGroup({ children }) {
  return <div className="field-group">{children}</div>;
}

function FieldShell({ label, hint, error, control }) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error || hint;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{label}</label>
      {control({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': note ? noteId : undefined })}
      {note && <span id={noteId} className={error ? 'field-error' : 'field-hint'}>{note}</span>}
    </div>
  );
}

export function TextField({ label, hint, error, ...rest }) {
  return <FieldShell label={label} hint={hint} error={error} control={(ids) => <input className="field-control" {...ids} {...rest} />} />;
}

export function TextAreaField({ label, hint, error, rows = 3, ...rest }) {
  return <FieldShell label={label} hint={hint} error={error} control={(ids) => <textarea className="field-control" rows={rows} {...ids} {...rest} />} />;
}

export function SelectField({ label, hint, error, children, ...rest }) {
  return <FieldShell label={label} hint={hint} error={error} control={(ids) => <select className="field-control" {...ids} {...rest}>{children}</select>} />;
}

export function Toggle({ label, ...rest }) {
  return (
    <label className="toggle">
      <span>{label}</span>
      <input className="toggle-input" type="checkbox" role="switch" {...rest} />
      <span className="toggle-track" aria-hidden="true" />
    </label>
  );
}

/** A pressable pill for filters and multi-choice. */
export function Chip({ pressed, children, ...rest }) {
  return <button type="button" className="chip" aria-pressed={Boolean(pressed)} {...rest}>{children}</button>;
}

export function Card({ ink, className, children, ...rest }) {
  return <section className={cx('card', ink && 'card-ink', className)} {...rest}>{children}</section>;
}

export function ListCard({ children, ...rest }) {
  return <section className="list-card" {...rest}>{children}</section>;
}

/** One row of a ListCard. Pass `as={Link}` and `to` to make it a link. */
export function ListRow({ as: Tag = 'div', leading, title, meta, trailing, ...rest }) {
  return (
    <Tag className="list-row" {...rest}>
      {leading}
      <span className="list-row-main">
        <span className="list-row-title">{title}</span>
        {meta && <span className="list-row-meta">{meta}</span>}
      </span>
      {trailing}
    </Tag>
  );
}

export function Stat({ value, label }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

/** tone: neutral, neel, good, warn, bad or ink. */
export function Badge({ tone = 'neutral', children }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/** tone: info, good, warn or bad. A bad banner is announced as soon as it appears. */
export function Banner({ tone = 'info', children }) {
  return <div className={`banner banner-${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>{children}</div>;
}

/** A business's logo or, without one, its initials. */
export function Avatar({ name, src }) {
  const initials = String(name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0].toUpperCase()).join('');
  return <span className="avatar" aria-hidden="true">{src ? <img src={src} alt="" /> : initials}</span>;
}

export function PageHeader({ eyebrow, title, actions }) {
  return (
    <header className="page-header">
      {eyebrow && <span className="eyebrow">{eyebrow}</span>}
      <div className="page-header-row">
        <h1>{title}</h1>
        {actions}
      </div>
    </header>
  );
}

export function EmptyState({ title, action, children }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading' }) {
  return (
    <div className="spinner" role="status">
      <span className="spinner-ring" aria-hidden="true" />
      {label}
    </div>
  );
}

/** A native modal dialog: use the ref's showModal() and close(). It traps focus and closes on Escape by itself. */
export const Sheet = forwardRef(function Sheet({ title, children, ...rest }, ref) {
  const close = (event) => event.currentTarget.closest('dialog').close();
  return (
    <dialog ref={ref} className="sheet" aria-label={title} {...rest}>
      <div className="sheet-head">
        <h2>{title}</h2>
        <IconButton label="Close" onClick={close}><X size={20} aria-hidden="true" /></IconButton>
      </div>
      {children}
    </dialog>
  );
});

/** Back to the list a page belongs to. */
export function BackLink({ to, children }) {
  return (
    <Link className="back-link" to={to}>
      <ArrowLeft size={16} strokeWidth={2} aria-hidden="true" />
      {children}
    </Link>
  );
}

/** A titled card: the building block of every screen and form. */
export function Panel({ title, action, children, ...rest }) {
  return (
    <Card {...rest}>
      {(title || action) && (
        <div className="panel-head">
          {title && <h2>{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </Card>
  );
}

/** A square picture, or a quiet placeholder when there is none or it won't load. */
export function Thumb({ src, alt = '', tall }) {
  const [failedSrc, setFailedSrc] = useState(null);
  const className = cx('thumb', tall && 'thumb-tall');
  if (!src || failedSrc === src) {
    return <span className={cx(className, 'thumb-empty')} aria-hidden="true"><ImageOff size={18} strokeWidth={1.6} /></span>;
  }
  return <img className={className} src={src} alt={alt} loading="lazy" onError={() => setFailedSrc(src)} />;
}

/** The same shape as EmptyState, for when the server let us down. "Try again" re-runs what failed. */
export function ErrorState({ title = 'We couldn’t load this', error, onRetry }) {
  return (
    <div role="alert">
      <EmptyState title={title} action={onRetry && <Button variant="soft" onClick={onRetry}>Try again</Button>}>
        {error?.message || 'Check your connection and try again.'}
      </EmptyState>
    </div>
  );
}

export function NotFoundState() {
  return <EmptyState title="We couldn’t find that page">It may have moved or been removed. Use the menu to carry on.</EmptyState>;
}

/** Not there, or a part of the API this server doesn't have yet. */
const isMissing = (error) => error?.status === 404 || error?.status === 501;

/**
 * The three states every screen has, in one place. `children` is called with the loaded data. Pass `detail`
 * on a page about one thing, so a missing thing reads as a page that isn't there rather than a failure.
 */
export function Loadable({ query, label, errorTitle, detail, children }) {
  if (query.isPending) return <Spinner label={label} />;
  if (query.isError) {
    if (detail && isMissing(query.error)) return <NotFoundState />;
    return <ErrorState title={errorTitle} error={query.error} onRetry={() => query.refetch()} />;
  }
  return children(query.data);
}

export function SearchField({ label, ...rest }) {
  return (
    <label className="search">
      <Search size={18} strokeWidth={1.8} aria-hidden="true" />
      <span className="sr-only">{label}</span>
      <input className="search-input" type="search" placeholder={label} {...rest} />
    </label>
  );
}

/** A row of filter chips that scrolls sideways on a phone instead of wrapping into a wall. */
export function ChipRow({ label, children }) {
  return <div className="chip-row" role="group" aria-label={label}>{children}</div>;
}

/** The end of a paged list. `query` is a usePagedList result. */
export function LoadMore({ query }) {
  if (!query.hasNextPage) return null;
  return <Button variant="soft" block loading={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>Load more</Button>;
}

/** Progress as a ring: `done` of `total`, with `label` read out by a screen reader. */
export function Ring({ done, total, label }) {
  const circumference = 2 * Math.PI * 26;
  const filled = total > 0 ? (done / total) * circumference : 0;
  return (
    <svg className="ring" width="64" height="64" viewBox="0 0 64 64" role="img" aria-label={label}>
      <circle className="ring-track" cx="32" cy="32" r="26" />
      <circle className="ring-fill" cx="32" cy="32" r="26" strokeDasharray={`${filled} ${circumference}`} transform="rotate(-90 32 32)" />
      <text className="ring-text" x="32" y="37" textAnchor="middle">{done}/{total}</text>
    </svg>
  );
}
