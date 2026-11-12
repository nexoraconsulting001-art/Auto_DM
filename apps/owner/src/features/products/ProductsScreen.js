import React, { useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { formatWhen, useStrings } from '@bhava/app-core';
import { Badge, Button, Card, Choices, Divider, Field, ListRow, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { useOpenLink } from '../../shell/context.js';
import { Loadable, MoreButton, Page, Refusal, Thumb, itemsOf, useConnection, usePaged } from './kit.js';
import { PRODUCT_STATUSES } from './limits.js';
import { priceLine, productBadges, recheckBody } from './form.js';

export const PRODUCTS_KEY = ['products'];

/** The price as the server works it out: the display price, the MRP and its "-N%" when the server sent them. */
export function PriceText({ product, testID }) {
  const { t } = useStrings();
  const line = priceLine(product);
  return (
    <View testID={testID} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      <Text variant="small" testID={testID ? `${testID}-price` : undefined}>{line.price}</Text>
      {line.strike ? <Text variant="caption" style={{ textDecorationLine: 'line-through' }} accessibilityLabel={t('products.mrpWas', { amount: line.strike })}>{line.strike}</Text> : null}
      {line.off ? <Text variant="caption" tone="good">{line.off}</Text> : null}
    </View>
  );
}

/**
 * Products (PRD 8.1): the catalog by status, searchable, with each product's price as the server works it out (the
 * lowest in-stock variant, K-03), its badges and where it came from. Adding and importing start here.
 */
export default function ProductsScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const openLink = useOpenLink();
  const { offline } = useConnection();
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const list = usePaged([...PRODUCTS_KEY, 'list', status, query], (page) => api.products.list({ status, ...(query ? { search: query } : {}), limit: 30, ...page }));
  const items = itemsOf(list);
  const filtered = Boolean(query) || status !== 'all';
  return (
    <Page testID="screen-products" offline={offline}>
      <Text variant="page">{t('products.title')}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
        <Button testID="products-add" label={t('products.add')} onPress={() => navigation.navigate('products.create')} />
        <Button testID="products-import" kind="secondary" label={t('products.import')} onPress={() => openLink('/imports')} />
        <Button testID="products-open-settings" kind="quiet" label={t('products.settings.title')} onPress={() => navigation.navigate('products.settings')} />
      </View>
      <Field testID="products-search" label={t('products.search')} value={search} onChangeText={setSearch} onSubmitEditing={() => setQuery(search.trim())} onBlur={() => setQuery(search.trim())} returnKeyType="search" />
      <Choices testID="products-status" label={t('products.statusLabel')} value={status} onChange={setStatus} options={PRODUCT_STATUSES.map((s) => ({ value: s, label: t(`products.status.${s}`) }))} />
      <Loadable query={list} empty={!items.length} testID="products-list" emptyTitle={t(filtered ? 'products.emptyFiltered' : 'products.empty')} emptyBody={filtered ? null : t('products.emptyBody')}>
        <Card>
          {items.map((product, i) => {
            const badges = productBadges(product);
            return (
              <View key={product.id}>
                {i ? <Divider /> : null}
                <ListRow
                  testID={`product-${product.id}`}
                  start={<Thumb uri={product.images?.[0]} label={product.name} />}
                  title={product.name}
                  subtitle={[priceLine(product).price, ...badges.slice(1).map((b) => t(b.key))].filter(Boolean).join(' · ')}
                  end={badges[0] ? <Badge testID={`product-${product.id}-badge`} label={t(badges[0].key)} tone={badges[0].tone} /> : null}
                  onPress={() => navigation.navigate('products.edit', { id: String(product.id) })}
                />
              </View>
            );
          })}
        </Card>
        <MoreButton query={list} testID="products-more" />
      </Loadable>
    </Page>
  );
}

/** Re-checks (8.8): how often imported products are read again from the seller's site, and how many need attention. */
export function CatalogSettingsScreen() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const queryClient = useQueryClient();
  const openLink = useOpenLink();
  const { online, offline } = useConnection();
  const settings = useQuery({ queryKey: [...PRODUCTS_KEY, 'settings'], queryFn: () => api.catalogSettings.get() });
  const [hours, setHours] = useState(null);
  const shown = hours ?? (settings.data ? String(settings.data.recheckHours) : '');
  const read = recheckBody(shown);
  const save = useMutation({
    mutationFn: (body) => api.catalogSettings.update(body),
    onSuccess: (answer) => {
      queryClient.setQueryData([...PRODUCTS_KEY, 'settings'], answer);
      setHours(null);
    },
  });
  const data = settings.data;
  return (
    <Page testID="screen-products-settings" offline={offline}>
      <Text variant="page">{t('products.settings.title')}</Text>
      <Loadable query={settings} testID="products-settings">
        {data ? (
          <Card>
            <Text variant="small">{t('products.settings.intro')}</Text>
            <Field testID="products-settings-hours" label={t('products.settings.hours')} value={shown} onChangeText={setHours} keyboardType="number-pad" error={hours !== null && read.error ? t(read.error) : null} />
            <Button testID="products-settings-save" label={t('common.save')} busy={save.isPending} disabled={!online || Boolean(read.error) || hours === null} onPress={() => save.mutate(read.body)} />
            {!online ? <Text variant="caption">{t('offline.writeDisabled')}</Text> : null}
            <Refusal error={save.error} testID="products-settings-error" />
            <Text variant="small" testID="products-settings-last">{data.lastRecheckAt ? t('products.settings.last', { when: formatWhen(t, data.lastRecheckAt, { locale }) }) : t('products.settings.never')}</Text>
            {data.attentionCount > 0 ? (
              <Button testID="products-settings-attention" kind="quiet" label={t('products.settings.attention', { count: data.attentionCount })} onPress={() => openLink('/products')} />
            ) : null}
          </Card>
        ) : null}
      </Loadable>
    </Page>
  );
}
