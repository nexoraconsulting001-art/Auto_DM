import React from 'react';
import { useStrings } from '@bhava/app-core';
import { EmptyState, Screen } from '@bhava/ui';

/** What a feature shows until its screens are built. `title` is a string key. */
export function PendingScreen({ feature, title }) {
  const { t } = useStrings();
  return (
    <Screen testID={`screen-${feature}`} title={t(title)}>
      <EmptyState title={t(title)}>{t('pending.body')}</EmptyState>
    </Screen>
  );
}
