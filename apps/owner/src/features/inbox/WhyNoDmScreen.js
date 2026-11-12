import React, { useState } from 'react';
import { View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { OfflineBanner, errorKey, useStrings } from '@bhava/app-core';
import { Badge, Button, Card, EmptyState, ErrorState, Field, LoadingRows, Screen, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { NothingSaved, formatDateTime, useWritable } from '../compliance/kit.js';
import { describeOutcome, describeReason } from '../compliance/reasons.js';
import { COMMENT_ID_MAX, cleanCommentId, isCommentId } from './views.js';

export const whyKey = (commentId) => ['inbox', 'why-no-dm', commentId];

/** What the compliance engine decided about one comment, in its own words, with the reason code for support. */
function Answer({ commentId }) {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const theme = useTheme();
  const answer = useQuery({ queryKey: whyKey(commentId), queryFn: () => api.compliance.whyNoDm({ commentId }), retry: false });
  if (answer.isPending && answer.isPaused) return <NothingSaved testID="why" />;
  if (answer.isPending) return <LoadingRows rows={2} label={t('common.loading')} testID="why-loading" />;
  if (answer.error && !answer.data) {
    if (answer.error.status === 404) return <EmptyState testID="why-none" title={t('inbox.why.none')}>{t('inbox.why.noneBody')}</EmptyState>;
    return <ErrorState testID="why-error" title={t('error.title')} onRetry={() => answer.refetch()} retryLabel={t('common.retry')}>{t(errorKey(answer.error))}</ErrorState>;
  }
  const found = answer.data;
  const { label, tone } = describeOutcome(t, found.outcome);
  return (
    <Card testID="why-answer">
      <Badge testID="why-outcome" label={label} tone={tone} />
      <Text variant="body" testID="why-explanation">{found.explanation || describeReason(t, found.reason) || describeReason(t, found.outcome)}</Text>
      {found.reason ? (
        <View style={{ gap: 2 }}>
          {found.explanation ? <Text variant="small">{describeReason(t, found.reason)}</Text> : null}
          <Text variant="caption" testID="why-code" selectable style={{ fontFamily: theme.font.bodyMedium }}>{found.reason}</Text>
        </View>
      ) : null}
      <Text variant="meta">{formatDateTime(found.at, { locale })}</Text>
    </Card>
  );
}

/**
 * "Why no DM?" (PRD 4.13): a comment's id, and what was decided about it and why. The compliance log, Needs a human
 * and a push link here with the id filled in (inbox/why-no-dm/:commentId).
 */
export default function WhyNoDmScreen({ route }) {
  const { t } = useStrings();
  const theme = useTheme();
  const writable = useWritable();
  const given = cleanCommentId(route?.params?.commentId);
  const [draft, setDraft] = useState(given);
  const [asked, setAsked] = useState(isCommentId(given) ? given : '');
  const typed = cleanCommentId(draft);
  return (
    <Screen testID="screen-why-no-dm" title={t('inbox.why.title')}>
      <OfflineBanner offline={!writable} />
      <Text variant="small">{t('inbox.why.intro')}</Text>
      <View style={{ gap: theme.space[2] }}>
        <Field
          testID="why-comment"
          label={t('inbox.why.commentId')}
          value={draft}
          onChangeText={setDraft}
          maxLength={COMMENT_ID_MAX}
          autoCapitalize="none"
          autoCorrect={false}
          error={typed && !isCommentId(typed) ? t('inbox.why.badId') : ''}
        />
        <Button testID="why-look-up" kind="secondary" label={t('inbox.why.lookUp')} disabled={!isCommentId(typed)} onPress={() => setAsked(typed)} />
      </View>
      {asked ? <Answer key={asked} commentId={asked} /> : <EmptyState testID="why-idle" title={t('inbox.why.idle')}>{t('inbox.why.idleBody')}</EmptyState>}
    </Screen>
  );
}
