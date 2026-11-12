/** A product's reviews, and writing one (with up to three photos) for something that was delivered. The store checks every review before it shows. */
import React, { useState } from 'react';
import { View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core/strings';
import { Banner, Button, Card, Choices, Field, ListRow, LoadingRows, Screen, Section, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../services.js';
import { useBrowseQuery } from '../../shell/data.js';
import { Problem, useBuy, useSessionState, useStoreQuery } from '../cart/ui.js';
import { REVIEW_MAX_PHOTOS, formWith, pickFiles } from '../returns/proof.js';

const RATINGS = [1, 2, 3, 4, 5].map((n) => ({ value: n, label: '★'.repeat(n) }));

export default function ReviewsScreen() {
  const { t } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const params = useRoute().params ?? {};
  const slug = String(params.slug ?? '');
  const orderNumber = String(params.orderNumber ?? '');
  const { buy } = useBuy();
  const services = useServices();
  const signedIn = useSessionState().status === 'signedIn';
  const product = useBrowseQuery(['product', slug], (browse) => browse.product(slug), { enabled: slug !== '' });
  const id = product.data?.id;
  const list = useStoreQuery(['reviews', id], () => buy.call('reviewList', { params: { id }, query: { limit: 20 } }), { enabled: Boolean(id) });
  const [rating, setRating] = useState(5);
  const [body, setBody] = useState('');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [thanks, setThanks] = useState('');
  const canWrite = signedIn && orderNumber !== '' && Boolean(id);

  async function addPhotos() {
    const more = await pickFiles({ picker: services.imagePicker ?? require('expo-image-picker'), limit: REVIEW_MAX_PHOTOS - files.length });
    setFiles((now) => [...now, ...more].slice(0, REVIEW_MAX_PHOTOS));
  }

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const fields = { orderNumber, productId: id, rating, body: body.trim() };
      const answer = files.length
        ? await buy.call('reviewCreate', { form: formWith(fields, 'photos', files) })
        : await buy.call('reviewCreate', { body: { ...fields } });
      setThanks(answer?.message || t('reviews.thanks'));
      setBody('');
      setFiles([]);
      await queryClient.invalidateQueries({ queryKey: ['buy', 'reviews'] });
    } catch (failed) {
      setError(failed);
    } finally {
      setBusy(false);
    }
  }

  const data = list.data;
  return (
    <Screen testID="screen-reviews" title={product.data ? t('reviews.of', { name: product.data.name }) : t('reviews.title')}>
      {product.isPending && slug ? <LoadingRows rows={2} label={t('home.common.loading')} testID="reviews-loading" /> : null}
      {list.isError && !data ? <Problem error={list.error} onRetry={() => list.refetch()} /> : null}
      {data ? (
        <Text variant="title" testID="reviews-summary">{data.count ? t('reviews.summary', { average: data.average, count: data.count }) : t('reviews.none')}</Text>
      ) : null}
      {data?.items.map((review) => (
        <Card key={review.id ?? `${review.createdAt}-${review.displayName}`} testID={`review-${review.id}`}>
          <View style={{ gap: theme.space[1] }}>
            <Text variant="body">{'★'.repeat(review.rating)}</Text>
            {review.body ? <Text variant="body">{review.body}</Text> : null}
            <Text variant="meta">{review.displayName}</Text>
            {review.reply ? <Text variant="small" testID={`review-reply-${review.id}`}>{t('reviews.reply', { text: review.reply })}</Text> : null}
          </View>
        </Card>
      ))}
      {canWrite ? (
        <Section title={t('reviews.write')}>
          {thanks ? <Banner testID="review-thanks" tone="good">{thanks}</Banner> : null}
          <Problem inline error={error} testID="review-error" />
          <Choices testID="review-rating" label={t('reviews.rating')} value={rating} onChange={setRating} options={RATINGS} />
          <Field testID="review-body" label={t('reviews.body')} value={body} onChangeText={setBody} multiline maxLength={1000} />
          {files.map((file, i) => <ListRow key={`${file.uri}-${i}`} testID={`review-photo-${i}`} title={file.name} end={<Button kind="quiet" label={t('reviews.removePhoto')} onPress={() => setFiles((now) => now.filter((_, j) => j !== i))} />} />)}
          {files.length < REVIEW_MAX_PHOTOS ? <Button testID="review-add-photo" kind="secondary" label={t('reviews.addPhoto')} onPress={addPhotos} /> : null}
          <Button testID="review-send" label={t('reviews.send')} busy={busy} onPress={send} />
        </Section>
      ) : null}
      {!signedIn && orderNumber ? <Button testID="review-sign-in" label={t('cart.signInButton')} onPress={() => navigation.navigate('sign-in.index')} /> : null}
    </Screen>
  );
}
