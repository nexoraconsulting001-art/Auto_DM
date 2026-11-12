import React from 'react';
import { useStrings } from '@bhava/app-core';
import { Badge, ListRow, Screen } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { useOpenLink } from '../../shell/context.js';
import { signed } from '../orders/kit/forms.js';
import { Offline, PagedList, formatWhenAt, usePaged } from '../orders/kit/ui.js';

const REASONS = ['sale', 'cancel', 'rto', 'return', 'manual', 'import', 'shopify', 'correction'];

/** Every change to stock, newest first: why it moved (a sale, a cancel, a return, by hand), by whom, and when. */
export default function MovementsScreen({ route }) {
  const productId = Number(route?.params?.productId) || null;
  const { api } = useServices();
  const { t, locale } = useStrings();
  const openLink = useOpenLink();
  const query = usePaged(['inventory', 'movements', productId], (page) => api.inventory.movements({ ...(productId ? { productId } : {}), ...page }));
  return (
    <Screen testID="screen-movements" title={t('inventory.movements')}>
      <Offline />
      <PagedList
        testID="movements"
        query={query}
        emptyTitle={t('inventory.movements.empty')}
        renderRow={(move) => (
          <ListRow
            testID={`movement-${move.id}`}
            title={t(`inventory.reason.${REASONS.includes(move.reason) ? move.reason : 'other'}`)}
            subtitle={[move.actor, formatWhenAt(move.at, locale)].filter(Boolean).join(' · ')}
            end={<Badge tone={move.delta > 0 ? 'good' : 'neutral'} label={signed(move.delta)} />}
            onPress={move.orderId ? () => openLink(`/orders/${move.orderId}`) : undefined}
          />
        )}
      />
    </Screen>
  );
}
