'use strict';
// ── EVERY ROLE IS EITHER ASSIGNED TASKS OR EXPLICITLY EXEMPT ─────────────────
//
// A team member reported that self-assigned tasks "had not worked for a long time". The agent was in
// fact creating 20-30 tasks a day for 7-11 people and had done so for months. Her role,
// `business_dev`, was simply absent from every segment list in orchestrator.js, and those lists are
// allowlists: a role in none of them is never queried, so it raises no error, writes no task, and
// logs the same success line as a good day. She was not failing a check. No check looked at her.
//
// The hole is not the missing entry — it is that a missing entry and a deliberate omission looked
// identical. So coverage is now total: each built-in role appears in a segment, or in EXEMPT_ROLES
// with a written reason. Adding a role to roles.js without deciding which fails here, at commit
// time, rather than becoming another person who quietly receives nothing.

const { SEGMENT_ROLES, EXEMPT_ROLES } = require('./orchestrator');
const { BUILT_IN_ROLES, EXTERNAL_ROLES, isExternalRole } = require('../roles');

const segmentRoles = Object.values(SEGMENT_ROLES).flat();
const covered = new Set(segmentRoles);
const exempt = new Set(Object.keys(EXEMPT_ROLES));

let pass = 0; let fail = 0;
const ok = (cond, label) => { if (cond) { pass += 1; } else { fail += 1; console.error(`  ✗ ${label}`); } };

// 1. Total coverage. The whole point.
const undecided = Object.keys(BUILT_IN_ROLES).filter((r) => !covered.has(r) && !exempt.has(r));
ok(undecided.length === 0,
  `role(s) in no segment and not exempt: ${undecided.join(', ')}. Add each to a list in `
  + `SEGMENT_ROLES (they get daily tasks) or to EXEMPT_ROLES with the reason (they do not). `
  + `Leaving a role out of both means that person is never looked at and never told.`);

// 2. No role is both, which would make the exemption reason a lie.
const both = Object.keys(EXEMPT_ROLES).filter((r) => covered.has(r));
ok(both.length === 0, `role(s) both exempt and in a segment: ${both.join(', ')}`);

// 3. No segment names a role that does not exist — a typo silently covers nobody, which is the
//    original bug wearing a different hat.
const ghosts = segmentRoles.filter((r) => !BUILT_IN_ROLES[r]);
ok(ghosts.length === 0, `segment(s) name non-existent role(s): ${ghosts.join(', ')}`);

// 4. No role is in two segments, which would assign it two sets of tasks a day.
const seen = new Map();
for (const [seg, roles] of Object.entries(SEGMENT_ROLES)) {
  for (const r of roles) {
    if (seen.has(r)) {
      fail += 1;
      console.error(`  ✗ ${r} is in both ${seen.get(r)} and ${seg} — it would be assigned twice daily`);
    } else seen.set(r, seg);
  }
}
if (!seen.size || segmentRoles.length === new Set(segmentRoles).size) pass += 1;

// 5. External roles are never assigned tasks. We do not set a partner's agenda, and a partner is
//    filtered by excludeExternalSql anyway — a segment listing one is a contradiction, not a bug
//    that shows up in behaviour.
const external = segmentRoles.filter((r) => isExternalRole(r));
ok(external.length === 0, `external role(s) in a task segment: ${external.join(', ')}`);
for (const r of EXTERNAL_ROLES) {
  ok(exempt.has(r), `external role ${r} must be listed in EXEMPT_ROLES with its reason`);
}

// 6. An exemption without a reason is an undocumented omission with better manners.
for (const [role, reason] of Object.entries(EXEMPT_ROLES)) {
  ok(typeof reason === 'string' && reason.trim().length >= 20,
    `EXEMPT_ROLES.${role} needs a real reason, not "${reason}"`);
}

// 7. The specific regression. Named, so that removing it is a visible act.
ok(covered.has('business_dev'),
  'business_dev must be assigned tasks — its absence is the reported bug');
ok(covered.has('sales_director'),
  'sales_director must be assigned tasks — a sales director with none was the same hole');

console.log(`task segment coverage: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
