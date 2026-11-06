#!/usr/bin/env node
// ── SSRF GUARD — PROVED BY ATTEMPTING WHAT IT FORBIDS ────────────────────────
//
//   node scripts/check-url-guard.js
//
// No network for the shape checks. The DNS-dependent assertions resolve real public names and are
// skipped — loudly, and without counting as passes — if this environment has no resolver.
//
// There is deliberately NO test-only bypass in the guard, so the fetch path is exercised by
// testing validateHop directly rather than by standing up a local server and waiving the rule for
// it. An escape hatch in an SSRF guard is the vulnerability.
'use strict';

const G = require('../src/lib/office/url-guard');

let pass = 0; let fail = 0; let skipped = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 260)}`); };
const skip = (m) => { skipped++; console.log(`  SKIP  ${m}`); };
const bar = () => '─'.repeat(78);
const h = (t) => console.log(`\n${bar()}\n${t}\n${bar()}`);

const refused = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const refusedAsync = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

h('1. SCHEMES: HTTPS ONLY');
for (const [u, why] of [
  ['http://sam.gov/x.pdf', 'plaintext'],
  ['file:///etc/passwd', 'local file'],
  ['ftp://sam.gov/x.pdf', 'ftp'],
  ['gopher://sam.gov/1', 'gopher — the classic SSRF protocol smuggling vector'],
  ['data:text/html,<script>', 'data URI'],
  ['javascript:alert(1)', 'javascript'],
  ['jar:https://sam.gov/x!/y', 'jar'],
  ['HTTP://SAM.GOV/x.pdf', 'uppercase http is still http'],
]) {
  const e = refused(() => G.validateUrlShape(u));
  if (e && e.code === 'scheme') ok(`${why} → REFUSED`);
  else bad(`${why} was accepted`, e ? `wrong code ${e.code}: ${e.message}` : 'accepted');
}
if (!refused(() => G.validateUrlShape('https://sam.gov/opp/x.pdf'))) ok('a plain https URL IS accepted — this is a gate, not a wall');
else bad('a legitimate https URL was refused');

h('2. THE METADATA ENDPOINT AND EVERY PRIVATE RANGE, AS LITERALS');
for (const [ip, why] of [
  ['169.254.169.254', 'the cloud metadata endpoint'],
  ['127.0.0.1', 'loopback'],
  ['0.0.0.0', 'unspecified'],
  ['10.1.2.3', 'RFC1918 /8'],
  ['172.16.5.5', 'RFC1918 /12'],
  ['172.31.255.254', 'RFC1918 /12 upper edge'],
  ['192.168.1.1', 'RFC1918 /16'],
  ['100.100.1.1', 'carrier-grade NAT'],
  ['198.18.0.1', 'benchmarking'],
  ['224.0.0.1', 'multicast'],
  ['255.255.255.255', 'broadcast'],
]) {
  const e = refused(() => G.validateUrlShape(`https://${ip}/x.pdf`));
  if (e && e.code === 'blocked_ip') ok(`${ip} — ${why} → REFUSED`);
  else bad(`${ip} (${why}) was accepted`, e ? `${e.code}: ${e.message}` : 'accepted');
}
// Boundaries, because an off-by-one in a CIDR mask is the whole bug.
for (const [ip, expect, why] of [
  ['172.15.255.255', false, 'just below 172.16/12'],
  ['172.32.0.0', false, 'just above 172.16/12'],
  ['11.0.0.0', false, 'just above 10/8'],
  ['9.255.255.255', false, 'just below 10/8'],
  ['100.63.255.255', false, 'just below CGNAT'],
  ['100.128.0.0', false, 'just above CGNAT'],
  ['169.253.255.255', false, 'just below link-local'],
  ['169.255.0.0', false, 'just above link-local'],
]) {
  const r = G.blockedReason(ip);
  if ((r !== null) === expect) ok(`${ip} (${why}) → ${r ? 'blocked' : 'allowed'}, as intended`);
  else bad(`${ip} (${why}) was ${r ? 'blocked' : 'allowed'} — a CIDR mask is off by one`, r);
}

h('3. IPv6, INCLUDING THE IPv4-MAPPED FORMS A NAIVE CHECK MISSES');
for (const [ip, why] of [
  ['[::1]', 'loopback'],
  ['[::]', 'unspecified'],
  ['[::ffff:127.0.0.1]', 'IPv4-mapped loopback'],
  ['[::ffff:169.254.169.254]', 'IPv4-mapped metadata endpoint'],
  ['[::ffff:10.0.0.1]', 'IPv4-mapped RFC1918'],
  ['[::127.0.0.1]', 'IPv4-compatible loopback'],
  ['[fd00::1]', 'unique local'],
  ['[fe80::1]', 'link-local'],
  ['[ff02::1]', 'multicast'],
  ['[2002:c0a8:0101::1]', '6to4'],
  ['[64:ff9b::7f00:1]', 'NAT64'],
]) {
  const e = refused(() => G.validateUrlShape(`https://${ip}/x.pdf`));
  if (e && e.code === 'blocked_ip') ok(`${ip} — ${why} → REFUSED`);
  else bad(`${ip} (${why}) was accepted`, e ? `${e.code}: ${e.message}` : 'accepted');
}
if (G.blockedReason('[::ffff:8.8.8.8]'.replace(/[[\]]/g, '')) === null) {
  ok('an IPv4-mapped PUBLIC address is not blocked — the unwrapping judges the address, not the form');
} else bad('a mapped public address was blocked');

h('4. INTERNAL NAMES, CREDENTIALS, PORTS AND MALFORMED INPUT');
for (const [u, code, why] of [
  ['https://postgres/x', 'internal_name', 'a dotless name can only be internal'],
  ['https://metadata/x', 'internal_name', 'the metadata alias'],
  ['https://localhost/x', 'internal_name', 'localhost'],
  ['https://db.railway.internal/x', 'internal_name', "Railway's internal namespace"],
  ['https://thing.local/x', 'internal_name', 'mDNS .local'],
  ['https://x.internal/x', 'internal_name', '.internal'],
  ['https://user:pw@sam.gov/x', 'credentials', 'embedded credentials'],
  ['https://sam.gov:8080/x', 'port', 'a non-443 port'],
  ['https://sam.gov:22/x', 'port', 'ssh port'],
  ['', 'empty', 'an empty string'],
  ['h', 'unparseable', 'not a URL at all'],
  ['not a url', 'control_chars', 'spaces in a URL'],
  ['https://sam.gov/\u0000', 'control_chars', 'a NUL byte'],
  ['https://sam.gov/ x', 'control_chars', 'a space'],
  [`https://sam.gov/${'a'.repeat(2100)}`, 'too_long', 'an absurdly long URL'],
]) {
  const e = refused(() => G.validateUrlShape(u));
  if (e && e.code === code) ok(`${why} → REFUSED (${code})`);
  else bad(`${why} was not refused as ${code}`, e ? `${e.code}: ${e.message}` : 'accepted');
}

h('5. A NAME IS NOT A DESTINATION — RESOLUTION IS CHECKED, NOT THE STRING');
(async () => {
  // These need a resolver. If there is none, they SKIP and are not counted as passes.
  const probe = await refusedAsync(() => G.resolveAndCheck('sam.gov'));
  const noResolver = probe && probe.code === 'dns';
  if (noResolver) {
    skip('no DNS in this environment — the resolution assertions asserted NOTHING');
  } else {
    if (!probe) ok('a real public name resolves and every address passes');
    else bad('a public name was refused', probe.message);

    // A name that resolves into a private range must be refused at resolution, not at the string.
    // localtest.me and similar public names resolve to 127.0.0.1 by design.
    for (const name of ['localtest.me', 'localhost.localtest.me']) {
      const e = await refusedAsync(() => G.resolveAndCheck(name));
      if (e && e.code === 'blocked_ip') ok(`${name} resolves into a blocked range → REFUSED at resolution`);
      else if (e && e.code === 'dns') skip(`${name} did not resolve here`);
      else bad(`${name} was accepted despite resolving privately`, e ? e.message : 'accepted');
    }
    const nx = await refusedAsync(() => G.resolveAndCheck('this-name-should-not-exist-9f3a2b.example'));
    if (nx && nx.code === 'dns') ok('an unresolvable name → REFUSED, not treated as reachable');
    else bad('an unresolvable name was accepted', nx ? nx.message : 'accepted');
  }

  h('6. EVERY REDIRECT HOP IS RE-VALIDATED, NOT JUST THE PASTED URL');
  // validateHop is the function the fetch loop calls on each hop. Testing it directly is how the
  // redirect protection is proved without adding a bypass to let a local server participate.
  for (const [u, why] of [
    ['https://169.254.169.254/latest/meta-data/', 'a 302 to the metadata endpoint'],
    ['https://127.0.0.1:443/admin', 'a 302 to loopback'],
    ['http://sam.gov/x', 'a 302 downgrading to plaintext'],
    ['file:///etc/passwd', 'a 302 to a local file'],
  ]) {
    const e = await refusedAsync(() => G.validateHop(u));
    if (e) ok(`${why} → REFUSED at the hop`);
    else bad(`${why} passed hop validation`, 'accepted');
  }
  if (G.MAX_REDIRECTS <= 5) ok(`the redirect cap is ${G.MAX_REDIRECTS}`);
  else bad(`the redirect cap is ${G.MAX_REDIRECTS}, which is too generous`);

  h('7. CAPS');
  if (G.MAX_BYTES === 50 * 1024 * 1024) ok('the size cap matches the schema byte_size cap (50 MB)');
  else bad(`size cap is ${G.MAX_BYTES}, which disagrees with the schema`);
  if (G.TIMEOUT_MS > 0 && G.TIMEOUT_MS <= 30000) ok(`the timeout is ${G.TIMEOUT_MS}ms`);
  else bad(`the timeout is ${G.TIMEOUT_MS}ms`);
  if (G.ALLOWED_SCHEMES.length === 1 && G.ALLOWED_SCHEMES[0] === 'https:') ok('exactly one permitted scheme');
  else bad('the scheme allowlist has grown', G.ALLOWED_SCHEMES.join(','));

  h('8. THERE IS NO WAY TO TURN THE GUARD OFF');
  // The failure this prevents is the one already found once in this codebase: a flag that
  // overrides a safety check, added for a test and then available in production.
  // Comments stripped first. The first run of this check failed on the word "bypass" appearing in
  // the guard's own explanation of why it has no bypass, which is a false positive that would have
  // trained someone to loosen the pattern.
  const raw = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'lib', 'office', 'url-guard.js'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const hatches = [/allowPrivate/, /allowLocalhost/, /skipSsrf/, /ALLOW_PRIVATE/, /process\.env\.[A-Z_]*ALLOW/, /unsafe/i, /bypass/i];
  const found = hatches.filter((re) => re.test(src));
  if (!found.length) ok('no bypass flag, no permissive environment variable, no "unsafe" option');
  else bad('the guard contains an escape hatch', found.map(String).join(' '));

  console.log(`\n${bar()}`);
  console.log(`  ${pass} assertion(s) passed · ${fail} failed · ${skipped} skipped`);
  if (fail) { console.log('\nFAIL  the SSRF guard does not hold as claimed.\n'); process.exit(1); }
  if (skipped) console.log(`\n  ${skipped} assertion(s) did not run and proved nothing.`);
  console.log('\nPASS  the metadata endpoint, every private range, internal names, downgrades and');
  console.log('      redirects into any of them are all refused — and there is no flag to turn it off.\n');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
