// ── THE KILL SWITCH, TESTED WHERE IT CAN BE TESTED WITHOUT A SERVER ──────────
//
// Semantics, precedence, the fail-closed matrix and the cache rules. The storage layer, the audit
// trigger, cross-process visibility and propagation latency need a real Postgres and live in
// scripts/check-autonomy-stop-db.js.
//
// Every test here is written so that disabling the guard it covers makes it fail. That is checked
// by mutation rather than assumed — on 27 Oct I shipped a test that passed with its fix removed.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const autonomy = require('./autonomy');
const { matchStop, validate, checkStopped, scopesForCron, resetForTests,
  TTL_CONSEQUENTIAL_MS, TTL_READONLY_MS, MIN_REASON, CRON_SCOPES } = autonomy;

const row = (scope_type, scope_key, reason = 'because of an incident') => ({ scope_type, scope_key, reason });

// A query stub that counts calls and can be made to fail or hang.
function stubQuery(rows, opts = {}) {
  const q = async () => {
    q.calls += 1;
    if (opts.throws) throw new Error(opts.throws);
    if (opts.hangMs) await new Promise((r) => setTimeout(r, opts.hangMs));
    return { rows: q.rows };
  };
  q.calls = 0;
  q.rows = rows;
  return q;
}

// ── A. GLOBAL DOMINANCE ──────────────────────────────────────────────────────

test('A1 — a global stop blocks with no narrower stop present', () => {
  const hit = matchStop([row('global', '')], { company: 'abiozen', agent: 'ceo-agent' }, true);
  assert.ok(hit, 'global stop must block');
  assert.strictEqual(hit.scope_type, 'global');
});

test('A2 — a global stop still blocks with any narrower scope also configured', () => {
  // The dangerous shape would be a precedence rule where a narrower row "wins" and could be read as
  // permission. There is no ALLOW row type at all, so this must hold for every combination.
  const narrower = [
    row('company', 'abiozen'), row('agent', 'ceo-agent'),
    row('workflow', 'daily-7cst-ceo-briefing'), row('capability', 'email.send'),
  ];
  for (let i = 0; i < narrower.length; i += 1) {
    const stops = [narrower[i], row('global', '')];
    const hit = matchStop(stops, {
      company: 'abiozen', agent: 'ceo-agent',
      workflow: 'daily-7cst-ceo-briefing', capability: 'email.send',
    }, true);
    assert.ok(hit, `global must still block alongside ${narrower[i].scope_type}`);
    assert.strictEqual(hit.scope_type, 'global',
      'the reported stop must be the broadest, so an operator is not told a narrower reason');
  }
});

test('A3 — no scope combination can bypass a global stop', () => {
  // Brute force every subset of narrower scopes that could be presented by a caller.
  const keys = ['company', 'agent', 'workflow', 'capability'];
  const vals = { company: 'abiozen', agent: 'ceo-agent', workflow: 'wf', capability: 'email.send' };
  for (let mask = 0; mask < 16; mask += 1) {
    const scopes = {};
    keys.forEach((k, i) => { if (mask & (1 << i)) scopes[k] = vals[k]; });
    assert.ok(matchStop([row('global', '')], scopes, true),
      `global bypassed with scopes ${JSON.stringify(scopes)}`);
  }
});

// ── ADDITIVE SEMANTICS ───────────────────────────────────────────────────────

test('any applicable stop blocks, at every scope', () => {
  const cases = [
    [[row('company', 'abiozen')], { company: 'abiozen' }],
    [[row('agent', 'outreach-agent')], { agent: 'outreach-agent' }],
    [[row('workflow', 'weekday-910cst-outreach-agent')], { workflow: 'weekday-910cst-outreach-agent' }],
    [[row('capability', 'email.send')], { capability: 'email.send' }],
  ];
  for (const [stops, scopes] of cases) {
    assert.ok(matchStop(stops, scopes, true), `${stops[0].scope_type} stop must block`);
  }
});

test('a stop on a DIFFERENT key does not block', () => {
  assert.strictEqual(matchStop([row('company', 'golfnex')], { company: 'abiozen' }, true), null);
  assert.strictEqual(matchStop([row('agent', 'ceo-agent')], { agent: 'outreach-agent' }, true), null);
  assert.strictEqual(matchStop([row('capability', 'whatsapp.send')], { capability: 'email.send' }, true), null);
});

test('an empty stop list allows everything', () => {
  assert.strictEqual(matchStop([], { company: 'abiozen', capability: 'email.send' }, true), null);
});

test('a scope the caller did not present cannot be matched', () => {
  // A cron with company:null must not be caught by a company stop — the alternative is a stop that
  // silently covers more than the operator asked for.
  assert.strictEqual(matchStop([row('company', 'abiozen')], { workflow: 'w' }, true), null);
});

// ── THINKING vs ACTING ───────────────────────────────────────────────────────

test('read-only reasoning survives a global stop', () => {
  // The CEO must be able to say "stop all external actions but keep analysing what happened".
  assert.strictEqual(matchStop([row('global', '')], { capability: 'llm.call' }, false), null);
});

test('read-only reasoning survives company, agent and workflow stops', () => {
  const stops = [row('company', 'abiozen'), row('agent', 'ceo-agent'), row('workflow', 'wf')];
  const scopes = { company: 'abiozen', agent: 'ceo-agent', workflow: 'wf', capability: 'llm.call' };
  assert.strictEqual(matchStop(stops, scopes, false), null);
});

test('read-only reasoning IS stopped by a stop on its own capability', () => {
  const hit = matchStop([row('capability', 'llm.call')], { capability: 'llm.call' }, false);
  assert.ok(hit, 'llm.call must remain independently stoppable');
  assert.strictEqual(hit.scope_type, 'capability');
});

test('the same stop list blocks a consequential action and permits analysis', () => {
  const stops = [row('global', '')];
  assert.ok(matchStop(stops, { capability: 'email.send' }, true), 'email must be stopped');
  assert.strictEqual(matchStop(stops, { capability: 'llm.call' }, false), null, 'analysis must continue');
});

// ── FAIL-CLOSED MATRIX ───────────────────────────────────────────────────────

test('D1 — a consequential action is REFUSED when the lookup throws', async () => {
  resetForTests();
  const q = stubQuery([], { throws: 'connection terminated unexpectedly' });
  const hit = await checkStopped({ capability: 'email.send' }, { consequential: true, deps: { query: q, listen: () => {} } });
  assert.ok(hit, 'an unreadable kill-state must refuse a consequential action');
  assert.strictEqual(hit.unknown, true);
  assert.match(hit.reason, /kill-state could not be determined/);
});

test('D2 — a consequential action is REFUSED when the lookup times out', async () => {
  resetForTests();
  const q = stubQuery([], { hangMs: autonomy.QUERY_TIMEOUT_MS + 500 });
  const hit = await checkStopped({ capability: 'email.send' }, { consequential: true, deps: { query: q, listen: () => {} } });
  assert.ok(hit, 'a hung lookup must refuse, not hang the caller indefinitely then proceed');
  assert.match(hit.reason, /timed out/);
});

test('D3 — read-only analysis PROCEEDS when the lookup fails', async () => {
  resetForTests();
  const q = stubQuery([], { throws: 'connection terminated unexpectedly' });
  const hit = await checkStopped({ capability: 'llm.call' }, { consequential: false, deps: { query: q, listen: () => {} } });
  assert.strictEqual(hit, null, 'a database blip must not take out diagnosis');
});

test('D4 — a STALE cache may not license a consequential action past its TTL', async () => {
  resetForTests();
  let t = 1_000_000;
  const q = stubQuery([]);                         // first read succeeds, list empty
  const deps = { query: q, listen: () => {}, now: () => t };
  assert.strictEqual(await checkStopped({ capability: 'email.send' }, { consequential: true, deps }), null);
  assert.strictEqual(q.calls, 1);

  // Now the database goes away and time moves past the consequential TTL.
  const failing = stubQuery([], { throws: 'server closed the connection' });
  t += TTL_CONSEQUENTIAL_MS + 1;
  const hit = await checkStopped({ capability: 'email.send' },
    { consequential: true, deps: { ...deps, query: failing } });
  assert.ok(hit, 'the stale "allowed" answer must not be reused once expired');
  assert.strictEqual(hit.unknown, true);
});

// ── CACHE AND LATENCY ────────────────────────────────────────────────────────

test('a fresh cache is served without re-querying, and expires at the consequential TTL', async () => {
  resetForTests();
  let t = 2_000_000;
  const q = stubQuery([]);
  const deps = { query: q, listen: () => {}, now: () => t };

  await checkStopped({ capability: 'email.send' }, { consequential: true, deps });
  assert.strictEqual(q.calls, 1);

  t += TTL_CONSEQUENTIAL_MS - 1;                   // still inside the window
  await checkStopped({ capability: 'email.send' }, { consequential: true, deps });
  assert.strictEqual(q.calls, 1, 'must not re-query inside the TTL');

  t += 2;                                          // now expired
  await checkStopped({ capability: 'email.send' }, { consequential: true, deps });
  assert.strictEqual(q.calls, 2, 'must re-query once the TTL has passed');
});

test('C — the consequential TTL bounds global-stop propagation inside the 2s target', async () => {
  resetForTests();
  let t = 3_000_000;
  const q = stubQuery([]);
  const deps = { query: q, listen: () => {}, now: () => t };

  await checkStopped({ capability: 'email.send' }, { consequential: true, deps });
  assert.strictEqual(await checkStopped({ capability: 'email.send' }, { consequential: true, deps }), null);

  // A stop lands in the database. With the NOTIFY listener dead, the TTL is the only thing that
  // will surface it — so the TTL alone must satisfy the target.
  q.rows = [row('global', '', 'CEO emergency stop — unexpected outbound campaign behaviour')];
  t += TTL_CONSEQUENTIAL_MS;
  const hit = await checkStopped({ capability: 'email.send' }, { consequential: true, deps });
  assert.ok(hit, 'the stop must be observed once the TTL has elapsed, with no listener and no restart');
  assert.ok(TTL_CONSEQUENTIAL_MS <= 2000,
    `consequential TTL is ${TTL_CONSEQUENTIAL_MS}ms, above the approved 2s propagation target`);
});

test('the read-only TTL is longer than the consequential one, and both are deliberate', () => {
  assert.ok(TTL_READONLY_MS > TTL_CONSEQUENTIAL_MS);
  assert.strictEqual(TTL_CONSEQUENTIAL_MS, 1000);
  assert.strictEqual(TTL_READONLY_MS, 15000);
});

// ── REASON IS MANDATORY ──────────────────────────────────────────────────────

test('a stop without a meaningful reason is rejected', () => {
  assert.ok(validate({ scope_type: 'global', scope_key: '', reason: '' }));
  assert.ok(validate({ scope_type: 'global', scope_key: '', reason: 'x' }));
  assert.ok(validate({ scope_type: 'global', scope_key: '', reason: '   ' }));
  assert.ok(validate({ scope_type: 'global', scope_key: '', reason: 'a'.repeat(MIN_REASON - 1) }));
  assert.strictEqual(validate({ scope_type: 'global', scope_key: '', reason: 'a'.repeat(MIN_REASON) }), null);
});

test('scope validation rejects unknown types and missing keys', () => {
  const reason = 'CEO emergency stop — outbound behaving unexpectedly';
  assert.ok(validate({ scope_type: 'everything', scope_key: '', reason }));
  assert.ok(validate({ scope_type: 'company', scope_key: '', reason }), 'a company stop needs a key');
  assert.ok(validate({ scope_type: 'global', scope_key: 'abiozen', reason }), 'global takes no key');
  assert.strictEqual(validate({ scope_type: 'company', scope_key: 'abiozen', reason }), null);
});

// ── THE CRON SCOPE MAP ───────────────────────────────────────────────────────

test('every withAlerts(...) name in server.js is present in CRON_SCOPES', () => {
  // Without this, a company or agent stop would silently cover nothing for a newly added cron —
  // the switch would appear to work while a job carried on. A new cron fails preflight instead.
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const names = [...src.matchAll(/withAlerts\(\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(names.length >= 37, `expected at least 37 cron names, found ${names.length}`);
  const missing = names.filter((n) => !Object.prototype.hasOwnProperty.call(CRON_SCOPES, n));
  assert.deepStrictEqual(missing, [],
    `these crons are not in CRON_SCOPES, so company/agent stops would not reach them: ${missing.join(', ')}`);
});

test('CRON_SCOPES has no entry for a cron that no longer exists', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const names = new Set([...src.matchAll(/withAlerts\(\s*'([^']+)'/g)].map((m) => m[1]));
  const stale = Object.keys(CRON_SCOPES).filter((k) => !names.has(k));
  assert.deepStrictEqual(stale, [], `stale CRON_SCOPES entries: ${stale.join(', ')}`);
});

test('scopesForCron always carries the workflow, and the mapped company/agent when known', () => {
  const s = scopesForCron('weekday-910cst-outreach-agent');
  assert.strictEqual(s.workflow, 'weekday-910cst-outreach-agent');
  assert.strictEqual(s.company, 'abiozen');
  assert.strictEqual(s.agent, 'outreach-agent');

  // An unmapped name still gets a workflow scope, so a global or workflow stop reaches it even if
  // the map is wrong. Degraded, not open.
  const u = scopesForCron('some-cron-nobody-mapped');
  assert.strictEqual(u.workflow, 'some-cron-nobody-mapped');
  assert.strictEqual(u.company, undefined);
  assert.strictEqual(u.agent, undefined);
});

test('platform-level crons are deliberately not attributed to a company', () => {
  // Halting all of Abiozen must not stop the audit that tells you what the halt did.
  for (const n of ['weekly-mon-7cst-data-accuracy', 'daily-12cst-product-shadow-read', 'daily-0utc-metrics-snapshot']) {
    assert.strictEqual(CRON_SCOPES[n].company, null, `${n} should not be company-scoped`);
  }
});

// ── D. THE SPY TESTS — THE BODY MUST NEVER BE REACHED ────────────────────────
//
// "It produced no output" is not evidence that a guard worked; the 2026-09-30 outage was a system
// producing no output while every monitor read green. These assert that the side-effecting function
// was never CALLED.

const { withAlerts } = require('./cron-alerts');

test('D5 — a stopped cron never reaches its body', async () => {
  resetForTests();
  let ran = 0;
  const q = stubQuery([row('global', '', 'CEO emergency stop — outbound campaign misbehaving')]);
  const job = withAlerts('weekday-910cst-outreach-agent', async () => { ran += 1; },
    { query: q, listen: () => {} });
  const out = await job();
  assert.strictEqual(ran, 0, 'the cron body was EXECUTED while autonomy was stopped');
  assert.ok(out && out.stopped_by_policy === true);
  assert.strictEqual(out.scope, 'global');
});

test('D6 — an unstopped cron does reach its body (the guard is not simply off)', async () => {
  resetForTests();
  let ran = 0;
  const q = stubQuery([]);
  const job = withAlerts('weekday-910cst-outreach-agent', async () => { ran += 1; },
    { query: q, listen: () => {} });
  const out = await job();
  assert.strictEqual(ran, 1, 'the guard is blocking work it should allow');
  assert.ok(!out || !out.stopped_by_policy);
});

test('D7 — a cron is halted when kill-state is unreadable, and still never reaches its body', async () => {
  resetForTests();
  let ran = 0;
  const q = stubQuery([], { throws: 'connection terminated unexpectedly' });
  const job = withAlerts('daily-9cst-inquiry-agent', async () => { ran += 1; },
    { query: q, listen: () => {} });
  const out = await job();
  assert.strictEqual(ran, 0, 'a cron ran with the brakes in unknown condition');
  assert.ok(out && out.stopped_by_policy === true);
});

test('D8 — a workflow stop halts only that cron', async () => {
  resetForTests();
  const q = stubQuery([row('workflow', 'weekday-910cst-outreach-agent', 'pausing cold outreach for review')]);
  const deps = { query: q, listen: () => {} };

  let a = 0; await withAlerts('weekday-910cst-outreach-agent', async () => { a += 1; }, deps)();
  assert.strictEqual(a, 0, 'the stopped workflow ran');

  resetForTests();
  let b = 0; await withAlerts('daily-7cst-ceo-briefing', async () => { b += 1; }, deps)();
  assert.strictEqual(b, 1, 'an unrelated cron was caught by a workflow-scoped stop');
});

test('D9 — an agent stop halts every cron belonging to that agent', async () => {
  const q = stubQuery([row('agent', 'reorder-agent', 'reorder logic under investigation')]);
  const deps = { query: q, listen: () => {} };
  for (const n of ['weekly-wed-10cst-reorder-agent', 'weekly-sun-20cst-reorder-agent']) {
    resetForTests();
    let ran = 0;
    await withAlerts(n, async () => { ran += 1; }, deps)();
    assert.strictEqual(ran, 0, `${n} ran despite an agent-scoped stop`);
  }
});

// ── THE OUTBOUND PRIMITIVES ──────────────────────────────────────────────────
//
// mailer/whatsapp/llm resolve autonomy at call time, so replacing the export is enough to drive
// them. The spy is on global fetch: the assertion is that the PROVIDER was never contacted.

function withStoppedAutonomy(stop, fn) {
  const real = autonomy.checkStopped;
  const realRecord = autonomy.recordRefusal;
  autonomy.checkStopped = async () => stop;
  autonomy.recordRefusal = () => {};
  const realFetch = global.fetch;
  let fetches = 0;
  global.fetch = async (...a) => { fetches += 1; return realFetch(...a); };
  const done = () => { autonomy.checkStopped = real; autonomy.recordRefusal = realRecord; global.fetch = realFetch; };
  return Promise.resolve(fn(() => fetches)).finally(done);
}

test('D10 — sendEmailDetailed never calls the provider when email.send is stopped', async () => {
  process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'test-key-not-used';
  const { sendEmailDetailed, sendEmail } = require('./mailer');
  await withStoppedAutonomy(row('capability', 'email.send', 'halting outbound while we investigate'), async (fetches) => {
    const r = await sendEmailDetailed({ to: 'nobody@example.com', subject: 's', html: '<p>x</p>' });
    assert.strictEqual(fetches(), 0, 'Resend was CONTACTED while email.send was stopped');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.stopped, true);
    assert.match(r.error, /^STOPPED_BY_POLICY:/);
    assert.strictEqual(r.id, null);

    // The boolean contract its 55 callers rely on is unchanged.
    const b = await sendEmail({ to: 'nobody@example.com', subject: 's', html: '<p>x</p>' });
    assert.strictEqual(b, false, 'sendEmail must still return a boolean');
  });
});

test('D11 — a policy stop is not reported as an ordinary send failure', async () => {
  const { sendEmailDetailed } = require('./mailer');
  await withStoppedAutonomy(row('global', '', 'CEO emergency stop — unexpected outbound behaviour'), async () => {
    const r = await sendEmailDetailed({ to: 'nobody@example.com', subject: 's', html: '<p>x</p>' });
    // STOPPED_BY_POLICY must be identifiable from the result, never indistinguishable from a
    // provider refusal. The durable half of this is asserted against Postgres.
    assert.strictEqual(r.stopped, true);
    assert.match(r.error, /STOPPED_BY_POLICY/);
    assert.doesNotMatch(r.error, /RESEND_API_KEY|not authorized/);
  });
});

test('D12 — sendWhatsApp never calls Twilio when whatsapp.send is stopped', async () => {
  process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
  process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'test';
  process.env.TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+10000000000';
  const { sendWhatsApp } = require('./whatsapp');
  await withStoppedAutonomy(row('capability', 'whatsapp.send', 'pausing escalation messages'), async (fetches) => {
    const r = await sendWhatsApp('+15551234567', 'hello');
    assert.strictEqual(fetches(), 0, 'Twilio was CONTACTED while whatsapp.send was stopped');
    assert.strictEqual(r.stopped_by_policy, true);
    // Must NOT be reported as `skipped`, which already means "Twilio is not configured".
    assert.strictEqual(r.skipped, undefined);
  });
});

test('D13 — callClaude is NOT stopped by a global stop, but IS by an llm.call stop', async () => {
  const { callClaude } = require('./llm');

  // A global stop must leave reasoning available. The call is allowed through the guard; it then
  // fails on the absent key, which is proof it got past the switch rather than being halted by it.
  const realKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const real = autonomy.checkStopped;
    autonomy.checkStopped = async (_s, o) => (o && o.consequential === false ? null : row('global', ''));
    const r = await callClaude({ model: 'claude-haiku-4-5-20251001', prompt: 'hi' });
    autonomy.checkStopped = real;
    assert.match(String(r.error), /ANTHROPIC_API_KEY/, 'a global stop silenced read-only reasoning');
    assert.ok(!r.stopped, 'reasoning must not be marked stopped by a global stop');
  } finally {
    if (realKey) process.env.ANTHROPIC_API_KEY = realKey;
  }

  // An llm.call stop must halt it, without contacting Anthropic.
  process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
  await withStoppedAutonomy(row('capability', 'llm.call', 'runaway prompt loop suspected'), async (fetches) => {
    const r = await callClaude({ model: 'claude-haiku-4-5-20251001', prompt: 'hi' });
    assert.strictEqual(fetches(), 0, 'Anthropic was CONTACTED while llm.call was stopped');
    assert.strictEqual(r.stopped, true);
    assert.match(r.error, /STOPPED_BY_POLICY/);
  });
});

// ── WHICH ENDPOINTS ARE GATED, AND WHICH MUST NOT BE ─────────────────────────
//
// Governing rule: STOP AUTONOMOUS ACTION, PRESERVE INBOUND EVIDENCE.
//
// Three unauthenticated endpoints cause autonomous execution and are gated. Three record inbound
// facts and are deliberately NOT gated, because halting them loses an order, a cross-product event
// or a Stripe payment confirmation while stopping no outbound action — Apollo and the storefront do
// not retry indefinitely, so a stop window becomes a permanent hole in the record.
//
// WHAT THIS TEST PROVES AND DOES NOT PROVE: it is a STRUCTURAL check over the handler bodies, not a
// behavioural one. It cannot prove the gate works — that is D5–D13 above and the Postgres check.
// What it catches is the two edits that would silently change policy: someone removing a gate from
// an endpoint that executes, or re-adding one to an endpoint that only records.

test('exactly the executing endpoints are gated; the recording endpoints are not', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'routes.js'), 'utf8');

  // Slice each handler from its router.post(...) to the start of the next route declaration.
  const handlerFor = (routePath) => {
    const i = src.indexOf(`router.post('${routePath}'`);
    assert.notStrictEqual(i, -1, `route ${routePath} not found — has it been renamed?`);
    const next = src.slice(i + 10).search(/\nrouter\.(get|post|put|patch|delete)\(/);
    return src.slice(i, next === -1 ? undefined : i + 10 + next);
  };

  // Executes: runs milestone triggers / a Claude call and an AI email to an external buyer.
  const MUST_BE_GATED = ['/triggers/check', '/inquiry/receive'];
  // Records only. engagement-event was gated in the first P0.2 implementation; the gate was removed
  // on 27 Oct by CEO decision under "stop autonomous action, preserve inbound evidence".
  const MUST_NOT_BE_GATED = ['/customers/engagement-event', '/orders/webhook', '/inquiry/stripe-webhook'];

  for (const p of MUST_BE_GATED) {
    assert.match(handlerFor(p), /autonomyHalt\(/,
      `${p} performs autonomous execution and MUST consult the kill switch`);
  }
  for (const p of MUST_NOT_BE_GATED) {
    assert.doesNotMatch(handlerFor(p), /autonomyHalt\(/,
      `${p} only records inbound evidence — gating it loses data and stops no outbound action`);
  }
});

test('/api/events/ingest is not gated either (inbound cross-product events)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'routes.js'), 'utf8');
  const i = src.indexOf("router.post('/events/ingest'");
  assert.notStrictEqual(i, -1);
  const body = src.slice(i, i + 700);
  assert.doesNotMatch(body, /autonomyHalt\(/,
    'events/ingest records inbound events; halting it loses them with no safety gain');
});
