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
// WHAT THE LIVE TEST DOES: at most TWO requests, budgeted in a ledger that refuses a third
// locally rather than discovering the real limit remotely. Both ask for 5 notices over a two-day
// window. The page size is 5 and not 1 for a specific reason: with a page size of one, a page
// index and a record offset mean the same thing, so the offset question — the one that silently
// truncates an ingest — cannot be answered at all. An earlier version used limit=1 and reported
// an answer anyway.
//
// It then works through VERIFY_ON_FIRST_CALL, reports which assumptions held, and runs every real
// record returned through the notice-type mapping. It writes nothing to any database — this is a
// probe, not an ingest, and ingestion stays unauthorized until a person has read its output.
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
  console.log('  It makes at most TWO requests (5 notices each, a two-day window) and writes nothing to any');
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
  // A page size above 1 is REQUIRED, not a preference: with limit=1 a page index and a record
  // offset are indistinguishable, so the offset question cannot be answered at all.
  const PAGE_SIZE = 5;
  console.log(`  window    : ${mmddyyyy(from)} → ${mmddyyyy(today)}`);
  console.log(`  budget    : ${quota.budget} call(s) for this run`);
  console.log(`  page size : ${PAGE_SIZE} (must exceed 1 to decide the offset question)`);
  console.log('');

  let first;
  try {
    first = await sam.fetchSearch(
      { postedFrom: mmddyyyy(from), postedTo: mmddyyyy(today), limit: PAGE_SIZE, offset: 0 },
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
  console.log(`  quota left  : ${first.quotaRemaining}   (our local ledger, not the API's)`);

  // ── THE REAL QUOTA, IF THE API WILL SAY ─────────────────────────────────
  //
  // open.gsa.gov publishes NO number for this API. Two sibling GSA pages carrying the identical
  // "federal or non-federal or general roles" sentence publish 10/day for a non-federal user; a
  // third publishes a table giving a non-federal personal key 10/day with no SAM.gov role and
  // 1,000/day with one. The schemes contradict each other and neither is stated to apply here, so
  // the number must be measured. This is the measurement.
  const rl = first.rateLimit || { limit: 'UNKNOWN', remaining: 'UNKNOWN', measured: false, note: '' };
  console.log(`  API limit   : ${rl.limit}`);
  console.log(`  API left    : ${rl.remaining}`);
  if (rl.measured) {
    ok(`the API reported its own limit: ${rl.limit}`);
    console.log(`          ${rl.note}`);
    if (typeof rl.limit === 'number' && rl.limit <= 10) {
      bad(`the limit is ${rl.limit} per window — a backfill CANNOT be done naively`,
        'postedFrom/postedTo are mandatory with a 1-year maximum span, so a full backfill is '
        + 'inherently multi-request. At this limit it would silently capture a fraction and look '
        + 'like a quiet source. Plan the ingest around the measured number before activating.');
    }
  } else {
    console.log('  note  no X-RateLimit-Limit header was returned, so the daily quota is STILL');
    console.log('        UNKNOWN. Do NOT adopt the 10/day or 1,000/day figures from the sibling');
    console.log('        GSA pages — neither is stated to apply to this API. The real limit can');
    console.log('        then only be learned from a 429, so keep the local ledger conservative.');
  }

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

  // WHICH SPELLING THE API ACTUALLY USES. open.gsa.gov gives two — `reponseDeadLine` in the
  // parameter table, `responseDeadLine` in Example 1 — and the connector reads both, so this is
  // now a measurement rather than a hope. It matters more than it looks: the field feeds
  // solicitations.response_open, and a null deadline makes that false for every record, which
  // reads as "nothing is biddable" — the correct output for the pre-activation state. Getting it
  // wrong would look exactly like working.
  const keysSeen = [...new Set(first.notices.map((x) => x.deadlineKeySeen).filter(Boolean))];
  if (keysSeen.length === 1) {
    ok(`the deadline field is spelled "${keysSeen[0]}" — ANSWERED. Drop the other spelling.`);
  } else if (keysSeen.length > 1) {
    bad(`both spellings appear across this page (${keysSeen.join(', ')})`,
      'the API is inconsistent per record; keep reading both and do not drop either');
  } else {
    console.log('  note  not one notice on this page carried EITHER spelling of the deadline. These');
    console.log('        may all be notice types without a deadline (award, special notice). Fetch a');
    console.log('        Solicitation or Combined Synopsis before concluding the field was renamed.');
  }
  const withDeadline = first.notices.filter((x) => x.responseDeadline !== null).length;
  console.log(`  deadlines   : ${withDeadline} of ${first.notices.length} notice(s) carry a value`);

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

  // ── THE OFFSET QUESTION ───────────────────────────────────────────────────
  //
  // The assumption that silently truncates an ingest, and the earlier version of this probe COULD
  // NOT ANSWER IT. It asked for limit=1 at offset=0 and offset=1 and concluded "paging works as a
  // record offset" when the two differed. With a page size of ONE, a page index and a record
  // offset are the same thing — offset=1 means record 2 under both readings — so that conclusion
  // was stronger than the measurement, which is the failure this whole repository is organised
  // against. The connector's own VERIFY_ON_FIRST_CALL said to use limit=2; the probe did not.
  //
  // With PAGE_SIZE > 1 the readings separate and the answer is decisive:
  //
  //   page index   offset=1 → records PAGE_SIZE+1 …   → first id of page 2 is NOT in page 1
  //   record offset offset=1 → records 2 …            → first id of page 2 IS page 1's SECOND id
  if (first.notices.length < 2) {
    console.log('  note  fewer than 2 notices returned, so a page size above 1 was not achieved and');
    console.log('        the offset question CANNOT be answered. Widen the window and re-run.');
  } else if (quota.remaining === 'UNKNOWN' || quota.remaining > 0) {
    try {
      const second = await sam.fetchSearch(
        { postedFrom: mmddyyyy(from), postedTo: mmddyyyy(today), limit: PAGE_SIZE, offset: 1 },
        { apiKey: key, authorized: true, quota, fetchImpl: (u, o) => fetch(u, o) },
      );
      const page1 = first.notices.map((x) => x.noticeId);
      const head2 = second.notices[0] && second.notices[0].noticeId;
      if (!head2) {
        console.log('  note  the second page returned nothing; offset semantics remain UNCONFIRMED.');
      } else if (head2 === page1[1]) {
        ok(`offset is a RECORD offset (page 2 begins at page 1's second notice, ${head2})`);
        bad('the documentation calls offset a "page index" — it is not',
          'paging by page index would SKIP records. Use a record offset: advance by `limit`, not by 1.');
      } else if (!page1.includes(head2)) {
        ok(`offset is a PAGE INDEX, as documented (page 2 begins outside page 1, ${head2})`);
        ok('the connector pages by incrementing offset by 1 — correct for a page index');
      } else {
        bad(`page 2 begins at ${head2}, which is inside page 1 but not its second record`,
          'offset behaves as neither reading. Do NOT bulk ingest until this is understood — an '
          + 'ingest would silently capture an unknown subset.');
      }
    } catch (e) {
      console.log(`  note  the offset probe could not run: ${e.message}`);
    }
  } else {
    console.log('  note  budget spent; the offset question remains UNCONFIRMED.');
  }

  // ── EVERY REAL RECORD ON THIS PAGE, THROUGH THE MAPPING (ruling 11 item 3) ─
  //
  // "Test a small number of real solicitation records." One record proves the request works; a
  // handful is what surfaces a notice type nobody listed. An unmapped type is SAFE — record-kind
  // returns null and the record goes to review rather than defaulting to biddable — but it is
  // invisible until something counts them.
  h(`THE ${first.notices.length} REAL RECORD(S) RETURNED`);
  const unmapped = new Map();
  for (const x of first.notices) {
    const kind = x.noticeType ? kindFromSamNoticeType(x.noticeType) : null;
    const div = x.baseNoticeType ? sam.typeDiverged(x) : null;
    console.log(`  ${(x.noticeId || 'NO-ID').slice(0, 22).padEnd(24)} ${String(x.noticeType || 'UNKNOWN').slice(0, 30).padEnd(32)} → ${kind || 'UNMAPPED → review'}`);
    console.log(`      deadline ${x.responseDeadline || 'none'}${div && div.diverged ? `   TYPE CHANGED from ${x.baseNoticeType}` : ''}`);
    if (x.noticeType && !kind) unmapped.set(x.noticeType, (unmapped.get(x.noticeType) || 0) + 1);
  }
  if (unmapped.size) {
    console.log('');
    bad(`${unmapped.size} notice type string(s) are not in SAM_NOTICE_TYPES`,
      [...unmapped.entries()].map(([k, v]) => `${k} ×${v}`).join(' | '));
    console.log('          These are SAFE — they map to null and go to review, never to biddable.');
    console.log('          Add the exact strings before a bulk run, or the review queue fills with them.');
  } else {
    ok('every notice type on this page maps to a known record kind');
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
