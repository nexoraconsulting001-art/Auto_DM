// Maestro runScript: plays the shopper paying the newest gateway order with the payment simulator's test card, once the
// app shows it is waiting for the payment page. The simulator marks the order captured and sends the gateway's signed
// "payment.captured" webhook to the job's server, which is the only thing that makes an order Paid. Plain ES5.
//
// env: SIM_RAZORPAY_URL (the simulator, as seen from the machine running Maestro)
// output: paymentId, orderId

var made = http.get(SIM_RAZORPAY_URL + '/__sim/calls?method=POST&path=/v1/orders');
if (!made.ok) throw new Error('The payment simulator answered ' + made.status);
var calls = json(made.body).calls || [];
var orderId = null;
for (var i = calls.length - 1; i >= 0 && !orderId; i--) {
  var reply = calls[i].response;
  if (typeof reply === 'string') {
    try { reply = JSON.parse(reply); } catch (ignored) { reply = null; }
  }
  if (reply && reply.id) orderId = reply.id;
}
if (!orderId) throw new Error('The server has opened no gateway order yet');

var paid = http.post(SIM_RAZORPAY_URL + '/__sim/pay', {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ orderId: orderId, method: 'card', outcome: 'captured', webhook: true }),
});
if (!paid.ok) throw new Error('The payment simulator answered ' + paid.status + ' to the test card');
output.orderId = orderId;
output.paymentId = json(paid.body).payment.id;
