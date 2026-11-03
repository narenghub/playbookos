#!/usr/bin/env node
// ── IS IT SAFE TO MAKE abiozen.com SENDING-CAPABLE? READ-ONLY. ──────────────
//
//   railway ssh 'node scripts/confirm-legacy-email-state.js'
//
// WRITES NOTHING and SENDS NOTHING. No INSERT, UPDATE or DELETE, no provider call, no refusal
// probe. It answers the six questions that decide whether verifying the Resend domain would arm
// an ungoverned external sender:
//
//   1. is the Tuesday procurement cron enabled, and when does it next run
//   2. is there work eligible for that execution
//   3. is the departed director inactive in the authoritative user data
//   4. how does the cron derive sender / signatory / reply-to on THIS deploy
//   5. does the kill switch currently cover email.send, exactly as the mail path measures it
//   6. which external senders would begin delivering the moment the domain is verified
//
// ── WHY QUESTION 5 CALLS checkStopped RATHER THAN READING THE STOPS TABLE ──
//
// A stop row existing and the mail path SEEING a stop are different facts. sendEmailDetailed asks
// `checkStopped({ capability }, { consequential: true })` with a TTL-cached snapshot, so this asks
// the identical question through the identical function. Reading the table would tell us what
// somebody inserted; this tells us what the next email will actually encounter.
'use strict';

const fs = require('fs');
const path = require('path');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${d}`); };
const warn = (m) => { console.log(`  WARN  ${m}`); };
const note = (m) => console.log(`  --    ${m}`);
const field = (k, v) => console.log(`    ${String(k).padEnd(26)} ${v}`);

// Next occurrence of a weekly cron, in the cron's own timezone. The schedule is
// `0 9 * * 2` with timezone America/Chicago, so the answer must be computed in that zone
// rather than in UTC — the two disagree by six hours and the whole question is about a deadline.
function nextTuesday9amChicago(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', minute: 'numeric',
    hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  let daysAhead = (2 - dow + 7) % 7;                       // 2 = Tuesday
  if (daysAhead === 0 && (hour > 9 || (hour === 9 && minute > 0))) daysAhead = 7;
  const mins = daysAhead * 1440 + (9 * 60 - (hour * 60 + minute));
  // THE DATE OF THE NEXT RUN, not today's date with 09:00 pasted over it. The first version
  // formatted `now` and then regex-replaced the time, so at 10:26 on a Tuesday it reported
  // "Tue 2026-11-03 09:00" — an execution that had already happened — while minutesAway correctly
  // said 9994. Two fields disagreeing, and the human-readable one was the wrong one.
  const at = new Date(now.getTime() + mins * 60000);
  const atParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', weekday: 'short', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at).map((x) => [x.type, x.value]));
  return { daysAhead, minutesAway: mins,
    local: `${atParts.weekday} ${atParts.year}-${atParts.month}-${atParts.day} `
      + `${atParts.hour}:${atParts.minute} America/Chicago` };
}

(async () => {
  try {
    const { query } = require('../src/lib/db');
    console.log('\n══ LEGACY EXTERNAL EMAIL — PRE-C CONFIRMATION (READ-ONLY) ══\n');
    console.log(`  deployed SHA ${process.env.RAILWAY_GIT_COMMIT_SHA || '(unset)'}\n`);

    // ── 1. THE CRON ────────────────────────────────────────────────────────
    console.log('  ── 1. THE TUESDAY PROCUREMENT CRON ──\n');
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const scheduled = /cron\.schedule\('0 9 \* \* 2',\s*withAlerts\('weekly-tue-9cst-procurement-rfqs'/.test(serverSrc);
    const commented = /^\s*\/\/\s*cron\.schedule\('0 9 \* \* 2'/m.test(serverSrc);
    field('registered in server.js', scheduled ? 'YES' : 'no');
    field('commented out', commented ? 'YES' : 'no');
    if (scheduled && !commented) {
      note('ENABLED — it will run. That is expected: the fix is that it now fails closed, not');
      note('that it stops running. A cron that runs and refuses leaves evidence; one that is');
      note('silently removed leaves none.');
    } else warn('the cron is not registered as expected — verify this is deliberate');
    const nx = nextTuesday9amChicago();
    field('next execution', nx.local);
    field('minutes away', nx.minutesAway);
    field('now', new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }) + ' America/Chicago');

    // ── 2. IS THERE WORK FOR IT ────────────────────────────────────────────
    console.log('\n  ── 2. WORK ELIGIBLE FOR THAT EXECUTION ──\n');
    const pend = (await query(
      `SELECT COUNT(*)::int n FROM rfq_requests WHERE status = 'pending'`)).rows[0].n;
    field('pending RFQ requests', pend);
    const appr = (await query(
      `SELECT COUNT(*)::int n FROM approval_queue
        WHERE status = 'approved' AND action_type LIKE '%sourc%'`)).rows[0].n.toString();
    field('approved sourcing items', appr);
    if (Number(pend) === 0 && Number(appr) === 0) {
      ok('no work is queued, so this execution would have had nothing to send either way');
    } else {
      note(`${pend} pending RFQ(s) and ${appr} approved sourcing item(s) exist — this execution`);
      note('WOULD have had work. The fail-closed signatory guard is what stops it, not an empty queue.');
    }

    // ── 3. THE DEPARTED DIRECTOR ───────────────────────────────────────────
    console.log('\n  ── 3. AUTHORITATIVE USER DATA ──\n');
    const gone = (await query(
      `SELECT id, name, email, role, is_active FROM users
        WHERE LOWER(email) LIKE '%palash%' OR LOWER(name) LIKE '%palash%'`)).rows;
    if (!gone.length) ok('no user row matching the departed director exists at all');
    for (const u of gone) {
      field('found', `${u.name} <${u.email}> role=${u.role} is_active=${u.is_active}`);
      if (Number(u.is_active) === 1) {
        bad('THE DEPARTED DIRECTOR IS STILL ACTIVE in the authoritative user data — deactivate him '
          + 'in Team Management. The code no longer falls back to him, but an ACTIVE row would be '
          + 'resolved legitimately by the role hierarchy');
      } else ok('and he is inactive, so the role hierarchy will not resolve him');
    }

    // ── 4. HOW THE SENDER IS DERIVED ON THIS DEPLOY ────────────────────────
    console.log('\n  ── 4. SENDER / SIGNATORY / REPLY-TO, AS DEPLOYED ──\n');
    const agentSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'lib', 'agents', 'procurement-agent.js'), 'utf8');
    // ── COMMENTS ARE EVIDENCE, NOT EXECUTION ────────────────────────────────
    //
    // The first version reported "hardcoded human fallback PRESENT" on a clean deploy, because its
    // pattern matched the COMMENT that deliberately records the removed line:
    //
    //     //     )).rows[0] || { name: 'Palash Das', ... };
    //
    // A validator that cannot tell history from live code flags the audit trail as the defect —
    // and the next person's fix is to delete the evidence. Executable lines only.
    const executable = (src) => src.split('\n')
      .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
      .join('\n');
    const agentExec = executable(agentSrc);
    const hardcoded = /\|\|\s*\{\s*name:\s*'Palash/.test(agentExec);
    const failsClosed = /const sig = await getSignatory\(\);\s*\n\s*if \(!sig\) \{/.test(agentExec);
    const usesGoverned = /require\('\.\.\/office\/procurement-rfq'\)/.test(agentExec);
    field('hardcoded human fallback', hardcoded ? 'PRESENT' : 'removed');
    field('fails closed with no signatory', failsClosed ? 'yes' : 'NO');
    field('uses the governed resolver', usesGoverned ? 'yes' : 'NO');
    if (hardcoded) bad('a hardcoded human fallback is still in the deployed sender path');
    else ok('no hardcoded human can become the sender');
    if (failsClosed) ok('no active signatory → the run is BLOCKED before any supplier is contacted');
    else bad('the deployed path does not fail closed');
    if (usesGoverned) ok('and the signatory comes from the same authority the governed kernel uses');
    else bad('the legacy path resolves authority separately from the kernel');

    const sig = await require('../src/lib/office/procurement-rfq').resolveSignatory({ query });
    if (!sig) {
      warn('NOBODY currently resolves as a procurement signatory. The cron will refuse and send '
        + 'nothing — safe, but it also means no RFQ can be sent until the role is filled.');
    } else {
      field('resolves to', `${sig.name} <${sig.email}> (${sig.role})`);
      field('fallback past procurement', sig.fallback ? 'YES' : 'no');
      if (/palash/i.test(`${sig.name} ${sig.email}`)) {
        bad('THE RESOLVED SIGNATORY IS THE DEPARTED DIRECTOR — he is active in `users`');
      } else ok('and that person is not the departed director');
    }

    // ── 5. WHAT THE MAIL PATH SEES ─────────────────────────────────────────
    console.log('\n  ── 5. KILL SWITCH, AS THE MAIL PATH MEASURES IT ──\n');
    const autonomy = require('../src/lib/autonomy');
    let seen = null; let readable = true;
    try {
      seen = await autonomy.checkStopped({ capability: 'email.send' }, { consequential: true });
    } catch (e) { readable = false; field('checkStopped', `THREW — ${e.message}`); }
    if (!readable) {
      warn('the kill state could not be read; consequential email fails closed, which is safe');
    } else if (seen) {
      field('email.send', `STOPPED — ${seen.scope_type}:${seen.scope_key || '(global)'}`);
      field('reason', String(seen.reason || '').slice(0, 120));
      field('unknown-state stop', seen.unknown === true ? 'YES (state unreadable)' : 'no');
      ok('a stop is in force: no consequential email will leave this deploy');
    } else {
      field('email.send', 'CLEAR — no stop in force');
      warn('NO STOP IS IN FORCE. Every path below would deliver the moment the domain verifies.');
    }
    const stops = await autonomy.listStops().catch(() => []);
    field('active stops', (stops || []).length);
    for (const s of stops || []) {
      field('  stop', `${s.scope_type}:${s.scope_key || '(global)'} by ${s.set_by || '?'} `
        + `at ${s.set_at || '?'} — ${String(s.reason || '').slice(0, 60)}`);
    }

    // ── 6. WHAT VERIFYING THE DOMAIN WOULD ARM ─────────────────────────────
    console.log('\n  ── 6. EXTERNAL SENDERS ON abiozen.com ──\n');
    const inqSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'lib', 'agents', 'inquiry-agent.js'), 'utf8');
    const inqHardcodedCc = /cc: \['palash@abiozen\.com'/.test(inqSrc);
    field('procurement RFQs', 'fails closed without a signatory · identity guard · kill switch '
      + '· NO approval boundary');
    field('inquiry buyer replies', (inqHardcodedCc ? 'HARDCODED departed CC · ' : '')
      + 'AUTO-SENDS AI content · kill switch · NO approval boundary');
    field('governed R1', 'frozen payload · approve AND release required · manual only');
    if (inqHardcodedCc) bad('the inquiry path still hardcodes the departed director in a CUSTOMER-facing CC');
    else ok('the inquiry path no longer hardcodes a departed recipient');
    note('The inquiry path still sends AI-composed email to BUYERS on its own schedule with no');
    note('approval boundary. Removing the departed CC does not make it governed. That is a');
    note('separate decision and it is why this check does not conclude that C is safe by itself.');

    // ── 7. TARGETED CONTAINMENT, AS DEPLOYED ───────────────────────────────
    console.log('\n  ── 7. TARGETED CONTAINMENT OF EACH LEGACY SENDER ──\n');
    const INQ_WF = 'legacy-inquiry-buyer-email';
    const RFQ_WF = 'legacy-supplier-rfq-email';
    const wfKeys = autonomy.knownScopeKeys('workflow') || [];
    for (const k of [INQ_WF, RFQ_WF]) {
      if (wfKeys.includes(k)) ok(`workflow:${k} is a RECOGNIZED kill scope on this deploy`);
      else bad(`workflow:${k} is NOT recognized — a stop naming it would be rejected`);
    }

    // The mail path must CONSULT the scope, not merely have one defined. A recognized scope that
    // no send path declares is a stop nobody is subject to.
    const mailSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'mailer.js'), 'utf8');
    const forwards = /\.\.\.\(workflow \? \{ workflow \} : \{\}\)/.test(mailSrc);
    const declaresInq = new RegExp(`workflow: '${INQ_WF}'`).test(inqSrc);
    const declaresRfq = new RegExp(`workflow: '${RFQ_WF}'`).test(agentSrc);
    field('mailer forwards workflow', forwards ? 'yes' : 'NO');
    field('inquiry send declares it', declaresInq ? 'yes' : 'NO');
    field('supplier send declares it', declaresRfq ? 'yes' : 'NO');
    if (forwards && declaresInq && declaresRfq) {
      ok('the deployed mail path consults the workflow scope, and both senders declare one');
    } else bad('the scope is defined but not consulted end to end — it would contain nothing');

    // Is the targeted stop actually IN FORCE, as the buyer path would measure it?
    let inqSeen = null;
    try {
      inqSeen = await autonomy.checkStopped(
        { capability: 'email.send', workflow: INQ_WF, agent: 'inquiry-agent' },
        { consequential: true });
    } catch (e) { field('buyer-path check', `THREW — ${e.message}`); }
    if (inqSeen) {
      field('buyer path', `STOPPED by ${inqSeen.scope_type}:${inqSeen.scope_key || '(global)'}`);
      ok('autonomous buyer email is contained right now');
      if (inqSeen.scope_type === 'capability') {
        note('contained by the BLUNT capability stop, which also silences internal mail. The');
        note(`targeted ${INQ_WF} stop would contain it precisely.`);
      }
    } else {
      bad('THE BUYER PATH IS NOT STOPPED — autonomous AI email to buyers would send as soon as '
        + 'the sending domain verifies');
    }

    // Provider invocation must be downstream of that decision. Asserted on the deployed source:
    // the kill-switch block appears before the fetch to the provider.
    const killAt = mailSrc.indexOf('const blocked = await checkStopped(');
    const fetchAt = mailSrc.indexOf("fetch('https://api.resend.com/emails'");
    field('kill check / provider call', `${killAt} / ${fetchAt}`);
    if (killAt > -1 && fetchAt > -1 && killAt < fetchAt) {
      ok('the provider call is DOWNSTREAM of the kill-switch decision');
    } else bad('the provider call is not provably downstream of the kill switch');

    // ── 8. R1 IS STILL GOVERNED AND EXPLICIT-RELEASE ───────────────────────
    console.log('\n  ── 8. THE GOVERNED PATH IS UNCHANGED ──\n');
    const execSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'lib', 'office', 'execute.js'), 'utf8');
    const checks = [
      [/requireExplicitRelease/, 'release requires an explicit act'],
      [/sender_not_recorded/, 'it refuses a payload with no frozen sender'],
      [/from: frozenSender/, 'and sends the approved sender explicitly'],
    ];
    for (const [re, what] of checks) {
      if (re.test(execSrc)) ok(what);
      else bad(`R1 no longer: ${what}`);
    }
    const modes = (await query(
      `SELECT release_mode, COUNT(*)::int n FROM objectives
        WHERE release_mode IS NOT NULL GROUP BY release_mode`)).rows;
    for (const m of modes) field(`objectives release_mode=${m.release_mode}`, m.n);
    if (!modes.some((m) => m.release_mode === 'on_approval')) {
      ok('no objective releases on approval alone');
    } else bad('an objective is set to release WITHOUT a separate human act');

    // ── 9. DID ANY EXTERNAL EMAIL GO OUT DURING REMEDIATION? ───────────────
    console.log('\n  ── 9. EXTERNAL EMAIL DURING THE REMEDIATION WINDOW ──\n');
    // ── email_log.sent_at IS `TEXT DEFAULT NOW()`, NOT timestamptz ───────────
    //
    // `sent_at >= $1::timestamptz` fails outright: "operator does not exist: text >= timestamp
    // with time zone". This repository has the lesson written down already — a one-off ops script
    // shipped `joined_at = CASE WHEN $2 THEN NOW() ELSE joined_at END`, passed node --check and the
    // whole unit suite, and failed on the live database because joined_at is TEXT. I assumed a
    // column type instead of reading it, and repeated the same class of defect.
    //
    // THE COLUMN IS CAST, not the parameter. Safe here because nothing ever supplies sent_at —
    // mailer's INSERT omits it, so every row carries the `DEFAULT NOW()` rendering and the format
    // is uniform. A column somebody wrote by hand would need a guarded cast.
    const since = '2026-11-03 00:00:00+00';
    const log = (await query(
      `SELECT status, COUNT(*)::int n FROM email_log
        WHERE sent_at::timestamptz >= $1::timestamptz GROUP BY status ORDER BY n DESC`, [since])).rows;
    if (!log.length) note('no email_log rows at all since 3 Nov 00:00 UTC');
    for (const r of log) field(`status ${r.status}`, r.n);
    const externalSent = (await query(
      `SELECT to_email, subject, sent_at FROM email_log
        WHERE sent_at::timestamptz >= $1::timestamptz AND status = 'sent'
          AND to_email NOT LIKE '%@abiozen.com'
          AND to_email NOT LIKE '%@adificetechnologies.com'
        ORDER BY sent_at DESC LIMIT 20`, [since])).rows;
    field('external recipients since then', externalSent.length);
    for (const r of externalSent) {
      field('  SENT', `${r.to_email} — ${String(r.subject || '').slice(0, 60)} — ${r.sent_at}`);
    }
    if (externalSent.length === 0) {
      ok('NO email reached an address outside the company during remediation');
    } else {
      bad(`${externalSent.length} external recipient(s) received email during remediation — read `
        + 'the rows above and establish what was sent before proceeding');
    }
    const stoppedCount = (await query(
      `SELECT COUNT(*)::int n FROM email_log
        WHERE sent_at::timestamptz >= $1::timestamptz AND status = 'stopped_by_policy'`, [since])).rows[0].n;
    field('refused by policy', stoppedCount);
    if (Number(stoppedCount) > 0) {
      note('the kill switch refused real attempts — that is the containment working, and each');
      note('refusal is durable evidence rather than a silent non-event.');
    }

    console.log('');
    if (fail) {
      console.log(`FAIL  ${fail} blocking finding(s). DO NOT VERIFY THE DOMAIN YET.\n`);
      process.exit(1);
    }
    console.log('PASS  no blocking finding in the deployed legacy sender paths. Nothing was written');
    console.log('      and nothing was sent by this check.\n');
    note('This does NOT by itself authorize C. Read section 5 and 6: if no stop is in force, the');
    note('inquiry path will begin autonomous external buyer email the moment the domain verifies.');
    console.log('');
    process.exit(0);
  } catch (e) {
    console.error(`\nFAIL  ${e.stack || e.message}\n`);
    process.exit(1);
  }
})();
