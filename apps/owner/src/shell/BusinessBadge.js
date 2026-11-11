import React from 'react';
import { Image } from 'expo-image';
import { WorkspaceBadge } from '@bhava/ui';

/**
 * A business's own logo, shown only as the mark of the workspace in use (P-67): in the top bar, the switcher, a
 * screen's header and Your account, and nowhere else in the app. Https only; otherwise its first letter.
 */
export function BusinessBadge({ business, size = 36 }) {
  const logo = /^https:\/\//.test(business?.logoUrl ?? '') ? <Image testID="business-logo" source={{ uri: business.logoUrl }} style={{ width: size, height: size }} contentFit="cover" accessibilityIgnoresInvertColors /> : null;
  return <WorkspaceBadge testID="workspace-badge" name={business?.name ?? ''} logo={logo} size={size} />;
}
