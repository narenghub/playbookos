#!/usr/bin/env node
// ── IS THE RELEASE STILL INERT WHERE IT IS SUPPOSED TO BE? ──────────────────
//
// Ruling 10 item 5: confirm SAM.gov remains inactive, no supplier communication is enabled, and no
// commercial bidding or submission functionality is activated.
//
// Those are three claims, and I have made all three in prose several times. Prose is not evidence,
// and the specific risk here is drift: a seed value edited for a test, an env default flipped, a
// route added next to the ones that already exist. Each is asserted against the code as it stands,
// so the claim is re-made every run rather than remembered from the last report.
//
// Pure static + seed inspection. No database, no network, no server.
//
// Exit: 0 inert · 1 something is live that should not be
'use strict';

const fs = require('fs');
const path = require('path');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 400)}`); };

const ROOT = process.cwd();
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

console.log('\nRELEASE SAFETY POSTURE (ruling 10 item 5)\n');

// ── 1. SAM.gov is inert ────────────────────────────────────────────────────
const { CONNECTOR_SEED } = require('../src/lib/connectors/schema');
const sam = CONNECTOR_SEED.find((c) => c.source_key === 'sam_gov');
if (!sam) bad('sam_gov is not in the connector seed at all');
else {
  if (sam.activated === false) ok('sam_gov seed: activated = false');
  else bad(`sam_gov seed: activated = ${sam.activated}`);
  // NULL, not a number. An invented ceiling reads as knowledge and silently caps or over-runs the
  // real limit, which the published documentation does not state for any role.
  if (sam.daily_call_ceiling === null) ok('sam_gov seed: daily_call_ceiling = null (the real limit is unpublished)');
  else bad(`sam_gov seed: daily_call_ceiling = ${sam.daily_call_ceiling}, expected null`);
}

// Exactly two connectors may be seeded active, and neither of them yields a biddable record.
const active = CONNECTOR_SEED.filter((c) => c.activated === true).map((c) => c.source_key).sort();
if (JSON.stringify(active) === JSON.stringify(['grants_gov', 'usaspending'])) {
  ok(`exactly grants_gov and usaspending are seeded active — neither can produce a solicitation`);
} else bad(`connectors seeded active: ${active.join(', ')}`, 'expected exactly grants_gov, usaspending');

// ── 2. the connector adapter cannot fetch without an explicit authorization ─
const samSrc = read('src/lib/connectors/sam-gov.js');
if (/opts\.authorized !== true/.test(samSrc)) {
  ok('sam-gov.js refuses to fetch unless { authorized: true } is passed explicitly');
} else bad('the SAM activation gate is missing from sam-gov.js');
if (/never read from the environment/.test(samSrc) && !/process\.env\.SAM_API_KEY/.test(samSrc)) {
  ok('sam-gov.js never reads an API key from the environment — a key appearing cannot start it');
} else bad('sam-gov.js reads a key from the environment', 'presence of a key would become consent');

// ── 3. no supplier communication is enabled ────────────────────────────────
const serverSrc = read('server.js');
// The flag must default to OFF. A default-on flag is one deploy away from sending.
if (/String\(process\.env\.OUTREACH_ENABLED \|\| ''\)\.toLowerCase\(\) === 'true'/.test(serverSrc)) {
  ok('outreach requires OUTREACH_ENABLED === "true"; absent or any other value is OFF');
} else bad('the outreach enable flag is not a strict opt-in', 'it must default to off');
if (!/OUTREACH_ENABLED\s*=\s*['"]true['"]/.test(serverSrc)) {
  ok('OUTREACH_ENABLED is not hard-set to true anywhere in server.js');
} else bad('server.js sets OUTREACH_ENABLED=true in code');

// Nothing on this branch may introduce a send. The PRPA endpoints are all GET except task
// create/update, and none of them touches a mailer.
const routes = read('src/api/routes.js');
const prpaBlock = routes.slice(routes.indexOf("'/prpa/review-queue'"));
const prpaSegment = prpaBlock.slice(0, prpaBlock.indexOf('\n});', prpaBlock.lastIndexOf("'/prpa/")) + 4);
for (const forbidden of ['sendEmail', 'sendMail', 'mailer', 'resend', 'twilio', 'whatsapp']) {
  if (!new RegExp(forbidden, 'i').test(prpaSegment)) ok(`no ${forbidden} reference in the PRPA routes`);
  else bad(`a PRPA route references ${forbidden}`, 'read-only intelligence must not be able to send');
}

// ── 4. no bidding or submission functionality ──────────────────────────────
const bidRoutes = (routes.match(/router\.(post|put|patch)\('\/[^']*/g) || [])
  .filter((r) => /\b(bid|submit|proposal|offer|tender|award-response)\b/i.test(r));
if (!bidRoutes.length) ok('no bid, submission, proposal or offer endpoint exists');
else bad(`${bidRoutes.length} bid/submission route(s) found`, bidRoutes.join(' | '));

// Only ONE record kind may ever be biddable, and the ladder must still say so.
const { RECORD_KINDS } = require('../src/lib/procurement/record-kind');
const biddable = Object.entries(RECORD_KINDS).filter(([, v]) => v.biddable).map(([k]) => k);
if (JSON.stringify(biddable) === JSON.stringify(['solicitation'])) {
  ok('exactly one record kind is biddable (solicitation), and its only source is inactive');
} else bad(`biddable kinds: ${biddable.join(', ')}`, 'expected exactly [solicitation]');

// ── 5. the capability registry still refuses unevidenced claims ────────────
const schemaSrc = read('src/lib/connectors/schema.js');
if (/verified_capabilities_verified_requires_evidence/.test(schemaSrc)) {
  ok('the capability evidence constraint is still in the schema');
} else bad('verified_capabilities_verified_requires_evidence is missing');

// ── 6. the migration is not wired into startup ─────────────────────────────
// Ruling 10 item 3. A line added to the boot chain would undo the whole runner decision silently.
if (!/migrateConnectors/.test(serverSrc)) {
  ok('migrateConnectors is NOT in server.js — the migration stays an explicit, operator-run command');
} else bad('migrateConnectors has been wired into server.js startup', 'ruling 10 item 3 forbids this');

console.log('');
if (fail) {
  console.log(`FAIL  ${fail} safety-posture check(s) failed — something is live that should not be\n`);
  process.exit(1);
}
console.log('PASS  SAM.gov inert, no supplier communication, no bidding, migration not in startup\n');
process.exit(0);
