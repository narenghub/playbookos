#!/usr/bin/env node
// ── DOES THE PRE-MIGRATION CHECK GIVE THE RIGHT ANSWER? ──────────────────────
//
//   node scripts/check-claim-uniqueness-control-db.js
//
// check-claim-uniqueness-live.js decides whether a production migration may be attempted. A check
// like that is only worth its verdict if the verdict has been seen to be WRONG when the data is
// wrong — so this drives it through five database states in a disposable cluster, and then asks
// Postgres itself whether it agrees.
//
// The agreement is the point. The check predicts whether CREATE UNIQUE INDEX would succeed; this
// runs the real statement from the real migration and asserts the prediction matched. A check that
// says CLEAR where the index would fail is worse than no check, because a migration is attempted
// on its word.
//
// EXIT 0 all five states correct and Postgres agreed · 1 any mismatch · 3 no Postgres.

'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
const { pgBin, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}${d ? `\n          ${d}` : ''}`); };
const note = (m) => console.log(`  --    ${m}`);
const head = (m) => console.log(`\n  ── ${m} ──\n`);

let temp = null;
function startTemp() {
  const dir = pgBin();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/claimuniq-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55996' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55996 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55996`;
}
function stopTemp() {
  if (!temp) return;
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { env, stdio: 'pipe' });
  } catch (_) {}
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) {}
}

const url = startTemp();
if (!url) {
  console.log('  skip  no Postgres available');
  console.log('SKIP  the pre-migration check was NOT exercised — this proved nothing.');
  process.exit(EXIT_NOT_EXECUTED);
}

(async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: false });
  const query = (sql, params) => pool.query(sql, params);

  const CHECK = require('./check-claim-uniqueness-live');
  const { DDL } = require('../src/lib/outbound/ledger-schema');
  const INDEX_STMT = DDL.find((s) => /one_claim_per_ref/.test(s));

  // Captured so the five verdicts are reported together rather than buried in the check's own
  // output, which is long and written for an operator reading it live.
  const quiet = async (deps) => {
    const log = console.log;
    const lines = [];
    console.log = (...a) => lines.push(a.join(' '));
    try { return { code: await CHECK.run(deps), out: lines.join('\n') }; } finally { console.log = log; }
  };

  /** Would Postgres actually accept the index right now? Asked, never assumed. */
  const indexWouldApply = async () => {
    try {
      await query('BEGIN');
      await query(INDEX_STMT);
      await query('ROLLBACK');     // never kept: this is a question, not a migration
      return { applies: true };
    } catch (e) {
      await query('ROLLBACK').catch(() => {});
      return { applies: false, error: (e.message || '').split('\n')[0] };
    }
  };

  const agree = async (label, expected) => {
    const r = await quiet({ query });
    const real = await indexWouldApply();
    const names = { 0: 'CLEAR', 1: 'BLOCKED', 3: 'INCOMPLETE' };
    if (r.code !== expected) {
      bad(`${label}: the check said ${names[r.code] || r.code}, expected ${names[expected]}`);
    } else {
      ok(`${label}: ${names[expected]}`);
    }
    // The agreement, where the check claims to know.
    if (r.code === 0 && !real.applies) {
      bad(`${label}: the check said CLEAR but Postgres REFUSES the index`, real.error);
    } else if (r.code === 1 && real.applies) {
      bad(`${label}: the check said BLOCKED but Postgres would accept the index`,
        'the check blocks a migration that would have succeeded');
    } else if (r.code === 0 || r.code === 1) {
      ok(`…and Postgres agrees (${real.applies ? 'the index applies' : 'the index is refused'})`);
    }
    return r;
  };

  if (!INDEX_STMT) { bad('the migration no longer contains the claim-uniqueness index'); }

  try {
    // ══ A. BEFORE THE LEDGER MIGRATION ═══════════════════════════════════
    head('the ledger migration has not been applied');
    await query(`CREATE TABLE email_log (id TEXT PRIMARY KEY, to_email TEXT NOT NULL,
      subject TEXT NOT NULL, trigger_type TEXT, sent_at TIMESTAMPTZ DEFAULT NOW(),
      status TEXT, error_message TEXT)`);
    const a = await quiet({ query });
    if (a.code === 3) ok('INCOMPLETE — not a clearance');
    else bad(`the check returned ${a.code} with claim_ref and outcome absent`);
    if (/ledger migration has not been applied/.test(a.out)) {
      ok('…and it says which migration is missing');
    } else bad('the reason does not name the missing migration');

    // ══ B. MIGRATED, NOTHING CLAIMED ═════════════════════════════════════
    head('migrated, with no claimed rows at all');
    for (const stmt of DDL) if (!/one_claim_per_ref/.test(stmt)) await query(stmt);
    const b = await agree('an empty covered set', 0);
    if (/empty set/.test(b.out)) {
      ok('…and it says the empty set is not evidence the application behaved');
    } else bad('an empty result is reported without that caveat');

    // ══ C. A CLEAN POPULATED TABLE ═══════════════════════════════════════
    head('rows present, no duplicates');
    const now = new Date();
    // stop_scope is NOT optional on a BLOCKED row — the schema's own CHECK refuses one without it,
    // because "a refusal nobody can explain is indistinguishable from a bug". My first fixture
    // omitted it and was rejected, which is the constraint working.
    await query(`INSERT INTO email_log (id,to_email,subject,claim_ref,outcome,transport,
      provider_responded_at,stop_scope) VALUES
      ('c1','a@x.test','S','key-1','PROVIDER_ACCEPTED','gmail_cphi',$1,NULL),
      ('c2','b@x.test','S','key-2','CLAIMED','gmail_cphi',NULL,NULL),
      ('c3','c@x.test','S','key-3','OUTCOME_UNKNOWN','gmail_cphi',NULL,NULL),
      ('c4','d@x.test','S','key-1','BLOCKED','gmail_cphi',NULL,'capability:email.send'),
      ('c5','e@x.test','S',NULL,'PROVIDER_ACCEPTED','gmail_cphi',$1,NULL)`, [now]);
    await agree('one claimed row per ref, plus a BLOCKED row sharing a ref', 0);
    note('the BLOCKED row shares key-1 with a claimed row and does NOT conflict — the index is');
    note('partial for exactly this reason: every refused duplicate writes a row carrying the key.');

    // ══ D. DUPLICATES ════════════════════════════════════════════════════
    head('two claimed rows under one claim_ref');
    await query(`INSERT INTO email_log (id,to_email,subject,claim_ref,outcome,transport,
      provider_responded_at) VALUES
      ('d1','a@x.test','S','key-1','PROVIDER_ACCEPTED','gmail_cphi',$1),
      ('d2','f@x.test','S','approval:ap-9-l.segala@nordkem.test','CLAIMED','gmail_cphi',NULL),
      ('d3','f@x.test','S','approval:ap-9-l.segala@nordkem.test','OUTCOME_UNKNOWN','gmail_cphi',NULL)`,
    [now]);
    const d = await agree('duplicates present', 1);
    if (/2 claim_ref value\(s\) already have more than one claimed row/.test(d.out)) {
      ok('…and it reports how many');
    } else bad('the count of conflicting refs is not reported');
    if (!/l\.segala@nordkem\.test/.test(d.out)) {
      ok('…and the recipient inside a claim_ref is MASKED in the output');
    } else {
      bad('a recipient address was printed by a script intended to be run against production',
        'claim_refs are built from ids, but approval ids can carry a person');
    }
    if (/RESOLVING THEM IS NOT THIS SCRIPT/.test(d.out)) {
      ok('…and it refuses to resolve them itself');
    } else bad('the script does not say that resolution is a human act');

    // ══ E. RESOLVED ══════════════════════════════════════════════════════
    head('the duplicates resolved, by removing one row of each pair');
    await query(`DELETE FROM email_log WHERE id IN ('d1','d3')`);
    await agree('duplicates resolved', 0);

    // ══ F. THE INDEX ALREADY EXISTS ══════════════════════════════════════
    head('the index has already been created');
    await query(INDEX_STMT);
    const f = await quiet({ query });
    if (f.code === 0 && /ALREADY EXISTS/.test(f.out)) ok('CLEAR, reported as a no-op');
    else bad(`the check returned ${f.code} with the index already present`);

    // And now the real thing: does the live index refuse a duplicate claim?
    try {
      await query(`INSERT INTO email_log (id,to_email,subject,claim_ref,outcome,transport)
        VALUES ('f1','g@x.test','S','key-2','CLAIMED','gmail_cphi')`);
      bad('the index is in place and a SECOND claimed row under key-2 was accepted',
        'the partial unique index is not doing what the migration claims');
    } catch (e) {
      if (/duplicate key|unique/i.test(e.message)) {
        ok('a second claimed row under an existing claim_ref is REFUSED by the database');
      } else {
        bad('the insert failed for an unexpected reason', e.message.split('\n')[0]);
      }
    }

    // ══ G. READ-ONLY, ENFORCED ═══════════════════════════════════════════
    head('the check cannot write, whatever it is handed');
    const ro = CHECK.makeReadOnly(query);
    for (const sql of ['DELETE FROM email_log', 'UPDATE email_log SET outcome = NULL',
      'DROP INDEX idx_email_log_one_claim_per_ref', 'SELECT 1; DELETE FROM email_log',
      'WITH x AS (DELETE FROM email_log RETURNING 1) SELECT * FROM x']) {
      try {
        await ro(sql);
        bad(`the read-only wrapper PERMITTED: ${sql.slice(0, 48)}`);
      } catch (e) {
        if (/refused/.test(e.message)) continue;
        bad(`the wrapper threw something other than a refusal for: ${sql.slice(0, 40)}`, e.message);
      }
    }
    ok('every write shape is refused, including a batched statement and a writing CTE');
    const stillThere = (await query(`SELECT COUNT(*)::int n FROM email_log`)).rows[0].n;
    if (stillThere > 0) ok(`and the table still holds its ${stillThere} row(s)`);
    else bad('the table is empty after the read-only attempts');
  } catch (e) {
    bad('the control could not complete', (e && e.stack) || String(e));
  } finally {
    await pool.end().catch(() => {});
    stopTemp();
  }

  console.log();
  if (fail) {
    console.log(`FAIL  ${fail} assertion(s) failed — the pre-migration check cannot be relied on.`);
    process.exit(1);
  }
  console.log('PASS  the pre-migration check is CLEAR, BLOCKED or INCOMPLETE in the right states,');
  console.log('      Postgres agrees with every verdict it claims to know, recipients are masked,');
  console.log('      and the read-only wrapper refuses every write shape tried against it.');
  process.exit(0);
})();
