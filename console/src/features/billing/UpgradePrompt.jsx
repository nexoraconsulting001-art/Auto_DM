import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Link } from 'react-router-dom';
import { Sparkles, X } from 'lucide-react';
import { Banner, Button, IconButton } from '../../design/index.jsx';
import { isPlanProblem, promptText } from './contract.js';
import { REFUSAL_EVENT } from './upgrade-watch.js';
import './billing.css';

/** An upgrade prompt for a refusal an inline screen already holds. The server has refused; this says why and where to go. */
export function UpgradePrompt({ error, planNameOf }) {
  if (!isPlanProblem(error)) return null;
  const { title, body } = promptText(error, { planNameOf });
  return (
    <div className="p7-upgrade" data-testid="upgrade-prompt">
      <Sparkles size={20} aria-hidden="true" />
      <div className="p7-upgrade-text">
        <strong>{title}</strong>
        <span>{body}</span>
      </div>
      <Button as={Link} variant="accent" to="/billing">See plans</Button>
    </div>
  );
}

/** The console-wide prompt: a bar near the foot of the screen, outside the router, that the person can dismiss. */
export function UpgradeHost() {
  const [error, setError] = useState(null);
  useEffect(() => {
    const show = (event) => setError(event.detail);
    window.addEventListener(REFUSAL_EVENT, show);
    return () => window.removeEventListener(REFUSAL_EVENT, show);
  }, []);
  if (!error) return null;
  const { title, body } = promptText(error);
  return (
    <div className="p7-upgrade-bar" data-testid="upgrade-bar">
      <Banner tone="warn">
        <span className="p7-upgrade-bar-row">
          <span><strong>{title}.</strong> {body}</span>
          <a className="btn btn-accent" href={`${import.meta.env.BASE_URL}billing`}>See plans</a>
          <IconButton label="Dismiss" onClick={() => setError(null)}><X size={18} aria-hidden="true" /></IconButton>
        </span>
      </Banner>
    </div>
  );
}

let mounted = false;
export function mountUpgradeHost() {
  if (mounted || typeof document === 'undefined') return;
  mounted = true;
  const holder = document.createElement('div');
  holder.id = 'p7-upgrade-host';
  document.body.appendChild(holder);
  createRoot(holder).render(<UpgradeHost />);
}
