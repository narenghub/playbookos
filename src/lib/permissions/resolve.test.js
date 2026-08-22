// Resolver precedence tests — run with:  node --test src/lib/permissions/resolve.test.js
// No live DB: user fields are passed inline and overrides are injected via deps.overrides,
// so gatherContext() never touches Postgres.

const { test } = require('node:test');
const assert = require('node:assert');
const { resolve, resolveAll, resolveNav } = require('./resolve');
const { FEATURES } = require('./registry');

const ENV_ON = { RESEARCH_INTEL_ENABLED: 'true' };
const ENV_OFF = { RESEARCH_INTEL_ENABLED: 'false' };
const user = (role, extra = {}) => ({ id: 'u1', role, is_active: 1, permissions_version: 1, ...extra });
const ov = (feature_key, effect, expires_at = null, reason) => ({ feature_key, effect, expires_at, reason });

// concrete fixtures (verified against the registry/templates)
const F = {
  orders: 'revenue.orders.list',                                        // account_manager holds this — but via rule 6 (revenue page implies it)
  ordersCreate: 'revenue.orders.create',                                // template-granted (revenue:rw write), NOT implied by any page -> clean rule 7
  cdiView: 'intelligence.page_clinical_demand_intelligence.view',       // nav_page, defaultDeny:false
  findContacts: 'intelligence.research_intelligence_studies.find_contacts', // defaultDeny:true + env-gated
  riRun: 'intelligence.research_intelligence.run',                      // env-gated
  procPage: 'procurement.page_procurement_agent.view',                  // implies dashboard/rfqs/suppliers (NOT compare)
  procDash: 'procurement.procurement_dashboard.list',                   // implied free read
  procCompare: 'procurement.procurement_compare.get',                   // spend read — excluded from page implies
  dashPage: 'revenue.page_dashboard.view',                             // implies summary + tasks_my (NOT agent/overview)
  agentOverview: 'admin.agent_overview.list',                          // adminOnly read — excluded from page implies
  myTasks: 'personal.page_my_tasks.view',
};

test('T1 — deny override beats allow override on same feature (rule 4 > 5)', async () => {
  const r = await resolve(user('account_manager'), F.orders, {
    env: ENV_ON, overrides: [ov(F.orders, 'allow'), ov(F.orders, 'deny')],
  });
  assert.equal(r.allowed, false);
  assert.equal(r.rule, 4);
});

test('T2 — deny override beats a template grant', async () => {
  const r = await resolve(user('account_manager'), F.orders, { env: ENV_ON, overrides: [ov(F.orders, 'deny')] });
  assert.equal(r.allowed, false);
  assert.equal(r.rule, 4);
});

test('T3 — deny override beats an implies grant', async () => {
  // page allow would grant procDash via rule 6; a deny override on procDash must still win.
  const r = await resolve(user('recruitment_team'), F.procDash, {
    env: ENV_ON, overrides: [ov(F.procPage, 'allow'), ov(F.procDash, 'deny')],
  });
  assert.equal(r.allowed, false);
  assert.equal(r.rule, 4);
});

test('T4 — env flag off beats an explicit user allow (rule 2 > 5)', async () => {
  const r = await resolve(user('admin'), F.riRun, { env: ENV_OFF, overrides: [ov(F.riRun, 'allow')] });
  assert.equal(r.allowed, false);
  assert.equal(r.rule, 2);
});

test('T5 — expired override is ignored, falls through to template (rule 7)', async () => {
  // ordersCreate is a template grant that no page implies, so falling through lands on rule 7.
  const past = new Date(Date.now() - 3600e3).toISOString();
  const r = await resolve(user('account_manager'), F.ordersCreate, { env: ENV_ON, overrides: [ov(F.ordersCreate, 'deny', past)] });
  assert.equal(r.allowed, true);
  assert.equal(r.rule, 7);
});

test('T6 — page grant implies its free reads (rule 6)', async () => {
  // recruitment_team lacks the procurement tier, so procDash is NOT in its template.
  // Granting the page must make procDash reachable via implies, and via rule 6 specifically.
  const r = await resolve(user('recruitment_team'), F.procDash, { env: ENV_ON, overrides: [ov(F.procPage, 'allow')] });
  assert.equal(r.allowed, true);
  assert.equal(r.rule, 6);
});

test('T7 — page grant does NOT imply a spend action or an adminOnly read', async () => {
  // spend read (procurement compare = llm) is excluded from the page's implies
  const rSpend = await resolve(user('recruitment_team'), F.procCompare, { env: ENV_ON, overrides: [ov(F.procPage, 'allow')] });
  assert.equal(rSpend.allowed, false);
  // adminOnly read (agent/overview) is excluded from the dashboard page's implies
  const rAdmin = await resolve(user('recruitment_team'), F.agentOverview, { env: ENV_ON, overrides: [ov(F.dashPage, 'allow')] });
  assert.equal(rAdmin.allowed, false);
});

test('T8 — defaultDeny feature is NOT granted by template even when reachable today', async () => {
  // business_dev reaches find-contacts (intelligence:rw) but it is defaultDeny -> not in grants.
  const r = await resolve(user('business_dev'), F.findContacts, { env: ENV_ON, overrides: [] });
  assert.equal(r.allowed, false);
  assert.equal(r.rule, 8);
});

test('T9 — inactive user is denied everything (rule 3)', async () => {
  const r = await resolve(user('super_admin', { is_active: 0 }), F.myTasks, { env: ENV_ON, overrides: [] });
  assert.equal(r.allowed, false);
  assert.equal(r.rule, 3);
});

test('T10 — unknown feature key is denied and does not throw (rule 1)', async () => {
  const r = await resolve(user('super_admin'), 'nope.not.a.real.key', { env: ENV_ON, overrides: [] });
  assert.equal(r.allowed, false);
  assert.equal(r.rule, 1);
});

test('T11 — super_admin holds all 223 non-cron features (and no crons)', async () => {
  const map = await resolveAll(user('super_admin'), { env: ENV_ON, overrides: [] });
  const isCron = f => f.surface === 'agent_trigger' && !f.ref.startsWith('POST ');
  const nonCron = FEATURES.filter(f => !isCron(f));
  const crons = FEATURES.filter(isCron);
  const allowedNonCron = nonCron.filter(f => map.get(f.key).allowed).length;
  assert.equal(allowedNonCron, 223); // +5 Content Studio features (page + list/get/update/run)
  assert.ok(crons.every(f => !map.get(f.key).allowed), 'no cron is ever held');
});

test('T12 — business_dev holds CDI view but NOT find-contacts (until ticked)', async () => {
  const rView = await resolve(user('business_dev'), F.cdiView, { env: ENV_ON, overrides: [] });
  const rFind = await resolve(user('business_dev'), F.findContacts, { env: ENV_ON, overrides: [] });
  assert.equal(rView.allowed, true);
  assert.equal(rFind.allowed, false);
  // and an explicit allow tick DOES grant it (the day-one super_admin action)
  const rTicked = await resolve(user('business_dev'), F.findContacts, { env: ENV_ON, overrides: [ov(F.findContacts, 'allow')] });
  assert.equal(rTicked.allowed, true);
  assert.equal(rTicked.rule, 5);
});

test('bonus — resolveNav returns only held nav_page features (sidebar == API)', async () => {
  const nav = await resolveNav(user('business_dev'), { env: ENV_ON, overrides: [] });
  assert.ok(nav.includes(F.cdiView), 'business_dev sees Clinical Demand Intelligence');
  assert.ok(nav.every(k => FEATURES.find(f => f.key === k).surface === 'nav_page'));
  assert.ok(!nav.includes('platform.page_settings.view'), 'business_dev does not see admin-only Settings');
});
