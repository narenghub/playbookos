// ── DOES EXISTING PLAYBOOKOS STILL WORK AFTER THE MIGRATION? ───────────────────────────────────────
//
//   node scripts/check-behavioral-regression.js ; echo $?
//
// Ruling 33 item 5: *"Run behavioral regression tests for existing PlaybookOS functionality,
// especially outreach, user roles, authentication, product permissions, and existing integrations."*
//
// WHY BEHAVIOUR AND NOT SCHEMA. The defect that halted gate 2 was found by reading a schema shape, and
// the schema was correct. The defect HIDING behind it — `outreach.partner_id` missing on every
// migrator-built database — was invisible to every schema check in this repository and would have
// been caught in one line by running the query the application runs. That asymmetry is the whole
// argument for this file: it boots the real server against a freshly migrated database and exercises
// the behaviour over HTTP, the way a user would.
//
// WHAT IT DELIBERATELY DOES NOT DO. It sends no email, contacts no supplier and reaches no external
// service. The three capability STOPs and the global email HOLD are in force, so for integrations
// "still working" means "still correctly held" — asserted by checking the stops are active, never by
// attempting a send to see what happens. A test that fires a real send to prove sending is blocked is
// the mistake CLAUDE.md names: *"it will be refused anyway" is a prediction, not a safeguard.*
//
// THE ROLE TESTS ARE A REGRESSION, NOT A SMOKE TEST. Until 2026-09-28 the role came from the JWT, so a
// promotion or demotion waited up to seven days for the token to expire; product_shadow_log shows one
// account making 178 requests as `admin` and 25 as `super_admin` on the same day, the same button
// working or not depending on which tab it was clicked in. src/lib/core.js now reads the role from the
// database per request. So these tests change the role UNDERNEATH A LIVE TOKEN and assert the very
// next request sees it — the property that was broken, not merely that gates exist.
'use strict';

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { Client } = require('pg');
const { pgBinCandidates, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const PGPORT = process.env.BEHAVIOR_PGPORT || '55474';
const APPPORT = process.env.BEHAVIOR_APPPORT || '5611';

let pass = 0; let fail = 0;
const ok = (m) => { pass += 1; console.log(`  ok    ${m}`); };
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}${d ? `\n          ${d}` : ''}`); };
const h = (t) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

let temp = null; let server = null;

function startCluster() {
  const dir = pgBinCandidates()[0];
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/behavior-');
  const asPostgres = process.getuid && process.getuid() === 0;
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, encoding: 'utf8', stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p ${PGPORT} -c listen_addresses=' start -w`);
  } catch (e) {
    console.error(`  (cluster start failed: ${e.message})`);
    return null;
  }
  temp = { base, dir, asPostgres };
  return base;
}

function cleanup() {
  if (server) { try { server.kill('SIGKILL'); } catch { /* going */ } }
  if (!temp) return;
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`],
    { env: { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` }, stdio: 'pipe' });
  } catch { /* going away anyway */ }
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch { /* temp dir */ }
}

// ── HTTP, with the status code kept, because the status code IS the assertion here ────────────────
function req(method, p, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const r = http.request({ host: '127.0.0.1', port: APPPORT, path: p, method, headers }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => {
        const text = Buffer.concat(c).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const waitForHealth = async () => {
  for (let i = 0; i < 90; i += 1) {
    try { const r = await req('GET', '/health'); if (r.status === 200) return true; } catch { /* not up */ }
    await new Promise((s) => setTimeout(s, 1000));
  }
  return false;
};

const ADMIN_EMAIL = 'behavior-admin@example.invalid';
const ADMIN_PASSWORD = `fixture-only-${require('crypto').randomBytes(12).toString('hex')}`;

// ── TWO MODES, ONE SET OF ASSERTIONS (ruling 40 item 2) ────────────────────────────────────────────
//
// Default: build a disposable cluster, migrate it, boot the server. That is the preflight path.
//
// BEHAVIOR_EXISTING_URL: run the SAME assertions against a database somebody else prepared — in
// practice the restored, reconciled, migrated copy of production that verify-migration-readiness.js
// has in hand. Wired as a mode rather than a second harness on purpose: two copies of these
// assertions would drift, and the one nobody ran would be the one that mattered.
//
// WHY THIS MODE NEEDS MORE CARE THAN THE OTHER. The fixture path boots the server over invented rows.
// This one boots it over 12 real people, 4,756 prospects and every buyer contact — and server.js
// registers its cron jobs unconditionally, one of which emails a briefing. So before the server
// starts, in this mode only:
//
//   1. the capability STOPs are inserted into the disposable database. src/lib/mailer.js and
//      src/lib/whatsapp.js both call checkStopped() before sending, so a stop is the DESIGNED refusal
//      and not a hope. capability:llm.call is deliberately left unstopped, because section 6 probes
//      the stop mechanism with it.
//   2. every outbound credential is blanked in the child's environment, so a path that somehow got
//      past the stop has nothing to authenticate with.
//   3. after the run, autonomy_events and email_log are checked for an actual send. The guard is
//      verified rather than trusted — "it will be refused anyway" is a prediction, not a safeguard.
const EXISTING_URL = process.env.BEHAVIOR_EXISTING_URL || null;

// Anything that could reach the outside world. Blanked, not removed, so code reading them gets an
// empty string rather than undefined-with-a-default.
const OUTBOUND_CREDENTIALS = ['RESEND_API_KEY', 'RESEND_FROM', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
  'TWILIO_WHATSAPP_FROM', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'APOLLO_API_KEY', 'ALGOLIA_API_KEY',
  'LINKEDIN_ACCESS_TOKEN', 'LINKEDIN_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_CLIENT_SECRET',
  'GOOGLE_SERVICE_ACCOUNT_JSON', 'TRIGGERS_SECRET', 'PLAYBOOKOS_WEBHOOK_SECRET', 'ENGAGEMENT_SECRET'];

// Row counts taken before the server boots, so section 7 can compare a delta rather than an
// absolute. Null in default mode, where the database is built empty by this script.
let outboundBaseline = null;

const PRE_INSERTED_STOPS = [
  ['capability', 'email.send'],
  ['capability', 'whatsapp.send'],
  ['workflow', 'legacy-inquiry-buyer-email'],
  ['workflow', 'legacy-supplier-rfq-email'],
];

async function main() {
  h(EXISTING_URL
    ? 'BEHAVIORAL REGRESSION — AGAINST THE RESTORED, RECONCILED PRODUCTION DATABASE'
    : 'BEHAVIORAL REGRESSION — EXISTING FUNCTIONALITY ON A FRESHLY MIGRATED DATABASE');

  let url;
  if (EXISTING_URL) {
    url = EXISTING_URL;
  } else {
    const base = startCluster();
    if (!base) {
      console.log('\nSKIP  no PostgreSQL server toolchain (initdb/pg_ctl). This proved NOTHING.\n');
      process.exit(EXIT_NOT_EXECUTED);
    }
    url = `postgresql://postgres@localhost/postgres?host=${base}&port=${PGPORT}&sslmode=disable`;
  }
  const owner = new Client({ connectionString: url });
  await owner.connect();
  const oq = (s, p) => owner.query(s, p);

  process.env.DATABASE_URL = url;
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.PRPA_COMPANY_SLUG = 'abiozen';

  const childEnv = {
    ...process.env,
    PORT: APPPORT,
    NODE_ENV: 'test',
    JWT_SECRET: require('crypto').randomBytes(24).toString('hex'),
  };

  if (EXISTING_URL) {
    h('1. A DATABASE SOMEBODY ELSE PREPARED — guard it, then boot the server over it');
    const tables = (await oq(`SELECT COUNT(*)::int n FROM pg_tables WHERE schemaname='public'`)).rows[0].n;
    const users = (await oq(`SELECT COUNT(*)::int n FROM users`)).rows[0].n;
    ok(`using the supplied database — ${tables} tables, ${users} user(s), already migrated`);

    // The index this whole reconciliation existed for. If it is absent, the database was not
    // reconciled and these assertions would be running against the wrong thing.
    const idx = (await oq(`SELECT COUNT(*)::int n FROM pg_indexes WHERE indexname='idx_cem_unique'`)).rows[0].n;
    if (idx === 1) ok('idx_cem_unique is present — this database has been reconciled and migrated');
    else bad('idx_cem_unique is absent', 'the supplied database has not been through reconciliation');

    for (const [type, key] of PRE_INSERTED_STOPS) {
      await oq(`INSERT INTO autonomy_stops (scope_type, scope_key, reason, set_by)
                VALUES ($1,$2,$3,$4)
                ON CONFLICT (scope_type, scope_key) DO NOTHING`,
      [type, key, 'behavioral regression on a restored copy — no outbound traffic permitted',
        'check-behavioral-regression.js']);
    }
    const stopped = (await oq(`SELECT scope_type || ':' || scope_key AS k FROM autonomy_stops ORDER BY 1`))
      .rows.map((r) => r.k);
    const missing = PRE_INSERTED_STOPS.map(([t, k]) => `${t}:${k}`).filter((k) => !stopped.includes(k));
    if (!missing.length) ok(`outbound capabilities stopped before boot: ${PRE_INSERTED_STOPS.map(([t, k]) => `${t}:${k}`).join(', ')}`);
    else bad(`could not stop ${missing.join(', ')}`, 'refusing to boot a server over real contacts without the kill switch set');

    let blanked = 0;
    for (const k of OUTBOUND_CREDENTIALS) { if (childEnv[k]) { childEnv[k] = ''; blanked += 1; } }
    ok(`${blanked} outbound credential(s) blanked in the server's environment (of ${OUTBOUND_CREDENTIALS.length} checked)`);

    // ── BASELINE FOR SECTION 7 ────────────────────────────────────────────────
    // Taken here, before the server boots, because section 7 has to answer "did this run send
    // anything" and the only honest form of that question is a DELTA. Not a timestamp window:
    // email_log.sent_at is TEXT (src/lib/db.js:130) and autonomy_events has `at`, not `created_at`,
    // so a `> NOW() - INTERVAL` comparison is wrong on both tables — it was, until this run caught
    // it. And not "the table is empty" either: this database is a copy of production and these
    // tables legitimately hold history. CLAUDE.md says compare a delta against what was already
    // there, and that applies to a read-only assertion exactly as it does to cleanup.
    outboundBaseline = {
      email_log: (await oq(`SELECT COUNT(*)::int n FROM email_log`)).rows[0].n,
      autonomy_events: (await oq(`SELECT COUNT(*)::int n FROM autonomy_events`)).rows[0].n,
    };
    console.log(`        baseline before boot — email_log ${outboundBaseline.email_log} row(s), `
      + `autonomy_events ${outboundBaseline.autonomy_events} row(s)`);

    if (missing.length) throw new Error('stop');
  } else {
    h('1. MIGRATE, THEN BOOT THE REAL SERVER');
    const r = await require('../src/lib/migrate-all').runAll(oq, { seeds: false, log: () => {} });
    if (r.ok) ok(`${r.steps.length} migration step(s) applied`);
    else { bad(`${r.failed.length} step(s) failed`, r.failed.map((f) => `${f.name}: ${f.error}`).join(' | ')); throw new Error('stop'); }
  }

  {
    // The fixture admin. In existing-database mode the real accounts are present but their passwords
    // are not known here and must never be — so a fixture super_admin is inserted with a password
    // generated for this run, and it dies with the disposable database.
    const hash = require('bcryptjs').hashSync(ADMIN_PASSWORD, 10);
    await oq(`INSERT INTO users (id, email, name, role, password_hash)
              VALUES ('behavior-admin', $1, 'Behavior Admin', 'super_admin', $2)
              ON CONFLICT (email) DO UPDATE SET role='super_admin', password_hash=$2`,
    [ADMIN_EMAIL, hash]);
    if (EXISTING_URL) ok(`fixture super_admin ${ADMIN_EMAIL} created in the disposable copy (password generated for this run)`);

    server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const boot = [];
    server.stdout.on('data', (d) => boot.push(d.toString()));
    server.stderr.on('data', (d) => boot.push(d.toString()));
    if (await waitForHealth()) ok(`the real server is serving on 127.0.0.1:${APPPORT}`);
    else { bad('the server never became healthy', boot.join('').slice(-500)); throw new Error('stop'); }
  }

  // ── 2. AUTHENTICATION ───────────────────────────────────────────────────────────────────────────
  h('2. AUTHENTICATION');
  let token = null;
  {
    const good = await req('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    if (good.status === 200 && good.json && good.json.token) { token = good.json.token; ok('login with correct credentials returns 200 and a token'); }
    else bad(`login failed (${good.status})`, good.text.slice(0, 200));

    const wrong = await req('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: 'not-the-password' } });
    if (wrong.status === 401) ok('login with a wrong password is refused 401');
    else bad(`a wrong password returned ${wrong.status}, not 401`, wrong.text.slice(0, 160));

    const noSuchUser = await req('POST', '/api/auth/login', { body: { email: 'nobody@example.invalid', password: 'x' } });
    if (noSuchUser.status === 401) ok('login as an unknown account is refused 401');
    else bad(`an unknown account returned ${noSuchUser.status}, not 401`);

    const anon = await req('GET', '/api/auth/me');
    if (anon.status === 401) ok('/api/auth/me is 401 anonymously');
    else bad(`/api/auth/me returned ${anon.status} with no token, not 401`);

    const garbage = await req('GET', '/api/auth/me', { token: 'not.a.jwt' });
    if (garbage.status === 401) ok('a malformed token is refused 401');
    else bad(`a malformed token returned ${garbage.status}, not 401`);

    // A token signed with the WRONG secret must not be accepted. This is the assertion that would
    // catch a verify() that decodes without verifying.
    const forged = require('jsonwebtoken').sign({ id: 'x', email: ADMIN_EMAIL }, 'the-wrong-secret', { expiresIn: '7d' });
    const f = await req('GET', '/api/auth/me', { token: forged });
    if (f.status === 401) ok('a token signed with the wrong secret is refused 401');
    else bad(`a forged token returned ${f.status}, not 401`, 'the signature is not being verified');

    if (token) {
      const me = await req('GET', '/api/auth/me', { token });
      if (me.status === 200 && me.json && me.json.user && me.json.user.email === ADMIN_EMAIL) ok('/api/auth/me returns the authenticated account');
      else if (me.status === 200 && me.json && me.json.email === ADMIN_EMAIL) ok('/api/auth/me returns the authenticated account');
      else bad(`/api/auth/me returned ${me.status}`, me.text.slice(0, 200));
    }
  }
  if (!token) { bad('no token — the remaining checks cannot run', 'this is a non-execution, not a pass'); throw new Error('stop'); }

  // ── 3. USER ROLES, READ FRESH FROM THE DATABASE ─────────────────────────────────────────────────
  h('3. USER ROLES — a role change must take effect on the NEXT request, not when the token expires');
  {
    const sa = await req('GET', '/api/products/grantable', { token });
    if (sa.status === 200) ok('a super_admin reaches a superAdminOnly route');
    else bad(`superAdminOnly route returned ${sa.status} for a super_admin`, sa.text.slice(0, 160));

    // THE REGRESSION. Demote in the database; the SAME token must now be refused.
    await oq(`UPDATE users SET role='sales_team' WHERE email=$1`, [ADMIN_EMAIL]);
    const demoted = await req('GET', '/api/products/grantable', { token });
    if (demoted.status === 403) ok('demoted in the database, the SAME token is refused 403 on the next request');
    else {
      bad(`after demotion the same token returned ${demoted.status}, not 403`,
        'the role is being trusted from the JWT — this is the 2026-09-28 defect, where one account '
        + 'made 178 requests as admin and 25 as super_admin on the same day');
    }

    await oq(`UPDATE users SET role='super_admin' WHERE email=$1`, [ADMIN_EMAIL]);
    const repromoted = await req('GET', '/api/products/grantable', { token });
    if (repromoted.status === 200) ok('re-promoted, the same token works again — no re-login needed');
    else bad(`after re-promotion the same token returned ${repromoted.status}, not 200`);

    // Deactivation must also bite immediately.
    // is_active is an INTEGER (0/1), not a boolean — src/lib/db.js:68. Asserted from
    // information_schema rather than assumed, because the first version of this check passed
    // `false` and the harness died on a type error two sections in.
    const activeType = (await oq(`SELECT data_type FROM information_schema.columns
                                    WHERE table_name='users' AND column_name='is_active'`)).rows[0];
    if (activeType) {
      const offVal = /int/i.test(activeType.data_type) ? '0' : 'false';
      const onVal = /int/i.test(activeType.data_type) ? '1' : 'true';
      await oq(`UPDATE users SET is_active=${offVal} WHERE email=$1`, [ADMIN_EMAIL]);
      const off = await req('GET', '/api/auth/me', { token });
      if (off.status === 401 || off.status === 403) ok(`a deactivated account is refused ${off.status} with a live token`);
      else bad(`a deactivated account still got ${off.status}`, 'deactivation waits for the token to expire');
      await oq(`UPDATE users SET is_active=${onVal} WHERE email=$1`, [ADMIN_EMAIL]);
    } else {
      console.log('        (users has no is_active column — deactivation not asserted)');
    }

    const roles = await req('GET', '/api/roles', { token });
    if (roles.status === 200) {
      const body = roles.json || {};
      const list = Array.isArray(body) ? body : (body.roles || []);
      if (list.length >= 12) ok(`the role system still reports ${list.length} roles`);
      else bad(`the role system reports ${list.length} roles, expected at least 12`);
    } else bad(`/api/roles returned ${roles.status}`);
  }

  // ── 4. PRODUCT PERMISSIONS ──────────────────────────────────────────────────────────────────────
  h('4. PRODUCT PERMISSIONS — never read from the JWT either');
  let fixtureProspect = null;
  {
    // A non-super_admin user, so the product boundary actually applies (super_admin bypasses it by
    // design, which is why the FIRST version of a check like this proved nothing).
    const pw = `fixture-only-${require('crypto').randomBytes(12).toString('hex')}`;
    const hash = require('bcryptjs').hashSync(pw, 10);
    await oq(`INSERT INTO users (id, email, name, role, password_hash)
              VALUES ('behavior-sales','behavior-sales@example.invalid','Behavior Sales','sales_team',$1)
              ON CONFLICT (email) DO UPDATE SET role='sales_team', password_hash=$1`, [hash]);
    const login = await req('POST', '/api/auth/login', { body: { email: 'behavior-sales@example.invalid', password: pw } });
    if (login.status !== 200 || !login.json || !login.json.token) {
      bad(`could not log in the sales_team fixture (${login.status})`, login.text.slice(0, 200));
    } else {
      const sToken = login.json.token;
      ok('a sales_team account can log in');

      // A REAL prospect row is required, because the route resolves the entity BEFORE it checks the
      // product grant. The first version of this check passed a made-up id, got 404 entity_not_found,
      // and never reached the gate it was trying to test — a green that proved nothing, which is the
      // failure mode this whole file exists to avoid.
      const prospect = (await oq(
        `INSERT INTO prospects (product, place_id, name) VALUES ('golfnex','behavior-regression-1','Behavior Fixture')
         ON CONFLICT (product, place_id) DO UPDATE SET name='Behavior Fixture' RETURNING id`)).rows[0];
      fixtureProspect = prospect.id;
      ok(`created a real prospect (#${prospect.id}, product golfnex) so the product gate is actually reached`);

      await oq(`DELETE FROM user_products WHERE user_id='behavior-sales'`);
      const denied = await req('PUT', '/api/outreach', {
        token: sToken, body: { entity_type: 'prospect', entity_id: String(prospect.id), status: 'contacted' },
      });
      if (denied.status === 403 && denied.json && denied.json.code === 'product_not_held') {
        ok('without a product grant, an outreach write is refused 403 product_not_held');
      } else {
        bad(`an ungranted outreach write returned ${denied.status} (${(denied.json && denied.json.code) || 'no code'}), not 403 product_not_held`,
          denied.text.slice(0, 200));
      }

      // Grant the product the prospect actually belongs to. Same token — the grant must take effect
      // immediately, because permissions are read per request and never from the JWT.
      await oq(`INSERT INTO user_products (user_id, product) VALUES ('behavior-sales', 'golfnex')
                ON CONFLICT DO NOTHING`);
      const granted = await req('PUT', '/api/outreach', {
        token: sToken, body: { entity_type: 'prospect', entity_id: String(prospect.id), status: 'contacted' },
      });
      if (granted.status === 200) ok('with the grant, the SAME token succeeds — no re-login needed');
      else if (granted.status === 403 && granted.json && granted.json.code === 'product_not_held') {
        bad('the grant did not take effect on the same token', 'permissions are being read from the JWT');
      } else bad(`the granted write returned ${granted.status}`, granted.text.slice(0, 600));

      // Revoke. Same token again — must go back to refused.
      await oq(`DELETE FROM user_products WHERE user_id='behavior-sales'`);
      const revoked = await req('PUT', '/api/outreach', {
        token: sToken, body: { entity_type: 'prospect', entity_id: String(prospect.id), status: 'won' },
      });
      if (revoked.status === 403) ok('revoked, the same token is refused again — no re-login, no token expiry wait');
      else bad(`after revocation the same token returned ${revoked.status}, not 403`);
    }
  }

  // ── 5. OUTREACH, THROUGH THE API ────────────────────────────────────────────────────────────────
  h('5. OUTREACH — the feature the migration defect would have broken, exercised over HTTP');
  {
    if (!fixtureProspect) { bad('no fixture prospect — section 4 did not create one', 'this is a non-execution'); throw new Error('stop'); }
    // The SAME real prospect section 4 created. An invented id returns 404 entity_not_found before any
    // of this is reached, and the first version of this section asserted against that 404 for five
    // lines — five failures that were all one fixture mistake.
    const eid = String(fixtureProspect);
    await oq(`DELETE FROM outreach WHERE entity_type='prospect' AND entity_id=$1`, [eid]);
    const before = (await oq(`SELECT COUNT(*)::int n FROM outreach`)).rows[0].n;
    const set = await req('PUT', '/api/outreach', {
      token, body: { entity_type: 'prospect', entity_id: eid, status: 'contacted', note: 'regression fixture' },
    });
    if (set.status === 200) ok('a status change succeeds over HTTP as a super_admin');
    else bad(`PUT /api/outreach returned ${set.status}`, set.text.slice(0, 250));

    const after = (await oq(`SELECT COUNT(*)::int n FROM outreach`)).rows[0].n;
    if (after === before + 1) ok('exactly one outreach row was created');
    else bad(`outreach went from ${before} to ${after} rows, expected one more`);

    // The upsert. Without the per-partner unique index this raises 42P10 and the route 500s — which is
    // precisely what a fresh deployment would have done before today.
    const again = await req('PUT', '/api/outreach', {
      token, body: { entity_type: 'prospect', entity_id: eid, status: 'won' },
    });
    const after2 = (await oq(`SELECT COUNT(*)::int n FROM outreach`)).rows[0].n;
    if (again.status === 200 && after2 === after) ok('a second change UPDATES in place — no duplicate row, no 42P10');
    else bad(`the second change returned ${again.status} and left ${after2} rows (expected ${after})`, again.text.slice(0, 250));

    const row = (await oq(`SELECT status FROM outreach WHERE entity_type='prospect' AND entity_id=$1`, [eid])).rows;
    if (row.length === 1 && row[0].status === 'won') ok('the new status persisted');
    else bad('the status did not persist', JSON.stringify(row));

    // The events log, which is the reason the table exists at all.
    const ev = (await oq(`SELECT COUNT(*)::int n FROM outreach_events`)).rows[0].n;
    if (ev >= 2) ok(`${ev} outreach event(s) logged — the history survives, which current status cannot answer`);
    else bad(`only ${ev} outreach event(s) logged, expected at least 2`);

    const summary = await req('GET', '/api/outreach/summary?entity_type=prospect&total=100', { token });
    if (summary.status === 200) ok('the outreach summary endpoint still answers');
    else bad(`/api/outreach/summary returned ${summary.status}`);
  }

  // ── 6. INTEGRATIONS — role gating, and the kill switch's vocabulary ─────────────────────────────
  h('6. INTEGRATIONS — role-gated, and the outbound capabilities still STOPPABLE');
  {
    const ints = await req('GET', '/api/integrations', { token });
    if (ints.status === 200) ok('the integrations registry answers for an authorized role');
    else bad(`/api/integrations returned ${ints.status}`, ints.text.slice(0, 200));

    // requireTier('technical'). A sales_team account must not reach it.
    const pw2 = `fixture-only-${require('crypto').randomBytes(12).toString('hex')}`;
    const hash2 = require('bcryptjs').hashSync(pw2, 10);
    await oq(`INSERT INTO users (id, email, name, role, password_hash)
              VALUES ('behavior-support','behavior-support@example.invalid','Behavior Support','support_team',$1)
              ON CONFLICT (email) DO UPDATE SET role='support_team', password_hash=$1`, [hash2]);
    const l2 = await req('POST', '/api/auth/login', { body: { email: 'behavior-support@example.invalid', password: pw2 } });
    if (l2.status === 200 && l2.json && l2.json.token) {
      const r2 = await req('GET', '/api/integrations', { token: l2.json.token });
      if (r2.status === 403) ok('a support_team account is refused 403 on the technical-tier route');
      else bad(`support_team got ${r2.status} on a technical-tier route, not 403`, r2.text.slice(0, 160));
    } else bad(`could not log in the support_team fixture (${l2.status})`);

    // ── THE STOPS ARE OPERATIONAL STATE, NOT MIGRATION OUTPUT ─────────────────────────────────────
    //
    // The first version of this section asserted that capability:email.send and the two legacy email
    // workflows were STOPPED on this database, and reported three failures. That was wrong: a stop is
    // a row somebody inserts, so a freshly migrated database correctly has none. Asserting production
    // state against a fixture is the mistake that halted gate 2 — an expectation encoding a state
    // that does not belong to the thing under test.
    //
    // What IS this harness's business: that the kill switch still KNOWS those scopes after the
    // migration, so they remain stoppable. Whether production currently holds the stops is asserted
    // against production by scripts/check-release-safety-posture.js, and the mechanism itself by
    // "kill switch stops, propagates and audits" in preflight.
    //
    // Nothing here attempts a send to see whether it is refused. "It will be refused anyway" is a
    // prediction, not a safeguard, and the one run where the guard does not fire is the run that
    // emails a real supplier.
    const autonomy = require('../src/lib/autonomy');

    // knownScopeKeys(scope_type) is SYNCHRONOUS and returns BARE keys — 'email.send', not
    // 'capability:email.send'. The first version of this section awaited it and compared prefixed
    // strings, so all three assertions failed against a kill switch that was working perfectly.
    const caps = autonomy.knownScopeKeys('capability');
    const flows = autonomy.knownScopeKeys('workflow');
    for (const want of ['email.send']) {
      if (caps.includes(want)) ok(`still stoppable after the migration: capability:${want}`);
      else bad(`the kill switch no longer knows capability:${want}`, `known: ${caps.join(', ')} — a scope it cannot name is a scope it cannot stop`);
    }
    for (const want of ['legacy-inquiry-buyer-email', 'legacy-supplier-rfq-email']) {
      if (flows.includes(want)) ok(`still stoppable after the migration: workflow:${want}`);
      else bad(`the kill switch no longer knows workflow:${want}`, `known: ${flows.slice(0, 14).join(', ')}`);
    }

    // And the mechanism still works on this schema: set a stop, read it back, resume. On a fixture
    // database, and on llm.call rather than anything outbound, so nothing real is held or released.
    //
    // stop() takes SNAKE_CASE keys and RETURNS {ok:false,error} rather than throwing. The first
    // version passed camelCase, got a quiet refusal, and then asserted that the stop "did not read
    // back" — reporting a broken kill switch when the only broken thing was the call. A function
    // whose failure is a return value has to have that value read.
    const set1 = await autonomy.stop({
      scope_type: 'capability', scope_key: 'llm.call',
      reason: 'behavioral regression fixture probe — disposable database', actor: ADMIN_EMAIL,
    });
    if (set1 && set1.ok === false) {
      bad('the kill switch refused a valid STOP on the migrated schema', set1.error);
    } else {
      const now = await autonomy.listStops();
      const active = now.map((x) => `${x.scope_type}:${x.scope_key}`);
      if (active.includes('capability:llm.call')) ok('a STOP can still be set and read back on the migrated schema');
      else bad('a STOP was set but does not read back', `active: ${active.join(', ') || '(none)'}`);

      const r1 = await autonomy.resume({
        scope_type: 'capability', scope_key: 'llm.call',
        reason: 'behavioral regression fixture probe over', actor: ADMIN_EMAIL,
      });
      if (r1 && r1.ok === false) {
        bad('the fixture stop could not be resumed', `${r1.error} — it would be left holding a capability`);
      } else {
        const after = await autonomy.listStops();
        if (!after.map((x) => `${x.scope_type}:${x.scope_key}`).includes('capability:llm.call')) {
          ok('…and resumed again, leaving no stop behind');
        } else bad('the fixture stop was not cleared', 'it would be left holding a capability');
      }
    }
  }

  // ── 7. DID ANYTHING ACTUALLY LEAVE THE MACHINE? (ruling 40 item 3) ─────────────────────────────
  if (EXISTING_URL) {
    h('7. NO OUTBOUND TRAFFIC — the guard is checked, not trusted');

    // A successful send writes to email_log. Anything the kill switch refused lands in
    // autonomy_events instead. Both are compared against the pre-boot baseline, because an absolute
    // count proves nothing on a copy of production and "the table is empty" is also what a table
    // nobody writes to looks like.
    if (!outboundBaseline) {
      bad('no pre-boot baseline was taken', 'section 7 cannot answer the question it exists for');
    } else {
      const nowEmail = (await oq(`SELECT COUNT(*)::int n FROM email_log`)).rows[0].n;
      const dEmail = nowEmail - outboundBaseline.email_log;
      if (dEmail === 0) ok(`email_log gained no row during this run (${nowEmail}, unchanged)`);
      else bad(`email_log gained ${dEmail} row(s) during this run`,
        'something attempted to send mail over contacts copied from production');

      const nowEv = (await oq(`SELECT COUNT(*)::int n FROM autonomy_events`)).rows[0].n;
      console.log(`        autonomy_events grew by ${nowEv - outboundBaseline.autonomy_events}`
        + ' row(s) (stop/resume audit from this run — expected, and written by a trigger)');
    }

    const stillStopped = (await oq(
      `SELECT COUNT(*)::int n FROM autonomy_stops
        WHERE (scope_type, scope_key) IN (('capability','email.send'),('capability','whatsapp.send'))`)).rows[0].n;
    if (stillStopped === 2) ok('the email and WhatsApp stops are still in force at the end of the run');
    else bad(`${stillStopped} of 2 outbound stops remain`, 'something resumed a capability mid-run');

    // And the credentials: the server was given empty strings, so even a bypass had nothing to use.
    const anySet = OUTBOUND_CREDENTIALS.filter((k) => childEnv[k]);
    if (!anySet.length) ok('no outbound credential was set in the server environment');
    else bad(`${anySet.length} credential(s) were still set`, anySet.join(', '));
  }

  await owner.end();

  h(`  ${pass} assertion(s) passed · ${fail} failed`);
  if (fail) {
    console.log('\nFAIL  existing functionality is not intact on a migrated database.\n');
    cleanup();
    process.exit(1);
  }
  console.log('\nPASS  authentication, role freshness, product permissions, outreach and the integration\n'
    + '      gating all behave correctly on a database built by the migrator, and the kill switch\n'
    + '      still names and can still hold every outbound email scope.\n'
    + '\n      This says nothing about whether production currently HOLDS those stops — that is\n'
    + '      operational state, asserted against production by check-release-safety-posture.js.\n');
}

main().then(() => {
  cleanup();
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  cleanup();
  console.error(`\nFAIL  harness error: ${e.message}`);
  process.exit(1);
});
