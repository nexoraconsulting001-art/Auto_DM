/** One order: what was bought, the server's totals, where it is, and what can be done now (track, reorder, cancel, return, review). */
import React, { useState } from 'react';
import { Linking, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core/strings';
import { formatPaise, safeUrl } from '@bhava/store-client';
import { Badge, Banner, Button, Card, ConfirmSheet, ListRow, LoadingRows, Screen, Section, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../services.js';
import { Photo } from '../../shell/parts.js';
import { NeedSignIn, Problem, Totals, useBag, useBuy, useSessionState, useStoreQuery } from '../cart/ui.js';
import { paymentWords } from '../checkout/placing.js';

export default function OrderScreen() {
  const { t } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const orderNumber = String(useRoute().params?.orderNumber ?? '');
  const { services, buy } = useBuy();
  const { cart } = useBag();
  const { config } = useServices();
  const signedIn = useSessionState().status === 'signedIn';
  const query = useStoreQuery(['order', orderNumber], () => buy.call('appOrder', { params: { orderNumber } }), { enabled: signedIn && orderNumber !== '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const [reordered, setReordered] = useState(null);

  async function reorder() {
    setBusy(true);
    setError(null);
    try {
      const answer = await buy.call('appReorder', { params: { orderNumber } });
      // Today's prices and stock come with the bag the server built; the bag here becomes that one, and nothing is placed.
      await cart.replace(answer.lines.filter((l) => l.state === 'ok' || l.state === 'capped').map((l) => ({ productId: l.productId, variantId: l.variantId ?? null, qty: l.qty })), { sync: false });
      if (answer.addressId && services.checkout) services.checkout.preferred.addressId = answer.addressId;
      setReordered(answer);
    } catch (failed) {
      setError(failed);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      await buy.call('accountOrderCancel', { params: { orderNumber }, body: {} });
      setCancelling(false);
      await queryClient.invalidateQueries({ queryKey: ['buy'] });
    } catch (failed) {
      setError(failed);
      setCancelling(false);
    } finally {
      setBusy(false);
    }
  }

  if (!signedIn) {
    return (
      <Screen testID="screen-order" title={t('orders.title')}>
        <NeedSignIn go={(name) => navigation.navigate(name)} reason={t('orders.signInBody')} />
      </Screen>
    );
  }
  const order = query.data;
  const words = order ? paymentWords(order.paymentStatus) : null;
  const openInvoice = (path) => {
    const url = safeUrl(config.origin, path);
    if (url) Linking.openURL(url);
  };
  return (
    <Screen testID="screen-order" title={order ? t('orders.number', { number: order.orderNumber }) : t('orders.title')}>
      {query.isError && !order ? <Problem error={query.error} onRetry={() => query.refetch()} /> : null}
      {query.isPending ? <LoadingRows rows={3} label={t('home.common.loading')} testID="order-loading" /> : null}
      <Problem inline error={error} testID="order-error" />
      {reordered ? (
        <Banner testID="reorder-result" tone={reordered.missing.length ? 'warn' : 'good'} action={<Button testID="reorder-cart" label={t('orders.goToCart')} onPress={() => navigation.navigate('cart.index')} />}>
          {[t('orders.reordered', { count: reordered.added }), ...reordered.missing.map((m) => t('orders.missing', { name: m.name })), ...reordered.notices].join('\n')}
        </Banner>
      ) : null}
      {order ? (
        <>
          <View style={{ flexDirection: 'row', gap: theme.space[2] }}>
            <Badge testID="order-fulfilment" label={t(`orders.fulfilment.${order.fulfilmentStatus}`)} />
            <Badge testID="order-payment" tone={words === 'paid' ? 'good' : words === 'failed' ? 'bad' : 'warn'} label={t(`orders.payment.${words}`)} />
          </View>
          <Section title={t('orders.items', { count: order.itemCount })}>
            {order.lines.map((line, i) => (
              <ListRow
                key={`${line.productSlug}-${i}`}
                testID={`order-line-${i}`}
                title={line.name}
                subtitle={[line.option, `× ${line.qty}`].filter(Boolean).join(' · ')}
                start={<View style={{ width: 48 }}><Photo uri={safeUrl(config.origin, line.image)} name={line.name} /></View>}
                end={<Text variant="body">{formatPaise(line.linePaise)}</Text>}
                onPress={line.productSlug ? () => navigation.navigate('product.index', { slug: line.productSlug }) : undefined}
              />
            ))}
          </Section>
          <Card><Totals totals={order.totals} mode={order.paymentMode} testID="order-totals" /></Card>
          <Section title={t('orders.deliveredTo')}>
            <Text variant="body">{[order.address.name, order.address.line1, order.address.line2, order.address.city, order.address.state, order.address.pincode].filter(Boolean).join(', ')}</Text>
          </Section>
          {order.timeline.length ? (
            <Section title={t('orders.timeline')}>
              {order.timeline.map((step, i) => <ListRow key={`${step.status}-${i}`} testID={`timeline-${i}`} title={t(`orders.fulfilment.${step.status}`)} subtitle={new Date(step.at).toLocaleString()} />)}
            </Section>
          ) : null}
          <View style={{ gap: theme.space[2] }}>
            <Button testID="order-track" kind="secondary" label={t('orders.track')} onPress={() => navigation.navigate('tracking.index', { token: order.token })} />
            {order.canReorder ? <Button testID="order-reorder" label={t('orders.reorder')} busy={busy} onPress={reorder} /> : null}
            {order.canReturn ? <Button testID="order-return" kind="secondary" label={t('orders.return')} onPress={() => navigation.navigate('returns.index', { orderNumber })} /> : null}
            {order.fulfilmentStatus === 'delivered' ? order.lines.filter((l) => l.productSlug).map((l, i) => (
              <Button key={l.productSlug} testID={`order-review-${i}`} kind="quiet" label={t('orders.review', { name: l.name })} onPress={() => navigation.navigate('reviews.index', { slug: l.productSlug, orderNumber })} />
            )) : null}
            {order.canCancel ? <Button testID="order-cancel" kind="danger" label={t('orders.cancel')} onPress={() => setCancelling(true)} /> : null}
            {order.invoices.map((invoice) => <Button key={invoice.number} testID={`invoice-${invoice.number}`} kind="quiet" label={t('orders.invoice', { number: invoice.number })} onPress={() => openInvoice(invoice.path)} />)}
          </View>
        </>
      ) : null}
      <ConfirmSheet visible={cancelling} title={t('orders.cancelTitle')} confirmLabel={t('orders.cancel')} cancelLabel={t('orders.keep')} busy={busy} onConfirm={cancel} onCancel={() => setCancelling(false)} testID="cancel-sheet">
        {t('orders.cancelBody')}
      </ConfirmSheet>
    </Screen>
  );
}
