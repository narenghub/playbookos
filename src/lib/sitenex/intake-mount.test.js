// ── THE MOUNT ORDER IS LOAD-BEARING, SO IT IS TESTED ───────────────────────────
//   node --test src/lib/sitenex/intake-mount.test.js
//
// src/api/sitenex-intake.routes.js is mounted in server.js ABOVE the permissions resolver, the
// permissions enforcer and the product boundary. It has to be: all three decide from req.user, there is
// no req.user on a tokenised link, and the boundary fails an unclassifiable route CLOSED — so mounted
// below them, every client we send a link to gets a 403.
//
// That makes this the one router in the application where authentication does not apply, which makes
// TWO facts about server.js worth asserting mechanically rather than trusting to review:
//
//   1. the mount is above all three gates. Moving it below breaks every intake link, silently, with a
//      403 that looks like a permissions problem.
//   2. EVERY PATH IN THAT ROUTER BEGINS WITH /intake. This is the one that would be catastrophic:
//      adding router.get('/sitenex/deals/:id') to that file is a complete authentication bypass on a
//      deal read, and in a diff it looks exactly like adding a route to any other router.
//
// A source-reading test, because the property is about the ORDER OF LINES in server.js and no runtime
// assertion can see it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

// Comments are stripped first. Four source-reading tests in this repo have been broken by prose that
// happened to contain the pattern they scanned for — a `partner_id` in a sentence, an `ORDER BY` in an
// explanation — and the paragraph above this file's code mentions every one of these mounts by name.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
            .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}
const CODE = stripComments(SERVER);
const lineOf = (re, what) => {
  const lines = CODE.split('\n');
  const i = lines.findIndex(l => re.test(l));
  assert.ok(i >= 0, `server.js no longer contains ${what} — this test cannot check an order it cannot find`);
  return i + 1;
};

test('the intake router is mounted ABOVE all three gates', () => {
  const intake = lineOf(/app\.use\(\s*['"]\/api['"]\s*,\s*require\(\s*['"]\.\/src\/api\/sitenex-intake\.routes['"]/, 'the intake mount');
  const shadow = lineOf(/permissions\/shadow['"]\)\.mount\(app\)/, 'the permissions shadow mount');
  const enforce = lineOf(/permissions\/enforce['"]\)\.mount\(app\)/, 'the permissions enforce mount');
  const boundary = lineOf(/productBoundary\(\)/, 'the product boundary mount');

  assert.ok(intake < shadow, `the intake mount (line ${intake}) must come before permissions/shadow (line ${shadow})`);
  assert.ok(intake < enforce, `the intake mount (line ${intake}) must come before permissions/enforce (line ${enforce})`);
  assert.ok(intake < boundary,
    `the intake mount (line ${intake}) must come before the product boundary (line ${boundary}) — ` +
    'below it, /api/intake/* is unclassifiable and the boundary fails closed, 403ing every client link');
});

test('express.json is mounted before it, or POST bodies arrive empty', () => {
  const intake = lineOf(/sitenex-intake\.routes/, 'the intake mount');
  const json = lineOf(/app\.use\(express\.json\(/, 'express.json');
  assert.ok(json < intake, `express.json (line ${json}) must come before the intake mount (line ${intake})`);
});

test('EVERY path declared in the intake router begins with /intake', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/api/sitenex-intake.routes.js'), 'utf8');
  const code = stripComments(src);
  const decls = [...code.matchAll(/router\.(get|post|put|patch|delete|all)\(\s*(['"`])([^'"`]*)\2/g)]
    .map(m => ({ method: m[1].toUpperCase(), path: m[3] }));

  assert.ok(decls.length >= 5, `expected the intake routes to still be here, found ${decls.length}`);
  for (const d of decls) {
    assert.ok(/^\/intake(\/|$)/.test(d.path),
      `${d.method} ${d.path} is declared in the UNAUTHENTICATED router. Every path in that file must ` +
      'start with /intake — anything else is reachable with no login at all.');
  }
});

test('the unauthenticated router does not import an auth or scoping middleware', () => {
  // Not because importing one would be harmful in itself, but because reaching for authMiddleware or
  // partnerScopeSql in there means somebody is building a route that needs a user — which is the exact
  // edit the test above is guarding against, caught one step earlier.
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'src/api/sitenex-intake.routes.js'), 'utf8'));
  for (const name of ['authMiddleware', 'adminOnly', 'requireTier', 'partnerScopeSql', 'productScopeSql', 'req.user']) {
    assert.ok(!code.includes(name),
      `the intake router mentions ${name}. There is no user on a tokenised link — if you need one, ` +
      'the route belongs in sitenex-phase3.routes.js, below the gates.');
  }
});

test('the intake page is served from its own file, not the SPA', () => {
  // index.html calls checkAuth and would bounce a client with no account to a login screen.
  assert.ok(/app\.get\(\s*['"]\/intake['"]/.test(CODE), 'server.js must serve GET /intake explicitly');
  assert.ok(/intake\.html/.test(CODE), 'GET /intake must send public/intake.html, not index.html');
  const intakePage = lineOf(/app\.get\(\s*['"]\/intake['"]/, 'GET /intake');
  const fallback = lineOf(/app\.get\(\s*['"]\*['"]/, 'the SPA fallback');
  assert.ok(intakePage < fallback,
    `GET /intake (line ${intakePage}) must be declared before the SPA fallback (line ${fallback}), ` +
    'or the fallback serves index.html and the client sees a login screen');
  assert.ok(fs.existsSync(path.join(ROOT, 'public/intake.html')), 'public/intake.html must exist');
});

test('the client page reads the token from the fragment and sends it as a header', () => {
  // The whole reason the token is not in the path: a fragment is never sent to a server, so the
  // credential stays out of access logs and out of Referer.
  const page = fs.readFileSync(path.join(ROOT, 'public/intake.html'), 'utf8');
  assert.ok(/location\.hash/.test(page), 'the page must read the token from location.hash');
  assert.ok(/X-Intake-Token/.test(page), 'the page must send the token as the X-Intake-Token header');
  assert.ok(/history\.replaceState/.test(page), 'the page must clear the fragment from the address bar');
  // And the API must accept it from nowhere else.
  const routes = stripComments(fs.readFileSync(path.join(ROOT, 'src/api/sitenex-intake.routes.js'), 'utf8'));
  assert.ok(/req\.get\(\s*['"]X-Intake-Token['"]\s*\)/.test(routes), 'the router must read the header');
  assert.ok(!/req\.params\.token/.test(routes),
    'the router must not accept the token from the path — that puts the credential back into every access log');
  assert.ok(!/req\.query\.token/.test(routes),
    'the router must not accept the token from the query string — same logging problem');
});
