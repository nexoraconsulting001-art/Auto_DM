import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserRound } from 'lucide-react';
import { useFeedback } from '../../components/feedback.jsx';
import { Badge, Banner, Button, Chip, EmptyState, FieldGroup, Loadable, PageHeader, Panel, SelectField, Sheet, TextField } from '../../design/index.jsx';
import { SESSION_KEY, api } from '../../lib/api/index.js';
import { formatDate } from '../../lib/format.js';
import { useSession } from '../../lib/session.jsx';
import { isCancelled, useFresh } from '../account/fresh.jsx';
import '../account/account.css';
import { PERMISSIONS, PERMISSION_LABELS, ROLES, ROLE_HELP, ROLE_LABELS, changeOf, inviteProblems, lastOwnerLock, permissionSummary } from './rules.js';

const TEAM_KEY = ['team'];
const PAGE = 100;

/** Every member and every open invitation. Teams are small, so the whole list is read, and the last-owner check sees everyone. */
async function wholeTeam() {
  const items = [];
  let invites = [];
  let cursor;
  for (let page = 0; page < 20; page++) {
    const result = await api.team.list({ limit: PAGE, cursor });
    items.push(...result.items);
    if (page === 0) invites = result.invites;
    if (!result.nextCursor) return { items, invites, complete: true };
    cursor = result.nextCursor;
  }
  return { items, invites, complete: false };
}

/** Staff permissions as pressable chips: one press adds or takes away one. */
function PermissionPicker({ value, onChange, error }) {
  const toggle = (permission) => onChange(value.includes(permission) ? value.filter((p) => p !== permission) : [...value, permission]);
  return (
    <fieldset className="acct-fieldset">
      <legend>What they can do</legend>
      <div className="chip-wrap">
        {PERMISSIONS.map((permission) => (
          <Chip key={permission} pressed={value.includes(permission)} onClick={() => toggle(permission)}>{PERMISSION_LABELS[permission]}</Chip>
        ))}
      </div>
      {error && <span className="field-error" role="alert">{error}</span>}
    </fieldset>
  );
}

function InvitePanel({ fresh }) {
  const queries = useQueryClient();
  const { toast } = useFeedback();
  const [contact, setContact] = useState('');
  const [role, setRole] = useState('staff');
  const [permissions, setPermissions] = useState(['orders']);
  const [problems, setProblems] = useState({});
  const [refusal, setRefusal] = useState('');
  const invite = useMutation({
    mutationFn: (body) => fresh.run(() => api.team.invite(body)),
    onSuccess: async () => {
      setContact('');
      toast('Invitation saved. They join when they next sign in with it.');
      await queries.invalidateQueries({ queryKey: TEAM_KEY });
    },
    onError: (error) => {
      if (isCancelled(error)) return;
      setProblems(error.fields ?? {});
      setRefusal(error.message);
    },
  });

  function submit(event) {
    event.preventDefault();
    setRefusal('');
    const found = inviteProblems({ contact, role, permissions });
    setProblems(found);
    if (Object.keys(found).length) return;
    invite.mutate({ contact: contact.trim(), role, permissions: role === 'staff' ? permissions : [] });
  }

  return (
    <Panel title="Invite someone">
      <p className="muted">Add a phone number or the email of their Google account. They join this business when they sign in to Bhava with it. Nothing is sent to them, so let them know.</p>
      <form className="stack" onSubmit={submit} noValidate>
        {refusal && <Banner tone="bad">{refusal}</Banner>}
        <FieldGroup>
          <TextField label="Phone number or email" name="contact" autoComplete="off" maxLength={200} value={contact} error={problems.contact} onChange={(e) => setContact(e.target.value)} />
          <SelectField label="Role" name="role" value={role} hint={ROLE_HELP[role]} error={problems.role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </SelectField>
        </FieldGroup>
        {role === 'staff' && <PermissionPicker value={permissions} onChange={setPermissions} error={problems.permissions} />}
        <Button type="submit" loading={invite.isPending}>Send invitation</Button>
      </form>
    </Panel>
  );
}

/** Changing one person's role and permissions. The only owner cannot be made anything else here (F-49). */
function RoleSheet({ sheet, member, lock, fresh, onSaved }) {
  const [role, setRole] = useState(member?.role ?? 'staff');
  const [permissions, setPermissions] = useState(member?.permissions ?? []);
  const [problem, setProblem] = useState('');
  const save = useMutation({
    mutationFn: (body) => fresh.run(() => api.team.update(member.id, body)),
    onSuccess: (updated) => {
      sheet.current?.close();
      onSaved(updated);
    },
    onError: (error) => {
      if (!isCancelled(error)) setProblem(error.message);
    },
  });

  function submit(event) {
    event.preventDefault();
    setProblem('');
    if (role === 'staff' && !permissions.length) {
      setProblem('Choose at least one thing they can do.');
      return;
    }
    const body = changeOf(member, { role, permissions });
    if (!body) {
      sheet.current?.close();
      return;
    }
    save.mutate(body);
  }

  return (
    <form className="stack" onSubmit={submit} noValidate>
      {problem && <Banner tone="bad">{problem}</Banner>}
      {lock && <Banner tone="info">{lock}</Banner>}
      <FieldGroup>
        <SelectField label="Role" name="member-role" value={role} disabled={Boolean(lock)} hint={ROLE_HELP[role]} onChange={(e) => setRole(e.target.value)}>
          {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
        </SelectField>
      </FieldGroup>
      {role === 'staff' && <PermissionPicker value={permissions} onChange={setPermissions} />}
      <div className="sheet-actions">
        <Button variant="outline" onClick={() => sheet.current?.close()}>Cancel</Button>
        <Button type="submit" loading={save.isPending} disabled={Boolean(lock)}>Save changes</Button>
      </div>
    </form>
  );
}

function MemberRow({ member, lock, onEdit, onRemove, removing }) {
  return (
    <div className="acct-row">
      <span className="acct-row-icon" aria-hidden="true"><UserRound size={20} strokeWidth={1.8} /></span>
      <span className="acct-row-main">
        <span className="acct-row-title">{member.name || 'Team member'}</span>
        <span className="acct-row-meta">{[member.phone, `Joined ${formatDate(member.joinedAt)}`].filter(Boolean).join(' · ')}</span>
        <span className="acct-row-meta">{permissionSummary(member)}</span>
        <span className="acct-badges">
          <Badge tone={member.role === 'owner' ? 'neel' : 'neutral'}>{ROLE_LABELS[member.role]}</Badge>
          {member.you && <Badge tone="ink">You</Badge>}
          {!member.verified && <Badge tone="warn">Not signed in yet</Badge>}
        </span>
      </span>
      <span className="acct-row-actions">
        <Button variant="soft" onClick={() => onEdit(member)} aria-label={`Change role of ${member.name || 'this team member'}`}>Change role</Button>
        {!lock && <Button variant="outline" loading={removing} onClick={() => onRemove(member)} aria-label={`Remove ${member.name || 'this team member'}`}>Remove</Button>}
      </span>
    </div>
  );
}

function Members({ team, fresh }) {
  const queries = useQueryClient();
  const { confirm, toast } = useFeedback();
  const sheet = useRef(null);
  const [editing, setEditing] = useState(null);
  const [refusal, setRefusal] = useState('');
  const complete = team.complete;

  const remove = useMutation({
    mutationFn: (member) => fresh.run(() => api.team.remove(member.id)),
    onSuccess: async (_none, member) => {
      toast(`${member.name || 'They'} can no longer open this business. Their sessions have ended.`);
      if (member.you) await queries.invalidateQueries({ queryKey: SESSION_KEY });
      await queries.invalidateQueries({ queryKey: TEAM_KEY });
    },
    onError: (error) => {
      if (!isCancelled(error)) setRefusal(error.message);
    },
  });

  function edit(member) {
    setRefusal('');
    setEditing(member);
    requestAnimationFrame(() => sheet.current?.showModal());
  }

  async function askToRemove(member) {
    setRefusal('');
    const yourself = member.you;
    const yes = await confirm({
      title: yourself ? 'Leave this business?' : `Remove ${member.name || 'this person'}?`,
      text: yourself
        ? 'You will be signed out here and in the app at once, and you won’t be able to open this business again unless an owner invites you.'
        : 'They are signed out of the console and the app at once, on every phone and browser, and can no longer open this business.',
      confirm: yourself ? 'Leave' : 'Remove',
    });
    if (yes) remove.mutate(member);
  }

  async function saved(updated) {
    toast(`${updated.name || 'Their'} role is saved.`);
    if (updated.you) await queries.invalidateQueries({ queryKey: SESSION_KEY });
    await queries.invalidateQueries({ queryKey: TEAM_KEY });
  }

  const lockOf = (member) => lastOwnerLock(member, team.items, { complete });

  return (
    <Panel title="People">
      {refusal && <Banner tone="bad">{refusal}</Banner>}
      {team.items.length ? (
        <div className="acct-rows">
          {team.items.map((member) => (
            <MemberRow key={member.id} member={member} lock={lockOf(member)} onEdit={edit} onRemove={askToRemove} removing={remove.isPending && remove.variables?.id === member.id} />
          ))}
        </div>
      ) : (
        <EmptyState title="No one on the team yet">Invite people above, and they appear here once they sign in.</EmptyState>
      )}
      <Sheet ref={sheet} title={editing ? `Role of ${editing.name || 'this team member'}` : 'Change role'} onClose={() => setEditing(null)}>
        {editing && <RoleSheet key={editing.id} sheet={sheet} member={editing} lock={lockOf(editing)} fresh={fresh} onSaved={saved} />}
      </Sheet>
    </Panel>
  );
}

function Invites({ invites }) {
  return (
    <Panel title="Waiting to join">
      {invites.length ? (
        <>
          <div className="acct-rows">
            {invites.map((invite) => (
              <div key={invite.id} className="acct-row">
                <span className="acct-row-main">
                  <span className="acct-row-title">{invite.contact}</span>
                  <span className="acct-row-meta">{`${ROLE_LABELS[invite.role]} · asked ${formatDate(invite.createdAt)} · open until ${formatDate(invite.expiresAt)}`}</span>
                  {invite.role === 'staff' && <span className="acct-row-meta">{permissionSummary(invite)}</span>}
                </span>
              </div>
            ))}
          </div>
          <p className="acct-footnote">An invitation is open for 7 days. Inviting the same number or email again replaces it.</p>
        </>
      ) : (
        <EmptyState title="No open invitations">People you invite show here until they sign in.</EmptyState>
      )}
    </Panel>
  );
}

/** Settings > Team (PRD 5.11): who works at this business, their roles and permissions, invitations, removing someone. Owner only. */
export default function TeamPage() {
  const { session } = useSession();
  const team = useQuery({ queryKey: TEAM_KEY, queryFn: wholeTeam });
  const fresh = useFresh();
  return (
    <>
      <PageHeader eyebrow="Settings" title="Team" />
      <p className="lead">{`The people who help run ${session.business.name}. Changes here ask you to confirm it’s you first, and removing someone signs them out everywhere at once.`}</p>
      <InvitePanel fresh={fresh} />
      <Loadable query={team} label="Loading your team" errorTitle="We couldn’t load your team">
        {(data) => (
          <>
            <Members team={data} fresh={fresh} />
            <Invites invites={data.invites} />
          </>
        )}
      </Loadable>
      {fresh.sheet}
    </>
  );
}
