// ── THE MONITOR CANNOT SEND ANYTHING (B4.5) ─────────────────────────────────
//
// Owner's Priority 3, directive of 2026-11-25: *"implement deduplicated monitoring with NO external
// notifications until separately authorized. Do not repurpose the `email.alert` exemption for
// business mail."*
//
// A configuration flag would satisfy that sentence and not satisfy its purpose: a flag can be set
// by anybody with access to the environment, and `email.alert` already exists as an exemption that
// a monitor could plausibly reach for. So the property asserted here is stronger and is a property
// of the module's SHAPE — the monitor requires no transport, so making it able to notify means
// ADDING a dependency, which is a reviewable change rather than a configuration one.
//
// Same reasoning as `office/memory.js` holding no transport: an adversarial memory has no body to
// put in front of one.
//
// Comments and string literals are blanked before the scan, so this file's own prose about mailers
// cannot satisfy the assertions it is making.
//
// IT LIVES IN scripts/ RATHER THAN BESIDE THE MODULE, with `proposal-is-readonly.test.js` and
// `membership-proposal-is-readonly.test.js`, which are exempt from the scope-discipline scanner for
// the same reason: this file QUOTES the SQL it forbids, in its assertions and in its own negative
// control, and the scanner cannot tell prose about SQL from SQL. That scanner refuses any exemption
// under `src/` — deliberately, because an exemption there is how company scoping moves back to call
// sites — so the honest place for a test that needs one is where its siblings already are.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'src', 'lib', 'office', 'monitor.js');

function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\[\s\S]|[^'\\])*'/g, "''")
    .replace(/"(?:\\[\s\S]|[^"\\])*"/g, '""');
}

const RAW = fs.readFileSync(FILE, 'utf8');
const CODE = codeOnly(RAW);

test('it requires no transport of any kind', () => {
  const targets = [...RAW.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  const forbidden = targets.filter((t) => /mailer|whatsapp|twilio|resend|notify|dispatch|slack|sms|outbound/i.test(t));
  assert.deepEqual(forbidden, [],
    `the monitor requires ${forbidden.join(', ')}: a monitor that can send is one notification away `
    + 'from being an external communication nobody authorized');
});

test('no outward call exists in its executable code', () => {
  for (const shape of [/\bfetch\s*\(/, /\bhttps?\.request\s*\(/, /\baxios\b/, /XMLHttpRequest/,
    /sendMail/, /sendCronAlert/, /\.send\s*\(/]) {
    assert.equal(shape.test(CODE), false, `${shape} appears in executable code`);
  }
});

test('it does not reach for the email.alert exemption', () => {
  // Named explicitly because it is the one exemption a monitor would plausibly use, and the owner
  // called it out: "do not repurpose the email.alert exemption for business mail."
  assert.equal(/email\.alert/.test(CODE), false,
    'the monitor names the email.alert capability in executable code');
});

test('its only writer is the alerts accessor', () => {
  // `recordAlert` and `resolveAlertsExcept` are the two writes it is allowed to make, and both go
  // through scope.js. No SQL of its own, and no other writer.
  // The keyword must look like SQL, not like a method: `\bUPDATE\b` case-insensitively matched
  // `crypto.createHash(...).update(...)` in `alertId`, and reported the monitor as writing its own
  // SQL. A pattern that cannot tell `.update(` from `UPDATE office_monitor_alerts` is measuring
  // spelling. So: not preceded by a dot or word character, and followed by whitespace and a table
  // identifier — the same shape check-office-scope-discipline.js arrived at for the same reason.
  for (const kw of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
    const sqlShaped = new RegExp(`(^|[^.\\w])${kw}\\s+(INTO\\s+)?[a-z_"]`, 'i');
    assert.equal(sqlShaped.test(CODE), false,
      `${kw} appears as SQL in executable code: the alerts table has an accessor`);
  }
  const writers = [...CODE.matchAll(/scope\.(\w+)/g)].map((m) => m[1]);
  const unexpected = writers.filter((w) => !['recordAlert', 'resolveAlertsExcept',
    'schedulerHeartbeats'].includes(w));
  assert.deepEqual(unexpected, [], `it also calls scope.${unexpected.join(', scope.')}`);
});

test('CONTROL: the SQL pattern fires on planted SQL and not on a method call', () => {
  // Without this, the narrowing above could have been a silencing. The same two strings, through
  // the same pattern: one must be caught and one must not.
  const sqlShaped = (kw) => new RegExp(`(^|[^.\\w])${kw}\\s+(INTO\\s+)?[a-z_"]`, 'i');
  assert.equal(sqlShaped('UPDATE').test('await query(`UPDATE office_monitor_alerts SET x=1`)'),
    true, 'planted SQL must be caught');
  assert.equal(sqlShaped('UPDATE').test('createHash("sha256").update(subject)'), false,
    'a method named update must not be mistaken for SQL');
  assert.equal(sqlShaped('INSERT').test('`INSERT INTO office_monitor_alerts (id) VALUES ($1)`'),
    true, 'planted INSERT must be caught');
});

test('it cannot advance, dispatch, stop or resume anything', () => {
  for (const act of ['advanceCycle', 'enqueueTask', 'claimTask', 'submitResult', 'retryRun',
    'stop(', 'resume(', 'grantMembership', 'assignTask']) {
    assert.equal(CODE.includes(act), false,
      `${act} appears: a monitor that acts is not a monitor`);
  }
});

test('the severities and codes are closed, frozen vocabularies', () => {
  const M = require('../src/lib/office/monitor');
  assert.ok(Object.isFrozen(M.SEVERITY));
  assert.ok(Object.isFrozen(M.CODES));
  assert.deepEqual(Object.values(M.SEVERITY).sort(), ['critical', 'info', 'warning']);
  // Every code must be distinct, or two conditions would share an alert id and one would hide the
  // other behind the other's `occurrences` count.
  const codes = Object.values(M.CODES);
  assert.equal(new Set(codes).size, codes.length);
});

test('the alert id is derived from the code AND the subject', () => {
  const M = require('../src/lib/office/monitor');
  const a = M.alertId(M.CODES.WORKER_OFFLINE, 'worker-1');
  const b = M.alertId(M.CODES.WORKER_OFFLINE, 'worker-2');
  const c = M.alertId(M.CODES.WORKER_NEVER_AUTHENTICATED, 'worker-1');
  assert.notEqual(a, b, 'two workers with the same fault must be two alerts');
  assert.notEqual(a, c, 'two faults on the same worker must be two alerts');
  assert.equal(a, M.alertId(M.CODES.WORKER_OFFLINE, 'worker-1'), 'and it must be stable');
  // Readable rather than hashed — see alertId's note on the digest-discipline scanner. The shape
  // assertion is that the id NAMES its code and its subject, which is what makes the alerts table
  // legible without a join.
  assert.match(a, /^alert-worker_offline-worker-1$/);
  assert.equal(M.alertId('x', 'a b/c'), 'alert-x-a_b_c');
});

test('a scheduler that is switched off is INFO, not an alarm', async () => {
  // The finding that would otherwise fire on every sweep of every day, since
  // OFFICE_INITIATOR_ENABLED is set nowhere. An alert that fires because the system is deliberately
  // inert is noise, and noise is what makes a real alert unreadable.
  const M = require('../src/lib/office/monitor');
  const ctx = Object.freeze({ companyId: 'co-test' });
  const r = await M.evaluate(ctx, { schedulerEnabled: false }, {
    commandCenter: { snapshot: async () => ({ at: new Date().toISOString(), workers: [],
      workersUnreadable: false, liveCapabilities: [], work: { byState: {}, blockedBacklog: [],
        servableBacklog: [] }, objectives: [], history: [], stops: [], refusals: [],
      operationalFacts: null, factQuality: null, unreadable: [] }),
    WORKER_STATUS: { OFFLINE: 'offline', UNKNOWN: 'unknown', REVOKED: 'revoked' } },
    scope: { schedulerHeartbeats: async () => [] },
  });
  const f = r.findings.find((x) => x.code === M.CODES.SCHEDULER_DISABLED);
  assert.ok(f, 'a disabled scheduler must be reported');
  assert.equal(f.severity, 'info');
  assert.equal(r.findings.some((x) => x.code === M.CODES.SCHEDULER_SILENT), false,
    'and it must NOT also be reported as silent');
});

test('an ENABLED scheduler with no heartbeat is critical', async () => {
  const M = require('../src/lib/office/monitor');
  const ctx = Object.freeze({ companyId: 'co-test' });
  const r = await M.evaluate(ctx, { schedulerEnabled: true }, {
    commandCenter: { snapshot: async () => ({ at: new Date().toISOString(), workers: [],
      workersUnreadable: false, liveCapabilities: [], work: { byState: {}, blockedBacklog: [],
        servableBacklog: [] }, objectives: [], history: [], stops: [], refusals: [],
      operationalFacts: null, factQuality: null, unreadable: [] }),
    WORKER_STATUS: { OFFLINE: 'offline', UNKNOWN: 'unknown', REVOKED: 'revoked' } },
    scope: { schedulerHeartbeats: async () => [] },
  });
  const f = r.findings.find((x) => x.code === M.CODES.SCHEDULER_SILENT);
  assert.ok(f, 'an enabled scheduler that has never beaten must be reported');
  assert.equal(f.severity, 'critical');
});
