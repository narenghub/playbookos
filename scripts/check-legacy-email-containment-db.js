#!/usr/bin/env node
// ── EACH LEGACY EXTERNAL SENDER CAN BE STOPPED ON ITS OWN ───────────────────
//
//   node scripts/check-legacy-email-containment-db.js   exit 0 = containment is precise, and the
//                                                                INTENDED gate is what refuses
//
// Two pre-kernel paths email people OUTSIDE the company on their own schedule, with no approval
// boundary: the inquiry agent writes AI-composed mail to BUYERS, and the procurement cron writes
// supplier RFQs. Until they declared a kill-switch identity, the only scope that reached them was
// `capability:email.send` — which is every email in the platform. Containing one ungoverned sender
// meant silencing the 6pm scores, the briefings and the alerts with it.
//
// ── WHY A GENERIC `refused` IS NOT ACCEPTABLE EVIDENCE HERE ────────────────
//
// Every case asserts WHICH scope produced the refusal, by reading `scope_type` and `scope_key` off
// the stop the mail path actually received. A test satisfied by `ok === false` would pass when some
// unrelated gate refused first — the gate-contamination pattern — and would therefore keep passing
// after the targeted stop stopped working.
//
// THE MAILER'S TRANSPORT IS A SPY. "The provider was never invoked" is counted, not inferred, and
// no message leaves this process. No real buyer or supplier is ever addressed.
'use strict';

const { pgBin, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(String(d).split('\n').slice(0, 4).map((l) => '          ' + l).join('\n')); };
const note = (m) => console.log(`  --    ${m}`);

const findInitdb = pgBin;

let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/legacycontain-');
  const asRoot = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asRoot ? `su postgres -c ${JSON.stringify(cmd)}` : cmd], { stdio: 'pipe' });
  try {
    if (asRoot) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55971 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asRoot };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55971&sslmode=disable`;
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

const url = process.env.LEGACYCONTAIN_PG_URL || startTemp();
if (!url) {
  console.log('  skip  no Postgres available (set LEGACYCONTAIN_PG_URL or install initdb)');
  console.log('SKIP  containment not exercised — this check needs a server');
  process.exit(EXIT_NOT_EXECUTED);
}
process.env.DATABASE_URL = url;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'PLACEHOLDER-not-a-secret';
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'PLACEHOLDER-not-a-key';
process.env.MAIL_FROM = process.env.MAIL_FROM || 'Fixture <fixture@example.invalid>';

// THE TRANSPORT SPY. Anything that reaches here would have been a real provider call.
const provider = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, opts) => {
  if (String(u).includes('api.resend.com')) {
    provider.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ id: 'stub-msg' }), text: async () => '' };
  }
  return realFetch ? realFetch(u, opts) : { ok: false, status: 599, json: async () => ({}), text: async () => '' };
};

const INQ = 'legacy-inquiry-buyer-email';
const RFQ = 'legacy-supplier-rfq-email';

(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: url, ssl: false });
  const q = (t, p) => P.query(t, p);
  try {
    await require('../src/lib/autonomy').migrateAutonomy(q);
    await q(`CREATE TABLE IF NOT EXISTS email_log (id TEXT PRIMARY KEY, to_email TEXT,
      subject TEXT, status TEXT, error_message TEXT, sent_at TIMESTAMPTZ DEFAULT NOW())`);

    const autonomy = require('../src/lib/autonomy');
    const mailer = require('../src/lib/mailer');

    // Every scope must be nameable, or an operator cannot stop it under pressure.
    const wf = autonomy.knownScopeKeys('workflow');
    for (const k of [INQ, RFQ]) {
      if (wf.includes(k)) ok(`workflow:${k} is a RECOGNIZED kill scope`);
      else bad(`workflow:${k} is not in the vocabulary — a stop naming it would be rejected`);
    }

    const clearAll = async () => {
      await q(`DELETE FROM autonomy_stops`).catch(() => {});
      autonomy.__resetSnapshotForTests && autonomy.__resetSnapshotForTests();
      // The snapshot is TTL-cached. Re-requiring resets it, which is what a deploy does.
      for (const k of Object.keys(require.cache)) {
        if (k.includes(path.join('src', 'lib', 'autonomy')) || k.includes(path.join('src', 'lib', 'mailer'))) delete require.cache[k];
      }
      return { autonomy: require('../src/lib/autonomy'), mailer: require('../src/lib/mailer') };
    };

    const send = async (m, { workflow, agent, capability } = {}) => {
      provider.length = 0;
      const r = await m.sendEmailDetailed({
        to: 'buyer@external.invalid', subject: 'fixture', html: 'body',
        ...(workflow ? { workflow } : {}), ...(agent ? { agent } : {}),
        ...(capability ? { capability } : {}),
      });
      return { r, calls: provider.length, sent: provider.slice() };
    };

    // ══ 1. BASELINE: WITHOUT A STOP IT REACHES THE PROVIDER ════════════════
    //
    // Non-vacuity. Without this, every refusal below could be a fixture that cannot send at all,
    // and the containment would be unproven.
    note('baseline: with no stop in force the buyer path must reach the mail boundary');
    {
      const { mailer: m } = await clearAll();
      const { r, calls } = await send(m, { workflow: INQ, agent: 'inquiry-agent' });
      if (r.ok && calls === 1) ok('the buyer path reaches the provider when nothing is stopped');
      else bad('the fixture cannot send at all, so every refusal below would prove nothing',
        JSON.stringify({ ok: r.ok, calls, err: r.error }).slice(0, 200));
    }

    // ══ 2. THE TARGETED STOP REFUSES — AND IT IS THE ONE THAT REFUSED ══════
    note('workflow:legacy-inquiry-buyer-email must refuse the buyer path, by name');
    {
      const { autonomy: a, mailer: m } = await clearAll();
      const st = await a.stop({ scope_type: 'workflow', scope_key: INQ,
        reason: 'containment while the legacy autonomous buyer-email path is ungoverned',
        actor: 'fixture' });
      if (!st.ok) bad('the stop was rejected', JSON.stringify(st));
      const { r, calls } = await send(m, { workflow: INQ, agent: 'inquiry-agent' });
      if (r.ok) bad('THE BUYER EMAIL WAS SENT WITH THE WORKFLOW STOPPED');
      else if (calls !== 0) bad(`the provider was invoked ${calls} time(s) despite the refusal`);
      else ok('refused, and THE PROVIDER WAS NEVER INVOKED — counted, not inferred');
      // THE GATE-CONTAMINATION ASSERTION. Not `ok===false`: which scope refused?
      if (/workflow:legacy-inquiry-buyer-email/.test(String(r.error))) {
        ok('and the refusal names workflow:legacy-inquiry-buyer-email — the INTENDED gate');
      } else {
        bad('it refused for a different reason, so the targeted gate was never measured — this is '
          + 'the gate-contamination pattern', String(r.error).slice(0, 200));
      }
      if (r.phase === 'stopped_by_policy' && r.providerResponded === false) {
        ok('and the outcome is stopped_by_policy with no provider response');
      } else bad('the refusal is not reported as a policy stop', JSON.stringify({ phase: r.phase }));
    }

    // ══ 3. CONTAINMENT IS PRECISE: INTERNAL MAIL STILL WORKS ═══════════════
    //
    // The whole point of naming the workflow. If this failed we would be back to the blunt
    // capability stop, which takes the 6pm scores and the briefings down with the buyer email.
    note('an internal email, and the OTHER legacy sender, must be unaffected');
    {
      const { autonomy: a, mailer: m } = await clearAll();
      await a.stop({ scope_type: 'workflow', scope_key: INQ,
        reason: 'containment while the legacy autonomous buyer-email path is ungoverned',
        actor: 'fixture' });

      const internal = await send(m, {});                       // declares no workflow
      if (internal.r.ok && internal.calls === 1) {
        ok('an UNDECLARED internal email still sends — the stop is not blunt');
      } else bad('the targeted stop also blocked ordinary internal email',
        JSON.stringify({ ok: internal.r.ok, err: internal.r.error }).slice(0, 160));

      const otherLegacy = await send(m, { workflow: RFQ, agent: 'procurement-agent' });
      if (otherLegacy.r.ok && otherLegacy.calls === 1) {
        ok('and the supplier-RFQ workflow is unaffected — each legacy sender stops independently');
      } else bad('stopping one legacy workflow also stopped the other', String(otherLegacy.r.error).slice(0, 160));

      // INTERNAL MAIL WORKING IS NOT EVIDENCE OF EXTERNAL SAFETY. Stated because the ruling
      // warns against exactly that confusion: this assertion proves PRECISION, and case 2 is the
      // one that proves containment.
      note('this case proves precision only. Case 2 is the containment evidence; an internal');
      note('email succeeding says nothing about whether buyer email is contained.');
    }

    // ══ 4. THE GLOBAL CAPABILITY STOP REMAINS DOMINANT ═════════════════════
    note('capability:email.send must still stop everything, including the named workflows');
    {
      const { autonomy: a, mailer: m } = await clearAll();
      await a.stop({ scope_type: 'capability', scope_key: 'email.send',
        reason: 'global containment of all consequential email during remediation',
        actor: 'fixture' });
      for (const [label, scopes] of [
        ['the buyer path', { workflow: INQ, agent: 'inquiry-agent' }],
        ['the supplier path', { workflow: RFQ, agent: 'procurement-agent' }],
        ['an undeclared internal email', {}],
      ]) {
        const { r, calls } = await send(m, scopes);
        if (!r.ok && calls === 0 && /capability:email\.send/.test(String(r.error))) {
          ok(`${label} is refused by capability:email.send`);
        } else bad(`${label} was not refused by the global capability stop`,
          JSON.stringify({ ok: r.ok, calls, err: String(r.error).slice(0, 120) }));
      }
      ok('declaring a workflow did not create a way around the capability scope');
    }

    // ══ 5. REMOVING THE TARGETED STOP RESTORES SENDING ═════════════════════
    //
    // Proves the stop is what refused in case 2, rather than something latent in the fixture.
    note('resuming the workflow must restore the path — the stop was the cause');
    {
      const { autonomy: a, mailer: m } = await clearAll();
      await a.stop({ scope_type: 'workflow', scope_key: INQ,
        reason: 'containment while the legacy autonomous buyer-email path is ungoverned',
        actor: 'fixture' });
      const stopped = await send(m, { workflow: INQ, agent: 'inquiry-agent' });
      if (stopped.r.ok) bad('the stop did not take, so case 5 cannot measure resumption');
      await a.resume({ scope_type: 'workflow', scope_key: INQ, actor: 'fixture',
        reason: 'fixture resumption to prove the stop was the cause' }).catch(async () => {
        await q(`DELETE FROM autonomy_stops WHERE scope_key = $1`, [INQ]);
      });
      const { mailer: m2 } = await clearAll();
      await a.stop({ scope_type: 'workflow', scope_key: RFQ,
        reason: 'unrelated stop, present to show only the named workflow was released',
        actor: 'fixture' });
      const resumed = await send(m2, { workflow: INQ, agent: 'inquiry-agent' });
      if (resumed.r.ok && resumed.calls === 1) {
        ok('with the stop removed the buyer path sends again — case 2 measured the stop itself');
      } else bad('the path did not recover after the stop was removed', String(resumed.r.error).slice(0, 160));
    }

    // ══ 6. THE DECLARATION IS PRESENT IN THE SHIPPED SEND PATHS ════════════
    //
    // A recognized scope that no send path declares would be a stop nobody is subject to.
    note('the shipped send paths must actually declare their scopes');
    {
      const inq = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'agents', 'inquiry-agent.js'), 'utf8');
      const proc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'agents', 'procurement-agent.js'), 'utf8');
      if (new RegExp(`workflow: '${INQ}'`).test(inq)) ok('the buyer send declares its workflow');
      else bad('the buyer send does not declare a workflow — the stop would never reach it');
      if (new RegExp(`workflow: '${RFQ}'`).test(proc)) ok('the supplier send declares its workflow');
      else bad('the supplier send does not declare a workflow');
      // THE FORWARDING MOVED, AND THIS ASSERTION FOLLOWED IT RATHER THAN BEING RELAXED.
      //
      // It used to look for `...(workflow ? { workflow } : {})` inside mailer.js. That spread now
      // lives in src/lib/email-gate.js, because the kill-switch decision was extracted so the two
      // Gmail transports could use the SAME one rather than growing a second copy — the whole of
      // S1. The old assertion would have gone red for a change that improved coverage, which is
      // how a guard teaches people to delete it.
      //
      // Both halves are checked, because either alone can break the chain: the mailer must HAND
      // the scope to the gate, and the gate must FORWARD it to checkStopped.
      const mail = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'mailer.js'), 'utf8');
      const gate = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'email-gate.js'), 'utf8');
      if (/assertSendAllowed\(\{[^}]*\bworkflow\b/.test(mail)) {
        ok('the mailer hands the workflow scope to the gate');
      } else bad('the mailer no longer passes workflow to assertSendAllowed');
      if (/\.\.\.\(workflow \? \{ workflow \} : \{\}\)/.test(gate)) {
        ok('and the gate forwards it to checkStopped');
      } else bad('the gate does not forward the workflow scope to checkStopped');
    }

    // ══ 7. MUTATION CONTROL ════════════════════════════════════════════════
    note('mutation control: stop forwarding the scope, prove the containment disappears');
    {
      // MUTATES src/lib/email-gate.js, NOT mailer.js. The forwarding moved there when the
      // kill-switch decision was extracted so all three transports could share one. A mutation
      // control aimed at the file that no longer holds the line proves nothing about the line —
      // it reports "the control is stale", which is the correct answer and not a passing one.
      const MAILF = path.join(__dirname, '..', 'src', 'lib', 'email-gate.js');
      const sha = (f) => require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');
      const before = sha(MAILF); const src = fs.readFileSync(MAILF, 'utf8');
      const anchor = "      ...(workflow ? { workflow } : {}),";
      if (!src.includes(anchor)) bad('M1 could not locate the forwarding — the control is stale');
      else {
        fs.writeFileSync(MAILF, src.replace(anchor, ''));
        // THE CACHE IS CLEARED HERE, BEFORE THE RE-REQUIRE, NOT ONLY IN THE finally.
        //
        // The mutation now lands in email-gate.js, which mailer.js requires at module scope. With
        // only the trailing cleanup, clearAll() re-required a fresh mailer that then pulled the
        // STALE gate out of require.cache — so the mutated line was never executed, the send was
        // refused, and the control reported "the forwarding was not what contained it". The
        // mutation had applied perfectly; the module graph had not moved.
        for (const k of Object.keys(require.cache)) if (k.includes(path.join('src', 'lib'))) delete require.cache[k];
        try {
          const { autonomy: a, mailer: m } = await clearAll();
          await a.stop({ scope_type: 'workflow', scope_key: INQ,
            reason: 'containment while the legacy autonomous buyer-email path is ungoverned',
            actor: 'fixture' });
          const { r, calls } = await send(m, { workflow: INQ, agent: 'inquiry-agent' });
          if (r.ok && calls === 1) {
            ok('M1 without the forwarding, a STOPPED buyer workflow sends anyway — the targeted '
              + 'containment is load-bearing, and the scope name alone would have been decoration');
          } else bad('M1 it was still refused, so the forwarding was not what contained it',
            String(r.error).slice(0, 160));
        } finally {
          fs.writeFileSync(MAILF, src);
          for (const k of Object.keys(require.cache)) if (k.includes(path.join('src', 'lib'))) delete require.cache[k];
        }
      }
      if (sha(MAILF) !== before) bad('M1 email-gate.js was NOT restored byte-for-byte');
      else ok('M1 email-gate.js restored, verified by content hash');
    }
  } catch (e) {
    bad('unexpected error', e.stack || e.message);
  } finally {
    globalThis.fetch = realFetch;
    try { await q(`DELETE FROM autonomy_stops`).catch(() => {}); } catch (_) {}
    try { await P.end(); } catch (_) {}
    stopTemp();
  }

  console.log(fail
    ? `\nFAIL  ${fail} containment assertion(s) failed`
    : '\nPASS  each legacy external sender stops on its own, by name, before the provider; internal\n'
      + '      email is unaffected; the global capability stop remains dominant; and removing the\n'
      + '      targeted stop restores the path.');
  process.exit(fail ? 1 : 0);
})();
