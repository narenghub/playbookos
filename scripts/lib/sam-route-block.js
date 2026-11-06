'use strict';
// ── THE SAM.gov ROUTE IS UNRESOLVED, SO THE PROBES REFUSE TO CALL ───────────
//
// Ruling item 1: "Do not continue guessing endpoint paths or repeatedly testing authenticated
// calls."
//
// A note in a document does not stop a command being re-run. Fourteen authenticated calls were
// already spent discovering that every documented path returns an empty 404 — six path variants
// across two APIs — and each one spent budget against a quota nobody has measured. Running them
// again cannot produce new information until somebody states what the correct endpoint is.
//
// So the refusal lives in code, in one place, and both probes consult it. It is lifted by naming
// an FSD case reference, which is the thing that would make another attempt meaningful:
//
//   --fsd-case=<reference>
//
// That is deliberately not a boolean. `--force` would be a flag somebody sets to get past a
// message; a case reference is a fact that only exists once the question has actually been asked,
// and it gets printed into the output so the run is attributable to the answer that prompted it.
//
// ── WHAT WOULD CHANGE THIS FILE ─────────────────────────────────────────────
//
// FSD stating the correct base URL, or stating that a System Account is required. At that point
// the base URL becomes a one-line change (fetchSearch already takes `baseUrl` as a parameter) and
// this block is deleted — not weakened, deleted. It is scaffolding around an open question, not a
// permanent control like the activation gate it sits in front of.

const EVIDENCE = Object.freeze({
  recorded: '2026-11-06',
  authenticatedCalls: 14,
  pathsTried: Object.freeze([
    'api.sam.gov/opportunities/v2/search',
    'api.sam.gov/prod/opportunities/v2/search',
    'api.sam.gov/opportunities/v1/search',
    'api.sam.gov/prod/opportunities/v1/search',
    'api.sam.gov/entity-information/v{2,3,4}/entities',
    'api.sam.gov/prod/entity-information/v{2,3,4}/entities',
    'api.sam.gov/  (no path at all)',
  ]),
  result: 'HTTP 404, empty body, server: istio-envoy, no X-RateLimit headers — from two unrelated '
    + 'networks, while open.gsa.gov and api.data.gov answered normally from both',
  doc: 'claude/sam-gov-api-unreachable-evidence-for-fsd.md',
});

/**
 * Should this probe make a live call?
 *
 * @returns {{allowed:boolean, caseRef:string|null}}
 */
function routeCheck(argv = process.argv) {
  const arg = argv.find((a) => /^--fsd-case=/.test(a));
  const caseRef = arg ? arg.split('=').slice(1).join('=').trim() : null;
  return { allowed: !!caseRef, caseRef: caseRef || null };
}

/** Print the refusal. The caller owns the exit code. */
function explainBlock(scriptName) {
  const bar = '─'.repeat(78);
  console.log(`\n${bar}\nLIVE CALL REFUSED — THE ROUTE IS UNRESOLVED\n${bar}`);
  console.log(`  ${EVIDENCE.authenticatedCalls} authenticated calls on ${EVIDENCE.recorded} established that every documented`);
  console.log('  SAM.gov path is unrouted:');
  for (const p of EVIDENCE.pathsTried) console.log(`    · ${p}`);
  console.log('');
  console.log(`  ${EVIDENCE.result}.`);
  console.log('');
  console.log('  Another call cannot produce new information until somebody states the correct');
  console.log('  endpoint, and each one spends budget against a quota that has never been');
  console.log('  measured — no X-RateLimit header has ever been returned.');
  console.log('');
  console.log(`  The evidence package is ${EVIDENCE.doc}.`);
  console.log('  Submit it to FSD (www.fsd.gov), then re-run with the case reference:');
  console.log('');
  console.log(`    node scripts/${scriptName} --i-am-authorized-to-activate --fsd-case=<reference>`);
  console.log('');
  console.log('  The reference is required rather than a --force flag because it is a fact that');
  console.log('  only exists once the question has been asked. It is printed into the output, so');
  console.log('  the run is attributable to the answer that prompted it.');
  console.log('');
  console.log('  To check reachability WITHOUT spending a call or sending a key:');
  console.log('    node scripts/diagnose-sam-reachability.js\n');
}

module.exports = { EVIDENCE, routeCheck, explainBlock };
