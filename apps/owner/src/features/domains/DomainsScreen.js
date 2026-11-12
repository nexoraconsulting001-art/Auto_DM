import React, { useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { OfflineBanner, formatWhen, useStrings } from '@bhava/app-core';
import { OWNER_ONLY, isAllowed } from '@bhava/app-core/access';
import { Badge, Banner, Button, Card, ConfirmSheet, Divider, Field, Screen, Section, Text, useTheme } from '@bhava/ui';
import { useServices, useSession } from '../../shell/hooks.js';
import { PagedState, Refusal, usePaged, useWritable } from '../compliance/kit.js';

export const DOMAINS_KEY = ['domains', 'list'];
const STATUS_TONE = Object.freeze({ pending: 'warn', verified: 'good', failed: 'bad', stopped: 'neutral' });

/** What the owner typed, as the API wants it: lower case, no scheme, no path, no trailing dot. Pure. */
export function cleanDomain(typed) {
  return String(typed ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/\.$/, '');
}
export const looksLikeDomain = (domain) => /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain);

function Records({ records }) {
  const { t } = useStrings();
  const theme = useTheme();
  if (!records.length) return null;
  return (
    <View style={{ gap: theme.space[2] }}>
      <Text variant="meta">{t('domains.records')}</Text>
      {records.map((record, i) => (
        <View key={`${record.type}-${record.name}-${i}`} style={{ backgroundColor: theme.color.surfaceSunken, borderRadius: theme.radius.small, padding: theme.space[2], gap: 2 }}>
          <Text variant="caption">{`${record.type} · ${t('domains.recordName')}`}</Text>
          <Text variant="small" selectable>{record.name}</Text>
          <Text variant="caption">{t('domains.recordValue')}</Text>
          <Text variant="small" selectable>{record.value}</Text>
        </View>
      ))}
    </View>
  );
}

function DomainCard({ domain, isOwner, writable, actions }) {
  const { t, locale } = useStrings();
  const theme = useTheme();
  const busy = actions.busyFor(domain.domain);
  return (
    <Card testID={`domain-${domain.domain}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2], flexWrap: 'wrap' }}>
        <Text variant="title" style={{ flex: 1 }}>{domain.domain}</Text>
        {domain.isPrimary ? <Badge testID={`domain-${domain.domain}-primary`} label={t('domains.primary')} tone="primary" /> : null}
        <Badge testID={`domain-${domain.domain}-status`} label={t(`domains.status.${domain.status}`)} tone={STATUS_TONE[domain.status] ?? 'neutral'} />
      </View>
      {domain.lastCheckedAt ? <Text variant="meta">{t('domains.checked', { when: formatWhen(t, domain.lastCheckedAt, { locale }) })}</Text> : null}
      {domain.status !== 'verified' ? <Records records={domain.records} /> : null}
      {isOwner ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
          {domain.status !== 'verified' ? <Button testID={`domain-${domain.domain}-check`} kind="secondary" label={t('domains.check')} busy={busy === 'check'} disabled={!writable} onPress={() => actions.check(domain.domain)} /> : null}
          {domain.status === 'verified' && !domain.isPrimary ? <Button testID={`domain-${domain.domain}-make-primary`} kind="secondary" label={t('domains.makePrimary')} busy={busy === 'primary'} disabled={!writable} onPress={() => actions.primary(domain.domain)} /> : null}
          <Button testID={`domain-${domain.domain}-remove`} kind="danger" label={t('domains.remove')} disabled={!writable} onPress={() => actions.askRemove(domain.domain)} />
        </View>
      ) : null}
    </Card>
  );
}

/**
 * Domains (PRD 5.4): the business's own web addresses, the records to add at the registrar, and checking them. Anyone
 * with the catalog permission sees the list; adding, checking, choosing the main one and removing are the owner's,
 * as the server rules, and a refusal shows in words. The records name nothing but the business's own address.
 */
export default function DomainsScreen() {
  const { api } = useServices();
  const { user } = useSession();
  const { t } = useStrings();
  const queryClient = useQueryClient();
  const writable = useWritable();
  const isOwner = isAllowed(user, OWNER_ONLY);
  const [typed, setTyped] = useState('');
  const [typedError, setTypedError] = useState('');
  const [removing, setRemoving] = useState(null);
  const domains = usePaged(DOMAINS_KEY, (query) => api.domains.list(query), { limit: 50 });
  const refresh = () => queryClient.invalidateQueries({ queryKey: DOMAINS_KEY });

  const add = useMutation({ mutationFn: (domain) => api.domains.add({ domain }), onSuccess: async () => { setTyped(''); await refresh(); } });
  const check = useMutation({ mutationFn: (domain) => api.domains.check(domain), onSuccess: refresh });
  const primary = useMutation({ mutationFn: (domain) => api.domains.setPrimary({ domain }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (domain) => api.domains.remove(domain), onSuccess: async () => { setRemoving(null); await refresh(); } });
  const actions = {
    check: (domain) => check.mutate(domain),
    primary: (domain) => primary.mutate(domain),
    askRemove: (domain) => setRemoving(domain),
    busyFor: (domain) => (check.isPending && check.variables === domain ? 'check' : primary.isPending && primary.variables === domain ? 'primary' : null),
  };

  function submit() {
    const domain = cleanDomain(typed);
    if (!looksLikeDomain(domain)) {
      setTypedError(t('domains.invalid'));
      return;
    }
    setTypedError('');
    add.mutate(domain);
  }

  return (
    <Screen testID="screen-domains" title={t('domains.title')}>
      <OfflineBanner offline={!writable} />
      <Text variant="small">{t('domains.intro')}</Text>
      <Refusal error={add.error ?? check.error ?? primary.error ?? remove.error} testID="domains-refusal" />
      {check.isSuccess && check.data?.status === 'verified' ? <Banner tone="good" testID="domains-verified">{t('domains.verified', { domain: check.data.domain })}</Banner> : null}
      <PagedState query={domains} testID="domains" emptyTitle={t('domains.empty')} emptyBody={t(isOwner ? 'domains.emptyOwner' : 'domains.emptyBody')}>
        {domains.items.map((domain) => <DomainCard key={domain.id} domain={domain} isOwner={isOwner} writable={writable} actions={actions} />)}
      </PagedState>
      {isOwner ? (
        <Section title={t('domains.addTitle')}>
          <Card>
            <Field testID="domains-new" label={t('domains.addLabel')} value={typed} onChangeText={setTyped} placeholder="shop.example.com" autoCapitalize="none" autoCorrect={false} keyboardType="url" error={typedError || undefined} editable={writable} />
            <Button testID="domains-add" label={t('domains.add')} busy={add.isPending} disabled={!writable || !typed.trim()} onPress={submit} />
          </Card>
        </Section>
      ) : <Text variant="meta" testID="domains-owner-only">{t('domains.ownerOnly')}</Text>}
      <ConfirmSheet
        testID="domains-remove-confirm"
        visible={Boolean(removing)}
        title={removing ? t('domains.removeTitle', { domain: removing }) : ''}
        confirmLabel={t('domains.remove')}
        cancelLabel={t('common.cancel')}
        onCancel={() => setRemoving(null)}
        onConfirm={() => remove.mutate(removing)}
        busy={remove.isPending}
        disabled={!writable}
      >
        {t('domains.removeBody')}
      </ConfirmSheet>
      <Divider />
    </Screen>
  );
}
