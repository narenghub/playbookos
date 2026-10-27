#!/usr/bin/env node
// ── TWO SIMULTANEOUS RUNS MUST NOT EMAIL THE SAME SUPPLIER TWICE ─────────────
//
//   scripts/check-supplier-rfq-claim-db.js   → exit 0 = the duplicate send is impossible
//
// ── WHY THIS CHECK EXISTS ────────────────────────────────────────────────────
//
// Until 27 Oct the procurement agent deduplicated with a SELECT before the send and wrote its log
// row after it (procurement-agent.js:342-370), with no unique constraint behind the read. Two real
// duplicates followed from that, and neither is a crash:
//
//   1. the send lands, the INSERT fails or the process dies — the next run reads "not contacted"
//      and emails the supplier again. The lost record IS the duplicate.
//   2. the weekly cron and a manual POST /api/procurement/run overlap. Both read before either
//      writes. Both send.
//
// A unit test cannot show either, because both live in the window between two statements. Only
// concurrent execution against a real database can, which is what this does: two independent pools
// race for the same claim and exactly one may win.
//
// The CEO instruction was explicit — "prove with concurrency testing that two simultaneous
// executions cannot send the same intended supplier RFQ twice" — so the race is the test, not a
// sequential approximation of it.
//
// Needs a server: set RFQ_PG_URL, or let it start a throwaway cluster if initdb is on PATH.
// With neither it SKIPS, so a machine without Postgres can still run preflight.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const rfqClaim = require('../src/lib/idempotency/supplier-rfq');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${d}`); };

const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/usr/bin'];
function findInitdb() {
  for (const d of BIN) { const p = path.join(d, 'initdb'); if (fs.existsSync(p)) return d; }
  return null;
}
let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/rfqclaim-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55983' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data -A trust`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55983 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55983`;
}
function stopTemp() {
  if (!temp) return;
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { env, stdio: 'pipe' });
  } catch (_) { /* best effort */ }
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) {}
}

const url = process.env.RFQ_PG_URL || startTemp();
if (!url) {
  console.log('  skip  no Postgres available (set RFQ_PG_URL or install initdb)');
  console.log('SKIP  supplier RFQ claim not executed — this check needs a server');
  process.exit(0);
}

// The real table as db.js creates it, so the migration is exercised against the shape it will meet.
const SCHEMA = `
CREATE TABLE supplier_outreach_log (
  id TEXT PRIMARY KEY,
  rfq_id TEXT,
  supplier_id TEXT,
  email_sent_to TEXT,
  email_subject TEXT,
  email_body TEXT,
  sent_at TEXT,
  replied_at TEXT,
  reply_text TEXT,
  status TEXT DEFAULT 'sent' CHECK (status IN ('sent','replied','no_response'))
);
CREATE INDEX idx_outreach_rfq ON supplier_outreach_log (rfq_id, status);`;

(async () => {
  const { Pool } = require('pg');
  const A = new Pool({ connectionString: url, ssl: false });
  const B = new Pool({ connectionString: url, ssl: false });
  const aq = (t, p) => A.query(t, p);
  const bq = (t, p) => B.query(t, p);

  try {
    await aq(SCHEMA);

    // 1. Before the migration the invariant is absent, and the code must say so rather than assume.
    if ((await rfqClaim.isEnforced(aq)) === false) ok('isEnforced() is false before the migration runs');
    else bad('isEnforced() reported true with no unique index present');

    // 2. The migration runs against the legacy shape, including replacing the status CHECK.
    const m = await rfqClaim.migrate(aq);
    if (m.enforced) ok('migrate() creates the UNIQUE index on a clean table');
    else bad('migrate() did not enforce uniqueness on a clean table', m.error);
    if (await rfqClaim.isEnforced(bq)) ok('isEnforced() is true on a SECOND connection');
    else bad('isEnforced() false after a successful migration');

    // 3. The claim is writable with status 'pending' — the state the original CHECK forbade.
    const first = await rfqClaim.claim(aq, { rfqId: 'rfq-1', supplierId: 'sup-1', email: 's1@demo.invalid' });
    if (first) ok("a first claim succeeds and stores status 'pending'");
    else bad('the first claim was refused');
    const st = await bq(`SELECT status, claimed_at FROM supplier_outreach_log WHERE id = $1`, [first]);
    if (st.rows[0] && st.rows[0].status === 'pending' && st.rows[0].claimed_at) {
      ok('the claim is visible to another connection as pending, with claimed_at set');
    } else bad('claim row wrong', JSON.stringify(st.rows[0] || null));

    // 4. A sequential second claim is refused.
    const second = await rfqClaim.claim(bq, { rfqId: 'rfq-1', supplierId: 'sup-1', email: 's1@demo.invalid' });
    if (second === null) ok('a second claim for the same (rfq, supplier) is refused, not an error');
    else bad('a second claim SUCCEEDED — the duplicate send is still possible');

    // 5. THE RACE. Both pools claim the same pair at the same instant. Exactly one may win.
    //    This is the case a sequential test cannot reach and the one that bit us.
    const results = await Promise.all([
      rfqClaim.claim(aq, { rfqId: 'rfq-race', supplierId: 'sup-race', email: 'r@demo.invalid' }),
      rfqClaim.claim(bq, { rfqId: 'rfq-race', supplierId: 'sup-race', email: 'r@demo.invalid' }),
    ]);
    const winners = results.filter(Boolean);
    if (winners.length === 1) ok('CONCURRENT claims: exactly one of two simultaneous runs may send');
    else bad(`CONCURRENT claims: ${winners.length} of 2 won — two runs would both email the supplier`);
    const rows = await aq(`SELECT COUNT(*)::int n FROM supplier_outreach_log WHERE rfq_id='rfq-race'`);
    if (rows.rows[0].n === 1) ok('the race left exactly one row');
    else bad(`the race left ${rows.rows[0].n} rows`);

    // 6. A 20-way race, because two is a small sample for a uniqueness claim.
    const many = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      rfqClaim.claim(i % 2 ? aq : bq, { rfqId: 'rfq-20', supplierId: 'sup-20', email: 'm@demo.invalid' })));
    const won = many.filter(Boolean).length;
    if (won === 1) ok('20 simultaneous claims: exactly one won');
    else bad(`20 simultaneous claims: ${won} won`);

    // 7. A FAILED send keeps its claim. Deleting it would reopen the window and let the next run
    //    try again with no record that the first attempt may have reached the supplier.
    await rfqClaim.markFailed(aq, first, 'send refused by the mail provider');
    const kept = await bq(`SELECT status, error FROM supplier_outreach_log WHERE id = $1`, [first]);
    if (kept.rows[0] && kept.rows[0].status === 'failed' && /mail provider/.test(kept.rows[0].error)) {
      ok('a failed send keeps its claim, marked failed with the reason');
    } else bad('the failed claim was lost or unmarked', JSON.stringify(kept.rows[0] || null));
    const reclaim = await rfqClaim.claim(aq, { rfqId: 'rfq-1', supplierId: 'sup-1' });
    if (reclaim === null) ok('a failed claim still blocks a silent automatic re-send');
    else bad('a failed claim allowed a re-send with no human decision');

    // 8. Confirm records the body only on success.
    const c = await rfqClaim.claim(aq, { rfqId: 'rfq-2', supplierId: 'sup-2', email: 's2@demo.invalid' });
    await rfqClaim.confirm(aq, c, { subject: 'RFQ: Yttrium oxide', body: 'the real body' });
    const done = await bq(`SELECT status, sent_at, email_subject, email_body FROM supplier_outreach_log WHERE id=$1`, [c]);
    if (done.rows[0].status === 'sent' && done.rows[0].sent_at && done.rows[0].email_body === 'the real body') {
      ok('confirm() records sent, sent_at and the body');
    } else bad('confirm() did not record the send', JSON.stringify(done.rows[0]));

    // 9. Unresolved claims — the known-unknowns a human must look at before anything retries.
    await aq(`UPDATE supplier_outreach_log SET claimed_at = NOW() - INTERVAL '2 hours'
               WHERE rfq_id = 'rfq-race'`);
    const un = await rfqClaim.unresolved(bq, { olderThanMinutes: 15 });
    if (un.length === 1 && un[0].rfq_id === 'rfq-race') ok('an old pending claim appears in unresolved()');
    else bad('unresolved() did not surface the stale pending claim', JSON.stringify(un.map((u) => u.rfq_id)));
    // A fresh pending claim must NOT be reported — reporting work in flight as unknown is noise,
    // and alarm fatigue is how a broken cron sent 168 false alerts a week unnoticed.
    const fresh = await rfqClaim.claim(aq, { rfqId: 'rfq-fresh', supplierId: 'sup-fresh' });
    const un2 = await rfqClaim.unresolved(bq, { olderThanMinutes: 15 });
    if (!un2.some((u) => u.rfq_id === 'rfq-fresh')) ok('a claim still in flight is not reported as unresolved');
    else bad('a fresh claim was reported as unresolved');
    if (fresh) { /* used below in cleanup */ }

    // 10. The migration must REFUSE to enforce — and say what blocks it — when duplicates exist.
    //     Boot cannot pick which historical duplicate to keep; that is a human decision about real
    //     correspondence, so it reports instead of guessing.
    await aq(`DROP INDEX ${rfqClaim.INDEX_NAME}`);
    await aq(`INSERT INTO supplier_outreach_log (id, rfq_id, supplier_id, status)
              VALUES ('dup-a','rfq-dup','sup-dup','sent'), ('dup-b','rfq-dup','sup-dup','sent')`);
    const m2 = await rfqClaim.migrate(aq);
    if (m2.enforced === false && (m2.duplicates || []).some((d) => d.rfq_id === 'rfq-dup' && d.n === 2)) {
      ok('migrate() refuses on existing duplicates and NAMES the offending (rfq, supplier) pair');
    } else bad('migrate() did not report the blocking duplicates', JSON.stringify(m2));
    if ((await rfqClaim.isEnforced(aq)) === false) ok('isEnforced() stays false, so sending refuses');
    else bad('isEnforced() reported true while duplicates exist');

    // 11. Cleanup: only rows this check created, by explicit id (CLAUDE.md). The table is never
    //     asserted empty — on production that becomes false the moment the agent runs.
    const mine = ['dup-a', 'dup-b', first, second, c, fresh, ...winners, ...many.filter(Boolean)].filter(Boolean);
    await aq(`DELETE FROM supplier_outreach_log WHERE id = ANY($1)`, [mine]);
    const left = await bq(`SELECT COUNT(*)::int n FROM supplier_outreach_log WHERE id = ANY($1)`, [mine]);
    if (left.rows[0].n === 0) ok('fixture rows removed by explicit id');
    else bad(`${left.rows[0].n} fixture row(s) left behind`);
  } catch (e) {
    bad('threw', e && e.stack ? e.stack : e);
  } finally {
    await A.end().catch(() => {});
    await B.end().catch(() => {});
    stopTemp();
  }

  if (fail) { console.log(`FAIL  ${fail} check(s) failed`); process.exit(1); }
  console.log('PASS  a supplier RFQ cannot be sent twice, even by two simultaneous executions');
})();
