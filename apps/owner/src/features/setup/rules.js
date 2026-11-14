/** Pure rules of the setup checklist: progress, and the pickup address as the server wants it. */

/** The terms the owner accepts. The server records the version with who accepted and when. */
export const TERMS_VERSION = '2026-11';

/** How far along: the steps that block going live and how many of them are done. Optional steps never count against it. */
export function progressOf(steps) {
  const required = (steps ?? []).filter((s) => s.required);
  return { total: required.length, done: required.filter((s) => s.status === 'done').length };
}

export const PICKUP_FIELDS = Object.freeze([
  { name: 'name', max: 80 },
  { name: 'phone', max: 10, keyboardType: 'number-pad' },
  { name: 'email', max: 200, keyboardType: 'email-address' },
  { name: 'line1', max: 190 },
  { name: 'line2', max: 190 },
  { name: 'city', max: 80 },
  { name: 'state', max: 80 },
  { name: 'pincode', max: 6, keyboardType: 'number-pad' },
]);

/** { body } for the server's own address rules, or { problems: { field: stringKey } }. */
export function checkPickup(values) {
  const v = Object.fromEntries(Object.entries(values).map(([k, x]) => [k, String(x ?? '').trim()]));
  const problems = {};
  if (!v.name) problems.name = 'setup.pickup.needName';
  if (!/^[6-9]\d{9}$/.test(v.phone)) problems.phone = 'setup.pickup.needPhone';
  if (v.email && !/^\S+@\S+\.\S+$/.test(v.email)) problems.email = 'setup.pickup.needEmail';
  if (!v.line1) problems.line1 = 'setup.pickup.needLine';
  if (!v.city) problems.city = 'setup.pickup.needCity';
  if (!v.state) problems.state = 'setup.pickup.needState';
  if (!/^\d{6}$/.test(v.pincode)) problems.pincode = 'setup.pickup.needPincode';
  if (Object.keys(problems).length) return { problems };
  return { body: { name: v.name, phone: v.phone, email: v.email, line1: v.line1, line2: v.line2, city: v.city, state: v.state, pincode: v.pincode } };
}
