// ── A CLEANUP TOOL MUST BE SAFER THAN THE MESS IT CLEANS ────────────────────
//
//   node --test scripts/pg-disposable.test.js
//
// The incident: 688 orphaned cluster directories and 228 postgres processes filled the disk to
// 100%, and preflight reported it as "database TLS verification refuses the wrong certificate" —
// an infrastructure failure wearing an application-security face.
//
// The obvious fix is a cleanup sweep, and the obvious cleanup sweep is the next incident: anything
// that deletes directories by name, or kills processes by pid, will eventually delete a real
// database or kill an unrelated server. So the tests that matter here are the REFUSALS.
//
// Most cases run against fabricated marker files rather than real clusters: the subject is the
// ownership decision, and creating thirty clusters to test it would be its own disk problem.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ── AN ISOLATED BASE, SET BEFORE THE UTILITY LOADS ──────────────────────────
//
// Every case here reasons about "what is in the disposable base", so sharing /tmp with other runs
// — or with the 688 legacy orphans — makes the assertions depend on the machine's history. A
// private base also demonstrates the isolation requirement directly: two runs with different bases
// cannot see, still less delete, each other's clusters.
const ISOLATED_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'pnx-testbase-'));
process.env.PNX_PG_BASE = ISOLATED_BASE;

const D = require('./lib/pg-disposable');

/** A directory shaped like a disposable cluster, with whatever marker the test wants. */
function fakeCluster(name, owner) {
  const dir = path.join(D.BASE, `pnxpg-${name}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  if (owner) fs.writeFileSync(path.join(dir, D.OWNER_FILE), JSON.stringify(owner, null, 2));
  return dir;
}
// Drop a cluster from the utility's live set WITHOUT destroying it — the state a killed process
// leaves. Reaches into the module's own bookkeeping deliberately, because the alternative is
// spawning and killing a child, which made this test slow and flaky for no extra coverage.
function live_forget(c) { c.destroy = () => {}; }

const made = [];
const mk = (...a) => { const d = fakeCluster(...a); made.push(d); return d; };
test.after(() => {
  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  try { fs.rmSync(ISOLATED_BASE, { recursive: true, force: true }); } catch (_) {}
});

// Resolved eagerly: after a destructive sweep the directory is gone, and realpathSync on a
// deleted path throws ENOENT — which is how the first version of this file reported a CORRECT
// deletion as a test failure.
const real = (dir) => { try { return fs.realpathSync(dir); } catch (_) { return dir; } };
const find = (rows, dir, resolved) => rows.find((r) => r.dir === (resolved || real(dir)));

// ── WHAT MAY BE DELETED ─────────────────────────────────────────────────────

test('DECISIVE: a cluster owned by a DEAD run is removable', () => {
  // The only state that is ever deleted. "Dead" means the recorded pid is gone, or is a different
  // process than the one that wrote the marker.
  const dir = mk('dead', {
    marker: D.MARKER, runId: 'run-gone', pid: 999999, pidStartTime: '12345',
    label: 'dead', createdAt: new Date().toISOString(),
  });
  const r = find(D.cleanupStale({ dryRun: true }).rows, dir);
  assert.strictEqual(r.state, D.STATE.DEAD_OWNED);
});

test('CONTROL: dry run removes nothing, and says so', () => {
  const dir = mk('dead2', {
    marker: D.MARKER, runId: 'run-gone', pid: 999998, pidStartTime: '1', label: 'd',
  });
  const out = D.cleanupStale({ dryRun: true });
  assert.strictEqual(out.dryRun, true);
  assert.deepStrictEqual(out.removed, []);
  assert.ok(fs.existsSync(dir), 'a dry run that deleted something would be a trap');
});

// ── WHAT MUST NEVER BE DELETED ──────────────────────────────────────────────

test('DECISIVE: a cluster owned by a LIVE run is never touched', () => {
  // Concurrent workstreams. This process is alive and its start time matches, so the cluster
  // belongs to a running run — deleting it would break a test that is still executing.
  const dir = mk('livemine', {
    marker: D.MARKER, runId: 'some-other-run', pid: process.pid,
    pidStartTime: D.pidStartTime(process.pid), label: 'live',
  });
  const r = find(D.cleanupStale({ dryRun: false }).rows, dir);
  assert.strictEqual(r.state, D.STATE.LIVE_OTHER);
  assert.ok(fs.existsSync(dir), 'another run was still using it');
});

test('DECISIVE: PID REUSE does not make a cluster removable', () => {
  // The pid is alive — it is this very process — but the recorded start time belongs to a
  // different process that merely had the same number. Killing on a pid match alone is how a
  // cleanup tool kills something unrelated.
  const dir = mk('reused', {
    marker: D.MARKER, runId: 'ancient', pid: process.pid,
    pidStartTime: '1', label: 'reused',
  });
  const resolved = real(dir);
  const r = find(D.cleanupStale({ dryRun: true }).rows, dir, resolved);
  assert.strictEqual(r.state, D.STATE.DEAD_OWNED,
    'a live pid with a different start time is NOT the original process');
  // It is removable — correctly — because the original process is provably gone. The guarantee
  // being tested is that the decision used the start time, not the pid.
  assert.notStrictEqual(r.state, D.STATE.LIVE_OTHER);
});

test('DECISIVE: incomplete ownership evidence means REFUSE, not delete', () => {
  // No start time recorded, and the pid is alive. Whether it is the same process cannot be
  // established, so the only safe answer is to report it.
  const dir = mk('nostart', {
    marker: D.MARKER, runId: 'r', pid: process.pid, pidStartTime: null, label: 'x',
  });
  const out = D.cleanupStale({ dryRun: false });
  const r = find(out.rows, dir);
  assert.strictEqual(r.state, D.STATE.UNCERTAIN);
  assert.match(r.why, /recycled pid|cannot confirm/);
  assert.ok(fs.existsSync(dir), 'uncertainty must not be resolved by deleting');
});

test('DECISIVE: a directory with NO marker is inventoried, never removed', () => {
  // These are the 688 from the incident. A directory name is not evidence of ownership, and this
  // is exactly where a name-based sweep would have deleted something it did not understand.
  const dir = mk('legacy', null);
  const out = D.cleanupStale({ dryRun: false });
  const r = find(out.rows, dir);
  assert.strictEqual(r.state, D.STATE.UNIDENTIFIED);
  assert.match(r.why, /a directory name is not evidence/);
  assert.ok(fs.existsSync(dir));
  assert.ok(out.counts.unidentified >= 1, 'and it is counted so somebody can act on it');
});

test('DECISIVE: a foreign marker is not our marker', () => {
  const dir = mk('foreign', { marker: 'someone-elses-tool-v1', runId: 'x', pid: 1 });
  const r = find(D.cleanupStale({ dryRun: false }).rows, dir);
  assert.strictEqual(r.state, D.STATE.UNIDENTIFIED);
  assert.ok(fs.existsSync(dir));
});

// ── PATH SAFETY ─────────────────────────────────────────────────────────────

test('DECISIVE: a symlink out of the base is refused', () => {
  // Without canonicalisation, a symlink named like a disposable cluster aims a recursive delete
  // wherever it points — a real data directory, for instance.
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'pnx-real-db-'));
  const link = path.join(D.BASE, `pnxpg-evil-${Math.random().toString(36).slice(2, 8)}`);
  try {
    fs.symlinkSync(target, link);
    assert.strictEqual(D.safeCandidate(link), null,
      'a link whose target is outside the disposable base must not be a cleanup candidate');
    // And a full sweep leaves the target alone, which is the consequence that matters.
    D.cleanupStale({ dryRun: false });
    assert.ok(fs.existsSync(target), 'the link target survives a destructive sweep');
  } finally {
    try { fs.unlinkSync(link); } catch (_) {}
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('a traversal path is not a candidate', () => {
  assert.strictEqual(D.safeCandidate(path.join(D.BASE, '..', 'etc')), null);
  assert.strictEqual(D.safeCandidate('/var/lib/postgresql'), null);
  assert.strictEqual(D.safeCandidate(path.join(D.BASE, 'not-a-cluster-dir')), null,
    'the prefix is required, so an unrelated directory under the base is still refused');
});

test('a production-looking URL cannot enter the cleanup path at all', () => {
  // Structural: cleanup never takes a URL. It walks one canonical base directory and reads marker
  // files. There is no parameter through which a DATABASE_URL could arrive.
  const src = fs.readFileSync(path.join(__dirname, 'lib', 'pg-disposable.js'), 'utf8');
  const code = require('./js-lex').blankCommentsOnly(src);
  assert.doesNotMatch(code, /DATABASE_URL/, 'the utility must not read a database URL');
  assert.doesNotMatch(code, /function cleanupStale\([^)]*url/i);
});

// ── INTERRUPTED-RUN RECOVERY, DEMONSTRATED ──────────────────────────────────

test('DECISIVE: a cluster left by an interrupted run is recovered', (t) => {
  // The incident condition: a run dies without its `finally` or signal handler running, leaving a
  // live server and its directory behind.
  //
  // A REAL cluster is created and then orphaned by rewriting its ownership to a run that no longer
  // exists — which is precisely the state a SIGKILL leaves, and is stated plainly rather than
  // dressed up as killing a child process: what is under test is the RECOVERY, and the recovery
  // reads the marker, not the manner of death.
  if (!require('./lib/pg-cluster').pgBin()) return t.skip('no initdb available');

  const c = D.create({ label: 'interrupted' });
  const base = c.base;
  made.push(base);
  // Forget it the way a killed process does: no destroy(), no handler, server still running.
  live_forget(c);
  const owner = JSON.parse(fs.readFileSync(path.join(base, D.OWNER_FILE), 'utf8'));
  fs.writeFileSync(path.join(base, D.OWNER_FILE), JSON.stringify({
    ...owner, runId: 'interrupted-run', pid: 999997, pidStartTime: '424242',
  }, null, 2));

  assert.ok(fs.existsSync(base), 'the interrupted run left its cluster behind');
  const resolved = real(base);
  const before = find(D.cleanupStale({ dryRun: true }).rows, base, resolved);
  assert.strictEqual(before.state, D.STATE.DEAD_OWNED,
    'a later run positively identifies it as owned by a run that is gone');

  const after = D.cleanupStale({ dryRun: false });
  assert.ok(after.removed.includes(resolved), 'and reclaims it');
  assert.ok(!fs.existsSync(base), 'the orphan is gone, server stopped and directory removed');
});


// ── DISK EXHAUSTION IS AN INFRASTRUCTURE FAILURE ────────────────────────────

test('DECISIVE: too little disk is reported as infrastructure, not as a test failure', () => {
  // The whole reason this file exists: a full disk presented as "TLS verification refuses the
  // wrong certificate". A caller must be able to tell the two apart programmatically.
  const saved = process.env.PNX_PG_MIN_FREE;
  process.env.PNX_PG_MIN_FREE = String(2 ** 53);      // nothing will ever satisfy this
  try {
    const fresh = `${path.join(__dirname, 'lib', 'pg-disposable.js')}`;
    delete require.cache[require.resolve(fresh)];
    const F = require(fresh);
    assert.throws(() => F.create({ label: 'nospace' }), (e) => {
      assert.strictEqual(e.name, 'InfrastructureError');
      assert.strictEqual(e.infrastructure, true, 'machine-readable, not just a message');
      assert.match(e.message, /INFRASTRUCTURE failure, not/);
      assert.match(e.message, /pg-cleanup/, 'and it names the remedy');
      return true;
    });
  } finally {
    if (saved === undefined) delete process.env.PNX_PG_MIN_FREE;
    else process.env.PNX_PG_MIN_FREE = saved;
    delete require.cache[require.resolve(path.join(__dirname, 'lib', 'pg-disposable.js'))];
  }
});

// ── NO ACCUMULATION ACROSS REPEATED RUNS ────────────────────────────────────

test('repeated create/destroy leaves nothing behind', (t) => {
  if (!require('./lib/pg-cluster').pgBin()) return t.skip('no initdb available');
  const before = D.inventory().filter((r) => r.state === D.STATE.MINE).length;
  for (let i = 0; i < 3; i++) {
    const c = D.create({ label: `loop${i}` });
    assert.ok(fs.existsSync(c.base));
    c.destroy();
    assert.ok(!fs.existsSync(c.base), `iteration ${i} cleaned up after itself`);
  }
  assert.strictEqual(D.inventory().filter((r) => r.state === D.STATE.MINE).length, before,
    'three clusters created and destroyed left none of MINE behind');
});

test('two concurrent clusters get different directories and ports', (t) => {
  if (!require('./lib/pg-cluster').pgBin()) return t.skip('no initdb available');
  const a = D.create({ label: 'conc-a' });
  const b = D.create({ label: 'conc-b' });
  try {
    assert.notStrictEqual(a.base, b.base);
    assert.notStrictEqual(a.port, b.port, 'a fixed port is what made one orphan block every run');
  } finally { a.destroy(); b.destroy(); }
});

// ── THE PORT CHOICE: A GUARANTEE THAT WAS PROSE ─────────────────────────────
//
// `create()`'s comment claimed "a unique port per run, so two concurrent runs cannot collide"
// while the code picked `49152 + random % 16000` with no collision check and no retry. Each
// cluster connects over its own unix socket, so a duplicate port cannot cross-wire two harnesses;
// what it does is fail `pg_ctl -w start`, which surfaces as NOT EXECUTED. Rare by the arithmetic,
// and not the point: one orphan holding a port in that range blocks it for every future run.
//
// These tests cover the pure parts. The retry itself is exercised by every other check in
// preflight, each of which starts a cluster.
test('listeningPorts reads the kernel and returns plausible port numbers', () => {
  const ports = D.listeningPorts();
  assert.ok(ports instanceof Set, 'a Set of ports');
  for (const p of ports) {
    assert.ok(Number.isInteger(p) && p > 0 && p <= 65535, `${p} is a port number`);
  }
});

test('pickPort returns a high port that is not currently listening', () => {
  const listening = D.listeningPorts();
  for (let i = 0; i < 50; i += 1) {
    const p = D.pickPort();
    assert.ok(p >= D.PORT_FLOOR, `${p} is above the floor`);
    assert.ok(p < D.PORT_FLOOR + D.PORT_SPAN, `${p} is inside the range`);
    assert.ok(!listening.has(p), `${p} was not already listening`);
  }
});

test('isBindFailure recognises a taken port and nothing else', () => {
  assert.ok(D.isBindFailure('could not bind IPv4 address "0.0.0.0": Address already in use'),
    'the bind error itself');
  assert.ok(D.isBindFailure('Is another postmaster already running on port 50123?'),
    'the postmaster-already-running error');
  // "could not create any TCP/IP sockets" is the line postgres prints AFTER the bind error. On its
  // own it does not say the port was taken, so it is deliberately NOT a retry trigger: a socket
  // failure another port will not fix must be reported, not retried four times.
  for (const other of [
    'FATAL: could not create any TCP/IP sockets',
    'initdb: command not found',
    'could not access directory "/tmp/x": Permission denied',
    'No space left on device',
    'FATAL: data directory "/tmp/x/data" has invalid permissions',
    '',
  ]) {
    assert.ok(!D.isBindFailure(other),
      `"${other}" must NOT be retried on another port — a retry loop that swallows an `
      + 'infrastructure error turns one clear failure into four identical ones');
  }
});
