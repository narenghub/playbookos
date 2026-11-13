#!/usr/bin/env node
// ── WHAT HAPPENED TO THE SENDS NOBODY KNOWS ABOUT? ───────────────────────────
//
//   railway ssh --service playbookos 'node /app/scripts/reconcile-outbound-claims.js; echo "EXIT=$?"'
//
// Final readiness item 4, the reconciliation half. READ-ONLY: it reports and emits the exact SQL a
// human would run. It writes nothing.
//
// ── WHAT AN UNRESOLVED CLAIM IS ──────────────────────────────────────────────
//
// `claim()` records responsibility BEFORE the provider call, so a crash between the two leaves a
// row saying an attempt was made and its outcome is unknown. That is the honest trace, and it is
// deliberately not cleaned up automatically: the row is the only evidence the attempt happened, and
// it blocks a retry that might send a second real message.
//
// It also blocks the key forever. Until somebody establishes what happened, that message cannot be
// re-sent and the recipient may have received nothing. So unresolved claims are work, not noise.
//
// ── WHAT THE TWO-LAYER SPLIT MAKES POSSIBLE ──────────────────────────────────
//
// Most of them can now be resolved WITHOUT asking the provider. The application and the sender
// service each write their own row and share a correlation_id, so when the application's row says
// CLAIMED or OUTCOME_UNKNOWN and the service's row under the same correlation says
// PROVIDER_ACCEPTED, the answer is already in the database: the provider took it, and only the
// application's knowledge of that was lost. That is the common case — a timeout, a container
// restart, a connection reset between the two processes — and it needs no Gmail query at all.
//
// The reverse also resolves: the service's row says PROVIDER_REJECTED or BLOCKED, so nothing left,
// and the application's claim can be closed as such.
//
// What CANNOT be resolved from the database is a correlation where the SERVICE never recorded
// anything — the request may not have arrived, or the service died before its own insert. Those are
// reported separately as needing the provider's own record, and this script does not guess.
//
// ── IT PROPOSES, IT DOES NOT WRITE ───────────────────────────────────────────
//
// Every query goes through a wrapper that refuses anything but a single SELECT. Resolution is a
// human act: RECONCILED means "a human or a reconciliation job later established what actually
// happened", and a script that wrote it from an inference would be putting a guess where the
// schema promises a finding.
//
// EXIT 0  nothing unresolved, or everything unresolved can be resolved from the ledger
// EXIT 1  at least one claim needs evidence this database does not hold
// EXIT 3  nothing could be established

'use strict';

const EXIT_NOT_ESTABLISHED = 3;
const SCHEMA = require('../src/lib/outbound/ledger-schema');

let needsProvider = 0;
let incomplete = false;
const ok = (m) => console.log(`  ok    ${m}`);
const warn = (m) => console.log(`  ..    ${m}`);
const note = (m) => console.log(`        ${m}`);

/** Recipients and claim_refs are masked: this is meant to be run in production and pasted. */
function maskAddr(v) {
  if (!v) return '(none)';
  const s = String(v);
  const at = s.indexOf('@');
  return at > 1 ? `${s.slice(0, 1)}***@${s.slice(at + 1).replace(/^[^.]*/, '***')}` : '***';
}
const maskRef = (v) => String(v || '(null)').replace(/[^\s:@]+@[^\s:]+/g, '***@***').slice(0, 56);

function makeReadOnly(query) {
  return async (sql, params = []) => {
    const normalised = String(sql).trim().replace(/\s+/g, ' ');
    if (!/^SELECT\b/i.test(normalised)) {
      throw new Error(`refused: this script runs SELECT only, got: ${normalised.slice(0, 60)}`);
    }
    if (/;/.test(normalised.replace(/;$/, ''))) {
      throw new Error('refused: statement batching is not allowed in a read-only reconciler');
    }
    return query(sql, params);
  };
}

async function main(deps = {}) {
  const windowHours = Number(deps.windowHours || process.env.RECONCILE_WINDOW_HOURS || 24 * 30);
  const sinceISO = new Date(Date.now() - windowHours * 3600000).toISOString();

  console.log('\n══ UNRESOLVED OUTBOUND CLAIMS — READ-ONLY ══\n');
  note(`window         the last ${windowHours} hour(s)`);
  note('resolution     PROPOSED only. This script writes nothing.');
  console.log();

  let ro;
  try {
    const { query } = deps.query ? deps : require('../src/lib/db');
    ro = makeReadOnly(deps.query || query);
  } catch (e) {
    console.log(`  FAIL  the database could not be reached: ${e.message}`);
    incomplete = true;
    return;
  }

  // ── 1. EVERY CLAIM NOBODY RESOLVED ────────────────────────────────────────
  //
  // CLAIMED means the outcome was never recorded. OUTCOME_UNKNOWN means it was recorded as unknown.
  // Both are unresolved; they differ in whether the process survived to say so, and both block the
  // key, so both are listed.
  let rows;
  try {
    rows = await ro(
      `SELECT id, correlation_id, claim_ref, transport, outcome, to_email, subject, sent_at
         FROM ${SCHEMA.TABLE}
        WHERE sent_at >= $1
          AND outcome IN ('CLAIMED', 'OUTCOME_UNKNOWN')
        ORDER BY sent_at DESC
        LIMIT 500`, [sinceISO]);
  } catch (e) {
    console.log(`  FAIL  the unresolved claims could not be read: ${e.message}`);
    incomplete = true;
    return;
  }

  if (!rows.rows.length) {
    ok('no unresolved claims in the window');
    note('Which is the state to want, and is NOT by itself evidence that sends are working — an');
    note('application that never records a claim produces the same empty answer.');
    return;
  }
  warn(`${rows.rows.length} unresolved claim(s)`);
  console.log();

  // ── 2. WHAT THE OTHER LAYER SAYS ABOUT EACH ONE ───────────────────────────
  const correlations = [...new Set(rows.rows.map((r) => r.correlation_id).filter(Boolean))];
  let siblings = { rows: [] };
  if (correlations.length) {
    try {
      siblings = await ro(
        `SELECT correlation_id, claim_ref, outcome, provider_message_id, provider_responded_at
           FROM ${SCHEMA.TABLE}
          WHERE correlation_id = ANY($1)
            AND outcome IN ('PROVIDER_ACCEPTED', 'PROVIDER_REJECTED', 'BLOCKED', 'RECONCILED')`,
        [correlations]);
    } catch (e) {
      console.log(`  FAIL  the sibling rows could not be read: ${e.message}`);
      incomplete = true;
      return;
    }
  }
  const byCorrelation = new Map();
  for (const s of siblings.rows) {
    if (!byCorrelation.has(s.correlation_id)) byCorrelation.set(s.correlation_id, []);
    byCorrelation.get(s.correlation_id).push(s);
  }

  const resolvable = [];
  const unresolvable = [];
  for (const r of rows.rows) {
    const sib = (r.correlation_id && byCorrelation.get(r.correlation_id)) || [];
    // The other layer's row, not this one's. Same correlation, different claim_ref.
    const other = sib.filter((s) => s.claim_ref !== r.claim_ref);
    const accepted = other.find((s) => s.outcome === 'PROVIDER_ACCEPTED');
    const definitelyNot = other.find((s) => s.outcome === 'PROVIDER_REJECTED' || s.outcome === 'BLOCKED');
    if (accepted) {
      resolvable.push({ row: r, verdict: 'PROVIDER_ACCEPTED', evidence: accepted });
    } else if (definitelyNot) {
      resolvable.push({ row: r, verdict: definitelyNot.outcome, evidence: definitelyNot });
    } else {
      unresolvable.push(r);
    }
  }

  console.log('        state              transport        recipient                  claim_ref');
  console.log(`        ${'-'.repeat(92)}`);
  for (const r of resolvable) {
    console.log(`        RESOLVABLE         ${String(r.row.transport).padEnd(16)} `
      + `${maskAddr(r.row.to_email).padEnd(26)} ${maskRef(r.row.claim_ref)}`);
    note(`  → the other layer recorded ${r.verdict}`
      + `${r.evidence.provider_message_id ? ` (provider id present)` : ''}`);
  }
  for (const r of unresolvable) {
    console.log(`        NEEDS PROVIDER     ${String(r.transport).padEnd(16)} `
      + `${maskAddr(r.to_email).padEnd(26)} ${maskRef(r.claim_ref)}`);
  }
  console.log();

  if (resolvable.length) {
    ok(`${resolvable.length} claim(s) can be resolved FROM THE LEDGER — no provider query needed`);
    note('This is what the two-layer split buys: the application lost its knowledge of the');
    note('outcome, and the sender service had already recorded it under the same correlation.');
    console.log();
    note('THE SQL A HUMAN WOULD RUN. One statement per row, by id, never by pattern or timestamp:');
    console.log();
    for (const r of resolvable) {
      const kind = r.verdict === 'PROVIDER_ACCEPTED' ? 'the provider accepted it' : `the provider did not send it (${r.verdict})`;
      console.log(`        UPDATE ${SCHEMA.TABLE} SET outcome = 'RECONCILED',`);
      console.log(`               reconciled_note = ${JSON.stringify(`${kind}; established from correlation ${String(r.row.correlation_id).slice(0, 12)}`)}`);
      console.log(`         WHERE id = ${JSON.stringify(r.row.id)};`);
    }
    console.log();
    note('RECONCILED is still covered by the claim-uniqueness index, so this does not free the key');
    note('for a re-send. That is deliberate: resolving what happened and deciding to send again are');
    note('different decisions, and the second one needs a fresh approval anyway.');
  }

  if (unresolvable.length) {
    needsProvider = unresolvable.length;
    console.log();
    warn(`${unresolvable.length} claim(s) cannot be resolved from this database`);
    note('For each, the SERVICE recorded nothing under the correlation — so either the request never');
    note('arrived, or the service died before its own insert. The two are indistinguishable here and');
    note('this script will not guess between them.');
    note('');
    note('To resolve one, the provider\'s own record is the evidence: search the sending mailbox\'s');
    note('Sent folder for the subject and recipient at that timestamp. If it is there, the message');
    note('went; if it is not, nothing did. Then record the finding as RECONCILED with what was found.');
  }
}

function report() {
  console.log();
  if (incomplete) {
    console.log('INCOMPLETE  nothing was established.');
    return EXIT_NOT_ESTABLISHED;
  }
  if (needsProvider) {
    console.log(`ATTENTION  ${needsProvider} claim(s) need evidence this database does not hold.`);
    return 1;
  }
  console.log('CLEAR  every unresolved claim can be resolved from the ledger, or there are none.');
  console.log('       Nothing was written by this script.');
  return 0;
}

async function run(deps = {}) {
  needsProvider = 0; incomplete = false;
  try { await main(deps); } catch (e) {
    console.log(`\nINCOMPLETE  ${(e && e.message) || e}`);
    return EXIT_NOT_ESTABLISHED;
  }
  return report();
}

module.exports = { run, main, makeReadOnly, maskAddr, maskRef };

if (require.main === module) {
  main().then(() => process.exit(report())).catch((e) => {
    console.log(`\nINCOMPLETE  ${(e && e.message) || e}`);
    process.exit(EXIT_NOT_ESTABLISHED);
  });
}
