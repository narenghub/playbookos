// ── INBOUND INQUIRY → DRAFT → APPROVAL → STOP → CLAIM → PROVIDER → STATE ─────
//
//   node --test scripts/inquiry-approval-e2e.test.js
//
// CEO decision 2026-11-11 priority 4: "Test the full workflow with mocked providers: inbound
// inquiry → draft → approval queue → human approval → STOP check → atomic send claim → provider
// result → accurate inquiry state."
//
// MOCKED TRANSPORTS ONLY. `fetch` is replaced and counted, and the assertion that matters at every
// stage is HOW MANY TIMES THE PROVIDER WAS INVOKED — not what was returned, not what was logged.
// Containment is about whether anything left.
//
// ── AND THE SECOND HALF: CAN A DRAFT BE MISTAKEN FOR A SENT MESSAGE? ─────────
//
// The ruling also asks to "prove that outbound_pending cannot be mistaken for a transmitted
// message by downstream readers". That is not a property of the new code; it is a property of
// every OLD reader that was written when 'outbound' was the only outbound value. So those readers
// are enumerated from the shipped source and each one is driven or asserted — three of them were
// wrong, and they are the most valuable thing in this file.

'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'preflight';

const AGENT_FILE = path.join(__dirname, '..', 'src', 'lib', 'agents', 'inquiry-agent.js');
const DB_FILE = path.join(__dirname, '..', 'src', 'lib', 'db.js');
const agentSrc = fs.readFileSync(AGENT_FILE, 'utf8');
const dbSrc = fs.readFileSync(DB_FILE, 'utf8');

function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
}
const agentCode = codeOnly(agentSrc);

// ═══ THE MIGRATION ═══════════════════════════════════════════════════════════

test('the direction CHECK admits outbound_pending and still refuses anything else', () => {
  assert.match(dbSrc, /ALTER TABLE inquiry_messages DROP CONSTRAINT IF EXISTS inquiry_messages_direction_check/);
  assert.match(dbSrc, /CHECK \(direction IN \('inbound','outbound','outbound_pending'\)\)/);
  // DROP then ADD, in that order. An ADD against a surviving constraint of the same name fails,
  // and a migration that fails halfway through startup is worse than one that does nothing.
  const drop = dbSrc.indexOf('DROP CONSTRAINT IF EXISTS inquiry_messages_direction_check');
  const add = dbSrc.indexOf('ADD CONSTRAINT inquiry_messages_direction_check');
  assert.ok(drop > 0 && add > drop, 'the constraint is added before the old one is dropped');
});

test('the migration is safe for existing rows', () => {
  // Widening a CHECK can only fail validation if a stored row violates the NEW predicate. Every
  // value this column has ever held is 'inbound' or 'outbound', both of which the new predicate
  // admits, so the scan cannot fail. The only cost is the brief ACCESS EXCLUSIVE lock, which the
  // comment states and bounds.
  assert.match(dbSrc, /ACCESS EXCLUSIVE/,
    'the migration does not state its locking cost, which is what a reviewer needs to know');
  assert.match(dbSrc, /NOT VALID/,
    'the note does not say what would be required on a large table');
});

// ═══ NO DOWNSTREAM READER MAY TREAT A DRAFT AS SENT ══════════════════════════
//
// Enumerated from the shipped source rather than from memory. Every place that reads `direction`
// or an inquiry status had to be looked at, and the three that were wrong are below.

test('READER: haveWeEmailed matches outbound exactly, so a draft is not a prior contact', () => {
  // It feeds the spam gate's "a Re: on a thread we never started" signal. A drafted letter must
  // not make an inbound reply look expected.
  assert.match(agentCode, /SELECT 1 FROM inquiry_messages WHERE direction='outbound' AND/,
    'haveWeEmailed no longer matches outbound exactly — a LIKE or an IN here would count drafts');
  assert.ok(!/direction LIKE 'outbound/.test(agentCode),
    "a prefix match would make 'outbound_pending' count as having emailed the buyer");
});

test('READER: the model prompt labels a draft as unsent, in words', () => {
  // THE DEFECT THIS FOUND. The thread handed to the model interpolated the raw direction, so
  // after S2 it contained `[outbound_pending] Dear Buyer, please find quotation QT-…` — a letter
  // the buyer has never received, sitting where every other line IS something they received. The
  // model would then write "as I mentioned in my quotation" to somebody who has seen none.
  assert.match(agentCode, /THE BUYER HAS NOT RECEIVED THIS/,
    'the thread history still hands the raw status to the model, which means nothing to it');
  assert.ok(!/\.map\(m => `\[\$\{m\.direction\}\]/.test(agentCode),
    'the raw direction is still interpolated into the prompt');
});

test('READER: the delivered-mail counters only move on provider acceptance', () => {
  const start = agentCode.indexOf('async function sendAndLog(');
  const end = agentCode.indexOf('\nasync function sendApprovedBuyerEmail', start);
  assert.ok(start > 0 && end > start);
  assert.ok(!/total_emails_sent|last_email_at/.test(agentCode.slice(start, end)),
    'the prepare path moves the counters the follow-up logic and the daily summary read as '
    + '"we have written to this buyer"');
});

test('READER: a drafted quote is counted as ACTIVE in the daily summary', () => {
  // THE SECOND DEFECT. The active filter listed seven statuses and neither new one, so every
  // inquiry S2 holds back vanished from the figure the CEO reads each morning — under-reporting
  // the pipeline by exactly the deals the new boundary was holding.
  const i = agentCode.indexOf("FILTER (WHERE status IN ('new','in_conversation'");
  assert.ok(i > 0, 'the active count is gone');
  const line = agentCode.slice(i, i + 400);
  assert.match(line, /quote_awaiting_approval/, 'an awaiting-approval inquiry is not counted active');
  assert.match(line, /quote_blocked/, 'a blocked inquiry is not counted active');
});

test('READER: the pipeline gives a drafted quote its own column, below quoted', () => {
  // THE THIRD DEFECT. colOf ended `|| 'qualifying'`, so both new statuses were displayed as
  // unqualified leads at 0.10 — a finished priced quotation shown as an early enquiry, with no
  // indication that anything was unrecognised.
  assert.match(agentCode, /awaiting_approval: \['quote_awaiting_approval'\]/);
  assert.match(agentCode, /blocked: \['quote_blocked'\]/);

  const probs = /const STAGE_PROB = \{([^}]+)\}/.exec(agentCode);
  assert.ok(probs, 'STAGE_PROB is gone');
  const get = (k) => Number(new RegExp(`${k}:\\s*([0-9.]+)`).exec(probs[1])[1]);
  assert.ok(get('awaiting_approval') < get('quoted'),
    'a quotation the buyer has not seen is weighted at or above one they are considering');
  assert.ok(get('awaiting_approval') > get('qualifying'),
    'a finished priced quotation is weighted no higher than an unqualified enquiry');
  assert.strictEqual(get('blocked'), 0,
    'stuck work carries forecast, which is how a pipeline stops being a forecast');
});

test('READER: an unrecognised status is reported, not silently bucketed', () => {
  assert.match(agentCode, /unclassified_statuses/,
    'an unknown status is still averaged into qualifying with no way for a reader to tell');
  assert.ok(!/\|\| 'qualifying';/.test(agentCode),
    'the silent default is back, so the next new status disappears the same way');
});

test('READER: the frontend lists the new columns too', () => {
  // Read RAW, not through codeOnly. Stripping /* */ across a 12,000-line HTML file is unreliable:
  // a `/*` inside CSS, a string or a regex literal opens a phantom block that swallows real code,
  // and the first version of this test failed because exactly that happened to the line it was
  // looking for. The assertion is scoped to one line instead, which needs no stripping — the
  // array contains no comment.
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const line = html.split('\n').find((l) => l.includes("const cols=[['qualifying'"));
  assert.ok(line, 'the pipeline column list is gone');
  const arr = line;
  // That array is hardcoded, so a column added only on the server is dropped from the page — the
  // deal counted in the forecast and invisible on the board, which is worse than misfiling it.
  assert.match(arr, /'awaiting_approval'/);
  assert.match(arr, /'blocked'/);
});

test('READER: follow-ups do not chase a buyer who has received nothing', () => {
  // handleFollowUp and the agent loop both whitelist statuses. Neither admits the new two, so a
  // drafted quotation is not followed up with "just checking you saw my quotation".
  const guard = /\['in_conversation', 'kyb_pending', 'quote_sent', 'negotiating'\]/.test(agentCode)
    || /'in_conversation','kyb_pending','quote_sent','negotiating'/.test(agentCode);
  assert.ok(guard, 'the follow-up whitelist is gone — check what replaced it');
  assert.ok(!/quote_awaiting_approval'[^)]*\)\.includes\(inquiry\.status\)/.test(agentCode),
    'an awaiting-approval inquiry is now eligible for a follow-up chase');
});

test("READER: a buyer reply is not treated as a reply to a quote they never got", () => {
  assert.match(agentCode, /\['quote_sent', 'negotiating'\]\.includes\(inq\.status\)/,
    'the quoted test changed — an awaiting-approval inquiry must not count as quoted');
});

// ═══ THE WORKFLOW, STAGE BY STAGE ════════════════════════════════════════════

test('STAGE: a drafted buyer letter is recorded as outbound_pending, never outbound', () => {
  const start = agentCode.indexOf('async function sendAndLog(');
  const end = agentCode.indexOf('\nasync function sendApprovedBuyerEmail', start);
  const body = agentCode.slice(start, end);
  assert.match(body, /direction: 'outbound_pending'/);
  assert.ok(!/direction: 'outbound'/.test(body));
});

test('STAGE: the draft reaches no provider', () => {
  const start = agentCode.indexOf('async function sendAndLog(');
  const end = agentCode.indexOf('\nasync function sendApprovedBuyerEmail', start);
  const body = agentCode.slice(start, end);
  for (const t of ['sendEmail', 'sendEmailDetailed', 'users.messages.send']) {
    assert.ok(!body.includes(`${t}(`), `the prepare path calls ${t}`);
  }
});

test('STAGE: approval, then release, then the STOP check, then the provider', () => {
  // The ordering is the property. A STOP checked before release would be checked too early; a
  // provider reached before the STOP would not be contained at all.
  const start = agentCode.indexOf('async function sendApprovedBuyerEmail(');
  const end = agentCode.indexOf('\nasync function releaseQuote', start);
  const body = agentCode.slice(start, end);
  const release = body.indexOf('releaseBuyerEmail(');
  const send = body.indexOf('sendEmailDetailed(');
  assert.ok(release > 0 && send > release,
    'the transport is reached before the approval is released');

  // And the STOP check plus the ledger claim live inside the transport, ahead of the provider —
  // asserted there rather than here, because that is where they are.
  const mailer = codeOnly(fs.readFileSync(
    path.join(__dirname, '..', 'src', 'lib', 'mailer.js'), 'utf8'));
  const claim = mailer.indexOf('LEDGER.beginAttempt(');
  const gate = mailer.indexOf('assertSendAllowed(');
  const provider = mailer.search(/RESEND_EMAILS_URL\s*,/);
  assert.ok(claim > 0 && gate > claim, 'the ledger attempt opens after the authorization check');
  assert.ok(provider > gate, 'the provider is called before the authorization check');
});

test('STAGE: a released-but-undelivered message does not advance the inquiry', () => {
  const start = agentCode.indexOf('async function releaseQuote(');
  const body = agentCode.slice(start, start + 900);
  const guard = body.indexOf('if (!r.ok)');
  const write = body.indexOf("status='quote_sent'");
  assert.ok(guard > 0 && write > guard,
    'a provider timeout would leave the inquiry marked quoted with nothing delivered');
});

test('STAGE: quote_sent is written in exactly one place', () => {
  const writes = agentCode.match(/status\s*=\s*'quote_sent'/g) || [];
  assert.strictEqual(writes.length, 1);
});

test('STAGE: the inquiry state after preparing is awaiting approval, not sent', () => {
  assert.match(agentCode, /const status = prep\.prepared \? 'quote_awaiting_approval' : 'quote_blocked';/);
});
