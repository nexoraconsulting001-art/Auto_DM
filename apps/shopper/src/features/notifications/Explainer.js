/**
 * The notification explainer (P-46): shown once, only after an order was placed, in the seller's own words. "Turn on" opens the
 * phone's own prompt and turns on Order updates only. "Not now" asks nothing of the phone, and nothing in the app depends on it.
 */
import React, { useEffect, useState } from 'react';
import { useStrings } from '@bhava/app-core/strings';
import { Button, Sheet, Text } from '@bhava/ui';
import { useServices } from '../../services.js';
import { useBrandName } from '../../shell/parts.js';

export function NotificationExplainer({ enabled, orderToken }) {
  const { t } = useStrings();
  const brand = useBrandName();
  const { notifications } = useServices();
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    if (!enabled || !notifications) return undefined;
    notifications.shouldExplain().then((yes) => live && setVisible(yes)).catch(() => {});
    return () => { live = false; };
  }, [enabled, notifications]);

  if (!visible) return null;
  const close = async (accept) => {
    setBusy(true);
    try {
      if (accept) await notifications.accept({ orderToken });
      else await notifications.declineExplainer();
    } catch {
      // The app works the same whatever the phone answers.
    }
    setBusy(false);
    setVisible(false);
  };
  return (
    <Sheet visible onClose={() => close(false)} dismissable={!busy} title={t('notifications.explainTitle')} closeLabel={t('notifications.notNow')} testID="notification-explainer">
      <Text variant="body">{t('notifications.explainBody', { brand })}</Text>
      <Button testID="explainer-yes" label={t('notifications.turnOn')} busy={busy} onPress={() => close(true)} />
      <Button testID="explainer-no" kind="quiet" label={t('notifications.notNow')} disabled={busy} onPress={() => close(false)} />
    </Sheet>
  );
}
