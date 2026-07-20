// ── AI Email Engine ───────────────────────────────────────────────────────────
// Turns weekly demand signals into per-segment A/B email campaigns, renders them
// into a fixed world-class HTML template, and packages each approved campaign as
// an Apollo sequence.
//
// Demand signals come from THREE sources, deduplicated and priority-ranked:
//   1. GSC search queries (seo_rankings) — buyers already searching. Highest.
//   2. molecule_history — the weekly 150-molecule market-intelligence feed.
//   3. Algolia abiozen_products — the live marketplace catalog.
//
// Design split (changed in the PART 2 upgrade): Claude no longer emits HTML. It
// returns COPY ONLY (subjects + a few body paragraphs) as JSON, and
// generateEmailHtml() assembles the deterministic template — logo header, molecule
// hero, spec table, badges, CTAs, footer. This guarantees a consistent, on-brand
// design, guarantees the CTA/footer/unsubscribe are always present, and cuts the
// per-variant token spend by ~3KB of HTML the model used to write every time.
//
// Runs Monday 15:30 UTC, after market intelligence (15:00) writes molecule_history.
const crypto = require('crypto');
const { query } = require('../db');
const { logAgentActivity, parseClaudeJSON } = require('../agent-core');
const { getAppId, getSearchKey } = require('../algolia-keys');
const { LOGO_SRC } = require('./email-assets');

const EMAIL_MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 4000; // copy-only now, not full HTML — smaller budget suffices

// Brand palette (PART 2).
const C = { navy: '#1B3A6B', teal: '#0D7377', mint: '#9FE1CB', green: '#1D9E75', ink: '#1a202c', slate: '#4a5568', mute: '#718096', line: '#e2e8f0' };

// Buyer segments. `brief` steers Claude's copy; `emphasis` steers both the copy
// prompt and which spec rows the template surfaces (PART 2 per-segment emphasis).
const SEGMENTS = [
  { key: 'compounding_pharmacy', label: 'Compounding Pharmacy',
    brief: 'Independent and 503B compounding pharmacies. Buy small-to-mid quantities, care most about USP/NF grade, COA on every lot, reliable resupply, and fast US delivery. Regulatory exposure is their biggest fear.',
    emphasis: 'bulk pricing, COA on every lot, and fast US delivery' },
  { key: 'research_lab', label: 'Research Lab',
    brief: 'Academic and contract research labs. Buy gram-to-kilo quantities, care about purity spec, analytical documentation (COA/SDS), and fast quoting. Price-sensitive and grant-cycle driven.',
    emphasis: 'purity spec, COA and SDS documentation, and research applications' },
  { key: 'generic_manufacturer', label: 'Generic Manufacturer',
    brief: 'Generic drug manufacturers buying API at scale. Care about GMP status, DMF availability, audit history, regulatory compliance, capacity, and multi-year supply security. Long qualification cycles.',
    emphasis: 'GMP certification, DMF filing status, regulatory compliance, and market size' },
  { key: 'university', label: 'University',
    brief: 'University departments and core facilities. Small quantities, purchase-order driven, need clear SDS and safe-handling documentation and flexible payment terms. Value education and technical support over price.',
    emphasis: 'small minimum order quantity, NET-30 terms, and research-grade documentation' },
];

const DAY_MS = 86400000;
const isoDate = d => d.toISOString().slice(0, 10);
function mondayOf(date = new Date()) {
  const d = new Date(date);
  const utcDay = d.getUTCDay();
  const offset = utcDay === 0 ? -6 : 1 - utcDay;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + offset));
}
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Chemical-name matching. Plain substring containment is wrong: the GSC query
// "2-(1-aminocyclobutyl)-5-bromopyrimidine" contains "5-bromopyrimidine" but is a
// different compound. Hyphens count as token characters (they glue a chemical name
// together) while other punctuation collapses, so "4'-fluoroacetophenone" still
// matches "4-fluoroacetophenone" across the apostrophe, but a name welded into a
// longer name by a hyphen does not.
const chemNorm = s => String(s || '').toLowerCase()
  .replace(/['‘’"]/g, '')
  .replace(/[^a-z0-9-]+/g, ' ')
  .replace(/\s+/g, ' ').trim();
const isTokenChar = ch => !!ch && /[a-z0-9-]/.test(ch);
function containsMolecule(queryText, moleculeName) {
  const q = chemNorm(queryText), n = chemNorm(moleculeName);
  if (!n || n.length < 4) return false;
  let i = q.indexOf(n);
  while (i !== -1) {
    const before = i > 0 ? q[i - 1] : '';
    const after = i + n.length < q.length ? q[i + n.length] : '';
    if (!isTokenChar(before) && !isTokenChar(after)) return true;
    i = q.indexOf(n, i + 1);
  }
  return false;
}

// Defence in depth: Claude's copy is inserted into the template, so strip anything
// executable even though the copy is only paragraphs and the preview is sandboxed.
function sanitizeHtml(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<iframe\b[\s\S]*?<\/iframe\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '');
}

async function callClaudeEmail(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { data: null, error: 'ANTHROPIC_API_KEY not configured' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: EMAIL_MODEL, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { data: null, error: `Claude ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = await res.json();
    const parsed = parseClaudeJSON(data.content?.[0]?.text || '');
    if (!parsed) return { data: null, error: 'unparseable JSON from Claude' };
    return { data: parsed };
  } catch (e) { return { data: null, error: e.message }; }
}

// ── Step 1 — demand signals from three sources ────────────────────────────────
// PART 3: molecule_history + skus + Algolia, deduplicated. Priority is encoded in
// the score bands so GSC-backed molecules (real buyer search) win, then the
// market-intelligence feed, then the catalog. A molecule appearing in several
// sources accumulates score AND collects every source tag for the UI badge.
async function gatherDemandSignals(week) {
  const since = isoDate(new Date(Date.now() - 30 * DAY_MS));
  const seoRows = (await query(
    `SELECT query, SUM(impressions)::int AS impressions FROM seo_rankings
     WHERE recorded_date >= $1 GROUP BY query ORDER BY SUM(impressions) DESC LIMIT 20`, [since]
  )).rows;

  const mhRows = (await query(
    `SELECT molecule_name, cas_number, rank, estimated_value FROM molecule_history
     WHERE week_start = $1 ORDER BY COALESCE(rank, 9999) ASC, COALESCE(estimated_value,0) DESC LIMIT 40`, [week]
  )).rows;

  const skuRows = (await query(
    `SELECT name AS molecule_name, cas_number FROM skus WHERE is_active = 1`
  )).rows;

  const algoliaRows = await fetchAlgoliaCatalog();

  // Vocabulary for resolving free-text GSC queries → real molecule names. This
  // must be BROAD, not just the current sources: a buyer searching for a compound
  // that isn't in this week's feed or the catalog should STILL get a campaign
  // (GSC is the highest-priority signal). So the dictionary spans the trailing 12
  // weeks of molecule_history plus every SKU and every Algolia record. A GSC hit
  // then enters the candidate pool via add(...,'gsc') below even if no other
  // source carries it. (Narrowing this to the current week silently zeroed GSC
  // matching — the whole search half of the pipeline went dark.)
  const vocabRows = (await query(
    `SELECT DISTINCT molecule_name AS name, cas_number FROM molecule_history
       WHERE week_start >= $1`,
    [isoDate(new Date(Date.now() - 84 * DAY_MS))]
  )).rows;
  const vocab = [];
  const seenVocab = new Set();
  for (const r of [...vocabRows, ...skuRows, ...algoliaRows]) {
    const nm = r.name || r.molecule_name;
    const k = norm(nm);
    if (!k || !nm || nm.length < 4 || seenVocab.has(k)) continue;
    seenVocab.add(k);
    vocab.push({ name: nm, cas_number: r.cas_number });
  }
  vocab.sort((a, b) => b.name.length - a.name.length); // longest first

  const byMolecule = new Map();
  const add = (name, cas, score, src) => {
    const k = norm(name);
    if (!k) return;
    const cur = byMolecule.get(k) || { molecule_name: name, cas_number: cas || null, score: 0, sources: [] };
    cur.score += score;
    if (!cur.cas_number && cas) cur.cas_number = cas;
    if (!cur.sources.includes(src)) cur.sources.push(src);
    byMolecule.set(k, cur);
  };

  // GSC — buyers already searching. Band 100-160 (impression-scaled bonus on top
  // of a 100 floor) so any GSC-matched molecule outranks a pure feed/catalog hit.
  let seoMatched = 0;
  const maxImp = Math.max(1, ...seoRows.map(r => Number(r.impressions) || 0));
  for (const r of seoRows) {
    const hit = vocab.find(v => containsMolecule(r.query, v.name));
    if (!hit) continue;
    seoMatched++;
    add(hit.name, hit.cas_number, 100 + ((Number(r.impressions) || 0) / maxImp) * 60, 'gsc');
  }

  // molecule_history — band 40-83. rank is per-batch (not global: this week has 9
  // molecules at rank 1), so rank sets the band and estimated_value breaks ties.
  const maxVal = Math.max(1, ...mhRows.map(r => Number(r.estimated_value) || 0));
  for (const r of mhRows) {
    const rank = Number(r.rank) || 15;
    const band = Math.max(40, 100 - rank * 2);
    add(r.molecule_name, r.cas_number, band * 0.85 + ((Number(r.estimated_value) || 0) / maxVal) * 15, 'market_intelligence');
  }

  // Catalog (skus + Algolia) — floor band 20-30. On-catalog molecules with no
  // demand signal still get covered once the higher bands are exhausted.
  for (const r of skuRows) add(r.molecule_name, r.cas_number, 25, 'catalog');
  for (const r of algoliaRows) add(r.molecule_name, r.cas_number, 20, 'catalog');

  const ranked = [...byMolecule.values()].sort((a, b) => b.score - a.score);
  return {
    ranked, seo_queries: seoRows.length, seo_matched: seoMatched,
    mh_count: mhRows.length, sku_count: skuRows.length, algolia_count: algoliaRows.length,
    unique_molecules: ranked.length,
  };
}

// Pull the marketplace catalog from Algolia. Best-effort: a missing key or a
// down index returns [] and the engine runs on the DB sources alone.
async function fetchAlgoliaCatalog() {
  const appId = getAppId(), key = getSearchKey();
  if (!appId || !key) return [];
  const index = process.env.ALGOLIA_INDEX_NAME || 'abiozen_products';
  try {
    const res = await fetch(`https://${appId}-dsn.algolia.net/1/indexes/${encodeURIComponent(index)}/query`, {
      method: 'POST',
      headers: { 'X-Algolia-Application-Id': appId, 'X-Algolia-API-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ params: 'query=&hitsPerPage=1000&attributesToRetrieve=name,cas_number,purity,is_gmp,coa_status,sds_status,price' }),
    });
    if (!res.ok) return [];
    const j = await res.json();
    return (j.hits || []).filter(h => h.name).map(h => ({
      molecule_name: h.name, cas_number: h.cas_number || null,
      _algolia: { purity: h.purity, is_gmp: h.is_gmp, coa_status: h.coa_status, sds_status: h.sds_status, price: h.price },
    }));
  } catch { return []; }
}

// ── Step 2 — catalog validation ───────────────────────────────────────────────
// Every availability claim comes from here, never from the model. Falls back from
// skus → the molecule's Algolia record so marketplace-only molecules still carry
// real purity/COA/GMP facts.
async function validateAgainstCatalog(molecules, algoliaByKey) {
  const out = [];
  for (const m of molecules) {
    const sku = (await query(
      `SELECT purity, sale_price, currency, coa_status, sds_status, is_gmp, cas_number
       FROM skus WHERE is_active = 1 AND (LOWER(name) = LOWER($1) OR (cas_number IS NOT NULL AND cas_number = $2))
       LIMIT 1`, [m.molecule_name, m.cas_number]
    )).rows[0];
    const mh = (await query(
      `SELECT in_catalog FROM molecule_history WHERE LOWER(molecule_name) = LOWER($1)
       ORDER BY created_at DESC LIMIT 1`, [m.molecule_name]
    )).rows[0];
    const alg = algoliaByKey.get(norm(m.molecule_name))?._algolia || {};
    const coaOk = v => v === 'available' || v === 'complete';
    out.push({
      ...m,
      cas_number: m.cas_number || sku?.cas_number || null,
      in_catalog: !!sku || Number(mh?.in_catalog) === 1 || m.sources.includes('catalog'),
      has_coa: coaOk(sku?.coa_status) || coaOk(alg.coa_status),
      has_sds: coaOk(sku?.sds_status) || coaOk(alg.sds_status),
      purity: sku?.purity || (alg.purity != null ? String(alg.purity) : null),
      price: sku?.sale_price ? Number(sku.sale_price) : (alg.price != null ? Number(alg.price) : null),
      currency: sku?.currency || 'USD',
      is_gmp: Number(sku?.is_gmp) === 1 || alg.is_gmp === true,
    });
  }
  return out;
}

// ── Step 3a — the world-class HTML template (deterministic) ────────────────────
// Table-based, inline CSS, max-width 600px. Claude supplies only `copy` (an array
// of paragraph strings, already sanitised); everything structural is here so the
// design is identical across all 80 variants and the CTA/footer/unsubscribe can
// never go missing.
//
// FOOTER ADDRESS: CAN-SPAM requires a real physical postal address in commercial
// email. Rendered on its own line in the footer under the company name.
const SENDER_ADDRESS = '1333 Barclay Blvd, Suite 1333, Buffalo Grove, IL 60089';

function badge(text, bg, fg = '#ffffff') {
  return `<span style="display:inline-block;background:${bg};color:${fg};font-size:11px;font-weight:700;letter-spacing:.3px;padding:4px 10px;border-radius:12px;margin:0 6px 6px 0">${esc(text)}</span>`;
}

function specRow(label, value) {
  return `<tr>
    <td style="padding:9px 0;border-bottom:1px solid ${C.line};font-size:13px;color:${C.mute};width:42%">${esc(label)}</td>
    <td style="padding:9px 0;border-bottom:1px solid ${C.line};font-size:13px;color:${C.ink};font-weight:600">${esc(value)}</td>
  </tr>`;
}

function generateEmailHtml(mol, seg, copyParas) {
  const gradeLabel = mol.is_gmp ? 'GMP Grade' : 'Research Grade';
  const availLabel = mol.in_catalog ? 'In catalog — ready to quote' : 'Available via sourcing network';
  const docLabel = mol.has_coa && mol.has_sds ? 'COA + SDS available'
    : mol.has_coa ? 'COA available'
    : mol.has_sds ? 'SDS available'
    : 'On request';

  // Badges — never assert a purity or GMP fact we don't hold.
  const badges = [
    badge(gradeLabel, mol.is_gmp ? C.teal : C.navy),
    mol.purity ? badge(`${mol.purity}${/%/.test(String(mol.purity)) ? '' : '%'} purity`, C.mint, C.navy) : '',
    mol.has_coa ? badge('COA', C.teal) : '',
  ].filter(Boolean).join('');

  // Spec table — real facts where we have them, honest "On request" otherwise.
  const specs = [
    specRow('Purity', mol.purity ? `${mol.purity}${/%/.test(String(mol.purity)) ? '' : '%'}` : 'On request'),
    specRow('Grade', gradeLabel),
    specRow('Documentation', docLabel),
    specRow('Availability', availLabel),
    specRow('Lead time', 'Contact for quote'),
  ].join('');

  const quoteSubject = encodeURIComponent(`Quote request: ${mol.molecule_name}${mol.cas_number ? ' (CAS ' + mol.cas_number + ')' : ''}`);
  const bodyParas = (copyParas || []).map(p => `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:${C.slate}">${sanitizeHtml(p)}</p>`).join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(mol.molecule_name)} — Abiozen</title></head>
<body style="margin:0;padding:0;background:#eef1f5;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f5"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid ${C.line}">

  <!-- Navy header with white logo strip -->
  <tr><td style="background:${C.navy};padding:22px 24px" align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px"><tr>
      <td style="padding:14px 26px" align="center"><img src="${LOGO_SRC}" width="180" alt="Abiozen" style="display:block;width:180px;max-width:180px;height:auto;border:0"></td>
    </tr></table>
  </td></tr>

  <!-- Molecule hero -->
  <tr><td style="padding:28px 28px 8px">
    <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${C.teal}">${esc(seg.label)} · Sourcing Update</div>
    <h1 style="margin:8px 0 6px;font-size:26px;line-height:1.25;color:${C.navy};font-weight:800">${esc(mol.molecule_name)}</h1>
    ${mol.cas_number ? `<div style="font-size:13px;color:${C.mute};margin-bottom:12px">CAS ${esc(mol.cas_number)}</div>` : '<div style="height:6px"></div>'}
    <div>${badges}</div>
  </td></tr>

  <!-- Body copy -->
  <tr><td style="padding:12px 28px 4px">${bodyParas}</td></tr>

  <!-- Spec table -->
  <tr><td style="padding:8px 28px 4px">
    <div style="font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:${C.navy};margin-bottom:6px">Key specifications</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${specs}</table>
  </td></tr>

  <!-- CTAs -->
  <tr><td style="padding:22px 28px 8px" align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto"><tr>
      <td style="padding:0 6px"><a href="mailto:sales@abiozen.com?subject=${quoteSubject}" style="display:inline-block;background:${C.green};color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;padding:13px 28px;border-radius:6px">Request Quote</a></td>
      <td style="padding:0 6px"><a href="https://abiozen.com" style="display:inline-block;background:#ffffff;color:${C.navy};font-size:15px;font-weight:700;text-decoration:none;padding:12px 26px;border-radius:6px;border:1.5px solid ${C.navy}">View Full Catalog</a></td>
    </tr></table>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:22px 28px 26px;border-top:1px solid ${C.line}">
    <div style="font-size:13px;font-weight:700;color:${C.navy}">Abiozen LLC</div>
    <div style="font-size:12px;color:${C.mute};line-height:1.6;margin-top:4px">
      US pharmaceutical API &amp; specialty chemical distribution<br>
      ${esc(SENDER_ADDRESS)}<br>
      <a href="mailto:sales@abiozen.com" style="color:${C.teal};text-decoration:none">sales@abiozen.com</a> · <a href="https://abiozen.com" style="color:${C.teal};text-decoration:none">abiozen.com</a>
    </div>
    <div style="font-size:11px;color:${C.mute};margin-top:12px">You are receiving this because Abiozen identified you as a potential sourcing partner. <a href="{{unsubscribe_url}}" style="color:${C.mute};text-decoration:underline">Unsubscribe</a></div>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

// ── Step 3b — the copy prompt (Claude writes words, not HTML) ──────────────────
function buildPrompt(mol, seg) {
  const facts = [
    `Molecule: ${mol.molecule_name}`,
    `CAS number: ${mol.cas_number || 'not available'}`,
    `Purity spec: ${mol.purity || 'not published'}`,
    `In Abiozen catalog right now: ${mol.in_catalog ? 'YES' : 'NO — frame as a sourcing enquiry, not a stock offer'}`,
    `COA available: ${mol.has_coa ? 'YES' : 'NO — do not promise a COA'}`,
    `SDS available: ${mol.has_sds ? 'YES' : 'NO — do not promise an SDS'}`,
    `GMP grade: ${mol.is_gmp ? 'YES' : 'NO / unconfirmed — do not claim GMP'}`,
    `Indicative price: ${mol.price ? `${mol.currency} ${mol.price} per kg` : 'not published — invite a quote instead of naming a price'}`,
  ].join('\n');

  return `You write B2B pharmaceutical sourcing email COPY for Abiozen LLC, a US API and specialty-chemical distributor. You are writing the body paragraphs only — a separate template supplies the logo, spec table, buttons and footer, so do NOT write HTML structure, headers, greetings-with-logos, tables, buttons, or a signature. Just persuasive paragraphs.

VERIFIED FACTS — the only claims you may make about availability, documentation, GMP status or price. Never assert a fact marked "not available"/"NO".
${facts}

BUYER SEGMENT: ${seg.label}
${seg.brief}
For this segment, emphasise: ${seg.emphasis}.

Write TWO variants.

Variant A — direct / product-focused: 2 short paragraphs. Lead with the molecule and its availability, then the documentation/quality posture and a nudge to request a quote. Procurement tone, no fluff.

Variant B — insight / market-focused: 2 short paragraphs. Open with why this molecule matters right now (demand, supply, or regulatory context relevant to this segment), then position Abiozen as the sourcing partner. Consultative, analyst voice.

Each subject line: under 70 characters. Variant A subject names the molecule; Variant B subject leads with the market angle. No emoji, no ALL CAPS, no "!".

Paragraphs: plain sentences wrapped in nothing (the template wraps them in <p>). You may use <strong> for one key phrase per paragraph. Under 90 words per paragraph. Do not mention "Variant A/B", do not add "Dear...", do not sign off.

Return ONLY this JSON, no prose, no code fences:
{"variant_a":{"subject":"...","paragraphs":["...","..."]},"variant_b":{"subject":"...","paragraphs":["...","..."]}}`;
}

// ── Step 5 — Apollo sequence payload ──────────────────────────────────────────
function buildApolloPayload(campaign, mol, seg, week) {
  const nudge = mol.in_catalog
    ? `Following up on ${campaign.molecule_name}. We hold stock and can turn a quote around same day — worth a short call?`
    : `Following up on ${campaign.molecule_name}. We can run a sourcing check against our supplier network if it is still on your list.`;
  const nudgeHtml = generateEmailHtml(mol, seg, [nudge]);
  return {
    name: `${campaign.molecule_name} — ${seg.label} — Week of ${week}`,
    permissions: 'team_can_use',
    active: false,
    emailer_steps: [
      { position: 1, wait_days: 0, type: 'auto_email', subject: campaign.variant_a_subject, body_html: campaign.variant_a_html },
      { position: 2, wait_days: 3, type: 'auto_email', subject: campaign.variant_b_subject, body_html: campaign.variant_b_html },
      { position: 3, wait_days: 7, type: 'auto_email', subject: `Re: ${campaign.variant_a_subject}`, body_html: nudgeHtml },
    ],
  };
}

/**
 * @param {string}  opts.weekStart      ISO Monday; defaults to the current week.
 * @param {boolean} opts.dryRun         Resolve the molecule list only; no Claude calls.
 * @param {number}  opts.topMolecules   Molecules to cover (default 10 → 40 campaigns).
 */
async function runEmailEngine({ weekStart, dryRun = false, topMolecules = 10 } = {}) {
  const week = weekStart || isoDate(mondayOf());
  const errors = [];

  const signals = await gatherDemandSignals(week);
  if (!signals.ranked.length) {
    return { week_start: week, generated: 0, skipped: 0, errors: ['no molecules resolved from any source'], ...signals };
  }
  const algoliaRaw = await fetchAlgoliaCatalog();
  const algoliaByKey = new Map(algoliaRaw.map(r => [norm(r.molecule_name), r]));
  const molecules = await validateAgainstCatalog(signals.ranked.slice(0, topMolecules), algoliaByKey);

  if (dryRun) {
    return {
      dryRun: true, week_start: week, model: EMAIL_MODEL,
      would_generate: molecules.length * SEGMENTS.length,
      sources: { seo_queries: signals.seo_queries, seo_matched: signals.seo_matched, mh_count: signals.mh_count, sku_count: signals.sku_count, algolia_count: signals.algolia_count, unique_molecules: signals.unique_molecules },
      molecules: molecules.map(m => ({ molecule_name: m.molecule_name, cas_number: m.cas_number, score: Math.round(m.score), sources: m.sources, in_catalog: m.in_catalog, has_coa: m.has_coa, purity: m.purity })),
    };
  }

  let generated = 0, skipped = 0;
  for (const mol of molecules) {
    for (const seg of SEGMENTS) {
      const existing = (await query(
        `SELECT id FROM email_campaigns WHERE week_start=$1 AND segment=$2 AND LOWER(molecule_name)=LOWER($3)`,
        [week, seg.key, mol.molecule_name]
      )).rows[0];
      if (existing) { skipped++; continue; }

      const { data, error } = await callClaudeEmail(buildPrompt(mol, seg));
      const va = data?.variant_a, vb = data?.variant_b;
      if (error || !Array.isArray(va?.paragraphs) || !va.paragraphs.length || !Array.isArray(vb?.paragraphs) || !vb.paragraphs.length) {
        errors.push(`${mol.molecule_name}/${seg.key}: ${error || 'incomplete copy'}`);
        continue;
      }
      const campaign = {
        id: crypto.randomUUID(),
        molecule_name: mol.molecule_name,
        cas_number: mol.cas_number,
        variant_a_subject: String(va.subject || `${mol.molecule_name} — sourcing`).slice(0, 300),
        variant_a_html: generateEmailHtml(mol, seg, va.paragraphs),
        variant_b_subject: String(vb.subject || `${mol.molecule_name} — market update`).slice(0, 300),
        variant_b_html: generateEmailHtml(mol, seg, vb.paragraphs),
      };
      const payload = buildApolloPayload(campaign, mol, seg, week);
      await query(
        `INSERT INTO email_campaigns
           (id, week_start, segment, molecule_name, cas_number,
            variant_a_subject, variant_a_html, variant_b_subject, variant_b_html,
            status, apollo_payload, sources, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10,$11,NOW())
         ON CONFLICT (week_start, segment, molecule_name) DO NOTHING`,
        [campaign.id, week, seg.key, campaign.molecule_name, campaign.cas_number,
         campaign.variant_a_subject, campaign.variant_a_html,
         campaign.variant_b_subject, campaign.variant_b_html,
         JSON.stringify(payload), mol.sources.join(',')]
      );
      generated++;
    }
  }

  await logAgentActivity({
    agent_name: 'email-engine', action_type: 'email_campaigns_generated',
    reasoning: `Generated ${generated} campaigns (${generated * 2} variants) across ${SEGMENTS.length} segments for week ${week} from ${signals.unique_molecules} unique molecules (GSC ${signals.seo_matched}, MI ${signals.mh_count}, catalog ${signals.sku_count + signals.algolia_count}).`
      + (skipped ? ` Skipped ${skipped} existing.` : '') + (errors.length ? ` ${errors.length} failed.` : ''),
    confidence_score: errors.length ? 60 : 90,
    output_summary: `week=${week} generated=${generated} skipped=${skipped} errors=${errors.length}`,
  }).catch(e => console.error('[email-engine] audit failed:', e.message));

  return {
    week_start: week, model: EMAIL_MODEL, generated, skipped,
    molecules: molecules.length, segments: SEGMENTS.length,
    seo_matched: signals.seo_matched, mh_count: signals.mh_count,
    catalog_count: signals.sku_count + signals.algolia_count, unique_molecules: signals.unique_molecules,
    errors,
  };
}

// ── Apollo publishing ─────────────────────────────────────────────────────────
// Building a sequence with content takes FOUR calls, and Apollo accepts (HTTP
// 200) three wrong shapes that silently drop the content. Every one was tried
// against the live API; do not "simplify" this back down:
//
//   1. POST /emailer_campaigns                       -> sequence id     (once)
//   2. POST /emailer_steps                            -> step id        (per step)
//        {emailer_campaign_id, position, type, wait_time, wait_mode:'day'}
//   3. POST /emailer_touches {emailer_step_id, type}  -> emailer_template_id
//        Apollo mints an EMPTY template for the touch and returns its id.
//   4. PUT  /emailer_templates/{that id} {subject, body_html}
//        The only shape where content survives.
//
// What returns 200 and silently loses content: inline emailer_steps on campaign
// create; nested emailer_template on the touch; subject/body_html at the touch top
// level; linking a pre-filled template by id (Apollo clones it empty). Also:
// /sequences is an alias for /emailer_campaigns, but /sequences/{id}/sequence_steps
// and /sequence_templates 404, and GET /emailer_campaigns/{id} never expands
// emailer_touches — verify content by fetching the template id directly.
async function publishSequenceToApollo(payload, apolloKey) {
  const call = async (path, body, method = 'POST') => {
    const r = await fetch('https://api.apollo.io/api/v1' + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apolloKey },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, text, json };
  };

  const created = await call('/emailer_campaigns', {
    name: payload.name, permissions: payload.permissions || 'team_can_use', active: false,
  });
  if (!created.ok) return { ok: false, stage: 'create', status: created.status, detail: created.text.slice(0, 400) };
  const sequenceId = created.json?.emailer_campaign?.id || created.json?.id || null;
  if (!sequenceId) return { ok: false, stage: 'create', status: created.status, detail: 'Apollo returned no sequence id' };

  const stepsDone = [];
  for (const step of payload.emailer_steps || []) {
    const s = await call('/emailer_steps', {
      emailer_campaign_id: sequenceId, position: step.position,
      type: step.type || 'auto_email', wait_time: step.wait_days || 0, wait_mode: 'day',
    });
    const stepId = s.json?.emailer_step?.id || null;
    if (!s.ok || !stepId) return { ok: false, stage: `step ${step.position}`, status: s.status, detail: s.text.slice(0, 400), sequenceId, stepsDone };

    const t = await call('/emailer_touches', { emailer_step_id: stepId, type: step.type || 'auto_email' });
    const templateId = t.json?.emailer_touch?.emailer_template_id || null;
    if (!t.ok || !templateId) return { ok: false, stage: `touch for step ${step.position}`, status: t.status, detail: t.text.slice(0, 400), sequenceId, stepsDone };

    const tpl = await call(`/emailer_templates/${templateId}`, { subject: step.subject, body_html: step.body_html }, 'PUT');
    if (!tpl.ok) return { ok: false, stage: `content for step ${step.position}`, status: tpl.status, detail: tpl.text.slice(0, 400), sequenceId, stepsDone };
    stepsDone.push(step.position);
  }
  return { ok: true, sequenceId, stepsDone };
}

module.exports = { runEmailEngine, SEGMENTS, buildApolloPayload, sanitizeHtml, generateEmailHtml, EMAIL_MODEL, publishSequenceToApollo };
