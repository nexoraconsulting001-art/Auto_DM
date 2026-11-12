/** Saved products. The server keeps them for a signed-in shopper; a product that went out of stock or off the shelf stays, marked, never dropped. */
import React, { useState } from 'react';
import { View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core/strings';
import { formatPaise, safeUrl } from '@bhava/store-client';
import { Badge, Banner, Button, Card, EmptyState, LoadingRows, Screen, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../services.js';
import { Photo } from '../../shell/parts.js';
import { NeedSignIn, Problem, useBuy, useSessionState, useStoreQuery } from '../cart/ui.js';

export default function WishlistScreen() {
  const { t } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const { services, buy } = useBuy();
  const { config } = useServices();
  const signedIn = useSessionState().status === 'signedIn';
  const list = useStoreQuery(['wishlist'], () => buy.call('wishlistGet'), { enabled: signedIn });
  const [error, setError] = useState(null);
  const [moved, setMoved] = useState(null);

  async function remove(productId) {
    setError(null);
    try {
      await buy.call('wishlistPut', { body: { add: [], remove: [productId] } });
      await queryClient.invalidateQueries({ queryKey: ['buy', 'wishlist'] });
    } catch (failed) {
      setError(failed);
    }
  }
  async function toBag(item) {
    if (item.needsOption) {
      navigation.navigate('product.index', { slug: item.slug });
      return;
    }
    await services.cart.add({ productId: item.productId, qty: 1 });
    setMoved(item.productId);
  }

  if (!signedIn) {
    return (
      <Screen testID="screen-wishlist" title={t('wishlist.title')}>
        <NeedSignIn go={(name) => navigation.navigate(name)} reason={t('wishlist.signInBody')} />
      </Screen>
    );
  }
  const items = list.data?.items ?? [];
  return (
    <Screen testID="screen-wishlist" title={t('wishlist.title')}>
      {list.isError && !list.data ? <Problem error={list.error} onRetry={() => list.refetch()} /> : null}
      {list.isPending ? <LoadingRows rows={3} label={t('home.common.loading')} testID="wishlist-loading" /> : null}
      <Problem inline error={error} />
      {list.data?.notices?.map((notice) => <Banner key={notice} tone="warn">{notice}</Banner>)}
      {list.data && !items.length ? <EmptyState testID="wishlist-empty" title={t('wishlist.emptyTitle')} action={<Button label={t('wishlist.browse')} onPress={() => navigation.navigate('catalog.index')} />}>{t('wishlist.emptyBody')}</EmptyState> : null}
      {items.map((item) => (
        <Card key={item.productId} testID={`wish-${item.productId}`}>
          <View style={{ flexDirection: 'row', gap: theme.space[3] }}>
            <View style={{ width: 72 }}><Photo uri={safeUrl(config.origin, item.image)} name={item.name} /></View>
            <View style={{ flex: 1, gap: theme.space[1] }}>
              <Text variant="title">{item.name}</Text>
              {item.pricePaise !== null ? <Text variant="body" testID={`wish-price-${item.productId}`}>{formatPaise(item.pricePaise)}</Text> : null}
              {item.state === 'sold_out' ? <Badge tone="bad" label={t('wishlist.soldOut')} /> : null}
              {item.state === 'inactive' ? <Badge tone="bad" label={t('wishlist.gone')} /> : null}
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: theme.space[2], marginTop: theme.space[3], flexWrap: 'wrap' }}>
            {item.available ? <Button testID={`wish-add-${item.productId}`} label={moved === item.productId ? t('wishlist.added') : item.needsOption ? t('wishlist.choose') : t('wishlist.add')} onPress={() => toBag(item)} /> : null}
            <Button testID={`wish-remove-${item.productId}`} kind="quiet" label={t('wishlist.remove')} onPress={() => remove(item.productId)} />
          </View>
        </Card>
      ))}
    </Screen>
  );
}
