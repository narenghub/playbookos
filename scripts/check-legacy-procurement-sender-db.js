#!/usr/bin/env node
// ── THE LEGACY WEEKLY RFQ CRON FAILS CLOSED WITHOUT A SIGNATORY ─────────────
//
//   node scripts/check-legacy-procurement-sender-db.js   exit 0 = it cannot send as a departed
//                                                                 employee, and says so
//
// `weekly-tue-9cst-procurement-rfqs` sends REAL supplier RFQ emails on the legacy path — no
// approval boundary, no frozen payload. On 3 Nov 2026 it was found resolving its sender like this:
//
//     SELECT ... WHERE role='procurement_director' AND is_active=1 ...
//     )).rows[0] || { name: 'Palash Das', email: 'palash@abiozen.com', id: null };
//
// The filter on `is_active=1` meant that DEACTIVATING THE DEPARTED DIRECTOR SELECTED THE HARDCODED
// FALLBACK. Removing him from the organization is what made the system use him. Every Tuesday it
// would have written to suppliers from, signed by and reply-to a person who had left, and nothing
// would have failed — the only thing preventing delivery was an unauthorized sending domain, which
// is a provider rejection rather than a control.
//
// ── WHAT THIS PROVES, BEHAVIOURALLY ───────────────────────────────────────
//
//   1. no active signatory            → BLOCKED, nothing sent, the mailer never called
//   2. an active signatory            → sends, and the From/Reply-To/signature are THAT person
//   3. a DEPARTED director in `users` → never selected
//   4. the generator refuses outright when handed no signatory
//   5. removing the fail-closed guard brings the defect back (mutation control)
//
// The mailer is a SPY, so "nothing was sent" is counted rather than inferred. No message leaves
// this process and no real supplier is ever named.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(String(d).split('\n').slice(0, 5).map((l) => '          ' + l).join('\n')); };
const note = (m) => console.log(`  --    ${m}`);

const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/usr/bin'];
const findInitdb = () => BIN.find((d) => fs.existsSync(path.join(d, 'initdb'))) || null;

let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/legacyproc-');
  const asRoot = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asRoot ? `su postgres -c ${JSON.stringify(cmd)}` : cmd], { stdio: 'pipe' });
  try {
    if (asRoot) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data -A trust`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55979 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asRoot };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55979&sslmode=disable`;
}
function stopTemp() {
  if (!temp) return;
  try {
    execFileSync('sh', ['-c', temp.asRoot
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { stdio: 'pipe' });
  } catch (_) {}
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) {}
}

const url = process.env.LEGACYPROC_PG_URL || startTemp();
if (!url) {
  console.log('  skip  no Postgres available (set LEGACYPROC_PG_URL or install initdb)');
  console.log('SKIP  the legacy sender was not exercised — this check needs a server');
  process.exit(0);
}
process.env.DATABASE_URL = url;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-ant-stub';
// procurement-agent pulls in core.js transitively, which refuses to load without this.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'legacy-sender-check';
// WITHOUT THIS THE MAILER REFUSES BEFORE THE REQUEST, so the fetch stub below is never reached —
// and the mutation control then reports "nothing was sent" and proves nothing. A stub key makes
// the provider call happen against the stub, which is what lets case 3 and M1 actually measure.
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 're_stub_key_for_fixture';
process.env.MAIL_FROM = process.env.MAIL_FROM || 'Fixture <fixture@example.invalid>';

// ── THE PROVIDER AND MAILER ARE BOTH STUBBED ───────────────────────────────
// The AI returns a body; the mailer records calls and sends nothing. A real send from this check
// would be the exact act it exists to prove impossible.
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, opts) => {
  if (String(u).includes('api.resend.com')) {
    sent.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ id: 'stub-msg' }), text: async () => '' };
  }
  if (String(u).includes('api.anthropic.com')) {
    return { ok: true, status: 200, text: async () => '',
      json: async () => ({ content: [{ type: 'text', text: 'Dear supplier,\n\nPlease quote.' }],
        usage: { input_tokens: 10, output_tokens: 10 } }) };
  }
  return realFetch ? realFetch(u, opts) : { ok: false, status: 599, json: async () => ({}), text: async () => '' };
};

(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: url, ssl: false });
  const q = (t, p) => P.query(t, p);
  try {
    const { query } = require('../src/lib/db');
    await require('../src/lib/runs').migrateRuns(q);
    await q(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL, role TEXT NOT NULL, is_active INTEGER DEFAULT 1, created_at TEXT DEFAULT NOW())`);
    await q(`CREATE TABLE IF NOT EXISTS suppliers (id TEXT PRIMARY KEY, name TEXT NOT NULL,
      country TEXT, region TEXT, contact_email TEXT, contact_name TEXT, specialties TEXT,
      reliability_score INTEGER DEFAULT 50, avg_response_days REAL DEFAULT 3,
      gmp_certified INTEGER DEFAULT 0, total_orders INTEGER DEFAULT 0)`);
    await q(`CREATE TABLE IF NOT EXISTS rfq_requests (id TEXT PRIMARY KEY, molecule_name TEXT NOT NULL,
      cas_number TEXT, target_quantity TEXT, target_purity TEXT, gmp_required INTEGER DEFAULT 0,
      week_start TEXT, status TEXT DEFAULT 'pending', priority TEXT DEFAULT 'medium',
      assigned_to_user_id TEXT, approval_id TEXT, created_at TEXT DEFAULT NOW())`);
    await q(`CREATE TABLE IF NOT EXISTS supplier_outreach_log (id TEXT PRIMARY KEY, rfq_id TEXT,
      supplier_id TEXT, email_sent_to TEXT, email_subject TEXT, email_body TEXT, sent_at TEXT,
      replied_at TEXT, reply_text TEXT, status TEXT DEFAULT 'sent')`);
    await require('../src/lib/idempotency/supplier-rfq').migrate(q);
    await require('../src/lib/procurement/rfq-identity-guard').migrate(query);
    await require('../src/lib/autonomy').migrateAutonomy(q);
    await q(`CREATE TABLE IF NOT EXISTS email_log (id TEXT PRIMARY KEY, to_email TEXT,
      subject TEXT, status TEXT, error_message TEXT, sent_at TIMESTAMPTZ DEFAULT NOW())`);

    // The molecule registry the identity guard reads, in the shape the other harnesses use, so the
    // guard can APPROVE this fixture and case 3 actually reaches the mailer. If any of this fails
    // the sender cases still stand: 1, 2 and 4 do not depend on a send succeeding.
    await q(`CREATE TABLE IF NOT EXISTS molecules (
      id BIGSERIAL PRIMARY KEY, molecule_ref TEXT, normalized_name TEXT UNIQUE, preferred_name TEXT,
      cas TEXT, cas_suppressed_reason TEXT, substance_form TEXT, status TEXT,
      deprecated_at TIMESTAMPTZ, deprecated_reason TEXT, parent_molecule_id BIGINT)`).catch(() => {});
    await q(`CREATE TABLE IF NOT EXISTS molecule_aliases (
      alias TEXT PRIMARY KEY, molecule_id BIGINT)`).catch(() => {});
    await q(`INSERT INTO molecules (molecule_ref, normalized_name, preferred_name, cas, status)
      VALUES ('MOL-LEG','candidatium','Candidatium','36282-47-0','active')
      ON CONFLICT (normalized_name) DO NOTHING`).catch(() => {});
    await q(`INSERT INTO suppliers (id,name,country,contact_email,gmp_certified)
             VALUES ('s-leg','Legacy Labs','India','legacy@supplier.invalid',1)
             ON CONFLICT (id) DO NOTHING`);
    await q(`INSERT INTO rfq_requests (id,molecule_name,cas_number,target_quantity,target_purity,
             gmp_required,week_start,status) VALUES ('rfq-leg','Candidatium','36282-47-0','25kg','99%',1,'2026-11-03','pending')
             ON CONFLICT (id) DO NOTHING`);

    const fresh = () => { for (const k of Object.keys(require.cache)) if (k.includes(path.join('src', 'lib'))) delete require.cache[k]; };

    // ══ 1. NO ACTIVE SIGNATORY → BLOCKED, AND THE MAILER IS NEVER CALLED ═══
    note('with nobody holding a procurement role the cron must refuse, not default to a person');
    {
      await q(`DELETE FROM users`);
      sent.length = 0;
      fresh();
      const agent = require('../src/lib/agents/procurement-agent');
      const r = await agent.sendRFQEmails(['rfq-leg']);
      if (r.blocked === true) ok('sendRFQEmails reports BLOCKED');
      else bad('it did not block with no signatory', JSON.stringify(r).slice(0, 200));
      if ((r.emails_sent || 0) === 0 && sent.length === 0) {
        ok('and the mailer was NEVER CALLED — counted, not inferred');
      } else bad(`the mailer was called ${sent.length} time(s)`);
      if ((r.details || []).some((e) => /no active procurement signatory/i.test(e))) {
        ok('and it says why, in words an operator can act on');
      } else bad('the refusal does not explain itself', JSON.stringify(r.details));
      const leaked = sent.filter((m) => JSON.stringify(m).toLowerCase().includes('palash'));
      if (!leaked.length) ok('and no message names the departed director');
      else bad('A DEPARTED DIRECTOR APPEARED IN A MESSAGE', JSON.stringify(leaked[0]));
    }

    // ══ 2. A DEPARTED DIRECTOR IS NEVER SELECTED ═══════════════════════════
    note('a deactivated director in `users` must not be resolvable — this is what used to select him');
    {
      await q(`INSERT INTO users (id,email,name,role,is_active)
               VALUES ('u-gone','gone@abiozen.invalid','A Departed Director','procurement_director',0)
               ON CONFLICT (id) DO UPDATE SET is_active=0`);
      sent.length = 0;
      fresh();
      const agent = require('../src/lib/agents/procurement-agent');
      const r = await agent.sendRFQEmails(['rfq-leg']);
      if (r.blocked === true && sent.length === 0) {
        ok('an INACTIVE director does not become the sender — it still refuses');
      } else bad('a deactivated director was used or something was sent', JSON.stringify(r).slice(0, 200));
    }

    // ══ 3. AN ACTIVE SIGNATORY → THE LETTER IS FROM THAT PERSON ════════════
    note('with a real active signatory the cron sends, and the identity is resolved live');
    {
      await q(`INSERT INTO users (id,email,name,role,is_active)
               VALUES ('u-live','live@abiozen.invalid','A Live Director','procurement_director',1)
               ON CONFLICT (id) DO UPDATE SET is_active=1`);
      await q(`DELETE FROM supplier_outreach_log`);
      sent.length = 0;
      fresh();
      const agent = require('../src/lib/agents/procurement-agent');
      const r = await agent.sendRFQEmails(['rfq-leg']);
      if (sent.length >= 1) {
        ok(`it sends with an active signatory (${sent.length} message(s))`);
        const m = sent[0];
        if (/A Live Director <live@abiozen\.invalid>/.test(m.from || '')) {
          ok('and the From is the RESOLVED person, not a constant');
        } else bad('the From is not the resolved signatory', String(m.from));
        if (m.reply_to === 'live@abiozen.invalid') ok('and the Reply-To reaches them');
        else bad('the Reply-To is not the resolved signatory', String(m.reply_to));
        if (!/palash/i.test(JSON.stringify(m))) ok('and nothing in the message names the departed director');
        else bad('the departed director appears in the sent message');
      } else {
        bad('nothing was sent with an active signatory, so the From/Reply-To assertions were never '
          + 'measured — the fixture must reach the mailer for this case to mean anything',
          JSON.stringify(r.details || []).slice(0, 160));
      }
    }

    // ══ 4. THE GENERATOR REFUSES WITHOUT A SIGNATORY ═══════════════════════
    {
      fresh();
      const agent = require('../src/lib/agents/procurement-agent');
      const approved = { molecule_name: 'Candidatium', cas_number: '36282-47-0',
        __approvedByDecision: 1, target_quantity: '25kg', target_purity: '99%' };
      let threw = null;
      await agent.generateRFQEmail(approved, { name: 'Legacy Labs' }, 'rfq-leg', null)
        .catch((e) => { threw = e; });
      if (threw && /signatory/i.test(threw.message)) {
        ok('generateRFQEmail THROWS when handed no signatory — it cannot invent one');
      } else bad('the generator accepted a missing signatory', threw && threw.message);
    }

    // ══ 5. MUTATION CONTROL ════════════════════════════════════════════════
    note('mutation control: restore the fallback, prove the defect returns');
    {
      const AGENTF = path.join(__dirname, '..', 'src', 'lib', 'agents', 'procurement-agent.js');
      const sha = (f) => require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');
      const before = sha(AGENTF); const src = fs.readFileSync(AGENTF, 'utf8');
      const anchor = `  const sig = await getSignatory();
  if (!sig) {`;
      if (!src.includes(anchor)) bad('M1 could not locate the fail-closed guard — the control is stale');
      else {
        // Exactly the defect that was removed: resolve, and fall back to the departed human.
        fs.writeFileSync(AGENTF, src.replace(anchor,
          `  let sig = await getSignatory();
  if (!sig) sig = { name: 'Palash Das', email: 'palash@abiozen.com', title: 'Procurement Director', id: null };
  if (false) {`));
        try {
          await q(`DELETE FROM users`);
          await q(`DELETE FROM supplier_outreach_log`);
          sent.length = 0;
          fresh();
          const mutated = require('../src/lib/agents/procurement-agent');
          const r = await mutated.sendRFQEmails(['rfq-leg']);
          const named = sent.some((m) => /palash/i.test(JSON.stringify(m)));
          if (named) {
            ok('M1 with the fallback restored, a supplier letter goes out FROM the departed '
              + 'director with nobody holding the role — the guard is load-bearing');
          } else if (r.blocked) {
            bad('M1 it still blocked, so the guard was not what prevents this', JSON.stringify(r.details).slice(0, 200));
          } else {
            bad('M1 the mutation never reached the mailer, so this control measured NOTHING — a '
              + 'mutation control that reports a note instead of a verdict is the gate-contamination '
              + 'pattern in the harness itself', JSON.stringify(r.details || []).slice(0, 160));
          }
        } finally { fs.writeFileSync(AGENTF, src); fresh(); }
      }
      if (sha(AGENTF) !== before) bad('M1 procurement-agent.js was NOT restored byte-for-byte');
      else ok('M1 procurement-agent.js restored, verified by content hash');
    }
  } catch (e) {
    bad('unexpected error', e.stack || e.message);
  } finally {
    globalThis.fetch = realFetch;
    try { await P.end(); } catch (_) {}
    stopTemp();
  }

  console.log(fail
    ? `\nFAIL  ${fail} legacy-sender assertion(s) failed`
    : '\nPASS  the legacy weekly RFQ cron cannot send as a departed employee: with no active '
      + 'signatory\n      it refuses and never calls the mailer, an inactive director is never '
      + 'selected, and the\n      generator will not write a letter without one.');
  process.exit(fail ? 1 : 0);
})();
