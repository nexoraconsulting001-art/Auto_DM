import React from 'react';
import { Share, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core';
import { Button, Card, Screen, Text } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { CopyLine, Fact, Offline, RecordView, formatPaise } from '../orders/kit/ui.js';

/**
 * The seller's referral link (PRD 5.20): shared on the sign-up page and on the creator page, never inside a DM. The
 * referrer is rewarded once, when the referred account starts a paid plan. The numbers are the server's.
 */
export default function ReferralsScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const query = useQuery({ queryKey: ['referrals'], queryFn: () => api.referrals.get() });
  return (
    <Screen testID="screen-referrals" title={t('referrals.title')}>
      <Offline />
      <RecordView query={query} testID="referrals">
        {(data) => (
          <View style={{ gap: 12 }}>
            <Card testID="referrals-link-card">
              <Text variant="title">{t('referrals.share')}</Text>
              <Text variant="small">{t('referrals.how')}</Text>
              <CopyLine testID="referrals-link" label={t('referrals.link')} value={data.link} />
              <Button testID="referrals-share" label={t('referrals.send')} onPress={() => { Share.share({ message: data.link }).catch(() => {}); }} />
              <Text variant="meta">{t('referrals.neverDm')}</Text>
            </Card>
            <Card testID="referrals-counts">
              <Fact testID="referrals-pending" label={t('referrals.pending')} value={String(data.counts.pending)} />
              <Fact testID="referrals-credited" label={t('referrals.credited')} value={String(data.counts.credited)} />
              <Fact testID="referrals-blocked" label={t('referrals.blocked')} value={String(data.counts.blocked)} />
              <Fact testID="referrals-earned" label={t('referrals.earned')} value={formatPaise(data.creditedPaise)} strong />
              {data.rewardPaise > 0 ? <Text variant="meta">{t('referrals.reward', { amount: formatPaise(data.rewardPaise) })}</Text> : <Text variant="meta">{t('referrals.rewardTbd')}</Text>}
              {data.counts.pending + data.counts.credited + data.counts.blocked === 0 ? <Text variant="small" testID="referrals-empty">{t('referrals.empty')}</Text> : null}
              {data.counts.blocked > 0 ? <Text variant="meta">{t('referrals.blockedWhy')}</Text> : null}
            </Card>
          </View>
        )}
      </RecordView>
    </Screen>
  );
}
