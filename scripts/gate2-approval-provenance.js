#!/usr/bin/env node
// ── WHERE DID THIS NUMBER ENTER THE WORKFLOW? ───────────────────────────────
//
//   railway ssh 'node scripts/gate2-approval-provenance.js a4e228e5-2194-416c-97f3-102da7e287bc'
//
// READS ONLY. No INSERT, no UPDATE, no DELETE, no DDL, no email.
// EXIT 0 MEANS "I MEASURED", NOT "ALL CLEAR".
//
// ── WHY ─────────────────────────────────────────────────────────────────────
//
// On 21 July 2026 an RFQ reached Laurus Labs, Divi's and Dr Reddy's with the subject
// `RFQ — Tramadol Hydrochloride (27203-92-5) — Abiozen LLC`. Both that number and the canonical
// `36282-47-0` pass the CAS checksum, and the external ruling established they name different
// forms: `27203-92-5` is Tramadol, `36282-47-0` is Tramadol Hydrochloride. The filed name and the
// filed number referred to different substances.
//
// Fixing the row is not the point and is not authorised. The question is where the number came
// from, because that decides whether the defect is a row or a producer.
//
// ── WHAT IT ESTABLISHES, AND WHAT IT REFUSES TO GUESS ───────────────────────
//
// It reads the approval row, resolves the requester, runs the SHIPPED parseApproval over the
// payload to show exactly what the producer derived from it, and then searches every CAS-bearing
// column in the database for the literal value — because a value that exists elsewhere was
// plausibly copied, and one that exists nowhere else was typed or generated.
//
// Where the evidence does not settle it, it prints UNKNOWN. An inferred provenance presented as a
// finding is worse than an admitted gap: it would be used to decide whether a producer needs
// fixing.
'use strict';

const fs = require('fs');
const { query } = require('../src/lib/db');

const out = (s) => fs.writeSync(1, s + '\n');
const err = (s) => fs.writeSync(2, s + '\n');

const approvalId = (process.argv[2] || '').trim();
if (!approvalId) {
  err('usage: node scripts/gate2-approval-provenance.js <approval_queue id>');
  err('  no default: a production script must not investigate the wrong row because an argument');
  err('  was forgotten.');
  process.exit(2);
}

async function columnsOf(table) {
  try {
    return (await query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1`,
      [table])).rows;
  } catch (_) { return []; }
}

function printRow(r, label = '') {
  for (const [k, v] of Object.entries(r)) {
    if (v === null || v === undefined || String(v) === '') continue;
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    out(`     ${label}${k} = ${s.length > 1200 ? `${s.slice(0, 1200)}… [${s.length} chars]` : s}`);
  }
}

async function main() {
  out('');
  out('════ APPROVAL PROVENANCE ══════════════════════════════════════════════');
  out(`   approval id: ${approvalId}`);
  out('   READS ONLY. Exit 0 means the evidence was gathered.');

  // ── 1. the approval row itself, every column it really has ──
  out('');
  out('── 1. THE APPROVAL ROW  (approval_queue)');
  const aqCols = await columnsOf('approval_queue');
  if (!aqCols.length) { out('   TABLE approval_queue DOES NOT EXIST'); return 2; }
  let row;
  try {
    row = (await query(
      `SELECT * FROM approval_queue WHERE id = $1`, [approvalId])).rows[0];
  } catch (e) { out(`   QUERY FAILED — ${e.message}`); return 2; }
  if (!row) {
    out('   NOT FOUND. The approval row no longer exists, so its payload cannot be read and the');
    out('   provenance of the CAS is UNKNOWN from this route.');
    out('');
    out(`DIGEST approval=${approvalId} found=no provenance=UNKNOWN`);
    return 0;
  }
  printRow(row);

  // ── 2. who or what requested it ──
  out('');
  out('── 2. THE REQUESTER');
  const userCol = ['requested_for_user_id', 'requested_by_user_id', 'user_id', 'created_by']
    .find((c) => aqCols.some((x) => x.column_name === c));
  if (!userCol || !row[userCol]) {
    out(`   no requester column populated (looked for requested_for_user_id, requested_by_user_id,`);
    out('   user_id, created_by) — requester UNKNOWN');
  } else {
    try {
      const u = (await query(
        `SELECT id, email, name, role, is_active FROM users WHERE id = $1`, [row[userCol]])).rows[0];
      if (u) { out(`   ${userCol} resolves to:`); printRow(u); }
      else out(`   ${userCol} = ${row[userCol]} does not resolve to a users row`);
    } catch (e) { out(`   users lookup failed — ${e.message}`); }
  }
  // An agent-authored approval usually leaves a trace in the activity log.
  try {
    const acts = (await query(
      `SELECT agent_name, action_type, reasoning, output_summary, created_at
         FROM agent_activity_log
        WHERE reasoning ILIKE $1 OR output_summary ILIKE $1
        ORDER BY created_at LIMIT 10`, [`%${approvalId}%`])).rows;
    out('');
    out(`   agent_activity_log entries naming this approval: ${acts.length}`);
    for (const a of acts) printRow(a, '  ');
  } catch (e) { out(`   agent_activity_log lookup failed — ${e.message}`); }

  // ── 3. what the SHIPPED producer derives from this payload ──
  //
  // Calls parseApproval, not a copy of it. The whole question is what production does with this
  // payload, and a reimplementation here would answer a different question.
  out('');
  out('── 3. WHAT THE SHIPPED parseApproval DERIVES FROM IT');
  const payloadCol = ['action_payload', 'payload', 'action_data']
    .find((c) => aqCols.some((x) => x.column_name === c));
  let parsed = null;
  let rawPayload = payloadCol ? row[payloadCol] : null;
  if (!payloadCol) {
    out('   no payload column found — UNKNOWN');
  } else {
    try {
      const procurement = require('../src/lib/agents/procurement-agent');
      if (typeof procurement.parseApproval !== 'function') {
        out('   parseApproval is not exported, so what production derives cannot be shown without');
        out('   reimplementing it — which would answer a different question. Reporting UNKNOWN.');
      } else {
        parsed = procurement.parseApproval(rawPayload, row.action_type);
        out('   parseApproval returns:');
        printRow(parsed);
      }
    } catch (e) { out(`   could not run parseApproval — ${e.message}`); }
  }

  // ── 4. structured field, or regex over free text? ──
  //
  // This is the distinction that says whether somebody entered a CAS or whether the producer
  // scraped one out of a sentence.
  out('');
  out('── 4. STRUCTURED FIELD OR FREE-TEXT EXTRACTION?');
  let p = {};
  try { p = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : (rawPayload || {}); } catch (_) { p = {}; }
  const task = String(p.task || '');
  const hasStructuredCas = Object.prototype.hasOwnProperty.call(p, 'cas_number') && p.cas_number;
  const hasStructuredName = Object.prototype.hasOwnProperty.call(p, 'molecule_name') && p.molecule_name;
  const casFromTask = task.match(/CAS:?\s*([0-9]{2,7}-[0-9]{2}-[0-9])/i);
  const nameFromTask = task.match(/Source\s+(.+?)\s*\(CAS/i);
  out(`   payload keys                      ${JSON.stringify(Object.keys(p))}`);
  out(`   structured cas_number present     ${hasStructuredCas ? JSON.stringify(p.cas_number) : 'no'}`);
  out(`   structured molecule_name present  ${hasStructuredName ? JSON.stringify(p.molecule_name) : 'no'}`);
  out(`   free-text task present            ${task ? `yes (${task.length} chars)` : 'no'}`);
  if (task) out(`     task = ${JSON.stringify(task.slice(0, 600))}`);
  out(`   CAS regex over task matched       ${casFromTask ? JSON.stringify(casFromTask[1]) : 'no'}`);
  out(`   name regex over task matched      ${nameFromTask ? JSON.stringify(nameFromTask[1]) : 'no'}`);
  out('');
  if (hasStructuredCas) {
    out('   → the CAS came from a STRUCTURED payload field. Whoever or whatever wrote that field');
    out('     is the producer; this row does not say which.');
  } else if (casFromTask) {
    out('   → the CAS was SCRAPED BY REGEX out of a free-text sentence. The name is extracted by a');
    out('     SEPARATE regex over the SAME sentence, and nothing compares them, which is exactly');
    out('     how a name and a number describing different forms travel together into a subject');
    out('     line.');
  } else {
    out('   → no CAS is derivable from this payload at all. If the RFQ carries one, it did not');
    out('     come from here, and its provenance is UNKNOWN from this route.');
  }

  // ── 5. does the value exist anywhere else? copied, or originated here? ──
  const subject = parsed && parsed.cas_number ? parsed.cas_number : (casFromTask ? casFromTask[1] : null);
  out('');
  out('── 5. DOES THAT CAS EXIST ANYWHERE ELSE IN THE DATABASE?');
  if (!subject) {
    out('   no CAS to search for');
  } else {
    out(`   searching every CAS-bearing column for ${JSON.stringify(subject)}`);
    const candidates = (await query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE (column_name ILIKE '%cas%') AND table_schema = 'public'
        ORDER BY table_name, column_name`)).rows;
    let hits = 0;
    for (const c of candidates) {
      try {
        const r = await query(
          `SELECT COUNT(*)::int n FROM ${c.table_name} WHERE ${c.column_name}::text = $1`, [subject]);
        if (r.rows[0].n > 0) {
          hits += r.rows[0].n;
          out(`     ${c.table_name}.${c.column_name}: ${r.rows[0].n} row(s)`);
        }
      } catch (_) { /* a column that cannot be compared as text is not evidence either way */ }
    }
    if (!hits) {
      out('     found NOWHERE else.');
      out('   → the value did not come from another table in this database. It was typed or');
      out('     generated upstream. Which of those, this evidence does not say: UNKNOWN.');
    } else {
      out(`   → the value appears in ${hits} other row(s). It may have been copied from one of`);
      out('     them, or they may all share the same upstream origin. This does not establish');
      out('     direction of travel on its own.');
    }
  }

  // ── 6. can the same producer still do this today? ──
  //
  // Answered from the shipped code's structure, not from the row.
  out('');
  out('── 6. CAN THE SAME MISMATCH STILL BE PRODUCED TODAY?');
  out('   parseApproval extracts the molecule name and the CAS from the SAME free-text string via');
  out('   TWO INDEPENDENT regexes (`Source (.+?) \\(CAS` and `CAS:?\\s*([0-9]{2,7}-[0-9]{2}-[0-9])`),');
  out('   or from two separate structured fields. Nothing in that function, or anywhere between it');
  out('   and the supplier email, checks that the name and the number describe the same substance');
  out('   or the same FORM. There is no checksum test and no canonical comparison.');
  out('');
  out('   → YES. Unchanged. A payload naming a salt beside a base\'s registry number still produces');
  out('     an RFQ subject line carrying both.');

  out('');
  out('════ DIGEST ═══════════════════════════════════════════════════════════');
  out(`approval=${approvalId} found=yes action_type=${row.action_type || 'n/a'} `
    + `status=${row.status || 'n/a'} cas_source=${hasStructuredCas ? 'structured_field'
      : (casFromTask ? 'regex_over_free_text' : 'none')} parsed_cas=${subject || 'none'} `
    + `parsed_name=${parsed && parsed.molecule_name ? JSON.stringify(parsed.molecule_name) : 'none'}`);
  out('');
  out('Nothing above adjudicates a CAS, edits a row, or contacts anyone.');
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => { err(`PROVENANCE FAILED: ${e.message}\n${e.stack}`); process.exit(2); });
}

module.exports = { main };
