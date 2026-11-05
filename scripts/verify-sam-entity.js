#!/usr/bin/env node
'use strict';
// ── VERIFY A LEGAL ENTITY'S SAM.gov REGISTRATION, FROM ITS UEI ──────────────
//
// Ruling 11 item 4: establish a verified legal-entity registration record for Abiozen LLC using
// its ACTUAL SAM.gov evidence and expiration date.
//
// WHY THIS IS NOT OPTIONAL PAPERWORK. `qualify.js` treats an absent registration as UNKNOWN and
// returns NEEDS_REVIEW. There is no stored registration record, so **nothing can reach QUALIFIED
// today** — this one missing row gates the entire pipeline. And the dashboard's registration card
// already renders from `caps.registration` with uei / cage / status / expires_on, so the shape is
// settled; what is missing is evidence.
//
// WHY A SEPARATE SCRIPT AND NOT A HARDCODED ROW. The values are known from what the CEO has
// stated — UEI GW4MAZJHFV44, CAGE 0P2Q9, "All Awards", expiring 2026-12-30. Writing those into a
// migration would make a human statement indistinguishable from verified evidence, which is the
// exact failure the `verified_capabilities` evidence constraint exists to prevent. A registration
// record must be able to say WHERE it came from. This script reads the authoritative source.
//
// ── THE SOURCE ──────────────────────────────────────────────────────────────
//
// SAM.gov Entity Management API, documented at open.gsa.gov/api/entity-api/ (read 2026-11-05):
//
//   GET https://api.sam.gov/entity-information/v2/entities?api_key=KEY&ueiSAM=<UEI>
//       &includeSections=entityRegistration,coreData
//
// V2 IS PINNED DELIBERATELY. The documentation states: "This parameter is being renamed.
// expirationDate is in V1 and registrationExpirationDate is starting V2." Reading v1 with the v2
// field name yields `undefined` — a silent null on the one date that decides whether a bid is
// even permitted. The version is in the URL and the field name is checked against it.
//
// Registration status, expiration date, CAGE code, purpose of registration and the physical
// address are all documented as **Public** sensitivity, reachable with an ordinary personal API
// key: "Users must have a non-Federal/Federal Individual (Personal) account and the respective API
// Key". No role, no FOUO authorization, no System Account. Reading another entity's public
// registration needs nothing beyond that key.
//
// ── GATES, AND WHY TWO ──────────────────────────────────────────────────────
//
//   SAM_API_KEY=<key> node scripts/verify-sam-entity.js --i-am-authorized-to-activate
//
// Same shape as sam-gov-readiness.js, same reason: a key in the environment is not consent. The
// quota here is published — 10 requests/day for a non-federal personal key with no SAM.gov role,
// 1,000 with one — and 10 is few enough that an accidental loop costs a day's budget.
//
// THIS SCRIPT WRITES NOTHING. It makes one GET and prints what came back. Recording the result as
// a registration record needs a table that does not exist yet, and that migration is a separate
// approval gate. This produces the EVIDENCE for that record, not the record.
//
// Exit: 0 the registration was read · 1 the call failed or the registration is not usable
//       3 did not execute

const ENTITY_URL = 'https://api.sam.gov/entity-information/v2/entities';
const AUTHORIZE_FLAG = '--i-am-authorized-to-activate';
const EXIT_NOT_EXECUTED = 3;

// The CEO's stated values, used ONLY as an expectation to compare against — never as the answer.
// A mismatch is the finding worth having: it means what we believe and what SAM.gov says differ.
const EXPECTED = Object.freeze({
  uei: 'GW4MAZJHFV44',
  cage: '0P2Q9',
  legalName: 'ABIOZEN LLC',
  purpose: /all awards/i,
  expires: '2026-12-30',
  source: 'stated by the CEO, 2026-10-25',
});

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 500)}`); };
const note = (m) => console.log(`  note  ${m}`);
const bar = () => '─'.repeat(78);
const h = (t) => console.log(`\n${bar()}\n${t}\n${bar()}`);

const redact = (u) => String(u).replace(/api_key=[^&]*/, 'api_key=REDACTED');

function daysUntil(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.round((d.getTime() - Date.now()) / 864e5);
}

async function main() {
  const uei = (process.argv.find((a) => /^--uei=/.test(a)) || '').split('=')[1] || EXPECTED.uei;

  h('SAM.gov ENTITY REGISTRATION VERIFICATION (ruling 11 item 4)');
  console.log(`  uei       : ${uei}`);
  console.log(`  source    : ${ENTITY_URL} (v2 pinned — v1 names the expiry field differently)`);
  console.log(`  started   : ${new Date().toISOString()}`);
  console.log('');
  console.log('  Writes nothing. One GET. Produces the evidence for a registration record,');
  console.log('  not the record — that needs a table and a separate approval gate.');

  const authorized = process.argv.includes(AUTHORIZE_FLAG);
  const key = process.env.SAM_API_KEY;

  if (!authorized) {
    h('NOT AUTHORIZED — NO CALL MADE');
    console.log(`  Pass ${AUTHORIZE_FLAG} to make the one request.`);
    if (key) {
      console.log('  SAM_API_KEY is set and was NOT used. A key in the environment is not consent.');
    } else {
      console.log('  SAM_API_KEY is not set.');
    }
    console.log('\n  Obtain the key at https://sam.gov/workspace/profile/account-details, field');
    console.log('  "Public API Key". Note: the documentation contradicts itself on how it is');
    console.log('  revealed — the Opportunities page says you re-enter your account password, the');
    console.log('  Entity API page says a one-time code is emailed to you. Either way, the key is');
    console.log('  "visible until user navigates to a different page" and NO re-retrieval or');
    console.log('  rotation procedure is documented, so capture it on first reveal.');
    console.log('');
    console.log('  This check asserted NOTHING about the registration. It is not a pass.\n');
    process.exit(EXIT_NOT_EXECUTED);
  }
  if (!key) {
    console.error(`\n${AUTHORIZE_FLAG} was passed but SAM_API_KEY is not set. No call was made.\n`);
    process.exit(EXIT_NOT_EXECUTED);
  }

  // ── the one call ──────────────────────────────────────────────────────────
  h('THE REQUEST');
  const url = `${ENTITY_URL}?api_key=${encodeURIComponent(key)}`
    + `&ueiSAM=${encodeURIComponent(uei)}`
    + '&includeSections=entityRegistration,coreData';
  console.log(`  GET ${redact(url)}`);

  let body = null;
  let res = null;
  try {
    res = await fetch(url, { method: 'GET' });
    try { body = await res.json(); } catch (_) { body = null; }
  } catch (e) {
    bad('the request could not be made', e.message);
    return finish();
  }

  // The key is in the query string, so the URL is a secret. Every error path here redacts — the
  // natural instinct on a failure is to print the URL, and doing that pastes a live credential
  // into a terminal transcript and, if copied into an issue, into GitHub.
  if (res.status !== 200) {
    const hint = res.status === 401 || res.status === 403
      ? 'the key was rejected. Not retried — retrying an auth failure in a loop gets a key blocked.'
      : res.status === 429
        ? 'rate limited. For a non-federal personal key the documented limit is 10/day with no '
          + 'SAM.gov role. This burned part of today\'s budget; wait rather than retrying.'
        : 'unexpected status';
    bad(`HTTP ${res.status} — ${hint}`, JSON.stringify(body || {}).slice(0, 300));
    return finish();
  }

  const rl = (n) => { try { return res.headers.get(n); } catch (_) { return null; } };
  console.log(`  X-RateLimit-Limit     : ${rl('x-ratelimit-limit') || 'not set'}`);
  console.log(`  X-RateLimit-Remaining : ${rl('x-ratelimit-remaining') || 'not set'}`);

  const list = (body && (body.entityData || body.entities)) || [];
  if (!Array.isArray(list) || !list.length) {
    bad(`no entity was returned for UEI ${uei}`,
      'this is NOT a finding that the registration is invalid — it may mean the UEI is wrong, or '
      + 'that the entity has opted out of public display (publicDisplayFlag). Check the UEI '
      + 'against sam.gov before concluding anything.');
    return finish();
  }
  if (list.length > 1) {
    note(`${list.length} entities returned for one UEI; using the first and reporting the count.`);
  }

  // ── what SAM.gov says ─────────────────────────────────────────────────────
  h('WHAT SAM.gov SAYS');
  const e = list[0] || {};
  const reg = e.entityRegistration || {};
  const core = e.coreData || {};
  const addr = core.physicalAddress || {};

  // Pinned-version check. If `registrationExpirationDate` is absent but `expirationDate` is
  // present, we are talking to v1 despite the URL, and the expiry would have read as undefined.
  const hasV2 = Object.prototype.hasOwnProperty.call(reg, 'registrationExpirationDate');
  const hasV1 = Object.prototype.hasOwnProperty.call(reg, 'expirationDate');
  if (hasV2) ok('registrationExpirationDate is present — this is v2 or later, as pinned');
  else if (hasV1) {
    bad('the response carries `expirationDate`, not `registrationExpirationDate`',
      'that is the V1 field name. The URL pins v2, so either the pin is not being honoured or the '
      + 'API changed. Reading the v2 name here would have produced a silent null on the expiry.');
  } else {
    bad('NEITHER expiry field name is present', `keys: ${Object.keys(reg).join(', ') || 'none'}`);
  }

  const expires = hasV2 ? reg.registrationExpirationDate : (hasV1 ? reg.expirationDate : null);
  const rows = [
    ['legalBusinessName', reg.legalBusinessName],
    ['ueiSAM', reg.ueiSAM],
    ['cageCode', reg.cageCode],
    ['registrationStatus', reg.registrationStatus],
    ['samRegistered', reg.samRegistered],
    ['registrationDate', reg.registrationDate],
    ['registrationExpirationDate', expires],
    ['purposeOfRegistrationCode', reg.purposeOfRegistrationCode],
    ['purposeOfRegistrationDesc', reg.purposeOfRegistrationDesc],
    ['exclusionStatusFlag', reg.exclusionStatusFlag],
    ['publicDisplayFlag', reg.publicDisplayFlag],
    ['physicalAddress', [addr.addressLine1, addr.addressLine2, addr.city,
      addr.stateOrProvinceCode, addr.zipCode].filter(Boolean).join(', ') || null],
  ];
  console.log('');
  for (const [k, v] of rows) {
    console.log(`  ${k.padEnd(28)} ${v === undefined || v === null || v === '' ? 'UNKNOWN' : v}`);
  }

  // ── is it usable, and does it match what we believed? ─────────────────────
  h('IS THIS REGISTRATION USABLE?');
  if (/^A$/i.test(String(reg.registrationStatus)) || /active/i.test(String(reg.registrationStatus))) {
    ok(`registrationStatus is ${reg.registrationStatus} — active`);
  } else {
    bad(`registrationStatus is ${reg.registrationStatus || 'UNKNOWN'}`,
      'a non-active registration cannot receive a federal award. Nothing qualifies.');
  }

  if (expires) {
    const d = daysUntil(expires);
    console.log(`  expires in ${d === null ? 'UNKNOWN' : d} day(s)`);
    if (d !== null && d <= 0) {
      bad(`the registration EXPIRED on ${expires}`, 'no opportunity can qualify until it is renewed');
    } else if (d !== null && d <= 90) {
      // Not a warning to be scrolled past. The registration is checked against each submission
      // DEADLINE, not against today, so a solicitation closing after the expiry date does not
      // qualify for it — months before the registration actually lapses.
      bad(`the registration expires in ${d} day(s), on ${expires}`,
        'qualification is evaluated against each SUBMISSION DEADLINE, not against today. So every '
        + 'solicitation closing after that date is ALREADY unqualifiable, and activating ingestion '
        + 'now would fill the pipeline with opportunities that cannot be bid. Renew first.');
    } else ok(`expires ${expires} — ${d} days out`);
  } else {
    bad('no expiration date was returned', 'the expiry gates every qualification decision');
  }

  if (reg.exclusionStatusFlag && !/^n$/i.test(String(reg.exclusionStatusFlag))) {
    bad(`exclusionStatusFlag is ${reg.exclusionStatusFlag}`, 'an excluded entity cannot be awarded');
  } else ok('no active exclusion flag');

  h(`AGAINST WHAT WE BELIEVED (${EXPECTED.source})`);
  const cmp = [
    ['UEI', EXPECTED.uei, reg.ueiSAM],
    ['CAGE', EXPECTED.cage, reg.cageCode],
    ['legal name', EXPECTED.legalName, reg.legalBusinessName],
    ['expiry', EXPECTED.expires, expires ? String(expires).slice(0, 10) : null],
  ];
  for (const [label, want, got] of cmp) {
    if (got === undefined || got === null || got === '') {
      note(`${label}: SAM.gov returned nothing to compare against "${want}"`);
    } else if (String(got).trim().toUpperCase() === String(want).trim().toUpperCase()) {
      ok(`${label} matches: ${got}`);
    } else {
      // A mismatch is not necessarily an error — a record can be updated — but it means our
      // belief is stale, and a stale belief that nobody checks is how an expectation ends up
      // encoding account state a human changed months ago.
      bad(`${label} MISMATCH — we believed "${want}", SAM.gov says "${got}"`,
        'update the stated record; do not update SAM.gov to match our belief');
    }
  }
  if (EXPECTED.purpose.test(String(reg.purposeOfRegistrationDesc || ''))) {
    ok(`purpose of registration is "${reg.purposeOfRegistrationDesc}" — contracts, not only grants`);
  } else {
    bad(`purpose of registration is "${reg.purposeOfRegistrationDesc || 'UNKNOWN'}"`,
      'we believed "All Awards". A grants-only purpose means federal CONTRACTS are out of scope, '
      + 'which changes what this product can qualify.');
  }

  h('WHAT TO DO WITH THIS');
  console.log('  This output is the EVIDENCE for a registration record. The record itself has');
  console.log('  nowhere to live yet: there is no company_registrations table, and creating one is');
  console.log('  a migration and therefore a separate approval gate.');
  console.log('');
  console.log('  Nothing was written. Nothing was marked verified.');
  console.log('');
  return finish();
}

function finish() {
  h('RESULT');
  if (fail) {
    console.log(`  ${fail} failure(s). The registration is NOT confirmed usable.\n`);
    process.exit(1);
  }
  console.log('  The registration was read from SAM.gov and is usable as recorded above.\n');
  process.exit(0);
}

main().catch((e) => { console.error(`\nverify-sam-entity: ${redact(e.stack || e.message)}`); process.exit(1); });
