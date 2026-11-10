import { useCallback, useId, useMemo, useState } from 'react';
import { Link, NavLink, useSearchParams } from 'react-router-dom';
import { Info } from 'lucide-react';
import { Banner, Button, Chip, ChipRow, EmptyState, ErrorState, NotFoundState, Spinner, TextField } from '../../../design/index.jsx';
import { formatDateTime } from '../../../lib/format.js';
import { FIGURE_TEXT } from './catalog.js';
import { RANGE_CHOICES, checkCustomRange, chartSummary, linePath, rangeFrom } from './figures.js';
import { formatCount, formatDay, sourceLabel } from './words.js';
import './analytics.css';

/** Every figure carries one of the three labels of PRD 7.15. `onInk` for the dark hero card. */
export function SourceTag({ source, onInk = false }) {
  const label = sourceLabel(source);
  if (!label) return null;
  return <span className={`an-source an-source-${source}${onInk ? ' an-source-on-ink' : ''}`}>{label}</span>;
}

/** "Last updated 4 Nov, 3:05 pm", or that nothing has been fetched yet. Every figure shows when it was last updated (7.8). */
export function LastUpdated({ at, prefix = 'Last updated' }) {
  return <span className="an-updated">{at ? `${prefix} ${formatDateTime(at)}` : 'Not updated yet'}</span>;
}

/** The estimated-metric note (7.1), as a disclosure so it works on a phone, where a hover tooltip never shows. */
export function EstimatedNote({ onInk = false }) {
  return (
    <details className={`an-estimated${onInk ? ' an-estimated-on-ink' : ''}`}>
      <summary><Info size={14} strokeWidth={2} aria-hidden="true" />Estimated</summary>
      <span>{FIGURE_TEXT.estimated}</span>
    </details>
  );
}

/** Links between the screens of one area, as chips that scroll sideways on a phone. */
export function SectionTabs({ label, links }) {
  return (
    <nav aria-label={label}>
      <div className="chip-row an-tabs">
        {links.map((link) => (
          <NavLink key={link.to} className="chip" to={link.to} end={link.end ?? true}>{link.label}</NavLink>
        ))}
      </div>
    </nav>
  );
}

export const INSIGHTS_LINKS = Object.freeze([
  { to: '/analytics', label: 'Instagram' },
  { to: '/analytics/content', label: 'Posts and reels', end: false },
  { to: '/analytics/stories', label: 'Stories' },
  { to: '/analytics/audience', label: 'Audience' },
  { to: '/analytics/top', label: 'Top content' },
  { to: '/analytics/funnels', label: 'Funnels', end: false },
  { to: '/analytics/sources', label: 'Sales sources' },
]);
export const InsightsTabs = () => <SectionTabs label="Insights sections" links={INSIGHTS_LINKS} />;

export const TRAFFIC_LINKS = Object.freeze([
  { to: '/traffic', label: 'Overview' },
  { to: '/explore', label: 'Explore' },
  { to: '/funnels', label: 'Funnels', end: false },
  { to: '/cohorts', label: 'Cohorts' },
  { to: '/traffic/tags', label: 'Pixels and tags' },
]);
export const TrafficTabs = () => <SectionTabs label="Traffic sections" links={TRAFFIC_LINKS} />;

export const SAFETY_LINKS = Object.freeze([
  { to: '/reach-guard', label: 'Reach Guard' },
  { to: '/account-health', label: 'Account Health' },
]);
export const SafetyTabs = () => <SectionTabs label="Account safety" links={SAFETY_LINKS} />;

export const REPORT_LINKS = Object.freeze([
  { to: '/reports', label: 'Reports and files' },
  { to: '/reports/scheduled', label: 'Scheduled' },
  { to: '/settings/api-keys', label: 'API keys' },
]);
export const ReportTabs = () => <SectionTabs label="Reports sections" links={REPORT_LINKS} />;

const isMissing = (error) => error?.status === 404;

/**
 * Loading, failed and ready, like the console's Loadable, plus the states analytics has of its own: a part not switched on yet (501) reads
 * as "not available yet" rather than a failure, and a refusal says why ("Owner only.", a plan) instead of offering a retry that can't work.
 */
export function AnalyticsLoadable({ query, label, errorTitle, detail, children }) {
  if (query.isPending) return <Spinner label={label} />;
  if (query.isError) {
    const { error } = query;
    if (error?.status === 501) return <NotYetState />;
    if (error?.status === 403) return <RefusedState message={error.message} />;
    if (detail && isMissing(error)) return <NotFoundState />;
    return <ErrorState title={errorTitle} error={error} onRetry={() => query.refetch()} />;
  }
  return children(query.data);
}

export function NotYetState({ title = 'Not available yet' }) {
  return <EmptyState title={title}>This part of Bhava isn’t switched on for your account yet. It shows here as soon as it is.</EmptyState>;
}

export function RefusedState({ message }) {
  const ownerOnly = message === FIGURE_TEXT.ownerOnly;
  return <EmptyState title={ownerOnly ? 'Owner only' : 'Not included for you'}>{ownerOnly ? 'Only the owner of this business can open this.' : message || 'Ask the owner of this business if you need it.'}</EmptyState>;
}

/** Insights denied, or the connection lost: Analytics and Reach Guard say "Permission needed" and how to fix it (7.6, 7.7, N-34). */
export function PermissionNeeded({ channel = 'Instagram' }) {
  return (
    <div className="an-permission">
      <Banner tone="warn">{`Permission needed. Bhava can’t read your ${channel} insights right now, so these figures stop updating and automations run in slow mode.`}</Banner>
      <Button as={Link} to="/connect" variant="soft">{`Reconnect ${channel}`}</Button>
    </div>
  );
}

// ---- date ranges ---------------------------------------------------------------------------------------------------------

/** The date range lives in the address, so the back button and a shared link keep it. */
export function useRange(fallback = '28') {
  const [params, setParams] = useSearchParams();
  const query = useMemo(() => rangeFrom(params, fallback), [params, fallback]);
  const asked = params.get('range') ?? '';
  const setRange = useCallback((next) => {
    setParams((current) => {
      const out = new URLSearchParams(current);
      for (const key of ['range', 'from', 'to']) out.delete(key);
      if (next.range && next.range !== fallback) out.set('range', next.range);
      if (next.range === 'custom') {
        out.set('from', next.from);
        out.set('to', next.to);
      }
      return out;
    }, { replace: true });
  }, [setParams, fallback]);
  return [query, setRange, asked];
}

/** 7, 28 or 90 days, or two dates. A custom range is only applied once it's whole and in order. */
export function RangeBar({ query, onChange, asked, label = 'Date range' }) {
  const [custom, setCustom] = useState(asked === 'custom' || query.range === 'custom');
  const [from, setFrom] = useState(query.from ?? '');
  const [to, setTo] = useState(query.to ?? '');
  const [errors, setErrors] = useState(null);

  function apply(event) {
    event.preventDefault();
    const found = checkCustomRange(from, to);
    setErrors(found);
    if (!found) onChange({ range: 'custom', from, to });
  }

  return (
    <div className="an-range">
      <ChipRow label={label}>
        {RANGE_CHOICES.map((choice) => (
          <Chip
            key={choice.value}
            pressed={choice.value === 'custom' ? custom : !custom && query.range === choice.value}
            onClick={() => {
              if (choice.value === 'custom') {
                setCustom(true);
                return;
              }
              setCustom(false);
              setErrors(null);
              onChange({ range: choice.value });
            }}
          >
            {choice.label}
          </Chip>
        ))}
      </ChipRow>
      {custom && (
        <form className="an-range-custom" onSubmit={apply} noValidate>
          <TextField label="From" type="date" value={from} error={errors?.from} onChange={(event) => setFrom(event.target.value)} />
          <TextField label="To" type="date" value={to} error={errors?.to} onChange={(event) => setTo(event.target.value)} />
          <Button type="submit" variant="soft">Show these dates</Button>
        </form>
      )}
    </div>
  );
}

// ---- figures -------------------------------------------------------------------------------------------------------------

/** One figure in a tile: the value or the reason there isn't one, its label, and a note such as a gap or a change. */
export function FigureTile({ label, value, note, source, extra, pressed, onSelect }) {
  const body = (
    <>
      <span className="an-tile-label">{label}</span>
      <span className="an-tile-value">{value}</span>
      {note && <span className="an-tile-note">{note}</span>}
      {source && <SourceTag source={source} />}
    </>
  );
  if (onSelect) {
    return (
      <div className="an-tile-wrap">
        <button type="button" className="an-tile an-tile-button" aria-pressed={Boolean(pressed)} onClick={onSelect}>{body}</button>
        {extra}
      </div>
    );
  }
  return <div className="an-tile">{body}{extra}</div>;
}

/** Bars for a breakdown, each with its share. `format` writes the value. */
export function BarList({ items, format = formatCount, label }) {
  if (!items?.length) return <p className="muted">{FIGURE_TEXT.noData}</p>;
  const max = Math.max(...items.map((item) => item.value), 0);
  return (
    <ul className="an-bars" aria-label={label}>
      {items.map((item) => (
        <li key={item.key} className="an-bar">
          <span className="an-bar-row">
            <span className="an-bar-name">{item.label}</span>
            <span className="an-bar-value">{format(item.value)}{item.note ? <span className="an-bar-note"> {item.note}</span> : null}</span>
          </span>
          <span className="an-bar-track" aria-hidden="true"><span className="an-bar-fill" style={{ width: `${max > 0 ? Math.max(2, (item.value / max) * 100) : 0}%` }} /></span>
        </li>
      ))}
    </ul>
  );
}

/** Weekday by two-hour block. `grid` is heatmap() from figures.js. */
export function Heatmap({ grid, label, unit = 'sessions' }) {
  const titleId = useId();
  return (
    <figure className="an-heat" aria-labelledby={titleId}>
      <figcaption id={titleId} className="sr-only">{label}{grid.peak ? `. Busiest: ${grid.peak.label}.` : '.'}</figcaption>
      <div className="an-heat-hours" aria-hidden="true">
        <span /><span>12am</span><span>6am</span><span>12pm</span><span>6pm</span>
      </div>
      {grid.rows.map((row) => (
        <div key={row.weekday} className="an-heat-row">
          <span className="an-heat-day" aria-hidden="true">{row.label}</span>
          {row.cells.map((cell) => (
            <span key={cell.block} className={`an-heat-cell an-heat-${cell.level}`} title={`${cell.label}: ${formatCount(cell.value)} ${unit}`} aria-hidden="true" />
          ))}
        </div>
      ))}
      <div className="an-heat-key" aria-hidden="true">
        Fewer
        {[1, 2, 3, 4].map((level) => <span key={level} className={`an-heat-cell an-heat-${level}`} />)}
        More
      </div>
    </figure>
  );
}

/**
 * A line per day, gaps left as gaps. The last `mayChange` days are drawn dashed and dotted, because Meta may still revise them (7.1).
 * `previous` is the comparison period, dashed. The chart is described in words for a screen reader.
 */
export function LineChart({ days, previous, label, mayChange = 0, onInk = false, height = 96 }) {
  const values = (days ?? []).map((d) => (d.state === undefined || d.state === 'ok' ? d.value : null));
  const prevValues = previous ?? null;
  const max = Math.max(1, ...values.filter((v) => typeof v === 'number'), ...(prevValues ?? []).filter((v) => typeof v === 'number'));
  const settledCount = Math.max(0, values.length - mayChange);
  const settled = linePath(values.map((v, i) => (i < settledCount ? v : null)), { height, max });
  const recent = linePath(values.map((v, i) => (i >= Math.max(0, settledCount - 1) ? v : null)), { height, max });
  const before = prevValues ? linePath(prevValues, { height, max }) : null;
  const last = settled.points.concat(recent.points).at(-1);
  return (
    <figure className={`an-chart${onInk ? ' an-chart-on-ink' : ''}`}>
      <svg viewBox={`0 0 320 ${height}`} width="100%" height={height} preserveAspectRatio="none" role="img" aria-label={chartSummary(label, days)}>
        <path d={`M0 ${height * 0.17}H320M0 ${height / 2}H320M0 ${height * 0.83}H320`} className="an-chart-grid" />
        {before?.d && <path d={before.d} className="an-chart-previous" />}
        {settled.d && <path d={settled.d} className="an-chart-line" />}
        {mayChange > 0 && recent.d && <path d={recent.d} className="an-chart-line an-chart-recent" />}
        {last && <circle cx={last.x} cy={last.y} r="4" className="an-chart-dot" />}
      </svg>
      {(days?.length ?? 0) > 0 && (
        <figcaption className="an-chart-axis">
          <span>{formatDay(days[0].day)}</span>
          {previous && <span className="an-chart-legend"><span className="an-key an-key-line" />This period <span className="an-key an-key-previous" />Before</span>}
          {!previous && mayChange > 0 && <span className="an-chart-legend"><span className="an-key an-key-recent" />{FIGURE_TEXT.mayChange}</span>}
          <span>{formatDay(days.at(-1).day)}</span>
        </figcaption>
      )}
    </figure>
  );
}
