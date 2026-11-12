import { useState } from 'react';
import { Banner, Button, TextField } from '../design/index.jsx';
import { api } from './api.js';
import { usePlatformSession } from './session.jsx';

const asset = (name) => `${import.meta.env.BASE_URL}${name}`;
const sayWhy = (error) => (error?.status === 501 ? 'Sign-in isn’t switched on for this server yet.' : error?.message || 'That didn’t work. Try again.');

/**
 * Console sign-in (PRD 5.5): the email, the code sent to it, then the authenticator. A first sign-in shows the secret to
 * add to an authenticator app, and afterwards the recovery codes, once. There is no password and no "remember me".
 */
export function SignIn() {
  const { signedIn } = usePlatformSession();
  const [step, setStep] = useState('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [totp, setTotp] = useState('');
  const [ticket, setTicket] = useState(null);
  const [done, setDone] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = (work) => async (event) => {
    event?.preventDefault();
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (failure) {
      setError(sayWhy(failure));
    } finally {
      setBusy(false);
    }
  };

  const sendCode = run(async () => {
    await api.signInStart({ body: { email } });
    setStep('code');
  });
  const checkCode = run(async () => {
    setTicket(await api.signInVerify({ body: { email, code } }));
    setStep('totp');
  });
  const checkTotp = run(async () => {
    const session = await api.signInTotp({ body: { ticket: ticket.ticket, code: totp } });
    if (session.recoveryCodes?.length) {
      setDone(session);
      setStep('recovery');
    } else {
      signedIn(session);
    }
  });

  return (
    <main className="pc-signin">
      <div className="pc-signin-card">
        <img className="pc-signin-logo" src={asset('logo.svg')} alt="Bhava" width="104" height="26" />
        <h1 className="pc-signin-title">Bhava Console</h1>
        {error && <Banner tone="bad">{error}</Banner>}

        {step === 'email' && (
          <form className="stack" onSubmit={sendCode} noValidate>
            <TextField label="Work email" type="email" autoComplete="username" inputMode="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
            <Button type="submit" size="large" block loading={busy}>Email me a code</Button>
          </form>
        )}

        {step === 'code' && (
          <form className="stack" onSubmit={checkCode} noValidate>
            <p>If that email is one of ours, a 6-digit code is on its way. It works for 10 minutes.</p>
            <TextField label="Code from the email" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} required />
            <Button type="submit" size="large" block loading={busy}>Continue</Button>
            <button type="button" className="pc-link-button" onClick={() => { setStep('email'); setCode(''); setError(''); }}>Use a different email</button>
          </form>
        )}

        {step === 'totp' && ticket && (
          <form className="stack" onSubmit={checkTotp} noValidate>
            {ticket.next === 'enrol' && ticket.enrol && (
              <>
                <p>Add this key to an authenticator app, then enter the 6-digit code it shows. The key is shown only now.</p>
                <div className="pc-secret" aria-label="Authenticator key">{ticket.enrol.secret}</div>
                <a href={ticket.enrol.otpauthUrl}>Open in an authenticator app on this device</a>
              </>
            )}
            <TextField
              label="Code from your authenticator"
              hint={ticket.next === 'totp' ? 'Lost your phone? Enter one of your recovery codes instead.' : undefined}
              autoComplete="one-time-code"
              value={totp}
              onChange={(event) => setTotp(event.target.value.trim())}
              required
            />
            <Button type="submit" size="large" block loading={busy}>Sign in</Button>
          </form>
        )}

        {step === 'recovery' && done && (
          <div className="stack">
            <p>Keep these recovery codes somewhere safe. Each works once if you lose your authenticator. They are not shown again.</p>
            <ul className="pc-codes">
              {done.recoveryCodes.map((item) => <li key={item}>{item}</li>)}
            </ul>
            <Button size="large" block onClick={() => signedIn({ user: done.user, csrf: done.csrf })}>I have saved them</Button>
          </div>
        )}
      </div>
    </main>
  );
}
