/** The seller's privacy, terms, refund and shipping policies (P-66), shown in the app as plain text, from the server's copy. */
import React, { useState } from 'react';
import { Linking } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { useStrings } from '@bhava/app-core/strings';
import { Choices, Screen, Text } from '@bhava/ui';
import { useServices } from '../../services.js';
import { useBrowseQuery } from '../../shell/data.js';
import { Shown } from '../../shell/parts.js';

export const KINDS = ['privacy', 'terms', 'refund', 'shipping'];

export default function LegalScreen() {
  const { t } = useStrings();
  const { config } = useServices();
  const given = useRoute().params?.kind;
  const [kind, setKind] = useState(KINDS.includes(given) ? given : 'privacy');
  const policy = useBrowseQuery(['policy', kind], (browse) => browse.policy(kind));
  return (
    <Screen testID="screen-legal">
      <Choices testID="legal-kinds" label={t('legal.title')} value={kind} onChange={setKind} options={KINDS.map((value) => ({ value, label: t(`legal.kind.${value}`) }))} />
      <Shown query={policy}>
        {(data) => (
          <>
            <Text variant="page" testID="legal-title">{data.title || t(`legal.kind.${kind}`)}</Text>
            <Text variant="body" selectable testID="legal-body">{data.body}</Text>
            {data.updatedAt ? <Text variant="caption">{t('legal.updated', { date: data.updatedAt.slice(0, 10) })}</Text> : null}
          </>
        )}
      </Shown>
      {config.brand.supportEmail ? <Text variant="small" tone="primary" testID="legal-contact" accessibilityRole="link" onPress={() => Linking.openURL(`mailto:${config.brand.supportEmail}`)}>{config.brand.supportEmail}</Text> : null}
    </Screen>
  );
}
