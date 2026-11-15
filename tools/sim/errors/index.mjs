/**
 * An error tracker's HTTP intake, in the shape src/platform/error-sink.js's `http` driver posts. No tracker is chosen;
 * this stands in for any.
 *
 *   POST /events     Authorization: Bearer <token> (when the sink has one)     the document of src/contracts/metrics.js (ErrorEvent)
 *     202 { id }
 *     401            a wrong token
 *     422            a document with a field outside the contract, so a test that leaks a message fails here too
 *
 * Controls (under /__sim), beside the shared ones in base.mjs (faults, calls, the clock):
 *   GET  /events     every document accepted, oldest first
 *
 *   const tracker = createErrorTracker({ token: 'sim-errors-token' });
 *   await tracker.start();           // ERROR_SINK=http  ERROR_SINK_URL=`${tracker.url}/events`
 */
import { SimError, createSim } from '../base.mjs';

const ALLOWED = new Set(['time', 'service', 'release', 'event', 'errorClass', 'code', 'frames', 'requestId', 'tenantId', 'route']);

export function createErrorTracker({ token = '' } = {}) {
  let events = [];
  let seq = 0;
  return createSim({
    name: 'errors',
    errorBody: ({ kind }) => ({ error: { code: kind, message: `Simulated ${kind}.` } }),
    reset: () => {
      events = [];
      seq = 0;
    },
    routes: (on) => {
      on('POST', '/events', (req) => {
        if (token && req.headers.authorization !== `Bearer ${token}`) throw new SimError(401, { error: { code: 'unauthorized', message: 'The token is not valid.' } });
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SimError(422, { error: { code: 'invalid', message: 'A JSON document is required.' } });
        const extra = Object.keys(body).filter((key) => !ALLOWED.has(key));
        if (extra.length) throw new SimError(422, { error: { code: 'invalid', message: `Fields outside the contract: ${extra.join(', ')}` } });
        const id = `err_sim${++seq}`;
        events.push({ id, ...body });
        return { id };
      });
    },
    controls: (on) => {
      on('GET', '/events', () => ({ events }));
    },
  });
}
