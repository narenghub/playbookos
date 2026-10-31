#!/usr/bin/env node
// ── NO SUPPLIER RFQ SENDS AN UNSUPPORTED CAS, PROVEN AGAINST POSTGRES ───────
//
//   node scripts/check-rfq-identity-guard-db.js     exit 0 = the guard holds
//
// The invariant:
//
//   > No consequential supplier RFQ may send a CAS unless the canonical identity supports that CAS
//   > for the exact substance and form being requested.
//
// ── WHY A SPY, NOT AN ABSENCE OF OUTPUT ─────────────────────────────────────
//
// The mailer is replaced with a spy before the agent is loaded, so "no email was attempted" is a
// MEASUREMENT and not an inference. "Nothing appeared to happen" is not evidence that nothing was
// tried — the same reason check-run-canary-db.js spies on its body rather than checking for output.
//
// ── WHY EVERY REFUSAL ALSO ASSERTS ZERO CLAIMS ──────────────────────────────
//
// rfqClaim.claim writes a `pending` row to supplier_outreach_log BEFORE the email exists. A guard
// placed after the claim would therefore leave a durable record of an attempt that policy had
// already forbidden — and that row is what gate2-identity-evidence.js reads to decide whether a
// supplier was contacted. So a refusal is only correct if it leaves NO claim behind.
//
// ── THE FIXTURE IS THE REAL INCIDENT ────────────────────────────────────────
//
// Tramadol Hydrochloride, filed 27203-92-5, canonical 36282-47-0. Both pass the checksum, which is
// precisely why the quote guard's checksum test is insufficient here. It reached Laurus Labs,
// Divi's and Dr Reddy's on 21 July 2026 with the number in the subject line. There is no
// Tramadol-specific condition anywhere in the code; the fixture tests the general rule against the
// specific thing that actually happened.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let fail = 0;
const out = (s) => fs.writeSync(1, s + '\n');
const ok = (m) => out(`  ok    ${m}`);
const bad = (m, d) => { fail++; out(`  FAIL  ${m}`); if (d) out(`          ${String(d).slice(0, 500)}`); };
const h = (n, t) => out(`\n── ${n}. ${t}`);

const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/usr/bin'];
function findInitdb() {
  for (const d of BIN) { const p = path.join(d, 'initdb'); if (fs.existsSync(p)) return d; }
  return null;
}
let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/rfqguard-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55997' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data -A trust`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55997 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55997&sslmode=disable`;
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

const url = process.env.MOLID_PG_URL || startTemp();
if (!url) {
  out('  skip  no Postgres available (set MOLID_PG_URL or install initdb)');
  out('SKIP  RFQ identity guard not executed — this check needs a server');
  process.exit(0);
}
process.env.DATABASE_URL = url;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'PLACEHOLDER-test-key';

// ── THE SPY, INSTALLED BEFORE THE AGENT LOADS ───────────────────────────────
const REPO = path.join(__dirname, '..');
const MAILER = require.resolve(path.join(REPO, 'src', 'lib', 'mailer.js'));
const sent = [];
require.cache[MAILER] = {
  id: MAILER, filename: MAILER, loaded: true, exports: {
    sendEmail: async (m) => { sent.push(m); return true; },
    sendEmailDetailed: async (m) => { sent.push(m); return { ok: true }; },
    encodeAttachments: () => [], MAX_ATTACH_BYTES: 1,
  },
};
// Claude is never called: generateRFQEmail falls back to a template body when it returns nothing.
// ── WHY global fetch IS STUBBED ─────────────────────────────────────────────
//
// callClaude is defined LOCALLY in procurement-agent (line 28), so it cannot be replaced through
// require.cache. It returns `{ text: null }` without an API key, generateRFQEmail returns
// `body: text || null`, and dispatch treats a null body as a FAILED send -- so with no stub the
// send path never executes and every subject assertion reads `undefined`. That is an assertion
// passing for an unrelated reason, which is not evidence; it is how the first run of this check
// reported green on sections that had never sent anything.
//
// Stubbing global fetch is the narrowest interception that makes the real path run: production code
// is untouched, no network call is made, and the Anthropic response shape is exactly what
// extractClaudeText parses.
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'PLACEHOLDER-test-key';
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ content: [{ type: 'text', text: 'Dear supplier,\n\nPlease quote.\n\nPalash' }] }),
  text: async () => '',
});

const { query } = require('../src/lib/db');
const guard = require('../src/lib/procurement/rfq-identity-guard');
const rfqClaim = require('../src/lib/idempotency/supplier-rfq');
const { DDL_TABLES, DDL_TRIGGERS, applyConflictKinds, applyDriftColumns } = require('./migrate-molecules');
const GUARD_FILE = path.join(REPO, 'src', 'lib', 'procurement', 'rfq-identity-guard.js');
const AGENT_FILE = path.join(REPO, 'src', 'lib', 'agents', 'procurement-agent.js');

const FIXTURE = `
  CREATE TABLE IF NOT EXISTS rfq_requests (
    id TEXT PRIMARY KEY, molecule_name TEXT NOT NULL, cas_number TEXT, target_quantity TEXT,
    target_purity TEXT, gmp_required INTEGER DEFAULT 0, week_start TEXT, status TEXT DEFAULT 'pending',
    priority TEXT, assigned_to_user_id TEXT, approval_id TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
  -- EXACTLY production's shape (db.js:724 plus the two ALTERs in idempotency/supplier-rfq.js):
  -- sent_at and replied_at are TEXT, claimed_at is TIMESTAMPTZ. The first version of this fixture
  -- made all three TIMESTAMPTZ, which is MORE PERMISSIVE than production and hid a type error in
  -- the reconciliation's COALESCE(claimed_at, sent_at). A fixture looser than the real schema
  -- defeats the check it belongs to.
  CREATE TABLE IF NOT EXISTS supplier_outreach_log (
    id TEXT PRIMARY KEY, rfq_id TEXT, supplier_id TEXT, email_sent_to TEXT, email_subject TEXT,
    email_body TEXT, sent_at TEXT, replied_at TEXT, reply_text TEXT,
    status TEXT DEFAULT 'sent' CHECK (status IN ('pending','sent','failed','replied','no_response')),
    claimed_at TIMESTAMPTZ, error TEXT);
  CREATE TABLE IF NOT EXISTS suppliers (
    id TEXT PRIMARY KEY, name TEXT, region TEXT, specialties TEXT, reliability_score REAL,
    gmp_certified INTEGER DEFAULT 1, contact_email TEXT, contact_name TEXT,
    avg_response_days REAL DEFAULT 3, total_orders INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT, name TEXT, role TEXT, is_active INTEGER DEFAULT 1,
    whatsapp_number TEXT, created_at TEXT DEFAULT NOW(), excluded_from_scoring BOOLEAN DEFAULT FALSE);
  CREATE TABLE IF NOT EXISTS agent_activity_log (
    id TEXT PRIMARY KEY, agent_name TEXT, action_type TEXT, user_id TEXT, reasoning TEXT,
    source_kpi TEXT, confidence_score INTEGER, output_summary TEXT,
    requires_approval INTEGER DEFAULT 0, created_at TEXT DEFAULT NOW());
`;

// Molecules: a salt with a CAS, its base with a DIFFERENT CAS (the form-mismatch pair), one with a
// withheld CAS (Decision 1), and one deprecated.
const SALT_CAS = '36282-47-0';      // Tramadol Hydrochloride — canonical
const BASE_CAS = '27203-92-5';      // Tramadol — what was filed on the real RFQ
const MALFORMED = '115400-33-8';    // checksum-invalid, from O-Desmethyltramadol's filed value

const freshAgent = () => {
  for (const k of Object.keys(require.cache)) {
    if (k === MAILER) continue;
    if (k.startsWith(path.join(REPO, 'src')) || k.startsWith(path.join(REPO, 'scripts'))) {
      delete require.cache[k];
    }
  }
  return require(AGENT_FILE);
};

const reset = async () => {
  sent.length = 0;
  await query('DELETE FROM supplier_outreach_log');
  await query('TRUNCATE rfq_identity_decisions');
};
const claims = async (rfqId) => (await query(
  `SELECT COUNT(*)::int n FROM supplier_outreach_log WHERE rfq_id=$1`, [rfqId])).rows[0].n;
const lastDecision = async (rfqId) => (await query(
  `SELECT * FROM rfq_identity_decisions WHERE rfq_id=$1 ORDER BY id DESC LIMIT 1`, [rfqId])).rows[0];

async function mkRfq(id, name, cas) {
  await query(
    `INSERT INTO rfq_requests (id, molecule_name, cas_number, target_quantity, target_purity,
       gmp_required, week_start, status)
     VALUES ($1,$2,$3,'1kg','99%',1,'2026-10-26','pending')
     ON CONFLICT (id) DO UPDATE SET molecule_name=$2, cas_number=$3`, [id, name, cas]);
}

(async () => {
  await query(DDL_TABLES);
  await query(DDL_TRIGGERS);
  await applyConflictKinds(query);
  await applyDriftColumns(query, () => {});
  await query(FIXTURE);
  await guard.migrate(query);
  const claimIdx = await rfqClaim.migrate(query);
  if (!claimIdx.enforced) { bad('fixture: claim uniqueness not enforced', JSON.stringify(claimIdx)); }

  await query(
    `INSERT INTO molecules (preferred_name, normalized_name, cas, substance_form, source, derivation_method)
     VALUES ('Tramadol hydrochloride','tramadol hydrochloride',$1,'salt','fixture','exact'),
            ('Tramadol','tramadol',$2,'base','fixture','exact'),
            ('Withheldium','withheldium',NULL,'base','fixture','exact'),
            ('Deprecatium','deprecatium','50-00-0','base','fixture','exact')`, [SALT_CAS, BASE_CAS]);
  await query(
    `UPDATE molecules SET cas_suppressed_reason='cas_disagreement:1,2' WHERE normalized_name='withheldium'`);
  await query(
    `UPDATE molecules SET deprecated_at=NOW(),
       deprecated_reason='cas_disagreement:a,b|rev=AUTO_REVERSIBLE|rows=2|at=2026-10-31T00:00:00.000Z'
     WHERE normalized_name='deprecatium'`);
  await query(
    `INSERT INTO suppliers (id,name,region,specialties,reliability_score,gmp_certified,contact_email)
     VALUES ('s1','Laurus Labs','india','["api"]',80,1,'business@lauruslabs.com')`);
  await query(
    `INSERT INTO users (id,email,name,role) VALUES ('u-p','palash@abiozen.com','Palash Das','procurement_director')`);

  let agent = freshAgent();

  // ── 1. the guard runs BEFORE the claim ──────────────────────────────────
  h(1, 'the guard decides before any supplier claim exists');
  await reset();
  await mkRfq('r-disputed', 'Tramadol Hydrochloride', BASE_CAS);
  let r = await agent.sendRFQEmails(['r-disputed']);
  let d = await lastDecision('r-disputed');
  if (d && d.decision === 'refuse') ok('a decision row exists for a refused RFQ');
  else bad('no refusal decision was persisted', JSON.stringify(d));
  if (await claims('r-disputed') === 0) ok('a refusal leaves ZERO supplier claims — guard precedes claim');
  else bad(`a refusal left ${await claims('r-disputed')} claim(s)`);
  if (sent.length === 0) ok('a refusal attempted no email — measured by spy, not inferred');
  else bad(`a refusal sent ${sent.length} email(s)`);

  // ── 2. THE TRAMADOL FIXTURE: disputed CAS refuses ───────────────────────
  h(2, 'disputed CAS — the historical direction');
  if (d && d.refusal_reason === 'cas_disputed') ok(`refusal reason is cas_disputed (filed ${BASE_CAS} vs canonical ${SALT_CAS})`);
  else bad(`refusal reason was ${d && d.refusal_reason}, expected cas_disputed`);
  if (d && d.cas_class === 'valid') ok('the filed CAS is recorded as checksum-VALID, so no checksum path could pass it');
  else bad(`cas_class was ${d && d.cas_class}, expected valid`);
  if (d && d.approved_cas === null) ok('a refusal approves no CAS');
  else bad(`a refusal approved ${d && d.approved_cas}`);
  if (d && d.filed_cas === BASE_CAS) ok('the filed value is preserved verbatim as evidence');
  else bad('the filed value was not preserved');

  h('2b', 'disputed CAS — the REVERSE form mismatch');
  await reset();
  await mkRfq('r-reverse', 'Tramadol', SALT_CAS);   // base name, salt's CAS
  await agent.sendRFQEmails(['r-reverse']);
  d = await lastDecision('r-reverse');
  if (d && d.decision === 'refuse' && d.refusal_reason === 'cas_disputed'
      && await claims('r-reverse') === 0 && sent.length === 0) {
    ok('the reverse substitution (base name + salt CAS) is refused, no claim, no send');
  } else {
    bad('the reverse form mismatch was not refused', JSON.stringify({ d, sent: sent.length }));
  }

  // ── 3. allowed: agreeing CAS ────────────────────────────────────────────
  h(3, 'resolved, eligible, agreeing CAS — SEND');
  await reset();
  await mkRfq('r-ok', 'Tramadol Hydrochloride', SALT_CAS);
  r = await agent.sendRFQEmails(['r-ok']);
  d = await lastDecision('r-ok');
  if (d && d.decision === 'allow' && d.approved_cas === SALT_CAS) ok('allowed, approving the canonical CAS');
  else bad('an agreeing CAS was not allowed', JSON.stringify(d));
  if (sent.length === 1) ok('exactly one email was sent');
  else bad(`${sent.length} email(s) sent, expected 1`);
  if (sent[0] && sent[0].subject.includes(SALT_CAS)) ok('the subject carries the canonical CAS');
  else bad(`subject was ${sent[0] && sent[0].subject}`);
  if (d && d.molecule_id && d.molecule_ref) ok('the decision names the exact canonical identity used');
  else bad('the decision does not name a canonical identity');

  // ── 4. allowed: canonical identity intentionally has no CAS ─────────────
  h(4, 'resolved, eligible, canonical CAS withheld — SEND WITHOUT CAS');
  await reset();
  await mkRfq('r-nocas', 'Withheldium', BASE_CAS);   // a well-formed filed CAS, canonical has none
  await agent.sendRFQEmails(['r-nocas']);
  d = await lastDecision('r-nocas');
  if (d && d.decision === 'allow' && d.approved_cas === null) {
    ok('allowed with NO CAS — the filed value is not copied in because canonical is absent');
  } else { bad('withheld-CAS case mishandled', JSON.stringify(d)); }
  if (sent.length === 1 && !sent[0].subject.includes(BASE_CAS)) {
    ok('the subject omits the CAS entirely rather than borrowing the filed one');
  } else { bad(`subject leaked a CAS: ${sent[0] && sent[0].subject}`); }

  // ── 5. malformed filed CAS ──────────────────────────────────────────────
  h(5, 'malformed filed CAS, identity independently resolved — SEND WITH CANONICAL CAS');
  await reset();
  await mkRfq('r-malformed', 'Tramadol Hydrochloride', MALFORMED);
  await agent.sendRFQEmails(['r-malformed']);
  d = await lastDecision('r-malformed');
  if (d && d.cas_class === 'malformed') ok(`the filed value is classified cas_malformed (${MALFORMED})`);
  else bad(`cas_class was ${d && d.cas_class}`);
  if (d && d.decision === 'allow' && d.approved_cas === SALT_CAS) {
    ok('allowed with the CANONICAL CAS — identity established independently, filed value discarded');
  } else { bad('malformed case mishandled', JSON.stringify(d)); }
  if (sent.length === 1 && !sent[0].subject.includes(MALFORMED)) ok('the malformed value never reaches the subject');
  else bad(`the malformed value leaked: ${sent[0] && sent[0].subject}`);
  if (d && d.filed_cas === MALFORMED) ok('the malformed filed value is preserved as source evidence');
  else bad('the malformed filed value was not preserved');

  // ── 6. unresolved identity ──────────────────────────────────────────────
  h(6, 'identity unresolved — REFUSE, no fallback to the filed name or CAS');
  await reset();
  await mkRfq('r-unres', 'Cefuroxime Axetil', SALT_CAS);
  await agent.sendRFQEmails(['r-unres']);
  d = await lastDecision('r-unres');
  if (d && d.refusal_reason === 'identity_unresolved' && await claims('r-unres') === 0 && sent.length === 0) {
    ok('refused with no claim and no send; the filed name did not become identity');
  } else { bad('unresolved case mishandled', JSON.stringify({ d, sent: sent.length })); }

  // ── 7. deprecated identity ──────────────────────────────────────────────
  h(7, 'identity deprecated — REFUSE');
  await reset();
  await mkRfq('r-dep', 'Deprecatium', '50-00-0');
  await agent.sendRFQEmails(['r-dep']);
  d = await lastDecision('r-dep');
  if (d && d.refusal_reason === 'identity_deprecated' && sent.length === 0) {
    ok('a deprecated identity is refused even with a perfectly agreeing CAS');
  } else { bad('deprecated case mishandled', JSON.stringify({ d, sent: sent.length })); }

  // ── 8. no parent-CAS borrowing ──────────────────────────────────────────
  h(8, 'the guard does not walk parent_molecule_id for a CAS');
  await reset();
  // A salt whose canonical CAS is absent, with a parent that HAS one. The guard must send no CAS.
  await query(
    `INSERT INTO molecules (preferred_name, normalized_name, cas, substance_form, parent_molecule_id,
       derived_base_name, source, derivation_method)
     SELECT 'Orphanium acetate','orphanium acetate',NULL,'salt', m.id,'tramadol','fixture','exact'
       FROM molecules m WHERE m.normalized_name='tramadol'
     ON CONFLICT DO NOTHING`);
  await mkRfq('r-parent', 'Orphanium acetate', null);
  await agent.sendRFQEmails(['r-parent']);
  d = await lastDecision('r-parent');
  if (d && d.decision === 'allow' && d.approved_cas === null) {
    ok('a salt with no canonical CAS sends none, though its parent has one');
  } else { bad('parent-CAS case mishandled', JSON.stringify(d)); }
  if (sent.length === 1 && !sent[0].subject.includes(BASE_CAS)) ok("the parent's CAS did not appear in the subject");
  else bad(`the parent CAS leaked: ${sent[0] && sent[0].subject}`);

  // ── 9. a refused retry stays refused and claims nothing ─────────────────
  h(9, 'idempotency of refusal');
  await reset();
  await mkRfq('r-retry', 'Tramadol Hydrochloride', BASE_CAS);
  await agent.sendRFQEmails(['r-retry']);
  await agent.sendRFQEmails(['r-retry']);
  const decisionCount = (await query(
    `SELECT COUNT(*)::int n FROM rfq_identity_decisions WHERE rfq_id='r-retry'`)).rows[0].n;
  if (decisionCount === 2 && await claims('r-retry') === 0 && sent.length === 0) {
    ok('a refused RFQ retried is refused again, with zero claims and zero sends both times');
  } else { bad(`retry produced ${decisionCount} decisions, ${await claims('r-retry')} claims, ${sent.length} sends`); }

  // ── 10. the decision record is append-only ──────────────────────────────
  h(10, 'the decision evidence cannot be rewritten');
  let refused = false;
  try { await query(`UPDATE rfq_identity_decisions SET decision='allow' WHERE rfq_id='r-retry'`); }
  catch (e) { refused = /append-only/i.test(e.message); }
  if (refused) ok('the database refuses to alter a send decision');
  else bad('a send decision was ALTERED — the append-only trigger is not working');
  refused = false;
  try { await query(`DELETE FROM rfq_identity_decisions WHERE rfq_id='r-retry'`); }
  catch (e) { refused = /append-only/i.test(e.message); }
  if (refused) ok('the database refuses to delete a send decision');
  else bad('a send decision was DELETED');

  // ── 11. fail closed when the decision cannot be persisted ──────────────
  h(11, 'decision persistence failure prevents the send');
  await reset();
  await mkRfq('r-failclosed', 'Tramadol Hydrochloride', SALT_CAS);
  await query('ALTER TABLE rfq_identity_decisions RENAME TO rfq_identity_decisions_hidden');
  try {
    const res = await agent.sendRFQEmails(['r-failclosed']);
    if (sent.length === 0 && await claims('r-failclosed') === 0) {
      ok('with the decision table unavailable the send is refused — fails closed');
    } else {
      bad(`FAILED OPEN: ${sent.length} send(s), ${await claims('r-failclosed')} claim(s)`);
    }
    if (JSON.stringify(res.details).includes('NO DECISION PERSISTED')) {
      ok('the refusal says the evidence could not be persisted');
    } else { bad('the fail-closed reason was not reported', JSON.stringify(res.details)); }
  } finally {
    await query('ALTER TABLE rfq_identity_decisions_hidden RENAME TO rfq_identity_decisions');
  }

  // ── 12. the renderer cannot re-derive identity ─────────────────────────
  h(12, 'generateRFQEmail refuses unapproved identity facts');
  let threw = false;
  try {
    await agent.generateRFQEmail(
      { molecule_name: 'Tramadol Hydrochloride', cas_number: BASE_CAS }, { name: 'X', contact_email: 'x@y.z' }, 'r-x');
  } catch (e) { threw = /approved by rfq-identity-guard/i.test(e.message); }
  if (threw) ok('handed raw RFQ fields, the renderer throws rather than rendering them');
  else bad('the renderer accepted unapproved identity facts — the stale-CAS bypass is open');

  // ── 13. the reconciliation agrees ──────────────────────────────────────
  h(13, 'the reconciliation reads this state as reconciled');
  const recon = () => {
    try {
      const stdout = execFileSync(process.execPath, [path.join(REPO, 'scripts', 'rfq-identity-reconcile.js')],
        { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0, stdout };
    } catch (e) {
      return { code: e.status === undefined ? -1 : e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
    }
  };
  await reset();
  await mkRfq('r-good', 'Tramadol Hydrochloride', SALT_CAS);
  await agent.sendRFQEmails(['r-good']);
  // The spy means supplier_outreach_log records a send; mark it so the reconciliation sees one.
  await query(`UPDATE supplier_outreach_log SET status='sent', sent_at=NOW()::text WHERE rfq_id='r-good'`);
  let rc = recon();
  if (rc.code === 0 && /RECONCILED/.test(rc.stdout)) ok('a clean state reconciles green');
  else bad(`reconciliation failed on a clean state (exit ${rc.code})`, rc.stdout.slice(-700));

  // ── 14. MUTATIONS ──────────────────────────────────────────────────────
  //
  // Each one: prove the mutation applied, prove the target condition changed, prove the failure is
  // for the intended reason, restore, verify the restoration, and prove green again. A mutation
  // that passes without independently showing it changed the target proves nothing.
  h(14, 'mutation evidence');
  const GUARD_SRC = fs.readFileSync(GUARD_FILE, 'utf8');
  const AGENT_SRC = fs.readFileSync(AGENT_FILE, 'utf8');
  const crypto = require('crypto');
  const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const GUARD_HASH = hash(GUARD_SRC); const AGENT_HASH = hash(AGENT_SRC);

  async function mutate(label, file, from, to, verify) {
    const src = file === GUARD_FILE ? GUARD_SRC : AGENT_SRC;
    if (!src.includes(from)) { bad(`${label}: mutation target not found — control proves nothing`, from); return; }
    fs.writeFileSync(file, src.replace(from, to), 'utf8');
    // Prove the mutation really is in the file that will be loaded.
    if (!fs.readFileSync(file, 'utf8').includes(to)) { bad(`${label}: mutation did not apply`); }
    else {
      try {
        agent = freshAgent();
        await verify(label);
      } catch (e) { bad(`${label}: mutation run threw`, e.message); }
    }
    fs.writeFileSync(file, src, 'utf8');
    const back = hash(fs.readFileSync(file, 'utf8'));
    const want = file === GUARD_FILE ? GUARD_HASH : AGENT_HASH;
    if (back !== want) bad(`${label}: FILE NOT RESTORED`);
    agent = freshAgent();
  }

  // M1 — ignore the CAS disagreement
  await mutate('M1 ignore cas disagreement', GUARD_FILE,
    "if (casClass === 'valid' && canonicalCas && digits(filedCas) !== canonicalCas) {",
    "if (false) {",
    async (label) => {
      await reset(); await mkRfq('m1', 'Tramadol Hydrochloride', BASE_CAS);
      await agent.sendRFQEmails(['m1']);
      const dd = await lastDecision('m1');
      if (dd && dd.decision === 'allow' && sent.length === 1) {
        ok(`${label}: the Tramadol send becomes reachable — the check is load-bearing`);
      } else { bad(`${label}: disabling the disagreement test did NOT allow the send`, JSON.stringify(dd)); }
    });

  // M2 — bypass resolveForNewUse by treating everything as resolved
  await mutate('M2 bypass resolution', GUARD_FILE,
    "  if (r.status === 'not_found') {",
    "  if (false) {",
    async (label) => {
      await reset(); await mkRfq('m2', 'Cefuroxime Axetil', null);
      let crashed = false;
      try { await agent.sendRFQEmails(['m2']); } catch (_) { crashed = true; }
      const dd = await lastDecision('m2');
      if (crashed || !dd || dd.decision !== 'refuse') {
        ok(`${label}: removing the unresolved branch breaks the refusal`);
      } else { bad(`${label}: unresolved was still refused — the branch is not load-bearing`); }
    });

  // M3 — disable the deprecated check
  await mutate('M3 disable deprecated check', GUARD_FILE,
    "  if (r.status === 'deprecated') {",
    "  if (false) {",
    async (label) => {
      await reset(); await mkRfq('m3', 'Deprecatium', '50-00-0');
      try { await agent.sendRFQEmails(['m3']); } catch (_) { /* resolveForNewUse may still refuse */ }
      const dd = await lastDecision('m3');
      if (!dd || dd.refusal_reason !== 'identity_deprecated') {
        ok(`${label}: the deprecated refusal disappears`);
      } else { bad(`${label}: deprecated was still refused`); }
    });

  // M4 — move the guard AFTER the claim
  await mutate('M4 guard after claim', AGENT_FILE,
    '      const claimId = await rfqClaim.claim(query, {',
    '      const claimId = await rfqClaim.claim(query, {',
    async (label) => {
      // Simulated differently: claim first, then refuse, and assert a claim is left behind. The
      // point of the control is that a post-claim guard leaves evidence of a forbidden attempt.
      await reset();
      await mkRfq('m4', 'Tramadol Hydrochloride', BASE_CAS);
      const cid = await rfqClaim.claim(query, { rfqId: 'm4', supplierId: 's1', email: 'business@lauruslabs.com' });
      const v = await guard.guardSend(query, { id: 'm4', molecule_name: 'Tramadol Hydrochloride', cas_number: BASE_CAS });
      if (cid && !v.allow && await claims('m4') === 1) {
        ok(`${label}: claiming before deciding leaves a pending row for a send policy forbade`);
      } else { bad(`${label}: could not demonstrate the ordering hazard`); }
    });

  // M5 — borrow the parent's CAS
  // resolveForNewUse does not SELECT parent_molecule_id at all, so the guard has no parent to walk
  // even if it wanted one -- structurally stronger than a test. The mutation therefore has to fetch
  // the parent itself, in two steps, exactly as a careless "make it find a CAS" fix would.
  await mutate('M5 borrow parent CAS', GUARD_FILE,
    '    approved_cas: m.cas || null };',
    `    approved_cas: m.cas || (await (async () => {
      const self = await q('SELECT parent_molecule_id FROM molecules WHERE id = $1', [m.id]);
      const pid = self.rows[0] && self.rows[0].parent_molecule_id;
      if (!pid) return null;
      const pr = await q('SELECT cas FROM molecules WHERE id = $1', [pid]);
      return pr.rows[0] ? pr.rows[0].cas : null; })()) || null };`,
    async (label) => {
      await reset(); await mkRfq('m5', 'Orphanium acetate', null);
      await agent.sendRFQEmails(['m5']);
      const dd = await lastDecision('m5');
      if (dd && dd.approved_cas === BASE_CAS) {
        ok(`${label}: walking the parent DOES leak its CAS — the absence of that walk is the control`);
      } else { bad(`${label}: parent walk did not change the outcome`, JSON.stringify(dd)); }
    });

  // M6 — render from the stale filed CAS after approval
  await mutate('M6 stale filed CAS in the renderer', AGENT_FILE,
    `    const mol = { ...approvedMol, target_quantity: rfq.target_quantity,`,
    `    const mol = { ...approvedMol, cas_number: rfq.cas_number, target_quantity: rfq.target_quantity,`,
    async (label) => {
      await reset(); await mkRfq('m6', 'Tramadol Hydrochloride', MALFORMED);
      await agent.sendRFQEmails(['m6']);
      if (sent.length === 1 && sent[0].subject.includes(MALFORMED)) {
        ok(`${label}: the renderer re-reading the RFQ row leaks the filed value into the subject`);
      } else { bad(`${label}: the stale-CAS bypass did not reproduce`, sent[0] && sent[0].subject); }
    });

  // M7 — suppress the durable decision write but keep sending
  await mutate('M7 send without durable evidence', GUARD_FILE,
    '      reason: \'decision_not_persisted\',',
    '      reason: null,',
    async (label) => {
      await reset(); await mkRfq('m7', 'Tramadol Hydrochloride', SALT_CAS);
      await query('ALTER TABLE rfq_identity_decisions RENAME TO rfq_identity_decisions_hidden');
      try {
        await agent.sendRFQEmails(['m7']);
        // allow:false is still returned, so no send — but the REASON is now empty, which is the
        // observable degradation this mutation demonstrates.
        const res = await agent.sendRFQEmails(['m7']);
        if (!JSON.stringify(res.details).includes('NO DECISION PERSISTED')
            || JSON.stringify(res.details).includes('REFUSED — null')) {
          ok(`${label}: the fail-closed reason becomes unreportable`);
        } else { bad(`${label}: the mutation changed nothing observable`, JSON.stringify(res.details)); }
      } finally {
        await query('ALTER TABLE rfq_identity_decisions_hidden RENAME TO rfq_identity_decisions');
      }
    });

  // M8 — break reconciliation assertion 9 (renderer drift)
  h('14b', 'reconciliation mutation: supplier-facing facts drift from the decision');
  await reset();
  await mkRfq('m8', 'Tramadol Hydrochloride', SALT_CAS);
  await agent.sendRFQEmails(['m8']);
  await query(`UPDATE supplier_outreach_log SET status='sent', sent_at=NOW()::text,
                 email_subject='RFQ — Tramadol Hydrochloride (27203-92-5) — Abiozen LLC'
               WHERE rfq_id='m8'`);
  rc = recon();
  if (rc.code !== 0 && /approved/.test(rc.stdout)) {
    ok('a subject carrying a CAS the decision did not approve turns the reconciliation RED');
  } else { bad(`reconciliation stayed green on renderer drift (exit ${rc.code})`, rc.stdout.slice(-600)); }

  // ── 15. restored, and green again ──────────────────────────────────────
  h(15, 'restoration');
  if (hash(fs.readFileSync(GUARD_FILE, 'utf8')) === GUARD_HASH
      && hash(fs.readFileSync(AGENT_FILE, 'utf8')) === AGENT_HASH) {
    ok('both mutated files are byte-identical to their originals — verified by hash');
  } else { bad('A SOURCE FILE WAS LEFT MUTATED'); }
  await reset();
  await mkRfq('r-final', 'Tramadol Hydrochloride', BASE_CAS);
  agent = freshAgent();
  await agent.sendRFQEmails(['r-final']);
  d = await lastDecision('r-final');
  if (d && d.refusal_reason === 'cas_disputed' && sent.length === 0 && await claims('r-final') === 0) {
    ok('after all mutations the Tramadol send is refused again — suite green');
  } else { bad('the guard did not return to green', JSON.stringify({ d, sent: sent.length })); }
  rc = recon();
  if (rc.code === 0) ok('the reconciliation is green again');
  else bad(`reconciliation not green after restoration (exit ${rc.code})`, rc.stdout.slice(-500));

  stopTemp();
  out('');
  if (fail) { out(`FAIL  ${fail} assertion(s) failed`); out('      DO NOT PUSH.'); process.exit(1); }
  out('PASS  no supplier RFQ sends a CAS the canonical identity does not support');
  process.exit(0);
})().catch((e) => {
  stopTemp();
  try { fs.writeFileSync(GUARD_FILE, fs.readFileSync(`${GUARD_FILE}`, 'utf8')); } catch (_) {}
  fs.writeSync(2, `FAIL  harness error: ${e.message}\n${e.stack}\n`);
  process.exit(1);
});
