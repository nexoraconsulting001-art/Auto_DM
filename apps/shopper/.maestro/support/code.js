// Maestro runScript: the newest 6-digit code the store's WhatsApp number sent to PHONE, read from the WhatsApp
// simulator's outbox (GET /__sim/sent), into output.code. Run it once the app shows that the code was sent: the server
// answers only after the message reached the simulator. Plain ES5, so either of Maestro's script engines runs it.
//
// env: PHONE (the number as typed), SIM_WHATSAPP_URL (the simulator, as seen from the machine running Maestro)

function digitsOf(value) {
  return String(value).replace(/\D/g, '');
}

function codeInMessage(message) {
  var texts = [];
  function walk(value) {
    if (typeof value === 'string') texts.push(value);
    else if (value && typeof value === 'object') for (var key in value) walk(value[key]);
  }
  var body = message.body || {};
  walk((body.template && body.template.components) || body.text || body);
  for (var i = 0; i < texts.length; i++) {
    var found = /(^|\D)(\d{6})(?!\d)/.exec(texts[i]);
    if (found) return found[2];
  }
  return null;
}

function newestCode(sent, phone) {
  var local = digitsOf(phone).slice(-10);
  for (var i = sent.length - 1; i >= 0; i--) {
    if (digitsOf(sent[i].to).slice(-10) === local) {
      var code = codeInMessage(sent[i]);
      if (code) return code;
    }
  }
  return null;
}

var outbox = http.get(SIM_WHATSAPP_URL + '/__sim/sent');
if (!outbox.ok) throw new Error('The WhatsApp simulator answered ' + outbox.status);
var code = newestCode(json(outbox.body).sent || [], PHONE);
if (!code) throw new Error('No code was sent to that number');
output.code = code;
