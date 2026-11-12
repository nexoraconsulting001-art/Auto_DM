/**
 * The pieces every browsing screen is drawn from, all native: images, prices, product and reel tiles, the states a list
 * passes through, and the video of a reel. Seller text is drawn as <Text> and seller addresses only as image or video
 * sources: nothing here runs a seller's words as markup, and there is no web view.
 */
import React from 'react';
import { FlatList, Linking, Pressable, View } from 'react-native';
import { Image } from 'expo-image';
import { useStrings } from '@bhava/app-core/strings';
import { formatPaise, percentOff } from '@bhava/store-client';
import { Badge, Button, EmptyState, ErrorState, LoadingRows, Text, useTheme } from '@bhava/ui';
import { useServices } from '../services.js';

/** The store's own name, from the build. Shown wherever a name is needed; the screens never spell one out. */
export const useBrandName = () => useServices().config.brand.name;

/** The words for a failed read: what the server said, or plain words for no connection. Never a host, never a platform. */
export function failure(error, t) {
  if (!error || error.status === 0 || error.code === 'network' || error.code === 'offline') return { offline: true, title: t('home.common.offlineTitle'), body: t('home.common.offlineBody') };
  if (error.code === 'not_found') return { gone: true, title: t('home.common.notFoundTitle'), body: '' };
  return { title: t('home.common.error'), body: typeof error.message === 'string' && error.message ? error.message : t('home.common.errorBody') };
}

export function Photo({ uri, name, style, ratio = 1, testID }) {
  const theme = useTheme();
  const { t } = useStrings();
  const box = [{ width: '100%', aspectRatio: ratio, backgroundColor: theme.color.surfaceSunken, borderRadius: theme.radius.tile, overflow: 'hidden' }, style];
  if (!uri) return <View testID={testID} style={box} />;
  return <Image testID={testID} source={{ uri }} style={box} contentFit="cover" transition={120} accessible accessibilityLabel={t('home.common.image', { name: name ?? '' })} />;
}

/** Price from the server's paise; the strike-through and the percentage only compare two numbers the server sent. */
export function Price({ pricePaise, comparePaise, large = false, testID }) {
  const { t } = useStrings();
  const pct = percentOff(pricePaise, comparePaise);
  return (
    <View testID={testID} style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
      <Text variant={large ? 'page' : 'title'} testID={testID ? `${testID}-now` : undefined}>{formatPaise(pricePaise)}</Text>
      {pct ? <Text variant="meta" style={{ textDecorationLine: 'line-through' }} testID={testID ? `${testID}-was` : undefined}>{formatPaise(comparePaise)}</Text> : null}
      {pct ? <Text variant="meta" tone="good">{t('home.common.off', { pct })}</Text> : null}
    </View>
  );
}

export function ProductTile({ product, onPress }) {
  const { t } = useStrings();
  const theme = useTheme();
  const label = [product.name, formatPaise(product.pricePaise), product.inStock ? '' : t('home.common.soldOut')].filter(Boolean).join(', ');
  return (
    <Pressable
      testID={`product-${product.slug}`}
      onPress={() => onPress(product)}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{ flex: 1, gap: theme.space[2], opacity: product.inStock ? 1 : 0.7 }}
    >
      <View>
        <Photo uri={product.image} name={product.name} ratio={1} />
        {product.inStock ? null : <View style={{ position: 'absolute', left: 8, top: 8 }}><Badge label={t('home.common.soldOut')} tone="bad" testID={`soldout-${product.slug}`} /></View>}
      </View>
      <Text variant="small" numberOfLines={2} style={{ color: theme.color.ink }}>{product.name}</Text>
      <Price pricePaise={product.pricePaise} comparePaise={product.comparePaise} />
      {product.rating !== null && product.ratingCount > 0 ? (
        <Text variant="caption" accessibilityLabel={t('home.common.rating', { rating: product.rating.toFixed(1), count: product.ratingCount })}>{`★ ${product.rating.toFixed(1)} (${product.ratingCount})`}</Text>
      ) : null}
    </Pressable>
  );
}

export function ReelTile({ reel, onPress, width }) {
  const { t } = useStrings();
  const theme = useTheme();
  return (
    <Pressable testID={`reel-${reel.slug}`} onPress={() => onPress(reel)} accessibilityRole="button" accessibilityLabel={reel.title} style={{ flex: width ? undefined : 1, width, gap: theme.space[2] }}>
      <View>
        <Photo uri={reel.image} name={reel.title} ratio={9 / 16} />
        {reel.pinned ? <View style={{ position: 'absolute', left: 8, top: 8 }}><Badge label={t('home.common.pinned')} tone="neutral" testID={`pinned-${reel.slug}`} /></View> : null}
      </View>
      <Text variant="small" numberOfLines={2}>{reel.title}</Text>
      {reel.productCount > 0 ? <Text variant="caption">{t('home.common.products', { count: reel.productCount })}</Text> : null}
    </Pressable>
  );
}

/** Two tiles a row; a lone last tile keeps its half width. */
export function Grid({ data, renderItem, keyOf, header, footer, onEnd, testID, empty }) {
  const theme = useTheme();
  const rows = data.length % 2 ? [...data, null] : data;
  return (
    <FlatList
      testID={testID}
      data={rows}
      numColumns={2}
      keyExtractor={(item, index) => (item ? keyOf(item) : `blank-${index}`)}
      columnWrapperStyle={{ gap: theme.space[3] }}
      contentContainerStyle={{ gap: theme.space[4], paddingHorizontal: theme.space.gutter, paddingBottom: theme.space[8] }}
      renderItem={({ item }) => (item ? renderItem(item) : <View style={{ flex: 1 }} />)}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      ListEmptyComponent={empty}
      onEndReached={onEnd}
      onEndReachedThreshold={0.6}
    />
  );
}

/**
 * What a read shows while it loads, when it failed and when there is nothing, and its data when it has some. Data
 * already on the device is shown even when the latest try failed; "offline" is said plainly when there is none.
 */
export function Shown({ query, children, onGone }) {
  const { t } = useStrings();
  const brand = useBrandName();
  if (query.data !== undefined) return children(query.data);
  const offline = query.fetchStatus === 'paused' || (query.isError && failure(query.error, t).offline);
  if (query.isPending && !offline) return <LoadingRows rows={4} label={t('home.common.loading')} testID="loading" />;
  const why = failure(query.error, t);
  if (offline) return <EmptyState testID="offline" title={t('home.common.offlineTitle')} action={<Button kind="secondary" label={t('home.common.retry')} onPress={() => query.refetch()} />}>{t('home.common.offlineBody')}</EmptyState>;
  if (why.gone) {
    return <EmptyState testID="gone" title={why.title} action={onGone ? <Button label={t('home.common.goShop')} onPress={onGone} /> : null}>{t('home.common.notFoundBody', { brand })}</EmptyState>;
  }
  return <ErrorState testID="failed" title={why.title} onRetry={() => query.refetch()} retryLabel={t('home.common.retry')}>{why.body}</ErrorState>;
}

/** Horizontal chips (categories). `all` is the label of the unfiltered choice, or null for none. */
export function Chips({ items, value, onChange, all, testID }) {
  const theme = useTheme();
  const options = [...(all ? [{ slug: null, name: all }] : []), ...items];
  return (
    <FlatList
      testID={testID}
      horizontal
      showsHorizontalScrollIndicator={false}
      data={options}
      keyExtractor={(item) => String(item.slug)}
      contentContainerStyle={{ gap: theme.space[2], paddingHorizontal: theme.space.gutter, paddingVertical: theme.space[2] }}
      renderItem={({ item }) => {
        const chosen = (item.slug ?? null) === (value ?? null);
        return (
          <Pressable
            testID={`chip-${item.slug ?? 'all'}`}
            onPress={() => onChange(item.slug)}
            accessibilityRole="button"
            accessibilityState={{ selected: chosen }}
            style={{ minHeight: theme.tap.min, justifyContent: 'center', paddingHorizontal: theme.space[4], borderRadius: theme.radius.pill, borderWidth: 1, borderColor: chosen ? theme.color.primary : theme.color.line, backgroundColor: chosen ? theme.color.primaryTint : theme.color.surface }}
          >
            <Text variant="small" tone={chosen ? 'primary' : undefined}>{item.name}</Text>
          </Pressable>
        );
      }}
    />
  );
}

/** A reel's video, native (expo-video). Without a playable address, or without the module, its poster stands in. */
export function ReelVideo({ uri, poster, name, autoPlay = false }) {
  let video = null;
  try {
    video = uri ? require('expo-video') : null;
  } catch {
    video = null;
  }
  if (!video) return <Photo uri={poster} name={name} ratio={9 / 16} testID="reel-poster" />;
  return <Player video={video} uri={uri} autoPlay={autoPlay} />;
}

function Player({ video, uri, autoPlay }) {
  const player = video.useVideoPlayer(uri, (p) => {
    p.loop = true;
    if (autoPlay) p.play();
  });
  return <video.VideoView testID="reel-video" player={player} style={{ width: '100%', aspectRatio: 9 / 16, borderRadius: 14 }} nativeControls contentFit="cover" />;
}

/** Opens an address in the system, only if it is the store's own (https on its link hosts) or a mailto. */
export function openIfOwn(url, brand) {
  try {
    if (/^mailto:[^\s]+$/i.test(url)) return Linking.openURL(url);
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' && (brand.linkHosts ?? []).includes(parsed.host)) return Linking.openURL(url);
  } catch {
    // not an address: nothing opens
  }
  return Promise.resolve();
}
