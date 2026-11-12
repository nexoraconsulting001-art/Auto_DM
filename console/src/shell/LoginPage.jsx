import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useFeedback } from '../components/feedback.jsx';
import { Banner, Button, Card, FieldGroup, Spinner, TextField } from '../design/index.jsx';
import { DeletionTimeline } from '../features/account/DeletionTimeline.jsx';
import { workspace } from '../features/account/live.js';
import { OPTIONS_KEY, useSignInOptions } from '../features/account/options.js';
import { CODE_DIGITS, clearDeletion, googleStartUrl, isCode, maskPhone, readDeletion, secondsLeft, toE164, webDevice } from '../features/account/signin.js';
import '../features/account/account.css';
import { SESSION_KEY, api } from '../lib/api/index.js';
import { useSession } from '../lib/session.jsx';

function tabStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function deviceStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Google's mark, drawn here so the page loads nothing from anyone else. */
function GoogleMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 7l7.4 5.7c4.3-4 6.9-9.9 6.9-17.2z" />
      <path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z" />
    </svg>
  );
}

const here = () => `${window.location.pathname}${window.location.search}`;

function GoogleButton() {
  return (
    <Button as="a" href={googleStartUrl({ next: here() })} variant="outline" size="large" block className="acct-google">
      <GoogleMark />
      Continue with Google
    </Button>
  );
}

/** The WhatsApp code: a number, then the code that went to it. */
function CodeSignIn({ google, onSignedIn, setError, onStep }) {
  const [step, setStepState] = useState('phone');
  const setStep = (next) => {
    setStepState(next);
    onStep?.(next);
  };
  const [phone, setPhone] = useState('');
  const [phoneProblem, setPhoneProblem] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(null);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);

  const wait = sent ? secondsLeft(sent.at, sent.resendInSeconds) : 0;
  useEffect(() => {
    if (!wait) return undefined;
    const timer = setTimeout(() => setTick((n) => n + 1), 1000);
    return () => clearTimeout(timer);
  });

  async function sendCode() {
    setError('');
    const e164 = toE164(phone);
    if (!e164) {
      setPhoneProblem('Enter your mobile number, such as 98765 43210, or with its country code.');
      return;
    }
    setPhoneProblem('');
    setBusy(true);
    try {
      const started = await api.auth.start({ phone: e164 });
      setSent({ at: Date.now(), resendInSeconds: started.resendInSeconds, to: e164 });
      setStep('code');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function verify(event) {
    event.preventDefault();
    setError('');
    if (!isCode(code.trim())) {
      setError(`Enter the ${CODE_DIGITS}-digit code from WhatsApp.`);
      return;
    }
    setBusy(true);
    try {
      workspace.forget();
      const session = await api.auth.verify({
        phone: sent.to,
        code: code.trim(),
        transport: 'cookie',
        device: webDevice({ storage: deviceStorage(), userAgent: navigator.userAgent }),
      });
      onSignedIn(session);
    } catch (failure) {
      setError(failure.message);
      setCode('');
      setBusy(false);
    }
  }

  if (step === 'phone') {
    return (
      <form className="stack" onSubmit={(event) => { event.preventDefault(); sendCode(); }} noValidate>
        <FieldGroup>
          <TextField
            label="WhatsApp number"
            name="whatsapp"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="98765 43210"
            hint="We send a 6-digit code from Bhava’s WhatsApp number."
            error={phoneProblem || undefined}
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
        </FieldGroup>
        <Button type="submit" size="large" block loading={busy}>Send code on WhatsApp</Button>
      </form>
    );
  }

  return (
    <form className="stack" onSubmit={verify} noValidate>
      <p className="acct-sent">
        {'We sent a code on WhatsApp to '}
        <strong>{maskPhone(sent.to)}</strong>
        . It works once, for 5 minutes.
      </p>
      <FieldGroup>
        <TextField
          label="6-digit code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={CODE_DIGITS}
          autoFocus
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
        />
      </FieldGroup>
      <Button type="submit" size="large" block loading={busy}>Sign in</Button>
      <div className="acct-help">
        <span>Didn’t get it?</span>
        <button type="button" className="acct-link-button" disabled={wait > 0 || busy} onClick={sendCode}>Send a new code</button>
        {wait > 0 && <span className="acct-footnote">{`You can ask again in ${wait} s.`}</span>}
        {google ? (
          <span>
            {'No WhatsApp on this number? '}
            <a href={googleStartUrl({ next: here() })}>Use Google sign-in</a>
          </span>
        ) : (
          <span>Codes only come on WhatsApp. Check that WhatsApp is set up on this number.</span>
        )}
        <button type="button" className="acct-link-button" onClick={() => { setStep('phone'); setCode(''); setError(''); }}>Use a different number</button>
      </div>
    </form>
  );
}

/** Phone and password, from Phase 0: shown only while this server still has it (PASSWORD_LOGIN). */
function PasswordSignIn({ setError }) {
  const { signIn } = useSession();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    workspace.forget();
    try {
      await signIn({ phone, password });
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2>Sign in with a password</h2>
      <p className="acct-footnote">This server still has the old sign-in, for tests and local runs.</p>
      <form className="stack" onSubmit={submit}>
        <FieldGroup>
          <TextField label="Mobile number" name="phone" type="tel" inputMode="numeric" autoComplete="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} />
          <TextField label="Password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </FieldGroup>
        <Button type="submit" size="large" block loading={busy}>Sign in</Button>
      </form>
    </Card>
  );
}

/**
 * Signing in to the console (PRD 5.11, 10.3; P-11, F-109, F-117, F-118): Bhava's page, with Continue with Google and a
 * 6-digit code on WhatsApp, and no SMS. The session is a cookie with CSRF, in a refresh family tied to this browser as
 * a device, so Settings > Devices lists it and can sign it out. The address stays put, so a deep link survives signing in.
 */
export function LoginPage() {
  const queries = useQueryClient();
  const { toast } = useFeedback();
  const options = useSignInOptions();
  const [error, setError] = useState('');
  const [ended] = useState(() => workspace.endedBecause());
  const [deletion] = useState(() => readDeletion(tabStorage()));
  const [codeStep, setCodeStep] = useState('phone');

  useEffect(() => {
    workspace.forget();
  }, []);

  function signedIn(session) {
    workspace.forget();
    workspace.clearEnded();
    clearDeletion(tabStorage());
    queries.removeQueries({ predicate: (query) => query.queryKey[0] !== SESSION_KEY[0] && query.queryKey[0] !== OPTIONS_KEY[0] });
    queries.setQueryData(SESSION_KEY, session);
    if (session.created) toast('Welcome to Bhava. Your creator page is ready to set up.');
  }

  const offers = options.data;
  const ways = offers ? [offers.google && 'Google', offers.whatsapp && 'a 6-digit code on WhatsApp'].filter(Boolean) : [];

  return (
    <main className="login">
      <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="Bhava" width="120" height="30" />
      <div className="stack">
        <h1 className="login-title">Run your business from here</h1>
        {ways.length > 0 && <p className="acct-intro">{`Sign in with ${ways.join(' or ')}.`}</p>}
      </div>
      {deletion ? (
        <Card>
          <h2>Your account will be deleted</h2>
          <DeletionTimeline requestedAt={deletion.requestedAt} dueAt={deletion.dueAt} />
        </Card>
      ) : ended === 'elsewhere' ? (
        <Banner tone="warn">You were signed out. This device was signed out of your account, or your access to the business changed. Sign in again to carry on.</Banner>
      ) : null}
      {error && <Banner tone="bad">{error}</Banner>}
      {options.isPending ? (
        <Card><Spinner label="Getting sign-in ready" /></Card>
      ) : (
        <>
          {(offers.google || offers.whatsapp) && (
            <Card>
              {offers.google && <GoogleButton />}
              {offers.google && offers.whatsapp && <div className="acct-or" aria-hidden="true">or</div>}
              {offers.whatsapp && <CodeSignIn google={offers.google} onSignedIn={signedIn} setError={setError} onStep={setCodeStep} />}
            </Card>
          )}
          {!offers.google && !offers.whatsapp && !offers.password && (
            <Banner tone="warn">Signing in isn’t available right now. Try again in a few minutes.</Banner>
          )}
          {offers.password && codeStep === 'phone' && <PasswordSignIn setError={setError} />}
        </>
      )}
    </main>
  );
}
