#!/usr/bin/env node
// ── A CRON THAT CLAIMS A LOCAL HOUR MUST BE PINNED TO A TIMEZONE ────────────
//
//   node scripts/check-cron-timezone-intent.js
//     exit 0 = every cron whose comment states a local business hour passes a timezone
//
// On 2026-11-24 the owner asked a narrow question — "the intended performance scoring schedule is
// 6 PM America/Chicago; verify the actual scheduler and daylight saving time behaviour" — and the
// answer was that EIGHT jobs were firing five to six hours early.
//
// node-cron fires in the PROCESS timezone when no timezone argument is given, and TZ is pinned
// nowhere in this repository. On Railway that means UTC, so:
//
//   // Daily 6 PM          cron.schedule('0 18 * * *', …)   → 12:00 PM CST / 1:00 PM CDT
//   // Monday 8 AM         cron.schedule('0 8 * * 1',  …)   →  2:00 AM CST / 3:00 AM CDT
//
// `daily-18utc-performance-scoring` scores task completion, mails coaching and fires L1–L4
// escalations. Firing at midday scored every employee on a working day that was half over.
//
// AND A FIXED UTC HOUR CANNOT EXPRESS A LOCAL ONE. 6 PM Chicago is 00:00 UTC in winter and 23:00
// UTC in summer, so any constant UTC hour drifts by an hour at each DST transition. The timezone
// argument is not a tidier way of writing the same thing; it is the only correct form.
//
// ── WHAT THIS CHECKS, AND WHY IT READS COMMENTS ─────────────────────────────
//
// The rule it enforces is: **a cron whose own comment states a wall-clock business hour must pass a
// timezone.** That makes the comment load-bearing rather than decorative, which is the opposite of
// this repository's usual stance on comments — and it is deliberate. Intent is the only thing that
// distinguishes a correct `0 18 * * *` from an incorrect one; the expression alone cannot say
// whether 18:00 UTC was meant. The comment is where the intent lives, so the comment is what gets
// held to account.
//
// It deliberately does NOT flag:
//   · a comment stating UTC explicitly ("Daily 00:00 UTC") — honest, and matches the behaviour
//   · interval jobs ("every 15 minutes", "hourly") — no wall-clock intent to get wrong
//   · a cron with no time claim at all — nothing to contradict
//
// ── WHAT IT DOES NOT CLAIM ──────────────────────────────────────────────────
//
// It cannot tell whether the pinned timezone is the RIGHT one, and it cannot catch a job whose
// intent lives only in somebody's head or in the handoff document. For those, the names remain
// misleading by design: `daily-18utc-performance-scoring` now fires at 18:00 Chicago, because
// renaming it would mean migrating production STOP rows, which is not authorized. That mismatch is
// recorded in server.js and in the tracker rather than hidden.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'server.js');

// A wall-clock hour: "6 PM", "8 AM", "9am", "10:30pm". Captures the claim, not the number.
const LOCAL_HOUR = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM)\b/;
// An explicit UTC claim makes the comment honest about firing in UTC.
const SAYS_UTC = /\bUTC\b/;

const src = fs.readFileSync(FILE, 'utf8');
const lines = src.split('\n');

/** The line on which this cron.schedule(...) call closes, by paren balance. */
function spanEnd(start) {
  let depth = 0; let started = false;
  for (let j = start; j < Math.min(lines.length, start + 300); j++) {
    for (const ch of lines[j]) {
      if (ch === '(') { depth++; started = true; } else if (ch === ')') { depth--; }
    }
    if (started && depth === 0) return j;
  }
  return null;
}

/** The contiguous comment block immediately above a line — where the intent is stated. */
function commentAbove(i) {
  const out = [];
  for (let j = i - 1; j >= 0 && j > i - 40; j--) {
    const t = lines[j].trim();
    if (t === '') { if (out.length) break; continue; }
    if (!t.startsWith('//')) break;
    out.unshift(t);
  }
  return out.join('\n');
}

const violations = [];
let scanned = 0; let pinned = 0; let exemptUtc = 0; let noClaim = 0;

for (let i = 0; i < lines.length; i++) {
  if (!lines[i].includes('cron.schedule(')) continue;
  const end = spanEnd(i);
  if (end === null) continue;
  scanned++;

  const block = lines.slice(i, end + 1).join('\n');
  const wf = (block.match(/withAlerts\(\s*[`"']([^`"']+)/) || [])[1] || '(unnamed)';
  const expr = (lines[i].match(/cron\.schedule\(\s*[`"']([^`"']+)/) || [])[1] || '?';
  const hasTz = /timezone\s*:/.test(lines[end]) || /,\s*[A-Z_]+\s*\)/.test(lines[end]);

  if (hasTz) { pinned++; continue; }

  const comment = commentAbove(i);
  if (!LOCAL_HOUR.test(comment)) { noClaim++; continue; }
  if (SAYS_UTC.test(comment)) { exemptUtc++; continue; }

  const claim = comment.match(LOCAL_HOUR)[0];
  violations.push(`${wf} (server.js:${i + 1}) — its comment states "${claim}" but `
    + `cron.schedule('${expr}', …) passes NO timezone, so it fires at ${expr.split(' ')[1]}:`
    + `${expr.split(' ')[0].padStart(2, '0')} in whatever timezone the container has. Pass CHICAGO. `
    + 'A fixed UTC hour cannot express a local one: the local fire time drifts an hour at each DST '
    + 'transition.');
}

console.log(`  ${scanned} cron(s): ${pinned} pinned to a timezone · ${exemptUtc} stating UTC `
  + `explicitly · ${noClaim} with no wall-clock claim`);

if (violations.length) {
  console.error(`\nFAIL — ${violations.length} cron(s) claim a local hour and are not pinned:\n`);
  for (const v of violations) console.error(`  - ${v}\n`);
  process.exit(1);
}
console.log('\nOK: every cron that claims a local business hour is pinned to a timezone.');
process.exit(0);
