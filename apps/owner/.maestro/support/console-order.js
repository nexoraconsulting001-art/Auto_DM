// Maestro runScript: what the web console shows for an order on refresh (P-18). Signs a second owner of the business
// in the way the console does (a WhatsApp code, then a cookie session on the sign-in host), reads GET /api/v1/orders/:id
// as the console does, and fails unless its fulfilment status is EXPECT. Puts the status in output.consoleStatus.
// Plain ES5, so either of Maestro's script engines runs it.
//
// env: API_URL, SIGN_IN_HOST, SIM_WHATSAPP_URL, PHONE (the console seller), ORDER_ID, EXPECT

function digitsOf(value) {
  return String(value).replace(/\D/g, '');
}

function codeFor(phone) {
  var outbox = http.get(SIM_WHATSAPP_URL + '/__sim/sent');
  if (!outbox.ok) throw new Error('The WhatsApp simulator answered ' + outbox.status);
  var sent = json(outbox.body).sent || [];
  var local = digitsOf(phone).slice(-10);
  for (var i = sent.length - 1; i >= 0; i--) {
    if (digitsOf(sent[i].to).slice(-10) !== local) continue;
    var found = /(^|\D)(\d{6})(?!\d)/.exec(JSON.stringify(sent[i].body));
    if (found) return found[2];
  }
  throw new Error('No code was sent to the console seller');
}

// A response header, whatever case the engine gives its name in and whether it holds one value or a list.
function header(response, name) {
  var all = response.headers || {};
  for (var key in all) {
    if (String(key).toLowerCase() !== name) continue;
    var value = all[key];
    return typeof value === 'string' ? value : value && value.length ? String(value[0]) : String(value);
  }
  return '';
}

var onSignInHost = { 'content-type': 'application/json', 'x-forwarded-host': SIGN_IN_HOST };

var started = http.post(API_URL + '/api/v1/auth/start', { headers: onSignInHost, body: JSON.stringify({ phone: PHONE }) });
if (started.status !== 202) throw new Error('auth.start answered ' + started.status);

var verified = http.post(API_URL + '/api/v1/auth/verify', {
  headers: onSignInHost,
  body: JSON.stringify({ phone: PHONE, code: codeFor(PHONE), transport: 'cookie' }),
});
if (verified.status !== 201) throw new Error('auth.verify answered ' + verified.status);
var cookie = header(verified, 'set-cookie').split(';')[0];
if (!cookie) throw new Error('The console sign-in set no cookie');

var read = http.get(API_URL + '/api/v1/orders/' + ORDER_ID, { headers: { cookie: cookie, 'x-forwarded-host': SIGN_IN_HOST } });
if (read.status !== 200) throw new Error('The console read of the order answered ' + read.status);
var order = json(read.body);
output.consoleStatus = order.fulfilmentStatus;
if (order.fulfilmentStatus !== EXPECT) throw new Error('The console shows the order as ' + order.fulfilmentStatus + ', not ' + EXPECT);
