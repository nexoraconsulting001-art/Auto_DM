/** Points, their history and the referral link, in the seller's brand (P-66). Opened by a friend's referral link, it keeps the code for checkout. */
import React, { useEffect } from 'react';
import { Share, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useStrings } from '@bhava/app-core/strings';
import { formatPaise } from '@bhava/store-client';
import { Banner, Button, Card, EmptyState, ListRow, LoadingRows, Screen, Section, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../services.js';
import { useBrandName } from '../../shell/parts.js';
import { NeedSignIn, Problem, useBuy, useSessionState, useStoreQuery } from '../cart/ui.js';

export default function RewardsScreen() {
  const { t } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const brand = useBrandName();
  const { services, buy } = useBuy();
  const { checkout } = useServices();
  const code = String(useRoute().params?.code ?? '').toUpperCase();
  const signedIn = useSessionState().status === 'signedIn';
  const rewards = useStoreQuery(['rewards'], () => buy.call('appRewards'), { enabled: signedIn });

  // A friend's link: the code waits for checkout, where it is sent with the order and the server decides what it is worth.
  useEffect(() => {
    if (code && /^[A-Z0-9]{3,12}$/.test(code)) checkout.preferred.referralCode = code;
  }, [code, checkout]);

  const data = rewards.data;
  const share = () => {
    const message = data.referral.text.includes(data.referral.url) ? data.referral.text : `${data.referral.text}\n${data.referral.url}`;
    return Share.share({ message });
  };
  return (
    <Screen testID="screen-rewards" title={t('rewards.title')}>
      {code ? <Banner testID="referral-kept" tone="good" action={<Button testID="referral-shop" label={t('rewards.shop')} onPress={() => navigation.navigate('catalog.index')} />}>{t('rewards.kept', { brand })}</Banner> : null}
      {!signedIn ? <NeedSignIn go={(name) => navigation.navigate(name)} reason={t('rewards.signInBody', { brand })} /> : null}
      {signedIn && rewards.isError && !data ? <Problem error={rewards.error} onRetry={() => rewards.refetch()} /> : null}
      {signedIn && rewards.isPending ? <LoadingRows rows={3} label={t('home.common.loading')} testID="rewards-loading" /> : null}
      {data && !data.enabled ? <EmptyState testID="rewards-off" title={t('rewards.offTitle')}>{t('rewards.offBody', { brand })}</EmptyState> : null}
      {data?.enabled ? (
        <>
          <Card testID="points-card">
            <View style={{ gap: theme.space[1] }}>
              <Text variant="meta">{t('rewards.balance')}</Text>
              <Text variant="page" testID="points-balance">{data.pointsBalance}</Text>
              <Text variant="small" testID="points-value">{t('rewards.worth', { value: formatPaise(data.valuePaise) })}</Text>
              {data.pendingPoints > 0 ? <Text variant="small" testID="points-pending">{t('rewards.pending', { points: data.pendingPoints })}</Text> : null}
              {data.expiring ? <Text variant="small" tone="bad" testID="points-expiring">{t('rewards.expiring', { points: data.expiring.points, date: new Date(data.expiring.at).toLocaleDateString() })}</Text> : null}
            </View>
          </Card>
          {data.referral ? (
            <Card testID="referral-card">
              <View style={{ gap: theme.space[2] }}>
                <Text variant="title">{t('rewards.referTitle')}</Text>
                <Text variant="small">{data.referral.text}</Text>
                <Text variant="body" testID="referral-code" selectable>{data.referral.code}</Text>
                <Text variant="small" testID="referral-url" selectable>{data.referral.url}</Text>
                <Button testID="referral-share" label={t('rewards.share')} onPress={share} />
              </View>
            </Card>
          ) : null}
          <Section title={t('rewards.history')}>
            {data.history.length === 0 ? <Text variant="small" testID="history-empty">{t('rewards.noHistory')}</Text> : null}
            {data.history.map((entry, i) => (
              <ListRow key={`${entry.at}-${i}`} testID={`history-${i}`} title={entry.reason} subtitle={[new Date(entry.at).toLocaleDateString(), entry.orderNumber].filter(Boolean).join(' · ')} end={<Text variant="title" tone={entry.points >= 0 ? 'good' : 'bad'}>{entry.points > 0 ? `+${entry.points}` : String(entry.points)}</Text>} />
            ))}
          </Section>
        </>
      ) : null}
    </Screen>
  );
}
