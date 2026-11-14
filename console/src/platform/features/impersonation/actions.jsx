import { useState } from 'react';
import { Banner } from '../../../design/index.jsx';
import { ActionSheet, Countdown, useAct } from '../../kit.jsx';
import { api } from '../../api.js';

/**
 * Opens a business as its owner (5.10), read-only. The address that comes back is good for a minute and is opened by the
 * person, from a link: the console never opens it for them.
 */
export function ImpersonateSheet({ business, open, onClose, onStarted }) {
  const act = useAct();
  return (
    <ActionSheet
      open={open}
      title={`Open ${business.name} as its owner`}
      intro="You will see what the owner sees and cannot change anything. Everything you open is on the audit log with your reason."
      submitLabel="Start read-only session"
      onClose={onClose}
      onSubmit={async (reason) => onStarted?.(await act(() => api.impersonate({ params: { id: business.id }, body: { reason } }), 'The session has started.'))}
    />
  );
}

/** The link to the business's console, with the session's countdown. Shown straight after a start. */
export function StartedNote({ started, name }) {
  const [opened, setOpened] = useState(false);
  if (!started) return null;
  return (
    <Banner tone="good">
      <div className="stack">
        <span>Your session for {name} is ready. {started.session && <Countdown until={started.session.expiresAt} label="left" />}</span>
        <a className="btn btn-primary" href={started.url} target="_blank" rel="noopener noreferrer" onClick={() => setOpened(true)}>Open {name} as the owner</a>
        {opened && <span>The link works once and for a minute. Start a new session if it has expired.</span>}
      </div>
    </Banner>
  );
}
