#!/usr/bin/env node
// ── E1: LINK THE THREE OPERATIONAL TABLES TO THE MOLECULE SPINE ──────────────
//
//   node scripts/backfill-molecule-identity.js             DRY RUN — writes nothing
//   node scripts/backfill-molecule-identity.js --execute
//   node scripts/backfill-molecule-identity.js --execute --table=study_molecules
//
// Exit 0 = the pass completed (a quarantined conflict is a RESULT, not a failure).
// Exit 1 = it could not run, or --execute hit something it refused to decide and said so.
//
// ── THE ONE RULE THIS SCRIPT EXISTS TO HONOUR ───────────────────────────────
//
// It derives every mapping from the data in front of it and hard-codes none. There is no list of
// "known" merges in this file, because the CAS-conflict census has not been run against production
// yet and a mapping written ahead of it would be a guess wearing the clothes of a decision.
//
// When the data contradicts itself, the row is QUARANTINED and left unlinked. It is never resolved
// by picking. `molecule_conflicts` is append-only by trigger, so the list of things a human must
// rule on cannot be quietly tidied away, and `molecule_unresolved_reason` on the source row is what
// distinguishes "attempted and refused" from "not yet attempted" — a NULL molecule_id with no
// reason means the backfill has not reached it.
//
// ── IDEMPOTENCE IS ASSERTED, NOT INTENDED ───────────────────────────────────
//
// Running twice must change nothing the second time. The script reports writes per pass, and
// scripts/check-molecule-identity-db.js runs it twice and FAILS if the second pass writes anything.
// "It should be idempotent" is a comment; a second pass that writes zero rows is evidence.
'use strict';

const { initDB, query, withTransaction } = require('../src/lib/db');
const { validCas } = require('../src/lib/catalogue/cas');
// Imported directly and NEVER injectable. identityOf is pure, and taking it from a stub would mean
// a checker could accidentally blank the identity rules and still pass — the guard would then be
// tested against logic nothing in production uses. The same reasoning as scopesForCron in
// cron-alerts.js: only the DB-touching half is replaceable.
const { identityOf, moleculeKey } = require('../src/lib/molecules/identity');
// THE AUTHORITY. Not a second opinion: executionSet.CREATE is the only thing that may be created.
const { analyze } = require('../src/lib/molecules/preview');

// The database handle. Production uses src/lib/db; scripts/check-molecule-identity-db.js injects a
// pool pointed at a throwaway cluster so the REAL backfill runs against a real server, rather than
// a reimplementation of it being tested instead.
let Q = query;

// ── PER-IDENTITY ATOMICITY ──────────────────────────────────────────────────
//
// Every statement below is independently idempotent, so a crash is already recoverable: the rows
// keep molecule_id NULL and a re-run links them. But "recoverable" and "never partially applied"
// are different promises, and the second is the one that was asked for — a failure must not leave
// an identity partially treated as migrated.
//
// So the molecule, its aliases, its contest record and its row links commit together or not at
// all. Per identity rather than one transaction for all 2,428: a single enormous transaction
// holds locks across the whole run and turns any failure into a total rollback, which is the
// opposite of restartable. This way a crash leaves earlier identities finished, later ones
// untouched, and none half-done.
let TX = withTransaction;

const args = process.argv.slice(2);
// Gated on require.main for the same reason as the flag guard below, but this one is a write hazard
// rather than an annoyance: imported by a script that happened to be invoked with --execute, this
// module would default to writing to production. A caller gets execution only by asking for it in
// deps, never by inheriting the argv of a process it knows nothing about.
let EXECUTE = require.main === module && args.includes('--execute');

// --table= IS GONE. It restricted the run to one source table, and a run restricted to one table
// cannot make a correct decision: identities are grouped across all three, because a CAS conflict in
// study_molecules has to be visible while supplier_products is being processed. Narrowing the input
// would narrow the analysis and quietly produce a different answer, which is the defect this whole
// rewrite exists to remove. It is rejected rather than ignored, so an old invocation fails loudly.

// Unknown flags are rejected rather than ignored. The rotation tooling shipped a run where
// --snapshot silently did nothing because an older script was deployed, and the lesson recorded was
// that a flag nobody validates is a flag that lies.
//
// It runs ONLY as a program. e1-reconcile.js requires this file to re-run main() for the idempotency
// proof, and a module-scope guard reads the argv of whatever process imported it — so reconcile's own
// flags were rejected by its dependency, at import, before reconcile's code ran. A library does not
// get to validate its caller's command line.
const KNOWN = ['--execute', '--quiet'];
if (require.main === module) {
  for (const a of args) {
    if (a.startsWith('--table=')) {
      console.error('--table= is no longer supported: identities are grouped across all source '
        + 'tables, so restricting the input would change the decision. Run without it.');
      process.exit(2);
    }
    if (!KNOWN.includes(a)) {
      console.error(`unknown flag ${a}. Known: ${KNOWN.join(', ')}`);
      process.exit(2);
    }
  }
}

const SOURCES = [
  { table: 'study_molecules', idCol: 'id', nameCol: 'molecule_name', casCol: 'cas_number', where: null },
  { table: 'research_interests', idCol: 'id', nameCol: 'value', casCol: 'cas', where: `kind = 'molecule'` },
  { table: 'supplier_products', idCol: 'id', nameCol: 'product_name', casCol: 'cas', where: null },
];

const stats = {
  rowsSeen: 0, moleculesCreated: 0, aliasesCreated: 0, rowsLinked: 0,
  parentsLinked: 0, quarantined: 0, writes: 0,
};
const conflicts = [];

function note(kind, filed, identity, detail, casValues, table, ids) {
  conflicts.push({ kind, filed, identity, detail, casValues, table, ids });
}

async function tableExists(name) {
  const r = await Q(`SELECT to_regclass($1) IS NOT NULL ok`, [name]);
  return !!(r.rows[0] && r.rows[0].ok);
}

/** Find the molecule a name already resolves to: its own identity first, then the alias table. */
async function resolveExisting(identity) {
  const own = await Q(`SELECT id, cas, substance_form FROM molecules WHERE normalized_name = $1`, [identity]);
  if (own.rowCount) return { id: own.rows[0].id, cas: own.rows[0].cas, via: 'identity' };
  const al = await Q(
    `SELECT m.id, m.cas FROM molecule_aliases a JOIN molecules m ON m.id = a.molecule_id
      WHERE a.alias = $1`, [identity]);
  if (al.rowCount) return { id: al.rows[0].id, cas: al.rows[0].cas, via: 'alias' };
  return null;
}

// The analyser reports a reason string; molecule_conflicts.kind is a constrained vocabulary that
// predates it. Mapping the one onto the other keeps the quarantine queryable by category — "show me
// every corrupted name" stays a WHERE clause — instead of collapsing five distinct findings into one
// bucket called "the analyser said no" with the real answer buried in free text.
function kindOfReason(reason) {
  const r = String(reason || '');
  if (r.startsWith('corrupted_name:')) return 'corrupted_name';
  if (r.startsWith('ambiguous_form:')) return 'ambiguous_form';
  if (r.startsWith('duplicate_risk:')) return 'duplicate_risk';
  if (r.startsWith('insufficient_identity:')) return 'insufficient_identity';
  if (r.startsWith('cas_disagreement:')) return 'cas_disagreement';
  // A reason shape nobody mapped. Deliberately NOT silently bucketed as something plausible: an
  // unmapped category means the analyser grew a rule this script has not been taught, and that is
  // the exact drift that produced the 29 Oct run.
  return 'unmapped_exclusion_reason';
}

async function main(deps = {}) {
  if (deps.query) Q = deps.query; else await initDB();
  if (deps.withTransaction) TX = deps.withTransaction;
  if (deps.execute !== undefined) EXECUTE = deps.execute;
  // Reset the counters so a second pass in the same process reports its OWN writes rather than a
  // running total — the idempotence assertion depends on this being per-pass.
  Object.keys(stats).forEach((k) => { stats[k] = 0; });
  conflicts.length = 0;
  const commit = String(process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || 'local';
  console.log(`\n═══ molecule identity backfill · ${EXECUTE ? 'EXECUTE' : 'DRY RUN (writes nothing)'} · ${commit} ═══\n`);

  const needed = await tableExists('molecules');
  if (!needed) {
    console.error('molecules table does not exist — run scripts/migrate-molecules.js first');
    process.exit(1);
  }

  // ── PASS 0: READ EVERY SOURCE ROW ONCE, THEN ASK THE ANALYSER ─────────────
  //
  // This replaces a hand-rolled contest computation and a per-table grouping loop, and it is the
  // whole lesson of the 29 Oct migration.
  //
  // That run created 2466 molecules where the authorised preview said 2428. The cause was not a bug
  // in either file: it was that there were TWO implementations of "what may be created". The preview
  // had five exclusion categories; this script re-derived its own rule from scratch and had one. So
  // AMBIGUOUS_FORM, DUPLICATE_RISK, QUARANTINE_CORRUPTED_NAME and the generic-fragment rule existed
  // only in the analyser, and 27 identities the report promised to withhold were created anyway.
  //
  // The report described behaviour the code did not have. There is now ONE authority: analyze() over
  // all rows from all tables, and nothing outside executionSet.CREATE may be created. This script no
  // longer decides anything — it executes a decision and records the reason for every refusal.
  const allRows = [];
  for (const src of SOURCES) {
    if (!(await tableExists(src.table))) { console.log(`   skip   ${src.table} does not exist`); continue; }
    const w = src.where ? `WHERE ${src.where}` : '';
    const rows = (await Q(`
      SELECT ${src.idCol} AS rid, ${src.nameCol} AS nm, ${src.casCol} AS cas
        FROM ${src.table} ${w}`)).rows;
    rows.forEach((r) => allRows.push({ table: src.table, rid: r.rid, name: r.nm, cas: r.cas }));
    console.log(`   ${src.table}: ${rows.length} rows`);
  }
  stats.rowsSeen = allRows.length;

  const A = analyze(allRows);
  const CREATE = new Set(A.executionSet.CREATE);
  const contested = A.casContested;                       // one CAS, several identities
  const withinIdentity = A.casContestedWithinIdentity;    // one identity, several CAS
  console.log(`\n   analyser: ${A.e1.groups.size} identities proposed`
    + `, ${CREATE.size} in CREATE, ${A.exclusionReasons.size} excluded with a reason`);
  console.log(`   contested CAS values: ${contested.size} identity/ies affected across substances`
    + `, ${withinIdentity.size} identity/ies holding more than one — canonical cas NULL for both\n`);

  // ── PASS 1: ONE MOLECULE PER IDENTITY, GROUPED ACROSS ALL TABLES ───────────
  //
  // Grouped across tables, not within each one. Per-table grouping is how `elacestrant` ended up
  // both quarantined and created on the same run: its CAS conflict lived in study_molecules, so the
  // supplier_products pass saw three clean rows with no CAS at all and created it.
  const groups = new Map();   // identity -> { rows:[{table,rid,cas}], filed:Set, rec }
  for (const r of allRows) {
    const rec = identityOf(r.name);
    // THE SAME KEY THE ANALYSER USES. Imported, not reimplemented.
    rec.identity = moleculeKey(r.name) || rec.identity;
    if (!rec.identity || rec.identity.length < 3) {
      note('unresolvable_name', String(r.name || ''), null,
        'name is empty or shorter than 3 characters after normalisation — nothing to resolve',
        null, r.table, String(r.rid));
      continue;
    }
    // The group's record is derived from the CANONICAL identity, not from whichever row happened to
    // arrive first, and every other spelling seen in the data is collected as an alias.
    //
    // Taking it from the first row is what broke paracetamol. identityOf('Paracetamol') reports
    // aliases ['acetaminophen'] — the canonical name itself — so the alias insert saw "it IS this
    // molecule, nothing to add" and `paracetamol` never became an alias of anything. Per-table
    // processing had hidden it: the supplier row spelled 'Acetaminophen', whose alias list is
    // ['paracetamol'], and that pass created the edge the research_interests pass had missed.
    // Grouped across tables there is only one record, so it has to be the right one.
    const key = rec.identity;
    const g = groups.get(key)
      || { rows: [], filed: new Set(), rec: identityOf(key), spellings: new Set() };
    if (rec.identity !== key) g.spellings.add(rec.identity);
    const own = identityOf(r.name).identity;
    if (own && own !== key) g.spellings.add(own);
    g.rows.push({ table: r.table, rid: r.rid, cas: r.cas });
    g.filed.add(String(r.name).trim());
    groups.set(key, g);
  }
  // Curated synonyms plus every spelling the data actually used, minus the identity itself.
  for (const [identity, g] of groups) {
    g.aliases = [...new Set([...(g.rec.aliases || []), ...g.spellings])].filter((x) => x && x !== identity);
  }
  console.log(`   ${allRows.length} rows -> ${groups.size} distinct substances (all tables together)\n`);

  // Refusing rows means one UPDATE per source table, since each has its own id column.
  const byTable = (rows) => {
    const m = new Map();
    for (const x of rows) { const l = m.get(x.table) || []; l.push(x.rid); m.set(x.table, l); }
    return m;
  };
  const refuseRows = async (q, rows, reason) => {
    let n = 0;
    for (const [table, ids] of byTable(rows)) {
      const src = SOURCES.find((s) => s.table === table);
      // IS DISTINCT FROM, so re-running does not rewrite an identical reason. Counted by rowCount.
      const u = await q(
        `UPDATE ${table} SET molecule_unresolved_reason = $1
          WHERE ${src.idCol} = ANY($2) AND molecule_id IS NULL
            AND molecule_unresolved_reason IS DISTINCT FROM $1`,
        [reason.slice(0, 500), ids]);
      n += u.rowCount || 0;
    }
    return n;
  };

  for (const [identity, g] of groups) {
    const ids = g.rows.map((x) => x.rid);

    // ── THE ONE DECISION, TAKEN ELSEWHERE ────
    // Not in CREATE means the analyser withheld it and said why. This script does not re-litigate
    // that and does not have a rule of its own to fall back on.
    if (!CREATE.has(identity)) {
      const reason = A.exclusionReasons.get(identity)
        || 'excluded_by_analyser:classification_without_reason';
      note(kindOfReason(reason), [...g.filed].join(' | '), identity, reason,
        null, [...byTable(g.rows).keys()].join('+'), ids.join(','));
      if (EXECUTE) stats.writes += await refuseRows(Q, g.rows, reason);
      continue;
    }

    // ── DECISION 1 APPLIED AT THE WRITE ────
    // The name proceeds, the contested attribute does not. Source values are kept in
    // cas_source_values so nothing is discarded and no owner is chosen. Two shapes of contest reach
    // this point and both withhold the canonical CAS: one number claimed by several substances, and
    // one substance filed under several numbers.
    const casSet = new Set(g.rows.map((x) => x.cas).filter((c) => c && validCas(c)).map((c) => String(c).trim()));
    const disputed = withinIdentity.get(identity) || null;
    const isContested = contested.has(identity) || !!disputed;
    const cas = casSet.size === 1 ? [...casSet][0] : null;
    const casToWrite = isContested ? null : cas;
    const contestValues = disputed
      ? disputed.join(',')
      : (contested.has(identity) ? [...contested.get(identity)].join(',') : null);
    const suppressedReason = disputed
      ? `cas_contested_within_identity:${contestValues}`
      : (contested.has(identity)
        ? `cas_contested:${contestValues}`
        : (cas ? null : (g.rows.some((x) => x.cas && !validCas(x.cas))
          ? 'cas_present_invalid' : 'cas_missing')));
    const casSourceValues = isContested
      ? contestValues
      : (cas ? null : [...new Set(g.rows.map((x) => x.cas).filter(Boolean))].join(',') || null);

    // ── WHICH ROWS MAY LINK ────
    // Where one identity holds several valid CAS numbers, the rows carrying a disputed number are
    // the ones that might have meant a salt rather than the base, so they stay unresolved. A row
    // that named only the substance committed to nothing it can be wrong about, and links.
    // Recorded through note() as well as the evidence row below, because `quarantined` is what the
    // run reports and what the checker asserts. Inserting the evidence row directly and counting
    // nothing made a fixture built to cause a quarantine report zero — the refusal happened, the
    // rows were held back, and the summary said all clear.
    if (disputed) {
      note('cas_contested_within_identity', [...g.filed].join(' | '), identity,
        `one substance filed under ${disputed.length} checksum-valid CAS numbers — canonical cas `
        + 'withheld, and the rows naming a disputed number stay unresolved',
        disputed.join(','), [...byTable(g.rows).keys()].join('+'), ids.join(','));
    }

    const disputedSet = new Set(disputed || []);
    const linkable = disputed
      ? g.rows.filter((x) => !(x.cas && disputedSet.has(String(x.cas).trim())))
      : g.rows;
    const refused = disputed ? g.rows.filter((x) => !linkable.includes(x)) : [];

    let existing = await resolveExisting(identity);

    // A molecule already on file whose CAS disagrees with this group's. On a first run the analyser
    // has already seen every row, so this can only fire on a RE-RUN against rows added since — which
    // is exactly when it is worth having.
    if (existing && existing.cas && cas && existing.cas !== cas) {
      note('cas_disagreement', [...g.filed].join(' | '), identity,
        `molecule ${existing.id} is on file as CAS ${existing.cas}; this source says ${cas}`,
        `${existing.cas}, ${cas}`, [...byTable(g.rows).keys()].join('+'), ids.join(','));
      if (EXECUTE) {
        stats.writes += await refuseRows(Q, g.rows,
          `cas_disagreement with molecule ${existing.id}: ${existing.cas} vs ${cas}`);
      }
      continue;
    }

    // Everything from here to the row link is ONE unit of work for this identity. In EXECUTE mode it
    // runs inside a transaction so the molecule, its aliases, its contest record and its links
    // commit together or not at all; `q` is the transaction's client there and the plain handle
    // otherwise, so the dry-run path reads identically.
    const applyIdentity = async (q) => {
      if (!existing) {
        if (EXECUTE) {
          const ins = await q(
            `INSERT INTO molecules
               (preferred_name, normalized_name, cas, substance_form, derived_base_name,
                form_tokens, source, raw_reference, derivation_method, confidence,
                cas_suppressed_reason, cas_source_values)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             ON CONFLICT (normalized_name) DO NOTHING
             RETURNING id, cas`,
            [[...g.filed][0], identity, casToWrite, g.rec.form, g.rec.derivedBase,
              g.rec.formTokens.length ? g.rec.formTokens.join(' ') : null,
              `backfill:${[...byTable(g.rows).keys()].join('+')}`, ids.slice(0, 20).join(','),
              // The form is DERIVED from the name; the name and CAS are OBSERVED. Saying so is the
              // P1 rule against silently promoting a derived fact to a sourced one.
              'name_observed:form_derived', casToWrite ? 'high' : 'medium',
              suppressedReason, casSourceValues],
          );
          if (ins.rowCount) { stats.moleculesCreated += 1; stats.writes += 1; existing = { id: ins.rows[0].id, cas: ins.rows[0].cas }; }
          else existing = await resolveExisting(identity);   // lost a race; adopt the winner
        } else {
          stats.moleculesCreated += 1;
          existing = { id: null, cas: casToWrite };
        }
      }

      // ── ALIASES: same substance, other name ────
      for (const alias of g.aliases) {
        if (!EXECUTE) { stats.aliasesCreated += 1; continue; }
        const taken = await q(`SELECT molecule_id FROM molecule_aliases WHERE alias = $1`, [alias]);
        if (taken.rowCount) {
          if (existing && taken.rows[0].molecule_id !== existing.id) {
            note('alias_collision', alias, identity,
              `alias already belongs to molecule ${taken.rows[0].molecule_id}, not ${existing.id}`,
              null, [...byTable(g.rows).keys()].join('+'), ids.join(','));
          }
          continue;
        }
        // A name that is already some molecule's OWN identity must not be forced into an alias —
        // the trigger would refuse it, and a refusal inside a loop would abort the whole pass. So
        // it is detected here and recorded as the conflict it is.
        const ownedByOther = await q(`SELECT id FROM molecules WHERE normalized_name = $1`, [alias]);
        if (ownedByOther.rowCount && existing && ownedByOther.rows[0].id !== existing.id) {
          note('alias_collision', alias, identity,
            `"${alias}" is the identity of molecule ${ownedByOther.rows[0].id}; not aliasing it to ${existing.id}`,
            null, [...byTable(g.rows).keys()].join('+'), ids.join(','));
          continue;
        }
        if (ownedByOther.rowCount) continue;      // it IS this molecule; nothing to add
        if (!existing || !existing.id) continue;
        // ON CONFLICT DO NOTHING means the statement can be a no-op. Counting it unconditionally is
        // what made the idempotency proof report "the re-run wrote 26 times" while created=0 and
        // linked=0 — a phantom. The row count is the write count.
        const ins = await q(
          `INSERT INTO molecule_aliases (molecule_id, alias, alias_type, source, confidence)
           VALUES ($1,$2,'inn',$3,'high') ON CONFLICT (alias) DO NOTHING`,
          [existing.id, alias, `backfill:${[...byTable(g.rows).keys()].join('+')}`]);
        stats.aliasesCreated += ins.rowCount; stats.writes += ins.rowCount;
      }

      // The contest itself is recorded as evidence, so "why is this cas NULL" is answerable from
      // the database rather than by re-running the analysis.
      // Only the CROSS-identity contest is written here. The within-identity one went through
      // note() above and is written by the loop at the end of the run — writing it in both places
      // produced two rows for one finding, because the two paths build different conflict_keys and
      // the ON CONFLICT dedupe therefore never saw them as the same thing.
      if (EXECUTE && contested.has(identity)) {
        const key = `cas_contested|${identity}|${contestValues}`.slice(0, 500);
        const c = await q(
          `INSERT INTO molecule_conflicts
             (kind, filed_name, identity_name, detail, cas_values, source_table, source_ids, conflict_key)
           VALUES ('cas_contested',$1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (conflict_key) WHERE resolved_at IS NULL DO NOTHING`,
          [[...g.filed][0].slice(0, 500), identity,
            'CAS claimed by more than one distinct molecule key — canonical cas withheld, no owner chosen',
            contestValues, [...byTable(g.rows).keys()].join('+'), ids.slice(0, 20).join(','), key]);
        stats.writes += c.rowCount || 0;
      }

      // ── LINK THE SOURCE ROWS ────
      if (EXECUTE && existing && existing.id) {
        for (const [table, tids] of byTable(linkable)) {
          const src = SOURCES.find((s) => s.table === table);
          const upd = await q(
            `UPDATE ${table} SET molecule_id = $1, molecule_unresolved_reason = NULL
              WHERE ${src.idCol} = ANY($2) AND molecule_id IS NULL`,
            [existing.id, tids]);
          if (upd.rowCount) { stats.rowsLinked += upd.rowCount; stats.writes += upd.rowCount; }
        }
        if (refused.length) {
          stats.writes += await refuseRows(q, refused,
            `cas_contested_within_identity:${contestValues} — this row names one of the disputed numbers`);
        }
      } else if (!EXECUTE) {
        stats.rowsLinked += linkable.length;
      }
    };  // end applyIdentity

    if (EXECUTE) {
      // A failure here rolls this identity back entirely and is re-raised, so the run stops rather
      // than continuing past a half-applied substance. Earlier identities stay committed and a
      // re-run resumes from them — which is what restartable means.
      await TX(async (client) => applyIdentity((text, params) => client.query(text, params)));
    } else {
      await applyIdentity(Q);
    }
  }

  // ── PASS 2: PARENT EDGES, ONLY WHERE THE BASE WAS INDEPENDENTLY OBSERVED ───
  //
  // This is where the temptation to invent lives. `testosterone enanthate` implies a base called
  // `testosterone`, and creating that row would make the graph tidy — and would file a derived
  // fact as an observed one. So the base is linked ONLY if a molecule with that name exists
  // because the data contained it. Otherwise derived_base_name keeps the answer for a later pass,
  // and the child simply has no parent, which is an honest state rather than a missing one.
  if (await tableExists('molecules')) {
    const orphans = (await Q(`
      SELECT id, normalized_name, derived_base_name FROM molecules
       WHERE derived_base_name IS NOT NULL AND parent_molecule_id IS NULL AND substance_form <> 'base'`)).rows;
    for (const m of orphans) {
      const base = await Q(`SELECT id FROM molecules WHERE normalized_name = $1`, [m.derived_base_name]);
      if (!base.rowCount) continue;
      if (base.rows[0].id === m.id) continue;
      if (EXECUTE) {
        await Q(`UPDATE molecules SET parent_molecule_id = $1 WHERE id = $2 AND parent_molecule_id IS NULL`,
          [base.rows[0].id, m.id]);
        stats.writes += 1;
      }
      stats.parentsLinked += 1;
    }
  }

  // ── RECORD WHAT WE REFUSED ────
  stats.quarantined = conflicts.length;
  if (EXECUTE) {
    for (const c of conflicts) {
      // The dedupe key, and the partial unique index behind it, are why a re-run does not pile up
      // identical refusals on a table that forbids DELETE. source_ids is deliberately NOT part of
      // the key: one more study filed under the same disputed name is the same dispute, and
      // including the row ids would make every new row a "new" conflict.
      const key = `${c.kind}|${c.identity || c.filed}|${c.table}|${c.casValues || ''}`.slice(0, 500);
      const ins = await Q(
        `INSERT INTO molecule_conflicts
           (kind, filed_name, identity_name, detail, cas_values, source_table, source_ids, conflict_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (conflict_key) WHERE resolved_at IS NULL DO NOTHING`,
        [c.kind, c.filed.slice(0, 500), c.identity, c.detail, c.casValues, c.table,
          String(c.ids).slice(0, 2000), key]);
      // Counted by rowCount, not by having issued the statement: a DO NOTHING changed nothing, and
      // calling it a write would make the idempotence assertion unsatisfiable.
      stats.writes += ins.rowCount || 0;
    }
  }

  // ── REPORT ────
  console.log('');
  const r = (l, v) => console.log(`   ${String(l).padEnd(34)} ${v}`);
  r('source rows examined', stats.rowsSeen);
  r('molecules created', stats.moleculesCreated);
  r('aliases created', stats.aliasesCreated);
  r('source rows linked', stats.rowsLinked);
  r('parent edges linked', stats.parentsLinked);
  r('QUARANTINED (refused to decide)', stats.quarantined);
  r('write statements issued', EXECUTE ? stats.writes : '0 (dry run)');

  if (conflicts.length) {
    console.log('\n   ── every refusal, in full. These are the rows a human must rule on. ──');
    const byKind = {};
    conflicts.forEach((c) => { (byKind[c.kind] = byKind[c.kind] || []).push(c); });
    for (const kind of Object.keys(byKind)) {
      console.log(`\n   ${kind}  (${byKind[kind].length})`);
      byKind[kind].slice(0, 50).forEach((c) => {
        console.log(`     ${c.filed}`);
        console.log(`       ${c.detail}`);
        if (c.casValues) console.log(`       CAS seen: ${c.casValues}`);
        console.log(`       ${c.table} rows: ${String(c.ids).slice(0, 120)}`);
      });
      if (byKind[kind].length > 50) console.log(`     … and ${byKind[kind].length - 50} more (all are written to molecule_conflicts)`);
    }
  }

  console.log('');
  if (!EXECUTE) {
    console.log('   DRY RUN — nothing was written. Re-run with --execute to apply.');
    console.log('   The counts above are what WOULD happen, computed against the live data.\n');
  } else {
    console.log('   Applied. Re-running must now report 0 writes; that is what');
    console.log('   scripts/check-molecule-identity-db.js asserts.\n');
  }
  // Returned so a caller can assert on the counts instead of parsing stdout. Reading a verdict out
  // of a multi-line report is how production went down on 2026-09-30.
  return { ...stats, conflicts: conflicts.map((c) => ({ ...c })) };
}

module.exports = { main, SOURCES };

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error(`\n✗ backfill failed: ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  });
}
