import React, { useState } from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { useNavigation } from '@react-navigation/native';
import { useStrings } from '@bhava/app-core';
import { staffWith } from '@bhava/app-core/access';
import { Badge, Button, Choices, Field, ListRow, Screen, Sheet, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { reviewMoves } from '../orders/kit/rules.js';
import { ActionMessages, Offline, PagedList, StatusBadge, formatWhenAt, useAction, useAllowed, usePaged, useWritable } from '../orders/kit/ui.js';

const REVIEWS = ['reviews'];
const SHOW = ['pending', 'approved', 'hidden', 'all'];

/**
 * Review moderation (PRD 9.19): a review shows on the store once it is approved, and can be hidden again. The seller
 * replies once, in their own words; the shopper's words and stars are never changed.
 */
export default function ReviewsScreen() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const allowed = useAllowed();
  const writable = useWritable();
  const [status, setStatus] = useState('pending');
  const [replying, setReplying] = useState(null);
  const [reply, setReply] = useState('');
  const query = usePaged(['reviews', 'list', status], (page) => api.reviews.list({ status, ...page }));
  const action = useAction([REVIEWS]);

  async function sendReply() {
    const text = reply.trim();
    if (!text) return;
    const done = await action.run('reply', () => api.reviews.reply(replying.id, { reply: text.slice(0, 1000) }), { done: 'reviews.replied' });
    if (done) {
      setReplying(null);
      setReply('');
    }
  }

  return (
    <Screen testID="screen-reviews" title={t('reviews.title')}>
      <Offline />
      {allowed(staffWith('analytics')) ? <Button testID="reviews-saves" kind="secondary" label={t('reviews.saves')} onPress={() => navigation.navigate('reviews.saves')} /> : null}
      <Choices testID="reviews-show" label={t('orders.filterLabel')} value={status} onChange={setStatus} options={SHOW.map((value) => ({ value, label: value === 'all' ? t('orders.filter.all') : t(`orders.status.review.${value}`) }))} />
      <ActionMessages action={action} testID="reviews-action" />
      <PagedList
        testID="reviews-list"
        query={query}
        emptyTitle={t('reviews.empty')}
        renderRow={(review) => {
          const moves = reviewMoves(review);
          return (
            <View testID={`review-${review.id}`} style={{ gap: theme.space[2], paddingVertical: theme.space[2] }}>
              <ListRow
                title={`${'★'.repeat(review.rating)}${'☆'.repeat(Math.max(0, 5 - review.rating))} · ${review.productName}`}
                subtitle={[review.displayName, formatWhenAt(review.createdAt, locale)].filter(Boolean).join(' · ')}
                accessibilityLabel={t('reviews.spoken', { rating: review.rating, product: review.productName })}
                end={<StatusBadge group="review" status={review.status} />}
              />
              {review.body ? <Text variant="body">{review.body}</Text> : null}
              {review.photos?.length ? (
                <View style={{ flexDirection: 'row', gap: theme.space[2] }}>
                  {review.photos.slice(0, 4).map((uri) => <Image key={uri} source={{ uri }} accessibilityLabel={t('reviews.photo')} style={{ width: 64, height: 64, borderRadius: theme.radius.tile }} contentFit="cover" />)}
                </View>
              ) : null}
              {review.reply ? <Badge label={t('reviews.yourReply')} tone="primary" /> : null}
              {review.reply ? <Text variant="small" testID={`review-${review.id}-reply`}>{review.reply}</Text> : null}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
                {moves.includes('approve') ? <Button testID={`review-${review.id}-approve`} kind="secondary" label={t('reviews.approve')} disabled={!writable || Boolean(action.busy)} busy={action.busy === `approve:${review.id}`} onPress={() => action.run(`approve:${review.id}`, () => api.reviews.approve(review.id), { done: 'reviews.approved' })} /> : null}
                {moves.includes('hide') ? <Button testID={`review-${review.id}-hide`} kind="quiet" label={t('reviews.hide')} disabled={!writable || Boolean(action.busy)} busy={action.busy === `hide:${review.id}`} onPress={() => action.run(`hide:${review.id}`, () => api.reviews.hide(review.id), { done: 'reviews.hidden' })} /> : null}
                {moves.includes('reply') ? <Button testID={`review-${review.id}-reply-open`} kind="quiet" label={t('reviews.reply')} disabled={!writable} onPress={() => setReplying(review)} /> : null}
              </View>
            </View>
          );
        }}
      />
      <Sheet testID="review-reply" visible={Boolean(replying)} onClose={() => setReplying(null)} closeLabel={t('common.cancel')} dismissable={action.busy !== 'reply'} title={t('reviews.replyTitle')}
        footer={<Button testID="review-reply-send" label={t('reviews.replySend')} disabled={!writable || !reply.trim()} busy={action.busy === 'reply'} onPress={() => { sendReply(); }} />}
      >
        <Text variant="small">{t('reviews.replyIntro')}</Text>
        <Field testID="review-reply-text" label={t('reviews.reply')} value={reply} onChangeText={setReply} multiline maxLength={1000} />
        <ActionMessages action={action} />
      </Sheet>
    </Screen>
  );
}

/** How many shoppers saved each product (PRD 9.20). */
export function SavesScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const query = usePaged(['reviews', 'saves'], (page) => api.wishlist.counts(page));
  return (
    <Screen testID="screen-saves" title={t('reviews.saves')}>
      <Offline />
      <Text variant="small">{t('reviews.savesIntro')}</Text>
      <PagedList
        testID="saves-list"
        query={query}
        rowKey={(row) => row.productId}
        emptyTitle={t('reviews.savesEmpty')}
        renderRow={(row) => <ListRow testID={`saves-${row.productId}`} title={row.name} end={<Badge label={t('reviews.savedBy', { count: row.saves })} tone="primary" />} />}
      />
    </Screen>
  );
}
