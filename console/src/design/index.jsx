import { forwardRef, useId } from 'react';
import { X } from 'lucide-react';

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
export const Sheet = forwardRef(function Sheet({ title, children }, ref) {
  const close = (event) => event.currentTarget.closest('dialog').close();
  return (
    <dialog ref={ref} className="sheet" aria-label={title}>
      <div className="sheet-head">
        <h2>{title}</h2>
        <IconButton label="Close" onClick={close}><X size={20} aria-hidden="true" /></IconButton>
      </div>
      {children}
    </dialog>
  );
});
