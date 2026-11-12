/** The states and territories a delivery address can name, by the two-digit code the store's address form takes. */
export const STATES = Object.freeze([
  ['01', 'Jammu and Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'], ['04', 'Chandigarh'], ['05', 'Uttarakhand'], ['06', 'Haryana'], ['07', 'Delhi'],
  ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'], ['10', 'Bihar'], ['11', 'Sikkim'], ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'], ['14', 'Manipur'],
  ['15', 'Mizoram'], ['16', 'Tripura'], ['17', 'Meghalaya'], ['18', 'Assam'], ['19', 'West Bengal'], ['20', 'Jharkhand'], ['21', 'Odisha'],
  ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'], ['24', 'Gujarat'], ['26', 'Dadra and Nagar Haveli and Daman and Diu'], ['27', 'Maharashtra'],
  ['29', 'Karnataka'], ['30', 'Goa'], ['31', 'Lakshadweep'], ['32', 'Kerala'], ['33', 'Tamil Nadu'], ['34', 'Puducherry'],
  ['35', 'Andaman and Nicobar Islands'], ['36', 'Telangana'], ['37', 'Andhra Pradesh'], ['38', 'Ladakh'],
].map(([code, name]) => Object.freeze({ code, name })));

export const stateName = (code) => STATES.find((s) => s.code === code)?.name ?? '';

const PHONE = /^(\+?91)?[6-9][0-9]{9}$/;

/** What is wrong with an address before it is sent, keyed by field. The server checks again and has the last word. */
export function addressProblems(a) {
  const out = {};
  if (String(a.name ?? '').trim().length < 2) out.name = 'name';
  if (!PHONE.test(String(a.phone ?? '').replace(/[\s-]/g, ''))) out.phone = 'phone';
  if (String(a.line1 ?? '').trim().length < 3) out.line1 = 'line1';
  if (!String(a.city ?? '').trim()) out.city = 'city';
  if (!STATES.some((s) => s.code === a.stateCode)) out.stateCode = 'stateCode';
  if (!/^[1-9][0-9]{5}$/.test(String(a.pincode ?? ''))) out.pincode = 'pincode';
  return out;
}

export const EMPTY_ADDRESS = Object.freeze({ name: '', phone: '', line1: '', line2: '', landmark: '', city: '', stateCode: '', pincode: '', kind: 'home', isDefault: false });
