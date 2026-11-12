/** Paying for a placed order through the pay package (the hosted page by default), and what the server then says of it (P-29). */
import React, { useEffect, useRef, useState } from 'react';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useStrings } from '@bhava/app-core/strings';
import { Banner, Button, EmptyState, Loading, Screen } from '@bhava/ui';
import { useBuy } from '../cart/ui.js';
import { payAndSettle } from './flow.js';

export default function PaymentScreen() {
  const { t } = useStrings();
  const navigation = useNavigation();
  const params = useRoute().params ?? {};
  const { services, buy } = useBuy();
  const [phase, setPhase] = useState('paying');
  const [error, setError] = useState(null);
  const started = useRef(false);
  const order = useRef({ token: String(params.token ?? ''), gateway: params.gateway ?? null });

  async function run(next) {
    setPhase('paying');
    setError(null);
    try {
      const { outcome } = await payAndSettle({ pay: services.pay.pay, order: next, cart: services.cart, attempt: services.checkout.attempt });
      if (outcome === 'paid') navigation.replace('orders.byToken', { token: next.token, justPlaced: true });
      else setPhase(outcome);
    } catch (failed) {
      setError(failed);
      setPhase('cancelled');
    }
  }

  useEffect(() => {
    if (started.current || !order.current.token) return;
    started.current = true;
    run(order.current);
  }, []);

  // A second go at the same order: the server starts the payment again on the same order, so money is never taken twice.
  async function again() {
    setPhase('paying');
    setError(null);
    try {
      const retried = await buy.retry(order.current.token);
      if (retried.next === 'done') {
        await services.cart?.clear();
        navigation.replace('orders.byToken', { token: order.current.token, justPlaced: true });
        return;
      }
      order.current = { token: order.current.token, gateway: retried.gateway };
      await run(order.current);
    } catch (failed) {
      setError(failed);
      setPhase('cancelled');
    }
  }

  const status = (
    <>
      {error ? <Banner testID="payment-error" tone="warn">{error.message}</Banner> : null}
      <Button testID="pay-again" label={t('payment.again')} onPress={again} />
      <Button testID="pay-view-order" kind="secondary" label={t('payment.viewOrder')} onPress={() => navigation.replace('orders.byToken', { token: order.current.token, justPlaced: true })} />
      <Button testID="pay-back-cart" kind="quiet" label={t('payment.backToCart')} onPress={() => navigation.navigate('cart.index')} />
    </>
  );
  return (
    <Screen testID="screen-payment" title={t('payment.title')}>
      {phase === 'paying' ? <Loading testID="payment-working" label={t('payment.working')} /> : null}
      {phase === 'failed' ? <EmptyState testID="payment-failed" title={t('payment.failedTitle')}>{t('payment.failedBody')}</EmptyState> : null}
      {phase === 'cancelled' ? <EmptyState testID="payment-cancelled" title={t('payment.cancelledTitle')}>{t('payment.cancelledBody')}</EmptyState> : null}
      {phase === 'confirming' ? <EmptyState testID="payment-confirming" title={t('payment.confirmingTitle')}>{t('payment.confirmingBody')}</EmptyState> : null}
      {phase === 'failed' || phase === 'cancelled' ? status : null}
      {phase === 'confirming' ? <Button testID="pay-view-order" label={t('payment.viewOrder')} onPress={() => navigation.replace('orders.byToken', { token: order.current.token, justPlaced: true })} /> : null}
    </Screen>
  );
}
