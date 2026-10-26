// ── ONE QUEUE, READ BY BOTH THE DRY RUN AND THE SENDER ───────────────────────
//
// scripts/route-outreach.js prints who would be written to and why. scripts/send-outreach.js
// writes to them. If those two build their lists separately, the dry run stops being evidence
// about the send — it becomes a second implementation that happens to agree today.
//
// This session has already paid for that mistake twice. A role→campaign map existed in two places
// and queued a SCOPE contact to receive a CPHI letter. An inquiry filter existed in two places and
// queued five of our own test records for cold outreach. Both times the second copy was the one
// that drifted, and both times it looked fine until somebody read the list.
//
// So the queue is built once, here, and both commands import it. The dry run shows exactly what
// the sender will do because it is asking the same function.
'use strict';

const { needFor } = require('./needs');
const { resolveProductLink } = require('./product-link');
const { EXTERNAL_SQL } = require('../revenue/demand');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const titleCase = (t) => (t === t.toUpperCase() ? t.charAt(0) + t.slice(1).toLowerCase() : t);

/** First name for a greeting. "JONATHAN A ELLMAN" -> "Jonathan", so it is not read as a merge. */
function firstName(full) {
  const tok = String(full || '').trim().split(/\s+/).filter(Boolean)[0] || '';
  return tok ? titleCase(tok) : '';
}

// RePORTER files names several ways and all of them are in this table: "Scott J Miller",
// "JONATHAN A ELLMAN", "Margaret A. Phillips", "Pavel  Nagorny" with two spaces, "Jean-Pierre
// Vilardaga". The surname is the last token in each, but ALL-CAPS filings must be recased or the
// letter opens "Dear Professor ELLMAN", and a particle belongs with the name that follows it.
const PARTICLES = new Set(['van', 'von', 'de', 'del', 'della', 'di', 'da', 'dos', 'du', 'la',
  'le', 'den', 'der', 'ten', 'ter', 'bin', 'al']);

function lastName(full) {
  const toks = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return '';
  let i = toks.length - 1;
  while (i > 0 && PARTICLES.has(toks[i - 1].toLowerCase().replace(/[^a-z]/g, ''))) i -= 1;
  return toks.slice(i).map(titleCase).join(' ');
}

/**
 * Every contact we could write to, with the need they route to and why.
 *
 * Returns rows shaped for both callers:
 *   { channel, ref, who, first, last, email, org, src, route, approved, link, why }
 * `route` is null when nothing could be evidenced — those rows are the ones the dry run prints
 * under "not routed", and the sender ignores entirely.
 *
 * @param {function} query  the db query function
 * @param {object}  [opts]
 * @param {boolean} [opts.resolveLinks=true] set false to skip the network check
 */
async function buildQueue(query, opts = {}) {
  const rows = [];

  // ── FUNDED RESEARCH LABS ────
  // The only source where every field the discovery route needs is stored and checkable: the
  // department, the grant number, the end date and the PI's own published address.
  const labs = (await query(`
    SELECT l.id, l.pi_name, l.institution_name, l.department, l.focus,
           l.funding_id, l.funding_end, l.source_url,
           p.full_name, p.email
      FROM research_labs l
      JOIN research_people p ON p.lab_id = l.id
     WHERE p.email IS NOT NULL AND p.email <> ''
     ORDER BY l.institution_name, l.pi_name`)).rows;

  for (const r of labs) {
    const route = needFor({
      deptType: r.department,
      researchTopic: r.focus,
      grantNumber: r.funding_id,
      // Passed through, never pre-formatted. String(date).slice(0, 10) once gave "Sun Mar 31",
      // which V8 parsed as the year 2001 and printed to three professors.
      grantEndsOn: r.funding_end || null,
    });
    const who = r.full_name || r.pi_name;
    rows.push({
      channel: 'research_lab',
      ref: String(r.id),
      who,
      first: firstName(who),
      last: lastName(who),
      email: r.email,
      org: r.institution_name,
      src: 'research_lab',
      route,
      approved: false,
      evidenceUrl: r.source_url,
      why: route ? null : whyLabDeclined(r),
    });
  }

  // ── OPEN INQUIRIES ────
  // Someone who already asked us for something. EXTERNAL_SQL is imported rather than restated:
  // when this query kept its own copy it queued "Naren Boda" and "Buyer qa" for cold outreach.
  const inq = (await query(`
    SELECT i.id, i.buyer_name, i.buyer_email, i.buyer_company, i.molecule_name, i.cas_number, i.status
      FROM inquiries i
     WHERE ${EXTERNAL_SQL}
       AND i.buyer_email IS NOT NULL
       AND NULLIF(TRIM(i.molecule_name), '') IS NOT NULL
     ORDER BY i.created_at DESC`)).rows;

  const cat = (await query(
    'SELECT product_name, cas, review_status FROM supplier_products')).rows;
  const byName = new Map();
  const byCas = new Map();
  for (const c of cat) {
    const k = norm(c.product_name);
    if (k && !byName.has(k)) byName.set(k, c);
    const cs = String(c.cas || '').trim();
    if (cs && !byCas.has(cs)) byCas.set(cs, c);
  }

  for (const r of inq) {
    const k = norm(r.molecule_name);
    const hit = byCas.get(String(r.cas_number || '').trim()) || byName.get(k) || null;
    const who = r.buyer_name || r.buyer_company || r.buyer_email;
    // inCatalogue is always an explicit boolean here, because we have checked. needFor() declines
    // when it is undefined, and that distinction is the point: guessing picks between "we can
    // source it" and "nobody carries it", which are opposite letters.
    const route = needFor({ moleculeNamed: r.molecule_name, inCatalogue: !!hit });
    rows.push({
      channel: 'inquiry',
      ref: String(r.id),
      who,
      first: firstName(who),
      last: lastName(who),
      email: r.buyer_email,
      org: r.buyer_company,
      src: `inquiry/${r.status || '?'}`,
      route,
      approved: !!hit && hit.review_status === 'approved',
      why: route ? null : 'molecule present but unroutable',
    });
  }

  // ── LINKS ────
  // Resolved here so the dry run shows exactly which contacts would carry one. With no
  // ABIOZEN_PRODUCT_URL configured this resolves nothing and every letter goes without a link,
  // which reads correctly.
  if (opts.resolveLinks !== false) {
    for (const r of rows) {
      if (!r.route) { r.link = null; continue; }
      const mol = ['catalogue_api', 'custom_synthesis', 'reference_standard'].includes(r.route.need)
        ? r.route.topic : null;
      r.link = mol ? await resolveProductLink(mol, { approved: r.approved === true }) : null;
    }
  }

  return rows;
}

// What the row lacked, named precisely. "No need detected" is not actionable; "no focus recorded"
// tells somebody which field to go and fill.
function whyLabDeclined(r) {
  const d = String(r.department || '');
  if (!d.trim()) return 'no department recorded';
  if (!/chem/i.test(d)) return `department is ${d.slice(0, 30)}`;
  if (!r.focus) return 'no focus/topic recorded';
  if (!r.funding_id) return 'no grant number recorded';
  return 'topic is only grant boilerplate';
}

/** The variables a render needs, derived from one queue row. */
const varsFor = (r) => ({
  first: r.first,
  last: r.last,
  topic: r.route ? r.route.topic : '',
  evidence: r.route ? r.route.evidence : '',
  link: r.link ? r.link.url : null,
});

module.exports = { buildQueue, varsFor, firstName, lastName };
