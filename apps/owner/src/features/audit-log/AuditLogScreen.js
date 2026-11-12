import React from 'react';
import { View } from 'react-native';
import { useStrings } from '@bhava/app-core';
import { ListRow, Screen, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { detailLines } from '../orders/kit/rules.js';
import { Offline, PagedList, formatWhenAt, usePaged } from '../orders/kit/ui.js';

/** "team.invite" as "Team invite": an action the log names, in words, whatever module wrote it. */
export const actionWords = (action) => String(action ?? '').replace(/[._]+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());

/**
 * The audit log (PRD 5.11): who changed what in this business, newest first. Owner only. Details hold ids, roles and
 * masked values only; the server never writes a secret, a token or a number into them.
 */
export default function AuditLogScreen() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const theme = useTheme();
  const query = usePaged(['audit-log'], (page) => api.audit.list(page), { limit: 50 });
  return (
    <Screen testID="screen-audit-log" title={t('audit-log.title')}>
      <Offline />
      <Text variant="small">{t('audit-log.intro')}</Text>
      <PagedList
        testID="audit-log"
        query={query}
        emptyTitle={t('audit-log.empty')}
        renderRow={(entry) => (
          <View testID={`audit-${entry.id}`} style={{ gap: theme.space[1], paddingVertical: theme.space[1] }}>
            <ListRow title={actionWords(entry.action)} subtitle={[t('audit-log.by', { actor: entry.actor }), entry.target, formatWhenAt(entry.createdAt, locale)].filter(Boolean).join(' · ')} />
            {detailLines(entry.details).map((line) => <Text key={line} variant="meta">{line}</Text>)}
          </View>
        )}
      />
    </Screen>
  );
}
