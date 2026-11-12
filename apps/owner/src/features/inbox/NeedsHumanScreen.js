import React, { useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { OfflineBanner, useStrings } from '@bhava/app-core';
import { Badge, Button, Card, Choices, Divider, Screen, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { PagedState, Refusal, formatDateTime, usePaged, useWritable } from '../compliance/kit.js';
import { describeReason } from '../compliance/reasons.js';
import { NEEDS_HUMAN_KINDS, handle } from './views.js';

export const NEEDS_HUMAN_KEY = ['inbox', 'needs-human'];
const FILTERS = Object.freeze(['open', 'resolved']);

function Item({ item, writable, navigation, resolve }) {
  const { t, locale } = useStrings();
  const theme = useTheme();
  const open = item.status === 'open';
  const kind = NEEDS_HUMAN_KINDS.includes(item.kind) ? t(`inbox.needsHuman.kind.${item.kind}`) : item.kind;
  return (
    <View testID={`needs-${item.id}`} style={{ gap: theme.space[1], paddingVertical: theme.space[2] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}>
        <Text variant="title" numberOfLines={1} style={{ flex: 1 }}>{handle(t, item.username)}</Text>
        <Badge label={kind} tone={open ? 'warn' : 'neutral'} />
      </View>
      {item.text ? <Text variant="small" numberOfLines={4}>{item.text}</Text> : null}
      <Text variant="meta" testID={`needs-${item.id}-reason`}>{[describeReason(t, item.reason), formatDateTime(item.createdAt, { locale })].filter(Boolean).join(' ')}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
        {item.threadId ? <Button testID={`needs-${item.id}-chat`} kind="secondary" label={t('inbox.needsHuman.openChat')} onPress={() => navigation?.navigate('inbox.thread', { id: String(item.threadId) })} /> : null}
        {item.commentId ? <Button testID={`needs-${item.id}-why`} kind="quiet" label={t('inbox.why.title')} onPress={() => navigation?.navigate('inbox.whyNoDmFor', { commentId: item.commentId })} /> : null}
        {open ? <Button testID={`needs-${item.id}-done`} kind="quiet" label={t('inbox.needsHuman.done')} disabled={!writable} busy={resolve.isPending && resolve.variables === item.id} onPress={() => resolve.mutate(item.id)} /> : null}
      </View>
    </View>
  );
}

/**
 * Needs a human (PRD 6.7): unhappy comments, people who asked for a person, and messages that did not go or were not
 * confirmed. Each shows the reason the compliance engine recorded. Marking one done needs a connection.
 */
export default function NeedsHumanScreen({ navigation }) {
  const { api } = useServices();
  const { t } = useStrings();
  const queryClient = useQueryClient();
  const writable = useWritable();
  const [status, setStatus] = useState('open');
  const items = usePaged(NEEDS_HUMAN_KEY, (query) => api.inbox.needsHuman(query), { status, limit: 30 }, { refetchInterval: 20_000 });
  const resolve = useMutation({
    mutationFn: (id) => api.inbox.resolve(id),
    onSuccess: () => Promise.all([queryClient.invalidateQueries({ queryKey: NEEDS_HUMAN_KEY }), queryClient.invalidateQueries({ queryKey: ['home'] })]),
  });
  return (
    <Screen testID="screen-needs-human" title={t('inbox.needsHuman.title')}>
      <OfflineBanner offline={!writable} />
      <Text variant="small">{t('inbox.needsHuman.intro')}</Text>
      <Choices testID="needs-filter" label={t('inbox.filter')} value={status} onChange={setStatus} options={FILTERS.map((value) => ({ value, label: t(`inbox.needsHuman.filter.${value}`) }))} />
      <Refusal error={resolve.error} testID="needs-refusal" />
      <Card>
        <PagedState
          query={items}
          testID="needs"
          emptyTitle={t(status === 'open' ? 'inbox.needsHuman.empty' : 'inbox.needsHuman.emptyDone')}
          emptyBody={t(status === 'open' ? 'inbox.needsHuman.emptyBody' : 'inbox.needsHuman.emptyDoneBody')}
        >
          {items.items.map((item, i) => (
            <View key={item.id}>
              {i > 0 ? <Divider /> : null}
              <Item item={item} writable={writable} navigation={navigation} resolve={resolve} />
            </View>
          ))}
        </PagedState>
      </Card>
    </Screen>
  );
}
