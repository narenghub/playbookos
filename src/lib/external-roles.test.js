// EXTERNAL ROLES — "we do not do to a partner what we do to our own staff", pinned.
//   node --test src/lib/external-roles.test.js
//
// The rule is a property of the ROLE, so the tests are about the role. The last test is the one that
// matters in six months: it greps every query in src/lib that sweeps MULTIPLE users and fails if a new
// one appears without either a role allowlist or the exclusion. That is the only way this stays true —
// nothing stops someone writing `SELECT ... FROM users WHERE is_active=1` and emailing everyone.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { BUILT_IN_ROLES, EXTERNAL_ROLES, isExternalRole, excludeExternalSql } = require('./roles');

test('partner is the external role, and no internal role is marked external', () => {
  assert.deepEqual(EXTERNAL_ROLES, ['partner']);
  for (const [key, def] of Object.entries(BUILT_IN_ROLES)) {
    if (key === 'partner') continue;
    assert.notEqual(def.external, true, `${key} must not be marked external`);
  }
});

test('an UNKNOWN role is not external — a custom role must still be scored', () => {
  // The fail-safe direction here is the opposite of the product boundary's. Treating an unrecognised
  // role as external would silently stop scoring everyone on a newly created custom role, and nobody
  // would notice for weeks.
  assert.equal(isExternalRole('some_custom_role'), false);
  assert.equal(isExternalRole(undefined), false);
  assert.equal(isExternalRole(null), false);
});

test('the SQL fragment is a bare AND clause that composes with an existing WHERE', () => {
  const sql = excludeExternalSql('u');
  assert.match(sql, /^ AND COALESCE\(u\.role, ''\) NOT IN \('partner'\)$/);
  assert.match(excludeExternalSql(), /^ AND COALESCE\(role, ''\) NOT IN \('partner'\)$/);
  // COALESCE, not a bare comparison: `role <> 'partner'` is NULL for a row with no role, and NULL
  // is not TRUE, so a role-less user would be dropped from scoring entirely.
  assert.match(sql, /COALESCE/);
});

test('every external role key is a bare identifier, because the fragment INLINES it', () => {
  // The fragment is not parameterised (it has to drop into queries that already number their params),
  // so a key with a quote in it would break the SQL. roles.js throws at require time; this states why.
  for (const key of EXTERNAL_ROLES) assert.match(key, /^[a-z][a-z0-9_]*$/);
});

// ── the call sites ──────────────────────────────────────────────────────────────
const SITES = [
  ['agents/orchestrator.js', 'generateKpiTasks — AI daily task assignment'],
  ['agents/orchestrator.js', 'runPerformanceCheck — the 6pm score'],
  ['agents/orchestrator.js', 'the escalation ladder'],
  ['agents/goal-engine.js', 'the goal cascade'],
  ['agents/goal-engine.js', 'assignWeeklyKPIsForAll'],
  ['agents/meet-agent.js', 'getTeam — meeting action items'],
  ['jobs.js', 'scoreAllAndCoach — the coaching email'],
];

test('each place that scores, coaches, assigns or emails the whole team excludes external roles', () => {
  const counts = {};
  for (const [file] of SITES) counts[file] = (counts[file] || 0) + 1;
  for (const [file, expected] of Object.entries(counts)) {
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const found = (src.match(/excludeExternalSql\(/g) || []).length;
    assert.ok(found >= expected,
      `${file}: expected at least ${expected} excludeExternalSql() call(s), found ${found}`);
  }
});

test('assignWeeklyKPIs refuses an external role even when called for one user directly', () => {
  const src = fs.readFileSync(path.join(__dirname, 'agents/goal-engine.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function assignWeeklyKPIs(userId'));
  assert.match(fn.slice(0, 1200), /isExternalRole\(user\.role\)/,
    'the per-user path is reachable from the route, so the guard has to be inside the function too');
});

// ── the sweep: anything NEW that reads the whole roster ─────────────────────────
//
// Known exemptions, each one read and justified. Anything not on this list that selects several users
// must exclude external roles, or this test fails — which is the alarm.
const EXEMPT = [
  // Single-row lookups of a specific internal person. A role filter of their own already excludes a
  // partner, because a partner is never admin/super_admin/a director.
  /role IN \('admin','super_admin'\)/,
  /role IN \('super_admin','admin'\)/,
  /role='admin'/, /role = 'admin'/,
  /role='procurement_director'/, /role='seo_specialist'/, /role='procurement'/,
  /role='dev'/, /role=\$1/, /role = \$1/,
  /role IN \('sales_team','account_manager'\)/,
  // The inquiry agent's employee-name list for the spam gate. It reads NAMES to decide whether an
  // inbound email greets a real person; a partner's name being recognised is correct, and no message
  // is ever sent to anyone in this list.
  /SELECT name FROM users WHERE name IS NOT NULL/,
  // Already filtered by the role allowlist passed in as a parameter.
  /role = ANY\(\$1\)/,
];

// Windows of source around each `FROM users`, rather than an attempt to extract the string literal:
// these queries are template literals containing ${...} with quotes inside them, so quote-matching
// splices unrelated code together and reports nonsense. A generous window either side is crude and
// honest — it can only produce a FALSE ALARM (a filter further away than the window), never a miss.
function userQueryWindows(src) {
  const out = [];
  for (const m of src.matchAll(/FROM users\b/gi)) {
    const start = Math.max(0, m.index - 200);
    out.push({
      text: src.slice(start, m.index + 340).replace(/\s+/g, ' ').trim(),
      line: src.slice(0, m.index).split('\n').length,
    });
  }
  return out;
}

function isSingleRowOrFiltered(w) {
  if (/\bLIMIT 1\b/i.test(w)) return true;                                   // one row
  if (/WHERE\s+(u\.)?id\s*=|WHERE\s+email\s*=|WHERE invite_token/i.test(w)) return true;  // one row by key
  if (/(INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE) users/i.test(w)) return true;
  if (/information_schema|COUNT\(\*\)/i.test(w)) return true;                 // counts, not recipients
  return false;
}

// WHY src/lib AND NOT src/api. The rule is about what we SEND a partner and what we SCORE them on,
// and that lives in the agents and jobs here. src/api deliberately includes partners in places — GET
// /api/users must list them, or a super_admin cannot see the account they created. The two API routes
// that email the roster (the zero-score nudge and the onboarding send) were patched by hand and are
// covered by the call-site test above.
test('SWEEP: no query in src/lib reads the whole roster without excluding external roles', () => {
  const offenders = [];
  let scanned = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.js') || e.name.endsWith('.test.js')) continue;
      const src = fs.readFileSync(full, 'utf8');
      for (const w of userQueryWindows(src)) {
        scanned++;
        if (isSingleRowOrFiltered(w.text)) continue;
        if (EXEMPT.some(re => re.test(w.text))) continue;
        if (/\$\{excludeExternalSql\(/.test(w.text)) continue;
        offenders.push(`${path.relative(__dirname, full)}:${w.line}\n      ${w.text.slice(-190)}`);
      }
    }
  };
  walk(__dirname);
  // Non-vacuity: if the scanner stops finding queries (a refactor, a broken regex) this test would pass
  // by looking at nothing at all. That is the failure mode of every grep-based test.
  assert.ok(scanned >= 20, `the scanner found only ${scanned} user queries — it has stopped working`);
  assert.deepEqual(offenders, [],
    `\n${offenders.length} query/queries appear to sweep multiple users without excluding external roles.\n` +
    `Either add \${excludeExternalSql(alias)} or, if a partner genuinely belongs in the result, add the\n` +
    `pattern to EXEMPT in this test with the reason:\n\n  ` + offenders.join('\n\n  ') + '\n');
});
