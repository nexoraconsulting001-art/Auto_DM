import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OfflineBanner, errorKey, useOnline, useStrings } from '@bhava/app-core';
import { Banner, Button, Card, Divider, ErrorState, Field, LoadingRows, Screen, Section, Text, Toggle, useTheme } from '@bhava/ui';
import { useServices, useSession } from '../../shell/hooks.js';

export const PREFS_KEY = ['notifications', 'prefs'];
const CHANNELS = ['push', 'email', 'whatsapp'];
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The phone's own time zone, which quiet hours are kept in. */
export function deviceTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
  } catch {
    return 'Asia/Kolkata';
  }
}

/**
 * The choices per kind and channel, and quiet hours (PRD 5.13). The server says which kinds exist, which channels each
 * may be switched on, which are security notices that stay on, and which senders are set up at all; this screen draws
 * exactly that. Each switch is saved as it is flipped; nothing is changed offline.
 */
export default function NotificationSettingsScreen() {
  const { api } = useServices();
  const { offline } = useSession();
  const online = useOnline() && !offline;
  const queryClient = useQueryClient();
  const theme = useTheme();
  const { t } = useStrings();
  const prefs = useQuery({ queryKey: PREFS_KEY, queryFn: () => api.notifications.prefs() });
  const save = useMutation({
    mutationFn: (body) => api.notifications.savePrefs(body),
    onSuccess: (answer) => queryClient.setQueryData(PREFS_KEY, answer),
  });

  const quiet = prefs.data?.quietHours;
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  useEffect(() => {
    if (quiet) {
      setFrom(quiet.from);
      setTo(quiet.to);
    }
  }, [quiet?.from, quiet?.to]); // eslint-disable-line react-hooks/exhaustive-deps

  if (prefs.isPending) return <Screen testID="screen-notification-settings" title={t('notifications.settings')}><LoadingRows label={t('common.loading')} /></Screen>;
  if (!prefs.data) {
    return (
      <Screen testID="screen-notification-settings" title={t('notifications.settings')}>
        <OfflineBanner offline={!online} />
        <ErrorState testID="prefs-error" title={t('error.title')} onRetry={() => prefs.refetch()} retryLabel={t('common.retry')}>{t(errorKey(prefs.error))}</ErrorState>
      </Screen>
    );
  }

  const { kinds, events, available } = prefs.data;
  const busy = save.isPending;
  const timesOk = CLOCK.test(from) && CLOCK.test(to);
  const flip = (kind, channel, value) => save.mutate({ events: { [kind]: { [channel]: value } } });

  return (
    <Screen testID="screen-notification-settings" title={t('notifications.settings')}>
      <OfflineBanner offline={!online} />
      {save.isError ? <Banner tone="bad" testID="prefs-failed">{t(save.error?.code === 'offline' ? 'offline.writeDisabled' : 'error.saveFailed')}</Banner> : null}

      <Section title={t('notifications.quiet')}>
        <Card>
          <Toggle
            testID="prefs-quiet"
            title={t('notifications.quiet')}
            subtitle={t('notifications.quietBody')}
            value={quiet.enabled}
            disabled={!online || busy}
            onValueChange={(enabled) => save.mutate({ quietHours: { enabled, from: quiet.from, to: quiet.to, timezone: deviceTimeZone() } })}
          />
          {quiet.enabled ? (
            <View style={{ gap: theme.space[3] }}>
              <View style={{ flexDirection: 'row', gap: theme.space[3] }}>
                <View style={{ flex: 1 }}><Field testID="prefs-quiet-from" label={t('notifications.quietFrom')} value={from} onChangeText={setFrom} keyboardType="numbers-and-punctuation" maxLength={5} error={from && !CLOCK.test(from) ? t('notifications.badTime') : undefined} /></View>
                <View style={{ flex: 1 }}><Field testID="prefs-quiet-to" label={t('notifications.quietTo')} value={to} onChangeText={setTo} keyboardType="numbers-and-punctuation" maxLength={5} error={to && !CLOCK.test(to) ? t('notifications.badTime') : undefined} /></View>
              </View>
              <Button
                testID="prefs-quiet-save"
                kind="secondary"
                label={t('notifications.quietSave')}
                disabled={!online || busy || !timesOk || (from === quiet.from && to === quiet.to)}
                onPress={() => save.mutate({ quietHours: { enabled: true, from, to, timezone: deviceTimeZone() } })}
              />
            </View>
          ) : null}
        </Card>
      </Section>

      {kinds.map((kind) => (
        <Section key={kind.kind} title={kind.label} testID={`prefs-kind-${kind.kind}`}>
          <Card>
            {kind.mandatory ? <Text variant="meta">{t('notifications.mandatory')}</Text> : kind.critical ? <Text variant="meta">{t('notifications.critical')}</Text> : null}
            {CHANNELS.filter((channel) => kind.channels.includes(channel)).map((channel, i) => (
              <View key={channel}>
                {i > 0 ? <Divider /> : null}
                <Toggle
                  testID={`prefs-${kind.kind}-${channel}`}
                  title={t(`notifications.channel.${channel}`)}
                  subtitle={available[channel] === false ? t('notifications.unavailable') : undefined}
                  value={Boolean(events[kind.kind]?.[channel])}
                  disabled={!online || busy || kind.mandatory || available[channel] === false}
                  onValueChange={(value) => flip(kind.kind, channel, value)}
                />
              </View>
            ))}
            <Text variant="meta">{t('notifications.inapp')}</Text>
          </Card>
        </Section>
      ))}
    </Screen>
  );
}
