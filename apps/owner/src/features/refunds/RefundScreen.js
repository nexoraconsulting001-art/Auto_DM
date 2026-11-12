import React from 'react';
import { View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core';
import { OWNER_ONLY } from '@bhava/app-core/access';
import { Button, Card, Screen, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { useOpenLink } from '../../shell/context.js';
import { formatPaise } from '../orders/kit/rules.js';
import { ActionMessages, Fact, Offline, RecordView, StatusBadge, formatWhenAt, useAction, useAllowed, useWritable } from '../orders/kit/ui.js';

/** One refund: how much, how it went back, and, when the gateway refused it, the owner's way to try again. */
export default function RefundScreen({ route }) {
  const id = Number(route?.params?.id);
  const { api } = useServices();
  const { t, locale } = useStrings();
  const theme = useTheme();
  const openLink = useOpenLink();
  const allowed = useAllowed();
  const writable = useWritable();
  const key = ['orders', 'refund', id];
  const refund = useQuery({ queryKey: key, queryFn: () => api.refunds.get(id), enabled: id > 0 });
  const action = useAction([key, ['orders']]);
  return (
    <Screen testID="screen-refund">
      <Offline />
      <RecordView query={refund} testID="refund">
        {(data) => (
          <View style={{ gap: theme.space[4] }}>
            <Text variant="page">{formatPaise(data.amountPaise)}</Text>
            <StatusBadge group="refund" status={data.status} testID="refund-status" />
            <Card>
              <Fact label={t('refunds.how')} value={t(`orders.refund.method.${data.method}`)} />
              {data.reason ? <Fact label={t('refunds.reason')} value={data.reason} /> : null}
              {data.reference ? <Fact label={t('refunds.reference')} value={data.reference} /> : null}
              {data.reversalStatus !== 'none' ? <Fact label={t('refunds.reversal')} value={`${t(`refunds.reversalStatus.${data.reversalStatus}`)} · ${formatPaise(data.reversalPaise)}`} /> : null}
              <Fact label={t('refunds.asked')} value={formatWhenAt(data.createdAt, locale)} />
              {data.processedAt ? <Fact label={t('refunds.done')} value={formatWhenAt(data.processedAt, locale)} /> : null}
            </Card>
            <ActionMessages action={action} testID="refund-action" />
            {data.status === 'failed' && allowed(OWNER_ONLY) ? <Button testID="refund-retry" label={t('refunds.retry')} disabled={!writable} busy={action.busy === 'retry'} onPress={() => action.run('retry', () => api.refunds.retry(id), { done: 'refunds.retried' })} /> : null}
            <Button testID="refund-order" kind="secondary" label={t('refunds.openOrder')} onPress={() => openLink(`/orders/${data.orderId}`)} />
          </View>
        )}
      </RecordView>
    </Screen>
  );
}
