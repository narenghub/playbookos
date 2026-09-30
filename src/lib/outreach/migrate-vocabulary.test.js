// The MIGRATION's refusal, tested by running it for real against a fake db.
//
//   node --test src/lib/outreach/migrate-vocabulary.test.js
//
// Run as a CHILD PROCESS, because the thing being asserted is process.exit(1) and the order of statements
// leading up to it. A refusal is only a refusal if it exits non-zero and has changed nothing — and "read the
// exit code, not the output" applies to the migration as much as to the checkers that guard a push.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../../..');
const MIGRATION = path.join(ROOT, 'scripts/migrate-outreach-vocabulary.js');

// A preload that swaps ../src/lib/db for a fake recording every statement, then runs the migration.
function run(rows) {
  const harness = path.join(require('node:os').tmpdir(), `mig-harness-${process.pid}-${Math.random()}.js`);
  fs.writeFileSync(harness, `
    const Module = require('module');
    const path = require('path');
    const DB = path.join(${JSON.stringify(ROOT)}, 'src/lib/db.js');
    const SQL = [];
    const rows = ${JSON.stringify(rows)};
    const orig = Module._load;
    Module._load = function (req, parent, isMain) {
      if (req.endsWith('/db') || req === '../src/lib/db') {
        return { query: async (sql, params = []) => {
          SQL.push(sql.replace(/\\s+/g, ' ').trim());
          for (const [re, out] of rows) if (new RegExp(re, 'i').test(sql)) return { rows: out, rowCount: out.length };
          // A bare aggregate always returns exactly one row — an empty result here would be a fake that
          // cannot happen, and the migration would fail on an artefact instead of on its own logic.
          if (/^\\s*SELECT COUNT\\(/i.test(sql)) return { rows: [{ n: 0 }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        }, pool: { end: async () => {} } };
      }
      return orig.apply(this, arguments);
    };
    process.on('exit', () => {
      require('fs').writeFileSync(${JSON.stringify(ROOT)} + '/.mig-sql.json', JSON.stringify(SQL));
    });
    require(${JSON.stringify(MIGRATION)});
  `);
  const r = spawnSync(process.execPath, [harness], { encoding: 'utf8', cwd: ROOT, env: { ...process.env, JWT_SECRET: 'x' } });
  fs.unlinkSync(harness);
  let sql = [];
  try { sql = JSON.parse(fs.readFileSync(path.join(ROOT, '.mig-sql.json'), 'utf8')); fs.unlinkSync(path.join(ROOT, '.mig-sql.json')); } catch {}
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), sql };
}

test("it ABORTS on an 'interested' row, non-zero, having run NO other statement", () => {
  const r = run([['\'interested\'', [{ col: 'outreach.status', n: 3 }]]]);
  assert.equal(r.code, 1, 'the verdict is the exit code, not the text');
  assert.match(r.out, /interested/);
  assert.match(r.out, /NOTHING has been changed/);
  // The part that actually matters: the refusal came FIRST. It used to run after the ALTER TABLEs, which
  // made its own message untrue.
  assert.equal(r.sql.length, 1, `only the check ran, but got: ${JSON.stringify(r.sql)}`);
  assert.ok(!r.sql.some(s => /ALTER TABLE|CREATE INDEX|UPDATE |COMMENT ON/i.test(s)),
    'a refusal that has half-run is not a refusal');
});

test("it looks for 'interested' in the EVENT LOG too, not just the current status", () => {
  // An entity can have moved on while its history still carries the word. Rewriting only current rows would
  // leave a value in the log that is in no vocabulary.
  const r = run([['\'interested\'', [{ col: 'outreach_events.from_status', n: 1 }]]]);
  assert.equal(r.code, 1);
  assert.match(r.out, /outreach_events\.from_status/);
  const check = r.sql[0];
  for (const col of ['outreach.status', 'outreach_events.to_status', 'outreach_events.from_status']) {
    assert.ok(check.includes(col), `the pre-check must cover ${col}`);
  }
});

test('with no interested rows it proceeds: channel, then the unambiguous mappings, then COMMENTs', () => {
  const r = run([['information_schema.columns', [{ table_name: 'outreach', column_name: 'channel' },
                                                 { table_name: 'outreach_events', column_name: 'channel' }]]]);
  assert.equal(r.code, 0, r.out);
  const joined = r.sql.join('\n');
  assert.match(joined, /ALTER TABLE outreach ADD COLUMN IF NOT EXISTS channel TEXT/);
  assert.match(joined, /ALTER TABLE outreach_events ADD COLUMN IF NOT EXISTS channel TEXT/);
  // The two mappings that ARE unambiguous, on all three columns that hold a status value.
  assert.ok(r.sql.some(s => /UPDATE outreach SET status=\$2/.test(s)));
  assert.ok(r.sql.some(s => /UPDATE outreach_events SET to_status=\$2/.test(s)));
  assert.ok(r.sql.some(s => /UPDATE outreach_events SET from_status=\$2/.test(s)));
  assert.match(joined, /COMMENT ON COLUMN outreach\.status/);
  assert.match(joined, /COMMENT ON COLUMN outreach\.channel/);
  // Still no CHECK — this is the third time the list has grown.
  assert.ok(!/ADD CONSTRAINT.*CHECK|CHECK \(status/i.test(joined), 'the vocabulary is a comment, not a constraint');
});

test('the migration maps exactly what the registry says, and nothing it invents itself', () => {
  const { LEGACY_STATUS_MAP } = require('./registry');
  const src = fs.readFileSync(MIGRATION, 'utf8');
  assert.match(src, /LEGACY_STATUS_MAP/, 'the mapping is read from the registry, not restated here');
  assert.ok(!/'new'\s*:\s*'not_contacted'/.test(src), 'a second copy of the map would be free to drift');
  assert.deepEqual(LEGACY_STATUS_MAP, { new: 'not_contacted', in_progress: 'in_conversation' });
  assert.ok(!('interested' in LEGACY_STATUS_MAP), 'deliberately unmapped — it needs a human');
});
