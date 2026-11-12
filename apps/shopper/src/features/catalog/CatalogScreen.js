/** The whole shop (P-28): every product the server shows, by category and sort, page by page. */
import React, { useState } from 'react';
import { View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useStrings } from '@bhava/app-core/strings';
import { Choices, EmptyState, Screen, Text, useTheme } from '@bhava/ui';
import { useBrowsePages, useBrowseQuery } from '../../shell/data.js';
import { Chips, Grid, ProductTile, Shown } from '../../shell/parts.js';

export const SORTS = ['popular', 'newest', 'price-asc', 'price-desc', 'discount'];

export default function CatalogScreen() {
  const { t } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const [category, setCategory] = useState(null);
  const [sort, setSort] = useState('popular');
  const categories = useBrowseQuery(['categories'], (browse) => browse.categories());
  const products = useBrowsePages(['catalog', category, sort], (browse, cursor) => browse.catalog({ category: category ?? undefined, sort, cursor }), { placeholderData: (previous) => previous });
  const items = products.data?.pages.flatMap((page) => page.items) ?? [];
  const header = (
    <View style={{ gap: theme.space[3], marginHorizontal: -theme.space.gutter }}>
      <Chips testID="catalog-categories" items={categories.data ?? []} value={category} onChange={setCategory} all={t('catalog.all')} />
      <View style={{ paddingHorizontal: theme.space.gutter }}>
        <Choices testID="catalog-sort" label={t('catalog.sort')} value={sort} onChange={setSort} options={SORTS.map((value) => ({ value, label: t(`catalog.sort.${value}`) }))} />
      </View>
    </View>
  );
  return (
    <Screen testID="screen-catalog" scroll={false} title={t('catalog.title')} contentStyle={{ paddingHorizontal: 0 }}>
      <Shown query={products}>
        {() => (
          <Grid
            testID="catalog-list"
            data={items}
            keyOf={(p) => p.slug}
            header={header}
            renderItem={(product) => <ProductTile product={product} onPress={() => navigation.navigate('product.index', { slug: product.slug })} />}
            onEnd={() => products.hasNextPage && !products.isFetchingNextPage && products.fetchNextPage()}
            empty={<EmptyState testID="catalog-empty" title={t('catalog.empty')} />}
          />
        )}
      </Shown>
    </Screen>
  );
}
