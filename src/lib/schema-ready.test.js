// ── DOES BOOT REFUSE A SCHEMA THAT IS ONLY PARTLY MIGRATED? ──────────────────
//
//   node --test src/lib/schema-ready.test.js
//
// scripts/check-previous-release-compat.js already runs check() against a REAL migrated Postgres
// and asserts it passes. That proves the happy path and the SQL. It cannot prove the refusals,
// because a correctly migrated database has nothing missing — so the failure branches are
// driven here, with the query stubbed.
//
// This matters most for the CHECK-constraint branch, added 2026-11-11. S2 records a held buyer
// letter as direction='outbound_pending'. Deploy that against an unwidened constraint and the
// server starts, answers /health 200 with db: connected, and silently fails to record the draft an
// operator is being asked to approve — "green from outside, broken in use", which is the shape of
// the 2026-09-30 outage and of the outreach.partner_id defect this file already records.

'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const SR = require('./schema-ready');

// A stub that answers every readiness probe healthily, with hooks to break one thing at a time.
function fakeQuery({ missingTable = null, missingColumn = null, constraintDef = undefined } = {}) {
  return async (sql, params = []) => {
    if (/to_regclass/.test(sql)) {
      return { rows: [{ present: params[0] !== `public.${missingTable}` }] };
    }
    if (/information_schema\.columns/.test(sql)) {
      const [t, c] = params;
      const hit = missingColumn && missingColumn[0] === t && missingColumn[1] === c;
      return { rows: [{ present: !hit }] };
    }
    if (/pg_get_constraintdef/.test(sql)) {
      if (constraintDef === undefined) {
        // The migrated shape.
        return { rows: [{ def: "CHECK (direction = ANY (ARRAY['inbound'::text, 'outbound'::text, 'outbound_pending'::text]))" }] };
      }
      return { rows: constraintDef === null ? [] : [{ def: constraintDef }] };
    }
    throw new Error(`unexpected probe: ${sql.slice(0, 60)}`);
  };
}

test('a fully migrated schema is ready', async () => {
  const r = await SR.check(fakeQuery());
  assert.strictEqual(r.ready, true);
  assert.deepStrictEqual(r.staleConstraints, []);
});

test('an UNWIDENED direction constraint refuses the boot', async () => {
  // The exact pre-migration shape. A constraint of the right NAME that forbids the value is
  // exactly as broken as a missing one, which is why this checks the DEFINITION, not existence.
  const r = await SR.check(fakeQuery({
    constraintDef: "CHECK (direction = ANY (ARRAY['inbound'::text, 'outbound'::text]))" }));
  assert.strictEqual(r.ready, false);
  assert.deepStrictEqual(r.staleConstraints,
    ["inquiry_messages.inquiry_messages_direction_check does not admit 'outbound_pending'"]);
});

test('a missing constraint is reported as absent, not as the wrong predicate', async () => {
  const r = await SR.check(fakeQuery({ constraintDef: null }));
  assert.strictEqual(r.ready, false);
  assert.match(r.staleConstraints[0], /is absent/);
});

test('a missing table and a missing column are still reported separately', async () => {
  // The pre-existing branches, kept exercised: a change to the constraint logic must not quietly
  // break the two checks that were already there.
  const t = await SR.check(fakeQuery({ missingTable: 'federal_opportunities' }));
  assert.ok(t.missingTables.includes('federal_opportunities'));

  const c = await SR.check(fakeQuery({ missingColumn: ['outreach', 'partner_id'] }));
  assert.deepStrictEqual(c.missingColumns, ['outreach.partner_id']);
});

test('a constraint check is skipped when its whole table is missing', async () => {
  // "the constraint does not admit X" is noise when the table itself is absent, and it would
  // triple the output on a fresh database.
  const r = await SR.check(fakeQuery({ missingTable: 'inquiry_messages' }));
  assert.deepStrictEqual(r.staleConstraints, []);
  assert.ok(r.missingTables.includes('inquiry_messages'));
});

test('a stale constraint is named in the boot output', async () => {
  // Reported in its own words: "stale constraint" and "missing column" send a reader to different
  // places, and a refusal nobody can act on gets worked around.
  const lines = [];
  let code = null;
  await SR.assertReadyOrExit(
    fakeQuery({ constraintDef: "CHECK (direction = ANY (ARRAY['inbound'::text]))" }),
    { log: () => {}, err: (m) => lines.push(String(m)), exit: (c) => { code = c; } });
  assert.strictEqual(code, 1, 'boot did not refuse');
  assert.ok(lines.some((l) => /stale constraint/.test(l)), 'the stale constraint is not reported');
  assert.ok(lines.some((l) => /node scripts\/migrate\.js/.test(l)),
    'the output does not say how to fix it');
});

test('every reporter of a readiness failure surfaces stale constraints', () => {
  // Three places render this result: assertReadyOrExit (boot), migrate.js --check (the read-only
  // precheck an operator runs BEFORE migrating), and migrate.js's post-apply report. The first
  // version of staleConstraints was rendered by only one of them, so the other two would have
  // printed "schema ready: NO" with nothing under it — a verdict with the reason withheld, which
  // is the shape an operator works around rather than acts on.
  const mig = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'migrate.js'), 'utf8');
  const sr = fs.readFileSync(path.join(__dirname, 'schema-ready.js'), 'utf8');
  const hits = (mig.match(/staleConstraints/g) || []).length;
  assert.ok(hits >= 2,
    `migrate.js renders staleConstraints in ${hits} place(s); both --check and the post-apply `
    + 'report need it');
  assert.match(sr, /stale constraint: \$\{c\}/, 'assertReadyOrExit does not render it');
});

test('the readiness check runs SELECTs only — boot holds no DDL', async () => {
  const seen = [];
  const q = async (sql, params = []) => {
    seen.push(sql);
    return fakeQuery()(sql, params);
  };
  await SR.check(q);
  assert.ok(seen.length > 0);
  for (const sql of seen) {
    assert.match(sql.trim(), /^SELECT/i,
      `the readiness check issued a non-SELECT, which would require the application to hold DDL: ${sql.slice(0, 60)}`);
  }
});
