import React, { useState } from 'react';
import { View } from 'react-native';
import { OfflineBanner, useStrings } from '@bhava/app-core';
import { isAllowed, staffWith } from '@bhava/app-core/access';
import { Badge, Button, Card, Choices, Divider, ListRow, Screen, Sheet, Text, useTheme } from '@bhava/ui';
import { useServices, useSession } from '../../shell/hooks.js';
import { useOpenLink } from '../../shell/context.js';
import { PagedState, formatDateTime, usePaged, useWritable } from './kit.js';
import { OUTCOME_CODES, REASON_CODES, describeKind, describeOutcome, describeReason, isOutcome } from './reasons.js';

/** Reasons a filter can pick: those that are not also an outcome, which the chips above already offer. */
const FILTER_REASONS = REASON_CODES.filter((code) => !isOutcome(code));

function LogRow({ row, canAsk }) {
  const { t, locale } = useStrings();
  const theme = useTheme();
  const openLink = useOpenLink();
  const { label, tone } = describeOutcome(t, row.outcome);
  const where = t(row.channel === 'facebook' ? 'compliance.log.facebook' : 'compliance.log.instagram');
  return (
    <View testID={`log-${row.id}`} style={{ gap: theme.space[1], paddingVertical: theme.space[2] }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: theme.space[2] }}>
        <Text variant="body" style={{ flex: 1 }}>{describeReason(t, row.reason || row.outcome)}</Text>
        <Badge label={label} tone={tone} />
      </View>
      <Text variant="meta">{`${describeKind(t, row.kind)}, ${where}, ${formatDateTime(row.at, { locale })}`}</Text>
      {row.reason ? <Text variant="caption" testID={`log-${row.id}-code`}>{row.reason}</Text> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
        {row.automationId ? <Button testID={`log-${row.id}-automation`} kind="quiet" label={t('compliance.log.openAutomation')} onPress={() => openLink(`/automations/${row.automationId}`)} /> : null}
        {row.commentId && canAsk ? <Button testID={`log-${row.id}-why`} kind="quiet" label={t('compliance.log.whyNoDm')} onPress={() => openLink(`/inbox/why-no-dm/${encodeURIComponent(row.commentId)}`)} /> : null}
      </View>
    </View>
  );
}

/**
 * The compliance log: every decision about a message, newest first, with the reason the engine gave. People are never
 * named here; the rows hold no person's id. Filters are only what the API accepts.
 */
export default function ComplianceLogScreen() {
  const { api } = useServices();
  const { user } = useSession();
  const { t } = useStrings();
  const writable = useWritable();
  const [outcome, setOutcome] = useState('');
  const [reason, setReason] = useState('');
  const [picking, setPicking] = useState(false);
  const filters = { ...(outcome ? { outcome } : {}), ...(reason ? { reason } : {}), limit: 30 };
  const log = usePaged(['compliance', 'log'], (query) => api.compliance.activity(query), filters);
  const filtered = Boolean(outcome || reason);
  const canAsk = isAllowed(user, staffWith('inbox'));
  return (
    <Screen testID="screen-compliance-log" title={t('compliance.log.title')}>
      <OfflineBanner offline={!writable} />
      <Text variant="small">{t('compliance.log.intro')}</Text>
      <Choices
        testID="log-outcome"
        label={t('compliance.log.filterOutcome')}
        value={outcome}
        onChange={setOutcome}
        options={[{ value: '', label: t('compliance.log.all') }, ...OUTCOME_CODES.map((code) => ({ value: code, label: describeOutcome(t, code).label }))]}
      />
      <Button testID="log-reason" kind="secondary" label={reason ? describeReason(t, reason) : t('compliance.log.anyReason')} onPress={() => setPicking(true)} />
      <Card>
        <PagedState
          query={log}
          testID="compliance-log"
          emptyTitle={t(filtered ? 'compliance.log.noMatch' : 'compliance.log.empty')}
          emptyBody={t(filtered ? 'compliance.log.tryAnother' : 'compliance.log.emptyBody')}
          emptyAction={filtered ? <Button kind="secondary" label={t('compliance.log.showAll')} onPress={() => { setOutcome(''); setReason(''); }} /> : null}
        >
          {log.items.map((row, i) => (
            <View key={row.id}>
              {i > 0 ? <Divider /> : null}
              <LogRow row={row} canAsk={canAsk} />
            </View>
          ))}
        </PagedState>
      </Card>
      <Sheet testID="log-reasons" visible={picking} onClose={() => setPicking(false)} title={t('compliance.log.reason')} closeLabel={t('common.close')}>
        <ListRow testID="log-reason-any" title={t('compliance.log.anyReason')} onPress={() => { setReason(''); setPicking(false); }} />
        {FILTER_REASONS.map((code) => (
          <ListRow key={code} testID={`log-reason-${code}`} title={describeReason(t, code)} subtitle={code} onPress={() => { setReason(code); setPicking(false); }} />
        ))}
      </Sheet>
    </Screen>
  );
}
