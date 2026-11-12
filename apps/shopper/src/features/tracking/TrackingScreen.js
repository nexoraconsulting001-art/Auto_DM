/** Where a parcel is: the steps from the server's status, and for a signed-in shopper the courier, tracking number and scans. */
import React from 'react';
import { Linking, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useStrings } from '@bhava/app-core/strings';
import { safeUrl } from '@bhava/store-client';
import { Banner, Button, Card, ListRow, LoadingRows, Screen, Section, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../services.js';
import { Problem, useBuy, useSessionState, useStoreQuery } from '../cart/ui.js';

/** The steps a parcel goes through, in order. Statuses the server uses before a step map to the first. */
export const STEPS = Object.freeze(['placed', 'packed', 'shipped', 'out_for_delivery', 'delivered']);
const STEP_OF = { pending: 0, new: 0, packed: 1, ready_to_ship: 1, shipped: 2, out_for_delivery: 3, delivered: 4 };
export const stepOf = (status) => STEP_OF[status] ?? -1;

export default function TrackingScreen() {
  const { t } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const token = String(useRoute().params?.token ?? '');
  const { config } = useServices();
  const { buy } = useBuy();
  const signedIn = useSessionState().status === 'signedIn';
  const state = useStoreQuery(['order-state', token], () => buy.state(token), { enabled: token !== '' });
  const number = state.data?.orderNumber;
  const detail = useStoreQuery(['order', number], () => buy.call('appOrder', { params: { orderNumber: number } }), { enabled: signedIn && Boolean(number) });

  const status = state.data?.fulfilmentStatus;
  const at = stepOf(status);
  const ended = status === 'cancelled' || status === 'rto_initiated' || status === 'rto_delivered';
  const shipments = detail.data?.shipments ?? [];
  const open = (path) => {
    const url = safeUrl(config.origin, path);
    if (url) Linking.openURL(url);
  };
  return (
    <Screen testID="screen-tracking" title={t('tracking.title')}>
      {state.isError && !state.data ? <Problem error={state.error} onRetry={() => state.refetch()} /> : null}
      {state.isPending ? <LoadingRows rows={3} label={t('home.common.loading')} testID="tracking-loading" /> : null}
      {state.data ? (
        <>
          <Text variant="title" testID="tracking-number">{t('orders.number', { number: state.data.orderNumber })}</Text>
          {ended ? <Banner testID="tracking-ended" tone="warn">{t(`orders.fulfilment.${status}`)}</Banner> : (
            <Card testID="tracking-steps">
              <View style={{ gap: theme.space[3] }}>
                {STEPS.map((step, i) => (
                  <View key={step} testID={`step-${step}`} accessibilityState={{ selected: i <= at }} style={{ flexDirection: 'row', gap: theme.space[3], alignItems: 'center' }}>
                    <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: i <= at ? theme.color.primary : theme.color.line }} />
                    <Text variant={i === at ? 'title' : 'body'} tone={i <= at ? undefined : 'muted'}>{t(`tracking.step.${step}`)}</Text>
                    {i <= at ? <Text variant="meta" testID={`step-${step}-done`}>{i === at ? t('tracking.now') : t('tracking.done')}</Text> : null}
                  </View>
                ))}
              </View>
            </Card>
          )}
          {shipments.map((shipment) => (
            <Section key={shipment.awb || shipment.courier} title={t('tracking.parcel', { courier: shipment.courier })}>
              <ListRow testID={`awb-${shipment.awb}`} title={shipment.awb} subtitle={shipment.expectedAt ? t('tracking.expected', { date: new Date(shipment.expectedAt).toLocaleDateString() }) : shipment.status} />
              {shipment.scans.map((scan, i) => <ListRow key={`${scan.at}-${i}`} testID={`scan-${i}`} title={scan.text} subtitle={[new Date(scan.at).toLocaleString(), scan.location].filter(Boolean).join(' · ')} />)}
              {shipment.trackingPath ? <Button testID="courier-page" kind="secondary" label={t('tracking.courierPage')} onPress={() => open(shipment.trackingPath)} /> : null}
            </Section>
          ))}
          {!signedIn ? <Text variant="small" testID="tracking-signin-hint">{t('tracking.signInHint')}</Text> : null}
          <Button testID="tracking-back" kind="quiet" label={t('tracking.back')} onPress={() => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('catalog.index'))} />
        </>
      ) : null}
    </Screen>
  );
}
