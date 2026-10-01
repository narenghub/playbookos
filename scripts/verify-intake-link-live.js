// ── TOKENISED CLIENT INTAKE, END TO END, AGAINST THE LIVE CONTAINER ────────────
//
//   railway ssh 'node scripts/verify-intake-link-live.js'
//
// Every other check of this feature is a unit test against code I also wrote. This one issues a REAL
// token through the real route, then makes real unauthenticated HTTP requests at the real middleware
// chain, and asserts what comes back.
//
// Worth doing before a real client gets a link, because the unit tests cannot see the thing most likely
// to be wrong: the MOUNT ORDER. /api/intake/* sits above the permissions resolver and the product
// boundary, and if it did not, every request here would be a 403 that no unit test can produce.
//
// ── CLEANUP (CLAUDE.md) ──────────────────────────────────────────────────────
//
// Every row this script creates has its id recorded at the moment of insert, and the finally block
// deletes EXACTLY those ids. No deletion by timestamp, by pattern or by "recent". The leak check counts
// MY OWN ids still present — it never asserts a table is empty, because this feature is in use and an
// emptiness assertion becomes false the first time a client uploads something.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────
//
// It does not complete the intake over HTTP. That route fires the brief agent in the live process, which
// is a real Anthropic call and a real brief written about a junk fixture. completeIntake is exercised
// IN THIS PROCESS instead, which runs the same function against the same database and does not fire it —
// fireBrief is called by the route, not by completeIntake.
//
// It does not push 50MB through the loopback to test the per-deal cap. file_size is declared on a fixture
// row and the cap reads SUM(file_size), so the CHECK is exercised honestly; the bytes are not.

const jwt = require('jsonwebtoken');
const { query, withTransaction } = require('../src/lib/db');
const { MAX_DEAL_BYTES } = require('../src/lib/sitenex/intake-token');

const TAG = 'verify-intake-' + Date.now();
const EMAIL = `${TAG}@example.invalid`;
const PORT = process.env.PORT || 3000;
const BASE = `http://127.0.0.1:${PORT}`;

// EVERY ID, RECORDED AS IT IS CREATED.
const made = { users: [], deals: [], intake: [], links: [], files: [], projects: [], tasks: [] };
let fail = 0;

const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? '' : `\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
};
const ok = (label, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✅' : '❌'} ${label}${cond ? '' : (detail ? `\n      ${detail}` : '')}`);
};

// An unauthenticated request, exactly as a client's browser makes it: the token in the header, nothing
// in the path, no cookie, no Authorization.
const anon = async (method, path, { token, form, body } = {}) => {
  const headers = {};
  if (token) headers['X-Intake-Token'] = token;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + path, { method, headers, body: payload });
  let json = {};
  try { json = JSON.parse(await r.text()); } catch (_) {}
  return { status: r.status, body: json };
};

const staff = async (method, path, userId) => {
  const token = jwt.sign({ id: userId, email: EMAIL, role: 'super_admin' }, process.env.JWT_SECRET, { expiresIn: '3m' });
  const r = await fetch(BASE + path, { method, headers: { Authorization: 'Bearer ' + token } });
  let json = {};
  try { json = JSON.parse(await r.text()); } catch (_) {}
  return { status: r.status, body: json };
};

// The secrets the link must never reveal. Written onto the fixture deal so the negative assertion is
// about real data in a real row, not about a payload shape.
const SECRETS = {
  value_cents: 1337000,
  monthly_cents: 42100,
  contact_email: 'verify-intake-secret@example.invalid',
  contact_phone: '+1 815 555 9999',
  client_address: '99 Verify Lane, Nowhere, IL',
  terms_note: 'VERIFY-SECRET-TERMS net 30',
};

(async () => {
  let userId = null, dealId = null, url = null, token = null;
  try {
    // ── fixtures ────────────────────────────────────────────────────────────
    //
    // A FIXTURE super_admin, never the live one. A previous script PUT {role:'admin'} onto the only real
    // super_admin in the system; this one creates its own and deletes it.
    userId = require('crypto').randomUUID();
    await query(`INSERT INTO users (id, email, name, role, is_active, joined_at, permissions_version)
                 VALUES ($1, $2, 'Intake Verify Fixture', 'super_admin', 1, NOW(), 1)`, [userId, EMAIL]);
    made.users.push(userId);
    await query(`INSERT INTO user_products (user_id, product, granted_by) VALUES ($1, 'sitenex', $2)`,
                [userId, TAG]);

    dealId = (await query(
      `INSERT INTO sitenex_deals (status, company_name, contact_name, contact_title, contact_email,
                                  contact_phone, client_address, terms_note, value_cents, monthly_cents,
                                  package_code, owner_user_id)
       VALUES ('signed', $1, 'Verify Contact', 'Owner', $2, $3, $4, $5, $6, $7, 'P1', $8)
       RETURNING id`,
      [`${TAG} Co`, SECRETS.contact_email, SECRETS.contact_phone, SECRETS.client_address,
       SECRETS.terms_note, SECRETS.value_cents, SECRETS.monthly_cents, userId])).rows[0].id;
    made.deals.push(dealId);

    await query(`INSERT INTO sitenex_intake (deal_id, fields, required)
                 VALUES ($1, '{}'::jsonb, '["copy","logo","photos"]'::jsonb)`, [dealId]);
    made.intake.push(dealId);

    console.log(`fixtures: user ${userId}, deal ${dealId} (${TAG} Co) carrying a price, terms and a contact\n`);

    // ── 1. issuing ──────────────────────────────────────────────────────────
    console.log('1. ISSUING');
    const issued = await staff('POST', `/api/sitenex/deals/${dealId}/intake-link`, userId);
    check('POST /intake-link → 200', issued.status, 200);
    url = issued.body.url || '';
    token = url.split('#')[1] || '';
    ok('the url carries the token in the FRAGMENT, not the path', /\/intake#[A-Za-z0-9_-]{40,}$/.test(url), url);
    ok('the token is returned exactly once, with a note saying why', !!issued.body.token_shown_once && /cannot be shown again/.test(issued.body.note || ''));
    if (issued.body.link && issued.body.link.id) made.links.push(issued.body.link.id);

    const stored = (await query(`SELECT token_hash, token_tail FROM sitenex_intake_links WHERE deal_id = $1`, [dealId])).rows[0];
    // THE POINT OF THE WHOLE EXERCISE, asserted against the real row.
    ok('the DATABASE holds a hash, not the token', stored && stored.token_hash !== token && stored.token_hash.length === 64);
    ok("and the token is nowhere in the row", stored && !JSON.stringify(stored).includes(token.slice(0, 16)));
    check('only the last 4 characters are kept', stored.token_tail, token.slice(-4));

    // ── 2. the client's view leaks nothing ──────────────────────────────────
    console.log('\n2. WHAT THE LINK REVEALS');
    const view = await anon('GET', '/api/intake', { token });
    check('GET /api/intake → 200 (so the mount order is right — below the gates this is a 403)', view.status, 200);
    check('  …and names the client, so the page is not anonymous', view.body.company_name, `${TAG} Co`);
    const json = JSON.stringify(view.body);
    for (const [k, v] of Object.entries(SECRETS)) {
      ok(`  …and leaks NO ${k}`, !json.includes(String(v)), `found ${v} in the response`);
    }

    // ── 3. refusals ─────────────────────────────────────────────────────────
    console.log('\n3. WHAT IT REFUSES');
    const noTok = await anon('GET', '/api/intake');
    check('no token → 404', noTok.status, 404);
    const junk = await anon('GET', '/api/intake', { token: 'not-a-token' });
    const unknown = await anon('GET', '/api/intake', { token: 'Z'.repeat(43) });
    check('an unknown token → 404', unknown.status, 404);
    ok('and nonsense is INDISTINGUISHABLE from an unknown token', JSON.stringify(junk.body) === JSON.stringify(unknown.body),
       `${JSON.stringify(junk.body)} vs ${JSON.stringify(unknown.body)}`);

    const vid = new FormData();
    vid.append('file', new Blob([new Uint8Array(2048)], { type: 'video/quicktime' }), 'clip.mov');
    const video = await anon('POST', '/api/intake/files', { token, form: vid });
    check('a VIDEO is refused with 415', video.status, 415);
    check('  …by code', video.body.code, 'video_not_accepted');
    ok('  …and the message tells them to send a link instead', /link/i.test(video.body.error || ''), video.body.error);

    const svg = new FormData();
    svg.append('file', new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'logo.svg');
    check('an SVG is refused', (await anon('POST', '/api/intake/files', { token, form: svg })).status, 415);

    // ── 4. a real upload, and the quota ─────────────────────────────────────
    console.log('\n4. AN UPLOAD');
    const png = new FormData();
    png.append('file', new Blob([new Uint8Array(3072)], { type: 'image/png' }), `${TAG}-logo.png`);
    png.append('field', 'logo');
    const up = await anon('POST', '/api/intake/files', { token, form: png });
    check('a PNG is accepted', up.status, 200);
    if (up.body.uploaded && up.body.uploaded.id) made.files.push(up.body.uploaded.id);
    ok('the bytes landed in Postgres', (await query(
      `SELECT octet_length(file_bytes) n FROM sitenex_intake_files WHERE id = $1`,
      [made.files[0]])).rows[0].n === 3072);
    // An UPLOADED logo satisfies the required 'logo' — the contradiction that made a task list a file
    // and call it missing in the same breath.
    ok("and it satisfies the required 'logo'", !(up.body.missing || []).includes('logo'),
       JSON.stringify(up.body.missing));
    check('  …leaving copy and photos', (up.body.missing || []).sort(), ['copy', 'photos']);

    const saved = await anon('POST', '/api/intake/fields', { token, body: { copy: 'Verify fixture copy.' } });
    check('text answers save', saved.status, 200);
    check('  …and copy is no longer outstanding', (saved.body.missing || []).sort(), ['photos']);

    // THE PER-DEAL CAP REFUSES RATHER THAN TRUNCATING. A fixture row declares the size; the bytes are not
    // pushed through the loopback, because the cap reads SUM(file_size).
    const ballastId = (await query(
      `INSERT INTO sitenex_intake_files (deal_id, field, file_name, content_type, file_size, file_bytes)
       VALUES ($1, 'ballast', $2, 'application/pdf', $3, $4) RETURNING id`,
      [dealId, `${TAG}-ballast.pdf`, MAX_DEAL_BYTES - 4096, Buffer.from('x')])).rows[0].id;
    made.files.push(ballastId);
    const over = new FormData();
    over.append('file', new Blob([new Uint8Array(65536)], { type: 'image/png' }), 'too-much.png');
    const refused = await anon('POST', '/api/intake/files', { token, form: over });
    check('past the 50MB per-deal cap → 413', refused.status, 413);
    check('  …by code', refused.body.code, 'deal_quota_exceeded');
    ok('  …and it says how much room is left', /left for this project|make room/.test(refused.body.error || ''), refused.body.error);
    const after = (await query(`SELECT COUNT(*)::int n FROM sitenex_intake_files WHERE deal_id = $1 AND file_name = 'too-much.png'`, [dealId])).rows[0].n;
    check('  …and NOTHING was stored — refused, never truncated', after, 0);

    // ── 5. revocation and re-issue ──────────────────────────────────────────
    console.log('\n5. REVOCATION AND RE-ISSUE');
    const reissued = await staff('POST', `/api/sitenex/deals/${dealId}/intake-link`, userId);
    check('re-issuing → 200', reissued.status, 200);
    if (reissued.body.link && reissued.body.link.id) made.links.push(reissued.body.link.id);
    const newToken = (reissued.body.url || '').split('#')[1];
    const old = await anon('GET', '/api/intake', { token });
    check('the PREVIOUS token is now 410', old.status, 410);
    check('  …and says it was replaced, not that it is invalid', old.body.code, 'link_revoked');
    check('the new token works', (await anon('GET', '/api/intake', { token: newToken })).status, 200);
    const liveLinks = (await query(
      `SELECT COUNT(*)::int n FROM sitenex_intake_links WHERE deal_id = $1 AND revoked_at IS NULL`, [dealId])).rows[0].n;
    check('exactly ONE live link per deal, enforced by the index', liveLinks, 1);

    const revoked = await staff('DELETE', `/api/sitenex/deals/${dealId}/intake-link`, userId);
    check('revoking → 200', revoked.status, 200);
    check('and the new token is dead too', (await anon('GET', '/api/intake', { token: newToken })).status, 410);

    // ── 6. completion, IN THIS PROCESS ──────────────────────────────────────
    //
    // Not over HTTP: that route fires the brief agent in the live process, which is a real Anthropic call
    // and a real brief about a junk fixture. This is the same function against the same database.
    console.log('\n6. COMPLETION (in-process, so no LLM call is made)');
    const { completeIntake } = require('../src/lib/sitenex/intake-complete');
    const done = await withTransaction(async (client) =>
      completeIntake((sql, params) => client.query(sql, params), { dealId, by: userId }));
    check('completeIntake → ok', done.ok, true);
    if (done.task_id) made.tasks.push(done.task_id);
    if (done.project_id) made.projects.push(done.project_id);
    ok('a project row exists', !!done.project_id);
    ok('a task was created', !!done.task_id);
    check('  …and it went to the staff member who issued the link', done.assignee.rule, 'link.issued_by');
    check('  …who is the fixture, not a partner', done.assignee.user_id, userId);
    const task = (await query(`SELECT task_title, task_description, source_kpi FROM daily_tasks WHERE id = $1`,
                              [done.task_id])).rows[0];
    ok('the task NAMES the decision rather than guessing', /^Assign a developer to /.test(task.task_title), task.task_title);
    ok('and carries the client contact and every upload, before any brief exists',
       task.task_description.includes(SECRETS.contact_email) && task.task_description.includes(`${TAG}-logo.png`));
    check('source_kpi is NULL — a handover is not a performance measure', task.source_kpi, null);
    const stamped = (await query(`SELECT completed_at FROM sitenex_intake WHERE deal_id = $1`, [dealId])).rows[0];
    ok('completed_at is stamped', !!stamped.completed_at);

  } catch (e) {
    fail++; console.error('ERROR:', e.message, '\n', e.stack);
  } finally {
    // ── CLEANUP: EXACTLY THE IDS THIS SCRIPT RECORDED ─────────────────────────
    console.log('\ncleanup');
    const del = async (sql, ids) => { for (const id of ids) await query(sql, [id]).catch(e => console.log('   !', e.message)); };
    await del(`DELETE FROM daily_tasks WHERE id = $1`, made.tasks);
    await del(`DELETE FROM sitenex_intake_files WHERE id = $1`, made.files);
    await del(`DELETE FROM sitenex_intake_links WHERE id = $1`, made.links);
    await del(`DELETE FROM sitenex_projects WHERE id = $1`, made.projects);
    await del(`DELETE FROM sitenex_intake WHERE deal_id = $1`, made.intake);
    await del(`DELETE FROM sitenex_deals WHERE id = $1`, made.deals);
    await del(`DELETE FROM user_products WHERE user_id = $1`, made.users);
    await del(`DELETE FROM product_shadow_log WHERE user_id = $1`, made.users);
    await del(`DELETE FROM users WHERE id = $1`, made.users);

    // MY FIXTURES ARE GONE — not "the table is empty". This feature is in use; an emptiness assertion
    // becomes false the first time a real client uploads a logo, and the obvious fix when it starts
    // failing is to widen the DELETE.
    let leaked = 0;
    for (const [table, col, ids] of [
      ['daily_tasks', 'id', made.tasks], ['sitenex_intake_files', 'id', made.files],
      ['sitenex_intake_links', 'id', made.links], ['sitenex_projects', 'id', made.projects],
      ['sitenex_intake', 'deal_id', made.intake], ['sitenex_deals', 'id', made.deals],
      ['users', 'id', made.users],
    ]) {
      if (!ids.length) continue;
      const n = (await query(`SELECT COUNT(*)::int n FROM ${table} WHERE ${col} = ANY($1)`,
                             [ids]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
      if (n) { leaked += n; console.log(`   ❌ ${n} of my ${table} row(s) survived: ${ids.join(', ')}`); }
    }
    console.log(`   my fixtures: ${leaked ? leaked + ' LEAKED' : 'all gone'}`);
    if (leaked) fail++;

    console.log(fail === 0
      ? '\n✅ ALL CHECKS PASSED — the intake link is safe to send to a client'
      : `\n❌ ${fail} CHECK(S) FAILED — do not send a link`);
    process.exit(fail === 0 ? 0 : 1);
  }
})();
