// ── LABCONNECT ROUTES ─────────────────────────────────────────────────────────
//
// Mounted from server.js with one line: app.use('/api', require('./src/api/labconnect.routes'));
//
// A SEPARATE ROUTER, for the same reason sitenex-phase3.routes.js is one: routes.js is past five
// thousand lines, and on 30 September an edit to it was swallowed by a `&&` chain and a route was
// documented, classified and tested while absent from the router for two commits. A small file is
// one nobody has to search.
//
// ── ACCESS ────────────────────────────────────────────────────────────────────
//
// LabConnect lives under the `abiozen` product, so reads take requireTier('intelligence') — the
// same gate as Market Intelligence and Research Institutions, which is the shelf the CEO put this
// on. WRITES ARE adminOnly, and that is not belt-and-braces: the `intelligence` tier is held by
// several roles, and the write that matters here moves a lab to 'active', which is the only status
// an order may be routed to. Promoting a lab is a commercial decision about a firm that has agreed
// to receive client samples, and a tier check is the wrong instrument for it.
//
// Self-onboarding — a lab filling in its own details — is NOT in this file. That is a public,
// unauthenticated surface and it needs its own tokenised flow, the way client intake does; adding
// it to an admin router would mean either exposing an admin route or pretending a public one is
// admin. It is the next piece, not a parameter on this one.

const express = require('express');
const { query } = require('../lib/db');
const { authMiddleware, requireTier, adminOnly } = require('../lib/core');
const { regionLabel, isRegion, US_ZONES, EUROPE } = require('../lib/labconnect/region');

const router = express.Router();

// discovered → invited → onboarding → active → (paused | rejected)
// Order matters: the directory sorts by it, so the labs needing a decision sit above the ones that
// have had one.
const LAB_STATUS = ['discovered', 'invited', 'onboarding', 'active', 'paused', 'rejected'];
// THE ONLY STATUS AN ORDER MAY GO TO. Exported so the routing code cannot invent its own answer.
const ROUTABLE_STATUS = ['active'];

const asInt = (v, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : dflt; };

// ── GET /labconnect/labs ──────────────────────────────────────────────────────
//
// The directory. Region-wise filterable, which is what it exists for.
//
// WHY THE SUMMARY DOES NOT MOVE WITH THE FILTERS. `summary` is census-wide and describes the whole
// table, not the current view — the same decision the AROS establishments page made, and for the
// same reason: a header that changes with the filter silently redefines "how many labs do we have",
// and somebody reads 40 after filtering to one state and reports it as the national number.
router.get('/labconnect/labs', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const clauses = [];
    const params = [];

    // region is VALIDATED, not interpolated. It arrives from a query string, and isRegion only
    // admits keys the region module itself could have produced.
    if (req.query.region === 'none') {
      // Explicitly asking for the labs whose location could not be determined. A real filter
      // value, because those rows are the ones somebody has to go and fix.
      clauses.push('region IS NULL');
    } else if (req.query.region) {
      if (!isRegion(req.query.region)) {
        return res.status(400).json({ error: `Unknown region '${req.query.region}'` });
      }
      params.push(req.query.region);
      clauses.push(`region = $${params.length}`);
    }

    if (req.query.country) { params.push(String(req.query.country).toUpperCase()); clauses.push(`country = $${params.length}`); }
    if (req.query.state) { params.push(String(req.query.state).toUpperCase()); clauses.push(`state = $${params.length}`); }

    if (req.query.status) {
      const list = String(req.query.status).split(',').map(s => s.trim()).filter(Boolean);
      const bad = list.filter(s => !LAB_STATUS.includes(s));
      if (bad.length) return res.status(400).json({ error: `Unknown status: ${bad.join(', ')}` });
      if (list.length) { params.push(list); clauses.push(`status = ANY($${params.length})`); }
    }

    if (req.query.capability === 'gmp') clauses.push('gmp_capable = true');
    else if (req.query.capability === 'research') clauses.push('research_capable = true');
    else if (req.query.capability === 'none') clauses.push('gmp_capable = false AND research_capable = false');

    // Labs that have priced at least one test — the ones an order could actually be quoted
    // against. A directory of firms with no catalogue is a mailing list.
    if (req.query.priced === 'true') clauses.push('EXISTS (SELECT 1 FROM lab_tests t WHERE t.lab_id = labs.id AND t.price_cents IS NOT NULL)');
    if (req.query.test) {
      params.push(String(req.query.test));
      clauses.push(`EXISTS (SELECT 1 FROM lab_tests t WHERE t.lab_id = labs.id AND t.test_code = $${params.length})`);
    }

    if (req.query.q) {
      params.push('%' + String(req.query.q).trim() + '%');
      clauses.push(`(name ILIKE $${params.length} OR city ILIKE $${params.length})`);
    }

    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const page = Math.max(1, asInt(req.query.page, 1));
    const pageSize = Math.min(200, Math.max(1, asInt(req.query.pageSize, 50)));

    const total = (await query(`SELECT COUNT(*)::int n FROM labs ${where}`, params)).rows[0].n;

    // NO TABLE ALIAS. The filter clauses above are built against `labs` — the `priced` and `test`
    // filters say `WHERE t.lab_id = labs.id` — so aliasing the table here would leave those
    // subqueries referring to a name that no longer exists. The first version of this aliased to
    // `l` and rewrote the clause text with a regex, which is the kind of fix that works until one
    // clause spells it differently.
    const items = (await query(
      `SELECT labs.id, labs.name, labs.city, labs.state, labs.country, labs.region,
              labs.status, labs.status_note, labs.source,
              labs.contact_name, labs.contact_email, labs.contact_phone, labs.website,
              labs.research_capable, labs.gmp_capable, labs.fei_number, labs.notes,
              jsonb_array_length(labs.accreditations) AS accreditation_count,
              (SELECT COUNT(*)::int FROM lab_tests t WHERE t.lab_id = labs.id) AS test_count,
              (SELECT COUNT(*)::int FROM lab_tests t
                WHERE t.lab_id = labs.id AND t.price_cents IS NOT NULL) AS priced_count,
              (SELECT MIN(t.turnaround_days) FROM lab_tests t WHERE t.lab_id = labs.id) AS fastest_days
         FROM labs ${where}
        -- The labs needing a decision first, then the ones with a real catalogue, then by name.
        -- Alphabetical-only would bury every actionable row behind an "A" with no tests priced.
        ORDER BY array_position($${params.length + 1}::text[], labs.status),
                 (SELECT COUNT(*) FROM lab_tests t WHERE t.lab_id = labs.id) DESC,
                 labs.name
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      [...params, LAB_STATUS])).rows;

    // Census-wide, filters ignored. See the note above.
    const summary = (await query(
      `SELECT COUNT(*)::int total,
              COUNT(*) FILTER (WHERE status = 'discovered')::int discovered,
              COUNT(*) FILTER (WHERE status = 'invited')::int invited,
              COUNT(*) FILTER (WHERE status = 'onboarding')::int onboarding,
              COUNT(*) FILTER (WHERE status = 'active')::int active,
              COUNT(*) FILTER (WHERE status IN ('paused','rejected'))::int closed,
              COUNT(*) FILTER (WHERE region IS NULL)::int no_region,
              COUNT(*) FILTER (WHERE contact_email IS NOT NULL)::int contactable,
              COUNT(*) FILTER (WHERE gmp_capable)::int gmp,
              COUNT(*) FILTER (WHERE research_capable)::int research
         FROM labs`)).rows[0];

    const regions = (await query(
      `SELECT region, COUNT(*)::int n,
              COUNT(*) FILTER (WHERE status = 'active')::int active
         FROM labs GROUP BY region ORDER BY n DESC`)).rows
      .map(r => ({ region: r.region, label: regionLabel(r.region), n: r.n, active: r.active }));

    const states = (await query(
      `SELECT state, COUNT(*)::int n FROM labs
        WHERE country = 'USA' AND state IS NOT NULL GROUP BY state ORDER BY state`)).rows;

    const tests = (await query(
      `SELECT c.code, c.name, c.category, c.gmp_relevant,
              COUNT(t.id)::int labs,
              COUNT(t.price_cents)::int priced,
              MIN(t.price_cents) AS min_price_cents,
              MAX(t.price_cents) AS max_price_cents
         FROM test_catalogue c LEFT JOIN lab_tests t ON t.test_code = c.code
        WHERE c.active GROUP BY c.code, c.name, c.category, c.gmp_relevant, c.sort_order
        ORDER BY c.sort_order`)).rows;

    res.json({
      page, pageSize, total, items, summary,
      facets: { regions, states, tests, statuses: LAB_STATUS, us_zones: US_ZONES, europe: EUROPE },
      // Said out loud in the payload, because it is the single most important fact about this
      // table and the screen must not have to infer it from a status list.
      routable_status: ROUTABLE_STATUS,
      can_manage: !!(req.user && ['super_admin', 'admin'].includes(req.user.role)),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /labconnect/labs/:id ──────────────────────────────────────────────────
router.get('/labconnect/labs/:id', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const lab = (await query(`SELECT * FROM labs WHERE id = $1`, [req.params.id])).rows[0];
    if (!lab) return res.status(404).json({ error: 'No such lab' });
    const tests = (await query(
      `SELECT t.*, c.name AS test_name, c.category, c.typical_method, c.gmp_relevant
         FROM lab_tests t JOIN test_catalogue c ON c.code = t.test_code
        WHERE t.lab_id = $1 ORDER BY c.sort_order`, [req.params.id])).rows;
    res.json({
      lab: { ...lab, region_label: regionLabel(lab.region) },
      tests,
      routable: ROUTABLE_STATUS.includes(lab.status),
      // WHY it is not routable, in words, because "false" on its own sends somebody to the code.
      not_routable_because: ROUTABLE_STATUS.includes(lab.status) ? null
        : `status is '${lab.status}' — only ${ROUTABLE_STATUS.join(', ')} may receive an order`,
      can_manage: !!(req.user && ['super_admin', 'admin'].includes(req.user.role)),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /labconnect/labs/:id ──────────────────────────────────────────────────
//
// adminOnly. The field that matters is `status`: moving a lab to 'active' is the moment it becomes
// routable, and that is a statement that a real firm has agreed to receive client samples.
router.put('/labconnect/labs/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const before = (await query(`SELECT * FROM labs WHERE id = $1`, [req.params.id])).rows[0];
    if (!before) return res.status(404).json({ error: 'No such lab' });

    const sets = [];
    const params = [];
    const changed = [];
    const put = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); changed.push(col); };

    if (req.body.status !== undefined) {
      if (!LAB_STATUS.includes(req.body.status)) {
        return res.status(400).json({ error: `Unknown status '${req.body.status}'. One of: ${LAB_STATUS.join(', ')}` });
      }
      // GOING ACTIVE REQUIRES A REASON ON THE RECORD. Not bureaucracy: this is the status that
      // makes a firm eligible to receive a client's sample, and six months later somebody will
      // need to know who agreed to that and on what basis. A note is the cheapest possible
      // version of that record, and the alternative is a status nobody can account for.
      if (req.body.status === 'active' && before.status !== 'active') {
        const note = String(req.body.status_note || '').trim();
        if (note.length < 3) {
          return res.status(400).json({
            error: 'Moving a lab to active makes it eligible to receive client samples. '
                 + 'Say what they agreed to, in status_note.',
            code: 'note_required',
          });
        }
      }
      put('status', req.body.status);
    }
    if (req.body.status_note !== undefined) put('status_note', req.body.status_note || null);
    for (const col of ['contact_name', 'contact_email', 'contact_phone', 'website', 'notes']) {
      if (req.body[col] !== undefined) put(col, req.body[col] || null);
    }
    for (const col of ['research_capable', 'gmp_capable']) {
      if (req.body[col] !== undefined) put(col, !!req.body[col]);
    }
    if (req.body.accreditations !== undefined) {
      if (!Array.isArray(req.body.accreditations)) {
        return res.status(400).json({ error: 'accreditations must be an array' });
      }
      put('accreditations', JSON.stringify(req.body.accreditations));
    }

    if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });
    params.push(req.params.id);
    const lab = (await query(
      `UPDATE labs SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${params.length} RETURNING *`, params)).rows[0];

    res.json({
      lab: { ...lab, region_label: regionLabel(lab.region) },
      changed,
      note: `${lab.name}: ${changed.join(', ')} updated`
          + (changed.includes('status') ? ` — now ${lab.status}` : ''),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /labconnect/labs/:id/tests ────────────────────────────────────────────
//
// The lab's catalogue and its own prices, saved WHOLE. The same decision the SiteNex payment
// schedule made: the invariant is about the set, so it is edited and replaced as a set rather than
// patched row by row, which cannot leave a half-updated catalogue behind.
router.put('/labconnect/labs/:id/tests', authMiddleware, adminOnly, async (req, res) => {
  try {
    const lab = (await query(`SELECT id, name FROM labs WHERE id = $1`, [req.params.id])).rows[0];
    if (!lab) return res.status(404).json({ error: 'No such lab' });
    if (!Array.isArray(req.body.tests)) return res.status(400).json({ error: 'tests must be an array' });

    const codes = (await query(`SELECT code FROM test_catalogue WHERE active`)).rows.map(r => r.code);
    const rows = [];
    for (const [i, t] of req.body.tests.entries()) {
      if (!t || !codes.includes(t.test_code)) {
        return res.status(400).json({ error: `tests[${i}]: '${t && t.test_code}' is not a catalogue test code` });
      }
      // '' means "no price given", NOT zero. A blank price must never become free — the same rule
      // the packages screen follows.
      const price = (t.price_cents === '' || t.price_cents == null) ? null : Math.round(Number(t.price_cents));
      if (price !== null && (!Number.isFinite(price) || price < 0)) {
        return res.status(400).json({ error: `tests[${i}]: price must be a non-negative amount or empty` });
      }
      const days = (t.turnaround_days === '' || t.turnaround_days == null) ? null : Math.round(Number(t.turnaround_days));
      rows.push({ test_code: t.test_code, price_cents: price, turnaround_days: days,
                  currency: t.currency || 'USD', accredited: !!t.accredited, gmp: !!t.gmp,
                  notes: t.notes || null });
    }
    const dup = rows.map(r => r.test_code).find((c, i, a) => a.indexOf(c) !== i);
    if (dup) return res.status(400).json({ error: `'${dup}' appears twice — one price per test` });

    await query(`DELETE FROM lab_tests WHERE lab_id = $1`, [lab.id]);
    for (const r of rows) {
      await query(
        `INSERT INTO lab_tests (lab_id, test_code, price_cents, currency, turnaround_days,
                                accredited, gmp, notes)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [lab.id, r.test_code, r.price_cents, r.currency, r.turnaround_days, r.accredited, r.gmp, r.notes]);
    }
    const priced = rows.filter(r => r.price_cents !== null).length;
    res.json({
      lab_id: lab.id, count: rows.length, priced,
      note: rows.length
        ? `${lab.name}: ${rows.length} test${rows.length === 1 ? '' : 's'}, ${priced} priced`
        : `${lab.name}: catalogue cleared`,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /labconnect/tests ─────────────────────────────────────────────────────
// The catalogue, with how many labs run each test and the price spread across them. This is the
// view that makes "labs set their own prices" workable: without the spread, a quote has no context.
router.get('/labconnect/tests', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const tests = (await query(
      `SELECT c.code, c.name, c.category, c.typical_method, c.gmp_relevant,
              COUNT(t.id)::int labs,
              COUNT(t.price_cents)::int priced,
              MIN(t.price_cents) AS min_price_cents,
              MAX(t.price_cents) AS max_price_cents,
              ROUND(AVG(t.price_cents))::int AS avg_price_cents,
              MIN(t.turnaround_days) AS fastest_days
         FROM test_catalogue c
         LEFT JOIN lab_tests t ON t.test_code = c.code
         LEFT JOIN labs l ON l.id = t.lab_id AND l.status = 'active'
        WHERE c.active
        GROUP BY c.code, c.name, c.category, c.typical_method, c.gmp_relevant, c.sort_order
        ORDER BY c.sort_order`)).rows;
    res.json({ tests, routable_status: ROUTABLE_STATUS });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.LAB_STATUS = LAB_STATUS;
module.exports.ROUTABLE_STATUS = ROUTABLE_STATUS;
