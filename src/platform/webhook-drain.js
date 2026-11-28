import { reportError } from './log.js';

/**
 * Working through provider_webhook_events (PRD 9.7) when more than one process does it (R4-WH-1, after R4-MONEY-2).
 *
 * Every webhook owner (payments, billing, shipping, Shopify sync, WhatsApp alerts) stores an event, answers the provider,
 * then works the event from the table twice over: at once in the web app that took it (kick) and in the worker's sweep for
 * anything left (drain). Both used to read the same 'received' rows and work them side by side, so one event could be
 * applied twice and a later event of the same subject could be applied while an earlier one was still in another
 * process's hands. This is the one way an owner works its rows:
 *
 *   claim   A drainer takes an event before it works it: while an event is 'received', processed_at is the time a drainer
 *           took it, and no other drainer touches it until that drainer has finished it (its own UPDATE ... WHERE status =
 *           'received'), let it go, or `lease` has passed (a drainer that died). The claim is one UPDATE, so of two drainers
 *           only one gets an event. After the owner's work the drainer lets go of an event still 'received' (a failure to
 *           be tried again after its back-off), only if the claim is still its own.
 *   order   Each event names its subjects (a subscription, a payment and its gateway order, an AWB, a shop). With 'in_hand',
 *           an event waits while an earlier event of a subject it shares is in another drainer's hands; with 'strict' it
 *           waits while any earlier event of a shared subject is still 'received' at all (in hand, or waiting to be tried
 *           again), so events of one subject are applied in the order they came, and never one before the one ahead of it.
 *           A waiting event is let go and taken up by the next pass (of this drainer or the one that holds the earlier one).
 *   owner   Each owner reads only its own rows (`providers` and `scopes`, LIKE patterns): Bhava's billing account and the
 *           store's managed account are both provider 'razorpay', told apart only by scope.
 *
 * A drain repeats passes until one does nothing; an event is tried once per drain, so a failing one waits for its next turn.
 *
 *   providers   e.g. ['razorpay', 'cashfree']
 *   scopes      LIKE patterns, e.g. ['managed', 'tenant:%']
 *   subjects    { sql, of }: a text[] SQL expression over a row of the table, and the same list worked out in JavaScript
 *   order       'in_hand' (default) or 'strict'
 *   process     (row) -> result: the owner's work on one claimed event, which finishes it or records its failure itself
 */
export function createWebhookDrain({ db, name, providers, scopes, subjects, order = 'in_hand', process, batch = 50, lease = '5 minutes' }) {
  if (!['in_hand', 'strict'].includes(order)) throw new Error(`unknown order ${order}`);
  const handle = typeof db === 'function' ? db : () => db;
  const mine = `provider = ANY($1::text[]) AND scope LIKE ANY($2::text[])`;

  /** Takes the event for this drainer. -> the claim (processed_at as text, microseconds kept), or null when another has it. */
  async function claim(row) {
    const [taken] = await handle().query(
      `UPDATE provider_webhook_events SET processed_at = now()
       WHERE id = $1 AND status = 'received' AND (processed_at IS NULL OR processed_at < now() - $2::interval) RETURNING processed_at::text AS mark`,
      [row.id, lease],
    );
    return taken?.mark ?? null;
  }

  /** Lets go of an event still waiting, if this drainer's claim on it is still the one there. */
  const letGo = (row, mark) => handle().query(
    `UPDATE provider_webhook_events SET processed_at = NULL WHERE id = $1 AND status = 'received' AND processed_at = $2::timestamptz`,
    [row.id, mark],
  );

  /** Whether an earlier event of a subject this one names must be finished first. */
  async function waitsBehind(row) {
    const names = [...new Set((subjects.of(row) ?? []).filter((s) => typeof s === 'string' && s))];
    if (!names.length) return false;
    const held = order === 'strict' ? '' : `AND processed_at >= now() - $5::interval`;
    const earlier = await handle().query(
      `SELECT 1 FROM provider_webhook_events
       WHERE ${mine} AND status = 'received' AND id < $3 AND (${subjects.sql}) && $4::text[] ${held} LIMIT 1`,
      [providers, scopes, row.id, names, ...(order === 'strict' ? [] : [lease])],
    );
    return earlier.length > 0;
  }

  /** One event, if this drainer gets it and nothing ahead of it must go first. -> the owner's result, or null */
  async function take(row) {
    const mark = await claim(row);
    if (!mark) return null;
    try {
      if (await waitsBehind(row)) return null;
      // The back-off of a failure runs from here, the start of this attempt (R6-RECON-2).
      await handle().query('UPDATE provider_webhook_events SET last_attempt_at = now() WHERE id = $1', [row.id]);
      return (await process(row)) ?? { id: Number(row.id) };
    } finally {
      await letGo(row, mark);
    }
  }

  /**
   * One pass over what is waiting and nobody has in hand, oldest first. A failure waits longer before each try, measured
   * from its last attempt (5 s, 20 s, 80 s, 320 s, 1,280 s, then an hour each), so its tries are spread over hours, not
   * used up in the first hour after it arrived (R6-RECON-2, M-3).
   */
  async function dispatch({ limit = batch, tried = new Set() } = {}) {
    const rows = await handle().query(
      `SELECT * FROM provider_webhook_events
       WHERE ${mine} AND status = 'received'
         AND (attempts = 0 OR COALESCE(last_attempt_at, received_at) < now() - make_interval(secs => least(3600, 5 * power(4, attempts - 1))))
         AND (processed_at IS NULL OR processed_at < now() - $4::interval) AND NOT (id = ANY($5::bigint[]))
       ORDER BY id LIMIT $3`,
      [providers, scopes, limit, lease, [...tried]],
    );
    const results = [];
    for (const row of rows) {
      tried.add(Number(row.id));
      const result = await take(row);
      if (result) results.push(result);
    }
    return results;
  }

  /** Passes until one does nothing, so an event left waiting behind another is taken up here. */
  async function drain() {
    const all = [];
    const tried = new Set();
    for (let pass = 0; pass < 100; pass++) {
      const results = await dispatch({ tried });
      all.push(...results);
      if (!results.length) break;
    }
    return all;
  }

  let running = null;
  let again = false;
  /** Works through new events soon, in this process; one run at a time. -> the run in progress */
  function kick() {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await drain();
        } while (again);
      } catch (err) {
        reportError(err, { msg: `${name}_drain_failed` });
      } finally {
        running = null;
      }
    })();
    return running;
  }

  /** Waits for a run in progress, then drains what is left (tests and the worker). */
  async function settle() {
    while (running) await running;
    return drain();
  }

  return { dispatch, drain, kick, settle };
}
