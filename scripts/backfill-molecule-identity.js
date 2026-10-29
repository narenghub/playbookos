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
let EXECUTE = args.includes('--execute');
const ONLY = (args.find((a) => a.startsWith('--table=')) || '').split('=')[1] || null;

// Unknown flags are rejected rather than ignored. The rotation tooling shipped a run where
// --snapshot silently did nothing because an older script was deployed, and the lesson recorded was
// that a flag nobody validates is a flag that lies.
const KNOWN = ['--execute', '--quiet'];
for (const a of args) {
  if (a.startsWith('--table=')) continue;
  if (!KNOWN.includes(a)) {
    console.error(`unknown flag ${a}. Known: ${KNOWN.join(', ')}, --table=<name>`);
    process.exit(2);
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

  // ── PASS 0: WHICH CAS NUMBERS ARE CONTESTED ACROSS SUBSTANCES ─────────────
  //
  // Read-only, and done before anything is created, because the answer depends on ALL the tables
  // at once: `selumetinib` appears in study_molecules and `binimetinib` may appear in
  // supplier_products, and neither table on its own shows that they claim one registry number.
  // A per-table check would have missed exactly the case this exists for.
  const casOwners = new Map();        // cas -> Set(identity)
  for (const src of SOURCES) {
    if (!(await tableExists(src.table))) continue;
    const w = src.where ? `WHERE ${src.where}` : '';
    const rows = (await Q(`
      SELECT ${src.nameCol} AS nm, ${src.casCol} AS cas FROM ${src.table} ${w}`)).rows;
    for (const r of rows) {
      const id = moleculeKey(r.nm);
      const c = r.cas && validCas(String(r.cas).trim()) ? String(r.cas).trim() : null;
      if (!id || !c) continue;
      const s = casOwners.get(c) || new Set();
      s.add(id);
      casOwners.set(c, s);
    }
  }
  // A CAS claimed by two or more distinct molecule keys. Note this is deliberately computed on the
  // FOLDED key, so a curated synonym pair sharing a number is NOT a contest — that is one
  // substance under two names, which is the whole point of the alias mechanism.
  const contested = new Map();        // identity -> [cas, ...]
  for (const [cas, owners] of casOwners) {
    if (owners.size < 2) continue;
    for (const id of owners) {
      const list = contested.get(id) || [];
      list.push(cas);
      contested.set(id, list);
    }
  }
  console.log(`   contested CAS values: ${[...casOwners.values()].filter((s) => s.size > 1).length}`
    + `, affecting ${contested.size} identities — their canonical cas will be NULL\n`);

  // ── PASS 1: one molecule per distinct identity name ─────────────────────────
  //
  // Grouped by identity rather than by filed name, because `Aspirin` and `Aspirin USP` are the same
  // substance and must not become two rows. The CAS set is collected across the whole group, which
  // is what makes a disagreement visible at all: a single row cannot contradict itself.
  for (const src of SOURCES) {
    if (ONLY && src.table !== ONLY) continue;
    if (!(await tableExists(src.table))) { console.log(`   skip   ${src.table} does not exist`); continue; }

    const w = src.where ? `WHERE ${src.where}` : '';
    const rows = (await Q(`
      SELECT ${src.idCol} AS rid, ${src.nameCol} AS nm, ${src.casCol} AS cas
        FROM ${src.table} ${w}`)).rows;
    stats.rowsSeen += rows.length;

    // identity -> { rows:[{rid,cas}], filed:Set, rec }
    const groups = new Map();
    for (const r of rows) {
      const rec = identityOf(r.nm);
      // THE SAME KEY THE PREVIEW USES. Imported, not reimplemented: a preview whose CREATE count
      // cannot equal the molecules created is a reconciliation that fails for a reason nobody can
      // tell apart from a real defect.
      rec.identity = moleculeKey(r.nm) || rec.identity;
      if (!rec.identity || rec.identity.length < 3) {
        note('unresolvable_name', String(r.nm || ''), null,
          'name is empty or shorter than 3 characters after normalisation — nothing to resolve',
          null, src.table, String(r.rid));
        continue;
      }
      const g = groups.get(rec.identity) || { rows: [], filed: new Set(), rec };
      g.rows.push({ rid: r.rid, cas: r.cas });
      g.filed.add(String(r.nm).trim());
      groups.set(rec.identity, g);
    }

    console.log(`   ${src.table}: ${rows.length} rows -> ${groups.size} distinct substances`);

    for (const [identity, g] of groups) {
      const casSet = new Set(g.rows.map((x) => x.cas).filter((c) => c && validCas(c)).map((c) => String(c).trim()));
      const ids = g.rows.map((x) => x.rid);

      // ── THE REFUSAL ────
      // Two checksum-valid CAS numbers under one identity means the registry considers these
      // different substances while the data files them under one name. Picking either one would
      // put the wrong material on a quotation, and picking "the most common" would make the error
      // a majority vote. Refuse, record, move on.
      if (casSet.size > 1) {
        note('cas_disagreement', [...g.filed].join(' | '), identity,
          `${casSet.size} different checksum-valid CAS numbers filed under one identity — refusing to choose`,
          [...casSet].join(', '), src.table, ids.join(','));
        if (EXECUTE) {
          // IS DISTINCT FROM, so re-running does not rewrite an identical reason. Counted by
          // rowCount for the same reason.
          const u = await Q(
            `UPDATE ${src.table} SET molecule_unresolved_reason = $1
              WHERE ${src.idCol} = ANY($2) AND molecule_id IS NULL
                AND molecule_unresolved_reason IS DISTINCT FROM $1`,
            [`cas_disagreement: ${[...casSet].join(', ')}`, ids]);
          stats.writes += u.rowCount || 0;
        }
        continue;
      }

      const cas = casSet.size === 1 ? [...casSet][0] : null;
      let existing = await resolveExisting(identity);

      // A molecule already on file whose CAS disagrees with this group's is the same refusal, seen
      // from the other side — and it is the case that catches a conflict ACROSS tables, which no
      // single-table query can see.
      if (existing && existing.cas && cas && existing.cas !== cas) {
        note('cas_disagreement', [...g.filed].join(' | '), identity,
          `molecule ${existing.id} is on file as CAS ${existing.cas}; this source says ${cas}`,
          `${existing.cas}, ${cas}`, src.table, ids.join(','));
        if (EXECUTE) {
          const u = await Q(
            `UPDATE ${src.table} SET molecule_unresolved_reason = $1
              WHERE ${src.idCol} = ANY($2) AND molecule_id IS NULL
                AND molecule_unresolved_reason IS DISTINCT FROM $1`,
            [`cas_disagreement with molecule ${existing.id}: ${existing.cas} vs ${cas}`, ids]);
          stats.writes += u.rowCount || 0;
        }
        continue;
      }

      // ── DECISION 1 APPLIED AT THE WRITE ────
      // The name proceeds, the contested attribute does not. Source values are kept in
      // cas_source_values so nothing is discarded and no owner is chosen.
      const isContested = contested.has(identity);
      const casToWrite = isContested ? null : cas;
      const suppressedReason = isContested
        ? `cas_contested:${contested.get(identity).join(',')}`
        : (cas ? null : (g.rows.some((x) => x.cas && !validCas(x.cas))
          ? 'cas_present_invalid' : 'cas_missing'));
      const casSourceValues = isContested
        ? contested.get(identity).join(',')
        : (cas ? null : [...new Set(g.rows.map((x) => x.cas).filter(Boolean))].join(',') || null);

      // Everything from here to the row link is ONE unit of work for this identity. In EXECUTE
      // mode it runs inside a transaction so the molecule, its aliases, its contest record and its
      // links commit together or not at all; `q` is the transaction's client there and the plain
      // handle otherwise, so the dry-run path reads identically.
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
              `backfill:${src.table}`, ids.slice(0, 20).join(','),
              // The form is DERIVED from the name; the name and CAS are OBSERVED. Saying so is the
              // P1 rule against silently promoting a derived fact to a sourced one.
              'name_observed:form_derived', casToWrite ? 'high' : 'medium',
              suppressedReason, casSourceValues],
          );
          if (ins.rowCount) { stats.moleculesCreated += 1; stats.writes += 1; existing = { id: ins.rows[0].id, cas: ins.rows[0].cas }; }
          else existing = await resolveExisting(identity);   // lost a race; adopt the winner
        } else {
          stats.moleculesCreated += 1;
          existing = { id: null, cas };
        }
      }

      // ── ALIASES: same substance, other name ────
      for (const alias of g.rec.aliases) {
        if (!EXECUTE) { stats.aliasesCreated += 1; continue; }
        const taken = await q(`SELECT molecule_id FROM molecule_aliases WHERE alias = $1`, [alias]);
        if (taken.rowCount) {
          if (existing && taken.rows[0].molecule_id !== existing.id) {
            note('alias_collision', alias, identity,
              `alias already belongs to molecule ${taken.rows[0].molecule_id}, not ${existing.id}`,
              null, src.table, ids.join(','));
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
            null, src.table, ids.join(','));
          continue;
        }
        if (ownedByOther.rowCount) continue;      // it IS this molecule; nothing to add
        if (!existing || !existing.id) continue;
        await q(
          `INSERT INTO molecule_aliases (molecule_id, alias, alias_type, source, confidence)
           VALUES ($1,$2,'inn',$3,'high') ON CONFLICT (alias) DO NOTHING`,
          [existing.id, alias, `backfill:${src.table}`]);
        stats.aliasesCreated += 1; stats.writes += 1;
      }

      // The contest itself is recorded as evidence, so "why is this cas NULL" is answerable from
      // the database rather than by re-running the analysis.
      if (EXECUTE && isContested) {
        const key = `cas_contested|${identity}|${src.table}|${contested.get(identity).join(',')}`.slice(0, 500);
        const c = await q(
          `INSERT INTO molecule_conflicts
             (kind, filed_name, identity_name, detail, cas_values, source_table, source_ids, conflict_key)
           VALUES ('cas_contested',$1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (conflict_key) WHERE resolved_at IS NULL DO NOTHING`,
          [[...g.filed][0].slice(0, 500), identity,
            'CAS claimed by more than one distinct molecule key — canonical cas withheld, no owner chosen',
            contested.get(identity).join(','), src.table, ids.slice(0, 20).join(','), key]);
        stats.writes += c.rowCount || 0;
      }

      // ── LINK THE SOURCE ROWS ────
      if (EXECUTE && existing && existing.id) {
        const upd = await q(
          `UPDATE ${src.table} SET molecule_id = $1, molecule_unresolved_reason = NULL
            WHERE ${src.idCol} = ANY($2) AND molecule_id IS NULL`,
          [existing.id, ids]);
        if (upd.rowCount) { stats.rowsLinked += upd.rowCount; stats.writes += 1; }
      } else if (!EXECUTE) {
        stats.rowsLinked += g.rows.length;
      }
      };  // end applyIdentity

      if (EXECUTE) {
        // A failure here rolls this identity back entirely and is re-raised, so the run stops
        // rather than continuing past a half-applied substance. Earlier identities stay committed
        // and a re-run resumes from them — which is what restartable means.
        await TX(async (client) => applyIdentity((text, params) => client.query(text, params)));
      } else {
        await applyIdentity(Q);
      }
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
