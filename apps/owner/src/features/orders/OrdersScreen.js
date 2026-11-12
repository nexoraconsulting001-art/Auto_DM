import React, { useState } from 'react';
import { View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { formatWhen, useStrings } from '@bhava/app-core';
import { Button, Choices, Field, ListRow, Screen, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { ORDER_FILTERS, actionBody, formatPaise, orderBadges, quickAction } from './kit/rules.js';
import { ActionMessages, Badges, Offline, PagedList, useAction, usePaged, useWritable } from './kit/ui.js';

export const ORDERS = ['orders'];
export const ordersKey = (filter, search) => ['orders', 'list', { filter, search }];

/**
 * Orders (PRD 9.9, 10.4). Lists read from the offline cache first, so in airplane mode the saved rows show under the
 * Offline banner and every Confirm is disabled (P-19). A cash on delivery order waiting for the seller has Confirm on
 * its row; it sends the move and nothing else, never an amount. Tapping a row opens the order.
 */
export default function OrdersScreen() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const writable = useWritable();
  const [filter, setFilter] = useState('all');
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const query = usePaged(ordersKey(filter, search), (page) => api.orders.list({ ...ORDER_FILTERS[filter], ...(search ? { search } : {}), ...page }));
  const action = useAction([ORDERS]);

  const filters = Object.keys(ORDER_FILTERS).map((value) => ({ value, label: t(`orders.filter.${value}`) }));
  return (
    <Screen testID="screen-orders" title={t('orders.title')}>
      <Offline />
      <Field
        testID="orders-search"
        label={t('orders.search')}
        value={typed}
        onChangeText={setTyped}
        onSubmitEditing={() => setSearch(typed.trim().slice(0, 80))}
        returnKeyType="search"
        autoCorrect={false}
      />
      <Choices testID="orders-filter" label={t('orders.filterLabel')} options={filters} value={filter} onChange={setFilter} />
      <ActionMessages action={action} testID="orders-action" />
      <PagedList
        testID="orders-list"
        query={query}
        emptyTitle={t(filter === 'all' && !search ? 'orders.empty' : 'orders.emptyFiltered')}
        renderRow={(order) => {
          const quick = quickAction(order);
          const items = order.itemCount === 1 ? t('orders.oneItem') : t('orders.items', { count: order.itemCount ?? 0 });
          return (
            <View style={{ gap: theme.space[2], paddingBottom: quick ? theme.space[2] : 0 }}>
              <ListRow
                testID={`order-${order.id}`}
                title={`${order.orderNumber} · ${order.customerName}`}
                subtitle={`${formatPaise(order.totalPaise)} · ${items} · ${formatWhen(t, order.createdAt, { locale })}`}
                onPress={() => navigation.navigate('orders.detail', { id: order.id })}
                end={<Badges items={orderBadges(order).slice(0, 2)} />}
              />
              {quick ? (
                <Button
                  testID={`order-${order.id}-${quick.key}`}
                  label={t(`orders.action.${quick.key}`)}
                  accessibilityHint={t('orders.action.hint', { number: order.orderNumber })}
                  disabled={!writable}
                  busy={action.busy === `${quick.key}:${order.id}`}
                  onPress={() => action.run(`${quick.key}:${order.id}`, () => (quick.kind === 'advance' ? api.orders.advance(order.id, actionBody(quick)) : api.orders.setStatus(order.id, actionBody(quick))), { done: `orders.done.${quick.key}` })}
                />
              ) : null}
            </View>
          );
        }}
      />
      <Text variant="small">{t('orders.filesIntro')}</Text>
      <Button testID="orders-files" kind="secondary" label={t('orders.files.title')} onPress={() => navigation.navigate('orders.files')} />
    </Screen>
  );
}
