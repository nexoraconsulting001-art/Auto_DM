import { useState } from 'react';
import { Copy } from 'lucide-react';
import { Badge, Banner, Button, ListCard, PageHeader, TextField } from '../../../design/index.jsx';
import { ActionSheet, PagedRows, Secret, When, useAct, usePlatformList } from '../../kit.jsx';
import { api } from '../../api.js';
import { SignupSwitch } from './switch.jsx';

const MODE_NOTE = {
  closed: 'Nobody can sign up. Businesses are created by Bhava’s team only.',
  invite: 'Only people with an invite code can sign up.',
  public: 'Anyone can sign up.',
};

function InviteSheet({ open, onClose, onCreated }) {
  const act = useAct();
  const [note, setNote] = useState('');
  const [uses, setUses] = useState('1');
  const [days, setDays] = useState('');
  const maxUses = /^\d{1,5}$/.test(uses) ? Number(uses) : 0;
  const expiresInDays = days === '' ? undefined : /^\d{1,3}$/.test(days) ? Number(days) : 0;
  const valid = maxUses >= 1 && maxUses <= 10000 && (expiresInDays === undefined || (expiresInDays >= 1 && expiresInDays <= 365));
  return (
    <ActionSheet
      open={open}
      title="New invite code"
      needsReason={false}
      submitLabel="Make the code"
      valid={valid}
      onClose={onClose}
      onSubmit={async () => onCreated(await act(() => api.createSignupInvite({ body: { note, maxUses, ...(expiresInDays ? { expiresInDays } : {}) } }), 'The invite code is ready.'))}
    >
      <TextField label="Who it is for" value={note} maxLength={200} onChange={(event) => setNote(event.target.value)} />
      <TextField label="How many times it can be used" inputMode="numeric" value={uses} onChange={(event) => setUses(event.target.value)} error={maxUses < 1 ? 'Enter 1 to 10000' : undefined} />
      <TextField label="Good for how many days" inputMode="numeric" hint="Empty means it does not expire." value={days} onChange={(event) => setDays(event.target.value)} error={expiresInDays === 0 ? 'Enter 1 to 365' : undefined} />
    </ActionSheet>
  );
}

function InviteRow({ invite }) {
  const act = useAct();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const live = !invite.revokedAt && (!invite.expiresAt || new Date(invite.expiresAt) > new Date()) && invite.uses < invite.maxUses;
  async function revoke() {
    setBusy(true);
    setError('');
    try {
      await act(() => api.revokeSignupInvite({ params: { id: invite.id } }), 'The invite code is revoked.');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="list-row" data-testid={`invite-${invite.id}`}>
      <span className="list-row-main">
        <span className="list-row-title">{invite.note || 'No note'}</span>
        <span className="list-row-meta">{invite.uses} of {invite.maxUses} used · {invite.expiresAt ? <>until <When value={invite.expiresAt} /></> : 'does not expire'} · by {invite.createdBy}</span>
        {error && <span className="field-error" role="alert">{error}</span>}
      </span>
      <span className="pc-badges">
        <Badge tone={live ? 'good' : 'neutral'}>{invite.revokedAt ? 'Revoked' : live ? 'Live' : 'Used up or expired'}</Badge>
        {live && <Button variant="soft" loading={busy} onClick={revoke}>Revoke</Button>}
      </span>
    </div>
  );
}

export function SignupPage() {
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState(null);
  const invites = usePlatformList('signup-invites', api.signupInvites);
  return (
    <div className="stack">
      <PageHeader eyebrow="Bhava Console" title="Sign-up" actions={<Button onClick={() => setOpen(true)}>New invite code</Button>} />
      <SignupSwitch note={MODE_NOTE} facts={(signup) => [['Free businesses per Instagram account', String(signup.freePerInstagram)]]} />
      {created && (
        <Banner tone="good">
          <div className="stack" data-testid="new-invite">
            <span>The invite code is made. It is shown now and not again; only the start of it appears here. Copy it before you leave.</span>
            <Secret value={created.code} label="Invite code" />
          </div>
        </Banner>
      )}
      <PagedRows query={invites} empty="No invite codes" emptyText="Make a code to let one business, or a few, sign up while sign-up is invite only." label="Loading invite codes">
        {(items) => <ListCard>{items.map((invite) => <InviteRow key={invite.id} invite={invite} />)}</ListCard>}
      </PagedRows>
      <InviteSheet open={open} onClose={() => setOpen(false)} onCreated={setCreated} />
    </div>
  );
}
