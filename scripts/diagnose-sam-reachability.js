#!/usr/bin/env node
'use strict';
// ── IS api.sam.gov REACHABLE FROM THIS MACHINE AT ALL? ──────────────────────
//
//   node scripts/diagnose-sam-reachability.js
//
// ── THIS SCRIPT NEVER SENDS AN API KEY, AND CANNOT ──────────────────────────
//
// It does not read SAM_API_KEY. It does not take a key as an argument. Every request below is
// deliberately **keyless**, which is what makes it free: an unauthenticated request cannot spend a
// quota nobody has measured, and it cannot leak a credential into a terminal transcript.
//
// ── WHY A KEYLESS PROBE IS THE RIGHT NEXT STEP ──────────────────────────────
//
// On 2026-11-06, eight authenticated attempts — the Opportunities endpoint plus four Entity API
// versions, across the documented base URL and the /prod/ form the documentation's examples use —
// every one returned **HTTP 404 with an empty body and no X-RateLimit headers at all**.
//
// Those three facts together are the finding, and they do not point where the first two attempts
// suggested:
//
//   · A REJECTED KEY IS A 403 carrying `An invalid api_key was supplied`. Documented. Not a 404.
//   · A MISSING KEY IS A 403 carrying `No api_key was supplied`. Also documented.
//   · A NON-EXISTENT UEI IS A 200 with an empty list.
//   · AND A REQUEST THAT REACHED THE GATEWAY CARRIES RATE-LIMIT HEADERS, even when it errors.
//
// An empty-bodied 404 with no headers is not the API answering. It is something in front of the
// API answering. That could be an edge or WAF rule, a proxy, a DNS answer pointing somewhere
// unexpected, or a genuinely retired path — and those have completely different fixes, so guessing
// between them by changing the URL again is the wrong move. Eight calls have already been spent
// that way.
//
// THE DISCRIMINATOR: send the same request with NO KEY.
//
//   · 403 "No api_key was supplied"  → the route is alive and the gateway is reachable. The
//                                      problem is then the KEY ITSELF, and the authenticated 404
//                                      becomes genuinely strange — worth taking to FSD with this
//                                      output attached.
//   · 404, empty, no headers         → api.sam.gov answers this way to everything from here, which
//                                      is NOT about our path and NOT about our key. Look at the
//                                      network: proxy, VPN, DNS, corporate filtering.
//
// A control request to a different government host runs too, so "outbound HTTPS is broken" is
// distinguished from "this host behaves oddly" rather than assumed either way.
//
// Exit: 0 the diagnostic ran and printed its findings · 1 it could not run
//       The verdict here is the REPORT, not the exit code: this script measures, it does not judge.

const PROBES = [
  // The two paths the authenticated attempts used, keyless.
  { label: 'Opportunities, documented base URL', url: 'https://api.sam.gov/opportunities/v2/search?postedFrom=11/04/2026&postedTo=11/06/2026&limit=1' },
  { label: 'Opportunities, /prod/ path from the examples', url: 'https://api.sam.gov/prod/opportunities/v2/search?postedFrom=11/04/2026&postedTo=11/06/2026&limit=1' },
  { label: 'Entity Management v4', url: 'https://api.sam.gov/entity-information/v4/entities?ueiSAM=GW4MAZJHFV44' },
  // The host itself, with no path. Tells us whether anything at all is served.
  { label: 'api.sam.gov root (no path)', url: 'https://api.sam.gov/' },
  // CONTROLS. Without these, a total failure is indistinguishable from this machine having no
  // outbound HTTPS, and the report would blame SAM.gov for a broken network.
  { label: 'CONTROL: open.gsa.gov (the documentation host)', url: 'https://open.gsa.gov/api/get-opportunities-public-api/', control: true },
  { label: 'CONTROL: api.data.gov (the gateway SAM.gov error strings come from)', url: 'https://api.data.gov/', control: true },
];

// `server` is first because it turned out to be the most informative field of the lot: an
// `istio-envoy` answering an empty 404 on EVERY path including the bare root is a service-mesh
// proxy with no route configured for the host, which is not how an API behaves.
const INTERESTING_HEADERS = [
  'server', 'content-type', 'content-length', 'via', 'x-cache', 'cf-ray',
  'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-amzn-requestid', 'x-amz-cf-id',
  'www-authenticate', 'location',
];

function bar() { return '─'.repeat(78); }
function h(t) { console.log(`\n${bar()}\n${t}\n${bar()}`); }

async function probe(p) {
  const started = Date.now();
  let res = null;
  let body = '';
  let err = null;
  try {
    res = await fetch(p.url, { method: 'GET', redirect: 'manual' });
    try { body = (await res.text()).slice(0, 300); } catch (_) { body = '(body unreadable)'; }
  } catch (e) {
    err = e;
  }
  const ms = Date.now() - started;
  console.log(`\n  ${p.control ? 'CONTROL  ' : ''}${p.label}`);
  console.log(`    ${p.url}`);
  if (err) {
    // A transport failure is a different finding from an HTTP status, and must not be reported as
    // one. DNS, TLS and connection-refused all land here.
    console.log(`    DID NOT CONNECT after ${ms}ms: ${err.cause ? `${err.message} (${err.cause.code || err.cause.message})` : err.message}`);
    return { p, err, ms };
  }
  console.log(`    HTTP ${res.status} ${res.statusText || ''}  (${ms}ms)`);
  const shown = [];
  for (const name of INTERESTING_HEADERS) {
    const v = res.headers.get(name);
    if (v !== null && v !== undefined) shown.push(`${name}: ${v}`);
  }
  console.log(`    headers: ${shown.length ? shown.join(' · ') : '(none of interest set)'}`);
  const oneLine = body.replace(/\s+/g, ' ').trim();
  console.log(`    body (${body.length} chars): ${oneLine ? oneLine.slice(0, 180) : '(empty)'}`);
  return {
    p,
    status: res.status,
    body,
    ms,
    rateLimited: res.headers.get('x-ratelimit-limit') !== null,
    server: res.headers.get('server'),
    emptyBody: body.length === 0,
  };
}

async function main() {
  h('api.sam.gov REACHABILITY — KEYLESS, SPENDS NO QUOTA');
  console.log(`  started   : ${new Date().toISOString()}`);
  console.log(`  node      : ${process.version}`);
  console.log('');
  console.log('  No API key is read, passed or sent. SAM_API_KEY is deliberately ignored, so');
  console.log('  nothing here can spend an unmeasured quota or print a credential.');

  // A proxy in the environment rewrites or intercepts requests, and is invisible unless asked for.
  // This has to be ruled in or out before any conclusion about a remote host.
  const proxyVars = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'NO_PROXY', 'no_proxy'];
  const set = proxyVars.filter((v) => process.env[v]);
  console.log('');
  if (set.length) {
    console.log('  PROXY ENVIRONMENT IS SET — this alone can produce an unexpected 404:');
    for (const v of set) console.log(`    ${v}=${process.env[v]}`);
  } else {
    console.log('  no proxy environment variables are set');
  }

  h('PROBES');
  const results = [];
  for (const p of PROBES) results.push(await probe(p));

  // ── what the pattern means ───────────────────────────────────────────────
  h('WHAT THIS NARROWS IT TO');
  const sam = results.filter((r) => !r.p.control);
  const controls = results.filter((r) => r.p.control);
  const controlsOk = controls.some((r) => !r.err && r.status && r.status < 500);
  const anySamConnected = sam.some((r) => !r.err);
  const forbidden = sam.filter((r) => r.status === 403);
  const notFound = sam.filter((r) => r.status === 404);
  const headered = sam.filter((r) => r.rateLimited);

  const root = sam.find((r) => /root \(no path\)/.test(r.p.label));
  const meshSignature = sam.filter((r) => r.status === 404 && r.emptyBody
    && /envoy|istio/i.test(r.server || ''));

  // THE PROXY IS WEIGHED FIRST, NOT MENTIONED AND THEN IGNORED. An earlier version of this script
  // printed "PROXY ENVIRONMENT IS SET — this alone can produce an unexpected 404" and then reached
  // a verdict about the remote host anyway. In a container behind an allowlisting proxy that verdict
  // was accidentally right for entirely the wrong reason, which is worse than being wrong.
  if (set.filter((v) => /^(HTTPS?_PROXY|https?_proxy|ALL_PROXY)$/.test(v)).length) {
    console.log('  A PROXY IS IN THE REQUEST PATH, so NOTHING here can be attributed to api.sam.gov.');
    console.log('  Whatever answered may be the proxy refusing a host it does not allow. Re-run this');
    console.log('  on a machine with no proxy set before drawing any conclusion about SAM.gov.');
    if (meshSignature.length) {
      console.log('');
      console.log(`  (For the record: ${meshSignature.length} probe(s) answered 404 with an empty body`);
      console.log(`  from "${meshSignature[0].server}" — a service-mesh proxy with no route for this`);
      console.log('  host, which is exactly what an allowlisting proxy looks like.)');
    }
  } else if (!controlsOk) {
    console.log('  OUTBOUND HTTPS IS NOT WORKING from this machine, or both control hosts are down.');
    console.log('  Nothing can be concluded about api.sam.gov from this run. Fix connectivity first.');
  } else if (!anySamConnected) {
    console.log('  api.sam.gov DID NOT CONNECT at all, while the control hosts did. That is DNS,');
    console.log('  TLS or a firewall specific to this host — not a path and not the key.');
  } else if (forbidden.length) {
    console.log(`  ${forbidden.length} keyless request(s) returned 403 — THE ROUTE IS ALIVE AND THE`);
    console.log('  GATEWAY IS REACHABLE. A 403 without a key is the documented behaviour.');
    console.log('');
    console.log('  So the path is right and the problem is THE KEY ITSELF. That makes the');
    console.log('  authenticated 404 genuinely strange, and it is now the thing to take to FSD,');
    console.log('  with this output attached. Before that, two cheap checks:');
    console.log('    · re-read the key from sam.gov (Workspace → Profile → Account Details) and');
    console.log('      re-enter it — a trailing character or a truncated paste is the common cause');
    console.log('    · confirm the key is the "Public API Key" field and not another value');
  } else if (meshSignature.length) {
    // The strongest available signal, and the reason `server` is captured at all.
    console.log(`  EVERY FAILING PROBE WAS ANSWERED BY "${meshSignature[0].server}" WITH AN EMPTY 404.`);
    if (root && root.status === 404 && root.emptyBody) {
      console.log('  Including https://api.sam.gov/ with no path at all.');
    }
    console.log('');
    console.log('  That is a service-mesh proxy with NO ROUTE CONFIGURED for this host. It is not');
    console.log('  the SAM.gov API returning 404 for an unknown path — an API would answer its own');
    console.log('  root with a body, and the documented behaviour for a keyless call is a 403');
    console.log('  carrying "No api_key was supplied". Nothing reached the API.');
    console.log('');
    console.log('  So this is an INTERCEPTION or ROUTING problem between this machine and SAM.gov,');
    console.log('  not a path problem and not a key problem. In order of likelihood:');
    console.log('    · a VPN, corporate proxy or endpoint-security client terminating HTTPS');
    console.log('    · DNS resolving api.sam.gov to something that is not SAM.gov');
    console.log('    · a transparent filtering appliance on the network');
    console.log('');
    console.log('  THE DECISIVE TEST COSTS NOTHING: re-run this from a phone hotspot. A 403 there');
    console.log('  proves the cause is local, and no change to this codebase can fix it.');
  } else if (notFound.length && !headered.length) {
    console.log(`  ${notFound.length} keyless request(s) returned 404 with NO rate-limit headers,`);
    console.log('  while the control hosts answered normally. A request that reached the real');
    console.log('  gateway would carry rate-limit headers and a documented 403, so nothing reached');
    console.log('  the API. The path and the key are both unlikely to be the cause.');
    console.log('  Re-run from a different network before concluding anything about SAM.gov.');
  } else {
    console.log('  Mixed or unexpected result. The per-probe output above is the finding; do not');
    console.log('  generalise from it. Record it as-is and take it to FSD if SAM.gov is implicated.');
  }

  h('WHAT THIS DOES NOT ESTABLISH');
  console.log('  Nothing about whether the key is valid — no key was sent.');
  console.log('  Nothing about the quota — an unauthenticated request is not metered the same way.');
  console.log('  Nothing about SAM.gov registration GW4MAZJHFV44, which remains as stated and');
  console.log('  unverified against the authoritative source.\n');
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => { console.error(`\ndiagnose-sam-reachability: ${e.stack || e.message}`); process.exit(1); });
