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
const { query, withTransaction } = require('../lib/db');
const { authMiddleware, requireTier, adminOnly } = require('../lib/core');
const { regionFor, regionLabel, isRegion, US_ZONES, EUROPE } = require('../lib/labconnect/region');
const { outsourcerSql, SIBLING_ANALYSIS_SQL, segmentFor, likelyTests, SEGMENTS } =
  require('../lib/labconnect/buyers');
const { matchLabs, describeRouting } = require('../lib/labconnect/match');
const { emailContent, callContent } = require('../lib/labconnect/outreach-content');

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

// ── GET /labconnect/buyers ────────────────────────────────────────────────────
//
// The agent's prospect list: sites that make product and hold no ANALYSIS registration, so their
// testing is going outside today. See src/lib/labconnect/buyers.js for why that is the signal and
// the three ways it is wrong.
router.get('/labconnect/buyers', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const { sql: outsourcer, params, nextIndex } = outsourcerSql(1);
    const clauses = [outsourcer];
    let i = nextIndex;

    // THE FALSE POSITIVE, AS A FILTER RATHER THAN A FOOTNOTE. A firm with a laboratory at another
    // site is not an outsourcer. Excluded by default — the agent should not have to remember — and
    // `include_siblings=true` opts back in for someone auditing the signal itself.
    if (req.query.include_siblings !== 'true') clauses.push(`NOT ${SIBLING_ANALYSIS_SQL}`);

    if (req.query.country) { params.push(String(req.query.country).toUpperCase()); clauses.push(`country = $${i++}`); }
    // Only firms we can actually write to. An uncontactable row is a statistic, not a prospect.
    if (req.query.contactable !== 'false') {
      clauses.push(`(establishment_contact_email IS NOT NULL OR registrant_contact_email IS NOT NULL)`);
    }
    // An FDA exclusion flag is the agency saying something about the firm. Never a prospect.
    clauses.push(`(exclusion_flag IS NULL OR btrim(exclusion_flag) = '')`);
    if (req.query.q) { params.push('%' + String(req.query.q).trim() + '%'); clauses.push(`firm_name ILIKE $${i++}`); }

    const where = 'WHERE ' + clauses.join(' AND ');
    const page = Math.max(1, asInt(req.query.page, 1));
    const pageSize = Math.min(200, Math.max(1, asInt(req.query.pageSize, 50)));

    const total = (await query(`SELECT COUNT(*)::int n FROM fda_establishments ${where}`, params)).rows[0].n;
    const rows = (await query(
      `SELECT id, firm_name, address, country, operations, is_api_manufacturer, is_us_agent,
              fei_number, establishment_contact_name, establishment_contact_email,
              registrant_contact_email
         FROM fda_establishments ${where}
        ORDER BY country, firm_name
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params)).rows;

    // Segment and region are DERIVED, in the modules that own those decisions, rather than in SQL.
    const items = rows.map(r => {
      const { segment, confidence } = segmentFor(r);
      const { region, state } = regionFor(r);
      return {
        id: r.id, firm_name: r.firm_name, country: r.country, state,
        region, region_label: regionLabel(region),
        operations: r.operations, is_api_manufacturer: r.is_api_manufacturer,
        fei_number: r.fei_number,
        contact_name: r.establishment_contact_name,
        contact_email: r.establishment_contact_email || r.registrant_contact_email,
        // A registrant address is frequently a US agent rather than the firm. Flagged, because the
        // agent's email reads differently when it is going to an intermediary.
        contact_is_registrant: !r.establishment_contact_email && !!r.registrant_contact_email,
        segment, segment_label: (SEGMENTS[segment] && SEGMENTS[segment].label) || 'Unclassified',
        segment_confidence: confidence,
        segment_needs: (SEGMENTS[segment] && SEGMENTS[segment].needs) || null,
        likely_tests: likelyTests(segment),
      };
    });

    const bySegment = {};
    for (const it of items) bySegment[it.segment] = (bySegment[it.segment] || 0) + 1;

    res.json({
      page, pageSize, total, items,
      facets: { segments: SEGMENTS, counts_on_page: bySegment },
      // THE SIGNAL, STATED ON THE PAYLOAD. A list this long looks authoritative, and whoever reads
      // it should know it is an inference from a registration and not a declared need.
      signal: 'Registered to make product, not registered for analysis — so their testing goes '
            + 'outside today. Almost all of them already have a provider, which makes this a '
            + 'displacement sale rather than a new need.',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /labconnect/buyers/:id/content ────────────────────────────────────────
//
// The email and the phone script for one buyer. The CAPABILITY is read here, from active labs only,
// and handed to a pure generator — so the content cannot offer a test no lab runs, and the rule
// lives in one place rather than in a template.
router.get('/labconnect/buyers/:id/content', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const row = (await query(
      `SELECT id, firm_name, address, country, operations, is_api_manufacturer, is_us_agent,
              establishment_contact_name, establishment_contact_email, registrant_contact_email
         FROM fda_establishments WHERE id = $1`, [req.params.id])).rows[0];
    if (!row) return res.status(404).json({ error: 'No such establishment' });

    const { segment, confidence } = segmentFor(row);
    const buyer = {
      id: row.id, firm_name: row.firm_name, segment,
      contact_email: row.establishment_contact_email || row.registrant_contact_email,
      contact_name: row.establishment_contact_name,
    };

    // ACTIVE LABS ONLY. The join condition carries the status, not the WHERE clause, so a test with
    // no active lab comes back with labs = 0 rather than vanishing — the generator needs to know a
    // test exists and cannot be placed, which is different from it not existing.
    const capability = (await query(
      `SELECT c.code AS test_code,
              COUNT(t.id)::int labs,
              MIN(t.price_cents) AS min_price_cents,
              MIN(t.turnaround_days) AS fastest_days
         FROM test_catalogue c
         LEFT JOIN labs l ON l.status = 'active'
         LEFT JOIN lab_tests t ON t.test_code = c.code AND t.lab_id = l.id
        WHERE c.active
        GROUP BY c.code, c.sort_order ORDER BY c.sort_order`)).rows;

    const email = emailContent(buyer, capability);
    const call = callContent(buyer, capability);
    res.json({
      buyer: { ...buyer, segment_confidence: confidence,
               segment_label: (SEGMENTS[segment] && SEGMENTS[segment].label) || 'Unclassified' },
      email, call,
      capability: capability.filter(c => c.labs > 0),
      // Said separately from `email.ok` so the screen can explain an empty result without parsing prose.
      placeable_tests: capability.filter(c => c.labs > 0).length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /labconnect/orders ───────────────────────────────────────────────────
//
// Create an order and route it in one call, because an unrouted order is not useful to anybody and
// a two-step flow invites the second step to be forgotten. adminOnly: this is the write that ends
// with a client's sample going to a named company.
router.post('/labconnect/orders', authMiddleware, adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.client_company || !String(b.client_company).trim()) {
      return res.status(400).json({ error: 'client_company is required — an order needs a client' });
    }
    const test = (await query(`SELECT code, name, gmp_relevant FROM test_catalogue WHERE code = $1 AND active`,
      [b.test_code])).rows[0];
    if (!test) return res.status(400).json({ error: `'${b.test_code}' is not an active catalogue test` });

    const order = {
      test_code: test.code,
      gmp: !!b.gmp,
      require_accredited: !!b.require_accredited,
      country: b.restrict_country ? String(b.restrict_country).toUpperCase() : null,
      region: b.client_region || null,
    };

    // The candidate labs, with their catalogues. Every lab is fetched, not just the active ones:
    // the matcher's rejection list is what explains an unroutable order, and "none of them is
    // active" is only sayable if the non-active ones were seen.
    const labs = (await query(
      `SELECT l.id, l.name, l.status, l.region, l.country, l.gmp_capable, l.research_capable,
              COALESCE(json_agg(json_build_object(
                'test_code', t.test_code, 'price_cents', t.price_cents,
                'turnaround_days', t.turnaround_days, 'accredited', t.accredited, 'gmp', t.gmp
              )) FILTER (WHERE t.id IS NOT NULL), '[]'::json) AS tests
         FROM labs l LEFT JOIN lab_tests t ON t.lab_id = l.id
        GROUP BY l.id ORDER BY l.id`)).rows;

    const result = matchLabs(order, labs);

    const orderNo = 'LC-' + new Date().getFullYear() + '-'
      + String((await query(`SELECT nextval('lab_order_no_seq') AS n`)).rows[0].n).padStart(4, '0');
    const best = result.matches[0] || null;

    const created = (await withTransaction(async (tx) => {
      const row = (await tx.query(
        `INSERT INTO lab_orders (order_no, client_company, client_contact, client_email,
            fda_establishment_id, segment, test_code, matrix, sample_count, gmp, require_accredited,
            restrict_country, client_region, lab_id, lab_name, price_cents, turnaround_days,
            commission_bps, status, routed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         RETURNING *`,
        [orderNo, String(b.client_company).trim(), b.client_contact || null, b.client_email || null,
         b.fda_establishment_id || null, b.segment || null, test.code, b.matrix || null,
         Math.max(1, asInt(b.sample_count, 1)), order.gmp, order.require_accredited,
         order.country, order.region,
         best ? best.lab.id : null, best ? best.lab.name : null,
         best ? best.price_cents : null, best ? best.turnaround_days : null,
         b.commission_bps == null ? null : asInt(b.commission_bps, null),
         best ? 'routed' : 'new', best ? new Date().toISOString() : null])).rows[0];

      // THE AUDIT. Every lab the matcher looked at, matched or rejected, with the reason as shown at
      // this moment — see the migration for why this is written now and never reconstructed later.
      for (const [idx, m] of result.matches.entries()) {
        await tx.query(
          `INSERT INTO lab_order_routes (order_id, lab_id, lab_name, outcome, reason, rank,
              price_cents, turnaround_days, same_region, chosen)
           VALUES ($1,$2,$3,'matched',NULL,$4,$5,$6,$7,$8)`,
          [row.id, m.lab.id, m.lab.name, idx + 1, m.price_cents, m.turnaround_days,
           m.same_region, idx === 0]);
      }
      for (const r of result.rejected) {
        await tx.query(
          `INSERT INTO lab_order_routes (order_id, lab_id, lab_name, outcome, reason, chosen)
           VALUES ($1,$2,$3,$4,$5,false)`,
          [row.id, r.lab.id || null, r.lab.name || '(unnamed)', r.code, r.reason]);
      }
      return row;
    }));

    res.status(201).json({
      order: created,
      routing: {
        routable: result.routable,
        why_not: result.why_not,
        summary: describeRouting(result, order),
        considered: result.matches.length + result.rejected.length,
        matched: result.matches.map(m => ({
          lab_id: m.lab.id, lab_name: m.lab.name, same_region: m.same_region,
          price_cents: m.price_cents, turnaround_days: m.turnaround_days, needs_quote: m.needs_quote,
        })),
        rejected: result.rejected.map(r => ({ lab_id: r.lab.id, lab_name: r.lab.name, code: r.code, reason: r.reason })),
      },
      note: result.routable
        ? `${orderNo} created and routed to ${best.lab.name}.`
        : `${orderNo} created but NOT routed — ${result.why_not}.`,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /labconnect/orders ────────────────────────────────────────────────────
router.get('/labconnect/orders', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const orders = (await query(
      `SELECT o.*, c.name AS test_name,
              (SELECT COUNT(*)::int FROM lab_order_routes r WHERE r.order_id = o.id) AS considered
         FROM lab_orders o JOIN test_catalogue c ON c.code = o.test_code
        ORDER BY o.created_at DESC LIMIT 200`)).rows;
    const summary = (await query(
      `SELECT COUNT(*)::int total,
              COUNT(*) FILTER (WHERE lab_id IS NULL)::int unrouted,
              COUNT(*) FILTER (WHERE gmp)::int gmp,
              COALESCE(SUM(price_cents), 0)::bigint lab_value_cents
         FROM lab_orders`)).rows[0];
    res.json({ orders, summary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /labconnect/orders/:id ────────────────────────────────────────────────
// With its routing audit, which is the reason the table exists.
router.get('/labconnect/orders/:id', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const order = (await query(
      `SELECT o.*, c.name AS test_name, c.typical_method
         FROM lab_orders o JOIN test_catalogue c ON c.code = o.test_code
        WHERE o.id = $1`, [req.params.id])).rows[0];
    if (!order) return res.status(404).json({ error: 'No such order' });
    const routes = (await query(
      `SELECT * FROM lab_order_routes WHERE order_id = $1
        ORDER BY chosen DESC, rank NULLS LAST, lab_name`, [req.params.id])).rows;
    res.json({
      order, routes,
      // Grouped, because "five labs rejected for not_gmp_test" is a sales fact — nobody has priced
      // that method under GMP — wearing the clothes of a routing failure.
      rejected_by_reason: routes.filter(r => r.outcome !== 'matched')
        .reduce((acc, r) => { acc[r.outcome] = (acc[r.outcome] || 0) + 1; return acc; }, {}),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.LAB_STATUS = LAB_STATUS;
module.exports.ROUTABLE_STATUS = ROUTABLE_STATUS;
