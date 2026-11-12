/** Search (P-37): the shop's search, as the shopper types or when they submit. Nothing is asked of them first. */
import React, { useEffect, useState } from 'react';
import { TextInput, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useStrings } from '@bhava/app-core/strings';
import { EmptyState, Screen, useTheme } from '@bhava/ui';
import { useBrowsePages } from '../../shell/data.js';
import { Grid, ProductTile, Shown } from '../../shell/parts.js';

export const DEBOUNCE_MS = 350;

export default function SearchScreen() {
  const { t } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const [text, setText] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setTerm(text.trim().slice(0, 80)), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  const results = useBrowsePages(['search', term], (browse, cursor) => browse.catalog({ q: term, cursor }), { enabled: term !== '' });
  const items = results.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Screen testID="screen-search" scroll={false} contentStyle={{ paddingHorizontal: 0 }}>
      <View style={{ paddingHorizontal: theme.space.gutter }}>
        <TextInput
          testID="search-input"
          value={text}
          onChangeText={setText}
          onSubmitEditing={() => setTerm(text.trim().slice(0, 80))}
          placeholder={t('search.placeholder')}
          placeholderTextColor={theme.color.ink3}
          accessibilityLabel={t('search.placeholder')}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={80}
          style={{ minHeight: theme.tap.large, paddingHorizontal: theme.space[4], borderRadius: theme.radius.field, borderWidth: 1, borderColor: theme.color.line, backgroundColor: theme.color.surface, color: theme.color.ink, fontFamily: theme.font.body, fontSize: theme.text.body }}
        />
      </View>
      {term === '' ? (
        <EmptyState testID="search-hint" title={t('search.hint')} />
      ) : (
        <Shown query={results}>
          {() => (
            <Grid
              testID="search-results"
              data={items}
              keyOf={(p) => p.slug}
              renderItem={(product) => <ProductTile product={product} onPress={() => navigation.navigate('product.index', { slug: product.slug })} />}
              onEnd={() => results.hasNextPage && !results.isFetchingNextPage && results.fetchNextPage()}
              empty={<EmptyState testID="search-empty" title={t('search.none', { term })} />}
            />
          )}
        </Shown>
      )}
    </Screen>
  );
}
