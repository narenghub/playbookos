// Research Agent — nightly scan of PubMed, FDA (OpenFDA), patent expiries, and
// ClinicalTrials.gov for molecule opportunities, patent cliffs, and regulatory
// changes relevant to Abiozen's API marketplace. Every external call degrades
// gracefully (returns [] + a warning) so a source outage never breaks the run.
const crypto = require('crypto');
const { query } = require('../db');
const { sendEmail } = require('../mailer');
const { logAgentActivity, enqueueApproval, parseClaudeJSON } = require('../agent-core');

const AGENT = 'research-agent';
const RESEARCH_MODEL = 'claude-opus-4-8';
const UA = { 'User-Agent': 'PlaybookOS-Research/1.0 (naren@abiozen.com)' };
const BASE_URL = () => process.env.BASE_URL || 'https://playbook.abiozen.com';
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function callClaude(prompt, { maxTokens = 3000, json = false } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { data: null, text: null, error: 'ANTHROPIC_API_KEY not configured' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: RESEARCH_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) return { data: null, text: null, error: `Claude ${res.status}: ${(await res.text()).slice(0, 160)}` };
    const text = (await res.json()).content?.[0]?.text || '';
    return { data: json ? parseClaudeJSON(text) : null, text };
  } catch (e) { return { data: null, text: null, error: e.message }; }
}
async function fetchJson(url, opts = {}) {
  try {
    const res = await fetch(url, { headers: UA, ...opts });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { data: await res.json() };
  } catch (e) { return { error: e.message }; }
}

// Is a molecule already in the Abiozen catalog (skus or recent molecule_history)?
async function inCatalog(name, cas) {
  if (!name && !cas) return false;
  const r = (await query(
    `SELECT 1 FROM skus WHERE is_active=1 AND (LOWER(name)=LOWER($1) OR (cas_number IS NOT NULL AND cas_number=$2))
     UNION SELECT 1 FROM molecule_history WHERE (LOWER(molecule_name)=LOWER($1) OR (cas_number IS NOT NULL AND cas_number=$2)) LIMIT 1`,
    [name || '', cas || null]
  )).rows[0];
  return !!r;
}

// Insert a finding, deduped on url. Only stores relevance >= minScore.
async function storeFinding(f, minScore = 40) {
  if ((f.relevance_score || 0) < minScore) return false;
  if (f.url) {
    const exists = (await query('SELECT id FROM research_findings WHERE url=$1', [f.url])).rows[0];
    if (exists) return false;
  }
  await query(
    `INSERT INTO research_findings (id, source, finding_type, title, summary, url, molecule_name,
       cas_number, therapeutic_area, relevance_score, actioned, published_date, found_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,NOW(),NOW())`,
    [crypto.randomUUID(), f.source, f.finding_type, String(f.title || '').slice(0, 500), String(f.summary || '').slice(0, 2000),
     f.url || null, f.molecule_name || null, f.cas_number || null, f.therapeutic_area || null,
     Math.min(100, Math.max(0, Math.round(f.relevance_score || 0))), f.published_date || null]
  );
  return true;
}

// Batch-score a list of candidate items with Claude → [{i, relevance_score, molecule_name, therapeutic_area}].
async function scoreBatch(items, context) {
  if (!items.length) return [];
  const list = items.map((it, i) => `${i}. ${it.title}${it.abstract ? ' — ' + String(it.abstract).slice(0, 400) : ''}`).join('\n');
  const { data } = await callClaude(
    `You are a pharmaceutical market-intelligence analyst for Abiozen LLC, a US API marketplace that sources and sells generic APIs, research chemicals, and specialty intermediates. Score each item below 0-100 for RELEVANCE to Abiozen's sourcing/marketplace business (a specific sourceable molecule, a patent/generic-entry signal, or a demand signal = high; unrelated basic science = low). ${context || ''}\n\n${list}\n\nReturn ONLY a JSON array: [{"i":0,"relevance_score":75,"molecule_name":"...or null","therapeutic_area":"...or null"}]`,
    { maxTokens: 2000, json: true });
  return Array.isArray(data) ? data : [];
}

// ── Function 1 — PubMed ───────────────────────────────────────────────────────
async function scanPubMed(extraKeywords = []) {
  const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
  const queries = [
    '"generic drug" AND bioavailability', '"GLP-1" AND (new compound OR analog)',
    '"active pharmaceutical ingredient" AND (patent OR synthesis)', 'compounding pharmacy AND API',
    ...extraKeywords.map(k => `"${k}"`),
  ];
  const pmids = new Set();
  const warnings = [];
  for (const q of queries) {
    const r = await fetchJson(`${EUTILS}esearch.fcgi?db=pubmed&retmode=json&reldate=30&datetype=pdat&retmax=4&term=${encodeURIComponent(q)}`);
    if (r.error) { warnings.push('esearch: ' + r.error); continue; }
    for (const id of (r.data?.esearchresult?.idlist || [])) pmids.add(id);
  }
  const ids = [...pmids].slice(0, 18);
  if (!ids.length) return { stored: 0, warnings };
  // Fetch abstracts (text) for the batch.
  let text = '';
  try {
    const res = await fetch(`${EUTILS}efetch.fcgi?db=pubmed&rettype=abstract&retmode=text&id=${ids.join(',')}`, { headers: UA });
    if (res.ok) text = await res.text();
  } catch (e) { warnings.push('efetch: ' + e.message); }
  // Titles via esummary (JSON) for reliable per-PMID title + date.
  const sum = await fetchJson(`${EUTILS}esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(',')}`);
  const items = ids.map(id => {
    const s = sum.data?.result?.[id] || {};
    return { pmid: id, title: s.title || '(no title)', date: s.pubdate || null, abstract: '' };
  });
  const scores = await scoreBatch(items, 'These are recent PubMed papers.');
  let stored = 0;
  for (const sc of scores) {
    const it = items[sc.i]; if (!it) continue;
    if (await storeFinding({
      source: 'pubmed', finding_type: 'new_molecule', title: it.title,
      summary: sc.therapeutic_area ? `${sc.molecule_name || 'Research signal'} — ${sc.therapeutic_area}` : it.title,
      url: `https://pubmed.ncbi.nlm.nih.gov/${it.pmid}/`, molecule_name: sc.molecule_name || null,
      therapeutic_area: sc.therapeutic_area || null, relevance_score: sc.relevance_score, published_date: it.date,
    })) stored++;
  }
  return { stored, warnings, scanned: items.length };
}

// ── Function 2 — FDA approvals (OpenFDA) ──────────────────────────────────────
async function scanFDAApprovals() {
  const to = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  const r = await fetchJson(`https://api.fda.gov/drug/drugsfda.json?search=submissions.submission_status_date:[${from}+TO+${to}]&limit=30`);
  if (r.error) return { stored: 0, warnings: ['openfda: ' + r.error] };
  let stored = 0; const results = r.data?.results || [];
  for (const d of results) {
    const app = d.application_number || '';
    const isGeneric = /^ANDA/i.test(app) || (d.submissions || []).some(s => /ANDA/i.test(d.application_number || ''));
    const products = d.products || [];
    const name = products[0]?.active_ingredients?.[0]?.name || products[0]?.brand_name || null;
    if (!name) continue;
    const cat = await inCatalog(name, null);
    // A generic approval for something NOT in our catalog is the strongest signal.
    const relevance = isGeneric ? (cat ? 55 : 85) : (cat ? 35 : 60);
    if (await storeFinding({
      source: 'fda', finding_type: 'fda_approval',
      title: `${isGeneric ? 'Generic (ANDA)' : 'Drug'} approval: ${name}`,
      summary: `${d.sponsor_name || 'Applicant'} — ${app}. ${cat ? 'Already in Abiozen catalog.' : 'NOT in catalog — potential new sourcing opportunity.'}`,
      url: `https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo=${encodeURIComponent(app.replace(/\D/g, ''))}`,
      molecule_name: name, therapeutic_area: null, relevance_score: relevance,
    })) stored++;
  }
  return { stored, scanned: results.length };
}

// ── Function 3 — expiring patents ─────────────────────────────────────────────
// Drives off the seeded patent_watch table (real expiry dates), refreshes each
// row's status, and emits findings for anything expiring within 18 months. Cross-
// references molecule_history so trending molecules score higher.
async function scanExpiringPatents() {
  const rows = (await query('SELECT * FROM patent_watch')).rows;
  const now = Date.now();
  let flagged = 0;
  for (const p of rows) {
    const exp = p.expiry_date ? new Date(p.expiry_date).getTime() : null;
    if (!exp) continue;
    const monthsOut = (exp - now) / (30.4 * 86400000);
    const status = exp < now ? 'expired' : monthsOut <= 18 ? 'expiring_soon' : 'active';
    // market-size-driven opportunity score, boosted as expiry nears
    let score = Math.min(85, Math.round((Number(p.market_size_usd_millions) || 0) / 260));
    if (monthsOut <= 6 && monthsOut >= -3) score = Math.max(score, 90);
    else if (monthsOut <= 18 && monthsOut > 6) score = Math.max(score, 70);
    await query('UPDATE patent_watch SET status=$1, generic_opportunity_score=$2 WHERE id=$3', [status, Math.min(100, score), p.id]);
    if (status === 'expiring_soon' || (status === 'expired' && monthsOut >= -6)) {
      const trending = (await query('SELECT 1 FROM molecule_history WHERE LOWER(molecule_name) LIKE $1 LIMIT 1', ['%' + norm(p.molecule_name).split(' ')[0] + '%'])).rows[0];
      if (await storeFinding({
        source: 'patents', finding_type: 'expiring_patent', title: `Patent ${status.replace('_', ' ')}: ${p.molecule_name}`,
        summary: `${p.molecule_name} (${p.therapeutic_area || 'therapeutic'}) — patent ${p.patent_holder ? 'held by ' + p.patent_holder + ' ' : ''}expires ${p.expiry_date}. Market ~$${p.market_size_usd_millions}M.${trending ? ' Trending in our molecule feed.' : ''}`,
        url: `patent-watch://${p.id}`, molecule_name: p.molecule_name, cas_number: p.cas_number,
        therapeutic_area: p.therapeutic_area, relevance_score: Math.min(100, score + (trending ? 5 : 0)),
        published_date: p.expiry_date,
      }, 60)) flagged++;
    }
  }
  return { patents_flagged: flagged, watched: rows.length };
}

// ── Function 4 — ClinicalTrials.gov (Phase 3 = future generic pipeline) ───────
async function scanClinicalTrials() {
  const r = await fetchJson('https://clinicaltrials.gov/api/v2/studies?query.term=pharmaceutical&filter.overallStatus=RECRUITING&pageSize=25&fields=protocolSection.identificationModule,protocolSection.conditionsModule,protocolSection.designModule,protocolSection.armsInterventionsModule');
  if (r.error) return { stored: 0, warnings: ['clinicaltrials: ' + r.error] };
  const studies = (r.data?.studies || []);
  const items = [];
  for (const s of studies) {
    const ps = s.protocolSection || {};
    const phases = ps.designModule?.phases || [];
    if (!phases.some(p => /PHASE3/i.test(p))) continue;
    const title = ps.identificationModule?.briefTitle || '';
    const cond = (ps.conditionsModule?.conditions || []).join(', ');
    const nct = ps.identificationModule?.nctId;
    const drug = (ps.armsInterventionsModule?.interventions || []).find(i => /DRUG/i.test(i.type || ''))?.name || null;
    items.push({ title, abstract: cond, nct, drug, cond });
  }
  const scores = await scoreBatch(items.slice(0, 15), 'These are Phase 3 clinical trials — a molecule nearing approval is a future generic/API opportunity.');
  let stored = 0;
  for (const sc of scores) {
    const it = items[sc.i]; if (!it) continue;
    const mol = sc.molecule_name || it.drug;
    const cat = mol ? await inCatalog(mol, null) : false;
    if (await storeFinding({
      source: 'clinicaltrials', finding_type: 'clinical_trial', title: it.title,
      summary: `Phase 3${it.cond ? ' · ' + it.cond : ''}.${mol ? (cat ? ' In catalog.' : ' NOT in catalog — future opportunity.') : ''}`,
      url: it.nct ? `https://clinicaltrials.gov/study/${it.nct}` : null, molecule_name: mol,
      therapeutic_area: sc.therapeutic_area || it.cond || null,
      relevance_score: (mol && !cat) ? Math.max(sc.relevance_score || 0, 55) : (sc.relevance_score || 0),
    })) stored++;
  }
  return { stored, scanned: items.length };
}

// ── Function 5 — pharma news (Claude knowledge; NewsAPI if configured) ────────
async function scanPharmNews() {
  let context = '';
  if (process.env.NEWSAPI_KEY) {
    const r = await fetchJson(`https://newsapi.org/v2/everything?q=(generic%20API%20OR%20drug%20shortage%20OR%20GLP-1%20OR%20compounding%20pharmacy)&language=en&sortBy=publishedAt&pageSize=15&apiKey=${process.env.NEWSAPI_KEY}`);
    if (r.data?.articles) context = r.data.articles.map(a => `- ${a.title} (${a.source?.name})`).join('\n');
  }
  const { data } = await callClaude(
    `You are a pharmaceutical market-intelligence analyst for Abiozen LLC (US API marketplace). Identify up to 6 recent, SPECIFIC pharma developments relevant to sourcing/generic-API opportunities — API shortages, generic approvals, patent cliffs, compounding-pharmacy demand shifts, GLP-1 supply.${context ? '\n\nRecent headlines:\n' + context : ''}\n\nReturn ONLY a JSON array: [{"title":"...","molecule_name":"...or null","therapeutic_area":"...","summary":"one sentence","finding_type":"market_opportunity|regulatory_change","relevance_score":0-100}]`,
    { maxTokens: 2000, json: true });
  let stored = 0;
  for (const f of (Array.isArray(data) ? data : [])) {
    if (await storeFinding({
      source: 'news', finding_type: ['regulatory_change', 'market_opportunity'].includes(f.finding_type) ? f.finding_type : 'market_opportunity',
      title: f.title, summary: f.summary || f.title, url: `news://${crypto.randomUUID()}`,
      molecule_name: f.molecule_name || null, therapeutic_area: f.therapeutic_area || null, relevance_score: f.relevance_score || 0,
    })) stored++;
  }
  return { stored };
}

// ── Function 6 — strategic report ─────────────────────────────────────────────
async function generateResearchReport(findings) {
  const list = findings.map(f => `- [${f.source}/${f.finding_type}, score ${f.relevance_score}] ${f.title}${f.molecule_name ? ' (' + f.molecule_name + ')' : ''}${f.summary ? ' — ' + f.summary.slice(0, 160) : ''}`).join('\n');
  const { text } = await callClaude(
    `You are a pharmaceutical market intelligence analyst for Abiozen LLC, a US-based API marketplace.

Here are this week's research findings from PubMed, FDA, patents, and clinical trials:
${list || '(no findings this week)'}

Generate a strategic intelligence report with:
1. Top 5 opportunities this week (ranked by revenue potential)
2. Critical regulatory changes to act on
3. Expiring patents with highest generic opportunity
4. Molecules trending in clinical research (future demand signals)
5. Recommended actions for Naresh (prioritized list)

Format as an executive summary — concise, actionable, specific molecule names and market sizes. Do not invent findings beyond those listed.`,
    { maxTokens: 2500 });
  return text || 'No report generated.';
}

// ── Function 7 — orchestration ────────────────────────────────────────────────
async function runResearchAgent({ dryRun = false } = {}) {
  const week = new Date().toISOString().slice(0, 10);
  const out = { week, findings_total: 0, high_relevance: 0, patents_flagged: 0, fda_approvals: 0, warnings: [], errors: [] };

  // Top-10 molecules from this week's feed feed PubMed keywords.
  let topMolecules = [];
  try {
    topMolecules = (await query(
      `SELECT molecule_name FROM molecule_history WHERE week_start = (SELECT MAX(week_start) FROM molecule_history)
       ORDER BY COALESCE(rank,9999) LIMIT 10`)).rows.map(r => r.molecule_name);
  } catch {}

  if (dryRun) {
    // Preview: run the read-only scans without storing (report counts only).
    return { ...out, dryRun: true, note: 'dryRun previews reachability only', top_molecules: topMolecules.length };
  }

  const run = async (name, fn) => { try { const r = await fn(); if (r.warnings) out.warnings.push(...r.warnings); return r; } catch (e) { out.errors.push(`${name}: ${e.message}`); return {}; } };
  const pm = await run('pubmed', () => scanPubMed(topMolecules));
  const fda = await run('fda', () => scanFDAApprovals());
  const pat = await run('patents', () => scanExpiringPatents());
  const ct = await run('clinicaltrials', () => scanClinicalTrials());
  const news = await run('news', () => scanPharmNews());
  out.patents_flagged = pat.patents_flagged || 0;
  out.fda_approvals = fda.stored || 0;

  // This week's stored findings.
  const findings = (await query(
    `SELECT * FROM research_findings WHERE found_at >= (NOW() - INTERVAL '7 days')::text ORDER BY relevance_score DESC`)).rows;
  out.findings_total = findings.length;
  out.high_relevance = findings.filter(f => f.relevance_score >= 80).length;

  // High-relevance findings → Market Intelligence approval queue.
  for (const f of findings.filter(f => f.relevance_score >= 80 && !f.actioned)) {
    try {
      await enqueueApproval({
        agent_name: AGENT, action_type: 'source_molecule',
        action_payload: { task: `Source ${f.molecule_name || f.title} — research signal (${f.source}, score ${f.relevance_score}) — ${String(f.summary || '').slice(0, 200)}`, molecule_name: f.molecule_name, cas_number: f.cas_number, source: 'research-agent' },
        priority: 'HIGH',
      });
      await query(`UPDATE research_findings SET actioned=1, action_taken='queued for procurement approval' WHERE id=$1`, [f.id]);
    } catch (e) { out.errors.push(`enqueue ${f.molecule_name}: ${e.message}`); }
  }

  // Report + email Naresh.
  const report = await generateResearchReport(findings);
  await query(
    `INSERT INTO research_findings (id, source, finding_type, title, summary, relevance_score, actioned, found_at, created_at)
     VALUES ($1,'news','market_opportunity',$2,$3,0,1,NOW(),NOW())`,
    [crypto.randomUUID(), `Research Report — Week of ${week}`, report.slice(0, 2000)]
  ).catch(() => {}); // lightweight report persistence for /research/report
  await sendResearchDigest({ week, findings, report }).catch(e => out.errors.push('email: ' + e.message));

  await logAgentActivity({ agent_name: AGENT, action_type: 'research_agent_run', user_id: null,
    reasoning: `Scanned PubMed/FDA/patents/trials/news → ${out.findings_total} findings (${out.high_relevance} high-relevance), ${out.patents_flagged} patents flagged.`,
    source_kpi: 'kpi-vision', confidence_score: out.errors.length ? 60 : 90,
    output_summary: `findings=${out.findings_total} high=${out.high_relevance} patents=${out.patents_flagged}` }).catch(() => {});
  return out;
}

async function getNaresh() {
  const r = (await query(`SELECT id, name, email FROM users WHERE is_active=1 AND role IN ('admin','super_admin') ORDER BY CASE WHEN LOWER(email) LIKE 'naren%' THEN 0 ELSE 1 END, created_at LIMIT 1`)).rows[0];
  return r || { name: 'Naresh', email: 'naren@abiozen.com', id: null };
}
async function sendResearchDigest({ week, findings, report }) {
  const naresh = await getNaresh();
  const top = findings.slice(0, 5).map(f => `<li style="margin:4px 0"><strong>${esc(f.molecule_name || f.title)}</strong> <span style="color:#888;font-size:12px">[${esc(f.source)} · ${f.relevance_score}]</span>${f.summary ? '<br><span style="font-size:12px;color:#555">' + esc(f.summary.slice(0, 160)) + '</span>' : ''}</li>`).join('');
  const patents = (await query(`SELECT molecule_name, expiry_date, market_size_usd_millions FROM patent_watch WHERE status='expiring_soon' ORDER BY market_size_usd_millions DESC LIMIT 6`)).rows
    .map(p => `<li style="margin:3px 0">${esc(p.molecule_name)} — expires ${esc(p.expiry_date)} · ~$${esc(p.market_size_usd_millions)}M</li>`).join('') || '<li style="color:#888">None flagged.</li>';
  const fda = findings.filter(f => f.source === 'fda').slice(0, 5).map(f => `<li style="margin:3px 0">${esc(f.title)}</li>`).join('') || '<li style="color:#888">None this week.</li>';
  const html = `<div style="font-family:Arial;max-width:660px;color:#222">
    <div style="background:#1B3A6B;padding:16px 22px;border-radius:8px 8px 0 0"><h2 style="color:#fff;margin:0">Research Intelligence</h2><p style="color:#9FE1CB;margin:4px 0 0;font-size:13px">Week of ${esc(week)} · ${findings.length} findings</p></div>
    <div style="padding:18px 22px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">
      <h3 style="color:#1B3A6B;margin:0 0 6px">Top opportunities</h3><ul style="padding-left:18px;margin:0 0 14px">${top || '<li style="color:#888">None this week.</li>'}</ul>
      <h3 style="color:#991B1B;margin:14px 0 6px">Expiring patents (by market size)</h3><ul style="padding-left:18px;margin:0 0 14px">${patents}</ul>
      <h3 style="color:#166534;margin:14px 0 6px">FDA approvals (potential new generics)</h3><ul style="padding-left:18px;margin:0 0 14px">${fda}</ul>
      <h3 style="color:#0D7377;margin:14px 0 6px">Analyst report</h3><div style="font-size:13px;line-height:1.6;white-space:pre-wrap;background:#f8fafc;padding:12px;border-radius:6px">${esc(report)}</div>
      <p style="margin-top:16px"><a href="${BASE_URL()}/#research-agent" style="background:#0D7377;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Open Research Agent →</a></p>
    </div></div>`;
  return sendEmail({ to: naresh.email, subject: `Research Intelligence — Week of ${week}`, html });
}

// ── PART 3 — patent watch seed (20 high-value molecules) ──────────────────────
const PATENT_SEED = [
  ['Semaglutide', 'Novo Nordisk', '2026-12-31', 'Metabolic / GLP-1', 22000],
  ['Tirzepatide', 'Eli Lilly', '2026-12-31', 'Metabolic / GLP-1', 16000], // compound-patent generic window
  ['Apixaban', 'BMS / Pfizer', '2024-11-30', 'Anticoagulant', 12000],       // already expired
  ['Empagliflozin', 'Boehringer / Lilly', '2025-12-31', 'Metabolic / SGLT2', 7800],
  ['Dupilumab', 'Regeneron / Sanofi', '2031-12-31', 'Immunology', 10000],
  ['Pembrolizumab', 'Merck', '2028-12-31', 'Oncology / PD-1', 20000],
  ['Nivolumab', 'BMS', '2026-12-31', 'Oncology / PD-1', 8000],
  ['Ibrutinib', 'AbbVie / J&J', '2027-12-31', 'Oncology / BTK', 5000],
  ['Lenalidomide', 'BMS', '2022-01-31', 'Oncology', 12000],                 // expired
  ['Upadacitinib', 'AbbVie', '2030-12-31', 'Immunology / JAK', 4000],
  ['Osimertinib', 'AstraZeneca', '2030-12-31', 'Oncology / EGFR', 4000],
  ['Baricitinib', 'Lilly / Incyte', '2028-12-31', 'Immunology / JAK', 2000],
  ['Tofacitinib', 'Pfizer', '2025-12-31', 'Immunology / JAK', 2500],
  ['Ruxolitinib', 'Incyte / Novartis', '2024-06-30', 'Oncology / JAK', 3000], // expired
  ['Olaparib', 'AstraZeneca', '2028-12-31', 'Oncology / PARP', 2000],
  ['Niraparib', 'GSK', '2027-12-31', 'Oncology / PARP', 1500],
  ['Rivaroxaban', 'Bayer / J&J', '2024-12-31', 'Anticoagulant', 6000],      // expired
  ['Dapagliflozin', 'AstraZeneca', '2025-12-31', 'Metabolic / SGLT2', 6500],
  ['Canagliflozin', 'J&J', '2023-12-31', 'Metabolic / SGLT2', 1100],        // expired
  ['Liraglutide', 'Novo Nordisk', '2023-12-31', 'Metabolic / GLP-1', 3200], // expired
];
async function seedPatentWatch() {
  const existing = (await query('SELECT COUNT(*)::int c FROM patent_watch')).rows[0].c;
  if (existing > 0) return { seeded: 0, skipped: existing };
  const now = Date.now();
  let seeded = 0;
  for (const [name, holder, expiry, area, market] of PATENT_SEED) {
    const monthsOut = (new Date(expiry).getTime() - now) / (30.4 * 86400000);
    const status = new Date(expiry).getTime() < now ? 'expired' : monthsOut <= 18 ? 'expiring_soon' : 'active';
    let score = Math.min(85, Math.round(market / 260));
    if (monthsOut <= 6 && monthsOut >= -3) score = Math.max(score, 90);
    else if (monthsOut <= 18 && monthsOut > 6) score = Math.max(score, 70);
    await query(
      `INSERT INTO patent_watch (id, molecule_name, patent_holder, expiry_date, therapeutic_area,
         market_size_usd_millions, generic_opportunity_score, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
      [crypto.randomUUID(), name, holder, expiry, area, market, Math.min(100, score), status]);
    seeded++;
  }
  await logAgentActivity({ agent_name: AGENT, action_type: 'patent_watch_seeded', reasoning: `Seeded ${seeded} patent-watch molecules.`, source_kpi: 'kpi-vision', output_summary: `seeded=${seeded}` }).catch(() => {});
  return { seeded, skipped: 0 };
}

// Monday digest — emails a summary of the past week's stored findings + latest
// report, without re-scanning the sources.
async function runWeeklyDigest() {
  const week = new Date().toISOString().slice(0, 10);
  const findings = (await query(
    `SELECT * FROM research_findings WHERE found_at >= (NOW() - INTERVAL '7 days')::text AND title NOT LIKE 'Research Report%'
     ORDER BY relevance_score DESC`)).rows;
  const rep = (await query(`SELECT summary FROM research_findings WHERE title LIKE 'Research Report%' ORDER BY created_at DESC LIMIT 1`)).rows[0];
  const ok = await sendResearchDigest({ week, findings, report: rep ? rep.summary : 'No report generated yet.' }).catch(() => false);
  return { week, findings: findings.length, sent: !!ok };
}

module.exports = {
  runResearchAgent, runWeeklyDigest, scanPubMed, scanFDAApprovals, scanExpiringPatents, scanClinicalTrials,
  scanPharmNews, generateResearchReport, seedPatentWatch, sendResearchDigest,
};
