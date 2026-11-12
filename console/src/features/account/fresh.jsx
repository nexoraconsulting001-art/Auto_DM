import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Banner, Button, FieldGroup, Sheet, TextField } from '../../design/index.jsx';
import { SESSION_KEY, api } from '../../lib/api/index.js';
import { useSession } from '../../lib/session.jsx';
import { CODE_DIGITS, googleStartUrl, isCode, isFresh } from './signin.js';

/** What a caller gets when the person closes the re-auth sheet: nothing to report. */
export class Cancelled extends Error {
  constructor() {
    super('Cancelled');
    this.cancelled = true;
  }
}

export const isCancelled = (error) => Boolean(error?.cancelled);

const here = () => `${window.location.pathname}${window.location.search}`;

/**
 * Sensitive actions (PRD 5.11): the team, linking a way to sign in, deleting the account. The server refuses them with
 * `reauth_required` unless the session signed in or re-authed in the last few minutes, so this asks for a fresh
 * WhatsApp code first when the session says it is not fresh, and again if the server refuses anyway.
 *
 *   const fresh = useFresh();
 *   await fresh.run(() => api.team.update(id, body));   // throws Cancelled if the person closes the sheet
 *   return <>{...}{fresh.sheet}</>;
 *
 * `google` says whether "Sign in again with Google" may be offered, for someone whose account has no phone to send to.
 */
export function useFresh({ google = false } = {}) {
  const { session } = useSession();
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

  /** Opens the sheet and resolves once the session is fresh again. */
  const confirm = useCallback(() => new Promise((resolve, reject) => {
    waiting.current?.reject(new Cancelled());
    waiting.current = { resolve, reject };
    setStep('sending');
    send();
  }), [send]);

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

  const run = useCallback(async (action) => {
    if (isFresh(session?.freshUntil) === false) await confirm();
    try {
      return await action();
    } catch (error) {
      if (error?.code !== 'reauth_required') throw error;
      await confirm();
      return action();
    }
  }, [session?.freshUntil, confirm]);

  const sheet = (
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
  );

  return { run, sheet };
}
