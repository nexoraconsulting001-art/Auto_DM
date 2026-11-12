/** The Reels tab (P-29 and P-65): the store's reels in the set order of each category, pinned first, filtered by category chips. */
import React, { useState } from 'react';
import { View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useStrings } from '@bhava/app-core/strings';
import { EmptyState, Screen, useTheme } from '@bhava/ui';
import { useBrowsePages } from '../../shell/data.js';
import { Chips, Grid, ReelTile, Shown } from '../../shell/parts.js';

export default function ReelsScreen() {
  const { t } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const [category, setCategory] = useState(null);
  const reels = useBrowsePages(['reels', category], (browse, cursor) => browse.reels({ category: category ?? undefined, cursor }), { placeholderData: (previous) => previous });
  const pages = reels.data?.pages ?? [];
  const chips = pages[0]?.chips ?? [];
  const items = pages.flatMap((page) => page.items);
  // Pinned reels lead, every group keeps the order the seller set; the server already sends it so, and a later page never reorders an earlier one.
  const ordered = [...items.filter((reel) => reel.pinned), ...items.filter((reel) => !reel.pinned)];
  return (
    <Screen testID="screen-reels" scroll={false} title={t('reels.title')} contentStyle={{ paddingHorizontal: 0 }}>
      <Shown query={reels}>
        {() => (
          <Grid
            testID="reels-list"
            data={ordered}
            keyOf={(r) => r.slug}
            header={<View style={{ marginHorizontal: -theme.space.gutter }}><Chips testID="reels-categories" items={chips} value={category} onChange={setCategory} all={t('reels.all')} /></View>}
            renderItem={(reel) => <ReelTile reel={reel} onPress={() => navigation.navigate('reels.reel', { slug: reel.slug })} />}
            onEnd={() => reels.hasNextPage && !reels.isFetchingNextPage && reels.fetchNextPage()}
            empty={<EmptyState testID="reels-empty" title={t('reels.empty')} />}
          />
        )}
      </Shown>
    </Screen>
  );
}
