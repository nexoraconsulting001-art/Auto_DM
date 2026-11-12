/** One category (P-31): its reels in the seller's set order with pinned first, then its products page by page. */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useStrings } from '@bhava/app-core/strings';
import { EmptyState, Screen, Section, Text, useTheme } from '@bhava/ui';
import { useBrowsePages } from '../../shell/data.js';
import { Grid, ProductTile, ReelTile, Shown } from '../../shell/parts.js';

export default function CategoryScreen() {
  const { t } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const slug = String(useRoute().params?.slug ?? '');
  const query = useBrowsePages(['category', slug], (browse, cursor) => browse.category(slug, { cursor }), { nextOf: (page) => page.products.nextCursor, enabled: slug !== '' });
  const first = query.data?.pages[0];
  const products = query.data?.pages.flatMap((page) => page.products.items) ?? [];
  return (
    <Screen testID="screen-category" scroll={false} contentStyle={{ paddingHorizontal: 0 }}>
      <Shown query={query} onGone={() => navigation.navigate('catalog.index')}>
        {() => (
          <Grid
            testID="category-products"
            data={products}
            keyOf={(p) => p.slug}
            header={(
              <View style={{ gap: theme.space[4], paddingBottom: theme.space[3] }}>
                <Text variant="page" testID="category-name">{first.category.name}</Text>
                {first.reels.length ? (
                  <Section title={t('category.reels')}>
                    <ScrollView testID="category-reels" horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: theme.space[3] }}>
                      {first.reels.map((reel) => <ReelTile key={reel.slug} reel={reel} width={120} onPress={() => navigation.navigate('reels.reel', { slug: reel.slug })} />)}
                    </ScrollView>
                  </Section>
                ) : null}
                <Text variant="title">{t('category.products')}</Text>
              </View>
            )}
            renderItem={(product) => <ProductTile product={product} onPress={() => navigation.navigate('product.index', { slug: product.slug })} />}
            onEnd={() => query.hasNextPage && !query.isFetchingNextPage && query.fetchNextPage()}
            empty={<EmptyState testID="category-empty" title={t('category.empty')} />}
          />
        )}
      </Shown>
    </Screen>
  );
}
