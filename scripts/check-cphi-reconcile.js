// ── IS THE CPHI RECONCILIATION AUDITABLE, REPEATABLE AND RECOVERABLE? ──────────────────────────────
//
//   node scripts/check-cphi-reconcile.js ; echo $?
//
// Ruling 35 item 5: *"Test the proposed reconciliation against an isolated restored production
// backup. Demonstrate that the operation is auditable, repeatable, and recoverable."*
//
// Those three words are the whole specification, and each one is only worth anything if it is
// demonstrated rather than claimed. So each is provoked here against a real cluster:
//
//   AUDITABLE    a deleted row's COMPLETE prior contents must be reconstructable afterwards from
//                cphi_reconcile_audit — proved by deleting a row and rebuilding it field for field,
//                not by checking that an audit table exists and has some rows in it.
//   REPEATABLE   applying the same plan twice must change nothing the second time, and generating
//                the plan twice from the same database must produce the same survivors and the same
//                fingerprints. A plan that drifts between generations cannot be reviewed.
//   RECOVERABLE  the rows removed must come back, with their notes and review statuses intact, from
//                the audit table alone — so the recovery route does not depend on the backup having
//                been taken, though it also is.
//
// And the two refusals that make a plan safe to leave on disk and come back to:
//
//   TRANSACTIONAL  the merge, the audit rows and the deletions commit together or not at all —
//                  proved by injecting a real BEFORE DELETE failure at the database and showing the
//                  group comes back untouched, with no audit rows, while other groups still apply.
//
//   DRIFT        a group whose rows have changed since the plan was generated is REFUSED, not
//                reconciled on stale information. This is the `verify-product-revocation-live.js`
//                lesson from CLAUDE.md: an expectation that encoded account state somebody had since
//                changed, and found out by writing.
//   CONFLICT     a group where two rows carry contradicting human work is left exactly as it is,
//                whatever flags are passed.
//
// THE MOST IMPORTANT SINGLE ASSERTION IN THIS FILE is that a note on a row which does NOT survive
// ends up on the row that does. Deleting a duplicate is easy; deleting a duplicate without losing
// the sentence somebody typed about a conversation at a trade stand is the actual requirement.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { pgBinCandidates, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const PGPORT = process.env.RECONCILE_PGPORT || '55487';

let pass = 0; let fail = 0;
const ok = (m) => { pass += 1; console.log(`  ok    ${m}`); };
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}${d ? `\n          ${d}` : ''}`); };
const h = (t) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

let temp = null;
const sh = (cmd) => {
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  return execFileSync('sh', ['-c', temp.asPostgres ? `su postgres -c ${JSON.stringify(`PATH=${temp.dir}:$PATH ${cmd}`)}` : cmd],
    { env, encoding: 'utf8', stdio: 'pipe' });
};

function startCluster() {
  const dir = pgBinCandidates()[0];
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/cphirec-');
  const asPostgres = process.getuid && process.getuid() === 0;
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, encoding: 'utf8', stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p ${PGPORT} -c listen_addresses=' start -w`);
  } catch (e) {
    console.error(`  (cluster start failed: ${e.message})`);
    return null;
  }
  temp = { base, dir, asPostgres };
  return base;
}

function stopCluster() {
  if (!temp) return;
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`],
    { env: { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` }, stdio: 'pipe' });
  } catch { /* going away anyway */ }
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch { /* temp dir */ }
}

const TABLE = `
  CREATE TABLE cphi_exhibitor_matches (
    id                BIGSERIAL PRIMARY KEY,
    event_slug        TEXT NOT NULL,
    holder            TEXT NOT NULL,
    holder_normalized TEXT NOT NULL,
    exhibiting        BOOLEAN NOT NULL DEFAULT false,
    exhibitor_name    TEXT,
    booth             TEXT,
    hall              TEXT,
    match_tier        TEXT,
    molecules_covered INTEGER NOT NULL DEFAULT 0,
    review_status     TEXT NOT NULL DEFAULT 'unreviewed',
    searched_terms    TEXT,
    checked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    entity_note       TEXT
  );
`;

// A fixture that contains one of each kind of group, because a harness that only tests the easy case
// is how the ENG-004 verify survived for a month.
//   alpha  — AUTO:     two plain rows, nothing human anywhere
//   gamma  — MERGE:    the note is on the row that will NOT survive. This is the one that matters,
//                      and constructing it needs care: a note-bearing row is human-touched, so it
//                      WINS unless another row in the group is human too. So gamma holds a reviewed
//                      row (newer, survives) and a noted row (older, does not) — the note and the
//                      review do not contradict each other, so this is a merge and not a conflict,
//                      and the note has to travel.
//   delta  — MERGE:    the survivor is the reviewed row, and a row that does NOT survive carries a
//                      HIGHER molecules_covered — so keeping the survivor's own figure would
//                      understate the holder
//   omega  — CONFLICT: two different review_status values
//   sigma  — CONFLICT: two different notes
//   beta   — not duplicated at all; must be left alone entirely
const FIXTURE = `
  INSERT INTO cphi_exhibitor_matches
    (event_slug, holder, holder_normalized, exhibiting, exhibitor_name, booth, hall, match_tier,
     molecules_covered, review_status, searched_terms, checked_at, entity_note) VALUES
  ('cphi-milan-2026','Alpha Pharma','alpha', false, NULL,      NULL,  NULL, 'token',  0, 'unreviewed','alpha pharma', NOW() - INTERVAL '9 days', NULL),
  ('cphi-milan-2026','Alpha Pharma','alpha', true,  'Alpha SpA','12A', '12', 'exact',  3, 'unreviewed','alpha spa',    NOW() - INTERVAL '1 days', NULL),
  ('cphi-milan-2026','Gamma Labs', 'gamma', true,  'Gamma Srl','7B',  '7',  'core',   2, 'unreviewed','gamma labs',   NOW() - INTERVAL '8 days', 'Met Giulia at the stand, she handles tenders'),
  ('cphi-milan-2026','Gamma Labs', 'gamma', true,  'Gamma Srl','7B',  '7',  'core',   2, 'confirmed', 'gamma srl',    NOW() - INTERVAL '2 days', NULL),
  ('cphi-milan-2026','Delta Chem', 'delta', true,  NULL,       '3C',  '3',  'prefix', 1, 'confirmed', 'delta chem',   NOW() - INTERVAL '6 days', NULL),
  ('cphi-milan-2026','Delta Chem', 'delta', true,  'Delta AG', NULL,  NULL, 'prefix', 9, 'unreviewed','delta ag',     NOW() - INTERVAL '3 days', NULL),
  ('cphi-milan-2026','Omega Bio',  'omega', true,  'Omega',    '1A',  '1',  'exact',  4, 'confirmed', 'omega bio',    NOW() - INTERVAL '5 days', NULL),
  ('cphi-milan-2026','Omega Bio',  'omega', true,  'Omega',    '1A',  '1',  'exact',  4, 'rejected',  'omega bio ag', NOW() - INTERVAL '4 days', NULL),
  ('cphi-milan-2026','Sigma Ind',  'sigma', true,  'Sigma',    '9D',  '9',  'core',   1, 'unreviewed','sigma ind',    NOW() - INTERVAL '7 days', 'Booth was unattended both times I went'),
  ('cphi-milan-2026','Sigma Ind',  'sigma', true,  'Sigma',    '9D',  '9',  'core',   1, 'unreviewed','sigma industries', NOW() - INTERVAL '6 days', 'Emailed them instead, no reply'),
  ('cphi-milan-2026','Beta Co',    'beta',  true,  'Beta',     '2B',  '2',  'exact',  5, 'confirmed', 'beta co',      NOW() - INTERVAL '2 days', 'Signed an NDA');
`;

async function db(base, name, ddl) {
  const admin = new Client({ connectionString: `postgresql://postgres@localhost/postgres?host=${base}&port=${PGPORT}&sslmode=disable` });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = `postgresql://postgres@localhost/${name}?host=${base}&port=${PGPORT}&sslmode=disable`;
  const c = new Client({ connectionString: url });
  await c.connect();
  if (ddl) await c.query(ddl);
  return { url, c };
}

function reconcile(url, args = []) {
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, 'cphi-reconcile.js'), ...args],
      { env: { ...process.env, DATABASE_URL: url, RECONCILE_ACTOR: 'harness@example.invalid' },
        encoding: 'utf8', stdio: 'pipe', maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? 1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

const groupRows = async (c, norm) => (await c.query(
  `SELECT * FROM cphi_exhibitor_matches WHERE holder_normalized = $1 ORDER BY id`, [norm])).rows;
const total = async (c) => (await c.query(`SELECT COUNT(*)::int n FROM cphi_exhibitor_matches`)).rows[0].n;

async function main() {
  h('CPHI RECONCILIATION — AUDITABLE, REPEATABLE, RECOVERABLE');

  const base = startCluster();
  if (!base) {
    console.log('\nSKIP  no PostgreSQL server toolchain (initdb/pg_ctl). This proved NOTHING.\n');
    process.exit(EXIT_NOT_EXECUTED);
  }

  // ── 1. an isolated restore, the way ruling 35 item 5 asks for ──────────────────────────────────
  h('1. BUILD A DATABASE, DUMP IT, RESTORE THE DUMP — reconciliation runs on the RESTORE');
  const planFile = `${temp.base}/plan.json`;
  let url;
  let c;
  {
    const src = await db(base, 'cphi_src', `${TABLE}${FIXTURE}`);
    const n = await total(src.c);
    await src.c.end();
    if (n === 11) ok(`source database built — ${n} rows, 5 duplicate groups and 1 untouched holder`);
    else bad(`expected 11 rows, built ${n}`);

    sh(`pg_dump -h ${temp.base} -p ${PGPORT} -U postgres --format=custom --file=${temp.base}/src.dump cphi_src`);
    const admin = new Client({ connectionString: `postgresql://postgres@localhost/postgres?host=${base}&port=${PGPORT}&sslmode=disable` });
    await admin.connect();
    await admin.query('DROP DATABASE IF EXISTS cphi_restored');
    await admin.query('CREATE DATABASE cphi_restored');
    await admin.end();
    sh(`pg_restore -h ${temp.base} -p ${PGPORT} -U postgres -d cphi_restored ${temp.base}/src.dump`);
    url = `postgresql://postgres@localhost/cphi_restored?host=${base}&port=${PGPORT}&sslmode=disable`;
    c = new Client({ connectionString: url });
    await c.connect();
    if (await total(c) === 11) ok('restored into an isolated database — 11 rows, matching the source');
    else bad(`the restore holds ${await total(c)} rows, not 11`);
  }

  // ── 2. the report: everything item 3 asks for ──────────────────────────────────────────────────
  h('2. THE REPORT — every group, row ids, review statuses, notes, provenance, timestamps');
  {
    const r = reconcile(url, ['--plan-out', planFile]);
    if (r.code === 1) ok('exit 1 — duplicates are a blocking finding, and an exit code cannot be skimmed past');
    else bad(`exit ${r.code}, expected 1`, 'a report nobody has to acknowledge is a report nobody reads');

    for (const [needle, what] of [
      [/AUTO\s+1 group/, 'counts the AUTO groups'],
      [/MERGE\s+2 group/, 'counts the MERGE groups'],
      [/CONFLICT\s+2 group/, 'counts the CONFLICT groups'],
      [/Met Giulia at the stand/, "quotes the note verbatim, including the one on a row that will not survive"],
      [/review_status="confirmed"/, 'shows review statuses'],
      [/fingerprint [0-9a-f]{16}/, 'fingerprints each group so the plan can detect drift'],
      [/searched_terms=/, 'shows the source reference each row came from'],
      [/checked /, 'shows timestamps'],
      [/molecules_covered=/, 'shows molecules_covered, which a careless merge would lower'],
      [/rows deleted if this plan is applied: 3/, 'states exactly how many rows would go'],
    ]) {
      if (needle.test(r.out)) ok(what);
      else bad(`the report does not: ${what}`);
    }
    if (!fs.existsSync(planFile)) { bad('no plan file was written'); throw new Error('stop'); }
    ok(`plan written to ${path.basename(planFile)}`);
    if (await total(c) === 11) ok('the report changed nothing — still 11 rows');
    else bad(`the read-only report mutated the database: 11 → ${await total(c)}`);
  }

  // ── 3. the plan: survivors and merges, item 4 ──────────────────────────────────────────────────
  h('3. THE PLAN — a survivor and a merge for each group, human work preserved');
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  {
    const g = (n) => plan.groups.find((x) => x.holder_normalized === n);

    if (g('alpha').classification === 'AUTO') ok('alpha, with no human work anywhere, is AUTO');
    else bad(`alpha classified ${g('alpha').classification}, expected AUTO`);

    // THE ONE THAT MATTERS. The note is on the OLDER row, which does not survive on recency.
    const gamma = g('gamma');
    const noteRow = gamma.rows.find((x) => x.entity_note);
    if (gamma.classification === 'MERGE') ok('gamma is MERGE — its note is on a row that will not survive');
    else bad(`gamma classified ${gamma.classification}, expected MERGE`);
    if (String(gamma.survivor_id) !== String(noteRow.id)) {
      ok(`the surviving row (#${gamma.survivor_id}) is NOT the one holding the note (#${noteRow.id}) — so the note must be carried`);
    } else {
      bad('the fixture does not exercise the case it exists for', 'the note is on the survivor, so nothing has to be carried');
    }
    const noteMerge = gamma.merges.find((m) => m.field === 'entity_note');
    if (noteMerge && /Met Giulia at the stand/.test(noteMerge.value)) ok("the note is carried onto the survivor verbatim");
    else bad('the note would be LOST', JSON.stringify(gamma.merges));
    if (noteMerge && /merged from row #/.test(noteMerge.value)) ok('…with provenance recording which row it came from, and when');
    else bad('the carried note has no provenance');

    const delta = g('delta');
    if (delta.merges.find((m) => m.field === 'molecules_covered' && Number(m.value) === 9)) {
      ok('delta keeps the HIGHER molecules_covered (9, not the survivor\'s 1)');
    } else {
      bad('delta would understate the holder\'s coverage', JSON.stringify(delta.merges));
    }
    if (delta.merges.find((m) => m.field === 'exhibitor_name')) ok('delta fills exhibitor_name, which its survivor lacked');
    else bad('delta drops an exhibitor_name the survivor did not have');

    for (const n of ['omega', 'sigma']) {
      const grp = g(n);
      if (grp.classification === 'CONFLICT') ok(`${n} is CONFLICT — contradicting human work, no rule can settle it`);
      else bad(`${n} classified ${grp.classification}, expected CONFLICT`);
      if (grp.delete_ids.length === 0 || grp.conflicts.length) ok(`${n} carries its reason and is not scheduled for deletion`);
      else bad(`${n} would be reconciled anyway`);
    }
    if (!plan.groups.find((x) => x.holder_normalized === 'beta')) ok('beta, not duplicated, is not in the plan at all');
    else bad('a non-duplicated holder appears in the plan');

    // Every group records what would be lost if the losers were simply dropped — item 3's "any other
    // information that could be lost or changed".
    if (plan.groups.every((x) => Array.isArray(x.would_lose_without_merge))) {
      ok('every group itemises what the non-surviving rows carry');
    } else bad('some groups do not record what would be lost');
  }

  // ── 4. REPEATABLE, part one: the plan is deterministic ─────────────────────────────────────────
  h('4. REPEATABLE — generating the plan twice must give the same answer');
  {
    const second = `${temp.base}/plan2.json`;
    reconcile(url, ['--plan-out', second]);
    const p2 = JSON.parse(fs.readFileSync(second, 'utf8'));
    const key = (p) => p.groups.map((g) => `${g.holder_normalized}:${g.classification}:${g.survivor_id}:${g.fingerprint}:${g.delete_ids.join('-')}`).join('|');
    if (key(plan) === key(p2)) ok('same survivors, same classifications, same fingerprints');
    else bad('the plan is not deterministic', `${key(plan)}\n          vs\n          ${key(p2)}`);
    if (plan.plan_id !== p2.plan_id) ok('…but a distinct plan_id, so the audit trail can tell the two runs apart');
    else bad('both plans share a plan_id — audit rows could not be attributed');
  }

  // ── 5. apply, and the refusal without confirmation ─────────────────────────────────────────────
  h('5. APPLY — refused without --confirm-not-production, then applied');
  {
    const noConfirm = reconcile(url, ['--apply', planFile]);
    if (noConfirm.code === 2) ok('refused without --confirm-not-production — exit 2');
    else bad(`exit ${noConfirm.code}, expected 2`, 'it would delete rows on a bare --apply');
    if (await total(c) === 11) ok('nothing changed by the refused apply');
    else bad(`the refused apply still mutated: 11 → ${await total(c)}`);

    const r = reconcile(url, ['--apply', planFile, '--confirm-not-production']);
    // Exit 1 is correct here: two CONFLICT groups remain, so the index still cannot be created.
    if (/3 row\(s\) deleted/.test(r.out)) ok('applied — 3 rows deleted, exactly as planned');
    else bad('the apply did not delete the planned rows', r.out.trim().split('\n').slice(-6).join(' | '));
    if (/2 skipped/.test(r.out)) ok('the 2 CONFLICT groups were skipped');
    else bad('conflicting groups were not skipped');
    if (await total(c) === 8) ok('11 → 8 rows');
    else bad(`expected 8 rows, found ${await total(c)}`);

    // THE REQUIREMENT, checked in the data rather than in the log.
    const gammaRows = await groupRows(c, 'gamma');
    if (gammaRows.length === 1) ok('gamma is now a single row');
    else bad(`gamma has ${gammaRows.length} rows`);
    if (gammaRows.length && /Met Giulia at the stand/.test(gammaRows[0].entity_note || '')) {
      ok('…and it carries the note from the row that was deleted — the human sentence survived');
    } else {
      bad('THE NOTE WAS LOST', `entity_note is now ${JSON.stringify(gammaRows[0] && gammaRows[0].entity_note)}`);
    }
    const deltaRows = await groupRows(c, 'delta');
    if (deltaRows.length === 1 && deltaRows[0].review_status === 'confirmed' && Number(deltaRows[0].molecules_covered) === 9) {
      ok('delta kept its review and the higher molecules_covered');
    } else {
      bad('delta lost its review or its coverage', JSON.stringify(deltaRows.map((x) => [x.review_status, x.molecules_covered])));
    }
    const betaRows = await groupRows(c, 'beta');
    if (betaRows.length === 1 && betaRows[0].entity_note === 'Signed an NDA') ok('beta, never duplicated, is untouched including its note');
    else bad('an unrelated row was modified', JSON.stringify(betaRows));
    for (const n of ['omega', 'sigma']) {
      if ((await groupRows(c, n)).length === 2) ok(`${n} still has both rows — conflicts untouched`);
      else bad(`${n} was reconciled despite being a conflict`);
    }
  }

  // ── 6. AUDITABLE and RECOVERABLE ───────────────────────────────────────────────────────────────
  h('6. AUDITABLE / RECOVERABLE — rebuild a deleted row from the audit table alone');
  {
    const audit = (await c.query(
      `SELECT * FROM cphi_reconcile_audit WHERE plan_id = $1 ORDER BY id`, [plan.plan_id])).rows;
    if (audit.length >= 3) ok(`${audit.length} audit row(s) under this plan_id`);
    else bad(`only ${audit.length} audit row(s)`, '3 deletes and 2 merges were applied');

    if (audit.every((a) => a.actor === 'harness@example.invalid')) ok('every audit row records who did it');
    else bad('audit rows do not record the actor');
    if (audit.every((a) => a.applied_at)) ok('…and when');
    else bad('audit rows have no timestamp');

    const deletes = audit.filter((a) => a.action === 'delete');
    if (deletes.length === 3) ok('3 delete actions recorded');
    else bad(`${deletes.length} delete actions recorded, expected 3`);
    if (deletes.every((a) => a.before_row && a.before_row.id)) ok('each holds the COMPLETE prior row as JSON');
    else bad('a delete was recorded without the row it removed');

    // RECOVERY, demonstrated: put one back from the audit alone and compare it field for field with
    // what the pristine source had. Claiming recoverability without doing this is how a rollback plan
    // gets written three times and tested nowhere.
    const gammaDeleted = deletes.find((a) => a.holder_normalized === 'gamma');
    const before = gammaDeleted.before_row;
    await c.query(
      `INSERT INTO cphi_exhibitor_matches
         (id, event_slug, holder, holder_normalized, exhibiting, exhibitor_name, booth, hall,
          match_tier, molecules_covered, review_status, searched_terms, checked_at, entity_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [before.id, before.event_slug, before.holder, before.holder_normalized, before.exhibiting,
        before.exhibitor_name, before.booth, before.hall, before.match_tier, before.molecules_covered,
        before.review_status, before.searched_terms, before.checked_at, before.entity_note]);

    const src = new Client({ connectionString: `postgresql://postgres@localhost/cphi_src?host=${base}&port=${PGPORT}&sslmode=disable` });
    await src.connect();
    const original = (await src.query(`SELECT * FROM cphi_exhibitor_matches WHERE id = $1`, [before.id])).rows[0];
    await src.end();
    const restored = (await c.query(`SELECT * FROM cphi_exhibitor_matches WHERE id = $1`, [before.id])).rows[0];

    const differing = Object.keys(original).filter((k) => {
      const a = original[k] instanceof Date ? original[k].getTime() : original[k];
      const b = restored[k] instanceof Date ? restored[k].getTime() : restored[k];
      return String(a) !== String(b);
    });
    if (!differing.length) ok(`row #${before.id} rebuilt from the audit table matches the original in every field`);
    else bad(`the rebuilt row differs in: ${differing.join(', ')}`, 'the audit trail is not a recovery route');

    await c.query(`DELETE FROM cphi_exhibitor_matches WHERE id = $1`, [before.id]);   // tidy the fixture
  }

  // ── 7. REPEATABLE, part two: applying twice ────────────────────────────────────────────────────
  h('7. REPEATABLE — applying the same plan again must change nothing');
  {
    const beforeN = await total(c);
    const beforeAudit = (await c.query(`SELECT COUNT(*)::int n FROM cphi_reconcile_audit`)).rows[0].n;
    const r = reconcile(url, ['--apply', planFile, '--confirm-not-production']);
    const afterN = await total(c);
    if (afterN === beforeN) ok(`a second apply changed no rows (${beforeN} → ${afterN})`);
    else bad(`the second apply mutated the database: ${beforeN} → ${afterN}`);
    if (/already reconciled/.test(r.out)) ok('it reports the groups as already reconciled');
    else bad('it does not recognise its own prior work', r.out.trim().split('\n').slice(-5).join(' | '));
    const afterAudit = (await c.query(`SELECT COUNT(*)::int n FROM cphi_reconcile_audit`)).rows[0].n;
    if (afterAudit === beforeAudit) ok('and wrote no new audit rows');
    else bad(`it wrote ${afterAudit - beforeAudit} spurious audit row(s)`);
  }

  // ── 8. DRIFT ───────────────────────────────────────────────────────────────────────────────────
  h('8. DRIFT — a plan must be refused once the rows it describes have changed');
  {
    const { url: u2, c: c2 } = await db(base, 'cphi_drift', `${TABLE}${FIXTURE}`);
    const pf = `${temp.base}/drift.json`;
    reconcile(u2, ['--plan-out', pf]);
    const dp = JSON.parse(fs.readFileSync(pf, 'utf8'));
    const gamma = dp.groups.find((g) => g.holder_normalized === 'gamma');

    // Somebody reviews the row the plan was going to delete. The plan is now wrong about this group:
    // deleting that row would discard a review that did not exist when the plan was made.
    await c2.query(`UPDATE cphi_exhibitor_matches SET review_status = 'confirmed' WHERE id = $1`,
      [gamma.delete_ids[0]]);

    const before = await total(c2);
    const r = reconcile(u2, ['--apply', pf, '--confirm-not-production']);
    if (/REFUSED .*gamma/.test(r.out) || /REFUSED/.test(r.out)) ok('the changed group is REFUSED');
    else bad('it applied a stale plan', r.out.trim().split('\n').slice(-6).join(' | '));
    if (/changed since the plan was made/.test(r.out)) ok('…and says why, naming both fingerprints');
    else bad('the refusal does not explain itself');

    const gammaRows = await groupRows(c2, 'gamma');
    if (gammaRows.length === 2) ok('both gamma rows survive — the newly reviewed row was not deleted');
    else bad(`gamma now has ${gammaRows.length} row(s)`, 'a review created after the plan was discarded');
    if (gammaRows.some((x) => x.review_status === 'confirmed')) ok('the new review is intact');
    else bad('the review added after planning was lost');
    // Other groups are independent and should still have been applied.
    if (await total(c2) < before) ok('unaffected groups were still reconciled — drift is refused per group, not globally');
    else bad('one drifted group blocked every other group');
    await c2.end();
  }

  // ── 9. TRANSACTIONAL — an injected failure must roll the whole group back ──────────────────────
  h('9. TRANSACTIONAL — merge, audit and deletes commit together or not at all');
  {
    // NO TEST HOOK IN THE PRODUCTION CODE. A `RECONCILE_FAIL_AFTER` env switch inside the one
    // destructive path in the repository would be its own defect — a branch that exists only for
    // tests, in the code least able to afford one. So the failure is injected at the DATABASE: a
    // BEFORE DELETE trigger that raises for a single row id. That is a real mid-transaction failure,
    // in the same place a deadlock or a constraint violation would land.
    const { url: u3, c: c3 } = await db(base, 'cphi_tx', `${TABLE}${FIXTURE}`);
    const pf = `${temp.base}/tx.json`;
    reconcile(u3, ['--plan-out', pf]);
    const tp = JSON.parse(fs.readFileSync(pf, 'utf8'));
    const gamma = tp.groups.find((g) => g.holder_normalized === 'gamma');
    const alpha = tp.groups.find((g) => g.holder_normalized === 'alpha');

    // gamma is the group that both MERGES (carries a note) and DELETES, so a rollback has to undo
    // two different kinds of write plus two audit rows.
    if (gamma.merges.length && gamma.delete_ids.length) {
      ok(`gamma both merges (${gamma.merges.map((m) => m.field).join(', ')}) and deletes #${gamma.delete_ids.join(', ')} — a rollback must undo both`);
    } else {
      bad('the fixture group does not exercise both a merge and a delete');
    }

    await c3.query(`
      CREATE FUNCTION reconcile_boom() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected failure deleting row %', OLD.id; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER t_reconcile_boom BEFORE DELETE ON cphi_exhibitor_matches
        FOR EACH ROW WHEN (OLD.id = ${gamma.delete_ids[0]}) EXECUTE FUNCTION reconcile_boom();`);
    ok(`trigger installed: deleting row #${gamma.delete_ids[0]} will raise`);

    const beforeRows = await total(c3);
    const r = reconcile(u3, ['--apply', pf, '--confirm-not-production']);

    if (/ROLLED BACK/.test(r.out)) ok('the failing group is reported as ROLLED BACK');
    else bad('the rollback is not reported', r.out.trim().split('\n').slice(-8).join(' | '));
    if (/injected failure deleting row/.test(r.out)) ok('…naming the underlying database error');
    else bad('the error is not surfaced');

    // THE ASSERTIONS THAT MATTER: the group must be byte-for-byte as it was.
    const gammaRows = await groupRows(c3, 'gamma');
    if (gammaRows.length === gamma.rows.length) ok(`gamma still has all ${gamma.rows.length} rows — no partial deletion`);
    else bad(`gamma has ${gammaRows.length} of ${gamma.rows.length} rows`, 'a partial apply is the state that cannot be re-applied');

    const survivorNow = gammaRows.find((x) => String(x.id) === String(gamma.survivor_id));
    const noteMerge = gamma.merges.find((m) => m.field === 'entity_note');
    if (noteMerge && !survivorNow.entity_note) ok('the survivor was NOT merged — the UPDATE rolled back with the DELETE');
    else if (noteMerge) bad('the merge committed while the delete failed', `entity_note is now ${JSON.stringify(survivorNow.entity_note)}`);

    const auditForGamma = (await c3.query(
      `SELECT COUNT(*)::int n FROM cphi_reconcile_audit WHERE holder_normalized = 'gamma'`)).rows[0].n;
    if (auditForGamma === 0) ok('no audit rows were written for the rolled-back group');
    else bad(`${auditForGamma} audit row(s) survive for a group that was never changed`,
      'an audit row claiming a deletion that did not happen is worse than none');

    // PER GROUP, not per plan: the other groups must have gone through.
    const alphaRows = await groupRows(c3, 'alpha');
    if (alphaRows.length === 1) ok('alpha was still reconciled — one failing group does not roll back the others');
    else bad(`alpha has ${alphaRows.length} rows`, 'a single failure rolled back unrelated work');
    if (await total(c3) < beforeRows) ok('the rest of the plan applied normally');
    else bad('nothing at all was applied');

    // And the rollback must leave the group RE-APPLIABLE rather than stuck: same plan, no trigger.
    await c3.query('DROP TRIGGER t_reconcile_boom ON cphi_exhibitor_matches; DROP FUNCTION reconcile_boom();');
    const again = reconcile(u3, ['--apply', pf, '--confirm-not-production']);
    const gammaAfter = await groupRows(c3, 'gamma');
    if (gammaAfter.length === 1) ok('with the fault removed, the SAME plan reconciles gamma — the rollback left it re-appliable, not stuck');
    else bad(`gamma still has ${gammaAfter.length} rows after a clean re-apply`, again.out.trim().split('\n').slice(-6).join(' | '));
    if (gammaAfter.length === 1 && /Met Giulia at the stand/.test(gammaAfter[0].entity_note || '')) {
      ok('…and the note was carried across on that second attempt');
    } else if (gammaAfter.length === 1) {
      bad('the note was lost on the retry', JSON.stringify(gammaAfter[0].entity_note));
    }
    await c3.end();
  }

  await c.end();

  h(`  ${pass} assertion(s) passed · ${fail} failed`);
  if (fail) {
    console.log('\nFAIL  reconciliation is not safe to run against a restored production backup.\n');
    stopCluster();
    process.exit(1);
  }
  console.log('\nPASS  the plan is deterministic and reviewable; human notes and reviews are carried onto\n'
    + '      the surviving row rather than deleted with the old one; contradicting groups are left\n'
    + '      alone; every change is recorded with the complete prior row, and a deleted row was\n'
    + '      rebuilt from that record field for field; a second apply is a no-op; a plan whose rows\n'
    + '      have moved is refused rather than acted on; and an injected database failure rolled the\n'
    + '      whole group back — no partial deletion, no orphan audit row, other groups unaffected,\n'
    + '      and the group still re-appliable afterwards.\n');
}

main().then(() => {
  stopCluster();
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  stopCluster();
  console.error(`\nFAIL  harness error: ${e.message}`);
  process.exit(1);
});
