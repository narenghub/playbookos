// ── AI Email Engine ───────────────────────────────────────────────────────────
// Turns weekly demand signals (GSC search queries + the market-intelligence
// molecule feed) into per-segment A/B email campaigns, then packages each
// approved campaign as an Apollo sequence payload.
//
// Runs Monday 15:30 UTC, right after market intelligence (15:00) — it reads that
// run's molecule_history rows, so it must not start before they land.
//
// Claude is called once per (molecule, segment) pair and returns BOTH variants in
// one JSON object: 2 calls per molecule per segment would double cost for no gain,
// and generating A and B together lets the model differentiate them deliberately
// rather than accidentally writing the same email twice.
const crypto = require('crypto');
const { query } = require('../db');
const { logAgentActivity } = require('../agent-core');
const { parseClaudeJSON } = require('../agent-core');

const EMAIL_MODEL = 'claude-opus-4-8';
// No `thinking` field — this is templated HTML/copy generation, not multi-step
// reasoning, and at 40 calls/week adaptive thinking would add cost without
// improving output. Raise to {type:'adaptive'} if copy quality proves weak.
const MAX_TOKENS = 8000;

// The 4 buyer segments. `label` goes in the Apollo sequence name; `brief` is the
// only segment context Claude gets, so it carries the positioning.
const SEGMENTS = [
  { key: 'compounding_pharmacy', label: 'Compounding Pharmacy',
    brief: 'Independent and 503B compounding pharmacies. They buy small-to-mid quantities, care most about USP/NF grade, COA on every lot, and reliable resupply. Regulatory exposure is their biggest fear.' },
  { key: 'research_lab', label: 'Research Lab',
    brief: 'Academic and contract research labs. They buy gram-to-kilo quantities, care about purity spec, analytical documentation, and fast quoting. Price-sensitive and grant-cycle driven.' },
  { key: 'generic_manufacturer', label: 'Generic Manufacturer',
    brief: 'Generic drug manufacturers buying API at scale. They care about GMP status, DMF availability, audit history, capacity, and multi-year supply security. Long qualification cycles.' },
  { key: 'university', label: 'University',
    brief: 'University departments and core facilities. Small quantities, purchase-order driven, need clear SDS and safe-handling documentation. Value education and technical support over price.' },
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

// Chemical-name matching. Plain substring containment is wrong here: the GSC
// query "2-(1-aminocyclobutyl)-5-bromopyrimidine" contains "5-bromopyrimidine"
// but is a different compound, and matching it would generate a campaign for a
// molecule nobody searched for. So hyphens are preserved as token characters
// (they glue a chemical name together) while other punctuation collapses to
// spaces — that way "4'-fluoroacetophenone" still matches "4-fluoroacetophenone"
// across the apostrophe, but a name welded into a longer name by a hyphen does
// not match.
const chemNorm = s => String(s || '').toLowerCase()
  .replace(/['‘’"]/g, '')      // apostrophes/quotes vanish, not split
  .replace(/[^a-z0-9-]+/g, ' ')          // everything else -> space; keep hyphen
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

// Model-generated HTML is stored, rendered in the admin preview, and shipped to
// Apollo. Strip anything executable before any of that happens — the preview
// iframe is sandboxed too, but defence in depth costs nothing here.
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

// ── Step 1 — demand signals ───────────────────────────────────────────────────
// GSC rows are search *queries*, not molecules ("buy paracetamol api bulk"), so
// they can't be ranked as molecules directly. We resolve each query to a known
// molecule by longest-name containment against the catalog + recent molecule
// feed; queries that match nothing are counted and dropped, not guessed at.
async function gatherDemandSignals(week) {
  const since = isoDate(new Date(Date.now() - 30 * DAY_MS));
  const seoRows = (await query(
    `SELECT query, SUM(impressions)::int AS impressions, SUM(clicks)::int AS clicks
     FROM seo_rankings WHERE recorded_date >= $1
     GROUP BY query ORDER BY SUM(impressions) DESC LIMIT 20`, [since]
  )).rows;

  const mhRows = (await query(
    `SELECT molecule_name, cas_number, category, gmp_status, in_catalog, rank, estimated_value
     FROM molecule_history WHERE week_start = $1
     ORDER BY COALESCE(rank, 9999) ASC, COALESCE(estimated_value,0) DESC LIMIT 10`, [week]
  )).rows;

  // Known-molecule vocabulary for resolving GSC queries.
  const vocab = (await query(
    `SELECT DISTINCT molecule_name AS name, cas_number FROM molecule_history
       WHERE week_start >= $1
     UNION
     SELECT DISTINCT name, cas_number FROM skus WHERE is_active = 1`,
    [isoDate(new Date(Date.now() - 84 * DAY_MS))]
  )).rows.filter(r => r.name && r.name.length >= 4);
  // Longest first so "acetylsalicylic acid" wins over "acid".
  vocab.sort((a, b) => b.name.length - a.name.length);

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

  let seoMatched = 0;
  const maxImp = Math.max(1, ...seoRows.map(r => Number(r.impressions) || 0));
  for (const r of seoRows) {
    const hit = vocab.find(v => containsMolecule(r.query, v.name));
    if (!hit) continue;
    seoMatched++;
    // Normalised 0-60 so search demand can't swamp the curated molecule feed.
    add(hit.name, hit.cas_number, ((Number(r.impressions) || 0) / maxImp) * 60, 'gsc');
  }
  // molecule_history is rank-ordered (1 = strongest); map rank to 40..100.
  for (const r of mhRows) {
    const rank = Number(r.rank) || 50;
    add(r.molecule_name, r.cas_number, Math.max(40, 100 - rank * 2), 'market_intelligence');
  }

  const ranked = [...byMolecule.values()].sort((a, b) => b.score - a.score);
  return { ranked, seo_queries: seoRows.length, seo_matched: seoMatched, mh_count: mhRows.length };
}

// ── Step 2 — catalog validation ───────────────────────────────────────────────
// Everything Claude asserts about availability comes from here, never from the
// model. A molecule we don't stock must not produce an email promising stock.
async function validateAgainstCatalog(molecules) {
  const out = [];
  for (const m of molecules) {
    const sku = (await query(
      `SELECT name, cas_number, purity, sale_price, currency, coa_status, sds_status, is_gmp, units_in_stock
       FROM skus WHERE is_active = 1 AND (LOWER(name) = LOWER($1) OR (cas_number IS NOT NULL AND cas_number = $2))
       LIMIT 1`, [m.molecule_name, m.cas_number]
    )).rows[0];
    const mh = (await query(
      `SELECT in_catalog FROM molecule_history WHERE LOWER(molecule_name) = LOWER($1)
       ORDER BY created_at DESC LIMIT 1`, [m.molecule_name]
    )).rows[0];
    out.push({
      ...m,
      cas_number: m.cas_number || sku?.cas_number || null,
      in_catalog: !!sku || Number(mh?.in_catalog) === 1,
      has_coa: sku?.coa_status === 'available' || sku?.coa_status === 'complete',
      has_sds: sku?.sds_status === 'available' || sku?.sds_status === 'complete',
      purity: sku?.purity || null,
      price: sku?.sale_price ? Number(sku.sale_price) : null,
      currency: sku?.currency || 'USD',
      is_gmp: Number(sku?.is_gmp) === 1,
    });
  }
  return out;
}

// ── Step 3 — campaign generation ──────────────────────────────────────────────
function buildPrompt(mol, seg) {
  const facts = [
    `Molecule: ${mol.molecule_name}`,
    `CAS number: ${mol.cas_number || 'not available — omit the CAS line entirely if not available'}`,
    `Purity spec: ${mol.purity || 'not published — do not state a purity figure'}`,
    `In Abiozen catalog right now: ${mol.in_catalog ? 'YES' : 'NO — this is a sourcing enquiry, not a stock offer'}`,
    `COA available: ${mol.has_coa ? 'YES' : 'NO — do not promise a COA'}`,
    `SDS available: ${mol.has_sds ? 'YES' : 'NO — do not promise an SDS'}`,
    `GMP grade: ${mol.is_gmp ? 'YES' : 'NO / unconfirmed'}`,
    `Indicative price: ${mol.price ? `${mol.currency} ${mol.price} per kg` : 'not published — invite them to request a quote instead of naming a price'}`,
  ].join('\n');

  return `You write B2B pharmaceutical sourcing emails for Abiozen, a specialty chemical and API supplier.

VERIFIED FACTS — these are the only claims you may make about availability, documentation or price. Never invent a fact that is not listed. If a fact says NO or "not available", you must not imply otherwise.
${facts}

BUYER SEGMENT: ${seg.label}
${seg.brief}

Write TWO different emails to this segment about this molecule.

Email A — direct / product-focused:
- Subject: name the specific molecule and its availability status.
- Body: specs, what documentation exists, pricing posture, clear call to action.
- Tone: direct, procurement-focused. No storytelling.

Email B — insight / market-focused:
- Subject: lead with a market trend or demand signal, not the product.
- Body: why this molecule matters right now, market context, soft call to action.
- Tone: consultative and educational. Sound like a supply-chain analyst, not a rep.

HTML requirements for BOTH emails:
- Valid standalone HTML, table-based, mobile-responsive (max-width 600px, inline CSS only, no <style> block, no external CSS, no JavaScript).
- At the very top: <div class="logo-placeholder">[ABIOZEN LOGO]</div>
- Display the molecule name prominently; include CAS and purity ONLY if supplied above.
- A "Request Quote" button linking to mailto:sales@abiozen.com with a relevant subject line.
- At the bottom: <a href="{{unsubscribe_url}}">Unsubscribe</a>
- Professional pharma-industry design: restrained palette, generous whitespace, no emoji, no marketing hype.
- Under 500 words of body copy each.

Return ONLY this JSON object, no prose, no code fences:
{"variant_a":{"subject":"...","html":"..."},"variant_b":{"subject":"...","html":"..."}}`;
}

// ── Step 5 — Apollo sequence payload ──────────────────────────────────────────
// Built for every campaign at generation time (cheap, deterministic) so the
// publish endpoint has nothing left to compute. Step 3 is a plain-text nudge
// generated here rather than by Claude — a one-line follow-up does not warrant
// its own API call.
function buildApolloPayload(campaign, mol, seg, week) {
  const name = `${campaign.molecule_name} — ${seg.label} — Week of ${week}`;
  const nudge = mol.in_catalog
    ? `Following up on ${campaign.molecule_name}. We hold stock and can turn a quote around same day — worth a short call?`
    : `Following up on ${campaign.molecule_name}. We can run a sourcing check against our supplier network if it is still on your list.`;
  return {
    name,
    permissions: 'team_can_use',
    active: false,
    emailer_steps: [
      { position: 1, wait_days: 0, type: 'auto_email', subject: campaign.variant_a_subject, body_html: campaign.variant_a_html },
      { position: 2, wait_days: 3, type: 'auto_email', subject: campaign.variant_b_subject, body_html: campaign.variant_b_html },
      { position: 3, wait_days: 7, type: 'auto_email', subject: `Re: ${campaign.variant_a_subject}`, body_html: `<p>${nudge}</p><p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>` },
    ],
  };
}

/**
 * @param {string}  opts.weekStart      ISO Monday; defaults to the current week.
 * @param {boolean} opts.dryRun         Generate nothing, return the resolved molecule list only.
 * @param {number}  opts.topMolecules   How many molecules to cover (default 5 → 20 campaigns).
 */
async function runEmailEngine({ weekStart, dryRun = false, topMolecules = 5 } = {}) {
  const week = weekStart || isoDate(mondayOf());
  const errors = [];

  const signals = await gatherDemandSignals(week);
  if (!signals.ranked.length) {
    return { week_start: week, generated: 0, skipped: 0, errors: ['no demand signals resolved to a known molecule'], ...signals };
  }
  const molecules = await validateAgainstCatalog(signals.ranked.slice(0, topMolecules));

  if (dryRun) {
    return {
      dryRun: true, week_start: week, model: EMAIL_MODEL,
      would_generate: molecules.length * SEGMENTS.length,
      seo_queries: signals.seo_queries, seo_matched: signals.seo_matched, mh_count: signals.mh_count,
      molecules,
    };
  }

  let generated = 0, skipped = 0;
  for (const mol of molecules) {
    for (const seg of SEGMENTS) {
      // Idempotent: re-running the cron must not duplicate or clobber a campaign
      // an admin has already approved or sent.
      const existing = (await query(
        `SELECT id, status FROM email_campaigns WHERE week_start=$1 AND segment=$2 AND LOWER(molecule_name)=LOWER($3)`,
        [week, seg.key, mol.molecule_name]
      )).rows[0];
      if (existing) { skipped++; continue; }

      const { data, error } = await callClaudeEmail(buildPrompt(mol, seg));
      if (error || !data?.variant_a?.html || !data?.variant_b?.html) {
        errors.push(`${mol.molecule_name}/${seg.key}: ${error || 'incomplete variants'}`);
        continue;
      }
      const campaign = {
        id: crypto.randomUUID(),
        molecule_name: mol.molecule_name,
        cas_number: mol.cas_number,
        variant_a_subject: String(data.variant_a.subject || '').slice(0, 300),
        variant_a_html: sanitizeHtml(data.variant_a.html),
        variant_b_subject: String(data.variant_b.subject || '').slice(0, 300),
        variant_b_html: sanitizeHtml(data.variant_b.html),
      };
      const payload = buildApolloPayload(campaign, mol, seg, week);
      await query(
        `INSERT INTO email_campaigns
           (id, week_start, segment, molecule_name, cas_number,
            variant_a_subject, variant_a_html, variant_b_subject, variant_b_html,
            status, apollo_payload, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10,NOW())
         ON CONFLICT (week_start, segment, molecule_name) DO NOTHING`,
        [campaign.id, week, seg.key, campaign.molecule_name, campaign.cas_number,
         campaign.variant_a_subject, campaign.variant_a_html,
         campaign.variant_b_subject, campaign.variant_b_html, JSON.stringify(payload)]
      );
      generated++;
    }
  }

  await logAgentActivity({
    agent_name: 'email-engine', action_type: 'email_campaigns_generated',
    reasoning: `Generated ${generated} campaigns (${generated * 2} variants) across ${SEGMENTS.length} segments for week ${week}.`
      + (skipped ? ` Skipped ${skipped} that already existed.` : '')
      + (errors.length ? ` ${errors.length} failed.` : ''),
    confidence_score: errors.length ? 60 : 90,
    output_summary: `week=${week} generated=${generated} skipped=${skipped} errors=${errors.length}`,
  }).catch(e => console.error('[email-engine] audit failed:', e.message));

  return {
    week_start: week, model: EMAIL_MODEL, generated, skipped,
    molecules: molecules.length, segments: SEGMENTS.length,
    seo_queries: signals.seo_queries, seo_matched: signals.seo_matched, mh_count: signals.mh_count,
    errors,
  };
}

module.exports = { runEmailEngine, SEGMENTS, buildApolloPayload, sanitizeHtml, EMAIL_MODEL };
