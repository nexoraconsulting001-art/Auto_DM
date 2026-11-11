import React, { useState } from 'react';
import { Image } from 'expo-image';
import { useStrings } from '@bhava/app-core';
import { Badge, Banner, Card, ListRow, Screen, WorkspaceBadge } from '@bhava/ui';
import { useServices, useSession } from '../services.js';

/** A business's own logo, shown only as the mark of the workspace in use (P-67). Https only; otherwise its first letter. */
export function BusinessBadge({ business, size = 36 }) {
  const logo = /^https:\/\//.test(business?.logoUrl ?? '') ? <Image source={{ uri: business.logoUrl }} style={{ width: size, height: size }} contentFit="cover" accessibilityIgnoresInvertColors /> : null;
  return <WorkspaceBadge name={business?.name ?? ''} logo={logo} size={size} />;
}

/**
 * The business switcher (P-09, P-10): exactly the businesses the session lists, and nothing typed in. Choosing one
 * reloads every screen in that business; the cache of the old one is dropped before the new one loads.
 */
export function Switcher({ onDone }) {
  const { session } = useServices();
  const { businesses, tenantId } = useSession();
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
      {failed ? <Banner tone="bad" testID="switcher-failed">{t('switcher.failed')}</Banner> : null}
      <Card>
        {businesses.map((business) => (
          <ListRow
            key={business.id}
            testID={`switcher-business-${business.id}`}
            title={business.name}
            start={<BusinessBadge business={business} />}
            end={business.id === tenantId ? <Badge label={t('switcher.current')} tone="primary" /> : null}
            disabled={busy !== null}
            onPress={() => choose(business.id)}
          />
        ))}
      </Card>
    </Screen>
  );
}
