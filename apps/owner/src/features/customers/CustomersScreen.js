import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core';
import { MANAGERS, OWNER_ONLY } from '@bhava/app-core/access';
import { Badge, Button, Card, Choices, ConfirmSheet, Field, ListRow, Screen, Section, Sheet, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { formatPaise, rowsOf } from '../orders/kit/rules.js';
import { ActionMessages, CopyLine, Fact, Offline, PagedList, RecordView, StatusBadge, formatWhenAt, openOutside, useAction, useAllowed, usePaged, useWritable } from '../orders/kit/ui.js';

/**
 * Customers (PRD 9.17, 9.18, 9.22): shoppers of this business with what they bought and what they agreed to, the older
 * accounts that still sign in with a password, and requests about a shopper's data. Phone numbers are shown masked:
 * the app never keeps a whole number.
 */
export default function CustomersScreen() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const navigation = useNavigation();
  const [tab, setTab] = useState('shoppers');
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const shoppers = usePaged(['customers', 'shoppers', search], (page) => api.shoppers.list({ ...(search ? { search } : {}), ...page }), { enabled: tab === 'shoppers' });
  const accounts = usePaged(['customers', 'accounts', search], (page) => api.customers.list({ ...(search ? { search } : {}), ...page }), { enabled: tab === 'accounts' });
  return (
    <Screen testID="screen-customers" title={t('customers.title')}>
      <Offline />
      <Field testID="customers-search" label={t('customers.search')} value={typed} onChangeText={setTyped} onSubmitEditing={() => setSearch(typed.trim().slice(0, 80))} returnKeyType="search" autoCorrect={false} />
      <Choices testID="customers-tab" label={t('customers.title')} value={tab} onChange={setTab} options={[{ value: 'shoppers', label: t('customers.shoppers') }, { value: 'accounts', label: t('customers.accounts') }]} />
      {tab === 'shoppers' ? (
        <PagedList
          testID="customers-shoppers"
          query={shoppers}
          rowKey={(row) => row.id ?? row.phone}
          emptyTitle={t('customers.empty')}
          renderRow={(shopper) => (
            <ListRow
              testID={`shopper-${shopper.id}`}
              title={shopper.name || t('customers.noName')}
              subtitle={[t('customers.orders', { count: shopper.orders, amount: formatPaise(shopper.spentPaise) }), shopper.lastOrderAt ? formatWhenAt(shopper.lastOrderAt, locale) : null].filter(Boolean).join(' · ')}
              end={shopper.signedIn ? <Badge tone="primary" label={t('customers.signedIn')} /> : null}
              onPress={shopper.id ? () => navigation.navigate('customers.shopper', { id: shopper.id }) : undefined}
            />
          )}
        />
      ) : <Accounts query={accounts} />}
      <Button testID="customers-requests" kind="secondary" label={t('customers.requests')} onPress={() => navigation.navigate('customers.requests')} />
    </Screen>
  );
}

/** Accounts that sign in with a password (from before sign-in by code). A manager can set a new one, shown once. */
function Accounts({ query }) {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const allowed = useAllowed();
  const writable = useWritable();
  const action = useAction([['customers', 'accounts']]);
  const [asking, setAsking] = useState(null);
  const [reset, setReset] = useState(null);

  async function confirmReset() {
    const customer = asking;
    const answer = await action.run(`reset:${customer.id}`, () => api.customers.resetPassword(customer.id));
    setAsking(null);
    // Held in this screen's memory only, never in the query cache, and gone when the sheet closes.
    if (answer?.temporaryPassword) setReset({ name: customer.name, temporaryPassword: answer.temporaryPassword });
  }

  return (
    <>
      <ActionMessages action={action} testID="customers-accounts-action" />
      <PagedList
        testID="customers-accounts"
        query={query}
        emptyTitle={t('customers.accountsEmpty')}
        renderRow={(customer) => (
          <ListRow
            testID={`customer-${customer.id}`}
            title={customer.name}
            subtitle={[customer.phone, t('customers.orders', { count: customer.orderCount, amount: formatPaise(customer.spentPaise) }), formatWhenAt(customer.createdAt, locale)].filter(Boolean).join(' · ')}
            end={customer.role === 'customer' && allowed(MANAGERS) ? <Button testID={`customer-${customer.id}-reset`} kind="quiet" label={t('customers.reset')} disabled={!writable} busy={action.busy === `reset:${customer.id}`} onPress={() => setAsking(customer)} /> : customer.role !== 'customer' ? <Badge label={t(customer.role === 'owner' ? 'customers.owner' : 'customers.team')} /> : null}
          />
        )}
      />
      <ConfirmSheet testID="customers-reset-confirm" visible={Boolean(asking)} title={t('customers.resetTitle', { name: asking?.name ?? '' })} confirmLabel={t('customers.resetYes')} cancelLabel={t('common.cancel')} busy={Boolean(action.busy)} disabled={!writable} onCancel={() => setAsking(null)} onConfirm={() => { confirmReset(); }}>
        {t('customers.resetBody')}
      </ConfirmSheet>
      <Sheet testID="customers-new-password" visible={Boolean(reset)} onClose={() => setReset(null)} closeLabel={t('common.done')} title={t('customers.newPassword', { name: reset?.name ?? '' })}>
        <CopyLine testID="customers-password" label={t('customers.passwordOnce')} value={reset?.temporaryPassword} />
      </Sheet>
    </>
  );
}

/** One shopper: orders, spend, what they agreed to hear, and (for the owner) a copy or the deletion of their data. */
export function ShopperScreen({ route }) {
  const id = Number(route?.params?.id);
  const { api } = useServices();
  const shopper = useQuery({ queryKey: ['customers', 'shopper', id], queryFn: () => api.shoppers.get(id), enabled: id > 0 });
  return (
    <Screen testID="screen-shopper">
      <Offline />
      <RecordView query={shopper} testID="shopper">
        {(data) => <Shopper shopper={data} />}
      </RecordView>
    </Screen>
  );
}

function Shopper({ shopper }) {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const allowed = useAllowed();
  const writable = useWritable();
  const action = useAction([['customers']]);
  const [asking, setAsking] = useState(null);
  return (
    <View style={{ gap: theme.space[4] }}>
      <Text variant="page">{shopper.name || t('customers.noName')}</Text>
      <Card testID="shopper-facts">
        {shopper.phone ? <Fact label={t('customers.phone')} value={shopper.phone} /> : null}
        {shopper.email ? <Fact label={t('customers.email')} value={shopper.email} /> : null}
        <Fact label={t('customers.ordersLabel')} value={String(shopper.orders)} />
        <Fact label={t('customers.spent')} value={formatPaise(shopper.spentPaise)} />
        {shopper.lastOrderAt ? <Fact label={t('customers.last')} value={formatWhenAt(shopper.lastOrderAt, locale)} /> : null}
      </Card>
      <Section title={t('customers.consent')}>
        <Card testID="shopper-consent">
          <Fact label={t('customers.consent.whatsapp')} value={t(shopper.marketing?.whatsapp ? 'customers.yes' : 'customers.no')} />
          <Fact label={t('customers.consent.email')} value={t(shopper.marketing?.email ? 'customers.yes' : 'customers.no')} />
        </Card>
      </Section>
      {allowed(OWNER_ONLY) ? (
        <Section title={t('customers.data')} testID="shopper-data">
          <Text variant="small">{t('customers.dataIntro')}</Text>
          <ActionMessages action={action} testID="shopper-data-action" />
          <Button testID="shopper-access" kind="secondary" label={t('customers.access')} disabled={!writable} busy={action.busy === 'access'} onPress={() => setAsking('access')} />
          <Button testID="shopper-erasure" kind="danger" label={t('customers.erasure')} disabled={!writable} busy={action.busy === 'erasure'} onPress={() => setAsking('erasure')} />
        </Section>
      ) : null}
      <ConfirmSheet
        testID="shopper-data-confirm"
        visible={Boolean(asking)}
        tone={asking === 'erasure' ? 'danger' : 'primary'}
        title={t(asking === 'erasure' ? 'customers.erasureTitle' : 'customers.accessTitle')}
        confirmLabel={t(asking === 'erasure' ? 'customers.erasure' : 'customers.access')}
        cancelLabel={t('common.cancel')}
        busy={Boolean(action.busy)}
        disabled={!writable}
        onCancel={() => setAsking(null)}
        onConfirm={async () => {
          const kind = asking;
          const done = await action.run(kind, () => api.dataRequests.create({ shopperId: shopper.id, kind }), { done: kind === 'erasure' ? 'customers.erasureStarted' : 'customers.accessStarted' });
          setAsking(null);
          if (done) navigation.navigate('customers.requests');
        }}
      >
        {t(asking === 'erasure' ? 'customers.erasureBody' : 'customers.accessBody')}
      </ConfirmSheet>
    </View>
  );
}

/** Requests about a shopper's data, from the shopper, the seller or a complaint, and (for the owner) a file of every shopper. */
export function DataRequestsScreen() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const allowed = useAllowed();
  const [status, setStatus] = useState('open');
  const query = usePaged(['customers', 'requests', status], (page) => api.dataRequests.list({ status, ...page }));
  return (
    <Screen testID="screen-data-requests" title={t('customers.requests')}>
      <Offline />
      <Choices testID="requests-show" label={t('orders.filterLabel')} value={status} onChange={setStatus} options={['open', 'completed', 'all'].map((value) => ({ value, label: t(`customers.requests.${value}`) }))} />
      <PagedList
        testID="requests-list"
        query={query}
        emptyTitle={t('customers.requestsEmpty')}
        renderRow={(request) => (
          <ListRow
            testID={`request-${request.id}`}
            title={`${t(`customers.kind.${request.kind}`)} · ${t(`customers.source.${request.source}`)}`}
            subtitle={[request.shopperId ? t('customers.shopperId', { id: request.shopperId }) : null, formatWhenAt(request.completedAt ?? request.requestedAt, locale)].filter(Boolean).join(' · ')}
            end={<StatusBadge group="dataRequest" status={request.status} />}
          />
        )}
      />
      {allowed(OWNER_ONLY) ? <ShopperFiles /> : null}
    </Screen>
  );
}

const FILES = ['customers', 'files'];

/** Every shopper of this business as a file, made in the background. Owner only. */
function ShopperFiles() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const writable = useWritable();
  const [format, setFormat] = useState('csv');
  const files = usePaged(FILES, (page) => api.shopperDownloads.list(page), { meta: { offline: false } });
  const action = useAction([FILES]);
  const queued = rowsOf(files.data).filter((file) => file.status === 'queued').map((file) => file.id).join(',');
  useEffect(() => {
    if (!queued) return undefined;
    const timer = setInterval(async () => {
      const answers = await Promise.all(queued.split(',').map((id) => api.shopperDownloads.get(Number(id)).catch(() => null)));
      if (answers.some((file) => file && file.status !== 'queued')) files.refetch();
    }, 4000);
    return () => clearInterval(timer);
  }, [queued]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Section title={t('customers.files')} testID="shopper-files">
      <Card>
        <Text variant="small">{t('customers.filesIntro')}</Text>
        <Choices testID="shopper-files-format" label={t('customers.format')} value={format} onChange={setFormat} options={[{ value: 'csv', label: 'CSV' }, { value: 'xlsx', label: 'Excel' }]} />
        <Button testID="shopper-files-make" label={t('customers.filesMake')} disabled={!writable} busy={action.busy === 'make'} onPress={() => action.run('make', () => api.shopperDownloads.create({ format }), { done: 'customers.filesMade' })} />
        <ActionMessages action={action} testID="shopper-files-action" />
      </Card>
      <PagedList
        testID="shopper-files-list"
        query={files}
        emptyTitle={t('customers.filesEmpty')}
        renderRow={(file) => (
          <ListRow
            testID={`shopper-file-${file.id}`}
            title={t('customers.fileRow', { count: file.rowCount, format: file.format.toUpperCase() })}
            subtitle={formatWhenAt(file.createdAt, locale)}
            end={file.status === 'ready' && file.fileUrl ? <Button kind="quiet" testID={`shopper-file-${file.id}-open`} label={t('orders.files.open')} onPress={() => { openOutside(file.fileUrl); }} /> : <StatusBadge group="file" status={file.status} />}
          />
        )}
      />
    </Section>
  );
}
