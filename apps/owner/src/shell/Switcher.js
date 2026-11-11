import React, { useState } from 'react';
import { OfflineBanner, useOnline, useStrings } from '@bhava/app-core';
import { Badge, Banner, Card, ListRow, Screen } from '@bhava/ui';
import { useServices, useSession } from '../services.js';
import { BusinessBadge } from './BusinessBadge.js';

export { BusinessBadge };

/**
 * The business switcher (P-09, P-10): exactly the businesses the session lists, and nothing typed in. Choosing one
 * reloads every screen in that business; the cache of the old one is dropped before the new one loads. Switching
 * needs the server, so it waits for a connection.
 */
export function Switcher({ onDone }) {
  const { session } = useServices();
  const { businesses, tenantId } = useSession();
  const online = useOnline();
  const { t } = useStrings();
  const [busy, setBusy] = useState(null);
  const [failed, setFailed] = useState(false);

  async function choose(id) {
    if (id === tenantId) return onDone?.();
    setBusy(id);
    setFailed(false);
    try {
      await session.switchBusiness(id);
      onDone?.();
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen testID="switcher" title={t('switcher.title')}>
      <OfflineBanner offline={!online} />
      {failed ? <Banner tone="bad" testID="switcher-failed">{t('switcher.failed')}</Banner> : null}
      <Card>
        {businesses.map((business) => (
          <ListRow
            key={business.id}
            testID={`switcher-business-${business.id}`}
            title={business.name}
            subtitle={business.role ? t(`role.${business.role}`) : undefined}
            start={<BusinessBadge business={business} />}
            end={business.id === tenantId ? <Badge label={t('switcher.current')} tone="primary" /> : null}
            disabled={busy !== null || (!online && business.id !== tenantId)}
            onPress={() => choose(business.id)}
          />
        ))}
      </Card>
    </Screen>
  );
}
