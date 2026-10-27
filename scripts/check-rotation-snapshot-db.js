#!/usr/bin/env node
// ── RUN THE ROTATION SNAPSHOT STORE AGAINST A REAL POSTGRES ──────────────────
//
//   scripts/check-rotation-snapshot-db.js   → exit 0 = the store persists, refuses, and clears
//
// ── WHY THIS CHECK EXISTS ────────────────────────────────────────────────────
//
// The snapshot is the only record of what the credentials were before rotation. Once the values are
// rotated the before-state cannot be recreated, so every failure in this layer is unrecoverable at
// the moment it is discovered.
//
// It has already been wrong once in the way that matters most. The first version wrote
// /tmp/fp.json inside the Railway container — and the procedure requires a redeploy between writing
// it and reading it, which replaces the container. The storage was guaranteed to be destroyed by
// the step it existed to survive. Nothing in the unit tests could see that, because the file write
// and the file read both worked perfectly.
//
// So the two things asserted here are the two that cost something:
//   1. a snapshot taken in one process is readable by a DIFFERENT process (what a redeploy is), and
//   2. a second --snapshot does NOT overwrite the first.
//
// (2) is the dangerous one. Re-snapshotting after rotating replaces the before-state with the
// after-state; the comparison then reports every credential unchanged. Read one way that is "the
// rotation failed" and the operator rotates again; read the other way, by anyone who inverts the
// check, it is a clean bill of health on a rotation that never happened. Either way the evidence is
// gone, and the only indication would have been a timestamp nobody reads.
//
// Needs a server: set ROTATION_PG_URL, or let it start a throwaway cluster if initdb is on PATH.
// With neither it SKIPS, so a machine without Postgres can still run preflight.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const store = require('../src/lib/rotation-snapshot');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => {
  fail++; console.log(`  FAIL  ${m}`);
  if (d) console.log(String(d).split('\n').map((l) => `          ${l}`).join('\n'));
};

// ── GET A SERVER ────
const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/usr/bin'];
function findInitdb() {
  for (const d of BIN) { const p = path.join(d, 'initdb'); if (fs.existsSync(p)) return d; }
  return null;
}
let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/rotsnap-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55994' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data -A trust`);
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
  } catch (_) { /* best effort */ }
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) {}
}

const url = process.env.ROTATION_PG_URL || startTemp();
if (!url) {
  console.log('  skip  no Postgres available (set ROTATION_PG_URL or install initdb)');
  console.log('SKIP  rotation snapshot store not executed — this check needs a server');
  process.exit(0);
}

const fp = (v, salt) => crypto.createHash('sha256').update(`${salt}\u0000${v}`).digest('hex');
const SECRET_BEFORE = 'postgresql://u:EXAMPLE-fixture-old-4e71@h:5432/db';
const SECRET_AFTER = 'postgresql://u:EXAMPLE-fixture-new-9b02@h:5432/db';

(async () => {
  const { Pool } = require('pg');
  // Two independent pools on purpose. A redeploy is a new process reading what an older process
  // wrote, and a single connection that happened to hold the row in a session temp table would
  // pass a test that the real procedure fails.
  const writer = new Pool({ connectionString: url, ssl: false });
  const reader = new Pool({ connectionString: url, ssl: false });
  const wq = (t, p) => writer.query(t, p);
  const rq = (t, p) => reader.query(t, p);

  try {
    const salt = crypto.randomBytes(16).toString('hex');
    const snap = {
      takenAt: new Date().toISOString(),
      salt,
      fingerprints: { DATABASE_URL: fp(SECRET_BEFORE, salt), ADMIN_PASSWORD: fp('EXAMPLE-fixture-admin-3c8f', salt) },
    };

    // 1. The SQL runs at all. CREATE TABLE … JSONB, an ON CONFLICT upsert and a $5 json parameter
    //    all parse fine in JavaScript and fail on contact with a server.
    const saved = await store.save(wq, { label: 'checkrun', commit: 'abc1234', snap });
    if (saved.saved && saved.count === 2) ok('save() creates the table and records 2 fingerprints');
    else bad('save() did not report a successful write', JSON.stringify(saved));

    // 2. A DIFFERENT process can read it. This is the redeploy.
    const loaded = await store.load(rq, 'checkrun');
    if (!loaded) bad('load() from a second connection found nothing — this is the /tmp bug again');
    else if (loaded.salt === salt && loaded.fingerprints.DATABASE_URL === snap.fingerprints.DATABASE_URL) {
      ok('load() from a separate connection returns the salt and digests intact');
    } else bad('load() returned a snapshot that does not match what was written', JSON.stringify(loaded));

    // 3. The digests are usable as digests — jsonb came back as an object, not a string.
    if (loaded && typeof loaded.fingerprints === 'object' && !Array.isArray(loaded.fingerprints)) {
      ok('fingerprints deserialise to an object, so lookups are not silently undefined');
    } else bad('fingerprints did not come back as an object');

    // 4. THE GUARD. A second snapshot must be refused.
    const second = await store.save(wq, {
      label: 'checkrun',
      commit: 'def5678',
      snap: { takenAt: new Date().toISOString(), salt: 'other', fingerprints: { DATABASE_URL: fp(SECRET_AFTER, 'other') } },
    });
    if (second.refused && !second.saved) ok('a second save() is refused rather than overwriting the before-state');
    else bad('a second save() OVERWROTE the snapshot — the before-state is destroyable', JSON.stringify(second));

    // 5. And the refusal must have left the original untouched, not merely returned a flag.
    const after = await store.load(rq, 'checkrun');
    if (after && after.salt === salt && after.commit === 'abc1234') {
      ok('the refused write changed nothing — original salt and commit still stored');
    } else bad('the row changed despite the refusal', JSON.stringify(after));

    // 6. --force overwrites deliberately.
    const forced = await store.save(wq, {
      label: 'checkrun', commit: 'def5678', force: true,
      snap: { takenAt: new Date().toISOString(), salt: 'forced', fingerprints: { DATABASE_URL: 'x' } },
    });
    const afterForce = await store.load(rq, 'checkrun');
    if (forced.saved && afterForce && afterForce.salt === 'forced') ok('--force overwrites when asked explicitly');
    else bad('--force did not overwrite', JSON.stringify({ forced, afterForce }));

    // 7. No secret VALUE is ever in the table. The whole point of storing digests.
    const raw = await rq('SELECT label, taken_commit, salt, fingerprints::text AS f FROM rotation_snapshots');
    const dump = JSON.stringify(raw.rows);
    if (!/EXAMPLE-fixture-old-4e71|EXAMPLE-fixture-new-9b02|EXAMPLE-fixture-admin-3c8f/.test(dump)) {
      ok('the stored row contains no secret value, only salted digests');
    } else bad('A SECRET VALUE IS STORED IN THE TABLE');

    // 7b. THE SECOND GUARD, and the one that already failed in production. --health printed
    //     "post-rotation health … all healthy after rotation" while every credential was still the
    //     leaked value. It now refuses while a snapshot is outstanding, which only works if an
    //     outstanding snapshot is distinguishable from a verified one.
    const outstanding = await store.load(rq, 'checkrun');
    if (outstanding && outstanding.verifiedAt === null) {
      ok('a snapshot that has not been compared reads as unverified');
    } else bad('an uncompared snapshot did not read as unverified', JSON.stringify(outstanding));

    const vAt = await store.markVerified(wq, 'checkrun', 'ver9999');
    const verified = await store.load(rq, 'checkrun');
    if (vAt && verified && verified.verifiedAt && verified.verifiedCommit === 'ver9999') {
      ok('markVerified() records when and on which commit the comparison passed');
    } else bad('markVerified() did not record the verification', JSON.stringify({ vAt, verified }));

    // And the digests must be gone once verified — the row is evidence, not a stored oracle.
    const blanked = await rq("SELECT salt, fingerprints::text AS f FROM rotation_snapshots WHERE label = 'checkrun'");
    if (blanked.rows[0].salt === '' && blanked.rows[0].f === '{}') {
      ok('verification blanks the salt and digests, leaving evidence without an oracle');
    } else bad('digests survived verification', JSON.stringify(blanked.rows[0]));

    // A verified round must not be silently overwritten by a fresh snapshot either.
    const reuse = await store.save(wq, {
      label: 'checkrun', commit: 'zzz',
      snap: { takenAt: new Date().toISOString(), salt: 's', fingerprints: { DATABASE_URL: 'y' } },
    });
    if (reuse.refused && reuse.verifiedAt) ok('a completed round is refused as a snapshot target, and says it is completed');
    else bad('a completed round was overwritten or did not report itself verified', JSON.stringify(reuse));

    // 8. Cleanup is a real delete, and reports what it deleted.
    const n = await store.remove(wq, 'checkrun');
    const gone = await store.load(rq, 'checkrun');
    if (n === 1 && gone === null) ok('remove() deletes the row and load() then returns null');
    else bad('remove() did not clear the snapshot', JSON.stringify({ n, gone }));

    // 9. load() on a label that was never taken returns null rather than throwing or inventing one.
    const missing = await store.load(rq, 'never-taken');
    if (missing === null) ok('load() of an unknown label returns null');
    else bad('load() of an unknown label returned something', JSON.stringify(missing));

    // 10. Only rows this check created. Per CLAUDE.md: never assert the table is empty — on
    //     production that becomes false the moment a real rotation is in flight.
    const mine = await rq("SELECT COUNT(*)::int n FROM rotation_snapshots WHERE label IN ('checkrun','never-taken')");
    if (mine.rows[0].n === 0) ok('no fixture rows left behind');
    else bad(`${mine.rows[0].n} fixture row(s) leaked`);
  } catch (e) {
    bad('threw', e && e.stack ? e.stack : e);
  } finally {
    await writer.end().catch(() => {});
    await reader.end().catch(() => {});
    stopTemp();
  }

  if (fail) { console.log(`FAIL  ${fail} check(s) failed`); process.exit(1); }
  console.log('PASS  the rotation snapshot survives a new process, refuses overwrite, stores no values');
})();
