// Maestro runScript: a second phone of the same seller, made through the API the way the owner app signs in (P-08).
// Plain ES5, so either of Maestro's script engines runs it.
//
//   ACTION=signIn            signs PHONE in as a device called NAME, with a WhatsApp code read from the simulator;
//                            puts its Settings > Devices id in output.deviceId and its access token in output.deviceToken
//   ACTION=expectSignedOut   fails unless TOKEN is refused (401): that device is signed out
//
// env: ACTION, API_URL, SIGN_IN_HOST, SIM_WHATSAPP_URL, PHONE, NAME, TOKEN

function digitsOf(value) {
  return String(value).replace(/\D/g, '');
}

// The messages Bhava's WhatsApp number sent to `phone`, oldest first.
function messagesTo(phone) {
  var outbox = http.get(SIM_WHATSAPP_URL + '/__sim/sent');
  if (!outbox.ok) throw new Error('The WhatsApp simulator answered ' + outbox.status);
  var sent = json(outbox.body).sent || [];
  var local = digitsOf(phone).slice(-10);
  var mine = [];
  for (var i = 0; i < sent.length; i++) if (digitsOf(sent[i].to).slice(-10) === local) mine.push(sent[i]);
  return mine;
}

function randomHex(length) {
  var out = '';
  while (out.length < length) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

var onSignInHost = { 'content-type': 'application/json', 'x-forwarded-host': SIGN_IN_HOST };

if (ACTION === 'signIn') {
  var before = messagesTo(PHONE).length;
  var started = http.post(API_URL + '/api/v1/auth/start', { headers: onSignInHost, body: JSON.stringify({ phone: PHONE }) });
  if (started.status !== 202) throw new Error('auth.start answered ' + started.status);
  var after = messagesTo(PHONE);
  // Inside the resend wait the server sends nothing new: the flow waits that out before it gets here.
  if (after.length <= before) throw new Error('No new code was sent: the last one is under 30 seconds old');
  var code = /(^|\D)(\d{6})(?!\d)/.exec(JSON.stringify(after[after.length - 1].body));
  if (!code) throw new Error('The newest message holds no code');
  var device = { id: randomHex(32), name: NAME, platform: 'android', app: 'owner', appVersion: '1.0.0' };
  var verified = http.post(API_URL + '/api/v1/auth/verify', {
    headers: onSignInHost,
    body: JSON.stringify({ phone: PHONE, code: code[2], transport: 'bearer', device: device }),
  });
  if (verified.status !== 201) throw new Error('auth.verify answered ' + verified.status);
  var token = json(verified.body).accessToken;
  var listed = http.get(API_URL + '/api/v1/auth/devices', { headers: { authorization: 'Bearer ' + token, 'x-forwarded-host': SIGN_IN_HOST } });
  if (listed.status !== 200) throw new Error('auth.devices answered ' + listed.status);
  var devices = json(listed.body).devices || [];
  var current = null;
  for (var i = 0; i < devices.length; i++) if (devices[i].current) current = devices[i];
  if (!current) throw new Error('The new device is not in Settings > Devices');
  output.deviceId = String(current.id);
  output.deviceToken = token;
} else if (ACTION === 'expectSignedOut') {
  var read = http.get(API_URL + '/api/v1/auth/devices', { headers: { authorization: 'Bearer ' + TOKEN, 'x-forwarded-host': SIGN_IN_HOST } });
  if (read.status !== 401) throw new Error('The revoked device is still signed in: the API answered ' + read.status);
  output.signedOut = 'yes';
} else {
  throw new Error('ACTION is signIn or expectSignedOut');
}
