#!/usr/bin/env node
// ── WHICH CONSEQUENTIAL OPERATIONS ARE PROTECTED, BY EXECUTION PATH ─────────
//
//   node scripts/check-authz-execution-paths.js          # the audit
//   node scripts/check-authz-execution-paths.js --json
//
//   exit 0 = the audit was produced and its invariants hold
//   exit 1 = a consequential operation lost its own gate, or a new one appeared unguarded
//
// Owner's requirement 2, 2026-11-26: *"Complete B3.11a authorization adoption through an actual
// execution-path audit. Do not treat the heuristic list of 37 operations as a complete inventory or
// import counts as enforcement evidence."*
//
// ── WHY THE EXISTING INVENTORY IS NOT THIS ──────────────────────────────────
//
// `check-authz-adoption-inventory.js` answers the question the owner's §5 asked and labels its
// fourth category a heuristic. It flags a module that touches a company-scoped table without
// resolving a company in the same file — which over-reports (`migrate-all.js` creates the tables;
// `active-company-guard.js` installs a trigger on them; `runs.js` owns them) and under-reports
// (a module can resolve a context and then query something else). Its own header says so. Thirty-
// seven files is a worklist.
//
// ── AND WHY A REQUIRE-GRAPH REACHABILITY WOULD BE WORSE ─────────────────────
//
// The obvious next step is to walk the require graph from each HTTP route to each sink and report
// the gates "on the path". I built that first and threw it away, because **it is import counting
// wearing a longer name.** `A requires B` means A *can* reach B, not that this route does; and a
// gate module being required somewhere on an over-approximated path is not evidence that the gate
// runs before the act. It would have produced a reassuring table of "protected" paths from exactly
// the kind of evidence the owner just told me not to use.
//
// ── SO THE AUDIT IS SINK-CENTRIC, WHICH IS WHERE PROTECTION ACTUALLY LIVES ──
//
// For each consequential operation — the function that performs the act — this asks **what that
// function itself requires before acting**, read from its own body:
//
//   · does it `assertContext`, so the company is READ from stored state rather than passed in?
//   · does it consult the kill switch, and does an unreadable answer refuse?
//   · does it require a released approval, a budget hold, an authorized sender, an active
//     membership?
//   · or does its authorization arrive as an ARGUMENT, in which case the only protection is
//     whatever the caller happened to do — and that is the thing that cannot be counted as
//     enforcement?
//
// An operation that gates itself is protected on every path, including paths nobody has written
// yet. An operation that trusts its caller is protected on exactly the paths somebody has audited,
// which is a statement with an expiry date.
//
// The ENTRY SURFACE is reported separately and deliberately without a verdict: how many HTTP routes
// and scheduled crons exist, and what middleware each route carries. That is the shape of the
// attack surface, not a claim about it.
//
// ── WHAT THIS CANNOT DO ────────────────────────────────────────────────────
//
// It reads source. It cannot prove a gate is reached at runtime — that is what the DB checks do,
// each against a real database, and this audit names which check covers which operation so the two
// are not confused. Where no check covers an operation, it says so, and that is the honest state
// of adoption rather than a number.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const JSON_OUT = process.argv.includes('--json');
const ROOT = path.join(__dirname, '..');
const { blankCommentsOnly } = require('./js-lex');

let fail = 0;
const out = [];
const say = (s = '') => { if (!JSON_OUT) console.log(s); out.push(s); };
const bad = (m, extra) => {
  fail += 1;
  say(`  FAIL  ${m}`);
  if (extra !== undefined) say(`          ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
};
const ok = (m) => say(`  ok    ${m}`);
const note = (m) => say(`  --    ${m}`);
const head = (m) => { say(); say(`── ${m} ──`); say(); };

// ── THE CLOSED LIST OF CONSEQUENTIAL OPERATIONS ─────────────────────────────
//
// Named by MODULE and FUNCTION, because an operation is a thing a function does, not a table a file
// mentions. Each entry says what the operation DOES in business terms, so an operator reading the
// audit does not have to infer it from a function name.
//
// `gates` is what the function must enforce ITSELF. A missing one is a finding, not a style note.
// `coveredBy` names the database check that exercises it at runtime; `null` means no check does,
// which is reported as unmeasured rather than hidden.
const OPERATIONS = Object.freeze([
  {
    module: 'src/lib/outbound/dispatch.js', fn: 'dispatch',
    does: 'hands a message to an email provider — the only road out of the platform',
    gates: ['assertSendAllowed', 'mimeAuthorization', 'senderIdentity', 'verifyReleasedApproval',
      'idempotencyKey'],
    coveredBy: 'scripts/check-outbound-ledger-db.js',
  },
  {
    module: 'src/lib/mailer.js', fn: 'sendEmail',
    does: 'the legacy internal send path, 55 callers',
    gates: ['assertSendAllowed'],
    coveredBy: 'scripts/check-legacy-email-containment-db.js',
  },
  {
    module: 'src/lib/whatsapp.js', fn: 'sendWhatsApp',
    does: 'sends a WhatsApp message',
    // `resolveRecipient` is listed as a gate because it is one: it refuses a number that no ACTIVE
    // INTERNAL user holds, which is the authorization this path simply did not have while the email
    // path required `assertSendAllowed`. `checkStopped` was always in this function and sat BEHIND
    // the Twilio credential check — so in any environment without credentials, which is every
    // development environment, it was unreachable. A gate present in the source and unreachable in
    // practice is precisely why this audit's source reading needs a database check beside it, and
    // section 3 was right to report this operation as having none.
    gates: ['checkStopped', 'resolveRecipient'],
    coveredBy: 'scripts/check-whatsapp-boundary-db.js',
  },
  {
    module: 'src/lib/office/budget.js', fn: 'authorizeSpend',
    does: 'authorizes money to be spent and takes the pre-call hold',
    gates: ['assertContext', 'reserveSpend'],
    coveredBy: 'scripts/check-aggregate-spend-concurrency-db.js',
  },
  {
    module: 'src/lib/office/ai.js', fn: 'governedCall',
    does: 'reaches a paid model provider',
    gates: ['assertContext', 'authorizeSpend', 'checkStopped'],
    coveredBy: 'scripts/check-office-governed-ai-db.js',
  },
  {
    module: 'src/lib/identity/company-membership.js', fn: 'grantMembership',
    does: 'grants a person access to a company\'s data',
    gates: ['assertActorMayManage', 'isExternalRole'],
    coveredBy: 'scripts/check-company-membership-db.js',
  },
  {
    module: 'src/lib/identity/company-membership.js', fn: 'revokeMembership',
    does: 'removes a person\'s access to a company\'s data',
    gates: ['assertActorMayManage'],
    coveredBy: 'scripts/check-company-membership-db.js',
  },
  {
    module: 'src/lib/worker/leases.js', fn: 'enqueueTask',
    does: 'creates work for a worker to execute',
    gates: ['intentKey'],
    coveredBy: 'scripts/check-worker-leasing-db.js',
  },
  {
    module: 'src/lib/office/approval.js', fn: 'release',
    does: 'releases a human-approved action for dispatch',
    gates: ['assertContext', 'checkStopped'],
    coveredBy: 'scripts/check-office-release-db.js',
  },
  {
    module: 'src/lib/office/decomposition.js', fn: 'persist',
    does: 'mints a plan, which is minting authorization to act',
    gates: ['assertContext'],
    coveredBy: 'scripts/check-office-decomposition-db.js',
  },
  {
    module: 'src/lib/office/delegation.js', fn: 'delegate',
    does: 'hands authority to a child agent run',
    gates: ['assertContext', 'checkStopped'],
    coveredBy: 'scripts/check-office-delegation-db.js',
  },
  {
    module: 'src/lib/office/run.js', fn: 'beginObjectiveRun',
    does: 'opens an agent run, which is the unit authorization attaches to',
    // ── THIS GATE WAS UPSTREAM, AND THE AUDIT IS WHY IT IS NOT ANY MORE ─────
    //
    // The first run of this audit reported `beginObjectiveRun: missing checkStopped`, and it was
    // right: there was no stop check in the function or anywhere in its module. B3.12 had put the
    // check in the INITIATOR, before the ledger opens, which is a real design — so the expectation
    // was moved to a `callerEnforced` declaration and MEASURED across the call sites rather than
    // accepted. Measured: **2 of 6** production callers checked. `office/initiator.js` and
    // `office/procurement-rfq.js` did; `agents/inquiry-agent.js`, `agents/outreach-approval.js`,
    // `office/executive-agent.js` and `connectors/grants-gov-job.js` did not. (One of those four
    // was invisible to the first count, which matched `beginObjectiveRun(` and so missed
    // `grants-gov-job.js`, where the function is aliased through `deps`. The denominator was 5
    // when it was 6, and the caller it dropped was a failing one.)
    //
    // The fix was not four more upstream copies: that protects exactly those four paths and leaves
    // the convention to be forgotten by caller seven. `office/run.js` now checks at the sink, so
    // the gate is on every path including unwritten ones, and `checkStopped` is listed here as a
    // sink gate because that is now where it is. The initiator's own check stays — it refuses a
    // batch with a per-objective reason before doing any work, which is better reporting.
    gates: ['checkStopped'],
    coveredBy: 'scripts/check-office-initiator-db.js',
  },
  {
    module: 'src/lib/identity/scoped-operations.js', fn: 'assignTask',
    does: 'assigns work to a named employee under a company',
    gates: ['assertContext'],
    coveredBy: 'scripts/check-phase-idempotency-db.js',
  },
  {
    module: 'src/lib/autonomy.js', fn: 'stop',
    does: 'halts a capability, workflow or agent — the kill switch itself',
    gates: [],
    coveredBy: 'scripts/check-autonomy-stop-db.js',
  },
]);

// ── HOW EACH GATE IS RECOGNISED, AND WHY THE FIRST VERSION WAS WRONG ────────
//
// The first version of this table was written from memory and reported **six of the fourteen most
// sensitive operations in the codebase as having lost a gate**. Every one was my pattern, not the
// product:
//
//   · `dispatch` calls `MIME.authorizeRawMessage`; I looked for `authorizeRawRecipients`.
//   · `release` reaches the kill switch through `budget.consequentialReleaseGate`, which contains
//     it; I looked only for `checkStopped` in `release`'s own body.
//   · `governedCall` reaches it through `llm.callClaude`, one layer down, where the module's own
//     header says *"THE KILL SWITCH — THINKING, NOT ACTING"*.
//   · `beginObjectiveRun` resolves its company with `resolveObjectiveContext`, not `assertContext`.
//   · `assignTask` scopes with `companyOf(ctx)` and verifies ACTIVE MEMBERSHIP through
//     `membersOfCompany`; neither is the token I searched for.
//   · `sendEmail`'s gate is in `email-gate.js`, which its own comment states in capitals.
//
// Six false alarms about the email road, the money road and the membership road. An audit that
// cried wolf about those is worse than no audit, because the next real finding is the one nobody
// reads — and it is the same defect class as everything else in this repository: a measurement
// (a token search) standing in for the property (does a gate run before the act).
//
// So each gate now has (a) patterns broad enough to recognise the MECHANISM rather than one
// spelling, and (b) the names of the functions that CONTAIN it, so a gate one layer down is found
// and reported as one layer down. The distinction that matters is not present-or-absent; it is
// **whether the gate is on every path to the act, or only on the paths somebody audited**:
//
//   AT THE SINK   — in the function itself. On every path, including paths nobody has written.
//   ONE LAYER     — in a function the sink calls unconditionally. Also on every path.
//   UPSTREAM      — in the sink's CALLERS. On today's paths only, and that is the adoption gap.
//
// Section 6's control plants a removal and shows the audit go red, so this broadening cannot be a
// silencing.
const GATE_PATTERNS = Object.freeze({
  assertContext: {
    here: /\bassertContext\s*\(|\bcompanyOf\s*\(\s*ctx|\bresolveObjectiveContext\s*\(|\bresolveCompanyContext\s*\(/,
    via: ['resolveObjectiveContext', 'resolveCompanyContext', 'companyOf'],
  },
  checkStopped: {
    here: /\bcheckStopped\s*\(|\bwithAlerts\s*\(|\bintentBlockedBy\s*\(|\bconsequentialReleaseGate\s*\(|\bassertNotStopped\s*\(/,
    via: ['consequentialReleaseGate', 'callClaude', 'withAlerts'],
  },
  assertSendAllowed: {
    // `sendEmailDetailed` is in the via list because `sendEmail` is a three-line wrapper around it
    // and the gate is at line 449 of the SAME file. The first version of this audit reported
    // `sendEmail: missing assertSendAllowed` for exactly that reason: the one-layer-down search
    // resolved the sink's relative requires and nothing else, so a delegate inside the sink's own
    // module was unreachable to it. A gate one call down in the same file is on every path to the
    // act just as much as one in another module — the module boundary was never what made it
    // sound. The search now includes the sink's own file; see section 1's loop.
    here: /\bassertSendAllowed\s*\(/,
    via: ['assertSendAllowed', 'sendEmailDetailed', 'deliverAuthorized'],
  },
  mimeAuthorization: {
    here: /\bauthorizeRawMessage\s*\(|\bauthorizeRawRecipients\s*\(|\bMIME\./,
    via: ['authorizeRawMessage'],
  },
  senderIdentity: {
    here: /\bverifySenderPolicy\s*\(|\bsenderIdentity\b|\bresolveSender\w*\s*\(|\bauthorizedSender\w*\s*\(/i,
    via: ['verifySenderPolicy', 'authorizedSenderFor'],
  },
  verifyReleasedApproval: {
    here: /\bverifyReleasedApproval\s*\(|\bapprovalId\b/,
    via: ['verifyReleasedApproval'],
  },
  idempotencyKey: { here: /\bidempotencyKey\b/, via: [] },
  authorizeSpend: { here: /\bauthorizeSpend\s*\(/, via: ['authorizeSpend'] },
  reserveSpend: { here: /\breserveSpend\s*\(/, via: ['reserveSpend'] },
  assertActorMayManage: { here: /\bassertActorMayManage\s*\(/, via: ['assertActorMayManage'] },
  isExternalRole: { here: /\bisExternalRole\s*\(/, via: ['isExternalRole'] },
  activeMembership: {
    here: /\bmembersOfCompany\s*\(|\bemployeesOf\s*\(|\bisActiveMember\s*\(/,
    via: ['membersOfCompany'],
  },
  intentKey: { here: /\bintentKey\b/, via: [] },
});

/**
 * The body of one function, from its declaration to the matching close brace.
 *
 * Brace-counted rather than regex-terminated, and string- and comment-blanked first, because a
 * `}` inside a template literal would end the body early — which is the same class of error as the
 * close-comment sequence that disabled a guard twice in this repository.
 *
 * (And writing that sequence literally here, inside a block comment, terminated the comment and
 * made the next line parse as code — a third instance, in a comment ABOUT the second. `node
 * --check` caught it in two seconds, which is the argument for the parse step running early.)
 */
/** The files a module relatively-requires, resolved to paths that exist. */
function requiresOf(file, src) {
  const outp = [];
  for (const m of blankCommentsOnly(src).matchAll(/require\((['"])(\.[^'"]+)\1\)/g)) {
    let t = path.resolve(path.dirname(file), m[2]);
    if (!t.endsWith('.js')) t += '.js';
    if (fs.existsSync(t)) outp.push(t);
  }
  return outp;
}

function bodyOf(src, fn) {
  const blanked = blankCommentsOnly(src);
  const decl = new RegExp(`(?:async\\s+)?function\\s+${fn}\\s*\\(|(?:const|let)\\s+${fn}\\s*=\\s*(?:async\\s*)?\\(`);
  const m = decl.exec(blanked);
  if (!m) return null;

  // ── SKIP THE PARAMETER LIST FIRST ──────────────────────────────────────
  //
  // My first version took `indexOf('{', m.index)` as the body's opening brace. Every one of these
  // functions takes a DESTRUCTURED options object, so that brace is the parameter pattern's — and
  // brace-counting from it returned the parameter list as the "body". The audit then reported that
  // `authorizeSpend` does not call `assertContext`, which is its fourth line.
  //
  // It is the same defect this file is written to catch, in the instrument: a measurement standing
  // in for the property, and plausible enough to publish. It was caught only because the result was
  // implausible on its face — nine operations all suddenly unguarded — which is not a method.
  // So: walk the parameter list by PAREN depth, then take the first brace after it.
  const open = blanked.indexOf('(', m.index);
  if (open < 0) return null;
  let pd = 0; let afterParams = -1;
  for (let j = open; j < blanked.length; j += 1) {
    if (blanked[j] === '(') pd += 1;
    else if (blanked[j] === ')') {
      pd -= 1;
      if (pd === 0) { afterParams = j + 1; break; }
    }
  }
  if (afterParams < 0) return null;
  const i = blanked.indexOf('{', afterParams);
  if (i < 0) return null;

  let depth = 0;
  for (let j = i; j < blanked.length; j += 1) {
    const ch = blanked[j];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return blanked.slice(i, j + 1);
    }
  }
  return null;
}


// ── THE DETECTION, IN ONE PLACE, SO THE CONTROL CAN RUN IT ──────────────────
//
// Section 1 asks this of the real files; section 6 asks it of a copy with a gate call deleted. One
// function, called twice. A control that re-implemented the detection would prove that the COPY of
// the logic goes red, which is the measurement standing in for the property all over again.
//
// `src` and `body` are passed in rather than read here, so the control can hand it modified source
// without writing to disk. `file` stays the real path, because relative requires resolve from it.
function detectGates(gates, file, src, body, undeclared = []) {
  const atSink = []; const oneLayer = []; const missing = [];
  for (const g of gates) {
  const spec = GATE_PATTERNS[g];
  if (!spec) { undeclared.push(g); continue; }
    if (spec.here.test(body)) { atSink.push(g); continue; }
    // ── ONE LAYER DOWN, WHICH IS STILL ON EVERY PATH ────────────────────
    //
    // A gate inside a function the sink calls unconditionally protects every path to the act
    // just as a gate in the sink does. Searched by resolving the sink's own relative requires
    // and looking for the named gate-bearing function's body — not by asking whether the module
    // is imported, which is the import counting the owner ruled out.
    let found = null;
    for (const viaFn of spec.via) {
      if (!new RegExp(`\\b${viaFn}\\s*\\(`).test(body)) continue;   // the sink must CALL it
      // The sink's OWN file first: a wrapper whose gate sits in the function it delegates to is
      // the commonest shape of all, and omitting it is what produced this audit's last false
      // alarm. Then its relative requires.
      for (const dep of [file, ...requiresOf(file, src)]) {
        // `src` for the sink's OWN file, rather than a second read from disk. The caller may have
        // handed us modified source — section 6's control does exactly that — and re-reading the
        // real file silently discards it. The control caught this: with every `assertSendAllowed(`
        // call deleted from the copy, the same-file route went on reporting the gate found, because
        // it was reading the unmodified mailer.js off the disk. A control that cannot fail is the
        // thing section 6 exists to prevent, and it nearly was one.
        let depSrc = null;
        if (dep === file) depSrc = src;
        else { try { depSrc = fs.readFileSync(dep, 'utf8'); } catch (_) { continue; } }
        const depBody = bodyOf(depSrc, viaFn);
        if (depBody && spec.here.test(depBody)) {
          found = `${viaFn}() in ${path.relative(ROOT, dep)}`;
          break;
        }
        // The gate may be the callee ITSELF rather than something inside it.
        if (depBody && new RegExp(`\\b${viaFn}\\b`).test(g)) { found = `${viaFn}()`; break; }
      }
      if (!found && new RegExp(`\\b${viaFn}\\s*\\(`).test(body) && viaFn === g) {
        found = `${viaFn}() called directly`;
      }
      if (found) break;
    }
    if (found) oneLayer.push(`${g} via ${found}`); else missing.push(g);
  }
  return { atSink, oneLayer, missing, undeclared };
}

(() => {
  say('══ AUTHORIZATION BY EXECUTION PATH ══');

  // ══ 1. EVERY CONSEQUENTIAL OPERATION, AND WHAT IT ENFORCES ITSELF ══════
  head('1. what each consequential operation requires BEFORE it acts');

  const rows = [];
  for (const op of OPERATIONS) {
    const file = path.join(ROOT, op.module);
    let src = null;
    try { src = fs.readFileSync(file, 'utf8'); } catch (_) { src = null; }
    if (src === null) { bad(`${op.module} does not exist — the operation list is stale`); continue; }

    const body = bodyOf(src, op.fn);
    if (!body) {
      bad(`${op.module}: ${op.fn}() could not be located. Either it was renamed — in which case `
        + 'this audit has stopped auditing it — or it was removed', op.fn);
      continue;
    }

    const { atSink, oneLayer, missing } = detectGates(op.gates, file, src, body);

    // Where does the company come from — stored state, or the caller?
    const selfScoped = GATE_PATTERNS.assertContext.here.test(body);
    const sig = body.slice(0, 400);
    const takesCompanyArg = /\bcompanyId\s*[,=:)]/.test(sig) || /\bcompanyId\s*=\s*null/.test(body);

    rows.push({ ...op, atSink, oneLayer, missing, selfScoped, takesCompanyArg });
  }

  for (const r of rows) {
    const scope = r.selfScoped ? 'resolved context'
      : (r.takesCompanyArg ? 'CALLER-SUPPLIED' : 'not company-scoped');
    say(`  ${r.fn}()  —  ${r.does}`);
    say(`      module      ${r.module}`);
    say(`      company     ${scope}`);
    say(`      at the sink ${r.atSink.length ? r.atSink.join(', ') : '(none in this function)'}`);
    if (r.oneLayer.length) say(`      one layer   ${r.oneLayer.join(' · ')}`);
    if (r.missing.length) say(`      NOT FOUND   ${r.missing.join(', ')}`);
    say(`      runtime     ${r.coveredBy || 'NO DATABASE CHECK COVERS THIS OPERATION'}`);
    say();
  }

  // ── THE INVARIANTS ────────────────────────────────────────────────────
  const lostGates = rows.filter((r) => r.missing.length);
  if (!lostGates.length) {
    ok(`all ${rows.length} consequential operations still enforce every gate this audit expects of `
      + 'them — a rename or a removal turns this red, which is the point of listing them by '
      + 'function rather than counting imports');
  } else {
    bad(`${lostGates.length} operation(s) no longer enforce a gate they are expected to`,
      lostGates.map((r) => `${r.fn}: missing ${r.missing.join(', ')}`));
  }

  // ══ 1b. GATES THE SINK LEAVES TO ITS CALLERS, MEASURED ACROSS THEM ═════
  //
  // A gate declared "upstream by design" is a claim about EVERY caller, and a claim about every
  // caller is the one thing a reader cannot check by looking at the sink. So each declared
  // caller-enforced gate is counted across the production call sites. An operation whose callers
  // mostly check is not protected; it is protected on those paths.
  head('1b. gates left to the caller — adoption counted across the call sites');

  /** Every .js under src/, plus server.js. Tests excluded: a test caller is not a path to the act. */
  function productionFiles() {
    const outp = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) outp.push(p);
      }
    }(path.join(ROOT, 'src')));
    outp.push(path.join(ROOT, 'server.js'));
    return outp;
  }

  const delegated = [];
  for (const r of rows) {
    if (!r.callerEnforced) continue;
    const spec = GATE_PATTERNS[r.callerEnforced.gate];
    const sinkPath = path.join(ROOT, r.module);
    const callers = [];
    for (const f of productionFiles()) {
      if (f === sinkPath) continue;
      const s = blankCommentsOnly(fs.readFileSync(f, 'utf8'));
      // ── A CALLER IS A FILE THAT HOLDS THE SYMBOL, NOT ONE THAT SPELLS THE CALL ──
      //
      // The first version matched `beginObjectiveRun(`. `src/lib/connectors/grants-gov-job.js`
      // does `const startRun = deps.beginObjectiveRun || beginObjectiveRun;` and then calls
      // `startRun(...)` — a real caller, invisible to a call-syntax match, and it has no stop
      // check. The denominator was 5 when it was 6, and the one it dropped was a failing one.
      //
      // So a file counts as a caller when it NAMES the symbol outside comments: an import, an
      // alias, a `deps.` injection point or a direct call. That over-counts a file that imports
      // and never calls, which is the safe direction for a denominator.
      //
      // This is not the import counting the owner ruled out. An import here decides WHICH FILES
      // ARE ON THE LIST; the evidence of enforcement is still the stop check found in each one.
      // Counting imports as enforcement would be using the left column as the right one.
      if (!new RegExp(`\\b${r.fn}\\b`).test(s)) continue;
      callers.push({ file: path.relative(ROOT, f), checks: spec.here.test(s) });
    }
    const without = callers.filter((c) => !c.checks);
    delegated.push({ fn: r.fn, gate: r.callerEnforced.gate, why: r.callerEnforced.why, callers, without });

    say(`  ${r.fn}()  leaves '${r.callerEnforced.gate}' to its callers`);
    say(`      because     ${r.callerEnforced.why}`);
    say(`      adoption    ${callers.length - without.length} of ${callers.length} production call `
      + 'sites contain that check');
    for (const c of callers) say(`      ${c.checks ? 'checks ' : 'NO CHECK'}    ${c.file}`);
    say();
  }

  if (!delegated.length) {
    ok('no operation defers a gate to its callers');
  } else {
    const broken = delegated.filter((d) => d.without.length);
    if (!broken.length) {
      ok('every caller-enforced gate is present at every production call site');
    } else {
      bad('a gate declared "enforced by the caller" is absent from some callers — on those paths it '
        + 'is enforced by nobody',
      broken.flatMap((d) => d.without.map((c) => `${c.file} calls ${d.fn}() without ${d.gate}`)));
      note('This is the adoption finding, stated with a denominator. It is NOT reported as a lost '
        + 'sink gate, because the sink never had one and B3.12 deliberately put it upstream — and '
        + 'it is NOT reported as satisfied, because "the initiator checks" is true of the '
        + 'initiator and of nothing else. Opening a run is not an external effect and every effect '
        + 'sink downstream gates itself, so this is work a stopped platform still does rather than '
        + 'a message a stopped platform still sends.');
    }
  }

  // ══ 2. THE ONES WHOSE AUTHORIZATION COMES FROM THEIR CALLER ════════════
  head('2. operations that trust their caller — the real adoption gap');

  const trusting = rows.filter((r) => !r.selfScoped);
  if (trusting.length) {
    note('These act on a company their CALLER names. They may be used correctly everywhere today, '
      + 'and that is a statement about today\'s callers rather than about the operation — which is '
      + 'exactly what "do not substitute import counts for enforcement evidence" means. Each needs '
      + 'either a resolved context or a database-level guard that holds whatever the caller does:');
    for (const r of trusting) {
      say(`      ${r.fn.padEnd(20)} ${r.module}`);
    }
    note('');
    note('`enqueueTask` is the instructive one. Its company arrives as `companyId = null`, so '
      + 'nothing in the function prevents work being created for the wrong company — and the '
      + 'protection that DOES hold is not in this file at all: B3.21 put a `BEFORE INSERT` trigger '
      + 'on `worker_tasks` which refuses a company that is not active, whatever the caller does. '
      + 'That is the shape the rest of this list needs: a guard is not a gate, and the database can '
      + 'state what the code merely intends.');
  } else {
    ok('every consequential operation resolves its own company context');
  }

  // ══ 3. WHICH OPERATIONS ARE EXERCISED AT RUNTIME, AND WHICH ARE NOT ════
  head('3. runtime coverage — source assertions are not execution evidence');

  const uncovered = rows.filter((r) => !r.coveredBy);
  const missingChecks = rows.filter((r) => r.coveredBy
    && !fs.existsSync(path.join(ROOT, r.coveredBy)));
  if (missingChecks.length) {
    bad('an operation names a database check that does not exist',
      missingChecks.map((r) => `${r.fn} -> ${r.coveredBy}`));
  } else {
    ok(`every named database check exists on disk (${rows.length - uncovered.length} of `
      + `${rows.length} operations have one)`);
  }
  if (uncovered.length) {
    note(`${uncovered.length} operation(s) have NO database check exercising them, and that is `
      + 'reported rather than inferred to be safe:');
    for (const r of uncovered) say(`      ${r.fn.padEnd(20)} ${r.does}`);
  }

  // ══ 4. THE ENTRY SURFACE, WITHOUT A VERDICT ════════════════════════════
  head('4. the entry surface — counted, not judged');

  const apiDir = path.join(ROOT, 'src', 'api');
  let routes = 0; let guarded = 0; const perFile = [];
  for (const f of fs.readdirSync(apiDir).filter((x) => x.endsWith('.js') && !x.endsWith('.test.js'))) {
    const src = blankCommentsOnly(fs.readFileSync(path.join(apiDir, f), 'utf8'));
    const decls = [...src.matchAll(/router\.(get|post|put|patch|delete)\(\s*(['"])([^'"]+)\2([^)]*)/g)];
    let g = 0;
    for (const d of decls) {
      if (/require(Auth|Role|SuperAdmin)|authenticate|requireProduct/.test(d[4])) g += 1;
    }
    routes += decls.length; guarded += g;
    if (decls.length) perFile.push({ file: `src/api/${f}`, routes: decls.length, guarded: g });
  }
  perFile.sort((a, b) => b.routes - a.routes);
  for (const p of perFile) {
    say(`      ${String(p.routes).padStart(3)} route(s)  ${String(p.guarded).padStart(3)} with inline auth middleware  ${p.file}`);
  }
  note(`${routes} HTTP route declarations; ${guarded} carry auth middleware ON THE DECLARATION. `
    + 'The remainder may be guarded by a router-level `use`, which this count cannot see — so this '
    + 'is the SHAPE of the surface and explicitly not a finding about it. Counting it as one would '
    + 'be the same error as counting imports.');

  const serverSrc = blankCommentsOnly(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'));
  const crons = [...serverSrc.matchAll(/cron\.schedule\(/g)].length;
  const scopes = [...serverSrc.matchAll(/CRON_SCOPES/g)].length;
  note(`${crons} scheduled cron registration(s) in server.js, and CRON_SCOPES is referenced `
    + `${scopes} time(s) — every scheduled entry point must be haltable by name (B1.13)`);

  // ══ 5. WHAT THIS AUDIT DOES NOT ESTABLISH ══════════════════════════════
  head('5. the boundary of this audit');

  note('NOT established: that a gate RUNS at runtime. This reads source. The named database checks '
    + 'are what exercise these operations against a real database, and section 3 says which '
    + 'operations have none.');
  note('NOT established: a complete inventory of consequential operations. This list is closed and '
    + 'reviewed, which is stronger than a heuristic — and it is still a list somebody wrote. A new '
    + 'consequential operation added without an entry here is invisible to this audit, which is '
    + 'why section 1 fails loudly when an existing one is renamed rather than silently shrinking.');
  note('NOT established: that the 37-file heuristic list is covered. It is not an inventory and is '
    + 'not treated as one; `check-authz-adoption-inventory.js` keeps it as a worklist.');
  note('NOT established: anything about adoption of `authz/boundary.js` specifically. Measured '
    + 'there: 1 production caller. What this audit shows is that protection today lives mostly in '
    + 'the operations themselves and in the database, not in that boundary — which is a different '
    + 'and more useful answer than a migration percentage.');

  // ══ 6. THE CONTROL: PLANT A REMOVAL AND REQUIRE THE AUDIT TO SEE IT ════
  //
  // Every pattern in GATE_PATTERNS was BROADENED after the first run reported six operations as
  // unguarded and all six were my patterns rather than the product. Broadening a detector until it
  // stops complaining is how a detector becomes decorative — and from the outside it is
  // indistinguishable from fixing it, because both end in a green line.
  //
  // So: take the real source, delete the gate CALL from it, and require the same `detectGates` to
  // report it missing. If a widened pattern now matches something incidental — a comment, an
  // import, a similarly-named helper — the gate goes on being "found" after its call is gone, and
  // these cases fail. This is the only part of this file that can tell a fix from a silencing.
  //
  // One case per detection route, including the sink gate added to office/run.js today, because a
  // control that exercises one route says nothing about the other two.
  head('6. control — with the gate call deleted, the audit must go red');

  const CONTROLS = Object.freeze([
    { fn: 'authorizeSpend', gate: 'reserveSpend', route: 'at the sink',
      kill: (s) => s.replace(/\breserveSpend\s*\(/g, 'neutered_reserveSpend(') },
    { fn: 'sendEmail', gate: 'assertSendAllowed', route: 'one layer down, same file',
      kill: (s) => s.replace(/\bassertSendAllowed\s*\(/g, 'neutered_assertSendAllowed(') },
    { fn: 'governedCall', gate: 'checkStopped', route: 'one layer down, another module',
      // Here the gate itself is untouched — `callClaude` in src/lib/llm.js still contains it. What
      // is removed is the sink's CALL to it, which is the whole basis for saying a gate one layer
      // down is on every path. If the audit still reports it found, it is crediting an import.
      kill: (s) => s.replace(/\bcallClaude\s*\(/g, 'neutered_callClaude(') },
    { fn: 'beginObjectiveRun', gate: 'checkStopped', route: 'the gate added today',
      kill: (s) => s.replace(/\bcheckStopped\s*\(/g, 'neutered_checkStopped(') },
  ]);

  let controlsHeld = 0;
  for (const c of CONTROLS) {
    const op = OPERATIONS.find((o) => o.fn === c.fn);
    if (!op) { bad(`control names ${c.fn}(), which is not in the operation list`); continue; }
    const cfile = path.join(ROOT, op.module);
    const real = fs.readFileSync(cfile, 'utf8');
    const maimed = c.kill(real);
    if (maimed === real) {
      bad(`control for ${c.fn}() changed nothing — the text it removes is no longer there, so the `
        + 'control proves nothing and would pass for ever', `${c.gate} in ${op.module}`);
      continue;
    }
    const cbody = bodyOf(maimed, c.fn);
    if (!cbody) { bad(`control for ${c.fn}(): the maimed copy no longer parses into a body`); continue; }
    const cr = detectGates([c.gate], cfile, maimed, cbody);
    if (cr.missing.includes(c.gate)) {
      controlsHeld += 1;
      say(`      caught    ${c.fn}() without ${c.gate} — ${c.route}`);
    } else {
      bad(`CONTROL FAILED: with the ${c.gate} call deleted from ${c.fn}(), this audit still reports `
        + 'it enforced. The pattern is matching something that is not the gate, so a real removal '
        + 'would pass unnoticed',
      [`${c.fn}: atSink=${cr.atSink.join(',') || '-'} oneLayer=${cr.oneLayer.join(',') || '-'}`]);
    }
  }
  if (controlsHeld === CONTROLS.length) {
    ok(`all ${CONTROLS.length} planted removals were detected — the broadened patterns still `
      + 'distinguish a gate that is there from one that is gone');
  }

  say();
  say(`${fail ? 'FAIL' : 'OK'}  ${fail ? `${fail} invariant(s) broke` : 'the execution-path audit holds'}`);
  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify({ operations: rows, routes, guarded, crons, fail }, null, 2)}\n`);
  }
  process.exit(fail ? 1 : 0);
})();
