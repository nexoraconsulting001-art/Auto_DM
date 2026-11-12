import React from 'react';
import { View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core';
import { MANAGERS, OWNER_ONLY } from '@bhava/app-core/access';
import { Banner, Button, Card, Field, ListRow, Screen, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { useOpenLink } from '../../shell/context.js';
import { STATE_OPTIONS, invoiceSettingsBody, invoiceSettingsForm } from '../orders/kit/forms.js';
import { formatPaise } from '../orders/kit/rules.js';
import { ActionMessages, Fact, Offline, PagedList, PickerField, RecordView, formatWhenAt, openOutside, useAction, useAllowed, useForm, useProblem, usePaged, useWritable } from '../orders/kit/ui.js';

const SETTINGS = ['invoices', 'settings'];

/** Invoices (PRD 9.13): every tax invoice, bill of supply and credit note, numbered by the database with no gap. */
export default function InvoicesScreen() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const navigation = useNavigation();
  const allowed = useAllowed();
  const query = usePaged(['invoices', 'list'], (page) => api.invoices.list(page));
  return (
    <Screen testID="screen-invoices" title={t('invoices.title')}>
      <Offline />
      {allowed(MANAGERS) ? <Button testID="invoices-settings" kind="secondary" label={t('invoices.settings')} onPress={() => navigation.navigate('invoices.settings')} /> : null}
      <PagedList
        testID="invoices-list"
        query={query}
        emptyTitle={t('invoices.empty')}
        renderRow={(invoice) => (
          <ListRow
            testID={`invoice-row-${invoice.id}`}
            title={`${t(`orders.invoice.kind.${invoice.docType}`)} ${invoice.number}`}
            subtitle={`${formatPaise(invoice.totalPaise)} · ${formatWhenAt(invoice.issuedAt, locale)}`}
            onPress={() => navigation.navigate('invoices.detail', { id: invoice.id })}
          />
        )}
      />
    </Screen>
  );
}

/** One invoice: its GST split and, when the file is ready, the PDF in the system's viewer. */
export function InvoiceScreen({ route }) {
  const id = Number(route?.params?.id);
  const { api } = useServices();
  const { t, locale } = useStrings();
  const theme = useTheme();
  const openLink = useOpenLink();
  const invoice = useQuery({ queryKey: ['invoices', 'detail', id], queryFn: () => api.invoices.get(id), enabled: id > 0 });
  return (
    <Screen testID="screen-invoice">
      <Offline />
      <RecordView query={invoice} testID="invoice">
        {(data) => (
          <View style={{ gap: theme.space[4] }}>
            <Text variant="page">{`${t(`orders.invoice.kind.${data.docType}`)} ${data.number}`}</Text>
            <Text variant="meta">{formatWhenAt(data.issuedAt, locale)}</Text>
            <Card testID="invoice-money">
              <Fact label={t('invoices.taxable')} value={formatPaise(data.taxablePaise)} />
              {data.cgstPaise ? <Fact label={t('invoices.cgst')} value={formatPaise(data.cgstPaise)} /> : null}
              {data.sgstPaise ? <Fact label={t('invoices.sgst')} value={formatPaise(data.sgstPaise)} /> : null}
              {data.igstPaise ? <Fact label={t('invoices.igst')} value={formatPaise(data.igstPaise)} /> : null}
              <Fact label={t('invoices.total')} value={formatPaise(data.totalPaise)} strong />
              {data.advancePaise ? <Fact label={t('invoices.advance')} value={formatPaise(data.advancePaise)} /> : null}
              {data.balancePaise ? <Fact label={t('invoices.balance')} value={formatPaise(data.balancePaise)} /> : null}
            </Card>
            {data.fileUrl ? <Button testID="invoice-open" label={t('invoices.open')} onPress={() => { openOutside(data.fileUrl); }} /> : <Banner testID="invoice-making">{t('invoices.making')}</Banner>}
            <Button testID="invoice-order" kind="secondary" label={t('invoices.order')} onPress={() => openLink(`/orders/${data.orderId}`)} />
          </View>
        )}
      </RecordView>
    </Screen>
  );
}

/** The business's GST details on every invoice. Owners and managers see them; only the owner changes them. */
export function InvoiceSettingsScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const settings = useQuery({ queryKey: SETTINGS, queryFn: () => api.invoiceSettings.get() });
  return (
    <Screen testID="screen-invoice-settings" title={t('invoices.settings')}>
      <Offline />
      <RecordView query={settings} testID="invoice-settings">
        {(data) => <SettingsForm key={JSON.stringify(data)} settings={data} />}
      </RecordView>
    </Screen>
  );
}

function SettingsForm({ settings }) {
  const { api } = useServices();
  const { t } = useStrings();
  const allowed = useAllowed();
  const writable = useWritable();
  const owner = allowed(OWNER_ONLY);
  const form = useForm(invoiceSettingsForm(settings));
  const problem = useProblem(form.problems);
  const action = useAction([SETTINGS]);
  const { values, set } = form;

  async function save() {
    const built = invoiceSettingsBody(values);
    form.setProblems(built.problems ?? {});
    if (built.problems) return;
    await action.run('save', () => api.invoiceSettings.update(built.body), { done: 'invoices.saved' });
  }

  return (
    <Card testID="invoice-settings-form">
      <Text variant="small">{t('invoices.settingsIntro')}</Text>
      <Field testID="invoice-legal-name" label={t('invoices.legalName')} value={values.legalName} onChangeText={set('legalName')} editable={owner} maxLength={200} />
      <Field testID="invoice-gstin" label={t('invoices.gstin')} hint={t('invoices.gstinHint')} value={values.gstin} onChangeText={(text) => set('gstin')(text.toUpperCase())} error={problem('gstin')} editable={owner} autoCapitalize="characters" maxLength={15} />
      <PickerField testID="invoice-state" label={t('invoices.state')} value={values.stateCode} onChange={set('stateCode')} error={problem('stateCode')} disabled={!owner} options={STATE_OPTIONS.map(([value, label]) => ({ value, label }))} />
      <Field testID="invoice-address" label={t('invoices.address')} value={values.address} onChangeText={set('address')} editable={owner} multiline maxLength={400} />
      <Field testID="invoice-prefix" label={t('invoices.prefix')} hint={t('invoices.prefixHint')} value={values.invoicePrefix} onChangeText={(text) => set('invoicePrefix')(text.toUpperCase())} error={problem('invoicePrefix')} editable={owner} autoCapitalize="characters" maxLength={4} />
      <ActionMessages action={action} testID="invoice-settings-action" />
      {owner ? <Button testID="invoice-settings-save" label={t('common.save')} disabled={!writable} busy={action.busy === 'save'} onPress={() => { save(); }} /> : <Text variant="meta">{t('invoices.ownerOnly')}</Text>}
    </Card>
  );
}
