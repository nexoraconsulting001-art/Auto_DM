import React, { useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OfflineBanner, useStrings } from '@bhava/app-core';
import { Badge, Banner, Button, Card, Field, Screen, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { RecordState, Refusal, formatDateTime, useWritable } from '../compliance/kit.js';
import { describeOutcome, describeReason } from '../compliance/reasons.js';
import { MESSAGE_KINDS, SENT_OUTCOMES, THREAD_TONES, WINDOW_CLOSED, handle, pauseLine } from './views.js';
import { THREADS_KEY } from './InboxScreen.js';

export const threadKey = (id) => ['inbox', 'thread', String(id)];

function Bubble({ message }) {
  const { t, locale } = useStrings();
  const theme = useTheme();
  const out = message.direction === 'out';
  const who = message.author === 'automation' ? t('inbox.author.automation') : message.author === 'owner' ? t('inbox.author.owner') : '';
  return (
    <View
      testID={`message-${message.id}`}
      style={{
        alignSelf: out ? 'flex-end' : 'flex-start', maxWidth: '86%', gap: 2, padding: theme.space[3], borderRadius: theme.radius.tile,
        backgroundColor: out ? theme.color.primaryTint : theme.color.surface, borderWidth: 1, borderColor: out ? theme.color.primaryLine : theme.color.line,
      }}
    >
      {MESSAGE_KINDS.includes(message.kind) ? <Text variant="caption">{t(`inbox.kind.${message.kind}`)}</Text> : null}
      {message.text ? <Text variant="body" selectable>{message.text}</Text> : null}
      <Text variant="caption">{`${who ? `${who}, ` : ''}${formatDateTime(message.at, { locale })}`}</Text>
    </View>
  );
}

/**
 * A reply goes through the same checks as every other send (PRD 6.7), so "it didn't go" is an ordinary answer here,
 * shown with the reason the compliance engine gave. Nothing is queued: offline, the box and the button are off.
 */
function Composer({ thread, writable }) {
  const { api } = useServices();
  const { t } = useStrings();
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [problem, setProblem] = useState(null);
  const send = useMutation({
    mutationFn: (body) => api.inbox.reply(thread.id, { text: body }),
    onSuccess: (result) => {
      if (SENT_OUTCOMES.includes(result.outcome)) {
        setText('');
        setProblem(null);
      } else {
        setProblem({ outcome: result.outcome, reason: result.reason });
      }
    },
    onSettled: () => Promise.all([queryClient.invalidateQueries({ queryKey: threadKey(thread.id) }), queryClient.invalidateQueries({ queryKey: THREADS_KEY })]),
  });
  const windowClosed = send.error?.reason === WINDOW_CLOSED;
  return (
    <Card testID="composer">
      <Field testID="composer-text" label={t('inbox.reply.label')} value={text} onChangeText={setText} multiline maxLength={4000} editable={writable} style={{ minHeight: 96, textAlignVertical: 'top' }} />
      {problem ? (
        <Banner testID="composer-not-sent" tone="bad" title={t('inbox.reply.notSent', { outcome: describeOutcome(t, problem.outcome).label })}>
          {`${describeReason(t, problem.reason) || describeReason(t, problem.outcome)}${problem.reason ? `\n${problem.reason}` : ''}`}
        </Banner>
      ) : null}
      {windowClosed ? <Banner testID="composer-window" tone="warn">{t('inbox.reply.inInstagram')}</Banner> : <Refusal error={send.error} testID="composer-refusal" />}
      {send.isSuccess && !problem ? <Text variant="meta" tone="good" testID="composer-sent">{t('inbox.reply.sent')}</Text> : null}
      <Button testID="composer-send" label={t('inbox.reply.send')} busy={send.isPending} disabled={!writable || !text.trim()} onPress={() => send.mutate(text.trim())} />
    </Card>
  );
}

/** One chat: every message kept (30 days), whether automation is paused in it, and a reply box while the 24-hour window is open. */
export default function ThreadScreen({ route }) {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const writable = useWritable();
  const theme = useTheme();
  const id = String(route?.params?.id ?? '');
  const thread = useQuery({ queryKey: threadKey(id), queryFn: () => api.inbox.thread(id), enabled: /^\d+$/.test(id), refetchInterval: 15_000 });
  return (
    <Screen testID="screen-inbox-thread" title={t('inbox.thread.title')}>
      <OfflineBanner offline={!writable} />
      <RecordState query={/^\d+$/.test(id) ? thread : { data: null, isPending: false }} testID="thread">
        {(found) => (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}>
              <Text variant="title" style={{ flex: 1 }}>{handle(t, found.username)}</Text>
              <Badge label={t(`inbox.status.${found.status}`)} tone={THREAD_TONES[found.status] ?? 'neutral'} />
            </View>
            {found.channel === 'facebook' ? <Text variant="meta">{t('inbox.thread.messenger')}</Text> : null}
            {found.messages.length > 0 ? (
              <View testID="messages" accessibilityLabel={t('inbox.thread.messages')} style={{ gap: theme.space[2] }}>
                {found.messages.map((message) => <Bubble key={message.id} message={message} />)}
              </View>
            ) : <Text variant="small" testID="messages-gone">{t('inbox.thread.gone')}</Text>}
            {pauseLine(t, found, (when) => formatDateTime(when, { locale })) ? <Banner testID="thread-paused">{pauseLine(t, found, (when) => formatDateTime(when, { locale }))}</Banner> : null}
            {found.canReply ? <Composer thread={found} writable={writable} /> : <Banner testID="thread-no-reply" tone="warn">{t('inbox.reply.inInstagram')}</Banner>}
          </>
        )}
      </RecordState>
    </Screen>
  );
}
