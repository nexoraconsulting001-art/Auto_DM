import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core';
import { Banner, Card, Choices, ListRow, Screen, Text } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { useOpenLink } from '../../shell/context.js';
import { formatPaise, monthRange } from '../orders/kit/rules.js';
import { Fact, Offline, PagedList, RecordView, StatusBadge, formatWhenAt, usePaged } from '../orders/kit/ui.js';

const MONTHS = [0, -1, -2];

/**
 * The settlement statement (PRD 9.7): a month's sales, the gateway's fees, courier charges, refunds and what is owed to
 * the business, then each line. Every number is the server's; the app adds nothing up.
 */
export default function StatementScreen() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const openLink = useOpenLink();
  const [offset, setOffset] = useState(0);
  const range = monthRange(offset);
  const summary = useQuery({ queryKey: ['payments', 'summary', range], queryFn: () => api.settlements.summary(range) });
  const lines = usePaged(['payments', 'lines', range], (page) => api.settlements.list({ ...range, ...page }));
  const label = (n) => {
    const at = new Date(`${monthRange(n).from}T00:00:00+05:30`);
    try {
      return new Intl.DateTimeFormat(locale === 'hi' ? 'hi-IN' : 'en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(at);
    } catch {
      return monthRange(n).from.slice(0, 7);
    }
  };
  return (
    <Screen testID="screen-statement" title={t('payments.statement.title')}>
      <Offline />
      <Choices testID="statement-month" label={t('payments.statement.month')} value={offset} onChange={setOffset} options={MONTHS.map((n) => ({ value: n, label: label(n) }))} />
      <RecordView query={summary} testID="statement-summary">
        {(data) => (
          <Card testID="statement-totals">
            <Fact label={t('payments.statement.sales')} value={formatPaise(data.salesPaise)} />
            <Fact label={t('payments.statement.fees')} value={`−${formatPaise(data.gatewayFeesPaise)}`} />
            <Fact label={t('payments.statement.shipping')} value={`−${formatPaise(data.shippingChargesPaise)}`} />
            <Fact label={t('payments.statement.refunds')} value={`−${formatPaise(data.refundsPaise)}`} />
            <Fact label={t('payments.statement.payable')} value={formatPaise(data.payablePaise)} strong testID="statement-payable" />
            {data.recoverablePaise > 0 ? <Fact label={t('payments.statement.recoverable')} value={formatPaise(data.recoverablePaise)} /> : null}
            {data.inReview > 0 ? <Banner tone="warn" testID="statement-review">{t('payments.statement.inReview', { count: data.inReview })}</Banner> : null}
          </Card>
        )}
      </RecordView>
      <Text variant="title">{t('payments.statement.lines')}</Text>
      <PagedList
        testID="statement-lines"
        query={lines}
        emptyTitle={t('payments.statement.empty')}
        renderRow={(line) => (
          <ListRow
            testID={`statement-line-${line.id}`}
            title={`${t(`payments.kind.${line.kind}`)} · ${line.creditPaise ? formatPaise(line.creditPaise) : `−${formatPaise(line.debitPaise)}`}`}
            subtitle={[line.orderNumber, formatWhenAt(line.at, locale)].filter(Boolean).join(' · ')}
            end={line.status === 'review' ? <StatusBadge group="hold" status="review" /> : null}
            onPress={line.orderId ? () => openLink(`/orders/${line.orderId}`) : undefined}
          />
        )}
      />
    </Screen>
  );
}
