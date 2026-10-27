// ── THE KILL SWITCH ──────────────────────────────────────────────────────────
//
// P0.2. Stops autonomous execution without a deploy. Approved design:
// claude/p0-2-kill-switch-approved-design.md
//
// ── WHY A TABLE AND NOT A FLAG ───────────────────────────────────────────────
//
// `process.env` is captured at launch, so a Railway variable stops nothing until the container
// restarts — on 12 Oct that cost us 52 of 53 messages. And a deploy is not a stop mechanism: on
// 27 Oct a push's webhook was dropped and the commit sat undeployed for twenty minutes while
// /health happily reported the old one. So the switch lives in a row that any connection can write
// and every process re-reads, and the break-glass path is a direct INSERT that does not pass
// through the HTTP control plane it exists to stop.
//
// ── SEMANTICS: ADDITIVE, NEVER OVERRIDABLE ───────────────────────────────────
//
// ANY applicable stop = STOP. There is no "most specific wins", and there is no ALLOW row type at
// all — which is why no narrower configuration can bypass a broader stop. That is a property of the
// schema, not of this code being careful.
//
// ── THINKING vs ACTING ───────────────────────────────────────────────────────
//
// A consequential action (email, WhatsApp, an outbound post, spend) is stopped by a stop at any
// scope. Read-only reasoning is stopped ONLY by a stop on its own capability. So a global stop
// halts every external action while leaving analysis available — "stop all external actions but
// keep analysing what happened" is expressible, which it would not be if fail-closed were applied
// uniformly. Uniform fail-closed would also turn a transient database blip into a total outage,
// including of the analysis needed to diagnose it.
//
// ── FAIL-CLOSED, AND WHAT A STALE CACHE MAY NOT DO ───────────────────────────
//
// When kill-state cannot be determined, a consequential action is refused. A cached verdict is
// honoured only inside its TTL; past that, with the read still failing, consequential actions are
// refused rather than allowed on the strength of an old answer. The moment kill-state is
// unknowable, consequential autonomy halts.
//
// ── LATENCY, WITHOUT NEW INFRASTRUCTURE ──────────────────────────────────────
//
// Postgres LISTEN/NOTIFY — already in the database, no Redis. A trigger NOTIFYs on any change to
// the stop table, including a break-glass INSERT, and the listener invalidates the snapshot, so
// propagation is effectively immediate.
//
// Correctness NEVER depends on that. A dropped listener connection is silent, which is this
// codebase's signature failure mode, so the TTL poll is the floor: 1s for consequential lookups,
// 15s for read-only ones. Worst case with a dead listener is a ~1s window, inside the ≤2s target.
// The listener is an accelerator and nothing more.
'use strict';

const SCOPE_TYPES = ['global', 'company', 'agent', 'workflow', 'capability'];

// Stable capability identifiers, not implementation function names. Reserved but NOT implemented in
// P0.2: deployment.execute, quote.send, payment.execute, external.post. The namespace is preserved
// so adding one later is a row, not a migration.
const CAPABILITIES = ['email.send', 'whatsapp.send', 'llm.call'];

const TTL_CONSEQUENTIAL_MS = 1000;
const TTL_READONLY_MS = 15000;
const QUERY_TIMEOUT_MS = 2000;

const DDL = [
  `CREATE TABLE IF NOT EXISTS autonomy_stops (
     scope_type TEXT NOT NULL,
     scope_key  TEXT NOT NULL DEFAULT '',
     reason     TEXT NOT NULL,
     set_by     TEXT,
     set_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (scope_type, scope_key)
   )`,
  // Append-only. Nothing in the application UPDATEs or DELETEs from it: deleting the active stop row
  // must not erase the evidence that autonomy was stopped.
  `CREATE TABLE IF NOT EXISTS autonomy_events (
     id         BIGSERIAL PRIMARY KEY,
     at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     action     TEXT NOT NULL,
     scope_type TEXT,
     scope_key  TEXT,
     reason     TEXT NOT NULL,
     actor      TEXT,
     detail     JSONB
   )`,
  `CREATE INDEX IF NOT EXISTS idx_autonomy_events_at ON autonomy_events (at DESC)`,
  // The history and the NOTIFY are written by a TRIGGER rather than by the route handler, so a
  // break-glass `INSERT INTO autonomy_stops ...` typed into a database console gets both for free.
  // If this lived in the HTTP layer, the emergency path would be the one path with no audit trail.
  `CREATE OR REPLACE FUNCTION autonomy_stops_audit() RETURNS trigger AS $fn$
   DECLARE who TEXT;
   BEGIN
     who := COALESCE(NULLIF(current_setting('autonomy.actor', true), ''), 'sql-break-glass');
     IF TG_OP = 'DELETE' THEN
       INSERT INTO autonomy_events (action, scope_type, scope_key, reason, actor)
         VALUES ('RESUME', OLD.scope_type, OLD.scope_key,
                 COALESCE(NULLIF(current_setting('autonomy.resume_reason', true), ''),
                          'resumed (no reason recorded — break-glass path)'), who);
     ELSE
       INSERT INTO autonomy_events (action, scope_type, scope_key, reason, actor)
         VALUES ('STOP', NEW.scope_type, NEW.scope_key, NEW.reason, who);
     END IF;
     PERFORM pg_notify('autonomy_stop', TG_OP);
     RETURN NULL;
   END;
   $fn$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_autonomy_stops_audit ON autonomy_stops`,
  `CREATE TRIGGER trg_autonomy_stops_audit
     AFTER INSERT OR UPDATE OR DELETE ON autonomy_stops
     FOR EACH ROW EXECUTE FUNCTION autonomy_stops_audit()`,
];

async function migrateAutonomy(query) {
  for (const sql of DDL) await query(sql);
}

// ── the cache ────────────────────────────────────────────────────────────────
let snapshot = { at: 0, stops: null };   // stops: array of rows, or null = never loaded
let listener = { alive: false, starting: false, stop: null };

function resetForTests() {
  snapshot = { at: 0, stops: null };
  listener = { alive: false, starting: false, stop: null };
}

function withTimeout(p, ms) {
  let t;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`autonomy lookup timed out after ${ms}ms`)), ms); }),
  ]);
}

async function refresh(query, now) {
  const r = await withTimeout(query('SELECT scope_type, scope_key, reason FROM autonomy_stops'), QUERY_TIMEOUT_MS);
  snapshot = { at: now, stops: r.rows };
  return snapshot.stops;
}

// Best-effort LISTEN. Never awaited by a caller, never able to fail a check: if it cannot be
// established the TTL floor is what keeps the switch correct.
function ensureListener(deps) {
  if (listener.alive || listener.starting) return;
  let fn = deps.listen;
  if (!fn) { try { fn = require('./db').listen; } catch (_) { return; } }
  if (typeof fn !== 'function') return;
  listener.starting = true;
  Promise.resolve(fn('autonomy_stop', () => { snapshot.at = 0; }))
    .then((stop) => { listener = { alive: true, starting: false, stop }; })
    .catch(() => { listener = { alive: false, starting: false, stop: null }; });
}

// ── the decision ─────────────────────────────────────────────────────────────
// Reported broadest-first, so an operator reading a refusal sees "global" rather than whichever
// narrower scope happened to be checked first.
const BREADTH = { global: 0, company: 1, agent: 2, workflow: 3, capability: 4 };

function matchStop(stops, scopes, consequential) {
  const hits = [];
  for (const s of stops) {
    const t = s.scope_type;
    // Read-only reasoning is stopped only by a stop on its own capability. Every other scope is an
    // instruction about ACTING, and thinking is not acting.
    if (!consequential && t !== 'capability') continue;
    if (t === 'global') hits.push(s);
    else if (scopes[t] && s.scope_key === scopes[t]) hits.push(s);
  }
  hits.sort((a, b) => BREADTH[a.scope_type] - BREADTH[b.scope_type]);
  return hits[0] || null;
}

/**
 * The only question callers ask. Returns null when the action may proceed, or
 * { scope_type, scope_key, reason, unknown? } when it must not.
 *
 * scopes: { company?, agent?, workflow?, capability? }
 * consequential: true for anything with an effect outside this process (default).
 */
async function checkStopped(scopes = {}, { consequential = true, deps = {} } = {}) {
  const query = deps.query || require('./db').query;
  const now = (deps.now ? deps.now() : Date.now());
  const ttl = consequential ? TTL_CONSEQUENTIAL_MS : TTL_READONLY_MS;

  ensureListener(deps);

  let stops = snapshot.stops;
  const age = now - snapshot.at;
  if (stops === null || age >= ttl) {
    try {
      stops = await refresh(query, now);
    } catch (e) {
      // Kill-state is unknowable. A consequential action is refused; analysis continues.
      // A stale snapshot is NOT honoured here — it is past its TTL, which is the whole point.
      if (consequential) {
        return {
          scope_type: 'global',
          scope_key: '',
          reason: `kill-state could not be determined (${e.message}) — refusing consequential action`,
          unknown: true,
        };
      }
      return null;
    }
  }
  return matchStop(stops, scopes, consequential);
}

// ── writing a stop ───────────────────────────────────────────────────────────
// A reason is mandatory and must be meaningful: "incident reconstruction" is the entire point of
// the field, and "x" reconstructs nothing.
const MIN_REASON = 10;

function validate({ scope_type, scope_key, reason }) {
  if (!SCOPE_TYPES.includes(scope_type)) {
    return `scope_type must be one of ${SCOPE_TYPES.join(', ')}`;
  }
  if (scope_type === 'global') {
    if (scope_key) return "global stop takes no scope_key";
  } else if (!scope_key || !String(scope_key).trim()) {
    return `${scope_type} stop requires a scope_key`;
  }
  if (!reason || String(reason).trim().length < MIN_REASON) {
    return `reason is required and must be at least ${MIN_REASON} characters — it is what an incident review reads`;
  }
  return null;
}

// Actor travels to the audit trigger through a transaction-local setting, so the trigger records it
// without the application writing the history row itself (and therefore without being able to
// forget to).
async function stop({ scope_type, scope_key = '', reason, actor }, { deps = {} } = {}) {
  const err = validate({ scope_type, scope_key, reason });
  if (err) return { ok: false, error: err };
  const withTransaction = deps.withTransaction || require('./db').withTransaction;
  await withTransaction(async (client) => {
    await client.query('SELECT set_config($1, $2, true)', ['autonomy.actor', String(actor || 'unknown')]);
    await client.query(
      `INSERT INTO autonomy_stops (scope_type, scope_key, reason, set_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (scope_type, scope_key) DO UPDATE SET reason = $3, set_by = $4, set_at = NOW()`,
      [scope_type, scope_key, String(reason).trim(), String(actor || 'unknown')],
    );
  });
  snapshot.at = 0;   // this process sees it immediately; others via NOTIFY or the TTL floor
  return { ok: true };
}

async function resume({ scope_type, scope_key = '', reason, actor }, { deps = {} } = {}) {
  if (!SCOPE_TYPES.includes(scope_type)) return { ok: false, error: `scope_type must be one of ${SCOPE_TYPES.join(', ')}` };
  if (!reason || String(reason).trim().length < MIN_REASON) {
    return { ok: false, error: `reason is required for a resume too, and must be at least ${MIN_REASON} characters` };
  }
  const withTransaction = deps.withTransaction || require('./db').withTransaction;
  const n = await withTransaction(async (client) => {
    await client.query('SELECT set_config($1, $2, true)', ['autonomy.actor', String(actor || 'unknown')]);
    await client.query('SELECT set_config($1, $2, true)', ['autonomy.resume_reason', String(reason).trim()]);
    const r = await client.query('DELETE FROM autonomy_stops WHERE scope_type = $1 AND scope_key = $2',
      [scope_type, scope_key]);
    return r.rowCount;
  });
  snapshot.at = 0;
  return { ok: true, removed: n };
}

async function listStops({ deps = {} } = {}) {
  const query = deps.query || require('./db').query;
  const r = await query('SELECT scope_type, scope_key, reason, set_by, set_at FROM autonomy_stops ORDER BY set_at DESC');
  return r.rows;
}

async function history({ limit = 50, deps = {} } = {}) {
  const query = deps.query || require('./db').query;
  const r = await query(
    'SELECT id, at, action, scope_type, scope_key, reason, actor, detail FROM autonomy_events ORDER BY at DESC, id DESC LIMIT $1',
    [Math.min(Math.max(1, Number(limit) || 50), 500)],
  );
  return r.rows;
}

// Every refusal is recorded. A silently suppressed email is indistinguishable from the failure that
// lost 1,113 of them over eight weeks, so a stop that cannot be seen afterwards is not a safety
// control — it is a second outage wearing the first one's clothes.
//
// Fire-and-forget: a refusal must never throw into the caller it is protecting. When the database is
// the thing that is down, the console line is the last channel there is, and it is tagged so it can
// be found.
function recordRefusal({ stop: s, what, detail = {}, deps = {} }) {
  const query = deps.query || require('./db').query;
  try {
    const p = query(
      `INSERT INTO autonomy_events (action, scope_type, scope_key, reason, actor, detail)
       VALUES ('REFUSED', $1, $2, $3, $4, $5::jsonb)`,
      [s.scope_type, s.scope_key || '', s.reason, 'policy',
        JSON.stringify({ what, ...detail, unknown_kill_state: !!s.unknown })],
    );
    if (p && typeof p.catch === 'function') {
      p.catch((e) => console.error(`[STOPPED_BY_POLICY] could not record refusal of ${what}: ${e.message}`));
    }
  } catch (e) {
    console.error(`[STOPPED_BY_POLICY] could not record refusal of ${what}: ${e.message}`);
  }
}

// ── cron name → scope, so a company or agent stop reaches scheduled work ─────
//
// withAlerts only knows the workflow name. Without this map a company-scope stop would silently
// cover nothing scheduled — it would appear to work, which is the failure mode this whole week has
// been about. A test asserts that every withAlerts(...) name in server.js appears here, so a new
// cron cannot quietly escape company and agent stops: it fails preflight instead.
//
// company is null where the job is platform-level rather than one business's: halting all of
// Abiozen should not stop a data-accuracy audit that exists to tell you what the halt did.
const CRON_SCOPES = {
  'daily-0utc-metrics-snapshot':             { company: null,      agent: null },
  'daily-7cst-command-center-briefing':      { company: 'abiozen', agent: null },
  'weekly-mon-8utc-goal-engine':             { company: 'abiozen', agent: null },
  'weekly-mon-8utc-growth-agent':            { company: 'abiozen', agent: 'market-intelligence' },
  'weekly-mon-8utc-seo-agent':               { company: 'abiozen', agent: 'seo-agent' },
  'daily-8utc-github-sync':                  { company: null,      agent: null },
  'weekly-mon-9utc-weekly-analysis':         { company: 'abiozen', agent: null },
  'weekly-mon-9utc-revenue-intel':           { company: 'abiozen', agent: null },
  'weekly-mon-9cst-market-intelligence':     { company: 'abiozen', agent: 'market-intelligence' },
  'weekly-mon-930cst-email-engine':          { company: 'abiozen', agent: 'email-engine' },
  'hourly-17-sales-replies':                 { company: 'abiozen', agent: 'sales-agent' },
  'daily-18utc-milestone-triggers':          { company: 'abiozen', agent: null },
  'daily-18utc-performance-scoring':         { company: null,      agent: null },
  'daily-18utc-goal-divergence':             { company: 'abiozen', agent: null },
  'weekly-tue-9cst-procurement-rfqs':        { company: 'abiozen', agent: 'procurement-agent' },
  'daily-9cst-inquiry-agent':                { company: 'abiozen', agent: 'inquiry-agent' },
  'hourly-45-inquiry-poll':                  { company: 'abiozen', agent: 'inquiry-agent' },
  'daily-12cst-product-shadow-read':         { company: null,      agent: null },
  'weekly-wed-10cst-reorder-agent':          { company: 'abiozen', agent: 'reorder-agent' },
  'weekly-sun-20cst-reorder-agent':          { company: 'abiozen', agent: 'reorder-agent' },
  'nightly-23cst-research-agent':            { company: 'abiozen', agent: 'research-agent' },
  'weekly-mon-8cst-research-digest':         { company: 'abiozen', agent: 'research-agent' },
  'daily-2cst-research-intel':               { company: 'abiozen', agent: 'research-agent' },
  'weekly-mon-11cst-meet-agent':             { company: 'abiozen', agent: 'meet-agent' },
  'weekly-fri-16cst-meet-agent':             { company: 'abiozen', agent: 'meet-agent' },
  'biz-hours-2h-gemini-notes':               { company: 'abiozen', agent: 'meet-agent' },
  'weekly-thu-9cst-procurement-followup':    { company: 'abiozen', agent: 'procurement-agent' },
  'daily-2230cst-procurement-ist-briefing':  { company: 'abiozen', agent: 'procurement-agent' },
  'daily-130cst-dev-seo-ist-briefing':       { company: 'abiozen', agent: 'seo-agent' },
  'daily-7cst-ceo-briefing':                 { company: null,      agent: 'ceo-agent' },
  'weekly-mon-10cst-linkedin-content':       { company: 'abiozen', agent: 'linkedin-agent' },
  'weekdays-8cst-us-team-briefing':          { company: null,      agent: null },
  'hourly-05-cphi-followup':                 { company: 'abiozen', agent: 'cphi-followup' },
  'hourly-25-cphi-reply-sync':               { company: 'abiozen', agent: 'cphi-followup' },
  'weekly-mon-7cst-data-accuracy':           { company: null,      agent: null },
  'weekly-mon-620cst-research-ingest':       { company: 'abiozen', agent: 'research-agent' },
  'weekday-910cst-outreach-agent':           { company: 'abiozen', agent: 'outreach-agent' },
};

function scopesForCron(name) {
  const m = CRON_SCOPES[name] || {};
  return { workflow: name, company: m.company || undefined, agent: m.agent || undefined };
}

module.exports = {
  SCOPE_TYPES, CAPABILITIES, CRON_SCOPES,
  TTL_CONSEQUENTIAL_MS, TTL_READONLY_MS, QUERY_TIMEOUT_MS, MIN_REASON,
  migrateAutonomy, checkStopped, stop, resume, listStops, history,
  recordRefusal, scopesForCron, validate, matchStop,
  resetForTests,
};
