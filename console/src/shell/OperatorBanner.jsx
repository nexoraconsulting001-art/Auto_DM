import { useEffect, useState } from 'react';

const SERVICE_LABELS = {
  reel_management: 'Reel management',
  reel_backlog: 'Reel backlog',
  merchandising: 'Store merchandising',
  catalog_management: 'Catalog management',
  performance_report: 'Performance report',
};

const clock = (ms) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
};

/**
 * Shown across the top of the console whenever Bhava's team opened this session (PRD 5.10, 5.17). It names the business
 * and the operator, says whether anything can be changed, and counts down. `operator` is session.operator from auth.me
 * (SessionOperator in src/contracts/api/ops.js); with none, nothing renders. When the time is up, or on "End session",
 * the session is signed out and the browser goes back to the Platform Console.
 */
export function OperatorBanner({ operator, business, onEnd }) {
  const [now, setNow] = useState(() => Date.now());
  const endsAt = operator ? new Date(operator.expiresAt).getTime() : 0;
  const left = endsAt - now;

  useEffect(() => {
    if (!operator) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [operator]);

  useEffect(() => {
    if (operator && left <= 0) onEnd();
  }, [operator, left, onEnd]);

  if (!operator) return null;
  const support = operator.kind === 'impersonation';
  const what = support
    ? operator.mode === 'write' ? 'Changes are on' : 'Read-only'
    : `${SERVICE_LABELS[operator.service] ?? 'Managed service'}, task ${operator.taskRef}${operator.mode === 'approve_first' ? ', changes wait for approval' : ''}`;

  return (
    <div className={`operator-banner ${support && operator.mode !== 'write' ? '' : 'operator-banner-write'}`} role="status">
      <p className="operator-banner-text">
        <strong>{support ? 'Bhava support' : 'Bhava team'}</strong>
        {`: ${operator.operatorName} is in ${business.name}${support ? ' as the owner' : ''}. ${what}. Ends in ${clock(left)}.`}
      </p>
      <button type="button" className="operator-banner-end" onClick={onEnd}>End session</button>
    </div>
  );
}
