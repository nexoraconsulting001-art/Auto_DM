import { PINCODE, PINCODE_MESSAGE } from '../orders/shared/contract.js';

/**
 * The courier settings form (9.10) and the API's ShippingSettings, both ways. The pickup address goes all together or not at
 * all; the own account's password is sent only when typed, and never comes back. Pure, so it is tested in Node.
 */
export const PICKUP_FIELDS = Object.freeze(['pickupName', 'pickupPhone', 'pickupLine1', 'pickupLine2', 'pickupCity', 'pickupStateCode', 'pickupPincode']);
const REQUIRED = Object.freeze({ pickupName: 'Enter a name', pickupPhone: 'Enter a phone number', pickupLine1: 'Enter the address', pickupCity: 'Enter the city', pickupStateCode: 'Pick a state', pickupPincode: PINCODE_MESSAGE });

export function settingsToForm(settings) {
  return {
    mode: settings.mode,
    ...Object.fromEntries(PICKUP_FIELDS.map((name) => [name, settings[name] ?? ''])),
    ownEmail: settings.ownEmail ?? '',
    ownPassword: '',
    chargeBilling: settings.chargeBilling,
  };
}

/** The form as ShippingSettingsUpdate, or { errors }. */
export function formToSettings(values) {
  const errors = {};
  const body = { mode: values.mode === 'own' ? 'own' : 'managed', chargeBilling: values.chargeBilling === 'monthly' ? 'monthly' : 'payout' };
  const pickup = Object.fromEntries(PICKUP_FIELDS.map((name) => [name, String(values[name] ?? '').trim()]));
  if (PICKUP_FIELDS.some((name) => pickup[name])) {
    for (const [name, message] of Object.entries(REQUIRED)) if (!pickup[name]) errors[name] = message;
    if (pickup.pickupPincode && !PINCODE.test(pickup.pickupPincode)) errors.pickupPincode = PINCODE_MESSAGE;
    if (pickup.pickupStateCode && !/^[0-9]{2}$/.test(pickup.pickupStateCode)) errors.pickupStateCode = 'Pick a state';
    Object.assign(body, pickup);
  }
  if (body.mode === 'own') {
    const email = String(values.ownEmail ?? '').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.ownEmail = 'Enter a valid email';
    body.ownEmail = email;
    if (values.ownPassword) body.ownPassword = values.ownPassword;
  }
  return Object.keys(errors).length ? { errors } : { body };
}
