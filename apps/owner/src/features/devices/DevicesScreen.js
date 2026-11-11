import React, { useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Smartphone from 'lucide-react-native/icons/smartphone';
import Monitor from 'lucide-react-native/icons/monitor';
import { OfflineBanner, errorKey, formatWhen, useOnline, useStrings } from '@bhava/app-core';
import { Badge, Banner, Button, Card, ConfirmSheet, Divider, EmptyState, ListRow, ListState, Screen, Text, useTheme } from '@bhava/ui';
import { useServices, useSession } from '../../shell/hooks.js';
import { signOutEverywhere } from '../../shell/sign-out.js';

export const DEVICES_KEY = ['auth', 'devices'];

/** What a device is called: its own name, or what it is. */
const nameOf = (t, device) => device.name?.trim() || t(`devices.platform.${device.platform}`) || t('devices.unnamed');

/**
 * Settings > Devices (P-08). Signing a device out here ends its refresh family on the server; that phone is signed
 * out on its next call, which its heartbeat makes within a minute. Signing out this phone signs out here at once.
 * Revoking needs a connection and is never held up by a re-auth.
 */
export default function DevicesScreen() {
  const { api, session, store } = useServices();
  const { offline } = useSession();
  const online = useOnline() && !offline;
  const queryClient = useQueryClient();
  const theme = useTheme();
  const { t, locale } = useStrings();
  const [chosen, setChosen] = useState(null);

  const devices = useQuery({ queryKey: DEVICES_KEY, queryFn: () => api.auth.devices() });
  const revoke = useMutation({
    mutationFn: (device) => api.auth.revokeDevice(device.id),
    onSuccess: async (_answer, device) => {
      setChosen(null);
      if (device.current) {
        await signOutEverywhere({ session, store, requireServer: false }); // the revoke itself ended it on the server
        return;
      }
      queryClient.setQueryData(DEVICES_KEY, (old) => (old ? { ...old, devices: old.devices.filter((d) => d.id !== device.id) } : old));
    },
  });

  const list = devices.data?.devices ?? [];
  const describe = (device) =>
    [
      t(`devices.platform.${device.platform}`),
      device.platform === 'web' ? null : t(`devices.app.${device.app}`, { version: device.appVersion }).trim(),
      t('devices.lastSeen', { when: formatWhen(t, device.lastSeenAt, { locale }) }),
    ].filter(Boolean).join(' · ');

  return (
    <Screen testID="screen-devices" title={t('devices.title')}>
      <OfflineBanner offline={!online} />
      <Text variant="small">{t('devices.intro')}</Text>
      {revoke.isError ? <Banner tone="bad" testID="devices-failed">{t(revoke.error?.code === 'offline' ? 'offline.writeDisabled' : 'devices.failed')}</Banner> : null}
      <ListState
        testID="devices"
        loading={devices.isPending}
        error={devices.error}
        empty={list.length === 0}
        loadingLabel={t('common.loading')}
        errorTitle={t('error.title')}
        errorBody={devices.error ? t(errorKey(devices.error)) : ''}
        onRetry={() => devices.refetch()}
        retryLabel={t('common.retry')}
        emptyView={<EmptyState title={t('devices.empty')} />}
      >
        <Card>
          {list.map((device, i) => {
            const Icon = device.platform === 'web' ? Monitor : Smartphone;
            const name = nameOf(t, device);
            return (
              <View key={device.id}>
                {i > 0 ? <Divider /> : null}
                <ListRow
                  testID={`device-${device.id}`}
                  title={name}
                  subtitle={describe(device)}
                  start={<Icon color={theme.color.ink2} size={22} />}
                  end={
                    <View style={{ alignItems: 'flex-end', gap: theme.space[1] }}>
                      {device.current ? <Badge testID={`device-${device.id}-current`} label={t('devices.thisPhone')} tone="primary" /> : null}
                      {device.deviceUnlock ? <Badge label={t('devices.unlockOn')} tone="good" /> : null}
                      <Button
                        testID={`device-${device.id}-revoke`}
                        kind="quiet"
                        label={t('devices.signOut')}
                        accessibilityHint={t('devices.signOutLabel', { name })}
                        disabled={!online}
                        onPress={() => setChosen(device)}
                      />
                    </View>
                  }
                />
              </View>
            );
          })}
        </Card>
      </ListState>
      <ConfirmSheet
        testID="devices-confirm"
        visible={Boolean(chosen)}
        title={chosen ? t('devices.confirm.title', { name: nameOf(t, chosen) }) : ''}
        confirmLabel={t('devices.confirm.action')}
        cancelLabel={t('common.cancel')}
        onCancel={() => setChosen(null)}
        onConfirm={() => revoke.mutate(chosen)}
        busy={revoke.isPending}
        disabled={!online}
      >
        {chosen ? `${t('devices.confirm.body')}${chosen.current ? ` ${t('devices.confirm.thisPhone')}` : ''}` : ''}
      </ConfirmSheet>
    </Screen>
  );
}
