/** Pure rules of the setup checklist (PRD 5.6): what each live state says, and the checks the address and key forms make first. */
export const TERMS_VERSION = '2026-11';
export const OWN_KEY_PROVIDERS = Object.freeze(['razorpay', 'cashfree', 'shiprocket']);
export const PROVIDER_LABELS = Object.freeze({ razorpay: 'Razorpay', cashfree: 'Cashfree', shiprocket: 'Shiprocket' });

const WORDS = Object.freeze({
  done: { badge: 'Done', tone: 'good' },
  pending: { badge: 'To do', tone: 'neutral' },
  waiting: { badge: 'Waiting', tone: 'warn' },
  failed: { badge: 'Needs attention', tone: 'bad' },
});
export const statusView = (status) => WORDS[status] ?? WORDS.pending;

/** { done, total, next }: required steps only count; optional ones never hold a business back. */
export function progress(checklist) {
  const required = checklist.steps.filter((step) => step.required);
  const done = required.filter((step) => step.status === 'done').length;
  const next = required.find((step) => step.status !== 'done') ?? null;
  return { done, total: required.length, next };
}

export const KYC_WORDS = Object.freeze({
  created: 'Started. Finish the form on Razorpay.',
  under_review: 'Razorpay is reviewing your documents.',
  needs_clarification: 'Razorpay needs a little more from you.',
  activated: 'Verified. Payments are open.',
  rejected: 'Razorpay could not verify this account.',
  suspended: 'Razorpay has paused this account.',
});

export function checkPickup(values) {
  const found = {};
  if (!values.name.trim()) found.name = 'Enter a contact name.';
  if (!/^[6-9]\d{9}$/.test(values.phone.trim())) found.phone = 'Enter a 10-digit mobile number.';
  if (values.email.trim() && !/^\S+@\S+\.\S+$/.test(values.email.trim())) found.email = 'Enter a valid email address.';
  if (!values.line1.trim()) found.line1 = 'Enter the address.';
  if (!values.city.trim()) found.city = 'Enter the city.';
  if (!values.state.trim()) found.state = 'Enter the state.';
  if (!/^\d{6}$/.test(values.pincode.trim())) found.pincode = 'Enter a 6-digit pincode.';
  return found;
}

export function checkKeys(values) {
  const found = {};
  if (!OWN_KEY_PROVIDERS.includes(values.provider)) found.provider = 'Choose a provider.';
  if (!values.keyId.trim()) found.keyId = values.provider === 'shiprocket' ? 'Enter the login email.' : 'Enter the key id.';
  if (!values.keySecret.trim()) found.keySecret = values.provider === 'shiprocket' ? 'Enter the password.' : 'Enter the secret.';
  return found;
}

export const EMPTY_PICKUP = Object.freeze({ name: '', phone: '', email: '', line1: '', line2: '', city: '', state: '', pincode: '' });
