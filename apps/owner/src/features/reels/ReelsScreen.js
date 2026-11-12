import React from 'react';
import { Image, View } from 'react-native';
import { OfflineBanner, errorKey, useStrings } from '@bhava/app-core';
import { Badge, Banner, Button, Card, Divider, EmptyState, ErrorState, ListRow, LoadingRows, Screen, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { NothingSaved, refusalOf, usePaged, useWritable } from '../compliance/kit.js';
import { mergeReelCards } from './form.js';

export const REELS_KEY = ['reels', 'list'];
export const POSTS_KEY = ['reels', 'posts'];
export const REELS_QUERY = Object.freeze({ limit: 50 });

const isWebImage = (url) => /^https:\/\//i.test(String(url ?? ''));

/** A reel's picture, or a plain tile when Instagram gave none. */
export function Thumb({ url, size = 48 }) {
  const theme = useTheme();
  const box = { width: size, height: Math.round(size * 1.25), borderRadius: theme.radius.small, backgroundColor: theme.color.surfaceSunken };
  return isWebImage(url) ? <Image source={{ uri: url }} style={box} accessibilityIgnoresInvertColors /> : <View style={box} />;
}

/** The reels set up so far, and every post they could be set up for. */
export function useReelSources() {
  const { api } = useServices();
  const reels = usePaged(REELS_KEY, (query) => api.reels.list(query), REELS_QUERY);
  // Instagram being down must not hide the reels already set up, so this one fails on its own.
  const posts = usePaged(POSTS_KEY, (query) => api.reels.instagramPosts(query), REELS_QUERY, { retry: false });
  return { reels, posts };
}

/**
 * Reels (the console's /reels): one card for each Instagram post, with its store if it has one. Each store shows 1 to 20
 * products and sends its link when someone comments its keyword. Read from the offline cache when there is no connection.
 */
export default function ReelsScreen({ navigation }) {
  const { t } = useStrings();
  const writable = useWritable();
  const { reels, posts } = useReelSources();
  const open = (id) => navigation?.navigate('reels.detail', { id: String(id) });

  let body;
  if (reels.isPending && reels.isPaused) body = <NothingSaved testID="reels" />;
  else if (reels.isPending || (posts.isPending && !posts.isPaused && !reels.items.length)) body = <LoadingRows label={t('common.loading')} testID="reels-loading" />;
  else if (reels.error && !reels.items.length) {
    body = <ErrorState testID="reels-error" title={t('error.title')} onRetry={() => reels.refetch()} retryLabel={t('common.retry')}>{t(errorKey(reels.error))}</ErrorState>;
  } else {
    const cards = mergeReelCards(posts.items, reels.items);
    body = cards.length ? (
      <Card>
        {cards.map((card, i) => (
          <View key={card.id}>
            {i > 0 ? <Divider /> : null}
            <ListRow
              testID={`reel-${card.id}`}
              start={<Thumb url={card.thumbnailUrl} />}
              title={card.title || t(`reels.kind.${card.kind}`)}
              subtitle={card.reel ? t('reels.line', { products: card.reel.productCount, dms: card.reel.dmCount, orders: card.reel.orderCount }) : t(`reels.kind.${card.kind}`)}
              end={card.reel ? <Badge label={t(card.reel.active ? 'reels.live' : 'reels.paused')} tone={card.reel.active ? 'good' : 'neutral'} /> : <Badge label={t('reels.notSetUp')} tone="warn" />}
              accessibilityHint={t(card.reel ? 'reels.edit' : 'reels.setUp')}
              onPress={() => open(card.id)}
            />
          </View>
        ))}
        {posts.hasNextPage ? <Button testID="reels-more-posts" kind="secondary" label={t('compliance.kit.loadMore')} disabled={!writable} busy={posts.isFetchingNextPage} onPress={() => posts.fetchNextPage()} /> : null}
        {reels.hasNextPage ? <Button testID="reels-more" kind="secondary" label={t('compliance.kit.loadMore')} disabled={!writable} busy={reels.isFetchingNextPage} onPress={() => reels.fetchNextPage()} /> : null}
      </Card>
    ) : <EmptyState testID="reels-empty" title={t('reels.empty')}>{t('reels.emptyBody')}</EmptyState>;
  }

  return (
    <Screen testID="screen-reels" title={t('reels.title')}>
      <OfflineBanner offline={!writable} />
      <Text variant="small">{t('reels.intro')}</Text>
      {posts.error && writable ? <Banner testID="reels-posts-failed" tone="warn" title={t('reels.postsFailed')}>{`${refusalOf(t, posts.error).text} ${t('reels.postsFailedBody')}`}</Banner> : null}
      {body}
    </Screen>
  );
}
