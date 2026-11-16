import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Banner, Button, FieldGroup, Sheet, TextField } from '../../design/index.jsx';
import { SESSION_KEY, api } from '../../lib/api/index.js';
import { Cancelled, confirmFresh, isCancelled, setFreshOpener } from '../../lib/fresh-gate.js';
import { useSession } from '../../lib/session.jsx';
import { OPTIONS_KEY, signInOptions } from './options.js';
import { CODE_DIGITS, googleStartUrl, isCode, isFresh } from './signin.js';

export { Cancelled, isCancelled };

const here = () => `${window.location.pathname}${window.location.search}`;

/**
 * The one "Confirm it’s you" sheet for the whole signed-in console (PRD 5.11). Every route the contract marks `fresh`
 * (money, keys, connections, the team, deleting the account) is refused with `reauth_required` unless the session signed
 * in or re-authed in the last few minutes. The console's API client hands any such refusal to lib/fresh-gate.js, which
 * opens this sheet, and repeats the call once a fresh WhatsApp code is confirmed. So every page is covered without
 * asking. "Sign in again with Google" is offered to someone with no phone to send to, when this server offers Google.
 */
export function FreshProvider({ children }) {
  const queries = useQueryClient();
  const dialog = useRef(null);
  const waiting = useRef(null);
  const [step, setStep] = useState('idle');
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  const settle = useCallback((outcome) => {
    const pending = waiting.current;
    waiting.current = null;
    if (dialog.current?.open) dialog.current.close();
    setStep('idle');
    setCode('');
    setProblem('');
    if (outcome === true) pending?.resolve();
    else pending?.reject(new Cancelled());
  }, []);

  const send = useCallback(async () => {
    setBusy(true);
    setProblem('');
    try {
      const started = await api.auth.reauthStart();
      setStep(started.sent ? 'code' : 'no-phone');
    } catch (error) {
      setStep('failed');
      setProblem(error.message);
    } finally {
      setBusy(false);
    }
  }, []);

  /** Opens the sheet and resolves once the session is fresh again. Calls refused together share one sheet. */
  const confirm = useCallback(() => {
    if (waiting.current) return waiting.current.promise;
    const pending = {};
    pending.promise = new Promise((resolve, reject) => Object.assign(pending, { resolve, reject }));
    waiting.current = pending;
    setStep('sending');
    send();
    return pending.promise;
  }, [send]);

  useEffect(() => setFreshOpener(confirm), [confirm]);
  const options = useQuery({ queryKey: OPTIONS_KEY, queryFn: signInOptions, staleTime: Infinity, retry: false, enabled: step === 'no-phone' });
  const google = Boolean(options.data?.google);

  useEffect(() => {
    if (step !== 'idle' && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [step]);
  useEffect(() => () => waiting.current?.reject(new Cancelled()), []);

  async function verify(event) {
    event.preventDefault();
    if (!isCode(code.trim())) {
      setProblem(`Enter the ${CODE_DIGITS}-digit code from WhatsApp.`);
      return;
    }
    setBusy(true);
    setProblem('');
    try {
      const { freshUntil } = await api.auth.reauthVerify({ code: code.trim() });
      queries.setQueryData(SESSION_KEY, (current) => (current ? { ...current, freshUntil } : current));
      settle(true);
    } catch (error) {
      setProblem(error.fields?.code ?? error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {children}
    <Sheet ref={dialog} title="Confirm it’s you" onClose={() => settle(false)}>
      {step === 'sending' && <p className="sheet-text" role="status">Sending a code to your WhatsApp…</p>}
      {step === 'code' && (
        <form className="stack" onSubmit={verify} noValidate>
          <p className="sheet-text">This change needs a fresh check. We sent a {CODE_DIGITS}-digit code to your WhatsApp number.</p>
          {problem && <Banner tone="bad">{problem}</Banner>}
          <FieldGroup>
            <TextField label="Code from WhatsApp" name="reauth-code" inputMode="numeric" autoComplete="one-time-code" maxLength={CODE_DIGITS} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          </FieldGroup>
          <div className="sheet-actions">
            <Button variant="outline" loading={busy} onClick={send}>Send a new code</Button>
            <Button type="submit" loading={busy}>Confirm</Button>
          </div>
        </form>
      )}
      {step === 'no-phone' && (
        <div className="stack">
          <p className="sheet-text">Your account has no WhatsApp number to send a code to. Sign in again to confirm this change, or add a number under Your account.</p>
          <div className="sheet-actions">
            <Button variant="outline" onClick={() => settle(false)}>Not now</Button>
            {google && <Button as="a" href={googleStartUrl({ next: here() })}>Sign in again with Google</Button>}
          </div>
        </div>
      )}
      {step === 'failed' && (
        <div className="stack">
          <Banner tone="bad">{problem || 'We couldn’t send a code. Try again.'}</Banner>
          <div className="sheet-actions">
            <Button variant="outline" onClick={() => settle(false)}>Not now</Button>
            <Button loading={busy} onClick={send}>Try again</Button>
          </div>
        </div>
      )}
    </Sheet>
    </>
  );
}

/**
 * For a page that knows its action is sensitive: asks first when the session already says it is not fresh, so the
 * person is not refused mid-way through a multi-step change. A refusal from the server is handled by the client anyway.
 *
 *   const fresh = useFresh();
 *   await fresh.run(() => api.team.update(id, body));   // throws Cancelled if the person closes the sheet
 *
 * The sheet itself is FreshProvider's, mounted once for the whole console.
 */
export function useFresh() {
  const { session } = useSession();
  const run = useCallback(async (action) => {
    if (isFresh(session?.freshUntil) === false && !(await confirmFresh())) throw new Cancelled();
    return action();
  }, [session?.freshUntil]);
  return { run };
}
