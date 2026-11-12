import { formatDate } from '../../lib/format.js';

/** What happens after "Delete my account" (PRD 10.6, P-26): asked, signed out everywhere, deleted on the due date unless they sign in first. */
export function DeletionTimeline({ requestedAt, dueAt }) {
  return (
    <ol className="acct-timeline">
      <li>
        <span className="acct-timeline-mark" aria-hidden="true" />
        <span className="acct-timeline-text">
          <strong>{`Asked on ${formatDate(requestedAt)}`}</strong>
          <span>Our team has been told, and it’s in each business’s activity record.</span>
        </span>
      </li>
      <li>
        <span className="acct-timeline-mark" aria-hidden="true" />
        <span className="acct-timeline-text">
          <strong>Signed out everywhere</strong>
          <span>Every phone and browser signed in to your account was signed out.</span>
        </span>
      </li>
      <li className="acct-timeline-later">
        <span className="acct-timeline-mark" aria-hidden="true" />
        <span className="acct-timeline-text">
          <strong>{`Deleted on ${formatDate(dueAt)}`}</strong>
          <span>Changed your mind? Sign in again before then and nothing is deleted.</span>
        </span>
      </li>
    </ol>
  );
}
