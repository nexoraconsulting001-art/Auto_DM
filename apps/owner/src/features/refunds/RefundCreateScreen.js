import React, { useState } from 'react';
import { View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useReauth, useStrings } from '@bhava/app-core';
import { OWNER_ONLY } from '@bhava/app-core/access';
import { Banner, Button, Card, Choices, Field, Screen, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { formatPaise, newRefundKey, refundBody, refundable, rupeesText } from '../orders/kit/rules.js';
import { Offline, RecordView, RupeeField, SecretField, problemText, useAllowed, whenAsked, useWritable } from '../orders/kit/ui.js';

/**
 * Refunding an order (PRD 9.8, S-28, S-29): owner only. The amount is the one a person types (the app never sends an
 * order's own amounts) and the server holds it inside what was captured. One key per visit to this screen, so a second
 * tap, or a retry after a lost answer, is the same refund and never a second one. A cash on
 * delivery refund is paid back by hand, with its reference. The route is not one the server marks fresh, so a fresh check is
 * asked for only if the server says so.
 */
export default function RefundCreateScreen({ route }) {
  const id = Number(route?.params?.id);
  const { api } = useServices();
  const order = useQuery({ queryKey: ['orders', 'detail', id], queryFn: () => api.orders.get(id), enabled: id > 0 });
  return (
    <Screen testID="screen-refund-create">
      <Offline />
      <RecordView query={order} testID="refund-order">
        {(data) => <RefundForm order={data} returnId={Number(route?.params?.returnId) || null} />}
      </RecordView>
    </Screen>
  );
}

function RefundForm({ order, returnId }) {
  const { api } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const { runFresh } = useReauth();
  const allowed = useAllowed();
  const writable = useWritable();
  const payments = useQuery({ queryKey: ['orders', order.id, 'payments'], queryFn: () => api.payments.forOrder(order.id) });
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [paymentId, setPaymentId] = useState('');
  const [password, setPassword] = useState('');
  const [key, setKey] = useState(() => newRefundKey());
  const [problems, setProblems] = useState({});
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  const most = refundable(order);
  const captured = (payments.data?.items ?? []).filter((p) => p.status === 'captured' && p.amountPaise > p.refundedPaise);
  const byHand = order.paymentMode === 'cod' || captured.some((p) => p.provider === 'cod');
  const owner = allowed(OWNER_ONLY);

  async function submit() {
    setProblem('');
    const built = refundBody({ amountText: amount, reason, reference, paymentId: paymentId || null, returnId, idempotencyKey: key, password }, { most, byHand });
    setProblems(built.problems ?? {});
    if (built.problems) return;
    if (!writable) {
      setProblem(t('offline.writeDisabled'));
      return;
    }
    setBusy(true);
    try {
      const refund = await whenAsked(runFresh, () => api.refunds.create(order.id, built.body));
      setPassword('');
      setDone(refund);
      setKey(newRefundKey()); // the next refund, if any, is a new one
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
    } catch (error) {
      setPassword('');
      setProblem(problemText(t, error));
      if (error?.status >= 400 && error?.status < 500) await queryClient.invalidateQueries({ queryKey: ['orders'] });
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <View style={{ gap: theme.space[4] }}>
        <Banner tone={done.status === 'failed' ? 'bad' : 'good'} testID="refund-done" title={done.status === 'failed' ? t('refunds.failedTitle') : t('refunds.started', { amount: formatPaise(done.amountPaise) })}>
          {done.status === 'failed' ? t('refunds.failedBody') : t('refunds.startedBody')}
        </Banner>
        <Button testID="refund-back" kind="secondary" label={t('refunds.backToOrder')} onPress={() => navigation.goBack()} />
      </View>
    );
  }

  return (
    <View style={{ gap: theme.space[4] }}>
      <Text variant="page">{t('refunds.createTitle', { number: order.orderNumber })}</Text>
      {!owner ? <Banner tone="warn" testID="refund-owner-only">{t('orders.refund.ownerOnly')}</Banner> : null}
      <Text variant="small" testID="refund-most">{most > 0 ? t('refunds.most', { amount: formatPaise(most) }) : t('refunds.nothing')}</Text>
      <Card>
        <RupeeField testID="refund-amount" label={t('refunds.amount')} value={amount} onChangeText={setAmount} error={problems.amount ? t(problems.amount, { amount: formatPaise(most) }) : undefined} />
        {most > 0 ? <Button testID="refund-all" kind="quiet" label={t('refunds.all', { amount: formatPaise(most) })} onPress={() => setAmount(rupeesText(most))} /> : null}
        {captured.length > 1 ? (
          <Choices
            testID="refund-payment"
            label={t('refunds.fromPayment')}
            value={paymentId}
            onChange={setPaymentId}
            options={[{ value: '', label: t('refunds.anyPayment') }, ...captured.map((p) => ({ value: String(p.id), label: t('refunds.paymentLeft', { purpose: t(`orders.pay.purpose.${p.purpose}`), amount: formatPaise(p.amountPaise - p.refundedPaise) }) }))]}
          />
        ) : null}
        <Field testID="refund-reason" label={t('refunds.reason')} value={reason} onChangeText={setReason} maxLength={300} />
        {byHand ? <Field testID="refund-reference" label={t('refunds.reference')} hint={t('refunds.referenceHint')} value={reference} onChangeText={setReference} maxLength={100} error={problems.reference ? t(problems.reference) : undefined} /> : null}
        <SecretField testID="refund-password" label={t('refunds.password')} hint={t('refunds.passwordWhy')} value={password} onChangeText={setPassword} error={problems.password ? t(problems.password) : undefined} />
        {problem ? <Banner tone="bad" testID="refund-problem">{problem}</Banner> : null}
        <Button testID="refund-submit" kind="danger" label={t('refunds.submit')} onPress={() => { submit(); }} busy={busy} disabled={!writable || !owner || most <= 0} />
      </Card>
    </View>
  );
}
