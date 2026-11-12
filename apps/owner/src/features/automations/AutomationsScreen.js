import React, { useState } from 'react';
import { View } from 'react-native';
import { OfflineBanner, formatDate, useStrings } from '@bhava/app-core';
import { Badge, Button, Card, Choices, Divider, ListRow, Screen, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { PagedState, StatusNotices, usePaged, useWritable } from '../compliance/kit.js';
import { STATES, STATE_TONES } from './form.js';

export const LIST_KEY = ['automations', 'list'];

/**
 * DM automations (the console's /automations, Automations.dc.html): a comment, story reply or DM comes in and the
 * right message goes back by itself. The list reads from the offline cache; a new one needs a connection.
 */
export default function AutomationsScreen({ navigation }) {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const theme = useTheme();
  const writable = useWritable();
  const [state, setState] = useState('');
  const list = usePaged(LIST_KEY, (query) => api.automations.list(query), { ...(state ? { state } : {}), limit: 30 });
  const summary = (row) => t('automations.list.line', {
    reach: row.mediaCount > 0 ? t('automations.list.posts', { count: row.mediaCount }) : t(`automations.trigger.short.${row.triggerType}`),
    mode: t(row.linkMode === 'two_tap' ? 'automations.list.twoTaps' : 'automations.list.oneTap'),
    sends: row.sends,
    when: formatDate(row.updatedAt, { locale }),
  });
  const open = (id) => navigation?.navigate('automations.detail', { id: String(id) });
  return (
    <Screen testID="screen-automations" title={t('automations.title')}>
      <OfflineBanner offline={!writable} />
      <Text variant="small">{t('automations.intro')}</Text>
      <StatusNotices />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
        <Button testID="automations-new" label={t('automations.new')} disabled={!writable} onPress={() => open('new')} />
        <Button testID="automations-ice-breakers" kind="secondary" label={t('automations.ice.title')} onPress={() => navigation?.navigate('automations.iceBreakers')} />
      </View>
      <Choices testID="automations-filter" label={t('automations.filter')} value={state} onChange={setState} options={[{ value: '', label: t('automations.all') }, ...STATES.map((value) => ({ value, label: t(`automations.state.${value}`) }))]} />
      <Card>
        <PagedState
          query={list}
          testID="automations"
          emptyTitle={t(state ? 'automations.emptyFiltered' : 'automations.empty')}
          emptyBody={t(state ? 'automations.tryAnother' : 'automations.emptyBody')}
          emptyAction={state ? null : <Button testID="automations-first" kind="secondary" label={t('automations.first')} disabled={!writable} onPress={() => open('new')} />}
        >
          {list.items.map((row, i) => (
            <View key={row.id}>
              {i > 0 ? <Divider /> : null}
              <ListRow testID={`automation-${row.id}`} title={row.name} subtitle={summary(row)} end={<Badge label={t(`automations.state.${row.state}`)} tone={STATE_TONES[row.state] ?? 'neutral'} />} onPress={() => open(row.id)} />
            </View>
          ))}
        </PagedState>
      </Card>
    </Screen>
  );
}
