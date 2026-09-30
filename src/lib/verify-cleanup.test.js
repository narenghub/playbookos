// VERIFICATION CLEANUP: only what you created, by id — and never "the table is empty".
//
//   node --test src/lib/verify-cleanup.test.js
//
// The rule is in CLAUDE.md. This is the part that does not rely on the next person having read it, because
// the failure mode is destructive and silent: these scripts run against PRODUCTION, and their cleanup is the
// code nobody reviews.
//
// What happened on 2026-09-30: verify-outreach-ui-live.js cleaned up with
//     DELETE FROM sitenex_deals WHERE created_at > NOW() - INTERVAL '10 minutes'
// which would have removed a deal somebody had just closed. Nothing was lost only because no real deals
// existed yet. It also swept a leak in verify-outreach-live.js — that script marked a prospect 'won',
// creating a deal by design, and never cleaned it up — so for as long as both were wrong, one hid the other.
//
// Both also asserted their tables end up EMPTY, which stops being true the moment the product is used. When
// such an assertion starts failing, the obvious fix is to widen the DELETE. A test that pressures the next
// person toward a more destructive cleanup is worse than no test.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPTS = path.join(__dirname, '../../scripts');

// Scripts that WRITE to production in order to verify something, so their cleanup matters. A read-only
// checker has nothing to clean up and is not policed here.
const VERIFIERS = fs.readdirSync(SCRIPTS)
  .filter(f => /^verify-.*\.js$/.test(f))
  .filter(f => /DELETE FROM/i.test(fs.readFileSync(path.join(SCRIPTS, f), 'utf8')));

// `WHERE id = $1 AND email LIKE 'verify-%'` is the SAFEST form there is: the id decides which row, and the
// pattern is a second belt in case the id is ever wrong. Flagging it would have made this guard unusable,
// and an unusable guard gets deleted. A pattern is only a problem when it is doing the SELECTING.
const idPinned = (t) => /\b(id|_id)\s*=\s*\$\d/.test(t);

const lines = (f) => fs.readFileSync(path.join(SCRIPTS, f), 'utf8').split('\n')
  .map((text, i) => ({ text, n: i + 1 }))
  .filter(l => !/^\s*(\/\/|\*|#)/.test(l.text));      // a comment may quote the forbidden shape

test('the sweep found the scripts it is meant to police', () => {
  // A filter this narrow can match nothing, and then every assertion below passes over an empty list —
  // which is the characteristic way a guard becomes decoration.
  assert.ok(VERIFIERS.length >= 3, `expected several writing verifiers, found: ${VERIFIERS.join(', ')}`);
  for (const want of ['verify-outreach-live.js', 'verify-outreach-ui-live.js']) {
    assert.ok(VERIFIERS.includes(want), `${want} must be covered — both carried the bug`);
  }
});

test('no cleanup deletes by time, pattern or "recent" — only by explicit id', () => {
  const bad = [];
  for (const f of VERIFIERS) {
    for (const l of lines(f)) {
      if (!/DELETE FROM/i.test(l.text)) continue;
      // The blast radius of a DELETE is decided entirely by its WHERE. These three shapes can all match
      // rows the script did not create.
      if (/created_at|updated_at|NOW\s*\(\s*\)|INTERVAL|CURRENT_(DATE|TIMESTAMP)/i.test(l.text)) {
        bad.push(`${f}:${l.n}  deletes by TIME — ${l.text.trim()}`);
      } else if (/\bLIKE\b|\bILIKE\b|~\*?\s*'/.test(l.text) && !idPinned(l.text)) {
        bad.push(`${f}:${l.n}  deletes by PATTERN — ${l.text.trim()}`);
      } else if (!/WHERE/i.test(l.text)) {
        bad.push(`${f}:${l.n}  deletes with NO WHERE — ${l.text.trim()}`);
      }
    }
  }
  assert.deepEqual(bad, [], `a verification may only delete rows it created, by id:\n${bad.join('\n')}`);
});

test('no verifier asserts a table is EMPTY — only that its own fixtures are gone', () => {
  const bad = [];
  for (const f of VERIFIERS) {
    const src = lines(f);
    for (const l of src) {
      // `SELECT COUNT(*) FROM <table>` with no WHERE, whose result is then required to be zero. The count
      // itself is fine to PRINT — it is useful diagnostics. It is failing on it that is the problem.
      const m = /COUNT\(\*\)(::int)?\s+n?\s*FROM\s+([a-z_]+)\s*`/i.exec(l.text);
      if (!m) continue;
      const varName = (/(?:const|let|var)\s+(\w+)\s*=/.exec(l.text) || [])[1];
      if (!varName) continue;
      // Does any later line make a verdict out of it?
      const verdicts = src.filter(x => x.n > l.n &&
        new RegExp(`(if\\s*\\(.*\\b${varName}\\b|assert\\w*\\(\\s*${varName}\\b)`).test(x.text) &&
        /fail\+\+|fail \+= |assert/.test(x.text));
      for (const v of verdicts) {
        bad.push(`${f}:${v.n}  fails on a whole-table count of ${m[2]} — ${v.text.trim()}`);
      }
    }
  }
  assert.deepEqual(bad, [],
    `"the table is empty" stops being true the moment the product is used, and the obvious fix when it\n` +
    `starts failing is to widen the DELETE. Assert "my fixtures are gone" instead:\n${bad.join('\n')}`);
});

test('the guard would catch the real regressions, rather than passing over clean files', () => {
  // Proving the patterns bite. Each of these is a shape that shipped.
  const byTime = "  await query(`DELETE FROM sitenex_deals WHERE created_at > NOW() - INTERVAL '10 minutes'`);";
  const noWhere = "  await query(`DELETE FROM outreach`);";
  const byPattern = "  await query(`DELETE FROM prospects WHERE business_name LIKE 'test-%'`);";
  const byId = "  await query(`DELETE FROM sitenex_deals WHERE id = $1`, [id]);";
  const byPair = "  await query(`DELETE FROM outreach WHERE entity_type=$1 AND entity_id=$2`, [ty, id]);";

  const flags = (t) => /DELETE FROM/i.test(t) && (
    /created_at|updated_at|NOW\s*\(\s*\)|INTERVAL|CURRENT_(DATE|TIMESTAMP)/i.test(t) ||
    /\bLIKE\b|\bILIKE\b|~\*?\s*'/.test(t) || !/WHERE/i.test(t));

  assert.ok(flags(byTime), 'the ten-minute window must be caught');
  assert.ok(flags(noWhere), 'a bare DELETE must be caught');
  assert.ok(flags(byPattern), 'a LIKE must be caught');
  // And the correct forms must NOT trip it, or the guard is unusable and gets deleted.
  assert.ok(!flags(byId), 'deleting by id is the point — it must pass');
  assert.ok(!flags(byPair), 'deleting by an explicit key pair must pass');
  const idPlusLike = "  await query(`DELETE FROM users WHERE id=$1 AND email LIKE 'verify-%'`, [id]);";
  assert.ok(!flags(idPlusLike) || idPinned(idPlusLike),
    'an id-pinned delete with a belt-and-braces LIKE is the safest form and must pass');
  const likeOnly = "  await query(`DELETE FROM notifications WHERE title LIKE $1`, [TAG + '%']);";
  assert.ok(flags(likeOnly) && !idPinned(likeOnly), 'a pattern doing the SELECTING must be caught');
});
