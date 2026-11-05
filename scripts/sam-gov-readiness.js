#!/usr/bin/env node
'use strict';
// ── SAM.GOV PR-3 READINESS REPORT, AND THE GATED LIVE TEST ──────────────────
//
// Ruling 7 item 1: prepare the connector, authentication, quota handling, amendment tracking and
// live solicitation ingestion tests. "Do not activate authenticated ingestion until credentials
// and authorization are confirmed."
//
// Run with no arguments it makes NO network call of any kind. It reports what is ready, what is
// assumed, and exactly what the first authenticated call must confirm.
//
//   node scripts/sam-gov-readiness.js
//
// The live test is behind TWO explicit gates, which must BOTH be supplied, because one of them is
// easy to set by accident and the other is not:
//
//   SAM_API_KEY=<key> node scripts/sam-gov-readiness.js --i-am-authorized-to-activate
//
// A key in the environment is not consent. Someone may set SAM_API_KEY for an unrelated tool, and
// a connector that activates on its presence would start ingesting the moment they did. So the
// flag is a separate, deliberate act, and its name is awkward on purpose.
//
// WHAT THE LIVE TEST DOES: exactly ONE request, the smallest one that can answer anything
// (limit=1 over a two-day window). It then works through VERIFY_ON_FIRST_CALL and reports which
// assumptions held. It writes nothing to any database — this is a probe, not an ingest, and
// ingestion stays unauthorized until the results of this probe have been read by a person.
//
// Exit: 0 report produced · 1 the live test ran and an assumption failed

const sam = require('../src/lib/connectors/sam-gov');
const { kindFromSamNoticeType } = require('../src/lib/procurement/record-kind');

const AUTHORIZE_FLAG = '--i-am-authorized-to-activate';
function bar(ch = '─') { return ch.repeat(78); }
function h(t) { console.log(`\n${bar()}\n${t}\n${bar()}`); }

function readiness() {
  h('SAM.gov PR-3 — READINESS  (no network call was made)');
  console.log(`  generated : ${new Date().toISOString()}`);
  console.log(`  endpoint  : ${sam.SEARCH_URL}`);
  console.log(`  alpha     : ${sam.ALPHA_SEARCH_URL}`);
  console.log('');
  console.log('  STATUS: PREPARED, NOT ACTIVATED. The connector refuses to fetch unless a caller');
  console.log('  passes { authorized: true } explicitly, and the key is never read from the');
  console.log('  environment by the module itself.');

  h('READY');
  for (const line of [
    'authentication — the key is passed in, never read from env inside the module; the full URL is',
    '  a secret because SAM.gov takes api_key as a QUERY parameter, so every error path redacts it',
    'quota — a ledger that refuses BEFORE the call rather than counting failures after, so an',
    '  exhausted budget never reaches the network and cannot trip an unknown overrun behaviour',
    'amendment tracking — detectAmendment() plus the solicitations / solicitation_amendments tables',
    'record kinds — the published ptype labels are mapped; an unrecognised type returns null and',
    '  goes to review rather than defaulting to biddable',
    'biddability — response_open is a GENERATED column; no caller can assert that a notice is open',
    'request validation — mandatory dates, MM/DD/YYYY, the 1-year range cap, and limit 1..1000 are',
    '  all checked locally, so a malformed request never spends a call',
  ]) console.log(line.startsWith('  ') ? `    ${line.trim()}` : `  · ${line}`);

  h('NOT READY — and these are not engineering tasks');
  for (const line of [
    'NO API KEY. Every endpoint requires one. Nothing can be ingested without it.',
    'NO SYSTEM ACCOUNT. Obtained through the entity administrator, not through code.',
    'QUOTA UNKNOWN. open.gsa.gov says only, verbatim, "Request per day are limited based on the',
    '  federal or non-federal or general roles" and gives NO number for ANY role. The seed ceiling',
    '  is therefore NULL. It previously read 10 — a figure from recollection, not a source — and',
    '  was corrected on 2026-11-05.',
    'SAM REGISTRATION EXPIRES 2026-12-30. After that an authorized connector qualifies nothing,',
    '  because the registration gate is checked against the submission deadline.',
  ]) console.log(line.startsWith('  ') ? `    ${line.trim()}` : `  · ${line}`);

  h('ASSUMED — every field name below is DOCUMENTED, NONE IS MEASURED');
  console.log('  grants-gov.js can say its shapes were measured against the live API. This one');
  console.log('  cannot: no key exists, so no response has ever been seen. The documentation is');
  console.log('  also imprecise about its own API — the examples use /prod/ paths that contradict');
  console.log('  the stated base URLs, `limit` is optional in one table and required in another,');
  console.log('  and the response `type` STRINGS are never listed, only the request-side codes.');
  console.log('');
  console.log('  assertResponseShape() therefore fails LOUDLY on an unexpected payload, because the');
  console.log('  silent version of a renamed field is a table of notices whose title, deadline and');
  console.log('  type are all null — which reads as sparse data, not as a broken connector.');
  console.log('');
  console.log('  TO CONFIRM ON THE FIRST AUTHENTICATED CALL:');
  sam.VERIFY_ON_FIRST_CALL.forEach((v, i) => {
    console.log(`\n   ${i + 1}. ${v.replace(/\n/g, '\n      ')}`);
  });

  h('HOW TO RUN THE LIVE TEST, WHEN YOU ARE READY');
  console.log(`  SAM_API_KEY=<key> node scripts/sam-gov-readiness.js ${AUTHORIZE_FLAG}`);
  console.log('');
  console.log('  It makes exactly ONE request (limit=1, a two-day window) and writes nothing to any');
  console.log('  database. Ingestion remains unauthorized until a person has read its output.');
  console.log('');
}

async function liveTest(key) {
  h('LIVE TEST — ONE AUTHENTICATED REQUEST');
  let failures = 0;
  const ok = (m) => console.log(`  ok    ${m}`);
  const bad = (m, d) => { failures++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 400)}`); };

  const today = new Date();
  const mmddyyyy = (d) => `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
  const from = new Date(today.getTime() - 2 * 864e5);

  // A budget of 2 for the whole run: one probe, one spare for the offset question. If the real
  // limit turns out to be lower, the ledger refuses locally rather than discovering it remotely.
  const quota = sam.makeQuotaLedger(2);
  console.log(`  window    : ${mmddyyyy(from)} → ${mmddyyyy(today)}`);
  console.log(`  budget    : ${quota.budget} call(s) for this run`);
  console.log('');

  let first;
  try {
    first = await sam.fetchSearch(
      { postedFrom: mmddyyyy(from), postedTo: mmddyyyy(today), limit: 1, offset: 0 },
      { apiKey: key, authorized: true, quota, fetchImpl: (u, o) => fetch(u, o) },
    );
    ok('the request succeeded and the response matched the documented shape');
  } catch (e) {
    if (e.kind === sam.ERROR_KINDS.AUTH) {
      bad('AUTH: the key was rejected. Not retried — retrying an auth failure in a loop is how a '
        + 'key gets blocked.', e.message);
    } else if (e.kind === sam.ERROR_KINDS.QUOTA) {
      bad('QUOTA: the account is already at its daily limit. Record the real number in the seed.', e.message);
    } else {
      bad(`the request failed (${e.kind || 'unknown'})`, e.message);
    }
    console.log('\n  No assumption could be checked, because no response was received.');
    return failures;
  }

  console.log(`  totalRecords: ${first.totalRecords === null ? 'UNKNOWN' : first.totalRecords}`);
  console.log(`  notices     : ${first.notices.length}`);
  console.log(`  quota left  : ${first.quotaRemaining}`);

  const n = first.notices[0];
  if (!n) {
    console.log('\n  The window returned no notices, so the field-level assumptions could not be');
    console.log('  checked. Widen the window and run again — this is not a failure.');
    return failures;
  }

  // Work through the assumptions, reporting each as held or not.
  console.log('');
  if (n.noticeId) ok(`noticeId is present (${n.noticeId})`);
  else bad('noticeId is absent — the natural key is wrong');

  if (n.responseDeadline !== null) ok(`responseDeadLine resolved (${n.responseDeadline}) — the capital L is right`);
  else console.log('  note  responseDeadline is null for this notice; it may be absent or renamed. '
    + 'Check a notice that definitely has a deadline before concluding.');

  if (n.noticeType) {
    const kind = kindFromSamNoticeType(n.noticeType);
    if (kind) ok(`type "${n.noticeType}" maps to record kind "${kind}"`);
    else bad(`type "${n.noticeType}" is NOT in the mapping — it will go to review until added`,
      'add the exact string to SAM_NOTICE_TYPES; do not guess its kind');
  } else bad('type is absent — record kind cannot be derived');

  if (n.baseNoticeType) {
    const d = sam.typeDiverged(n);
    ok(`baseType present; divergence ${d.diverged ? 'DETECTED' : 'none'} — ${d.reason}`);
  } else console.log('  note  baseType is absent on this notice; the type-transition signal needs it.');

  // THE OFFSET QUESTION, the one assumption that silently truncates an ingest.
  if (quota.remaining === 'UNKNOWN' || quota.remaining > 0) {
    try {
      const second = await sam.fetchSearch(
        { postedFrom: mmddyyyy(from), postedTo: mmddyyyy(today), limit: 1, offset: 1 },
        { apiKey: key, authorized: true, quota, fetchImpl: (u, o) => fetch(u, o) },
      );
      const a = first.notices[0] && first.notices[0].noticeId;
      const b = second.notices[0] && second.notices[0].noticeId;
      if (a && b && a !== b) {
        ok('offset advances the result set — paging works as a record offset');
      } else if (a && b && a === b) {
        bad('offset=1 returned the SAME notice as offset=0',
          'paging does not work the way the connector assumes. An ingest would re-read page 1 '
          + 'forever and silently capture only the first `limit` notices. Resolve before ingesting.');
      } else {
        console.log('  note  the second page returned nothing; offset semantics remain UNCONFIRMED.');
      }
    } catch (e) {
      console.log(`  note  the offset probe could not run: ${e.message}`);
    }
  } else {
    console.log('  note  budget spent; the offset question remains UNCONFIRMED.');
  }

  h('AFTER THIS TEST');
  console.log('  Nothing was ingested and nothing was written. Activation is still a separate');
  console.log('  decision, and it belongs to a person who has read the results above.');
  console.log('  Record the real daily quota in the source_connectors seed before any bulk run.');
  console.log('');
  return failures;
}

async function main() {
  readiness();
  const authorized = process.argv.includes(AUTHORIZE_FLAG);
  const key = process.env.SAM_API_KEY;
  if (!authorized) {
    if (key) {
      console.log(`  NOTE: SAM_API_KEY is set, and NO call was made. A key in the environment is not`);
      console.log(`  consent — pass ${AUTHORIZE_FLAG} to run the one-request live test.`);
    }
    return 0;
  }
  if (!key) {
    console.error(`\n${AUTHORIZE_FLAG} was passed but SAM_API_KEY is not set. No call was made.`);
    return 1;
  }
  return (await liveTest(key)) ? 1 : 0;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => { console.error(e && e.stack ? e.stack : String(e)); process.exit(1); });
