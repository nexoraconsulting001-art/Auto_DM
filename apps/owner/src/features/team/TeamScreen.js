import React, { useState } from 'react';
import { View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core';
import { PERMISSIONS } from '@bhava/app-core/access';
import { Badge, Banner, Button, Card, Choices, ConfirmSheet, Divider, Field, ListRow, Screen, Section, Sheet, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { TEAM_ROLES, inviteBody } from '../orders/kit/forms.js';
import { isOnlyOwner, teamBody } from '../orders/kit/rules.js';
import { ActionMessages, ManyChoices, Offline, RecordView, formatWhenAt, useAction, useForm, useProblem, useWritable } from '../orders/kit/ui.js';

const TEAM = ['team'];

/**
 * The team (PRD 5.11; F-46, F-47, F-49): owners, managers and staff with the permissions they hold, and open
 * invitations. Owner only. Inviting, changing a role or removing someone needs a fresh check, and removing someone signs
 * them out everywhere at once. A business always keeps an owner: the only owner cannot be demoted or removed.
 */
export default function TeamScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const team = useQuery({ queryKey: TEAM, queryFn: () => api.team.list({ limit: 100 }) });
  return (
    <Screen testID="screen-team" title={t('team.title')}>
      <Offline />
      <RecordView query={team} testID="team">
        {(data) => <Team members={data.items ?? []} invites={data.invites ?? []} />}
      </RecordView>
    </Screen>
  );
}

function roleLine(t, member) {
  const role = t(`team.role.${member.role}`);
  if (member.role !== 'staff') return role;
  return member.permissions?.length ? `${role} · ${member.permissions.map((p) => t(`team.permission.${p}`)).join(', ')}` : `${role} · ${t('team.noPermissions')}`;
}

function Team({ members, invites }) {
  const { t, locale } = useStrings();
  const theme = useTheme();
  const writable = useWritable();
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState(null);
  return (
    <View style={{ gap: theme.space[4] }}>
      <Button testID="team-invite" label={t('team.invite')} disabled={!writable} onPress={() => setInviting(true)} />
      <Card testID="team-members">
        {members.map((member, i) => (
          <View key={member.id}>
            {i > 0 ? <Divider /> : null}
            <ListRow
              testID={`member-${member.id}`}
              title={member.you ? t('team.you', { name: member.name }) : member.name}
              subtitle={[roleLine(t, member), member.phone, member.verified ? null : t('team.unverified')].filter(Boolean).join(' · ')}
              end={member.role === 'owner' ? <Badge tone="primary" label={t('team.role.owner')} /> : null}
              onPress={() => setEditing(member)}
            />
          </View>
        ))}
      </Card>
      {invites.length ? (
        <Section title={t('team.invites')} testID="team-invites">
          <Card>
            {invites.map((invite) => <ListRow key={invite.id} testID={`invite-${invite.id}`} title={invite.contact} subtitle={[roleLine(t, invite), t('team.expires', { when: formatWhenAt(invite.expiresAt, locale) })].join(' · ')} />)}
          </Card>
        </Section>
      ) : null}
      {inviting ? <InviteSheet onClose={() => setInviting(false)} /> : null}
      {editing ? <MemberSheet key={editing.id} member={editing} members={members} onClose={() => setEditing(null)} /> : null}
    </View>
  );
}

function PermissionChoices({ value, onChange, disabled, testID }) {
  const { t } = useStrings();
  return <ManyChoices testID={testID} value={value} onChange={onChange} disabled={disabled} options={PERMISSIONS.map((p) => ({ value: p, label: t(`team.permission.${p}`), hint: t(`team.permission.${p}.hint`) }))} />;
}

function InviteSheet({ onClose }) {
  const { api } = useServices();
  const { t } = useStrings();
  const writable = useWritable();
  const form = useForm({ contact: '', role: 'staff', permissions: [] });
  const problem = useProblem(form.problems);
  const action = useAction([TEAM]);
  const { values, set } = form;

  async function send() {
    const built = inviteBody(values);
    form.setProblems(built.problems ?? {});
    if (built.problems) return;
    const done = await action.run('invite', () => api.team.invite(built.body), { fresh: true, done: 'team.invited' });
    if (done) onClose();
  }

  return (
    <Sheet testID="team-invite-sheet" visible onClose={onClose} closeLabel={t('common.cancel')} dismissable={!action.busy} title={t('team.invite')}
      footer={<Button testID="team-invite-send" label={t('team.inviteSend')} disabled={!writable} busy={action.busy === 'invite'} onPress={() => { send(); }} />}
    >
      <Text variant="small">{t('team.inviteIntro')}</Text>
      <Field testID="team-invite-contact" label={t('team.contact')} value={values.contact} onChangeText={set('contact')} error={problem('contact')} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" maxLength={120} />
      <Choices testID="team-invite-role" label={t('team.role')} value={values.role} onChange={set('role')} options={TEAM_ROLES.map((role) => ({ value: role, label: t(`team.role.${role}`) }))} />
      <Text variant="meta">{t(`team.role.${values.role}.hint`)}</Text>
      {values.role === 'staff' ? <PermissionChoices testID="team-invite-permissions" value={values.permissions} onChange={set('permissions')} /> : null}
      {problem('permissions') ? <Text variant="meta" tone="bad">{problem('permissions')}</Text> : null}
      <Text variant="meta">{t('settings.secret.fresh')}</Text>
      <ActionMessages action={action} testID="team-invite-action" />
    </Sheet>
  );
}

function MemberSheet({ member, members, onClose }) {
  const { api } = useServices();
  const { t } = useStrings();
  const writable = useWritable();
  const [role, setRole] = useState(member.role);
  const [permissions, setPermissions] = useState(member.permissions ?? []);
  const [removing, setRemoving] = useState(false);
  const action = useAction([TEAM]);
  const onlyOwner = isOnlyOwner(members, member);
  const changed = role !== member.role || (role === 'staff' && [...permissions].sort().join() !== [...(member.permissions ?? [])].sort().join());

  async function save() {
    const done = await action.run('save', () => api.team.update(member.id, teamBody({ role, permissions })), { fresh: true, done: 'team.saved' });
    if (done) onClose();
  }

  async function remove() {
    const done = await action.run('remove', () => api.team.remove(member.id), { fresh: true, done: 'team.removed' });
    setRemoving(false);
    if (done) onClose();
  }

  return (
    <Sheet testID="team-member-sheet" visible onClose={onClose} closeLabel={t('common.close')} dismissable={!action.busy} title={member.name}
      footer={
        <>
          <Button testID="team-member-save" label={t('common.save')} disabled={!writable || !changed || onlyOwner} busy={action.busy === 'save'} onPress={() => { save(); }} />
          <Button testID="team-member-remove" kind="danger" label={t(member.you ? 'team.leave' : 'team.remove')} disabled={!writable || onlyOwner} onPress={() => setRemoving(true)} />
        </>
      }
    >
      {onlyOwner ? <Banner tone="warn" testID="team-only-owner">{t('team.onlyOwner')}</Banner> : null}
      <Choices testID="team-member-role" label={t('team.role')} value={role} onChange={setRole} disabled={onlyOwner} options={TEAM_ROLES.map((value) => ({ value, label: t(`team.role.${value}`) }))} />
      <Text variant="meta">{t(`team.role.${role}.hint`)}</Text>
      {role === 'staff' ? <PermissionChoices testID="team-member-permissions" value={permissions} onChange={setPermissions} disabled={onlyOwner} /> : null}
      <Text variant="meta">{t('settings.secret.fresh')}</Text>
      <ActionMessages action={action} testID="team-member-action" />
      <ConfirmSheet testID="team-remove-confirm" visible={removing} title={t('team.removeTitle', { name: member.name })} confirmLabel={t('team.remove')} cancelLabel={t('team.keep')} busy={action.busy === 'remove'} disabled={!writable} onCancel={() => setRemoving(false)} onConfirm={() => { remove(); }}>
        {t('team.removeBody')}
      </ConfirmSheet>
    </Sheet>
  );
}
