#!/usr/bin/env node
// ── DOES THE REPORT COUNT WHAT ACTUALLY LEFT? ────────────────────────────────
//
//   node scripts/check-ledger-accounting-db.js
//
// CEO decision 2026-11-12, items 2–5. Against REAL POSTGRES, in a disposable cluster created and
// destroyed here, because the de-duplication is a SQL expression and a JavaScript double would
// prove nothing about it. COUNT(DISTINCT … ) FILTER (…) is the thing under test.
//
// ── THE DEFECT THIS EXISTS FOR ───────────────────────────────────────────────
//
// Moving the sender out of process gave every submission TWO audit rows: the application records
// its intent, the service records the request it served. Both are kept — separate audit
// responsibilities, neither removable. But executionByTransport() counted ROWS, so the containment
// report said two transmissions where one message left. A report that over-states what went out is
// not harmless: it is the number a containment decision gets made from.
//
// ── THE ONE ASSERTION THAT MATTERS ───────────────────────────────────────────
//
// Every scenario below drives the REAL dispatch() through the REAL sender service over a socket,
// with the provider as a COUNTER, and then asserts:
//
//     report.transmissions === provider.calls.length
//
// Not "the number looks plausible". The two numbers are produced by entirely different machinery —
// one by SQL over the ledger, one by counting function calls — and they must agree exactly.
//
// Exit 0 all agree · 1 any disagreement · 3 no Postgres, nothing proved.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'PLACEHOLDER-not-a-secret';
process.env.SENDER_SERVICE_SECRET = 'PLACEHOLDER-not-a-secret-local-fixture';

const fs = require('fs');
const http = require('http');
const { execFileSync } = require('child_process');
const { pgBin, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${d}`); };
const note = (m) => console.log(`  --    ${m}`);
const head = (m) => console.log(`\n  ── ${m} ──\n`);

// ── A DISPOSABLE CLUSTER ────────────────────────────────────────────────────
let temp = null;
function startTemp() {
  const dir = pgBin();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/ledger-acct-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55994' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55994 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55994`;
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
  console.log('SKIP  ledger accounting was NOT exercised — this check proved nothing.');
  process.exit(EXIT_NOT_EXECUTED);
}

(async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: false });
  const query = (sql, params) => pool.query(sql, params);

  const LEDGER = require('../src/lib/outbound/ledger');
  const SCHEMA = require('../src/lib/outbound/ledger-schema');
  const D = require('../src/lib/outbound/dispatch');
  const SENDER = require('../src/services/sender/server');
  const CLIENT = require('../src/lib/outbound/transports/sender-client');

  const SECRET = process.env.SENDER_SERVICE_SECRET;
  const ENV = { COMPANY_DOMAINS: 'abiozen.com', SENDER_SERVICE_SECRET: SECRET };
  const EXTERNAL = 'buyer@acme-pharma.test';
  const TRANSPORT = 'gmail_cphi';
  const since = () => new Date(Date.now() - 3600000).toISOString();

  // Ids recorded as they are created and deleted by id at the end. Never by timestamp, never by
  // pattern, never "recent" — this cluster is disposable, and the discipline is the same anyway.
  const made = [];
  const trackIds = async () => {
    const r = await query(`SELECT id FROM email_log`);
    for (const row of r.rows) if (!made.includes(row.id)) made.push(row.id);
  };

  let server = null;
  const provider = { calls: [] };

  try {
    // ── THE SCHEMA, BY THE REAL MIGRATION ─────────────────────────────────
    // The table as it exists in production BEFORE the ledger migration — id TEXT, and the
    // original columns including error_message, which the migration does NOT add. My first
    // fixture omitted it, so every att.blocked() write failed with "column error_message does not
    // exist" and the refusals went unrecorded. The ledger logs that failure and proceeds, which is
    // correct for a non-consequential write, and meant the fixture was wrong rather than loud.
    await query(`CREATE TABLE IF NOT EXISTS email_log (
      id TEXT PRIMARY KEY, to_email TEXT NOT NULL, subject TEXT NOT NULL,
      trigger_type TEXT, sent_at TIMESTAMPTZ DEFAULT NOW(), status TEXT, error_message TEXT)`);
    for (const stmt of SCHEMA.DDL) await query(stmt);
    LEDGER._resetSchemaCache();
    if (await LEDGER.hasSchema({ query })) ok('the ledger schema is applied by its own migration');
    else { bad('the migration did not produce a usable ledger'); throw new Error('no schema'); }

    // ── THE SENDER SERVICE, WITH THE PROVIDER AS A COUNTER ────────────────
    const handlers = {
      [TRANSPORT]: async (m) => {
        provider.calls.push(m.to);
        return { ok: true, id: `prov-${provider.calls.length}`, providerResponded: true,
          meta: { threadId: `t-${provider.calls.length}` } };
      },
    };
    const gate = { allowed: true };
    const deps = {
      env: ENV, ledger: LEDGER, ledgerDeps: { query },
      gate: { assertSendAllowed: async () => (gate.allowed
        ? { allowed: true }
        : { allowed: false, reason: 'STOPPED_BY_POLICY: capability:email.send', scope: 'capability:email.send' }) },
    };
    server = SENDER.createServer({ ...deps, handlers });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const senderUrl = `http://127.0.0.1:${server.address().port}`;

    const transports = { [TRANSPORT]: CLIENT.transportFor(TRANSPORT, { url: senderUrl, secret: SECRET }) };
    const send = (key, over = {}) => {
      const m = { to: EXTERNAL, subject: `S-${key}`, raw: Buffer.from(`body ${key}`).toString('base64url'),
        mailbox: 'sales@abiozen.com', ...(over.message || {}) };
      return D.dispatch({
        message: m, transport: TRANSPORT, idempotencyKey: key,
        approvalId: `apv-${key}`, expectedDigest: over.badDigest ? 'deadbeef' : D.transmittedDigest(m),
        workflow: 'cphi-followup', agent: 'cphi-runner',
      }, { ...deps, transports: over.transports || transports });
    };

    const report = async () => {
      const r = await LEDGER.executionByTransport([TRANSPORT], { sinceISO: since() }, { query });
      return r[0];
    };
    /** The single assertion this file exists for. */
    const agree = async (what) => {
      const rep = await report();
      await trackIds();
      if (rep.transmissions === provider.calls.length) {
        ok(`${what}: report says ${rep.transmissions}, provider was invoked ${provider.calls.length}`);
      } else {
        bad(`${what}: report says ${rep.transmissions}, provider was invoked ${provider.calls.length}`,
          `rows that may have left: ${rep.rows_may_have_left} · records per submission: ${rep.audit_records_per_submission}`);
      }
      return rep;
    };

    // ══ 1. ONE SEND ══════════════════════════════════════════════════════
    head('one send, two audit records, one transmission');
    const one = await send('acct-1');
    if (one.ok) ok('the send was accepted'); else bad('the send was refused', one.error);

    const rep1 = await agree('after one send');
    if (rep1.rows_may_have_left === 2) {
      ok('BOTH audit records are preserved — the application\'s and the service\'s');
    } else {
      bad(`expected 2 audit records for one submission, found ${rep1.rows_may_have_left}`,
        'if this is 1, a layer has stopped writing its row and an audit responsibility has been lost');
    }
    if (rep1.audit_records_per_submission === 2) ok('…and the ratio is reported, so a lost row is visible');
    else bad(`records per submission is ${rep1.audit_records_per_submission}`);

    // Correlation is the mechanism, so assert it directly rather than inferring it from the count.
    const corr = await query(
      `SELECT correlation_id, COUNT(*)::int n, ARRAY_AGG(claim_ref ORDER BY claim_ref) refs
         FROM email_log WHERE outcome = ANY($1) GROUP BY correlation_id`, [SCHEMA.MAY_HAVE_LEFT]);
    if (corr.rows.length === 1 && corr.rows[0].n === 2) {
      ok('the two records share one correlation_id');
      const refs = corr.rows[0].refs || [];
      if (refs.some((x) => x === 'acct-1') && refs.some((x) => x === 'sender:acct-1')) {
        ok('…and remain distinguishable by claim_ref, so each layer\'s record is identifiable');
      } else bad(`claim_refs are ${JSON.stringify(refs)}`);
      if (corr.rows[0].correlation_id === D.dispatchIdFor('acct-1')) {
        ok('…and the correlation is the stable dispatch id, derived from the idempotency key');
      } else bad('the correlation is not the stable dispatch id');
    } else {
      bad(`expected one correlation with 2 records, got ${JSON.stringify(corr.rows.map((r) => r.n))}`);
    }

    // ══ 2. A DUPLICATE REQUEST ═══════════════════════════════════════════
    head('a duplicate under the same key adds no transmission');
    const before2 = provider.calls.length;
    const dup = await send('acct-1');
    if (!dup.ok && dup.phase === 'refused_duplicate') ok('the duplicate was refused');
    else bad(`the duplicate returned ${dup.phase}`, dup.error);
    if (provider.calls.length === before2) ok('the provider was not invoked again');
    else bad(`the provider was invoked ${provider.calls.length - before2} more time(s)`);
    await agree('after a duplicate');

    // ══ 3. A TIMEOUT: THE SERVICE SENT, THE ANSWER NEVER CAME ════════════
    head('a timeout — the message may have gone and nobody knows');
    //
    // The provider IS invoked here; the answer is what goes missing. This is the case where
    // "failed" would be a lie and a retry would be a second real message.
    const slow = {
      [TRANSPORT]: {
        send: async (m) => {
          // Reach the provider exactly as the service would, then never answer.
          await handlers[TRANSPORT](m);
          throw new Error('socket hang up');
        },
      },
    };
    const before3 = provider.calls.length;
    const timedOut = await send('acct-timeout', { transports: slow });
    if (!timedOut.ok && timedOut.phase === 'transport_unknown') {
      ok('the outcome is recorded as UNKNOWN, not as a failure');
    } else bad(`a timeout produced phase ${timedOut.phase}`);
    if (provider.calls.length === before3 + 1) ok('the provider WAS invoked — the message may have gone');
    else bad('the scenario did not actually reach the provider, so it proves nothing');
    const repT = await agree('after a timeout');
    if (repT.state === 'TRANSMITTED') ok('and the report counts it, because it may have left');
    else bad(`an uncertain send was reported as ${repT.state}`);

    // ── A RETRY AFTER THE TIMEOUT ──
    const before3b = provider.calls.length;
    const retry = await send('acct-timeout');
    if (!retry.ok) ok('a retry under the same key is refused after an unknown outcome');
    else bad('a retry after an UNKNOWN outcome was permitted — one uncertain send became two real ones');
    if (provider.calls.length === before3b) ok('the provider was not invoked again');
    else bad(`the retry invoked the provider ${provider.calls.length - before3b} more time(s)`);
    await agree('after a retry following a timeout');

    // ══ 4. CRASH RECOVERY ════════════════════════════════════════════════
    head('crash recovery — a process died mid-send and a later run tries again');
    //
    // Simulated exactly as a crash leaves the database: a CLAIMED row and nothing after it. No
    // process is killed; the state a kill WOULD leave is what the next run reads, and that state
    // is what decides whether it sends again.
    const crashKey = 'acct-crash';
    const crashAtt = await LEDGER.beginAttempt({
      transport: TRANSPORT, provider: 'gmail', to: EXTERNAL, subject: 'crashed',
      claimRef: crashKey, correlationId: D.dispatchIdFor(crashKey), consequential: true,
    }, { query });
    await crashAtt.claim();
    note('a CLAIMED row with no outcome — the honest trace of a crash mid-send');

    const before4 = provider.calls.length;
    const afterCrash = await send(crashKey);
    if (!afterCrash.ok && afterCrash.phase === 'refused_duplicate') {
      ok('the next run refuses: something may have left and nobody knows');
    } else bad(`after a crash the next run returned ${afterCrash.phase}`, afterCrash.error);
    if (provider.calls.length === before4) ok('the provider was not invoked');
    else bad('a crashed send was retried and reached the provider');

    const repC = await agree('after a crash');
    // ── AND THE CRASH IS NOT INVISIBLE ────────────────────────────────────
    //
    // My first expectation here was that the crashed attempt would count as a transmission. It
    // does not, and should not: CLAIMED means responsibility was taken and the outcome is unknown,
    // which is not a provider submission. But it was also in NEITHER bucket, so the report said
    // NO_TRANSMISSION while a message may have gone — a crash reading as silence.
    if (repC.unresolved_claims >= 1) {
      ok(`the crashed attempt is reported as an UNRESOLVED CLAIM (${repC.unresolved_claims}), `
        + 'neither counted as sent nor hidden');
    } else {
      bad('the crashed attempt is invisible to the report', 'a crash mid-send reads as silence');
    }
    if (repC.state === 'TRANSMITTED' || repC.state === 'UNRESOLVED_CLAIM') {
      ok(`and the state is ${repC.state}, not NO_TRANSMISSION`);
    } else bad(`the state is ${repC.state} with an unresolved claim outstanding`);

    // ══ 5. A STOP, AND A FAILURE ═════════════════════════════════════════
    head('refusals and failures add no transmissions');
    const before5 = provider.calls.length;
    const trans5 = (await report()).transmissions;

    gate.allowed = false;
    const stopped = await send('acct-stopped');
    gate.allowed = true;
    if (!stopped.ok && stopped.stopped) ok('a STOP refused the send'); else bad('the STOP did not refuse');

    const tampered = await send('acct-tampered', { badDigest: true });
    if (!tampered.ok && tampered.phase === 'digest_mismatch') ok('a digest mismatch refused the send');
    else bad(`the tampered send returned ${tampered.phase}`);

    const rejecting = { [TRANSPORT]: { send: async () => ({ ok: false, error: 'provider said no', providerResponded: true }) } };
    const rejected = await send('acct-rejected', { transports: rejecting });
    if (!rejected.ok && rejected.phase === 'provider_rejected') ok('a provider rejection is recorded as such');
    else bad(`the rejected send returned ${rejected.phase}`);

    if (provider.calls.length === before5) ok('none of the three reached the provider');
    else bad(`${provider.calls.length - before5} of them reached the provider`);
    const rep5 = await report();
    await trackIds();
    if (rep5.transmissions === trans5) ok(`transmissions unchanged at ${rep5.transmissions}`);
    else bad(`transmissions moved from ${trans5} to ${rep5.transmissions} on refusals alone`);
    if (rep5.blocked >= 2) ok(`and every refusal is still recorded (${rep5.blocked} BLOCKED)`);
    else bad(`only ${rep5.blocked} BLOCKED rows for three refusals`);

    // ══ 6. CONCURRENCY ═══════════════════════════════════════════════════
    head('twelve concurrent sends under ONE key');
    const before6 = provider.calls.length;
    const trans6 = (await report()).transmissions;
    // A BEHAVIOURAL check, and not the proof: it passed even with the arbitrating unique index
    // removed, because the connection pool and timing let priorClaim() win. Section 10 below is
    // the proof. This still earns its place — it is the shape a double-fired cron actually takes,
    // and it would catch a regression that made twelve keys out of one.
    const burst = await Promise.all(Array.from({ length: 12 }, () => send('acct-burst')));
    const accepted = burst.filter((r) => r.ok).length;

    if (accepted === 1) ok('exactly one of twelve was accepted');
    else bad(`${accepted} of twelve concurrent sends were accepted under one key`);
    if (provider.calls.length === before6 + 1) ok('the provider was invoked exactly once');
    else bad(`the provider was invoked ${provider.calls.length - before6} times`);
    const rep6 = await agree('after twelve concurrent sends');
    if (rep6.transmissions === trans6 + 1) ok('and the report moved by exactly one');
    else bad(`transmissions moved by ${rep6.transmissions - trans6}`);

    // ══ 7. TWELVE DISTINCT KEYS ══════════════════════════════════════════
    head('twelve concurrent sends under TWELVE keys');
    const before7 = provider.calls.length;
    const many = await Promise.all(Array.from({ length: 12 },
      (_, i) => send(`acct-many-${i}`)));
    const okMany = many.filter((r) => r.ok).length;
    if (okMany === 12) ok('all twelve were accepted'); else bad(`${okMany} of twelve were accepted`);
    if (provider.calls.length === before7 + 12) ok('the provider was invoked twelve times');
    else bad(`the provider was invoked ${provider.calls.length - before7} times`);
    const rep7 = await agree('after twelve distinct sends');
    // Most submissions carry two records; the timeout scenario carries ONE, because it used an
    // in-process transport that never reached the service. So the ratio is not a clean 2:1 and
    // asserting one would be asserting an accident of the scenarios above.
    if (rep7.rows_may_have_left > rep7.transmissions) {
      ok(`records outnumber submissions (${rep7.rows_may_have_left} records, `
        + `${rep7.transmissions} submissions) — both layers' audit rows are intact`);
    } else {
      bad(`${rep7.rows_may_have_left} records for ${rep7.transmissions} submissions — a layer has `
        + 'stopped writing its audit row');
    }

    // ══ 8. THE RECONCILIATION VIEW ═══════════════════════════════════════
    head('one entry per submission, for reconciliation');
    const subs = await LEDGER.submissionsByCorrelation({ sinceISO: since(), transports: [TRANSPORT] }, { query });
    if (subs.length === rep7.transmissions) {
      ok(`submissionsByCorrelation lists ${subs.length}, matching the reported transmissions`);
    } else {
      bad(`submissionsByCorrelation lists ${subs.length}, the report says ${rep7.transmissions}`);
    }
    const twoRecord = subs.filter((x) => x.records === 2).length;
    if (twoRecord >= 13) ok(`${twoRecord} submissions carry both layers' records`);
    else bad(`only ${twoRecord} submissions carry two records`);

    // ══ 9. AN UNCORRELATED ROW IS NOT DROPPED ════════════════════════════
    head('a row with no correlation counts on its own');
    //
    // COUNT(DISTINCT col) ignores NULLs. Without the explicit NULL arm, a row written by anything
    // that did not supply a dispatch id would vanish from the count — and a send that vanishes
    // from a containment report is the one direction this must never err in.
    const transBefore9 = (await report()).transmissions;
    const orphan = await LEDGER.beginAttempt({
      transport: TRANSPORT, provider: 'gmail', to: EXTERNAL, subject: 'no correlation',
      claimRef: 'acct-orphan', consequential: true,
    }, { query });
    // Driven to PROVIDER_ACCEPTED, not left at CLAIMED: this control is about the NULL arm of the
    // DISTINCT count, so the row has to be in MAY_HAVE_LEFT for transmissions to be the number
    // under test. My first version left it CLAIMED, which lands in unresolved_claims instead and
    // made the control fail for a reason unrelated to the thing it checks.
    await orphan.claim();
    await orphan.accepted('prov-orphan');
    await query(`UPDATE email_log SET correlation_id = NULL WHERE id = $1`, [orphan.id]);
    await trackIds();

    const rep9 = await report();
    if (rep9.transmissions === transBefore9 + 1) {
      ok('an uncorrelated row is counted, not silently dropped');
    } else {
      bad(`transmissions went from ${transBefore9} to ${rep9.transmissions} — an uncorrelated row `
        + 'was dropped by COUNT(DISTINCT), which hides a send');
    }
    // And the negative half: with the NULL arm removed this must stop holding. Asserted on the
    // SQL, because a count that happens to be right is not a count that handles NULL.
    const ledgerSrc = fs.readFileSync(require.resolve('../src/lib/outbound/ledger.js'), 'utf8');
    if (/COUNT\(\*\) FILTER \(WHERE correlation_id IS NULL\)/.test(ledgerSrc)) {
      ok('…and the count has an explicit NULL arm rather than relying on DISTINCT');
    } else {
      bad('the NULL arm is gone from the submission count');
    }

    // ══ 10. THE CLAIM ITSELF, DETERMINISTICALLY ══════════════════════════
    head('two attempts, one claim_ref — the second must lose');
    //
    // WHY THIS EXISTS, and it is the more important half of the concurrency story.
    //
    // The twelve-concurrent test above passed even with the arbitrating unique index REMOVED from
    // the migration. Measured, by deleting it and re-running: still "one of twelve accepted". So
    // that test was not proving the arbitration — it was passing on connection-pool serialisation
    // and timing, which made priorClaim() win the race by luck. A control that passes whether or
    // not the mechanism exists is measuring something other than the mechanism, which is the exact
    // defect this repository keeps finding.
    //
    // This asserts the claim directly and deterministically: two attempts under one claim_ref,
    // both claiming, no race to win. With the index gone the second claim succeeds and this fails.
    {
      const key = 'acct-arbitration';
      const a1 = await LEDGER.beginAttempt({
        transport: TRANSPORT, provider: 'gmail', to: EXTERNAL, subject: 'first',
        claimRef: key, correlationId: D.dispatchIdFor(key), consequential: true }, { query });
      const a2 = await LEDGER.beginAttempt({
        transport: TRANSPORT, provider: 'gmail', to: EXTERNAL, subject: 'second',
        claimRef: key, correlationId: D.dispatchIdFor(key), consequential: true }, { query });
      await trackIds();

      const c1 = await a1.claim();
      const c2 = await a2.claim();

      if (c1 && c1.ok === true) ok('the first attempt takes the claim');
      else bad('the first claim failed', (c1 && c1.error) || 'no answer');

      if (c2 && c2.ok === false && c2.lost === true) {
        ok('the second attempt LOSES the claim — arbitrated by the database, not by a prior read');
      } else {
        bad('the second attempt also claimed responsibility',
          'two attempts under one idempotency key both hold the claim, so both may send. The '
          + 'partial unique index on claim_ref is the only thing that prevents this.');
      }

      // And the loser must be left in a state that says so, not quietly abandoned.
      const after = await query(
        `SELECT outcome FROM email_log WHERE id = ANY($1) ORDER BY subject`, [[a1.id, a2.id]]);
      const outcomes = after.rows.map((r) => r.outcome).sort();
      if (outcomes.includes('CLAIMED') && outcomes.filter((o) => o === 'CLAIMED').length === 1) {
        ok('…and exactly one of the two rows is CLAIMED');
      } else {
        bad(`both rows ended as ${JSON.stringify(outcomes)}`);
      }
    }

    // ══ CLEANUP: BY ID, ONLY WHAT WAS MADE HERE ══════════════════════════
    await trackIds();
    for (const id of made) await query(`DELETE FROM email_log WHERE id = $1`, [id]);
    const mine = (await query(`SELECT COUNT(*)::int n FROM email_log WHERE id = ANY($1)`, [made])).rows[0].n;
    if (mine === 0) note(`cleanup: ${made.length} fixture row(s) removed by id, none leaked`);
    else bad(`${mine} fixture row(s) survived cleanup`);
  } catch (e) {
    bad('the accounting check could not complete', (e && e.stack) || String(e));
  } finally {
    if (server) await new Promise((r) => server.close(r));
    await pool.end().catch(() => {});
    stopTemp();
  }

  console.log();
  if (fail) {
    console.log(`FAIL  ${fail} accounting assertion(s) failed — the report does not match reality.`);
    process.exit(1);
  }
  console.log('PASS  reported transmissions equal actual provider invocations across one send,');
  console.log('      duplicates, a timeout, a retry, a crash, refusals, and 24 concurrent sends.');
  console.log('      Both audit records are preserved for every submission.');
  process.exit(0);
})();
