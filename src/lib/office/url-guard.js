// ── SSRF GUARD FOR MANUAL SOLICITATION INTAKE ────────────────────────────────
//
// Ruling 14 allowed intake "from public URLs … with authorized access and full provenance."
// Ruling 19 item 6 asks for the protections. This is them.
//
// The threat is not a malicious solicitation. It is that a human pastes a URL and this server
// fetches it. The server sits inside a network with a Postgres instance, a Railway internal DNS
// namespace, and — if this ever runs on a cloud instance — a metadata endpoint that hands out
// credentials to anything that asks. A URL field that performs a server-side GET is a request
// forgery primitive unless every one of those is closed.
//
// ── DESIGN, AND WHY IT IS SHAPED THIS WAY ────────────────────────────────────
//
// 1. ALLOWLIST THE SCHEME. https only. Not http — a plaintext fetch of a government solicitation
//    can be rewritten in flight, and the document's bytes are the evidence a requirement match is
//    later justified by. Not file:, not gopher:, not data:, not ftp:.
//
// 2. RESOLVE DNS *BEFORE* CONNECTING, AND CHECK EVERY ADDRESS. A name is not a destination.
//    `internal.example.com` can resolve to 10.0.0.5, and a hostname allowlist would never know.
//
// 3. PIN THE RESOLVED ADDRESS. Validating a name and then asking the HTTP client to resolve it
//    again is a DNS-rebinding hole: the second lookup can return a different answer. So the
//    connection is made to the address that was checked, with the original Host header.
//
// 4. RE-VALIDATE EVERY REDIRECT HOP. A public URL that 302s to 169.254.169.254 defeats any check
//    performed only on the URL the human pasted. Redirects are followed manually, each hop through
//    the full validation, with a hop cap.
//
// 5. CAP SIZE AND TIME, AND ENFORCE THE SIZE WHILE STREAMING. A Content-Length header is a claim.
//    The cap is applied to bytes actually received, so a lying header or a chunked response that
//    never ends cannot exhaust memory.
//
// 6. NO TEST-ONLY BYPASS. There is deliberately no option to permit localhost or a private range,
//    not even for tests. An escape hatch in an SSRF guard is the vulnerability — the first thing
//    an attacker looks for is the flag that turns the guard off, and the second is the environment
//    variable that sets it. The fetch path is therefore tested by unit-testing the hop validator
//    directly rather than by standing up a local server and waiving the rule for it.
'use strict';

const dns = require('dns').promises;
const net = require('net');
const https = require('https');

const MAX_REDIRECTS = 5;
const MAX_BYTES = 50 * 1024 * 1024;        // matches the schema's byte_size cap
const TIMEOUT_MS = 20000;

class UrlRefused extends Error {
  constructor(msg, code) { super(msg); this.name = 'UrlRefused'; this.code = code || 'refused'; }
}

const ALLOWED_SCHEMES = Object.freeze(['https:']);

// ── IPv4 ranges that must never be reached ───────────────────────────────────
// Each is here for a reason, not for completeness: link-local carries the cloud metadata endpoint,
// CGNAT and the private ranges carry internal services, and the documentation and benchmark ranges
// are included because a guard that lets through "harmless" ranges invites argument about which
// ones those are.
const V4_BLOCKED = [
  ['0.0.0.0', 8, 'this host / unspecified'],
  ['10.0.0.0', 8, 'private (RFC1918)'],
  ['100.64.0.0', 10, 'carrier-grade NAT (RFC6598)'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local — the cloud metadata endpoint lives here'],
  ['172.16.0.0', 12, 'private (RFC1918)'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'documentation (TEST-NET-1)'],
  ['192.88.99.0', 24, '6to4 relay anycast'],
  ['192.168.0.0', 16, 'private (RFC1918)'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation (TEST-NET-2)'],
  ['203.0.113.0', 24, 'documentation (TEST-NET-3)'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

const v4ToInt = (ip) => ip.split('.').reduce((a, o) => ((a << 8) >>> 0) + Number(o), 0) >>> 0;

function v4Reason(ip) {
  const n = v4ToInt(ip);
  for (const [base, bits, why] of V4_BLOCKED) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((n & mask) === (v4ToInt(base) & mask)) return why;
  }
  if (ip === '255.255.255.255') return 'broadcast';
  return null;
}

// Expand an IPv6 address to its eight 16-bit groups. Needed because the textual form cannot be
// pattern-matched reliably: Node's URL parser REWRITES ::ffff:127.0.0.1 into ::ffff:7f00:1, so a
// regex looking for dotted quads inside an IPv6 literal matches nothing. The first version of this
// file had exactly that bug and accepted the metadata endpoint written as [::ffff:169.254.169.254].
// Its own test caught it. Compare numerically, never textually.
function v6Groups(ip) {
  let a = ip.toLowerCase();
  // A trailing dotted quad (either form) becomes two groups.
  const quad = a.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (quad) {
    const o = quad[1].split('.').map(Number);
    if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    a = a.slice(0, -quad[1].length)
      + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':').filter((x) => x !== '') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':').filter((x) => x !== '') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const out = groups.map((g) => parseInt(g, 16));
  return out.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff) ? null : out;
}

function v6Reason(ip) {
  const a = ip.toLowerCase();
  const g = v6Groups(a);
  if (g) {
    // ::ffff:0:0/96 is IPv4-mapped; ::/96 with a non-zero low word is IPv4-compatible. Both carry
    // an IPv4 address in the low 32 bits and must be judged as that address.
    const highZero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
    const low = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
    if (highZero && g[5] === 0xffff) {
      const why = v4Reason(low);
      return why ? `IPv4-mapped ${low} — ${why}` : null;
    }
    if (highZero && g[5] === 0 && (g[6] !== 0 || g[7] > 1)) {
      const why = v4Reason(low);
      return why ? `IPv4-compatible ${low} — ${why}` : null;
    }
  }
  if (a === '::1') return 'loopback';
  if (a === '::') return 'unspecified';
  if (/^f[cd]/.test(a)) return 'unique local (fc00::/7)';
  if (/^fe[89ab]/.test(a)) return 'link-local (fe80::/10)';
  if (/^fec/.test(a)) return 'site-local (deprecated)';
  if (/^ff/.test(a)) return 'multicast';
  if (a.startsWith('2002:')) return '6to4';
  if (a.startsWith('64:ff9b:')) return 'NAT64';
  if (a.startsWith('100:')) return 'discard-only (RFC6666)';
  return null;
}

/** Why this address must not be reached, or null if it is fine. */
function blockedReason(ip) {
  const v = net.isIP(ip);
  if (v === 4) return v4Reason(ip);
  if (v === 6) return v6Reason(ip);
  return 'not a recognisable IP address';
}

/**
 * Validate the URL itself — everything decidable without a network. Throws UrlRefused.
 * Returns the parsed URL.
 */
function validateUrlShape(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new UrlRefused('no URL given', 'empty');
  if (raw.length > 2048) throw new UrlRefused('URL is implausibly long', 'too_long');
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) {
    throw new UrlRefused('URL contains whitespace or control characters', 'control_chars');
  }
  let u;
  try { u = new URL(raw); } catch (e) { throw new UrlRefused(`not a URL: ${e.message}`, 'unparseable'); }

  if (!ALLOWED_SCHEMES.includes(u.protocol)) {
    throw new UrlRefused(
      `scheme "${u.protocol}" is not permitted; only https. A plaintext fetch can be rewritten in `
      + 'flight, and these bytes are the evidence a requirement match is later justified by.',
      'scheme');
  }
  if (u.username || u.password) {
    throw new UrlRefused('URL carries embedded credentials', 'credentials');
  }
  if (u.port && u.port !== '443') {
    throw new UrlRefused(`port ${u.port} is not permitted; only 443`, 'port');
  }
  if (!u.hostname) throw new UrlRefused('URL has no host', 'no_host');

  // A bare IP literal skips DNS, so judge it here too. An IPv6 literal arrives bracketed.
  const literal = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(literal)) {
    const why = blockedReason(literal);
    if (why) throw new UrlRefused(`refusing ${literal}: ${why}`, 'blocked_ip');
  }
  // Names with no dot are internal by construction: `postgres`, `metadata`, a Railway service name.
  if (!net.isIP(literal) && !literal.includes('.')) {
    throw new UrlRefused(
      `host "${literal}" has no dot, so it can only be an internal name`, 'internal_name');
  }
  if (/\.(local|internal|localdomain|localhost)$/i.test(literal) || /^localhost$/i.test(literal)) {
    throw new UrlRefused(`host "${literal}" is an internal namespace`, 'internal_name');
  }
  if (/\.railway\.internal$/i.test(literal)) {
    throw new UrlRefused(`host "${literal}" is Railway's internal namespace`, 'internal_name');
  }
  return u;
}

/**
 * Resolve the host and require EVERY address to be acceptable. Returns the addresses, so the
 * caller can connect to one that was actually checked rather than resolving again.
 */
async function resolveAndCheck(hostname) {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(bare)) return [{ address: bare, family: net.isIP(bare) }];

  let addrs;
  try {
    addrs = await dns.lookup(bare, { all: true, verbatim: true });
  } catch (e) {
    throw new UrlRefused(`cannot resolve "${bare}": ${e.code || e.message}`, 'dns');
  }
  if (!addrs.length) throw new UrlRefused(`"${bare}" resolved to nothing`, 'dns');

  // EVERY address, not the first. A name that resolves to one public and one private address is
  // not safe to fetch: which one the connection uses is not ours to decide.
  for (const a of addrs) {
    const why = blockedReason(a.address);
    if (why) {
      throw new UrlRefused(
        `"${bare}" resolves to ${a.address}, which is ${why}. A name is not a destination.`,
        'blocked_ip');
    }
  }
  return addrs;
}

/**
 * Validate one hop. Used for the pasted URL and again for every redirect target, which is the
 * point: a check performed only on what the human typed is defeated by a 302.
 */
async function validateHop(raw) {
  const url = validateUrlShape(raw);
  const addresses = await resolveAndCheck(url.hostname);
  return { url, addresses };
}

/**
 * Fetch a solicitation document. Returns { buffer, finalUrl, contentType, hops }.
 * Every hop is validated, the connection is pinned to a checked address, and the size cap is
 * enforced against bytes received rather than against a header.
 */
async function fetchDocument(raw, opts = {}) {
  const maxBytes = opts.maxBytes || MAX_BYTES;
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
  const hops = [];
  let target = raw;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const { url, addresses } = await validateHop(target);
    hops.push(url.toString());

    const pinned = addresses[0];
    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        // Connect to the address we checked; send the real Host so TLS and vhosts still work.
        host: pinned.address,
        servername: url.hostname,          // SNI must be the name, not the pinned address
        headers: { Host: url.hostname, 'User-Agent': 'PlaybookOS-intake/1.0', Accept: '*/*' },
        path: `${url.pathname}${url.search}`,
        port: 443,
        method: opts.method || 'GET',
        timeout: timeoutMs,
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          if (!res.headers.location) return reject(new UrlRefused(`${res.statusCode} with no Location`, 'bad_redirect'));
          // Resolved against the current URL, then fully re-validated on the next iteration.
          return resolve({ redirect: new URL(res.headers.location, url).toString() });
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new UrlRefused(`HTTP ${res.statusCode}`, 'http_status'));
        }
        const chunks = []; let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            return reject(new UrlRefused(
              `response exceeded ${maxBytes} bytes. Enforced on bytes received, because a `
              + 'Content-Length header is a claim.', 'too_large'));
          }
          chunks.push(c);
          return undefined;
        });
        res.on('end', () => resolve({
          buffer: Buffer.concat(chunks),
          contentType: res.headers['content-type'] || null,
        }));
        res.on('error', reject);
        return undefined;
      });
      req.on('timeout', () => { req.destroy(); reject(new UrlRefused(`no response within ${timeoutMs}ms`, 'timeout')); });
      req.on('error', (e) => reject(new UrlRefused(`request failed: ${e.message}`, 'network')));
      req.end();
    });

    if (result.redirect) { target = result.redirect; continue; }
    return { ...result, finalUrl: hops[hops.length - 1], hops };
  }
  throw new UrlRefused(`more than ${MAX_REDIRECTS} redirects`, 'too_many_redirects');
}

module.exports = {
  UrlRefused,
  MAX_REDIRECTS,
  MAX_BYTES,
  TIMEOUT_MS,
  ALLOWED_SCHEMES,
  V4_BLOCKED,
  v6Groups,
  blockedReason,
  validateUrlShape,
  resolveAndCheck,
  validateHop,
  fetchDocument,
};
