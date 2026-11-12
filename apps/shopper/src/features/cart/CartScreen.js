/** The bag: lines priced by the server, quantities, and the way to checkout. The app adds nothing up; it draws the server's quote. */
import React from 'react';
import { View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { keepPreviousData } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core/strings';
import { Badge, Banner, Button, Card, EmptyState, LoadingRows, Screen, Text, useTheme } from '@bhava/ui';
import { safeUrl } from '@bhava/store-client';
import { Photo } from '../../shell/parts.js';
import { useServices } from '../../services.js';
import { keyOf } from './cart.js';
import { Amount, Problem, Totals, useBag, useBuy, useStoreQuery } from './ui.js';

const STATE_WORDS = { sold_out: 'cart.soldOut', inactive: 'cart.gone', capped: 'cart.capped' };

function Line({ line, onLess, onMore, onRemove }) {
  const { t } = useStrings();
  const theme = useTheme();
  const { config } = useServices();
  const buyable = line.state === 'ok' || line.state === 'capped';
  return (
    <Card testID={`line-${line.productId}-${line.variantId ?? 0}`}>
      <View style={{ flexDirection: 'row', gap: theme.space[3] }}>
        <View style={{ width: 72 }}><Photo uri={safeUrl(config.origin, line.image)} name={line.name} /></View>
        <View style={{ flex: 1, gap: theme.space[1] }}>
          <Text variant="title">{line.name}</Text>
          {line.option ? <Text variant="small">{line.option}</Text> : null}
          {STATE_WORDS[line.state] ? <Badge testID="line-state" tone={line.state === 'capped' ? 'warn' : 'bad'} label={t(STATE_WORDS[line.state])} /> : null}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Amount paise={line.unitPaise} testID="line-unit" variant="small" />
            <Amount paise={line.linePaise} testID="line-total" variant="title" />
          </View>
        </View>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[3], marginTop: theme.space[3] }}>
        {buyable ? (
          <>
            <Button testID="qty-less" kind="secondary" label="−" accessibilityHint={t('cart.less')} onPress={onLess} />
            <Text variant="title" testID="qty">{line.qty}</Text>
            <Button testID="qty-more" kind="secondary" label="+" accessibilityHint={t('cart.more')} onPress={onMore} />
          </>
        ) : null}
        <View style={{ flex: 1 }} />
        <Button testID="line-remove" kind="quiet" label={t('cart.remove')} onPress={onRemove} />
      </View>
    </Card>
  );
}

export default function CartScreen() {
  const { t } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const { buy } = useBuy();
  const { cart, lines } = useBag();
  const quote = useStoreQuery(['quote', 'bag', JSON.stringify(lines)], () => buy.quote({ lines }), { enabled: lines.length > 0, placeholderData: keepPreviousData });

  if (!lines.length) {
    return (
      <Screen testID="screen-cart" title={t('cart.title')}>
        <EmptyState testID="cart-empty" title={t('cart.emptyTitle')} action={<Button testID="go-shop" label={t('cart.startShopping')} onPress={() => navigation.navigate('catalog.index')} />}>{t('cart.emptyBody')}</EmptyState>
      </Screen>
    );
  }

  const data = quote.data;
  const stuck = Boolean(data?.lines.some((line) => line.state === 'sold_out' || line.state === 'inactive'));
  const localOf = (line) => lines.find((l) => keyOf(l) === keyOf(line));
  return (
    <Screen testID="screen-cart" title={t('cart.title')}>
      {quote.isError && !data ? <Problem error={quote.error} onRetry={() => quote.refetch()} /> : null}
      {!data && !quote.isError ? <LoadingRows rows={3} label={t('home.common.loading')} testID="cart-loading" /> : null}
      {data?.notices.map((notice) => <Banner key={notice} testID="cart-notice" tone="warn">{notice}</Banner>)}
      {data?.lines.map((line) => {
        const key = keyOf(line);
        const own = localOf(line);
        return (
          <Line
            key={key}
            line={line}
            onLess={() => cart.setQty(key, (own?.qty ?? line.qty) - 1)}
            onMore={() => cart.setQty(key, (own?.qty ?? line.qty) + 1)}
            onRemove={() => cart.remove(key)}
          />
        );
      })}
      {data ? (
        <Card>
          <Totals totals={data} />
          <Text variant="meta" style={{ marginTop: theme.space[2] }}>{t('cart.recheck')}</Text>
        </Card>
      ) : null}
      {stuck ? <Banner testID="cart-stuck" tone="bad">{t('cart.stuck')}</Banner> : null}
      <Button testID="go-checkout" label={t('cart.checkout')} disabled={!data || stuck || data.lines.length === 0} onPress={() => navigation.navigate('checkout.index')} />
    </Screen>
  );
}
