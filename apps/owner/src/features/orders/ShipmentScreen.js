import React from 'react';
import { Linking, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core';
import { Button, Card, Screen, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { formatPaise, journey } from './kit/rules.js';
import { Fact, Journey, Offline, RecordView, StatusBadge, formatWhenAt } from './kit/ui.js';

/**
 * One parcel: its courier, AWB and the journey the courier reported, drawn the way the shopper's tracking page draws
 * it. The tracking link is the seller's own page, never the courier's.
 */
export default function ShipmentScreen({ route }) {
  const id = Number(route?.params?.id);
  const { api } = useServices();
  const { t, locale } = useStrings();
  const theme = useTheme();
  const shipment = useQuery({ queryKey: ['orders', 'shipment', id], queryFn: () => api.shipments.get(id), enabled: id > 0 });
  return (
    <Screen testID="screen-shipment">
      <Offline />
      <RecordView query={shipment} testID="shipment">
        {(data) => {
          const steps = journey(data).map((event, i) => ({ key: `${event.at}-${i}`, title: t(`orders.status.shipment.${event.status}`), meta: [event.location, formatWhenAt(event.at, locale)].filter(Boolean).join(' · '), state: event.state }));
          if (data.status !== 'delivered' && !['cancelled', 'lost', 'rto_delivered'].includes(data.status)) steps.push({ key: 'next', title: t('orders.status.shipment.delivered'), meta: t('orders.ship.waiting'), state: 'next' });
          return (
            <View style={{ gap: theme.space[4] }}>
              <View style={{ gap: theme.space[2] }}>
                <Text variant="page">{data.courierName || t(`orders.ship.mode.${data.mode}`)}</Text>
                <StatusBadge group="shipment" status={data.status} testID="shipment-status" />
              </View>
              <Card>
                {data.awb ? <Fact label={t('orders.ship.awbLabel')} value={data.awb} /> : null}
                {data.codPaise ? <Fact label={t('orders.ship.collect')} value={formatPaise(data.codPaise)} /> : null}
                {data.chargePaise ? <Fact label={t('orders.ship.charge')} value={formatPaise(data.chargePaise)} /> : null}
                {data.weightGrams ? <Fact label={t('orders.ship.weight')} value={String(data.weightGrams)} /> : null}
              </Card>
              <Card><Journey steps={steps} testID="shipment-journey" /></Card>
              {/^https:\/\//i.test(data.trackingUrl ?? '') ? <Button kind="secondary" testID="shipment-track" label={t('orders.ship.track')} onPress={() => Linking.openURL(data.trackingUrl).catch(() => {})} /> : null}
            </View>
          );
        }}
      </RecordView>
    </Screen>
  );
}
