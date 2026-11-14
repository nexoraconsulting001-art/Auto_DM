import React from 'react';
import { useNavigation } from '@react-navigation/native';
import { useStrings } from '@bhava/app-core';
import { Banner, Button } from '@bhava/ui';
import { useSession } from '../../shell/hooks.js';
import { useBillingActions } from './actions.js';
import { groupDigits, planLabel, planRefusal } from './rules.js';

/**
 * What a screen shows when the server answers plan.feature_off or plan.limit_reached: the plan's limit in words, and a way to
 * the plans only when this build may send a person to pay (BILLING_ACTIONS) and the person is the owner. With the setting off
 * it says what is not included and nothing about where to buy. Renders nothing for any other error.
 */
export function UpgradePrompt({ error, testID = 'upgrade-prompt' }) {
  const { t } = useStrings();
  const navigation = useNavigation();
  const { user } = useSession();
  const actions = useBillingActions();
  const refusal = planRefusal(error);
  if (!refusal) return null;
  const plan = refusal.plan ? planLabel(refusal.plan) : '';
  const body = refusal.kind === 'limit'
    ? t('billing.prompt.limit', { used: groupDigits(refusal.used ?? 0), limit: groupDigits(refusal.limit ?? 0) })
    : t(plan ? 'billing.prompt.off' : 'billing.prompt.offAny', { plan });
  const owner = user?.role === 'owner';
  return (
    <Banner
      tone="warn"
      testID={testID}
      title={t(refusal.kind === 'limit' ? 'billing.prompt.limitTitle' : 'billing.prompt.offTitle')}
      action={actions && owner ? <Button testID={`${testID}-plans`} kind="secondary" label={t('billing.prompt.see')} onPress={() => navigation.navigate('billing.index')} /> : null}
    >
      {actions && !owner ? `${body} ${t('billing.prompt.askOwner')}` : body}
    </Banner>
  );
}

/** Keeps the last error of a change so the screen can show the prompt: `const [error, onError] = usePlanError()`, then run(..., { onError }). */
export function usePlanError() {
  const [error, setError] = React.useState(null);
  return [error, React.useCallback((e) => setError(e ?? null), []), () => setError(null)];
}
