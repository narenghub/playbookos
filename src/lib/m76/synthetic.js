// ── SYNTHETIC ABIOZEN SCIENTIFIC OPERATIONS DATA ────────────────────────────
//
// The pilot runs on invented facts, and this is the only place they come from. Nothing here reads
// a real table, an inbox, a supplier record or a customer. That is the authorization's constraint
// and it is also a design convenience: a deterministic generator makes the whole pipeline
// replayable, which is what lets `reexecutable: true` be asserted by a test rather than hoped for.
//
// ── DETERMINISTIC, AND SAYING SO IN THE DATA ───────────────────────────────
//
// `generate({ asOf, seed })` returns the same facts for the same inputs, on any machine, for ever.
// Two reasons: the deterministic-replay acceptance case needs a byte-identical report from a
// re-dispatched step, and a pilot whose input drifts cannot distinguish "the handler changed" from
// "the data changed".
//
// Every molecule name is obviously fictional. A synthetic dataset that looks like real inventory
// is one somebody eventually quotes in a meeting.

'use strict';

const KINDS = Object.freeze(['assay', 'batch', 'qc_check', 'inquiry', 'shipment']);
const STATUSES = Object.freeze(['open', 'closed', 'blocked']);

/** Transparently fictional. Nothing here is an Abiozen product, a customer or a supplier. */
const MOLECULES = Object.freeze([
  'SYN-ALPHA-01', 'SYN-BETA-02', 'SYN-GAMMA-03', 'SYN-DELTA-04',
  'SYN-EPSILON-05', 'SYN-ZETA-06', 'SYN-ETA-07', 'SYN-THETA-08',
]);

const DEFAULT_COUNT = 120;
/** The acceptance plan's limit for an 8 GB machine: keeps the payload well inside its 32 KB cap. */
const MAX_COUNT = 500;

/** FNV-1a. Small, stable across versions, and not pretending to be a hash function for secrets. */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: a named, inspectable PRNG rather than Math.random, which cannot be replayed. */
function prng(seedInt) {
  let a = seedInt >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {string} asOf   'YYYY-MM-DD' — part of the seed, so each day's facts differ
 * @param {string} seed   an explicit seed, so one day can be regenerated identically
 * @param {number} count  how many facts
 * @returns {{asOf, seed, facts}}
 */
function generate({ asOf, seed = 'm76', count = DEFAULT_COUNT } = {}) {
  if (typeof asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    throw new Error('generate needs asOf as YYYY-MM-DD');
  }
  const n = Number(count);
  if (!Number.isInteger(n) || n < 0 || n > MAX_COUNT) {
    throw new Error(`count must be an integer between 0 and ${MAX_COUNT}, got ${count}`);
  }
  const rnd = prng(hash32(`${seed}|${asOf}|${n}`));
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  const facts = [];
  for (let i = 0; i < n; i++) {
    facts.push({
      // The id encodes the day and the index, so a fact in a report can be traced back to the
      // generator call that produced it without storing the whole dataset twice.
      id: `${asOf}-${String(i).padStart(4, '0')}`,
      kind: pick(KINDS),
      molecule: pick(MOLECULES),
      status: pick(STATUSES),
      units: Math.round(rnd() * 500) / 10,
    });
  }
  return { asOf, seed, facts };
}

module.exports = { generate, KINDS, STATUSES, MOLECULES, DEFAULT_COUNT, MAX_COUNT, hash32, prng };
