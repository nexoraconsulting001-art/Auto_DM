/**
 * The activity generator (Phase 8, Q-03): thirty days of a business's life, made the way real data arrives. Nothing is
 * inserted into a table. Every event goes in through the door a real one uses:
 *
 *   comments, DMs, story replies, mentions   signed Meta webhooks from tools/sim/meta to the app's /webhook, so each one
 *                                            passes intake, the automations and the compliance engine, and what the app
 *                                            sends back lands in the simulator
 *   insights                                 the Meta simulator's insights answers, read by the app's own refresh job
 *   page visits                              buyer pages fetched on the business's host, and the traffic beacon they call
 *   carts and checkouts                      the store's own routes (cart, checkout), as a shopper's browser would
 *   payments, shipments, WhatsApp            the Razorpay, Shiprocket and WhatsApp simulators' signed webhooks, so an
 *                                            order moves through the order state machine: paid, packed, shipped,
 *                                            delivered, and some returned, refunded and reviewed
 *
 * Time is the controlled clock: the generator moves it forward through the days, and the app and the worker under it read
 * the same clock, so windows, caps, quiet hours and retention behave as they would over a month.
 *
 * Every shopper is an invented person (inventedPerson in src/contracts/seed.js); the generator makes no other name,
 * phone, email or Instagram id. Every choice comes from createRng(seed), never Math.random or the wall clock, so two runs
 * with the same seed on the same seed files produce the same events in the same order: `digest` is the proof (Q-03).
 *
 *   run({ businesses, days, seed, clock, world }) -> { days, seed, events, counts, digest }
 *
 *   businesses   what loadShowcase() answers, already loaded into the database: [{ key, seed, catalogue, tenantId, host }]
 *   days         how many days, ending at clock.now(); default SHOWCASE.days (30)
 *   seed         a whole number; default SHOWCASE.randomSeed
 *   clock        { now(): Date, set(date), advance(ms) }: createClock() below, or the test's own
 *   world        { baseUrl, sims: { meta, razorpay, shiprocket, whatsapp }, drain(): Promise } the running app's address,
 *                the simulators (tools/sim), and a call that lets the worker finish what is queued before time moves on
 *   events       how many events were sent
 *   counts       { <business key>: { <ACTIVITY_KINDS member>: n } }
 *   digest       sha-256 over the ordered list of [day, business key, kind, subject index]: no name, no text
 *
 * run() is built in ./run.mjs and re-exported here; createRng, createClock and digestOf are the shared parts every piece of
 * Phase 8 draws from. The world it runs in is ./world.mjs (the app, its worker and the simulators); seeding a business is ./seed.mjs.
 */
import crypto from 'node:crypto';
import { SHOWCASE, inventedPerson } from '../../../src/contracts/seed.js';

export const ACTIVITY_KINDS = Object.freeze([
  'comment', 'dm', 'story_reply', 'mention', 'insights', 'visit', 'cart', 'checkout', 'payment', 'shipment', 'delivery', 'whatsapp', 'return', 'refund', 'review',
]);

export class ActivityError extends Error {}

/**
 * A small seeded generator (mulberry32). The same seed gives the same sequence on every machine.
 *   next()            a number in [0, 1)
 *   int(min, max)     a whole number from min to max, both included
 *   pick(list)        one member
 *   chance(p)         true with probability p
 *   fork(label)       an independent generator for one business or one day, so adding events to one never shifts another
 */
export function createRng(seed) {
  if (!Number.isInteger(seed) || seed < 0) throw new ActivityError('The random seed is a whole number, 0 or more');
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
    fork: (label) => createRng(crypto.createHash('sha256').update(`${seed}:${label}`).digest().readUInt32BE(0)),
  };
}

/** A clock that only moves when told to. `start` is a Date or an ISO string. */
export function createClock(start) {
  let at = new Date(start).getTime();
  if (!Number.isFinite(at)) throw new ActivityError('The clock needs a start time');
  return {
    now: () => new Date(at),
    set: (date) => { at = new Date(date).getTime(); },
    advance: (ms) => { at += ms; return new Date(at); },
  };
}

/** The proof two runs agree: a sha-256 over the ordered events, each [day, business key, kind, subject index]. */
export function digestOf(events) {
  const hash = crypto.createHash('sha256');
  for (const [day, key, kind, subject] of events) {
    if (!ACTIVITY_KINDS.includes(kind)) throw new ActivityError(`"${kind}" is not a kind of activity`);
    hash.update(`${day}|${key}|${kind}|${subject}\n`);
  }
  return hash.digest('hex');
}

/** Checks and fills in what run() was given. */
export function runOptions({ businesses, days = SHOWCASE.days, seed = SHOWCASE.randomSeed, clock, world } = {}) {
  if (!Array.isArray(businesses) || businesses.length === 0) throw new ActivityError('Give the businesses to make activity for');
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new ActivityError('days is a whole number from 1 to 90');
  if (typeof clock?.now !== 'function' || typeof clock?.advance !== 'function') throw new ActivityError('Give the controlled clock');
  return { businesses, days, seed, clock, world, rng: createRng(seed) };
}

export { run } from './run.mjs';
