// ── PRPA — THE AUTHENTICATED HTTP SURFACE FOR THE FEDERAL CONTRACT TRACKER ───
//
// Ruling 27 item 1. The library and the schema were built and tested before this file existed; this
// is the surface that makes them reachable from a browser, and nothing more. No business logic
// lives here that is not about HTTP: parsing a request, checking a permission, calling the library,
// shaping a response.
//
// ── WHAT THIS ROUTER WILL NOT DO ─────────────────────────────────────────────
//
// There is no endpoint that contacts a contracting officer, submits a bid, emails anybody, or
// starts an unattended harvest. Those are not omissions to be filled in later: ruling 27 item 10
// withholds the first two, the global email HOLD and three capability STOPs cover the third, and
// ruling 22 item 8 keeps SAM.gov an attended manual source. A route that existed but was disabled
// by a flag would be one flag away from doing any of them.
//
// The ONE outbound fetch in this file is POST /prpa/import/url: a human pastes one solicitation URL
// and gets one notice. It is rate-limited, it goes through the SSRF guard, and it writes an audit
// event naming the person who asked. That is manual intake, which ruling 21 item 1 asks for.
//
// ── PERMISSIONS ──────────────────────────────────────────────────────────────
//
// Federal procurement is the `procurement` tier. Every route carries authMiddleware (mounted by
// server.js), staffOnly, and a tier check:
//
//   read   requireTier('procurement') with GET            → procurement r/rw/own
//   write  requireTier('procurement') with POST           → procurement rw/w/own
//
// Two routes are stricter than the tier, and the reason is written at each:
//   POST /prpa/opportunities/:id/review with decision 'bid'   → adminOnly
//   POST /prpa/assess                                         → adminOnly
//
// `own` deliberately does NOT get row filtering here. Opportunities are company-scoped, not
// person-scoped: a federal notice is not owned by whoever imported it, and filtering a shared board
// by importer would hide most of it from the person reviewing. A role holding procurement:'own'
// (procurement_team) sees the whole board, which is the intent — it is the WRITE routes that matter,
// and those are gated above.

'use strict';

const express = require('express');
const { query, withTransaction } = require('../lib/db');
const { staffOnly, adminOnly, requireTier } = require('../lib/core');
const T = require('../lib/office/opportunity-tracker');
const REG = require('../lib/office/capability-registry');
const RANK = require('../lib/office/opportunity-rank');
const AUDIT = require('../lib/office/opportunity-audit');
const { assessFeasibility } = require('../lib/office/fulfillment-feasibility');
const { relevantLines } = require('../lib/office/opportunity-qualify');
const { isoDay } = require('../lib/office/iso-day');
const { fetchDocument } = require('../lib/office/url-guard');
const { normalizeRow, mapHeaders, contentHash } = require('../lib/office/opportunity-normalize');
const DATASET = require('../lib/office/prpa-dataset');

// ── WHY EVERY PATH HERE IS /prpa/tracker/* AND NOT /prpa/* ──────────────────
//
// routes.js already declares /prpa/review-queue, /prpa/capabilities, /prpa/opportunities,
// /prpa/connectors, /prpa/tasks and /prpa/export/opportunities.csv, and server.js mounts routes.js
// FIRST. The first mount wins, so a path declared in both becomes dead code in the second — this
// router's handlers would never have run, and the only symptom would have been the old page's data
// appearing on the new one.
//
// Those older endpoints serve the existing "Federal Pipeline" page and have different semantics
// (its review queue is by criterion, not by opportunity). Replacing them would break that page, so
// this surface takes its own prefix instead. scripts/check-prpa-route-collisions.js fails the build
// if the two files ever declare the same path.
const router = express.Router();

// ── limits ───────────────────────────────────────────────────────────────────
// A pasted CSV is a text body, and the body parser's own limit is generous for JSON. 6 MB is about
// 25,000 SAM rows — far more than a manual paste — and refusing above it is cheaper than importing it.
const MAX_CSV_BYTES = 6 * 1024 * 1024;
const MAX_URL_FETCH_BYTES = 4 * 1024 * 1024;

// Manual URL intake is rate-limited per user, in memory. In-memory is honest about what it is: one
// process, reset on restart. It is here to stop a loop in a browser tab turning an attended tool
// into the unattended harvester ruling 22 item 8 forbids, not to defend against an attacker who
// already holds a staff token.
const URL_INTAKE_WINDOW_MS = 60_000;
const URL_INTAKE_MAX_PER_WINDOW = 10;
const urlIntakeHits = new Map();

function urlIntakeAllowed(userId) {
  const now = Date.now();
  const hits = (urlIntakeHits.get(userId) || []).filter((t) => now - t < URL_INTAKE_WINDOW_MS);
  if (hits.length >= URL_INTAKE_MAX_PER_WINDOW) {
    urlIntakeHits.set(userId, hits);
    return { allowed: false, retryInMs: URL_INTAKE_WINDOW_MS - (now - hits[0]) };
  }
  hits.push(now);
  urlIntakeHits.set(userId, hits);
  return { allowed: true };
}

// ── company resolution ───────────────────────────────────────────────────────
// Every kernel table is company-welded, so every query needs a company id. It comes from the
// database, never from the request: a company_id in a body or a query string would let any staff
// account read another company's board by changing one parameter.
async function resolveCompany(req, res, next) {
  try {
    const slug = process.env.PRPA_COMPANY_SLUG || 'abiozen';
    const r = await query(
      // display_name is the column; aliased so the rest of this file reads `.name`.
      `SELECT id, slug, display_name AS name FROM companies
        WHERE slug = $1 AND status = 'active' LIMIT 1`, [slug]);
    if (!r.rows.length) {
      return res.status(503).json({
        error: 'PRPA is not provisioned: no active company record',
        code: 'company_missing',
        detail: `expected an active company with slug "${slug}". Run the migrations and seed the company row.`,
      });
    }
    req.prpaCompany = r.rows[0];
    return next();
  } catch (e) {
    // to_regclass rather than a bare message, so a missing SCHEMA reads differently from a broken DB.
    const missing = /relation "companies" does not exist/i.test(e.message);
    return res.status(503).json({
      error: missing ? 'PRPA schema is not applied' : 'PRPA could not resolve the company',
      code: missing ? 'schema_missing' : 'company_lookup_failed',
      detail: missing ? 'run: node scripts/migrate.js' : e.message,
    });
  }
}

const actorOf = (req) => (req.user && (req.user.email || req.user.id)) || 'unknown';
const roleOf = (req) => (req.user && req.user.role) || null;

// Audit failures are reported, never swallowed and never fatal. See opportunity-audit.js.
async function audit(req, fields) {
  const r = await AUDIT.record(query, {
    companyId: req.prpaCompany.id, actor: actorOf(req), actorRole: roleOf(req), ...fields,
  });
  if (!r.ok) console.error(`[prpa] AUDIT WRITE FAILED action=${fields.action}: ${r.error}`);
  return r;
}

const read = [staffOnly, requireTier('procurement'), resolveCompany];
const write = [staffOnly, requireTier('procurement'), resolveCompany];

// ── 1. DATASET PROVENANCE (ruling 27 item 4) ─────────────────────────────────
// The 253 records are a reproducible DEVELOPMENT dataset, not a live feed. This endpoint is how the
// dashboard knows to say so, and it is served before anything else because every other number on
// the page is qualified by it.
router.get('/prpa/tracker/dataset', read, async (req, res) => {
  try {
    // Column names taken from the schema, not guessed: federal_opportunities records
    // first_seen_at / observed_at (there is no created_at), and a batch records imported_at.
    // Guessing created_at for both made this endpoint 500, and the dashboard's own banner — the one
    // that tells a reader the data is not live — was the thing that failed to load.
    const counts = (await query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE is_current)::int AS current,
              MAX(first_seen_at) AS first_seen,
              MAX(observed_at)   AS last_observed
         FROM federal_opportunities WHERE company_id = $1`, [req.prpaCompany.id])).rows[0];
    const batches = (await query(
      `SELECT id, source, source_detail, source_sha256, imported_by, imported_at
         FROM opportunity_import_batches WHERE company_id = $1 ORDER BY imported_at DESC LIMIT 20`,
      [req.prpaCompany.id])).rows;
    res.json({
      ...DATASET.describe(),
      company: { slug: req.prpaCompany.slug, name: req.prpaCompany.name },
      counts,
      batches,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 2. THE BOARD ─────────────────────────────────────────────────────────────
// One list endpoint feeding one table. Ranking, feasibility and the missing-evidence list are
// computed here rather than stored, so a change to the engine shows up without a re-import — and so
// no stale verdict can outlive the rule that produced it.
router.get('/prpa/tracker/opportunities', read, async (req, res) => {
  try {
    const today = isoDay(new Date());
    const f = {};
    if (req.query.biddableOnly === 'true') f.biddableOnly = true;
    if (req.query.status) f.status = String(req.query.status);
    if (req.query.noticeType) f.noticeType = String(req.query.noticeType);
    if (req.query.businessLine) f.businessLine = String(req.query.businessLine);
    if (req.query.search) f.search = String(req.query.search).slice(0, 120);

    const rows = await T.listOpportunities(query, req.prpaCompany.id, f);
    const caps = await REG.activeCapabilities(query, req.prpaCompany.id, { today });

    // business_lines comes from the qualify engine's line matcher, not from the stored assessment:
    // assess() returns an empty line list for a sources-sought notice because there is nothing to
    // bid on, and feeding that to rank() would zero the fit score for the very notices that are the
    // way in to a recompete.
    const enriched = rows.map((r) => ({ ...r, business_lines: r.business_lines || relevantLines(r).lines }));
    const ranked = RANK.rankAll(enriched, { today, capabilities: caps, supplierQuotes: {} });

    res.json({
      dataset: DATASET.describe(),
      today,
      verified_capabilities: caps.length,
      count: ranked.length,
      opportunities: ranked.map(shapeForBoard),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Exactly the columns ruling 27 item 2 names, plus what is needed to act on a row. Shaped in one
// place so the board, the detail view and the export cannot drift apart.
function shapeForBoard(r) {
  const feas = r.ranking.feasibility;
  return {
    id: r.id,
    solicitation_number: r.solicitation_number,
    notice_id: r.notice_id,
    title: r.title,
    agency: r.agency || null,
    // An unpopulated agency is reported as unconfirmed rather than blank: SAM's search index leaves
    // this empty for some notices, and a blank cell reads as "no agency" instead of "not stated".
    agency_confirmed: Boolean(r.agency),
    sub_agency: r.sub_agency || null,
    office: r.office || null,
    naics_code: r.naics_code || null,
    psc_code: r.psc_code || null,
    notice_type: r.notice_type,
    status: r.status,
    set_aside: r.set_aside || null,
    set_aside_stated: Boolean(r.set_aside),
    response_deadline: isoDay(r.response_deadline),
    deadline_confirmed: Boolean(r.deadline_confirmed_at),
    deadline_confirmed_at: r.deadline_confirmed_at || null,
    deadline_source_text: r.deadline_source_text || null,
    is_biddable: r.is_biddable,
    estimated_value_usd: r.estimated_value_usd || null,
    place_of_performance: r.place_of_performance || null,
    source_url: r.source_url || null,

    // "Required products/services" — what the notice asks for, as far as the notice says. The
    // product class IS the answer to that question when it resolves, and 'unknown' is reported as
    // unknown rather than dressed up.
    requested: {
      product_class: feas.product_class,
      basis: feas.basis,
      manufacturer: feas.manufacturer || null,
      description_available: Boolean(r.description && String(r.description).trim()),
      excerpt: r.description ? String(r.description).replace(/\s+/g, ' ').trim().slice(0, 400) : null,
    },

    feasibility: {
      verdict: feas.verdict,
      confidence: feas.confidence,
      blockers: feas.blockers,
      checks: feas.checks,
    },
    missing_evidence: feas.unknowns || [],

    qualification: {
      verdict: r.verdict || null,
      evidence_basis: r.evidence_basis || null,
      business_lines: r.business_lines || [],
      reasons: r.reasons || [],
      missing_requirements: r.missing_requirements || [],
    },

    ranking: {
      score: r.ranking.score,
      tier: r.ranking.tier,
      bars: r.ranking.bars,
      flags: r.ranking.flags || [],
      notes: r.ranking.notes,
      components: r.ranking.components,
    },

    // listOpportunities ALIASES the review columns (bid_decision, bid_decided_by, …) because the
    // assessment join already supplies `verdict` and a bare `decision` would be ambiguous beside
    // it. Reading r.decision returned undefined for every row, so a recorded decision never
    // appeared on the board — the API said it was saved and the board showed nothing.
    review: r.bid_decision ? {
      decision: r.bid_decision,
      decided_by: r.bid_decided_by,
      decided_at: r.bid_decided_at,
      rationale: r.bid_rationale,
    } : null,
  };
}

// ── 3. ONE OPPORTUNITY, WITH ITS WHOLE HISTORY ───────────────────────────────
router.get('/prpa/tracker/opportunities/:id', read, async (req, res) => {
  try {
    const h = await AUDIT.history(query, req.prpaCompany.id, String(req.params.id));
    if (!h) return res.status(404).json({ error: 'not found' });
    const today = isoDay(new Date());
    const caps = await REG.activeCapabilities(query, req.prpaCompany.id, { today });
    const o = { ...h.opportunity, business_lines: relevantLines(h.opportunity).lines };
    const ranking = RANK.rank(o, { today, capabilities: caps, supplierQuotes: {} });
    res.json({
      dataset: DATASET.describe(),
      opportunity: shapeForBoard({ ...o, ranking }),
      versions: h.versions,
      assessments: h.assessments,
      reviews: h.reviews,
      audit_events: h.audit_events,
      duplicate_candidates: h.duplicate_candidates,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 4. MANUAL INTAKE — CSV ───────────────────────────────────────────────────
router.post('/prpa/tracker/import/csv', write, async (req, res) => {
  try {
    const csvText = typeof req.body.csv === 'string' ? req.body.csv : null;
    if (!csvText || !csvText.trim()) {
      return res.status(400).json({ error: 'csv is required (the file contents as text)' });
    }
    if (Buffer.byteLength(csvText, 'utf8') > MAX_CSV_BYTES) {
      return res.status(413).json({ error: `csv exceeds ${MAX_CSV_BYTES} bytes` });
    }
    const sourceDetail = String(req.body.sourceDetail || '').slice(0, 500)
      || 'manual CSV upload (no description given)';

    const r = await T.importCsv(query, {
      companyId: req.prpaCompany.id, importedBy: actorOf(req), csvText, sourceDetail,
    });

    await audit(req, {
      action: 'import.csv',
      detail: {
        batch_id: r.batchId || null,
        sha256: r.sha256,
        source_detail: sourceDetail,
        inserted: r.outcome.inserted.length,
        amended: r.outcome.amended.length,
        unchanged: r.outcome.unchanged.length,
        rejected: r.outcome.rejected.length,
        unmatched_headers: r.unmatchedHeaders,
      },
    });
    // An amendment is its own event against the row it supersedes — that is what a reviewer looks
    // for when a deadline changed under an assessment.
    for (const a of r.outcome.amended) {
      await audit(req, {
        action: 'amendment.recorded', opportunityId: a.id,
        detail: { solicitation_number: a.solicitation_number, version: a.version },
      });
    }
    // duplicateCandidates carries solicitation NUMBERS, not row ids, so the audit event is written
    // against the whole import rather than against a row it cannot name. The candidate row itself
    // holds both ids and is served by /prpa/duplicates.
    for (const d of (r.outcome.duplicateCandidates || [])) {
      await audit(req, {
        action: 'duplicate.flagged',
        detail: { a: d.a, b: d.b, similarity: d.similarity },
      });
    }
    for (const rj of r.outcome.rejected.slice(0, 50)) {
      await audit(req, { action: 'import.rejected', detail: { issues: rj.issues } });
    }

    res.json({
      ok: true,
      dataset: DATASET.describe(),
      batch_id: r.batchId || null,
      sha256: r.sha256,
      inserted: r.outcome.inserted.length,
      amended: r.outcome.amended.length,
      unchanged: r.outcome.unchanged.length,
      rejected: r.outcome.rejected,
      issues: r.issues,
      unmatched_headers: r.unmatchedHeaders,
      duplicate_candidates: r.outcome.duplicateCandidates || [],
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 5. MANUAL INTAKE — ONE SOLICITATION URL ──────────────────────────────────
//
// Human-initiated, one notice at a time, through the SSRF guard. The notice id is taken from a
// sam.gov URL and the record is fetched from the endpoint that is known to work — including the
// detail that it answers `Accept: application/json` with HTTP 406, so the guard must not send one.
router.post('/prpa/tracker/import/url', write, async (req, res) => {
  const gate = urlIntakeAllowed((req.user && req.user.id) || actorOf(req));
  if (!gate.allowed) {
    return res.status(429).json({
      error: 'manual URL intake is rate limited',
      code: 'rate_limited',
      detail: `at most ${URL_INTAKE_MAX_PER_WINDOW} per minute. This is an attended tool, not a harvester.`,
      retry_in_ms: gate.retryInMs,
    });
  }
  try {
    const raw = String(req.body.url || '').trim();
    if (!raw) return res.status(400).json({ error: 'url is required' });

    // sam.gov/opp/<noticeId>/view, or the bare 32-hex notice id.
    const m = raw.match(/\/opp\/([0-9a-f]{32})\b/i) || raw.match(/^([0-9a-f]{32})$/i);
    if (!m) {
      return res.status(400).json({
        error: 'not a recognised SAM.gov opportunity URL',
        detail: 'expected https://sam.gov/opp/<32-hex notice id>/view, or the notice id itself',
      });
    }
    const noticeId = m[1].toLowerCase();

    let rec;
    try {
      // The guard sends `Accept: */*` and does not take custom headers — which is exactly right
      // here: sam.gov answers `Accept: application/json` on this endpoint with HTTP 406, and not
      // being able to override the header is what keeps that mistake out.
      rec = await fetchDocument(`https://sam.gov/api/prod/opps/v2/opportunities/${noticeId}`, {
        maxBytes: MAX_URL_FETCH_BYTES,
      });
    } catch (e) {
      return res.status(502).json({ error: 'could not fetch the notice', detail: e.message });
    }

    let doc;
    try { doc = JSON.parse(rec.buffer.toString('utf8')); } catch { return res.status(502).json({ error: 'the notice did not parse as JSON' }); }
    const record = samV2ToRecord(doc, noticeId);
    if (!record.ok) return res.status(422).json({ error: record.error, notice_id: noticeId });

    const batchId = await T.createBatch(query, {
      companyId: req.prpaCompany.id, source: 'url', importedBy: actorOf(req),
      sourceDetail: `manual URL intake — https://sam.gov/opp/${noticeId}/view `
        + '(record via sam.gov/api/prod/opps/v2; UNDOCUMENTED endpoint, attended use only)',
    });
    const out = await T.importRecords(query, {
      companyId: req.prpaCompany.id, batchId, records: [record.record],
    });

    await audit(req, {
      action: 'import.url',
      opportunityId: (out.inserted[0] || out.amended[0] || out.unchanged[0] || {}).id || null,
      detail: {
        notice_id: noticeId, url: `https://sam.gov/opp/${noticeId}/view`,
        inserted: out.inserted.length, amended: out.amended.length, unchanged: out.unchanged.length,
        endpoint: 'sam.gov/api/prod/opps/v2/opportunities (undocumented, attended)',
      },
    });
    for (const a of out.amended) {
      await audit(req, {
        action: 'amendment.recorded', opportunityId: a.id,
        detail: { solicitation_number: a.solicitation_number, version: a.version },
      });
    }

    res.json({
      ok: true, dataset: DATASET.describe(), notice_id: noticeId,
      inserted: out.inserted, amended: out.amended, unchanged: out.unchanged,
      rejected: out.rejected || [],
      warning: record.warnings,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * Map a sam.gov v2 record onto a tracker record.
 *
 * The description body lives at the TOP level of the response (`description[].body`), not inside
 * `data2` where every other field sits. Reading it from data2 returns undefined for every notice,
 * which looked exactly like "SAM does not expose descriptions".
 */
function samV2ToRecord(doc, noticeId) {
  const d = (doc && doc.data2) || {};
  const warnings = [];
  const solicitation = String(d.solicitationNumber || '').trim();
  if (!solicitation) warnings.push('the notice carries no solicitation number; the notice id is used as identity');

  const body = (Array.isArray(doc.description) ? doc.description : [])
    .map((x) => x && x.body).filter(Boolean).join('\n\n').trim();
  if (!body) warnings.push('the notice record carries no description body — the product class will be UNKNOWN');

  const plain = body
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&rsquo;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')
    .trim();

  // Through the same normaliser the CSV path uses, so a URL-imported row and a CSV-imported row of
  // the same notice are the same shape and dedupe against each other.
  const row = {
    NoticeId: noticeId,
    'Sol#': solicitation,
    Title: String(d.title || '').trim(),
    Type: noticeTypeFromV2(d.type),
    NaicsCode: Array.isArray(d.naics) && d.naics[0] ? String(d.naics[0].code || '') : '',
    ClassificationCode: String(d.classificationCode || ''),
    ResponseDeadLine: (d.solicitation && d.solicitation.deadlines && d.solicitation.deadlines.response) || '',
    ArchiveDate: (d.archive && d.archive.date) || '',
    PostedDate: doc.postedDate || '',
    Link: `https://sam.gov/opp/${noticeId}/view`,
    Description: plain,
    // Deliberately NOT inferred: the v2 record gives an organizationId, not a name. An agency name
    // guessed from the notice text would be an unconfirmed field presented as a confirmed one.
    'Department/Ind.Agency': '',
    SetASide: '',
  };
  if (!row['Department/Ind.Agency']) warnings.push('the v2 record exposes only an organisation id, so the agency is left unstated rather than guessed');

  const { mapping } = mapHeaders(Object.keys(row));
  const norm = normalizeRow(row, mapping);
  if (norm.rejected) return { ok: false, error: `the notice could not be normalised: ${norm.issues.join('; ')}` };
  const rec = norm.record;
  rec.content_hash = contentHash(rec);
  return { ok: true, record: rec, warnings: warnings.concat(norm.issues || []) };
}

// SAM's own type strings, mapped onto the tracker's enumeration. An unrecognised value becomes
// 'unknown' and never 'solicitation': a sources-sought notice recorded as a solicitation is market
// research presented as something to bid on.
function noticeTypeFromV2(t) {
  const s = String(t || '').toLowerCase();
  if (/combined/.test(s)) return 'Combined Synopsis/Solicitation';
  if (/^solicitation|request for (quote|proposal)/.test(s)) return 'Solicitation';
  if (/sources sought/.test(s)) return 'Sources Sought';
  if (/presolicitation/.test(s)) return 'Presolicitation';
  if (/special notice/.test(s)) return 'Special Notice';
  if (/award/.test(s)) return 'Award Notice';
  if (/justification/.test(s)) return 'Justification';
  return '';
}

// ── 6. THE DOCUMENTS ON A NOTICE (ruling 27 item 8: "inspect its documents") ─
// The attachment LIST only. Nothing is downloaded to the server and nothing is stored: the files
// are third-party documents, this repository is public, and the S3 document store is not
// provisioned (ruling 17 holds production provisioning). The response carries canonical SAM links
// so a human opens them at the source.
router.get('/prpa/tracker/opportunities/:id/documents', read, async (req, res) => {
  try {
    const r = await query(
      `SELECT id, notice_id, solicitation_number, source_url FROM federal_opportunities
        WHERE company_id = $1 AND id = $2`, [req.prpaCompany.id, String(req.params.id)]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    const opp = r.rows[0];
    if (!opp.notice_id || !/^[0-9a-f]{32}$/i.test(opp.notice_id)) {
      return res.status(422).json({
        error: 'this row has no SAM notice id, so its documents cannot be located',
        detail: 'notice_id is how SAM addresses attachments; a CSV-only row may not carry one',
      });
    }
    let out;
    try {
      out = await fetchDocument(
        `https://sam.gov/api/prod/opps/v3/opportunities/${opp.notice_id}/resources`,
        { maxBytes: MAX_URL_FETCH_BYTES },
      );
    } catch (e) {
      return res.status(502).json({ error: 'could not reach the SAM attachment index', detail: e.message });
    }
    let doc; try { doc = JSON.parse(out.buffer.toString('utf8')); } catch { return res.status(502).json({ error: 'the attachment index did not parse as JSON' }); }

    const list = [];
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n.resourceId || n.name) {
        list.push({
          resource_id: n.resourceId || null,
          name: n.name || n.fileName || null,
          type: n.type || n.mimeType || null,
          size_bytes: n.size || n.length || null,
          // The canonical government URL. A human clicks this; the server does not fetch it.
          url: n.resourceId
            ? `https://sam.gov/api/prod/opps/v3/opportunities/resources/files/${n.resourceId}/download`
            : null,
        });
      }
      Object.values(n).forEach(walk);
    };
    walk(doc);

    await audit(req, {
      action: 'documents.inspected', opportunityId: opp.id,
      detail: { notice_id: opp.notice_id, attachments: list.length },
    });

    res.json({
      opportunity_id: opp.id,
      solicitation_number: opp.solicitation_number,
      notice_url: opp.source_url || `https://sam.gov/opp/${opp.notice_id}/view`,
      attachments: list,
      note: 'The attachment index only. Nothing was downloaded or stored server-side — these are '
        + 'third-party documents and the document store is not provisioned. Open them at SAM.gov.',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 7. DEADLINE CONFIRMATION ─────────────────────────────────────────────────
// is_biddable is a generated column that requires deadline_confirmed_at. So this is not a cosmetic
// tick: until a human has checked the deadline against the official notice, nothing is biddable.
router.post('/prpa/tracker/opportunities/:id/confirm-deadline', write, async (req, res) => {
  try {
    const row = await T.confirmDeadline(query, {
      companyId: req.prpaCompany.id,
      opportunityId: String(req.params.id),
      confirmedBy: actorOf(req),
    });
    if (!row) {
      return res.status(422).json({
        error: 'nothing to confirm',
        detail: 'either the row does not exist, or it has no response deadline to confirm',
      });
    }
    await audit(req, {
      action: 'deadline.confirmed', opportunityId: row.id,
      detail: { is_biddable_now: row.is_biddable, note: String(req.body.note || '').slice(0, 300) || null },
    });
    res.json({ ok: true, id: row.id, is_biddable: row.is_biddable });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 8. HUMAN BID / NO-BID REVIEW ─────────────────────────────────────────────
//
// 'bid' is adminOnly. A no-bid closes a door that can be reopened; a bid commits the company to
// preparing a response, and ruling 24 item 1 is explicit that recording a decision is not the same
// as acting on it. Recording either is still only a record — nothing is submitted anywhere, and
// there is no endpoint in this file that could submit it.
router.post('/prpa/tracker/opportunities/:id/review', write, async (req, res) => {
  try {
    const decision = String(req.body.decision || '').trim();
    const rationale = String(req.body.rationale || '').trim();
    if (!['bid', 'no_bid', 'undecided'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be bid, no_bid or undecided' });
    }
    if (rationale.length < 10) {
      return res.status(400).json({
        error: 'a rationale of at least 10 characters is required',
        detail: 'a decision with no reason is not reviewable, and no_bid is the one most worth explaining',
      });
    }
    if (decision === 'bid' && !['admin', 'super_admin'].includes(roleOf(req))) {
      return res.status(403).json({
        error: 'recording a BID decision is restricted to admin',
        code: 'bid_requires_admin',
        detail: 'no_bid and undecided are available to the procurement tier',
      });
    }

    const opp = (await query(
      `SELECT id, is_biddable, solicitation_number FROM federal_opportunities
        WHERE company_id = $1 AND id = $2 AND is_current`,
      [req.prpaCompany.id, String(req.params.id)])).rows[0];
    if (!opp) return res.status(404).json({ error: 'not found, or not the current version' });

    const r = await query(
      `INSERT INTO opportunity_bid_reviews (id, company_id, opportunity_id, decision, decided_by, rationale)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, decided_at`,
      [`review-${require('crypto').randomBytes(8).toString('hex')}`, req.prpaCompany.id,
        opp.id, decision, actorOf(req), rationale]);

    await audit(req, {
      action: 'review.recorded', opportunityId: opp.id,
      detail: {
        decision, solicitation_number: opp.solicitation_number,
        was_biddable: opp.is_biddable,
        note: 'a recorded decision only — nothing was submitted and no contracting officer was contacted',
      },
    });
    res.json({ ok: true, review_id: r.rows[0].id, decided_at: r.rows[0].decided_at, decision });
  } catch (e) {
    if (/opportunity_bid_reviews_rationale/.test(e.message)) {
      return res.status(400).json({ error: 'the rationale is too short for the database constraint' });
    }
    res.status(500).json({ error: e.message });
  }
});

// ── 9. THE REVIEW QUEUE ──────────────────────────────────────────────────────
// What a human has to act on, in the order the calendar forces. Three queues rather than one list,
// because "confirm this deadline" and "decide this bid" are different actions.
router.get('/prpa/tracker/review-queue', read, async (req, res) => {
  try {
    const today = isoDay(new Date());
    const caps = await REG.activeCapabilities(query, req.prpaCompany.id, { today });
    const rows = await T.listOpportunities(query, req.prpaCompany.id, {});
    const enriched = rows.map((r) => ({ ...r, business_lines: r.business_lines || relevantLines(r).lines }));
    const ranked = RANK.rankAll(enriched, { today, capabilities: caps, supplierQuotes: {} });

    const open = ranked.filter((r) => r.status === 'open' && !r.ranking.bars.length);
    const shaped = open.map(shapeForBoard);

    const dups = (await query(
      `SELECT d.*, a.solicitation_number AS a_sol, a.title AS a_title,
                     b.solicitation_number AS b_sol, b.title AS b_title
         FROM opportunity_duplicate_candidates d
         JOIN federal_opportunities a ON a.id = d.opportunity_id AND a.company_id = d.company_id
         JOIN federal_opportunities b ON b.id = d.other_id       AND b.company_id = d.company_id
        WHERE d.company_id = $1 AND d.resolved_at IS NULL
        ORDER BY d.similarity DESC`, [req.prpaCompany.id])).rows;

    res.json({
      dataset: DATASET.describe(),
      today,
      // Deadline unconfirmed and a deadline to confirm: nothing can be biddable until this is done.
      awaiting_deadline_confirmation: shaped
        .filter((r) => r.response_deadline && !r.deadline_confirmed)
        .sort((a, b) => String(a.response_deadline).localeCompare(String(b.response_deadline))),
      // Biddable, no human decision yet.
      awaiting_decision: shaped
        .filter((r) => r.is_biddable && !r.review)
        .sort((a, b) => String(a.response_deadline).localeCompare(String(b.response_deadline))),
      // Flagged by the engine for a specific named reason a human must settle.
      flagged: shaped.filter((r) => r.ranking.flags.length),
      awaiting_duplicate_resolution: dups,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 10. DUPLICATE / AMENDMENT RESOLUTION ─────────────────────────────────────
// A human says same or different. NOTHING IS MERGED — not here and not anywhere. Two solicitation
// numbers for one procurement is a fact worth recording; collapsing the rows would destroy the
// evidence that both existed.
router.get('/prpa/tracker/duplicates', read, async (req, res) => {
  try {
    const rows = (await query(
      `SELECT d.*, a.solicitation_number AS a_sol, a.title AS a_title, a.agency AS a_agency,
                     b.solicitation_number AS b_sol, b.title AS b_title, b.agency AS b_agency
         FROM opportunity_duplicate_candidates d
         JOIN federal_opportunities a ON a.id = d.opportunity_id AND a.company_id = d.company_id
         JOIN federal_opportunities b ON b.id = d.other_id       AND b.company_id = d.company_id
        WHERE d.company_id = $1
        ORDER BY (d.resolved_at IS NULL) DESC, d.similarity DESC`, [req.prpaCompany.id])).rows;
    res.json({ count: rows.length, duplicates: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/prpa/tracker/duplicates/:id/resolve', write, async (req, res) => {
  try {
    const resolution = String(req.body.resolution || '').trim();
    if (!['same_procurement', 'different_procurement', 'unclear'].includes(resolution)) {
      return res.status(400).json({ error: 'resolution must be same_procurement, different_procurement or unclear' });
    }
    const r = await query(
      `UPDATE opportunity_duplicate_candidates
          SET resolution = $3, resolved_by = $4, resolved_at = NOW()
        WHERE company_id = $1 AND id = $2 AND resolved_at IS NULL
        RETURNING id, opportunity_id, other_id, resolution`,
      [req.prpaCompany.id, String(req.params.id), resolution, actorOf(req)]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found, or already resolved' });
    const row = r.rows[0];
    await audit(req, {
      action: 'duplicate.resolved', opportunityId: row.opportunity_id,
      detail: {
        other_id: row.other_id, resolution,
        note: 'recorded only — no rows were merged, and both solicitations remain in the dataset',
      },
    });
    res.json({ ok: true, ...row, merged: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 11. RE-ASSESS ────────────────────────────────────────────────────────────
// adminOnly: a run writes a verdict row against every current opportunity, and the evidence basis
// it runs under is the difference between "this is Abiozen's position" and "this is what fixture
// evidence would have produced". It always runs on the REAL registry here — there is no parameter
// that would let a fixture basis be requested through HTTP.
router.post('/prpa/tracker/assess', [staffOnly, adminOnly, resolveCompany], async (req, res) => {
  try {
    const today = isoDay(new Date());
    const caps = await REG.activeCapabilities(query, req.prpaCompany.id, { today });
    const out = await T.assessAll(query, {
      companyId: req.prpaCompany.id,
      assessedBy: actorOf(req),
      capabilities: caps,
      evidenceBasis: 'real_registry',
      opts: { today },
    });
    const tally = out.reduce((a, r) => { a[r.verdict] = (a[r.verdict] || 0) + 1; return a; }, {});
    await audit(req, {
      action: 'assessment.run',
      detail: { evidence_basis: 'real_registry', verified_capabilities: caps.length, assessed: out.length, tally },
    });
    res.json({
      ok: true, assessed: out.length, verified_capabilities: caps.length, tally,
      note: caps.length === 0
        ? 'Abiozen holds zero verified capabilities, so no opportunity can be QUALIFIED. That is the '
          + 'truthful result, not a failure of the run.'
        : undefined,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 12. ONE-CLICK EXCEL-COMPATIBLE EXPORT (ruling 27 item 3) ─────────────────
// A GET so a browser link downloads it with no JavaScript at all. The CSV carries its own
// provenance header: where the rows came from, when, their sha256, and which fields are unconfirmed.
router.get('/prpa/tracker/export.csv', read, async (req, res) => {
  try {
    const rows = await T.listOpportunities(query, req.prpaCompany.id,
      req.query.biddableOnly === 'true' ? { biddableOnly: true } : {});
    const csv = T.exportCsv(rows);
    await audit(req, {
      action: 'export.csv',
      detail: {
        rows: rows.length, bytes: Buffer.byteLength(csv, 'utf8'),
        biddable_only: req.query.biddableOnly === 'true',
      },
    });
    const day = isoDay(new Date());
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="abiozen-federal-opportunities-${day}.csv"`);
    // The export is a point-in-time file; a cached copy would quietly be a different dataset.
    res.setHeader('Cache-Control', 'no-store');
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 13. AUDIT HISTORY ────────────────────────────────────────────────────────
router.get('/prpa/tracker/audit', read, async (req, res) => {
  try {
    const rows = await AUDIT.recent(query, req.prpaCompany.id, req.query.limit);
    res.json({ count: rows.length, events: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 14. CAPABILITY REGISTRY, READ-ONLY HERE ──────────────────────────────────
// The board's verdicts are only as good as this, so the dashboard shows it. Activation is NOT
// reachable from this router: ruling 23 item 4 requires evidence, authorization and human review,
// which is the capability-registry module's own guarded path, not an HTTP POST.
router.get('/prpa/tracker/capabilities', read, async (req, res) => {
  try {
    const today = isoDay(new Date());
    const active = await REG.activeCapabilities(query, req.prpaCompany.id, { today });
    const gaps = await REG.gapReport(query, req.prpaCompany.id, { today });
    res.json({
      verified_count: active.length,
      active,
      gaps,
      note: active.length === 0
        ? 'The registry is empty. Every feasibility verdict below is therefore UNPROVEN at best, and '
          + 'nothing can be QUALIFIED.'
        : undefined,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
