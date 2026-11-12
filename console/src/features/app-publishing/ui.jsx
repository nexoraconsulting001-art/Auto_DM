import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Badge, Banner, EmptyState, TextAreaField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { PLATFORM_LABELS, failureText } from './rules.js';
import './app.css';

export { StoreScreen } from '../orders/shared/ui.jsx';

/** The pages of "My app", in the order a seller works through them. */
export const AREA_TABS = Object.freeze([
  ['/my-app', 'App details'],
  ['/my-app/stores', 'Store accounts'],
  ['/my-app/listing/android', 'Store listing'],
  ['/my-app/review', 'Review status'],
  ['/my-app/offers', 'Offers'],
  ['/my-app/push-keys', 'Push keys'],
]);

/** Links between the pages of this area, as a row of pills that scrolls sideways on a phone. */
export function AreaTabs({ current }) {
  return (
    <nav className="chip-row store-tabs" aria-label="My app">
      {AREA_TABS.map(([to, text]) => {
        const here = to === current || (current.startsWith('/my-app/listing') && to.startsWith('/my-app/listing'));
        return <Link key={to} className="chip" to={to} aria-current={here ? 'page' : undefined}>{text}</Link>;
      })}
    </nav>
  );
}

/** Shown for a platform the plan does not include. The server refuses the same call with 403, so this is only the explanation. */
export function UpgradePrompt({ platform, what = 'this' }) {
  return (
    <div className="myapp-upgrade" data-testid={`upgrade-${platform}`}>
      <Badge tone="warn">Not on your plan</Badge>
      <p><strong>{PLATFORM_LABELS[platform]} app</strong>: your plan does not include {what} for {PLATFORM_LABELS[platform]}. Ask the Bhava team about a plan that includes it, and it appears here.</p>
    </div>
  );
}

/** The app's details, shared by every page: what the plan includes and what is filled in. */
export function useAppConfig() {
  return useQuery({ queryKey: ['app-publishing', 'config'], queryFn: () => api.appPublishing.get() });
}

/** A form's text, its touched marks and the server's per-field refusals, with a save that shows the server's answer. */
export function useFields(initial) {
  const [values, setValues] = useState(initial);
  const [touched, setTouched] = useState({});
  const [server, setServer] = useState({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const set = useCallback((name, value) => {
    setValues((current) => ({ ...current, [name]: value }));
    setTouched((current) => ({ ...current, [name]: true }));
    setServer((current) => (current[name] ? { ...current, [name]: undefined } : current));
  }, []);
  const touchAll = useCallback((names) => setTouched(Object.fromEntries(names.map((name) => [name, true]))), []);

  /** Runs a save. Resolves to true when it worked; a refusal is shown on the fields it names. */
  const run = useCallback(async (action) => {
    setBusy(true);
    setServer({});
    setMessage('');
    try {
      await action();
      return true;
    } catch (error) {
      if (error?.cancelled) return false;
      const fields = {};
      for (const [path, text] of Object.entries(error?.fields ?? {})) fields[path.split('.')[0]] ??= text;
      setServer(fields);
      setMessage(failureText(error) || 'We could not save that. Please try again.');
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return { values, set, touched, touchAll, server, message, setMessage, busy, run, reset: setValues };
}

/** A box for a key or a pasted key file: masked as it is typed, kept out of autofill and spell check, and never filled from the server. */
export function SecretBox({ label, hint, error, ...rest }) {
  return (
    <TextAreaField
      label={label}
      hint={hint}
      error={error}
      className="field-control secret-text"
      autoComplete="off"
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      data-secret="true"
      {...rest}
    />
  );
}

/** A status from one of the [text, tone] tables in rules.js. */
export function Status({ table, value }) {
  const entry = table[value];
  return entry ? <Badge tone={entry[1]}>{entry[0]}</Badge> : null;
}

export function Note({ tone = 'info', children }) {
  return children ? <Banner tone={tone}>{children}</Banner> : null;
}

export function Empty({ title, children }) {
  return <EmptyState title={title}>{children}</EmptyState>;
}

/** The sentence under "never": what this area does and does not ask for. */
export function NoPasswords() {
  return (
    <p className="field-hint myapp-promise">
      We never ask for your Apple or Google password, sign-in or passcode. Keys you give us are stored encrypted and cannot be read back.
    </p>
  );
}
