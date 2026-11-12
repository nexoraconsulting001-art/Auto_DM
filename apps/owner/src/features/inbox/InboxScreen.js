import React, { useState } from 'react';
import { View } from 'react-native';
import { OfflineBanner, formatWhen, useStrings } from '@bhava/app-core';
import { isAllowed, staffWith } from '@bhava/app-core/access';
import { Badge, Button, Card, Choices, Divider, ListRow, Screen, Text, useTheme } from '@bhava/ui';
import { useServices, useSession } from '../../shell/hooks.js';
import { PagedState, StatusNotices, usePaged, useWritable } from '../compliance/kit.js';
import { THREAD_FILTERS, THREAD_TONES, handle } from './views.js';

export const THREADS_KEY = ['inbox', 'threads'];

/**
 * The inbox (PRD 6.7): the business's Instagram and Messenger chats, newest first, and the way to what needs a person.
 * Chats are read from the offline cache when there is no connection. A chat's words stay on this phone's screen.
 */
export default function InboxScreen({ navigation }) {
  const { api } = useServices();
  const { user } = useSession();
  const { t, locale } = useStrings();
  const theme = useTheme();
  const writable = useWritable();
  const [status, setStatus] = useState('');
  const threads = usePaged(THREADS_KEY, (query) => api.inbox.threads(query), { ...(status ? { status } : {}), limit: 30 }, { refetchInterval: 20_000 });
  return (
    <Screen testID="screen-inbox" title={t('inbox.title')}>
      <OfflineBanner offline={!writable} />
      <Text variant="small">{t('inbox.intro')}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
        <Button testID="inbox-open-needs-human" kind="secondary" label={t('inbox.needsHuman.title')} onPress={() => navigation?.navigate('inbox.needsHuman')} />
        <Button testID="inbox-open-why" kind="quiet" label={t('inbox.why.title')} onPress={() => navigation?.navigate('inbox.whyNoDm')} />
      </View>
      {/* The inbox has its own permission: the status needs the automations one, so someone with only the inbox isn't sent to a refusal. */}
      <StatusNotices allowed={isAllowed(user, staffWith('automations'))} />
      <Choices testID="inbox-filter" label={t('inbox.filter')} value={status} onChange={setStatus} options={THREAD_FILTERS.map((value) => ({ value, label: t(value ? `inbox.status.${value}` : 'inbox.all') }))} />
      <Card>
        <PagedState query={threads} testID="inbox-threads" emptyTitle={t(status ? 'inbox.emptyFiltered' : 'inbox.empty')} emptyBody={t(status ? 'inbox.tryAnother' : 'inbox.emptyBody')}>
          {threads.items.map((thread, i) => (
            <View key={thread.id}>
              {i > 0 ? <Divider /> : null}
              <ListRow
                testID={`thread-${thread.id}`}
                title={handle(t, thread.username)}
                subtitle={[thread.lastMessage, thread.lastMessageAt ? formatWhen(t, thread.lastMessageAt, { locale }) : ''].filter(Boolean).join(' · ')}
                emphasis={thread.status === 'needs_human'}
                end={<Badge label={t(`inbox.status.${thread.status}`)} tone={THREAD_TONES[thread.status] ?? 'neutral'} />}
                onPress={() => navigation?.navigate('inbox.thread', { id: String(thread.id) })}
              />
            </View>
          ))}
        </PagedState>
      </Card>
    </Screen>
  );
}
