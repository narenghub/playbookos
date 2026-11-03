#!/usr/bin/env node
// ── K8: A STOP MUST NAME SOMETHING ──────────────────────────────────────────
//
//   scripts/check-autonomy-scope-validation-db.js → exit 0 = a stop that would protect nothing is
//                                                   refused, and every real stop still works
//
// ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
//
// matchStop() matches by EXACT string equality, so a stop whose key no caller ever passes matches
// nothing, for ever. Before K8 such a stop was accepted, STORED, AUDITED and reported as
// successful: `capability='email_send'` (real key `email.send`) or `agent='seo'` (real name
// `seo-agent`). The operator believed autonomy was halted. It was not. False safety evidence is
// worse than none, because it stops people looking.
//
// ── WHAT THIS CHECK HAS TO PROVE, IN BOTH DIRECTIONS ────────────────────────
//
// Rejecting a LEGITIMATE stop is far worse than accepting a useless one: it denies an operator the
// ability to halt something. So the dangerous failure mode of K8 is over-strictness, and this
// check spends more assertions on "every real stop still works" than on the refusals:
//
//   • all five scope types still stop, resume and audit — the P0.2 semantics are not weakened
//   • EVERY key in the derived vocabularies is accepted (37 workflows, 13 agents, 3 capabilities),
//     asserted by enumeration rather than by sampling two of them
//   • a refused stop leaves NO ROW, so nothing can later be mistaken for protection
//   • a company key is still free text unless the companies table can disprove it
//
// Needs a server: the stop path writes through a transaction and the audit history is written by a
// database trigger, so a stubbed query would prove nothing about either.
'use strict';

const { pgBin, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => {
  fail++; console.log(`  FAIL  ${m}`);
  if (d) console.log(String(d).split('\n').map((l) => `          ${l}`).join('\n'));
};
const note = (m) => console.log(`  --    ${m}`);

const findInitdb = pgBin;
let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/k8-scope-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55992' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55992 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55992&sslmode=disable`;
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

const url = process.env.OFFICE_PG_URL || startTemp();
if (!url) {
  console.log('  skip  no Postgres available (set OFFICE_PG_URL or install initdb)');
  console.log('SKIP  K8 scope validation not executed against a server — this check needs one');
  process.exit(EXIT_NOT_EXECUTED);
}
process.env.DATABASE_URL = url;

const REASON = 'K8 check: verifying scope-key validation refuses a stop that protects nothing';

(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: url, ssl: false });
  const q = (t, p) => P.query(t, p);
  const deps = { query: q };

  const autonomy = require('../src/lib/autonomy');
  // Loading the Executive Agent registers its non-cron scope names. If registration did not
  // happen, `workflow=objective-review` would be refused — which is the failure mode this proves.
  require('../src/lib/office/executive-agent');
  const { migrateRuns } = require('../src/lib/runs');
  const { migrateOffice } = require('../src/lib/office/schema');

  const companies = [];
  const stopRows = async () => (await q(`SELECT COUNT(*)::int n FROM autonomy_stops`)).rows[0].n;
  const evRows = async () => (await q(`SELECT COUNT(*)::int n FROM autonomy_events`)).rows[0].n;

  try {
    await autonomy.migrateAutonomy(q);
    await migrateRuns(q);
    await migrateOffice(q);
    ok('schema applied (autonomy + runs + office)');

    // ══ 1. THE DEFECT, REFUSED ═════════════════════════════════════════════
    const invalid = [
      ['capability', 'email_send', 'the real key is email.send'],
      ['capability', 'send_email', 'not a capability at all'],
      ['agent', 'seo', 'the real name is seo-agent'],
      ['agent', 'ceo', 'the real name is ceo-agent'],
      ['workflow', 'daily-ceo-briefing', 'not a registered cron name'],
      ['workflow', 'objective_review', 'underscore instead of hyphen'],
    ];
    for (const [scope_type, scope_key, why] of invalid) {
      const before = await stopRows();
      const r = await autonomy.stop({ scope_type, scope_key, reason: REASON, actor: 'check' }, { deps });
      const after = await stopRows();
      if (r.ok) bad(`${scope_type}="${scope_key}" was ACCEPTED (${why}) — it would protect nothing`);
      else if (after !== before) bad(`${scope_type}="${scope_key}" was refused but LEFT A ROW — it could be mistaken for protection`);
      else ok(`${scope_type}="${scope_key}" refused and no row written (${why})`);
    }

    // The error has to be usable, not merely correct.
    const r1 = await autonomy.stop({ scope_type: 'capability', scope_key: 'email_send', reason: REASON, actor: 'check' }, { deps });
    if (!/did you mean "email\.send"/.test(r1.error || '')) bad(`the refusal does not name the near miss: ${r1.error}`);
    else ok('the refusal names the likely typo ("did you mean email.send?")');

    // ══ 2. EVERY REAL KEY STILL WORKS — BY ENUMERATION ═════════════════════
    // This is the assertion that protects against over-strictness, which is the dangerous
    // direction. Sampling two keys would not catch a vocabulary that dropped half its entries.
    for (const t of ['capability', 'workflow', 'agent']) {
      const keys = autonomy.knownScopeKeys(t);
      const rejected = keys.filter((k) => autonomy.validate({ scope_type: t, scope_key: k, reason: REASON }) !== null);
      if (rejected.length) bad(`${rejected.length} legitimate ${t} key(s) are now REFUSED — validation is over-strict`, rejected.join(', '));
      else ok(`all ${keys.length} ${t} keys are accepted (enumerated, not sampled)`);
    }
    const wf = autonomy.knownScopeKeys('workflow');
    if (!wf.includes('objective-review')) bad('the office workflow is not registered — the Executive Agent cannot be stopped by name');
    else ok('registerScopes() made the office workflow stoppable by name');
    if (!autonomy.knownScopeKeys('agent').includes('executive-agent')) bad('the Executive Agent is not registered as an agent scope');
    else ok('the Executive Agent is stoppable by agent name');

    // ══ 3. ALL FIVE SCOPE TYPES STILL STOP, RESUME AND AUDIT ═══════════════
    const A = `k8-co-${crypto.randomUUID()}`;
    await q(`INSERT INTO companies (id, slug, display_name) VALUES ($1,$1,$1)`, [A]);
    companies.push(A);

    const live = [
      ['global', ''],
      ['company', A],
      ['agent', 'ceo-agent'],
      ['workflow', 'daily-7cst-ceo-briefing'],
      ['capability', 'email.send'],
    ];
    for (const [scope_type, scope_key] of live) {
      const evBefore = await evRows();
      const s = await autonomy.stop({ scope_type, scope_key, reason: REASON, actor: 'check' }, { deps });
      if (!s.ok) { bad(`a LEGITIMATE ${scope_type} stop was refused: ${s.error}`); continue; }
      const stored = (await q(`SELECT 1 FROM autonomy_stops WHERE scope_type=$1 AND scope_key=$2`, [scope_type, scope_key])).rows.length;
      if (!stored) { bad(`the ${scope_type} stop reported ok but wrote no row`); continue; }
      const evAfter = await evRows();
      if (evAfter <= evBefore) { bad(`the ${scope_type} stop was not audited`); continue; }
      const res = await autonomy.resume({ scope_type, scope_key, reason: REASON, actor: 'check' }, { deps });
      if (!res.ok || res.removed !== 1) { bad(`the ${scope_type} stop could not be resumed: ${JSON.stringify(res)}`); continue; }
      ok(`${scope_type} stop works end to end: stored, audited, resumed (P0.2 semantics intact)`);
    }

    // ══ 4. COMPANY: VERIFIED WHEN POSSIBLE, FREE TEXT WHEN NOT ═════════════
    const ghost = await autonomy.stop({ scope_type: 'company', scope_key: 'no-such-company', reason: REASON, actor: 'check' }, { deps });
    if (ghost.ok) bad('a stop on an unknown company was accepted while the companies table was readable');
    else ok('a company key the companies table disproves is refused');

    // P0.2 deliberately made the company key free text. With the table absent we cannot know, and
    // refusing a halt we merely failed to verify is the dangerous direction.
    await q(`ALTER TABLE companies RENAME TO companies_k8_hidden`);
    try {
      const unverifiable = await autonomy.stop({ scope_type: 'company', scope_key: 'brand-new-business', reason: REASON, actor: 'check' }, { deps });
      if (!unverifiable.ok) bad(`with the companies table absent an unverifiable company stop was REFUSED: ${unverifiable.error}`);
      else {
        ok('with no companies table, a company stop is accepted rather than denied (P0.2: free text, no migration needed)');
        await autonomy.resume({ scope_type: 'company', scope_key: 'brand-new-business', reason: REASON, actor: 'check' }, { deps });
      }
    } finally {
      await q(`ALTER TABLE companies_k8_hidden RENAME TO companies`);
    }

    // ══ 5. THE SLUG PATH ═══════════════════════════════════════════════════
    const slugStop = await autonomy.stop({ scope_type: 'company', scope_key: A, reason: REASON, actor: 'check' }, { deps });
    if (!slugStop.ok) bad(`a stop on a real company id was refused: ${slugStop.error}`);
    else { ok('a real company id is accepted'); await autonomy.resume({ scope_type: 'company', scope_key: A, reason: REASON, actor: 'check' }, { deps }); }

    // ══ 6. MUTATION CONTROLS ═══════════════════════════════════════════════
    note('mutation controls: disable the validation, prove the bad stop is accepted again');

    const FILE = path.join(__dirname, '..', 'src', 'lib', 'autonomy.js');
    const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    const before = sha(FILE);
    const src = fs.readFileSync(FILE, 'utf8');
    const needle = `  const known = knownScopeKeys(scope_type);
  if (known && !known.includes(String(scope_key))) {`;
    if (!src.includes(needle)) {
      bad('M1 could not locate the scope-key check — the mutation control is stale and proves nothing');
    } else {
      fs.writeFileSync(FILE, src.replace(needle, `  const known = null;
  if (known && !known.includes(String(scope_key))) {`));
      try {
        for (const k of Object.keys(require.cache)) if (k.includes(path.join('src', 'lib', 'autonomy.js'))) delete require.cache[k];
        const mutated = require('../src/lib/autonomy');
        const slip = mutated.validate({ scope_type: 'capability', scope_key: 'email_send', reason: REASON });
        if (slip !== null) bad('M1 with the check disabled the bad key was STILL refused — the check may not be what protects us', String(slip));
        else ok('M1 disabling the scope-key check accepts capability="email_send" again — the check is load-bearing');
      } finally {
        fs.writeFileSync(FILE, src);
        for (const k of Object.keys(require.cache)) if (k.includes(path.join('src', 'lib', 'autonomy.js'))) delete require.cache[k];
      }
    }
    if (sha(FILE) !== before) bad('M1 autonomy.js was NOT restored byte-for-byte');
    else ok('M1 autonomy.js restored, verified by content hash');

    // M2 — the registry must be DERIVED. If CRON_SCOPES stopped feeding it, the vocabulary would
    // collapse and every real workflow stop would be refused. This proves the derivation is real
    // rather than a coincidence of a hard-coded list.
    const freshA = require('../src/lib/autonomy');
    const derived = freshA.knownScopeKeys('workflow');
    const cronNames = Object.keys(freshA.CRON_SCOPES);
    const missing = cronNames.filter((c) => !derived.includes(c));
    if (missing.length) bad(`M2 ${missing.length} cron name(s) are not in the derived workflow vocabulary`, missing.slice(0, 5).join(', '));
    else ok(`M2 the workflow vocabulary is derived from CRON_SCOPES (all ${cronNames.length} present), not a second list`);
    const agentsFromCrons = [...new Set(Object.values(freshA.CRON_SCOPES).map((m) => m && m.agent).filter(Boolean))];
    const missingAgents = agentsFromCrons.filter((a) => !freshA.knownScopeKeys('agent').includes(a));
    if (missingAgents.length) bad(`M2 ${missingAgents.length} cron agent(s) missing from the vocabulary`, missingAgents.join(', '));
    else ok(`M2 the agent vocabulary is derived too (all ${agentsFromCrons.length} cron agents present)`);

  } catch (e) {
    bad('unexpected error', e.stack || e.message);
  } finally {
    try {
      await q(`DELETE FROM autonomy_stops WHERE set_by = 'check' OR reason = $1`, [REASON]).catch(() => {});
      for (const id of companies) await q(`DELETE FROM companies WHERE id = $1`, [id]);
      const leak = companies.length
        ? (await q(`SELECT COUNT(*)::int n FROM companies WHERE id = ANY($1)`, [companies])).rows[0].n
        : 0;
      if (leak) bad(`${leak} of my fixture companies remain`);
      else ok('cleanup: every fixture row I created is gone (by id)');
    } catch (e) {
      bad('cleanup failed', e.message);
    }
    try { await P.end(); } catch (_) {}
    stopTemp();
  }

  console.log(fail
    ? `\nFAIL  ${fail} K8 assertion(s) failed`
    : '\nPASS  K8: a stop that would protect nothing is refused and leaves no row, and every real '
      + 'scope key still stops, audits and resumes');
  process.exit(fail ? 1 : 0);
})();
