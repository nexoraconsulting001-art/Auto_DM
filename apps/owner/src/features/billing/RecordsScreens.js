import React from 'react';
import { View } from 'react-native';
import { formatDate, useStrings } from '@bhava/app-core';
import { Badge, Button, Screen, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { ActionMessages, Offline, PagedList, formatPaise, openOutside, useAction, usePaged } from '../orders/kit/ui.js';

/** Bhava's own invoices and credit notes for this business, a file each (PRD 5.12). The file is a private link that expires, opened in the browser. */
export function InvoicesScreen() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const action = useAction([]);
  const query = usePaged(['billing', 'invoices'], (page) => api.billing.invoices(page));
  return (
    <Screen testID="screen-billing-invoices" title={t('billing.invoices.title')}>
      <Offline />
      <ActionMessages action={action} testID="billing-invoices-action" />
      <PagedList
        testID="billing-invoice-list"
        query={query}
        emptyTitle={t('billing.invoices.empty')}
        emptyBody={t('billing.invoices.emptyBody')}
        renderRow={(row) => (
          <View style={{ gap: 4, paddingVertical: 8 }} testID={`billing-invoice-${row.id}`}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text variant="body" style={{ flex: 1 }}>{row.number}</Text>
              <Badge label={t(row.docType === 'credit_note' ? 'billing.invoices.credit' : row.paid ? 'billing.invoices.paid' : 'billing.invoices.due')} tone={row.docType === 'credit_note' ? 'neutral' : row.paid ? 'good' : 'warn'} />
            </View>
            <Text variant="small">{`${formatDate(row.issuedAt, { locale })} · ${formatPaise(row.totalPaise)}`}</Text>
            <Text variant="meta">{t('billing.invoices.tax', { tax: formatPaise(row.cgstPaise + row.sgstPaise + row.igstPaise) })}</Text>
            {row.hasFile ? (
              <Button
                testID={`billing-invoice-${row.id}-file`}
                kind="secondary"
                label={t('billing.file.open')}
                disabled={!action.writable}
                busy={action.busy === `invoice:${row.id}`}
                onPress={async () => {
                  const file = await action.run(`invoice:${row.id}`, () => api.billing.invoiceFile(row.id));
                  if (file?.fileUrl) await openOutside(file.fileUrl);
                }}
              />
            ) : null}
          </View>
        )}
      />
    </Screen>
  );
}

/** The month's settlement statement: what came in, what went out and the closing balance. Bhava takes no share of sales. */
export function StatementsScreen() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const theme = useTheme();
  const action = useAction([]);
  const query = usePaged(['billing', 'statements'], (page) => api.billing.statements(page));
  const balance = (b) => `${formatPaise(b.amountPaise)} ${t(b.owedTo === 'business' ? 'billing.statements.owedToYou' : 'billing.statements.owedToBhava')}`;
  const open = async (row, format) => {
    const file = await action.run(`statement:${row.id}:${format}`, () => api.billing.statementFile(row.id, { format }));
    if (file?.fileUrl) await openOutside(file.fileUrl);
  };
  return (
    <Screen testID="screen-billing-statements" title={t('billing.statements.title')}>
      <Offline />
      <ActionMessages action={action} testID="billing-statements-action" />
      <PagedList
        testID="billing-statement-list"
        query={query}
        emptyTitle={t('billing.statements.empty')}
        emptyBody={t('billing.statements.emptyBody')}
        renderRow={(row) => (
          <View style={{ gap: 4, paddingVertical: 8 }} testID={`billing-statement-${row.id}`}>
            <Text variant="body">{formatDate(row.month, { locale, month: true })}</Text>
            <Text variant="small">{t('billing.statements.sales', { sales: formatPaise(row.salesPaise), refunds: formatPaise(row.refundsPaise) })}</Text>
            <Text variant="small">{t('billing.statements.fees', { fees: formatPaise(row.gatewayFeesPaise), shipping: formatPaise(row.shippingPaise) })}</Text>
            <Text variant="small">{t('billing.statements.payouts', { payouts: formatPaise(row.payoutsPaise) })}</Text>
            <Text variant="body" style={{ fontFamily: theme.font.bodySemiBold }}>{t('billing.statements.closing', { balance: balance(row.closingBalance) })}</Text>
            <Text variant="meta">{t('billing.statements.noShare')}</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {row.hasPdf ? <Button testID={`billing-statement-${row.id}-pdf`} kind="secondary" label={t('billing.statements.pdf')} disabled={!action.writable} onPress={() => open(row, 'pdf')} /> : null}
              {row.hasCsv ? <Button testID={`billing-statement-${row.id}-csv`} kind="secondary" label={t('billing.statements.csv')} disabled={!action.writable} onPress={() => open(row, 'csv')} /> : null}
            </View>
          </View>
        )}
      />
    </Screen>
  );
}
