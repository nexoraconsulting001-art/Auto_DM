/** One product (P-32 to P-36): photos, options and variants, the server's price and stock, and the reels it appears in. */
import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useStrings } from '@bhava/app-core/strings';
import { Badge, Button, Screen, Section, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../services.js';
import { useBrowseQuery } from '../../shell/data.js';
import { Photo, Price, ReelTile, Shown } from '../../shell/parts.js';

const JOIN = ' / ';

/** The variant the chosen values name, or null while any option is still open. */
export function variantFor(product, chosen) {
  if (!product.options.length) return null;
  if (!product.options.every((option) => chosen[option.name])) return null;
  const label = product.options.map((option) => chosen[option.name]).join(JOIN);
  return product.variants.find((variant) => variant.option === label) ?? null;
}

/** Whether a value of an option can still be bought given what else is chosen: only an in-stock variant counts. */
export function valueAvailable(product, option, value, chosen) {
  const at = product.options.findIndex((o) => o.name === option.name);
  return product.variants.some((variant) => {
    if (!variant.inStock) return false;
    const parts = variant.option.split(JOIN);
    if (parts[at] !== value) return false;
    return product.options.every((o, i) => i === at || !chosen[o.name] || parts[i] === chosen[o.name]);
  });
}

function Gallery({ images, name }) {
  const { width } = useWindowDimensions();
  const theme = useTheme();
  const size = Math.max(200, width - theme.space.gutter * 2);
  if (!images.length) return <Photo uri="" name={name} />;
  return (
    <FlatList
      testID="product-gallery"
      horizontal
      pagingEnabled
      showsHorizontalScrollIndicator={false}
      data={images}
      keyExtractor={(uri, i) => `${i}-${uri}`}
      renderItem={({ item }) => <View style={{ width: size, marginRight: 0 }}><Photo uri={item} name={name} ratio={1} /></View>}
    />
  );
}

function Detail({ product }) {
  const { t } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const services = useServices();
  const [chosen, setChosen] = useState({});
  const [qty, setQty] = useState(1);
  const variant = useMemo(() => variantFor(product, chosen), [product, chosen]);
  const hasOptions = product.options.length > 0;
  const price = variant?.pricePaise ?? product.pricePaise;
  const inStock = hasOptions ? (variant ? variant.inStock : product.inStock) : product.inStock;
  const images = variant?.image ? [variant.image, ...product.images.filter((u) => u !== variant.image)] : product.images;
  const add = services.cart?.add;
  const needsChoice = hasOptions && !variant;
  return (
    <View style={{ gap: theme.space[4] }}>
      <Gallery images={images.length ? images : [product.image].filter(Boolean)} name={product.name} />
      <Text variant="page" testID="product-name">{product.name}</Text>
      <Price testID="product-price" pricePaise={price} comparePaise={variant ? null : product.comparePaise} large />
      {inStock ? null : <Badge testID="product-soldout" label={t('home.common.soldOut')} tone="bad" />}
      {product.rating !== null && product.ratingCount > 0 ? <Text variant="small">{`★ ${product.rating.toFixed(1)} (${product.ratingCount})`}</Text> : null}
      {product.options.map((option) => (
        <View key={option.name} style={{ gap: theme.space[2] }} testID={`option-${option.name}`}>
          <Text variant="small">{option.name}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
            {option.values.map((value) => {
              const on = chosen[option.name] === value;
              const open = valueAvailable(product, option, value, chosen);
              return (
                <Pressable
                  key={value}
                  testID={`value-${option.name}-${value}`}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on, disabled: !open }}
                  accessibilityLabel={open ? value : `${value}, ${t('home.common.soldOut')}`}
                  onPress={() => setChosen((now) => ({ ...now, [option.name]: on ? undefined : value }))}
                  style={{ minHeight: theme.tap.min, justifyContent: 'center', paddingHorizontal: theme.space[4], borderRadius: theme.radius.field, borderWidth: 1, borderColor: on ? theme.color.primary : theme.color.line, backgroundColor: on ? theme.color.primaryTint : theme.color.surface, opacity: open ? 1 : 0.45 }}
                >
                  <Text variant="small" tone={on ? 'primary' : undefined} style={open ? null : { textDecorationLine: 'line-through' }}>{value}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}
      {needsChoice && inStock ? <Text variant="small" testID="choose-options">{t('product.choose')}</Text> : null}
      {product.description ? <Text variant="body" testID="product-description">{product.description}</Text> : null}
      {typeof add === 'function' ? (
        <View style={{ gap: theme.space[3] }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[3] }}>
            <Button testID="qty-less" kind="secondary" label="−" accessibilityHint={t('product.less')} disabled={qty <= 1} onPress={() => setQty((n) => Math.max(1, n - 1))} />
            <Text variant="title" testID="qty">{qty}</Text>
            <Button testID="qty-more" kind="secondary" label="+" accessibilityHint={t('product.more')} disabled={qty >= product.maxQty} onPress={() => setQty((n) => Math.min(product.maxQty, n + 1))} />
          </View>
          <Button
            testID="add-to-cart"
            label={inStock ? t('product.add') : t('home.common.soldOut')}
            disabled={!inStock || needsChoice}
            onPress={() => add({ productId: product.id, variantId: variant?.id ?? null, qty })}
          />
        </View>
      ) : null}
      {product.reels.length ? (
        <Section title={t('product.reels')}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: theme.space[3] }}>
            {product.reels.map((reel) => <ReelTile key={reel.slug} reel={reel} width={120} onPress={() => navigation.navigate('reels.reel', { slug: reel.slug })} />)}
          </ScrollView>
        </Section>
      ) : null}
    </View>
  );
}

export default function ProductScreen() {
  const navigation = useNavigation();
  const slug = String(useRoute().params?.slug ?? '');
  const query = useBrowseQuery(['product', slug], (browse) => browse.product(slug), { enabled: slug !== '' });
  return (
    <Screen testID="screen-product">
      <Shown query={query} onGone={() => navigation.navigate('catalog.index')}>
        {(product) => (product ? <Detail key={product.slug} product={product} /> : null)}
      </Shown>
    </Screen>
  );
}
