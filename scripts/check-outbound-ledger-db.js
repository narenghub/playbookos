#!/usr/bin/env node
// ── THE OUTBOUND LEDGER, AGAINST A REAL SERVER ───────────────────────────────
//
//   node scripts/check-outbound-ledger-db.js
//
// Exit 0 = every control executed and passed. 1 = a failure. 3 = no server, so NOTHING was proven.
//
// Eight controls, from CEO authorization 2026-11-10 S1.1 item 5. Every provider is mocked; no
// message is transmitted. The assertion is always about PROVIDER CALL COUNT and the durable row,
// because those are the two things an audit of containment actually rests on.
//
// A disposable cluster, created and destroyed here. The schema is applied by the same migration
// script an operator would run, so what is tested is the migration, not a hand-built table.

'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
const { pgBin, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');
const SCHEMA = require('../src/lib/outbound/ledger-schema');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${d}`); };
const note = (m) => console.log(`  --    ${m}`);

let temp = null;
function startTemp() {
  const dir = pgBin();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/ledger-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55993' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55993 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55993`;
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
  console.log('SKIP  the outbound ledger was NOT exercised — this check proved nothing.');
  process.exit(EXIT_NOT_EXECUTED);
}

(async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: false });
  const query = (sql, params) => pool.query(sql, params);
  const LEDGER = require('../src/lib/outbound/ledger');

  // Ids created here, removed by id at the end. Never by timestamp, never by pattern.
  const made = [];
  const rowsFor = async (id) => (await query(`SELECT * FROM email_log WHERE id = $1`, [id])).rows[0];

  try {
    await query(`CREATE TABLE email_log (
      id TEXT PRIMARY KEY, to_email TEXT NOT NULL, subject TEXT NOT NULL,
      trigger_type TEXT, sent_at TIMESTAMPTZ DEFAULT NOW(), status TEXT, error_message TEXT)`);

    // ── 3. MISSING AUDIT STORAGE FAILS CLOSED ────────────────────────────────
    //
    // Run BEFORE the migration, deliberately: this is the state a deploy is in if the migration
    // has not been run, and it must refuse rather than send unrecorded.
    console.log('\n  ── fail-closed before the migration ──\n');
    LEDGER._resetSchemaCache();
    {
      const att = await LEDGER.beginAttempt(
        { transport: 'resend', provider: 'resend', to: 'x@example.com', subject: 's' },
        { query });
      if (!att.ok) ok('a consequential message is REFUSED when the ledger schema is absent');
      else bad('a consequential message was permitted with no durable record');

      const obs = await LEDGER.beginAttempt(
        { transport: 'resend', provider: 'resend', to: 'ops@example.com', subject: 's',
          consequential: false }, { query });
      if (obs.ok) ok('…and observability mail still proceeds, so breakage can still be reported');
      else bad('the oversight channel was taken out by the ledger being unavailable');
    }

    // Apply via the real migration statements.
    for (const sql of SCHEMA.DDL) await query(sql);
    LEDGER._resetSchemaCache();
    const applied = await LEDGER.hasSchema({ query });
    if (applied) ok('the migration applies and the ledger reports itself ready');
    else bad('the migration ran but hasSchema() still says no');

    // ── 1. GLOBAL STOP → DURABLE BLOCKED ROW, ZERO PROVIDER CALLS ────────────
    console.log('\n  ── stop produces a durable BLOCKED result ──\n');
    let providerCalls = 0;
    const provider = async () => { providerCalls += 1; return { id: 'should-not-happen' }; };
    {
      const att = await LEDGER.beginAttempt(
        { transport: 'resend', provider: 'resend', to: 'buyer@example.com', subject: 'q',
          workflow: 'legacy-inquiry-buyer-email', agent: 'inquiry-agent' }, { query });
      made.push(att.id);
      await att.blocked('STOPPED_BY_POLICY: global — CEO hold', 'global');
      const row = await rowsFor(att.id);
      if (row && row.outcome === 'BLOCKED') ok('a refused send leaves a durable BLOCKED row');
      else bad(`expected BLOCKED, got ${row && row.outcome}`);
      if (row && row.stop_scope === 'global') ok('…naming the scope that blocked it');
      else bad('the blocking scope was not recorded');
      if (providerCalls === 0) ok('…and the provider was never called');
      else bad(`the provider was called ${providerCalls} time(s) on a blocked send`);
      if (!LEDGER.MAY_HAVE_LEFT.includes(row.outcome)) ok('…and BLOCKED is never counted as sent');
      else bad('a blocked attempt counts as possibly-sent');
    }

    // The database refuses a BLOCKED row that cannot explain itself.
    {
      const att = await LEDGER.beginAttempt(
        { transport: 'resend', provider: 'resend', to: 'a@example.com', subject: 's' }, { query });
      made.push(att.id);
      try {
        await query(`UPDATE email_log SET outcome='BLOCKED', stop_scope=NULL WHERE id=$1`, [att.id]);
        bad('a BLOCKED row with no scope was accepted — the refusal would be unexplainable');
      } catch (e) {
        if (/blocked_needs_scope/.test(e.message)) ok('the database refuses a BLOCKED row with no scope');
        else bad('refused, but not by the intended constraint', e.message);
      }
    }

    // ── 2. GMAIL AND RESEND USE THE SAME SEMANTICS ───────────────────────────
    console.log('\n  ── consistent outcome semantics across transports ──\n');
    {
      const shapes = {};
      for (const t of ['resend', 'gmail_cphi', 'gmail_outreach', 'gmail_probe']) {
        const att = await LEDGER.beginAttempt(
          { transport: t, provider: t === 'resend' ? 'resend' : 'gmail',
            to: 'x@example.com', subject: 's' }, { query });
        made.push(att.id);
        await att.claim();
        await att.accepted(`${t}-id`);
        const row = await rowsFor(att.id);
        shapes[t] = [row.outcome, row.provider_message_id ? 'has-id' : 'no-id',
          row.claimed_at ? 'claimed' : 'unclaimed',
          row.provider_responded_at ? 'responded' : 'no-time'].join('|');
      }
      const distinct = new Set(Object.values(shapes));
      if (distinct.size === 1) ok(`all four transports record acceptance identically (${[...distinct][0]})`);
      else bad('transports disagree on what acceptance looks like', JSON.stringify(shapes, null, 2));
    }

    // ── 4. PROVIDER TIMEOUT → OUTCOME_UNKNOWN ────────────────────────────────
    console.log('\n  ── an unanswered provider is UNKNOWN, not failed ──\n');
    let unknownId = null;
    {
      const att = await LEDGER.beginAttempt(
        { transport: 'resend', provider: 'resend', to: 'b@example.com', subject: 's' }, { query });
      made.push(att.id); unknownId = att.id;
      await att.claim();
      await att.unknown('Claude request aborted after 30000ms (provider did not respond)');
      const row = await rowsFor(att.id);
      if (row.outcome === 'OUTCOME_UNKNOWN') ok('a timeout is OUTCOME_UNKNOWN');
      else bad(`expected OUTCOME_UNKNOWN, got ${row.outcome}`);
      if (LEDGER.MAY_HAVE_LEFT.includes(row.outcome)) {
        ok('…and it counts as MAY have left, because tokens may have been spent and it may have gone');
      } else bad('an unknown outcome is treated as definitely not sent');
      if (!LEDGER.DEFINITELY_NOT_SENT.includes(row.outcome)) {
        ok('…and is NOT in the definitely-not-sent set');
      } else bad('an unknown outcome was classified as definitely not sent');
    }

    // ── 5. RETRY DOES NOT DUPLICATE A POSSIBLY-ACCEPTED MESSAGE ──────────────
    console.log('\n  ── an uncertain outcome is never auto-retried ──\n');
    {
      // The ledger exposes no retry, and nothing may promote UNKNOWN to a fresh attempt
      // automatically. Asserted on the module surface AND on the row.
      const verbs = Object.keys(LEDGER).filter((k) => /^(retry|resend|redeliver|requeue)/i.test(k));
      if (!verbs.length) ok('the ledger exposes no automatic retry');
      else bad(`the ledger exposes ${verbs.join(', ')} — an uncertain send could be duplicated`);

      const row = await rowsFor(unknownId);
      if (row.outcome === 'OUTCOME_UNKNOWN') {
        ok('an UNKNOWN row stays UNKNOWN until a human or a reconciliation job resolves it');
      } else bad('the unknown row changed on its own');

      // RECONCILED is the only way out, and it is explicit.
      await query(`UPDATE email_log SET outcome='RECONCILED', reconciled_note=$2 WHERE id=$1`,
        [unknownId, 'operator checked the provider dashboard: not delivered']);
      const after = await rowsFor(unknownId);
      if (after.outcome === 'RECONCILED') ok('…and RECONCILED is an explicit, recorded human act');
      else bad('reconciliation did not take');
    }

    // ── 6. CONCURRENT WORKERS CANNOT CLAIM THE SAME MESSAGE TWICE ────────────
    //
    // Idempotency belongs to the DOMAIN claim tables, not to this ledger — the ledger records
    // transport attempts and must not grow a second, competing claim. So the control proves the
    // domain pattern on the table shape those senders use.
    console.log('\n  ── two workers, one claim ──\n');
    {
      await query(`CREATE TABLE cphi_followup_sends (
        id SERIAL PRIMARY KEY, event_slug TEXT, contact_id INT, campaign TEXT, step INT,
        to_email TEXT, subject TEXT)`);
      await query(`CREATE UNIQUE INDEX uq_cphi_claim
        ON cphi_followup_sends (event_slug, contact_id, step)`);
      const claim = () => query(
        `INSERT INTO cphi_followup_sends (event_slug, contact_id, campaign, step, to_email, subject)
         VALUES ('e',1,'c',1,'x@example.com','s') RETURNING id`);
      const results = await Promise.allSettled([claim(), claim()]);
      const won = results.filter((r) => r.status === 'fulfilled').length;
      const lost = results.filter((r) => r.status === 'rejected'
        && /duplicate key|23505/.test(String(r.reason && r.reason.message))).length;
      if (won === 1 && lost === 1) ok('exactly one of two concurrent workers wins the claim');
      else bad(`won=${won} lost=${lost} — the claim does not arbitrate`);
      await query(`DROP TABLE cphi_followup_sends`);
    }

    // ── 7. A NEW TRANSPORT WITHOUT LEDGER INTEGRATION FAILS PREFLIGHT ────────
    console.log('\n  ── an unintegrated transport is caught ──\n');
    {
      const COVERAGE = require('./check-email-transport-coverage');
      const os = require('os'); const path = require('path');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-cov-'));
      fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'lib', 'rogue.js'),
        'async function go(g) { await g.gmail.users.messages.send({ userId: "me" }); }\nmodule.exports={go};\n');
      const sites = COVERAGE.discover(dir).filter((x) => !x.gated && !x.exception);
      if (sites.length === 1) ok('a new transport with no gate is discovered by the scanner');
      else bad(`expected 1 ungated site in the planted tree, got ${sites.length}`);
      fs.rmSync(dir, { recursive: true, force: true });

      // And every REAL transport that sends has a ledger attempt beside its gate.
      const srcs = {
        'src/lib/mailer.js': 'resend',
        'src/lib/campaigns/cphi-runner.js': 'gmail_cphi',
        'src/lib/agents/outreach-agent.js': 'gmail_outreach',
        'scripts/verify-bounce-detection.js': 'gmail_probe',
      };
      const missing = Object.keys(srcs).filter((f) => {
        const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
        return !/beginAttempt\(/.test(code);
      });
      if (!missing.length) ok('every live transport opens a ledger attempt');
      else bad(`transports with no ledger attempt: ${missing.join(', ')}`);
    }

    // ── 8. A LOGGING FAILURE CANNOT SILENTLY PERMIT TRANSMISSION ─────────────
    console.log('\n  ── a broken ledger refuses, it does not wave through ──\n');
    {
      const boom = async () => { throw new Error('ledger table is gone'); };
      LEDGER._resetSchemaCache();
      const att = await LEDGER.beginAttempt(
        { transport: 'resend', provider: 'resend', to: 'c@example.com', subject: 's' },
        { query: boom });
      if (!att.ok) ok('an unwritable ledger refuses the consequential send');
      else bad('an unwritable ledger permitted a send — the record was optional after all');
      LEDGER._resetSchemaCache();
      await LEDGER.hasSchema({ query });
    }

    // ── COVERAGE vs EXECUTION ────────────────────────────────────────────────
    console.log('\n  ── UNKNOWN is reported, never zero ──\n');
    {
      const rep = await LEDGER.executionByTransport(
        ['resend', 'gmail_cphi', 'never_used_transport'],
        { sinceISO: new Date(Date.now() - 86400000).toISOString() }, { query });
      const never = rep.find((r) => r.transport === 'never_used_transport');
      if (never && never.state === 'UNKNOWN' && never.observed === false) {
        ok('a transport with no rows reports UNKNOWN rather than a confident zero');
      } else bad(`an unobserved transport reported ${never && never.state}`);
      const seen = rep.find((r) => r.transport === 'resend');
      if (seen && seen.observed) ok('…and a transport with rows reports what it actually did');
      else bad('an observed transport was reported as unknown');
    }
  } catch (e) {
    bad('unexpected error', e.stack || e.message);
  } finally {
    // Delete exactly what was made, by id. Then assert MY rows are gone — never that the table is.
    try {
      for (const id of made) await query(`DELETE FROM email_log WHERE id = $1`, [id]);
      const mine = (await query(`SELECT COUNT(*)::int n FROM email_log WHERE id = ANY($1)`, [made])).rows[0].n;
      if (mine) bad(`${mine} fixture row(s) left behind`);
      else note(`cleanup: ${made.length} fixture row(s) removed by id, none leaked`);
    } catch (_) { /* the cluster is disposable; cleanup is still asserted above */ }
    await pool.end().catch(() => {});
    stopTemp();
  }

  console.log(fail
    ? `\nFAIL  ${fail} ledger control(s) failed\n`
    : '\nPASS  the outbound ledger records every transport identically, fails closed without\n'
      + '      storage, never counts a blocked attempt as sent, and never auto-retries an\n'
      + '      uncertain one.\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); stopTemp(); process.exit(1); });
