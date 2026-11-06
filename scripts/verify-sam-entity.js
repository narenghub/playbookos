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
// Same shape as sam-gov-readiness.js, same reason: a key in the environment is not consent.
//
// ON THE QUOTA, AND WHAT IS NOT KNOWN. The Entity Management API page publishes a five-row table
// of daily limits by account type. WHICH ROW APPLIES TO THIS ACCOUNT IS UNVERIFIED: the two rows
// that could apply to a non-federal personal key differ by whether the user "has a Role in
// SAM.gov", and nobody has established whether this account does. A third GSA page publishes a
// contradictory scheme with no role distinction at all. So no number is assumed here — the
// response's own X-RateLimit headers are printed, and until one is observed the quota is UNKNOWN.
// Treating it as unknown argues for the same care a small number would: one call, no loop.
//
// THIS SCRIPT WRITES NOTHING. It makes one GET and prints what came back. Recording the result as
// a registration record needs a table that does not exist yet, and that migration is a separate
// approval gate. This produces the EVIDENCE for that record, not the record.
//
// Exit: 0 the registration was read · 1 the call failed or the registration is not usable
//       3 did not execute

const routeBlock = require('./lib/sam-route-block');

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

  // Ruling item 1, as a control rather than a note. See scripts/lib/sam-route-block.js.
  const route = routeBlock.routeCheck();
  if (!route.allowed) {
    routeBlock.explainBlock('verify-sam-entity.js');
    process.exit(2);
  }
  console.log(`\n  FSD case ${route.caseRef} — proceeding on that basis.`);

  // ── THE REQUEST, AS A BOUNDED MEASUREMENT RATHER THAN A GUESS ─────────────
  //
  // The first run of this script asked v2 and got **HTTP 404 with an empty body**. That is not
  // explained by the documentation: open.gsa.gov lists v1 through v4 as live production endpoints
  // with no deprecation notice on any of them, documents no 404 for this API, and an invalid key
  // is documented to come back as a 403 carrying "An invalid api_key was supplied". An empty-bodied
  // 404 is the signature of a gateway rejecting the ROUTE — a path that is no longer served, or a
  // key not provisioned for this API — rather than of a rejected credential or a missing entity.
  //
  // So which variable is wrong is UNKNOWN, and there are three candidates: the version, the
  // includeSections parameter, and the key's entitlement. Changing all three at once and declaring
  // victory on a 200 would tell us nothing about why. Changing one at a time is the method, and
  // each attempt costs a call against a quota nobody has measured.
  //
  // Hence: an ordered, CAPPED matrix, newest version first since v2 already failed, varying one
  // thing per step, stopping at the first 200. Four calls maximum, printed as they go, with the
  // rate-limit headers from every attempt — a 404 still carries them, so even total failure
  // measures the quota, which is the one thing ruling 13 item 5 actually wants.
  //
  // v1 is last and flagged, because v1 names the expiry `expirationDate` rather than
  // `registrationExpirationDate`. The field check below reads whichever is present, so a v1
  // answer is still usable evidence — it just has to be labelled as v1.
  // THE /prod/ PREFIX IS NOW IN THE MATRIX, AND IT IS THE LEADING HYPOTHESIS.
  //
  // open.gsa.gov states the Opportunities base URL as https://api.sam.gov/opportunities/v2/search
  // while its own EXAMPLES use https://api.sam.gov/prod/opportunities/v2/search. We treated the
  // stated base as authoritative and recorded the contradiction as an open question. Then, on
  // 2026-11-06, the stated path returned an empty-bodied 404 for the Opportunities API AND for all
  // four versions of this one. A 404 is a gateway refusing a route; a rejected key is a 403.
  //
  // So the prefix the examples use gets tested, newest version first. Ordered and capped: one
  // variable per step, stopping at the first 200.
  const ATTEMPTS = [
    { version: 'v4', sections: true, prefix: '' },
    { version: 'v3', sections: true, prefix: '' },
    { version: 'v4', sections: true, prefix: 'prod/' },
    { version: 'v3', sections: true, prefix: 'prod/' },
    { version: 'v2', sections: true, prefix: 'prod/' },
    { version: 'v4', sections: false, prefix: '' },
  ];
  const MAX_CALLS = Number((process.argv.find((a) => /^--max-calls=/.test(a)) || '').split('=')[1]) || ATTEMPTS.length;

  h(`THE REQUEST — up to ${Math.min(MAX_CALLS, ATTEMPTS.length)} attempt(s), stopping at the first 200`);
  console.log('  Each attempt spends one call against a quota that is UNKNOWN. The rate-limit');
  console.log('  headers are printed for every attempt, including failures.');
  console.log('');

  let body = null;
  let res = null;
  let used = null;
  let calls = 0;

  for (const attempt of ATTEMPTS) {
    if (calls >= MAX_CALLS) break;
    const base = `https://api.sam.gov/${attempt.prefix || ''}entity-information/${attempt.version}/entities`;
    const url = `${base}?api_key=${encodeURIComponent(key)}`
      + `&ueiSAM=${encodeURIComponent(uei)}`
      + (attempt.sections ? '&includeSections=entityRegistration,coreData' : '');
    calls += 1;
    // The key is in the query string, so the URL is a secret. Redacted on every path — the natural
    // instinct on a failure is to print the URL, and that pastes a live credential into a terminal
    // transcript and, if copied into an issue, into GitHub.
    console.log(`  [${calls}] GET ${redact(url)}`);

    let r = null;
    let b = null;
    try {
      r = await fetch(url, { method: 'GET' });
      try { b = await r.json(); } catch (_) { b = null; }
    } catch (e) {
      console.log(`      network error: ${redact(e.message)}`);
      continue;
    }
    const hdr = (n) => { try { return r.headers.get(n); } catch (_) { return null; } };
    const lim = hdr('x-ratelimit-limit');
    const rem = hdr('x-ratelimit-remaining');
    console.log(`      HTTP ${r.status}   X-RateLimit-Limit: ${lim || 'not set'}   Remaining: ${rem || 'not set'}`);
    if (r.status !== 200) {
      const raw = JSON.stringify(b || {});
      console.log(`      body: ${raw.length > 220 ? `${raw.slice(0, 220)}…` : raw}`);
      if (r.status === 401 || r.status === 403) {
        bad('the key was REJECTED (401/403)',
          'this is a credential problem, not a route problem. Stopping — retrying an auth failure '
          + 'in a loop is how a key gets blocked.');
        return finish();
      }
      if (r.status === 429) {
        bad('RATE LIMITED (429) — and this is the direct evidence of the real limit',
          `record the X-RateLimit values above. Attempts made this run: ${calls}.`);
        return finish();
      }
      continue;   // 404 or 5xx: try the next variable
    }
    res = r; body = b; used = attempt;
    console.log(`      → 200. Using ${attempt.version}${attempt.sections ? ' with includeSections' : ' WITHOUT includeSections'}.`);
    break;
  }

  if (!res) {
    h('NO VERSION ANSWERED');
    bad(`all ${calls} attempt(s) failed — the Entity Management API route is not reachable with this key`,
      'every attempt returned 404 or 5xx, never 401/403, so the key was not rejected — the ROUTE was.');
    console.log('\n  What this narrows it to, and what it does NOT prove:');
    console.log('    · NOT a bad UEI — a UEI that does not exist returns 200 with an empty list.');
    console.log('    · NOT a rejected key — that is a documented 403 with a message body.');
    console.log('    · The documentation lists v1–v4 as live with no deprecation, so either the');
    console.log('      published paths are stale, or this key is not entitled to the Entity API.');
    console.log('\n  The cheapest next step is NOT another call. On sam.gov, open');
    console.log('  Workspace → Profile → Account Details and check whether the account shows any');
    console.log('  API entitlement beyond the Public API Key, then ask FSD (www.fsd.gov) whether a');
    console.log('  personal key is entitled to entity-information. A System Account with');
    console.log('  "Entity Information: read public" is documented for this API and may be required.');
    console.log('\n  THE REGISTRATION ITSELF IS NOT IN DOUBT from this failure. It is unverified by');
    console.log('  THIS ROUTE, which is a different statement. The UEI, CAGE, purpose and expiry');
    console.log('  remain as stated and unconfirmed against the authoritative source.\n');
    return finish();
  }

  const rl = (n) => { try { return res.headers.get(n); } catch (_) { return null; } };
  console.log('');
  console.log(`  answered by           : ${used.version}${used.sections ? '' : ' (no includeSections)'}`);
  console.log(`  calls spent this run  : ${calls}`);
  console.log(`  X-RateLimit-Limit     : ${rl('x-ratelimit-limit') || 'not set'}`);
  console.log(`  X-RateLimit-Remaining : ${rl('x-ratelimit-remaining') || 'not set'}`);
  if (!rl('x-ratelimit-limit')) {
    note('no X-RateLimit-Limit header, so the daily quota remains UNKNOWN — do not adopt a figure');
    note('from a sibling GSA page; neither published scheme is stated to apply to this account.');
  }
  if (used.version === 'v1') {
    note('v1 answered. v1 names the expiry `expirationDate`, not `registrationExpirationDate` —');
    note('the field check below reads whichever is present, so this is still usable evidence.');
  }

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
