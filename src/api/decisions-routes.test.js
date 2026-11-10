// ── THE DECISION QUEUE'S SURFACE ─────────────────────────────────────────────
//
//   node --test src/api/decisions-routes.test.js
//
// Two things about this router must stay true, and neither is visible from reading one file.
//
//   1. IT IS READ-ONLY. The queue aggregates decisions that sit behind the approval gate, the
//      global email HOLD and three capability STOPs. Those guards live on the execution paths. A
//      write route here would be a second door into them, and release() — the one narrow path from
//      an approved row to an external action — is narrow on purpose.
//
//   2. ITS NAV ENTRY AND ITS ROUTE AGREE. The route is adminOnly because it crosses tiers by
//      construction. The sidebar is built from a separate list in public/index.html, and nothing
//      but a check connects the two: a nav entry drawn for a role the route refuses is a button
//      whose only outcome is a 403.
//
// The route assertions inspect the Express router's own stack rather than the file's text. Five
// source-scanning tests in this repository have passed while matching the wrong line; a router's
// stack cannot be matched wrongly.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'preflight';

const router = require('./decisions.routes');

// The admin-only gate as it actually sits in passesPageReads: the page list, where the check is,
// and where the admin short-circuit is. Read from the function body because that is where it lives.
function navAdminGate() {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
  const fn = html.slice(html.indexOf('function passesPageReads(pageId, role, tiers) {'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const m = body.match(/if \(\[([^\]]*)\]\.indexOf\(pageId\) !== -1\) return role === 'admin'/);
  return {
    pages: m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [],
    at: m ? body.indexOf(m[0]) : -1,
    shortCircuit: body.indexOf("role === 'admin' || role === 'super_admin') return true"),
  };
}

function layers() {
  return router.stack.filter((l) => l.route).map((l) => ({
    path: l.route.path,
    methods: Object.keys(l.route.methods).filter((m) => l.route.methods[m]),
    handlers: l.route.stack.map((h) => h.name),
  }));
}

test('the router declares exactly one route', () => {
  const ls = layers();
  assert.strictEqual(ls.length, 1, `expected one route, found: ${ls.map((l) => l.path).join(', ')}`);
  assert.strictEqual(ls[0].path, '/decisions');
});

test('it is a GET, and there is no write verb anywhere on it', () => {
  const ls = layers();
  assert.deepStrictEqual(ls[0].methods, ['get']);
  for (const l of ls) {
    for (const m of ['post', 'put', 'patch', 'delete']) {
      assert.ok(!l.methods.includes(m),
        `${l.path} accepts ${m.toUpperCase()}. This queue is a view: every decision is made on the `
        + `page named in \`where\`, behind that page's own guards.`);
    }
  }
});

test('the chain carries authMiddleware and adminOnly, in that order', () => {
  // adminOnly reads req.user, which authMiddleware sets. Listed explicitly on the chain, because
  // server.js mounts authMiddleware NOWHERE globally — a comment claiming otherwise is what hid a
  // total outage of the PRPA router for the life of that feature.
  const h = layers()[0].handlers;
  assert.ok(h.includes('authMiddleware'), `authMiddleware is not on the chain: ${h.join(' → ')}`);
  assert.ok(h.includes('adminOnly'), `adminOnly is not on the chain: ${h.join(' → ')}`);
  assert.ok(h.indexOf('authMiddleware') < h.indexOf('adminOnly'),
    'adminOnly runs before authMiddleware, so req.user would be undefined');
  assert.ok(h.includes('resolveCompany'),
    'the company is not resolved, so a company-welded query would run unscoped');
});

test('the company is resolved by the kernel, never from the request and never by default', () => {
  // Two different mistakes are guarded here.
  //
  // A company_id read off the request would let one staff account read another company's held
  // actions by changing a parameter. A SLUG DEFAULT would be worse in a quieter way: there is no
  // user-to-company mapping in this system, so resolveCompanyForReadSession REFUSES when two active
  // companies exist rather than showing a person a tenant that may not be theirs. A default answers
  // that question by guessing, and goes on guessing silently on the day a second company appears.
  // The first version of this file had the slug default, copied from prpa.routes.js.
  const src = fs.readFileSync(path.join(__dirname, 'decisions.routes.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function resolveCompany'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(!/req\.(query|body|params)\s*(\.|\[)\s*['"]?company/i.test(body),
    'resolveCompany reads a company identifier off the request');
  assert.match(body, /resolveCompanyForReadSession/,
    'the company is not resolved through the kernel read-session resolver');
  assert.ok(!/PRPA_COMPANY_SLUG|FROM companies/.test(body),
    'resolveCompany resolves the company itself — by slug or by its own query — instead of '
    + 'deferring to the resolver that refuses an ambiguous tenancy');
});

test('the kernel accessor is what reaches office_approvals', () => {
  // Every predicate on a kernel table lives in src/lib/office/scope.js. The route injects the
  // accessor; neither this file nor decision-sources.js may name the table.
  const route = fs.readFileSync(path.join(__dirname, 'decisions.routes.js'), 'utf8');
  const sources = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'office', 'decision-sources.js'), 'utf8');
  assert.match(route, /listPendingApprovals:\s*SCOPE\.listPendingApprovals/,
    'the route does not inject the kernel accessor');
  for (const [name, src] of [['decisions.routes.js', route], ['decision-sources.js', sources]]) {
    assert.ok(!/FROM\s+office_approvals/i.test(src), `${name} names a kernel table in SQL`);
  }
});

test('the nav entry and the route agree on who may see this page', () => {
  // The nav is built from NAV_ADMIN_ONLY in public/index.html; the route is gated by adminOnly
  // here. If either changes alone, a role is shown a button that 403s — or, worse, the route is
  // widened and the nav keeps the page hidden, so the widening is invisible.
  const gate = navAdminGate();
  assert.ok(gate.pages.includes('decisions'),
    `'decisions' is not in the admin-only gate inside passesPageReads (${gate.pages.join(', ') || 'empty'}), `
    + 'so the sidebar would draw it for a director while the route answers 403');

  assert.ok(layers()[0].handlers.includes('adminOnly'),
    'the nav hides this page from non-admins but the route no longer requires an admin');
});

test('the admin-only gate is checked BEFORE the admin short-circuit', () => {
  // passesPageReads returns true for admins near the top. A narrowing check placed after that
  // still works for admins and silently does nothing for everybody else — the whole population it
  // exists to narrow.
  const gate = navAdminGate();
  assert.ok(gate.at !== -1, 'the admin-only gate is not inside passesPageReads');
  assert.ok(gate.at < gate.shortCircuit,
    'the admin-only gate runs after the admin short-circuit, so it narrows nothing');
});

test('the gate lives INSIDE passesPageReads, not beside it', () => {
  // It was a module-level `const NAV_ADMIN_ONLY` first. Five harnesses sandbox the nav by grabbing
  // a hand-written list of declarations out of index.html, and every one of them threw
  // ReferenceError — as would the next one written. Inside the function body it travels with the
  // function all of them already grab.
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
  assert.ok(!/^\s*const NAV_ADMIN_ONLY\b/m.test(html),
    'the gate is a module-level declaration again, which every nav harness has to be taught about '
    + 'separately — put the list inside passesPageReads');
});

test('the page function is reachable from an inline onclick', () => {
  // Annex B hoists a plain `function` out of a block but NOT an `async function`. Every handler
  // this page wires into markup must be on `window`, or the click throws ReferenceError and does
  // nothing visible — which is how production rendered an empty SPA on 2026-09-30.
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
  for (const name of ['decisionsPage', 'dqKind', 'dqGo', 'dqEsc']) {
    assert.match(html, new RegExp(`window\\.${name}\\s*=`),
      `${name} is used from markup but is not assigned to window`);
  }
  assert.match(html, /pages\['decisions'\]\s*=\s*window\.decisionsPage/,
    "pages['decisions'] is not attached, so navigate('decisions') would find nothing");
});
