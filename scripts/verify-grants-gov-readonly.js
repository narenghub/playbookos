#!/usr/bin/env node
// ── GRANTS.GOV, END TO END, READ-ONLY ───────────────────────────────────────
//
//   node scripts/verify-grants-gov-readonly.js
//   node scripts/verify-grants-gov-readonly.js --keyword="custom chemical synthesis" --rows=10
//
// PR-4. Live API → adapter → disposable PostgreSQL. Read-only with respect to Grants.gov (it is a
// public search endpoint needing no authentication) and with respect to everything of ours: the
// only database it writes to is a throwaway cluster it starts and destroys.
//
// ── WHAT THIS PROVES THAT THE UNIT TESTS CANNOT ─────────────────────────────
//
// grants-gov.test.js runs against fixtures I captured. It proves the adapter handles the payloads
// I SAW. It cannot prove the adapter handles what the API sends TODAY, across records I did not
// pick, and it cannot prove the §15 acceptance criterion at all:
//
//     "No duplicate opportunities after repeated synchronization."
//
// That is not a statement about one row. It is a statement about running the whole sync twice, and
// the only way to establish it is to run the whole sync twice. So this does, against live data,
// and compares the row counts.
//
// ── THE TWO THINGS MOST LIKELY TO BE WRONG IN PRODUCTION ────────────────────
//
// A field I never saw. Every normalised record is checked for a null in a column the adapter
// claims to populate, and the rate is reported rather than averaged away. A connector that writes
// NULL into every column reports success — that is the failure mode this repo keeps finding.
//
// A forecast presented as live. Measured on real records, not fixtures: every row's application_open flag
// is read back FROM THE DATABASE, where it is computed, and cross-checked against the standing the
// adapter assigned. If those two ever disagree, one of them is lying to a dashboard.
'use strict';

const { pgBin, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const fs = require('fs');
const { execFileSync } = require('child_process');
const { migrateConnectors } = require('../src/lib/connectors/schema');
const gg = require('../src/lib/connectors/grants-gov');
const sync = require('../src/lib/connectors/sync-run');

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
// The three things Abiozen actually sells. Two keywords, not ten: there is no published rate limit
// and courteous pacing is the stated etiquette.
const KEYWORDS = (arg('keyword', 'active pharmaceutical ingredient|analytical reference standard')).split('|');
const ROWS = Math.max(1, Math.min(50, parseInt(arg('rows', '15'), 10) || 15));
const DETAILS = Math.max(0, Math.min(10, parseInt(arg('details', '3'), 10) || 3));

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 500)}`); };
const note = (m) => console.log(`        ${m}`);

let temp = null;
function startTemp() {
  const dir = pgBin();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/ggverify-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55994' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd], { env, stdio: 'pipe' });
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

// Same refusal as the schema harness. The authorization is for a disposable database.
const envUrl = process.env.CONN_PG_URL;
if (envUrl) {
  for (const re of [/railway/i, /rlwy\.net/i, /amazonaws/i, /\.render\.com/i, /supabase/i, /neon\.tech/i, /prod/i]) {
    if (re.test(envUrl)) {
      console.log('  FAIL  refusing to run against what looks like a hosted or production database');
      process.exit(1);
    }
  }
}
const url = envUrl || startTemp();
if (!url) {
  console.log('  skip  no Postgres available (install initdb or set CONN_PG_URL to a DISPOSABLE database)');
  console.log('SKIP  Grants.gov end-to-end not executed — this check needs a server');
  process.exit(EXIT_NOT_EXECUTED);
}

const UPSTREAM = `
  CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active');
  CREATE TABLE IF NOT EXISTS agent_runs (
    run_id UUID PRIMARY KEY, root_run_id UUID, trigger TEXT, product TEXT,
    state TEXT, company_id TEXT REFERENCES companies(id));
  ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS uq_agent_runs_run_company;
  ALTER TABLE agent_runs ADD CONSTRAINT uq_agent_runs_run_company UNIQUE (run_id, company_id);
`;

const CO = 'company-ggverify-fixture';
const RUN = '33333333-3333-4333-8333-333333333333';
const made = { companies: [], runs: [], syncs: [] };

// Columns the adapter claims to populate for a search-derived row. Reported individually, because
// "95% populated" hides which 5% and a single always-null column is the whole defect.
const CLAIMED = ['opportunityId', 'opportunityNumber', 'title', 'agencyCode', 'agencyName',
  'openDate', 'oppStatus', 'docType', 'standing', 'sourceUrl'];

(async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 4 });
  const q = (sql, params) => pool.query(sql, params);
  const ctx = Object.freeze({ companyId: CO });
  const deps = { query: q };

  try {
    await q(UPSTREAM);
    await migrateConnectors(q);
    await q('INSERT INTO companies (id, slug, display_name) VALUES ($1,$2,$2)', [CO, 'ggverify-fixture']);
    made.companies.push(CO);
    await q(`INSERT INTO agent_runs (run_id, root_run_id, trigger, product, state, company_id)
             VALUES ($1,$1,'verify','prpa','running',$2)`, [RUN, CO]);
    made.runs.push(RUN);
    ok('disposable cluster up, migration applied, fixtures recorded by id');

    // ── one live pass ──────────────────────────────────────────────────────
    const livePass = async (label) => {
      const { syncId } = await sync.beginSync(ctx, { sourceKey: 'grants_gov', runId: RUN }, deps);
      made.syncs.push(syncId);
      let seen = 0;
      let upserted = 0;
      let versions = 0;
      const nullCounts = Object.fromEntries(CLAIMED.map((c) => [c, 0]));
      const standings = {};

      for (const kw of KEYWORDS) {
        await sync.chargeCalls(ctx, syncId, 1, deps);
        const res = await gg.fetchSearch(gg.buildSearchRequest({ keyword: kw, rows: ROWS }));
        note(`${label}: "${kw}" → hitCount ${res.hitCount}, returned ${res.hits.length}`);
        const normalized = res.hits.map((h) => gg.normalizeSearchHit(h, { companyId: CO }));
        for (const n of normalized) {
          if (n.skip) continue;
          seen += 1;
          standings[n.standing] = (standings[n.standing] || 0) + 1;
          for (const c of CLAIMED) if (n[c] == null || n[c] === '') nullCounts[c] += 1;
        }
        const r = await sync.upsertFundingOpportunities(ctx, syncId, normalized, deps);
        upserted += r.inserted + r.updated;
        if (r.skipped) note(`${label}: ${r.skipped} skipped — ${r.skippedReasons.join('; ')}`);
      }

      // Detail calls on a few records, which is where the revision chain comes from.
      const { rows: pick } = await q(
        `SELECT opportunity_id FROM funding_opportunities
          WHERE company_id = $1 ORDER BY opportunity_id LIMIT $2`, [CO, DETAILS]);
      for (const p of pick) {
        await sync.chargeCalls(ctx, syncId, 1, deps);
        const payload = await gg.fetchDetail(p.opportunity_id);
        const n = gg.normalizeDetail(payload, { companyId: CO });
        const r = await sync.upsertFundingOpportunities(ctx, syncId, [n], deps);
        versions += r.versions;
      }

      await sync.completeSync(ctx, syncId, { highWaterMark: new Date().toISOString().slice(0, 10) }, deps);
      return { syncId, seen, upserted, versions, nullCounts, standings };
    };

    const first = await livePass('pass 1');
    ok(`pass 1: ${first.seen} live records normalised, ${first.upserted} upserted, ${first.versions} revision rows`);

    const { rows: c1 } = await q('SELECT COUNT(*)::int n FROM funding_opportunities WHERE company_id = $1', [CO]);
    const { rows: v1 } = await q('SELECT COUNT(*)::int n FROM funding_opportunity_versions WHERE company_id = $1', [CO]);
    note(`after pass 1: ${c1[0].n} opportunities, ${v1[0].n} revisions`);
    if (c1[0].n > 0) ok('live records actually landed — the pipeline is not silently empty');
    else bad('live records landed', 'nothing was stored; the API returned data but nothing persisted');

    // ── §15, measured: run it again ───────────────────────────────────────
    const second = await livePass('pass 2');
    const { rows: c2 } = await q('SELECT COUNT(*)::int n FROM funding_opportunities WHERE company_id = $1', [CO]);
    const { rows: v2 } = await q('SELECT COUNT(*)::int n FROM funding_opportunity_versions WHERE company_id = $1', [CO]);
    note(`after pass 2: ${c2[0].n} opportunities, ${v2[0].n} revisions`);

    // A DELTA against what was already there, not an absolute. The count may legitimately grow if
    // Grants.gov posted something between the two passes, so the assertion is that the second pass
    // INSERTED nothing it had already seen — which is what `updated` counts.
    if (c2[0].n === c1[0].n) {
      ok(`§15 holds live: a second identical sync left the row count unchanged at ${c2[0].n} — no duplicates`);
    } else if (c2[0].n > c1[0].n) {
      // Not automatically a failure: the live service may have posted a record between passes.
      // It IS a failure if the new rows duplicate an opportunity_id already present.
      const { rows: dup } = await q(
        `SELECT opportunity_id, COUNT(*)::int n FROM funding_opportunities
          WHERE company_id = $1 GROUP BY opportunity_id HAVING COUNT(*) > 1`, [CO]);
      if (!dup.length) {
        ok(`§15 holds live: count moved ${c1[0].n} → ${c2[0].n} (the live service changed between passes) `
          + 'but no opportunity_id appears twice');
      } else {
        bad('§15 no duplicate opportunities after repeated synchronization',
          `${dup.length} opportunity_id(s) stored more than once: ${dup.slice(0, 5).map((d) => `${d.opportunity_id}×${d.n}`).join(', ')}`);
      }
    } else {
      bad('a second sync must not LOSE rows', `${c1[0].n} → ${c2[0].n}`);
    }

    // Exactly one current revision per opportunity, on live data.
    const { rows: multi } = await q(
      `SELECT opportunity_id, COUNT(*)::int n FROM funding_opportunity_versions
        WHERE company_id = $1 AND is_current GROUP BY opportunity_id HAVING COUNT(*) > 1`, [CO]);
    if (!multi.length) ok('every opportunity has at most one current revision, after two passes');
    else bad('one current revision per opportunity', JSON.stringify(multi.slice(0, 5)));

    // ── the field-population report ───────────────────────────────────────
    console.log('');
    console.log('  field population across live records (a column that is ALWAYS null is the defect):');
    const alwaysNull = [];
    for (const c of CLAIMED) {
      const n = first.nullCounts[c];
      const pct = first.seen ? Math.round((n / first.seen) * 100) : 0;
      console.log(`    ${c.padEnd(20)} ${String(first.seen - n).padStart(4)}/${first.seen} populated${n ? `   (${pct}% null)` : ''}`);
      if (first.seen && n === first.seen) alwaysNull.push(c);
    }
    if (!alwaysNull.length) ok('no claimed column is null on every live record');
    else bad('a claimed column is null on EVERY live record', `${alwaysNull.join(', ')} — the adapter is not reading these`);

    // ── biddability, read back from where it is computed ──────────────────
    console.log('');
    console.log(`  standings assigned by the adapter: ${JSON.stringify(first.standings)}`);
    const { rows: bid } = await q(
      `SELECT standing, application_open, COUNT(*)::int n FROM funding_opportunities
        WHERE company_id = $1 GROUP BY standing, application_open ORDER BY standing`, [CO]);
    for (const r of bid) console.log(`    standing=${String(r.standing).padEnd(20)} application_open=${String(r.application_open).padEnd(5)} ${r.n}`);

    const contradictions = bid.filter((r) => (r.standing === 'open') !== (r.application_open === true));
    if (!contradictions.length) {
      ok('the adapter\'s standing and the database\'s computed application_open agree on every live record');
    } else {
      bad('standing and biddable must agree — if they disagree one of them is lying to a dashboard',
        contradictions.map((c) => `standing=${c.standing} biddable=${c.biddable} ×${c.n}`).join('; '));
    }

    const forecastsBiddable = bid.filter((r) => r.standing === 'forecast' && r.application_open === true);
    if (!forecastsBiddable.length) ok('no forecast is marked open for applications on live data');
    else bad('a forecast is marked open for applications', JSON.stringify(forecastsBiddable));

    // ── the call ledger ───────────────────────────────────────────────────
    const { rows: ledger } = await q(
      `SELECT status, calls_made, records_seen, records_upserted, high_water_mark
         FROM source_sync_runs WHERE company_id = $1 AND source_key = 'grants_gov'
        ORDER BY started_at`, [CO]);
    console.log('');
    for (const r of ledger) {
      console.log(`    sync ${r.status.padEnd(10)} calls=${r.calls_made} seen=${r.records_seen} upserted=${r.records_upserted} watermark=${r.high_water_mark}`);
    }
    if (ledger.length === 2 && ledger.every((r) => r.status === 'completed' && r.calls_made > 0)) {
      ok('both syncs are recorded on the run ledger with their call counts and watermarks');
    } else bad('the run ledger records both syncs', JSON.stringify(ledger));

    // ── cleanup: only what I made, by id ──────────────────────────────────
    await q('DELETE FROM funding_opportunity_versions WHERE company_id = $1', [CO]);
    await q('DELETE FROM funding_opportunities WHERE company_id = $1', [CO]);
    for (const id of made.syncs) await q('DELETE FROM source_sync_runs WHERE id = $1', [id]);
    for (const id of made.runs) await q('DELETE FROM agent_runs WHERE run_id = $1', [id]);
    for (const id of made.companies) await q('DELETE FROM companies WHERE id = $1', [id]);
    // The two bulk deletes above are scoped to the FIXTURE COMPANY, which this script created and
    // which exists nowhere else — not to a timestamp and not to "recent". Every ingested row is
    // owned by that company by construction, so the fixture id IS the explicit scope.
    const { rows: leak } = await q(
      `SELECT (SELECT COUNT(*)::int FROM funding_opportunities WHERE company_id = $1) o,
              (SELECT COUNT(*)::int FROM funding_opportunity_versions WHERE company_id = $1) v,
              (SELECT COUNT(*)::int FROM source_sync_runs WHERE company_id = $1) s,
              (SELECT COUNT(*)::int FROM companies WHERE id = $1) c`, [CO]);
    const l = leak[0];
    if (!l.o && !l.v && !l.s && !l.c) ok('cleanup: every fixture row removed, none leaked');
    else bad('cleanup left rows behind', JSON.stringify(l));
  } catch (e) {
    bad('verification aborted', e.stack || e.message);
  } finally {
    await pool.end().catch(() => {});
    stopTemp();
  }

  console.log('');
  if (fail) { console.log(`FAIL  ${fail} Grants.gov end-to-end check(s) failed`); process.exit(1); }
  console.log('PASS  Grants.gov ingests live records, twice, without duplicating them');
  process.exit(0);
})();
