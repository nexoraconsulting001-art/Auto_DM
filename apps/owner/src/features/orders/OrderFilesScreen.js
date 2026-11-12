import React, { useState } from 'react';
import { Linking } from 'react-native';
import { useStrings } from '@bhava/app-core';
import { Button, Card, Choices, ListRow, Screen, Text } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { rowsOf } from './kit/rules.js';
import { ActionMessages, Offline, PagedList, StatusBadge, formatWhenAt, useAction, usePaged, useWritable } from './kit/ui.js';

const FILES = ['orders', 'files'];
const FULFILMENT = ['', 'new', 'packed', 'shipped', 'delivered', 'cancelled'];

/**
 * Orders as a file (PRD 9.9): this business's orders only, made in the background and kept for a while. The list
 * reads again every few seconds while a file is still being made.
 */
export default function OrderFilesScreen() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const writable = useWritable();
  const [fulfilment, setFulfilment] = useState('');
  const query = usePaged(FILES, (page) => api.orderDownloads.list(page));
  const queued = rowsOf(query.data).filter((file) => file.status === 'queued').map((file) => file.id).join(',');
  const action = useAction([FILES]);
  // A file still being made is asked after by itself; once one is done the list is read again.
  React.useEffect(() => {
    if (!queued) return undefined;
    const timer = setInterval(async () => {
      const answers = await Promise.all(queued.split(',').map((id) => api.orderDownloads.get(Number(id)).catch(() => null)));
      if (answers.some((file) => file && file.status !== 'queued')) query.refetch();
    }, 4000);
    return () => clearInterval(timer);
  }, [queued]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Screen testID="screen-order-files" title={t('orders.files.title')}>
      <Offline />
      <Text variant="small">{t('orders.files.intro')}</Text>
      <Card>
        <Choices testID="order-files-fulfilment" label={t('orders.filterLabel')} value={fulfilment} onChange={setFulfilment} options={FULFILMENT.map((value) => ({ value, label: value ? t(`orders.status.fulfilment.${value}`) : t('orders.filter.all') }))} />
        <Button testID="order-files-make" label={t('orders.files.make')} disabled={!writable} busy={action.busy === 'make'} onPress={() => action.run('make', () => api.orderDownloads.create(fulfilment ? { fulfilment } : {}), { done: 'orders.files.made' })} />
        <ActionMessages action={action} testID="order-files-action" />
      </Card>
      <PagedList
        testID="order-files"
        query={query}
        emptyTitle={t('orders.files.empty')}
        renderRow={(file) => (
          <ListRow
            testID={`order-file-${file.id}`}
            title={t('orders.files.row', { count: file.rowCount })}
            subtitle={[formatWhenAt(file.createdAt, locale), file.expiresAt ? t('orders.files.until', { when: formatWhenAt(file.expiresAt, locale) }) : null].filter(Boolean).join(' · ')}
            end={file.status === 'ready' && /^https?:\/\//i.test(file.fileUrl ?? '') ? <Button kind="quiet" testID={`order-file-${file.id}-open`} label={t('orders.files.open')} onPress={() => Linking.openURL(file.fileUrl).catch(() => {})} /> : <StatusBadge group="file" status={file.status} />}
          />
        )}
      />
    </Screen>
  );
}
