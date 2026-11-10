import { useState } from 'react';
import { Banner, Button, Card, FieldGroup, TextField } from '../design/index.jsx';
import { useSession } from '../lib/session.jsx';

export function LoginPage() {
  const { signIn } = useSession();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await signIn({ phone, password });
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="Bhava" width="120" height="30" />
      <h1 className="login-title">Run your business from here</h1>
      <Card>
        <form className="stack" onSubmit={submit}>
          {error && <Banner tone="bad">{error}</Banner>}
          <FieldGroup>
            <TextField label="Mobile number" name="phone" type="tel" inputMode="numeric" autoComplete="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} />
            <TextField label="Password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </FieldGroup>
          <Button type="submit" size="large" block loading={busy}>Sign in</Button>
        </form>
      </Card>
    </main>
  );
}
