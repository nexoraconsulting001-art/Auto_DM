/** One reel's own page (P-30), opened from the same direct link a message carries: the video, its products, more reels. Reading it records nothing. */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useStrings } from '@bhava/app-core/strings';
import { Screen, Section, Text, useTheme } from '@bhava/ui';
import { useBrowseQuery } from '../../shell/data.js';
import { Photo, ProductTile, ReelTile, ReelVideo, Shown } from '../../shell/parts.js';

export default function ReelPageScreen() {
  const { t } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const slug = String(useRoute().params?.slug ?? '');
  const page = useBrowseQuery(['landing', slug], (browse) => browse.landing(slug), { enabled: slug !== '' });
  return (
    <Screen testID="screen-reel">
      <Shown query={page} onGone={() => navigation.navigate('reels.index')}>
        {(data) => (
          <View style={{ gap: theme.space[5] }}>
            {data.media.kind === 'video' ? <ReelVideo uri={data.media.url} poster={data.media.poster} name={data.title} autoPlay /> : <Photo uri={data.media.url || data.media.poster} name={data.title} ratio={9 / 16} />}
            <Text variant="page" testID="reel-title">{data.title}</Text>
            {data.products.length ? (
              <Section title={t('reels.products')}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[3] }}>
                  {data.products.map((product) => (
                    <View key={product.slug} style={{ width: '47%' }}><ProductTile product={product} onPress={() => navigation.navigate('product.index', { slug: product.slug })} /></View>
                  ))}
                </View>
              </Section>
            ) : null}
            {data.moreReels.length ? (
              <Section title={t('reels.more')}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: theme.space[3] }}>
                  {data.moreReels.map((reel) => <ReelTile key={reel.slug} reel={reel} width={120} onPress={() => navigation.push('reels.reel', { slug: reel.slug })} />)}
                </ScrollView>
              </Section>
            ) : null}
          </View>
        )}
      </Shown>
    </Screen>
  );
}
