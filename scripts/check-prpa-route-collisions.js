#!/usr/bin/env node
// ── NO TWO ROUTERS MAY DECLARE THE SAME PATH ─────────────────────────────────
//
//   node scripts/check-prpa-route-collisions.js
//
// server.js mounts four routers on '/api'. Express gives the request to the FIRST matching handler,
// so a path declared in two routers means the second one's handler NEVER RUNS. There is no error,
// no warning, and no sign of it in a diff: the only symptom is a new endpoint returning the old
// endpoint's data.
//
// This is not hypothetical. src/api/prpa.routes.js was written declaring /prpa/opportunities,
// /prpa/review-queue and /prpa/capabilities — all three of which routes.js already owns and mounts
// earlier. Every handler in the new file for those paths was dead on arrival. The comments in
// server.js warn about exactly this for the two SiteNex routers and for LabConnect; a comment is
// what you read after you have already done it.
//
// Exit status is the verdict: 0 no collisions, 1 at least one.

'use strict';

const fs = require('fs');
const path = require('path');

const repo = path.join(__dirname, '..');

// In mount order, as server.js mounts them. Order matters for the report: the LATER file is the one
// whose handler is dead.
const ROUTERS = [
  'src/api/sitenex-intake.routes.js',
  'src/api/routes.js',
  'src/api/sitenex-phase3.routes.js',
  'src/api/labconnect.routes.js',
  'src/api/prpa.routes.js',
];

// router.get('/x', …) / router.post("/x", …) / router.route('/x')
const DECL = /\brouter\s*\.\s*(get|post|put|patch|delete|all|route)\s*\(\s*(['"`])([^'"`]+)\2/g;

function declarationsIn(rel) {
  const abs = path.join(repo, rel);
  if (!fs.existsSync(abs)) return null;
  const src = fs.readFileSync(abs, 'utf8');
  const out = [];
  let m;
  while ((m = DECL.exec(src)) !== null) {
    const method = m[1].toLowerCase();
    const p = m[3];
    // Line number, for a report somebody can act on.
    const line = src.slice(0, m.index).split('\n').length;
    out.push({ method: method === 'route' || method === 'all' ? '*' : method, path: p, line });
  }
  return out;
}

// Two paths collide when Express would match the same request to both. Parameter NAMES do not
// matter: '/x/:id' and '/x/:oppId' are the same route to the matcher, and comparing the literal
// strings would miss it.
const normalise = (p) => p.replace(/:[A-Za-z0-9_]+/g, ':param').replace(/\/+$/, '') || '/';

const seen = new Map();
const collisions = [];
const missing = [];
let total = 0;

for (const rel of ROUTERS) {
  const decls = declarationsIn(rel);
  if (decls === null) { missing.push(rel); continue; }
  for (const d of decls) {
    total += 1;
    const key = `${d.method} ${normalise(d.path)}`;
    // A wildcard declaration collides with any method on the same path.
    const starKey = `* ${normalise(d.path)}`;
    const hit = seen.get(key) || (d.method === '*' ? null : seen.get(starKey))
      || (d.method === '*' ? [...seen.entries()].find(([k]) => k.endsWith(` ${normalise(d.path)}`)) : null);
    const prior = Array.isArray(hit) ? null : (seen.get(key) || (d.method !== '*' ? seen.get(starKey) : null));
    if (prior) {
      collisions.push({
        path: d.path, method: d.method,
        first: prior, second: { file: rel, line: d.line },
      });
    } else {
      seen.set(key, { file: rel, line: d.line });
    }
  }
}

process.stdout.write(`\ncheck-prpa-route-collisions — ${total} route declaration(s) across ${ROUTERS.length - missing.length} router(s)\n`);
for (const m of missing) process.stdout.write(`  note: ${m} not present (skipped)\n`);
process.stdout.write('\n');

if (!collisions.length) {
  process.stdout.write('PASS  no path is declared in two routers. Every handler is reachable.\n\n');
  process.exit(0);
}

for (const c of collisions) {
  process.stdout.write(`  COLLISION  ${c.method.toUpperCase()} ${c.path}\n`);
  process.stdout.write(`      first (wins): ${c.first.file}:${c.first.line}\n`);
  process.stdout.write(`      second (DEAD): ${c.second.file}:${c.second.line}\n\n`);
}
process.stdout.write(`FAIL  ${collisions.length} path(s) declared twice. The LATER declaration never runs —\n`);
process.stdout.write('      Express hands the request to the first matching handler. Rename the new path\n');
process.stdout.write('      or remove the old one; there is no configuration that makes both reachable.\n\n');
process.exit(1);
