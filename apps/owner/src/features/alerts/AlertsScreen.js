import React from 'react';
import { View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { OfflineBanner, formatWhen, useStrings } from '@bhava/app-core';
import { Badge, Button, Card, Divider, Screen, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { useOpenLink } from '../../shell/context.js';
import { PagedState, Refusal, usePaged, useWritable } from '../compliance/kit.js';
import { alertLink } from './links.js';

export { alertLink };

export const ALERTS_KEY = ['alerts', 'list'];
const SEVERITY_TONE = Object.freeze({ info: 'primary', warning: 'warn', critical: 'bad' });

function AlertRow({ alert, writable, onRead, reading }) {
  const { t, locale } = useStrings();
  const theme = useTheme();
  const openLink = useOpenLink();
  const link = alertLink(alert);
  const unread = !alert.readAt;
  return (
    <View testID={`alert-${alert.id}`} style={{ gap: theme.space[1], paddingVertical: theme.space[2] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}>
        <Badge label={t(`alerts.severity.${alert.severity}`)} tone={SEVERITY_TONE[alert.severity] ?? 'neutral'} />
        {unread ? <Badge testID={`alert-${alert.id}-unread`} label={t('alerts.new')} tone="primary" /> : null}
        <Text variant="meta" style={{ flex: 1, textAlign: 'right' }}>{formatWhen(t, alert.createdAt, { locale })}</Text>
      </View>
      <Text variant="body" style={unread ? { fontFamily: theme.font.bodySemiBold } : null}>{alert.message}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
        {link ? <Button testID={`alert-${alert.id}-open`} kind="quiet" label={t('alerts.open')} onPress={() => openLink(link)} /> : null}
        {unread ? <Button testID={`alert-${alert.id}-read`} kind="quiet" label={t('alerts.markRead')} disabled={!writable} busy={reading} onPress={onRead} /> : null}
      </View>
    </View>
  );
}

/** Alerts: what the platform noticed about this business (a lost connection, a failing link, a person asking for help). */
export default function AlertsScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const queryClient = useQueryClient();
  const writable = useWritable();
  const alerts = usePaged(ALERTS_KEY, (query) => api.alerts.list(query), { limit: 30 });
  const read = useMutation({
    mutationFn: (id) => api.alerts.markRead(id),
    onSuccess: (_answer, id) => {
      const at = new Date().toISOString();
      queryClient.setQueriesData({ queryKey: ALERTS_KEY }, (old) => (old?.pages ? { ...old, pages: old.pages.map((page) => ({ ...page, items: page.items.map((a) => (a.id === id ? { ...a, readAt: a.readAt ?? at } : a)) })) } : old));
    },
  });
  return (
    <Screen testID="screen-alerts" title={t('alerts.title')}>
      <OfflineBanner offline={!writable} />
      <Text variant="small">{t('alerts.intro')}</Text>
      <Refusal error={read.error} testID="alerts-refusal" />
      <Card>
        <PagedState query={alerts} testID="alerts" emptyTitle={t('alerts.empty')} emptyBody={t('alerts.emptyBody')}>
          {alerts.items.map((alert, i) => (
            <View key={alert.id}>
              {i > 0 ? <Divider /> : null}
              <AlertRow alert={alert} writable={writable} reading={read.isPending && read.variables === alert.id} onRead={() => read.mutate(alert.id)} />
            </View>
          ))}
        </PagedState>
      </Card>
    </Screen>
  );
}
