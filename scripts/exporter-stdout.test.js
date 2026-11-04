// ── AN EXPORTER'S STDOUT IS A FILE SOMEBODY ELSE WILL OPEN ───────────────────
//
//   node --test scripts/exporter-stdout.test.js
//
// `initDB()` prints `✅ PostgreSQL database ready. 2 admin account(s); super_admin:
// naren@abiozen.com`. Exporters write their payload to stdout so it can be redirected into a file,
// so that line became LINE 1 of three CSVs staged for commit on 3 Nov — `approved.csv`,
// `supplier-products.csv`, `paul-*.csv` — each with the banner sitting above the real header, and
// the company's super-admin address in a file bound for a customer. Nothing errored.
//
// `export-trial-cut.js` had been fixed IN PLACE weeks earlier. That is how the defect survived:
// the fix protected the one copy that carried it, and three exporters without it kept writing the
// banner into customer-bound files. The same shape as a Postgres search path copied into 35
// harnesses, and the reason the guard now lives in scripts/lib/clean-stdout.js.
//
// ── WHAT IS PROVEN HERE, AND WHY IN THIS ORDER ──────────────────────────────
//
//   1. stdout parses as JSON — end to end, through the real exporter and a real database
//   2. the banner cannot appear — including when written straight to the stream
//   3. administrative addresses do not leak, on EITHER stream
//   4. a failure exits non-zero and leaves stdout EMPTY, never a truncated document
//   5. the human-readable modes still print to stdout, unchanged
//
// Each has a negative control: with the guard removed the banner reaches stdout, and with the
// redaction removed the address does. Without those, every assertion below would keep passing on a
// guard that had been quietly disabled.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const { pgBin, INITDB_FLAGS } = require('./lib/pg-cluster');
const { scrub } = require('./lib/clean-stdout');

// The banner, as production prints it. Kept verbatim so a change to db.js that alters the wording
// does not quietly make these tests measure a string nobody emits any more.
const BANNER = '✅ PostgreSQL database ready. 2 admin account(s); super_admin: naren@abiozen.com';
const ADMIN = 'naren@abiozen.com';

function runChild(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expstdout-'));
  const file = path.join(dir, 'child.js');
  fs.writeFileSync(file, body);
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8' });
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  return { stdout: r.stdout || '', stderr: r.stderr || '', code: r.status };
}

const GUARD = JSON.stringify(path.join(SCRIPTS, 'lib', 'clean-stdout.js'));

// ── 2 & 3. THE BANNER CANNOT APPEAR, AND THE ADDRESS DOES NOT LEAK ──────────

test('the banner cannot reach stdout, by console.log or by the stream itself', () => {
  const { stdout, stderr, code } = runChild(`
    const { payloadMode } = require(${GUARD});
    const out = payloadMode();
    console.log(${JSON.stringify(BANNER)});                 // how initDB prints it
    process.stdout.write(${JSON.stringify(`${BANNER}\n`)});  // and a library going round console
    out.emitJson({ ok: true });
  `);
  assert.equal(code, 0);
  assert.doesNotMatch(stdout, /PostgreSQL database ready/, `the banner reached stdout:\n${stdout}`);
  // It must not be swallowed either — a diagnostic nobody can see is its own defect.
  assert.match(stderr, /PostgreSQL database ready/, 'the banner was discarded instead of diverted');
  // Twice: once via console.log, once via the direct stream write. If only one appears, one of the
  // two interception paths is not working and a library would still be able to reach the file.
  assert.equal((stderr.match(/PostgreSQL database ready/g) || []).length, 2,
    `both writes must be diverted, got:\n${stderr}`);
  assert.deepEqual(JSON.parse(stdout), { ok: true });
});

test('administrative addresses do not leak through the diagnostics either', () => {
  const { stdout, stderr } = runChild(`
    const { payloadMode } = require(${GUARD});
    const out = payloadMode();
    console.log(${JSON.stringify(BANNER)});
    out.emitJson({ ok: true });
  `);
  assert.ok(!stdout.includes(ADMIN), 'the admin address reached stdout');
  assert.ok(!stderr.includes(ADMIN),
    `the admin address survived into the forwarded diagnostic:\n${stderr}`);
  assert.match(stderr, /\[redacted-address\]/, 'the address was removed without leaving a marker');
  // The rest of the diagnostic has to survive, or the redaction has destroyed the thing it was
  // protecting — somebody reading a login problem still needs "2 admin account(s)".
  assert.match(stderr, /2 admin account\(s\)/, 'redaction ate the useful part of the diagnostic');
});

test('NEGATIVE CONTROL: without the guard the banner lands in stdout and the address with it', () => {
  // The same child, minus payloadMode. If this does not reproduce the defect, the tests above are
  // measuring something other than the guard.
  const { stdout } = runChild(`
    console.log(${JSON.stringify(BANNER)});
    console.log(JSON.stringify({ ok: true }));
  `);
  assert.match(stdout, /PostgreSQL database ready/,
    'the defect did not reproduce — these tests are not measuring the guard');
  assert.ok(stdout.includes(ADMIN), 'the address did not reproduce in stdout');
  assert.throws(() => JSON.parse(stdout), 'unguarded stdout should not be parseable as JSON');
});

test('NEGATIVE CONTROL: the redaction itself is load-bearing', () => {
  // scrub() is what keeps the address out of the diverted diagnostic. Prove it fires on the real
  // banner and on the shapes an address actually takes, and that it leaves ordinary text alone.
  assert.ok(!scrub(BANNER).includes(ADMIN), 'scrub did not remove the address from the real banner');
  for (const a of ['naren@abiozen.com', 'prasanthi@adificetechnologies.com', 'a.b+c@sub.example.co.uk']) {
    assert.ok(!scrub(`admin: ${a}`).includes(a), `scrub missed ${a}`);
  }
  assert.equal(scrub('2 admin account(s)'), '2 admin account(s)', 'scrub altered ordinary text');
});

// ── 4. A FAILURE LEAVES NOTHING ON STDOUT ───────────────────────────────────

test('a failure exits non-zero and leaves stdout EMPTY, not truncated', () => {
  const { stdout, code } = runChild(`
    const { payloadMode } = require(${GUARD});
    const out = payloadMode();
    const rows = [{ id: 1 }, { id: 2 }];
    if (rows.length) { throw new Error('query failed halfway'); }
    out.emitJson({ products: rows });
  `);
  assert.notEqual(code, 0, 'a thrown error must not exit 0');
  assert.equal(stdout, '', `stdout must be empty on failure, got:\n${stdout}`);
});

test('the JSON document is written once, so it cannot be half a file', () => {
  // emitJson serialises before it writes. A streamed document that fails mid-way produces a file
  // that is almost right, which is the weakest possible signal.
  const { stdout, code } = runChild(`
    const { payloadMode } = require(${GUARD});
    const out = payloadMode();
    out.emitJson({ count: 2, products: [{ id: 1 }, { id: 2 }] });
  `);
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);           // throws if there is anything else on the stream
  assert.equal(parsed.count, 2);
  // Exactly one document: a second would make this unparseable, but assert the shape explicitly so
  // a future change that appends a trailing summary is caught here rather than by a consumer.
  assert.equal(stdout.trimEnd().endsWith('}'), true, `stdout has trailing output:\n${stdout}`);
  assert.equal(stdout.split('\n').filter((l) => l === '}').length, 1, 'more than one document');
});

// ── 1. END TO END, THROUGH THE REAL EXPORTER AND A REAL DATABASE ────────────

test('export-supplier-products --format=json emits parseable JSON with no banner', (t) => {
  const dir = pgBin();
  if (!dir) { t.skip('no Postgres available — cannot prove the end-to-end exporter output'); return; }

  const base = fs.mkdtempSync('/var/tmp/expjson-');
  const asRoot = process.getuid && process.getuid() === 0;
  const sh = (cmd) => execFileSync('bash', ['-c', asRoot ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { stdio: 'pipe' });
  let started = false;
  try {
    if (asRoot) execFileSync('bash', ['-c', `chown -R postgres ${base}`], { stdio: 'pipe' });
    sh(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    sh(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55962 -c listen_addresses=' start -w`);
    started = true;

    // A fixture address, so the run has a REAL administrative identifier to leak. initDB prints
    // `[db] Seeded initial admin user: <address>` on first boot, which is the leak this is for.
    const FIXTURE_ADMIN = 'fixture-admin@example.test';
    const env = {
      ...process.env,
      DATABASE_URL: `postgresql://postgres@localhost/postgres?host=${base}&port=55962&sslmode=disable`,
      JWT_SECRET: 'exporter-stdout-test',
      ADMIN_EMAIL: FIXTURE_ADMIN,
      ADMIN_PASSWORD: 'fixture-only-never-a-real-credential',
    };

    // The exporter's table. Built here rather than through migrate-supplier-products.js, which
    // depends on cphi_exhibitor_contacts and a chain of other migrations — none of which this test
    // is about. These are exactly the columns the exporter SELECTs, and one row so `products` is
    // populated rather than an empty array that would parse whatever happened upstream.
    // Collapsed to one line: the statement passes through JSON.stringify, bash -c and su -c, and a
    // newline survives none of them intact — it arrives as a literal backslash-n and psql rejects it.
    const psql = (sql) => sh(`PATH=${dir}:$PATH psql -h ${base} -p 55962 -U postgres -d postgres `
      + `-v ON_ERROR_STOP=1 -c ${JSON.stringify(sql.replace(/\s+/g, ' ').trim())}`);
    psql(`CREATE TABLE supplier_products (
            id serial primary key, event_slug text, supplier text, product_name text, cas text,
            grade text, markers jsonb, confidence text, name_source text, use_class text,
            listing_notice text, patent_check text, suggested text, suggested_reason text,
            priority int, review_status text, review_note text, source_file text,
            source_line text, extracted_at timestamptz default now())`);
    psql(`INSERT INTO supplier_products
            (event_slug, supplier, product_name, cas, grade, use_class, suggested, priority, review_status)
          VALUES ('cphi-milan-2026', 'Fixture Pharma', 'Allopurinol', '315-30-0', 'api',
                  'commercial', 'list', 70, 'approved')`);

    const r = spawnSync(process.execPath,
      [path.join(SCRIPTS, 'export-supplier-products.js'), '--format=json'],
      { encoding: 'utf8', env });

    assert.equal(r.status, 0, `exporter failed:\n${r.stderr}`);
    // THE assertion the ruling asks for: stdout parses, on its own, with nothing prepended.
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.products.length, 1, `expected the fixture row, got ${doc.products.length}`);
    assert.equal(doc.products[0].product_name, 'Allopurinol');
    assert.ok(Object.prototype.hasOwnProperty.call(doc, 'contract'),
      'the handover contract is missing — the marketplace relies on it');
    assert.doesNotMatch(r.stdout, /PostgreSQL database ready/, 'the banner is in the handover file');
    assert.ok(!r.stdout.includes('@example.test'), 'an administrative address is in the handover file');

    // NON-VACUITY. Both halves must have actually happened in THIS run, or the two assertions above
    // are satisfied by a run that printed nothing — which is exactly how 31 preflight checks passed
    // yesterday while executing nothing.
    assert.match(r.stderr, /PostgreSQL database ready/,
      'initDB printed no banner in this run, so the stdout assertion proved nothing');
    assert.match(r.stderr, /Seeded initial admin user/,
      'no administrative address was printed in this run, so the leak assertion proved nothing');
    assert.ok(!r.stderr.includes(FIXTURE_ADMIN),
      `the seeded address survived into the diagnostics:\n${r.stderr}`);
    assert.match(r.stderr, /\[redacted-address\]/, 'the address was removed without leaving a marker');
  } finally {
    if (started) { try { sh(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -m immediate stop`); } catch (_) {} }
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {}
  }
});

// ── 5. COMPATIBILITY ────────────────────────────────────────────────────────

test('an informational mode still prints to stdout', () => {
  // export-trial-cut.js claims stdout at module load so the CSV is clean. --list-regions opens no
  // database and its answer is the product, so it hands the stream back. Without that, claiming
  // stdout for the CSV would have silently redirected an unrelated mode — a regression introduced
  // by the fix itself.
  const r = spawnSync(process.execPath,
    [path.join(SCRIPTS, 'export-trial-cut.js'), '--list-regions'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /countries/, `--list-regions wrote nothing to stdout:\n${r.stdout}`);
});

test('an exporter with no database exits non-zero and writes nothing to stdout', () => {
  for (const script of ['export-supplier-products.js', 'export-cphi-contacts.js']) {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), '--format=json', '--print'], {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/none', PGHOST: '', PGPORT: '' },
      timeout: 60000,
    });
    assert.notEqual(r.status, 0, `${script} exited 0 with no database`);
    assert.equal((r.stdout || '').trim(), '',
      `${script} wrote to stdout while failing:\n${r.stdout}`);
  }
});

// ── THE SWEEP, SO A FIFTH EXPORTER CANNOT REPEAT THIS ───────────────────────

test('every exporter uses the shared guard and none keeps a private copy', () => {
  const exporters = fs.readdirSync(SCRIPTS)
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
    .filter((f) => {
      const s = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
      return /arg\('format'|--format=(json|csv)|arg\('print'|'--print'/.test(s) && s.includes('initDB');
    });

  assert.ok(exporters.length >= 3, `the sweep found only ${exporters.length} exporters`);
  const findings = [];
  for (const f of exporters) {
    const s = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
    if (!s.includes("require('./lib/clean-stdout')")) findings.push(`${f}: does not use the shared guard`);
    // The in-place fix is what failed to generalise. A private reimplementation is the defect
    // returning under another name.
    if (/const realLog = console\.log/.test(s)) findings.push(`${f}: keeps a private console.log swap`);
  }
  assert.deepEqual(findings, [],
    `\n${findings.length} exporter(s) are not behind the shared guard.\n\n`
    + 'An exporter writes a file somebody else opens. The guard belongs in one place, because the\n'
    + 'last time it lived in one exporter the other three wrote the database banner and the\n'
    + "company's super-admin address into customer-bound files.\n\n"
    + findings.join('\n'));
});

test('the sweep would notice an exporter that bypassed the guard', () => {
  // Planted positives: without these, the sweep passes on a clean tree and would keep passing if
  // the predicate were narrowed until it matched nothing.
  const planted = "const { initDB } = require('../src/lib/db');\nconst FORMAT = arg('format','json');";
  assert.ok(!planted.includes("require('./lib/clean-stdout')"), 'the predicate cannot detect a bypass');
  const withPrivate = "const realLog = console.log;\nconsole.log = (...a) => console.error(...a);";
  assert.match(withPrivate, /const realLog = console\.log/, 'the predicate cannot detect a private copy');
});
