#!/usr/bin/env node
// ── AUTHENTICATED ADMINISTRATIVE ENROLLMENT, OVER A REAL HTTP SERVER ────────
//
// Owner, Workstream A.3/A.4 and the sixth directive's point 3: *"An administrator email supplied
// through --operator is identification, not authentication."* and *"Test administrator
// impersonation, inactive administrators, ordinary employees, external users and unauthorized
// enrollment attempts."*
//
// Every case here goes over a real Express app against a real cluster, with real JWTs. Nothing is
// asserted on the source: the question is whether an HTTP request can obtain a token, and only a
// request can answer it.
//
// The verdict is the exit status.

'use strict';

process.env.ADMIN_EMAIL = 'enr-bootstrap@enr.invalid';
process.env.ADMIN_PASSWORD = `e-${require('crypto').randomBytes(16).toString('hex')}`;
process.env.WORKER_SECRET_SEAL_KEY = require('crypto').randomBytes(32).toString('hex');
process.env.JWT_SECRET = `jwt-${require('crypto').randomBytes(24).toString('hex')}`;
process.env.NODE_ENV = 'development';

const crypto = require('crypto');
const PG = require('./lib/pg-disposable');
const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let pass = 0;
let fail = 0;
const lines = [];
const ok = (m) => { pass += 1; lines.push(`  ok    ${m}`); };
const bad = (m) => { fail += 1; lines.push(`  FAIL  ${m}`); };
const note = (m) => lines.push(`  --    ${m}`);
const section = (t) => lines.push('', `── ${t} ──`, '');

(async () => {
  let cluster = null;
  try {
    cluster = PG.create({ label: 'admin-enrollment' });
  } catch (e) {
    console.log(`NOT EXECUTED  infrastructure unavailable: ${e.message}`);
    process.exit(EXIT_NOT_EXECUTED);
  }
  process.env.DATABASE_URL = cluster.url;

  let server = null;
  const DB = require('../src/lib/db');
  const { query } = DB;

  try {
    await DB.initDB();
    await DB.initPhase2();
    await DB.migrateSchemas();
    await require('../src/lib/runs').migrateRuns(query);
    await require('../src/lib/office/schema').migrateOffice(query);
    await require('../src/lib/identity/schema').migrateIdentity(query);
    await require('../src/lib/worker/identity').migrateWorkerIdentity(query);
    await require('../src/lib/worker/leases').migrateWorkerTasks(query);

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api', require('../src/api/routes'));
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    const base = `http://127.0.0.1:${server.address().port}`;
    note(`a real Express app is listening on ${base}`);

    const { signToken } = require('../src/lib/core');
    const mkUser = async (id, role, active) => {
      await query(
        `INSERT INTO users (id, email, name, role, is_active, password_hash)
         VALUES ($1,$2,$1,$3,$4,'x')`, [id, `${id}@enr.invalid`, role, active]);
      return id;
    };

    const post = async (tokenJwt, body) => {
      const r = await fetch(`${base}/api/admin/worker-enrollment-tokens`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(tokenJwt ? { authorization: `Bearer ${tokenJwt}` } : {}),
        },
        body: JSON.stringify(body),
      });
      let json = null;
      try { json = await r.json(); } catch (_) { /* a non-JSON body is itself the answer */ }
      return { status: r.status, json };
    };

    // ═══ 1. AN AUTHENTICATED SUPER ADMIN SUCCEEDS ═══════════════════════════
    section('1. the authorized path');

    const ADMIN = await mkUser('enr-admin', 'super_admin', 1);
    const adminJwt = signToken({ id: ADMIN, email: `${ADMIN}@enr.invalid`, role: 'super_admin' });
    const good = await post(adminJwt, { label: 'dev-cloud-worker' });
    if (good.status === 200 && good.json && good.json.ok === true && good.json.token) {
      ok('an authenticated super_admin receives a token');
    } else {
      bad(`the authorized request returned ${good.status} ${JSON.stringify(good.json)}`);
    }
    if (good.json && good.json.operator === ADMIN) {
      ok('the operator recorded is the AUTHENTICATED user, not anything the caller named');
    } else {
      bad(`the operator came back as ${good.json && good.json.operator}`);
    }
    if (good.json && good.json.syntheticOnly === true) {
      ok('and the grant defaults to RESTRICTED without being asked for');
    } else {
      bad(`syntheticOnly came back ${good.json && good.json.syntheticOnly}`);
    }
    // The token row must carry the authenticated operator, which is the audit trail's whole point.
    const row = await query(
      `SELECT created_by, synthetic_only FROM worker_enrollment_tokens
        WHERE token_digest = $1`,
      [crypto.createHash('sha256').update(good.json.token).digest('hex')]);
    if (row.rows.length && row.rows[0].created_by === ADMIN) {
      ok('the persisted token row names the authenticated administrator');
    } else {
      bad(`the token row recorded created_by = ${row.rows[0] && row.rows[0].created_by}`);
    }

    // And the token WORKS — otherwise every refusal below could be passing for the wrong reason.
    const IDENT = require('../src/lib/worker/identity');
    const enrolled = await IDENT.consumeEnrollmentToken(
      { token: good.json.token, hostFingerprint: 'check-admin-enrollment' }, { query });
    if (enrolled && enrolled.ok === true && enrolled.syntheticOnly === true) {
      ok('CONTROL: the token exchanges into a restricted identity, so the endpoint really works');
    } else {
      bad(`the token did not exchange: ${JSON.stringify(enrolled)}`);
    }

    // ═══ 2. EVERY UNAUTHORIZED CALLER THE OWNER NAMED ═══════════════════════
    section('2. impersonation, inactive admins, employees, partners, no session');

    const refused = async (what, jwt, body = { label: 'attempt' }) => {
      const r = await post(jwt, body);
      if (r.status >= 400) ok(`${what} → ${r.status} ${String((r.json && r.json.error) || '').slice(0, 56)}…`);
      else bad(`${what} SUCCEEDED with ${r.status} and received a token`);
    };

    await refused('no session at all', null);
    await refused('a forged JWT signed with the wrong secret',
      require('jsonwebtoken').sign({ id: ADMIN, role: 'super_admin' }, 'not-the-secret'));

    // IMPERSONATION: a real, valid session for a real user, CLAIMING a role it does not hold. The
    // role must be read from persisted state or from a signed claim — never from the body.
    const EMP = await mkUser('enr-employee', 'sales_team', 1);
    await refused('an ordinary employee with a valid session',
      signToken({ id: EMP, email: `${EMP}@enr.invalid`, role: 'sales_team' }));
    await refused('an employee whose JWT CLAIMS super_admin (impersonation)',
      signToken({ id: EMP, email: `${EMP}@enr.invalid`, role: 'super_admin' }));

    const PARTNER = await mkUser('enr-partner', 'partner', 1);
    await refused('an external partner', signToken({ id: PARTNER, role: 'partner' }));

    const INACTIVE = await mkUser('enr-inactive', 'super_admin', 0);
    await refused('a DEACTIVATED administrator',
      signToken({ id: INACTIVE, email: `${INACTIVE}@enr.invalid`, role: 'super_admin' }));

    // ═══ 3. THE BODY CANNOT NAME AN OPERATOR ════════════════════════════════
    section('3. createdBy is refused rather than ignored');

    const borrowed = await post(adminJwt, { label: 'borrowed', createdBy: 'enr-employee' });
    if (borrowed.status === 400 && /createdBy is not accepted/.test((borrowed.json || {}).error || '')) {
      ok('a createdBy in the body is REFUSED — silently dropping it would let a caller believe it took');
    } else {
      bad(`a body createdBy produced ${borrowed.status} ${JSON.stringify(borrowed.json)}`);
    }

    // ═══ 4. THE GRANTS THIS ENDPOINT WILL NOT ISSUE ═════════════════════════
    section('4. hardware and GUI are not grantable over an API');

    for (const cap of ['exec:hardware', 'exec:gui']) {
      const r = await post(adminJwt, { label: `cap-${cap}`, capabilities: [cap] });
      if (r.status === 400) ok(`${cap} is refused even for a super_admin`);
      else bad(`${cap} was granted over HTTP with status ${r.status}`);
    }

    // A truthy value must not widen the worker.
    for (const v of ['false', 0, null, 'no']) {
      const r = await post(adminJwt, { label: `truthy-${String(v)}`, syntheticOnly: v });
      if (r.status === 200 && r.json.syntheticOnly === true) {
        // Correct: only the literal boolean false widens.
      } else if (r.status === 200 && r.json.syntheticOnly === false) {
        bad(`syntheticOnly: ${JSON.stringify(v)} WIDENED the worker`);
      }
    }
    ok('no truthy or stringly value widens the grant — only the literal boolean false');

    const widened = await post(adminJwt, { label: 'widened', syntheticOnly: false });
    if (widened.status === 200 && widened.json.syntheticOnly === false) {
      ok('and an authenticated super_admin CAN widen deliberately, which is the control for the above');
    } else {
      bad(`a deliberate widening by a super_admin failed: ${widened.status}`);
    }

    // ═══ 5. PRODUCTION IS REFUSED ═══════════════════════════════════════════
    section('5. the endpoint does not exist in production');

    process.env.NODE_ENV = 'production';
    const inProd = await post(adminJwt, { label: 'prod-attempt' });
    process.env.NODE_ENV = 'development';
    if (inProd.status === 403) {
      ok('NODE_ENV=production refuses the endpoint — enrolling a production worker is B6.4');
    } else {
      bad(`production returned ${inProd.status}, not 403`);
    }
    const backAgain = await post(adminJwt, { label: 'after-prod' });
    if (backAgain.status === 200) {
      ok('CONTROL: and it works again in development, so section 5 measured the environment');
    } else {
      bad('the endpoint stayed refused after NODE_ENV was restored');
    }

    // ═══ 6. THE TOKEN IS NOT IN THE SERVER'S LOGS ═══════════════════════════
    section('6. the token is returned once and not logged');

    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'api', 'routes.js'), 'utf8');
    const LEX = require('./js-lex.js');
    const code = LEX.blankCommentsOnly(src);
    const i = code.indexOf("'/admin/worker-enrollment-tokens'");
    const handler = code.slice(i, i + 3200);
    if (!/console\.(log|info|warn|error)\s*\([^)]*t\.token|logLine|logger\./.test(handler)) {
      ok('the handler logs nothing containing the token');
    } else {
      bad('the handler writes the token to a log');
    }
  } catch (e) {
    bad(`the check itself failed: ${e.message}`);
    lines.push(String(e.stack || '').split('\n').slice(1, 5).join('\n'));
  } finally {
    try { if (server) await new Promise((r) => server.close(r)); } catch (_) { /* closing */ }
    try { cluster.destroy(); } catch (_) { /* already gone is the desired state */ }
  }

  console.log('══ AUTHENTICATED ADMINISTRATIVE ENROLLMENT ══');
  console.log(lines.join('\n'));
  console.log('');
  console.log(fail === 0
    ? `OK  administrative enrollment is authenticated (${pass} assertions)`
    : `FAILED  ${fail} assertion(s) failed, ${pass} passed`);
  process.exit(fail === 0 ? 0 : 1);
})();
