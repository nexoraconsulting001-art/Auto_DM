/**
 * BILLING_ACTIONS: the one build setting behind every buy, upgrade and pack button and every call to action to pay.
 * A Bhava plan is a digital service, which Apple may require to be sold by in-app purchase, so the setting is on for
 * Android and off for iOS unless the build says otherwise. With it off the screens still show the plan, usage, invoices
 * and limits and say nothing about where to buy.
 *
 * The build reads it from `extra.billingActions` (app.config.js writes the environment variable BILLING_ACTIONS there:
 * '1' on, '0' off). Unset, the platform decides; the older HIDE_PLAN_PURCHASE setting still turns it off on iOS.
 */
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { useServices } from '../../shell/hooks.js';

const ON = new Set([true, 1, '1', 'true', 'on', 'yes']);
const OFF = new Set([false, 0, '0', 'false', 'off', 'no']);

export function billingActionsOn({ constants = Constants, platform = Platform.OS } = {}) {
  const extra = constants?.expoConfig?.extra ?? {};
  const set = typeof extra.billingActions === 'string' ? extra.billingActions.trim().toLowerCase() : extra.billingActions;
  if (ON.has(set)) return true;
  if (OFF.has(set)) return false;
  if (platform === 'ios') return false;
  return !extra.hidePlanPurchase || platform !== 'ios';
}

/** True when this build may show a button or a line that sends the person to pay. */
export function useBillingActions() {
  const { config } = useServices();
  return billingActionsOn({ platform: config?.app?.platform ?? Platform.OS });
}
