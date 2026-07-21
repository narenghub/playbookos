// Procurement Agent — daily sourcing briefing (v1) + automated supplier outreach (v2).
// v1: pulls market-intelligence demand and has Claude propose sourcing tasks, routed
// to the approval queue for the CEO.
// v2: takes APPROVED sourcing tasks, matches suppliers, generates + sends RFQ emails
// from Palash, and scores the responses he logs — eliminating manual supplier research.
const crypto = require('crypto');
const { query } = require('../db');
const { runClaudeAnalysis } = require('../core');
const { sendEmail } = require('../mailer');
const { logAgentActivity, enqueueApproval, getCEOUser, parseClaudeJSON } = require('../agent-core');

const AGENT = 'procurement-agent';
const PROC_MODEL = 'claude-opus-4-8';
const BASE_URL = () => process.env.BASE_URL || 'https://playbook.abiozen.com';

function mondayOf(date = new Date()) {
  const d = new Date(date);
  const off = d.getUTCDay() === 0 ? -6 : 1 - d.getUTCDay();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + off)).toISOString().slice(0, 10);
}
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Direct Claude call. json:true returns parsed JSON (or null); else raw text.
async function callClaude(prompt, { maxTokens = 1500, json = false } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { data: null, text: null, error: 'ANTHROPIC_API_KEY not configured' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: PROC_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) return { data: null, text: null, error: `Claude ${res.status}: ${(await res.text()).slice(0, 160)}` };
    const text = (await res.json()).content?.[0]?.text || '';
    return { data: json ? parseClaudeJSON(text) : null, text };
  } catch (e) { return { data: null, text: null, error: e.message }; }
}

// Palash (procurement_director) is the RFQ sender + recipient of comparisons.
async function getPalash() {
  return (await query(
    `SELECT id, name, email FROM users WHERE role='procurement_director' AND is_active=1 ORDER BY created_at LIMIT 1`
  )).rows[0] || { name: 'Palash Das', email: 'palash@abiozen.com', id: null };
}
// Naresh gets the weekly brief.
async function getNaresh() {
  const r = (await query(
    `SELECT id, name, email FROM users WHERE is_active=1 AND role IN ('admin','super_admin')
     ORDER BY CASE WHEN LOWER(email) LIKE 'naren%' THEN 0 ELSE 1 END, created_at LIMIT 1`
  )).rows[0];
  return r || (await getCEOUser());
}

async function runProcurementBriefing({ dryRun = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const ceo = await getCEOUser();

  // Latest growth-intelligence analysis — molecules buyers search for but we lack.
  let topMolecules = [];
  const gi = (await query(
    `SELECT content FROM ai_analyses WHERE analysis_type='growth_intelligence' ORDER BY created_at DESC LIMIT 1`
  )).rows[0];
  if (gi) {
    try { topMolecules = (JSON.parse(gi.content).top_molecules || []).slice(0, 10); } catch {}
  }

  const pendingCoa = (await query(
    `SELECT name, COALESCE(coa_status,'pending') coa_status FROM skus
     WHERE is_active=1 AND COALESCE(coa_status,'pending') <> 'approved'
     ORDER BY name LIMIT 15`
  )).rows;
  const activeSkus = parseInt((await query(
    `SELECT COUNT(*) c FROM skus WHERE is_active=1`)).rows[0].c, 10);

  const demandText = topMolecules.length
    ? topMolecules.map((m, i) => `  ${i + 1}. ${m.molecule || m.name || '?'} — demand ${m.demand_signal || m.demand || '?'}, ${m.rationale || ''}`).join('\n')
    : '  (no growth-intelligence demand signals available yet)';
  const coaText = pendingCoa.length
    ? pendingCoa.map(c => `  - ${c.name} (COA: ${c.coa_status})`).join('\n')
    : '  (none)';

  const prompt = `You are the Procurement Agent for Abiozen LLC, a US pharmaceutical API distributor. Generate today's sourcing plan for the procurement team.

CATALOG: ${activeSkus} active SKUs.
BUYER DEMAND — molecules searched for but not yet sourced:
${demandText}
SKUs WITH PENDING COA (cannot be listed until resolved):
${coaText}

Return EXACTLY a JSON array of 5 sourcing tasks, no other text:
[{"molecule":"name","cas":"CAS number or empty","task":"specific sourcing action","rationale":"why this matters for revenue","estimated_value":1500,"priority":"HIGH|MEDIUM|LOW","confidence":80}]
estimated_value is the approximate USD spend to source the molecule. Prioritise high-demand molecules we do not yet carry. Do not invent CAS numbers — leave empty if unknown.`;

  let tasks = [];
  if (!dryRun) {
    const raw = await runClaudeAnalysis(prompt);
    const j = parseClaudeJSON(raw);
    if (Array.isArray(j)) tasks = j.slice(0, 5);
  }

  const queued = [];
  if (!dryRun) {
    for (const t of tasks) {
      const payload = {
        molecule: t.molecule || '', cas: t.cas || '',
        task: t.task || '', rationale: t.rationale || '',
        estimated_value: Number(t.estimated_value) || 0,
        amount: Number(t.estimated_value) || 0,
      };
      const approvalId = await enqueueApproval({
        agent_name: AGENT, action_type: 'procurement_sourcing_task',
        action_payload: payload, requested_for_user_id: ceo ? ceo.id : null,
        priority: ['HIGH', 'MEDIUM', 'LOW'].includes(String(t.priority).toUpperCase())
          ? String(t.priority).toUpperCase() : 'MEDIUM',
      });
      await logAgentActivity({
        agent_name: AGENT, action_type: 'procurement_sourcing_task',
        user_id: ceo ? ceo.id : null,
        reasoning: t.rationale || `Source ${t.molecule} based on buyer demand signals.`,
        source_kpi: 'kpi-sg-procurement',
        confidence_score: Number(t.confidence) || 70,
        output_summary: `Sourcing task queued for approval: ${t.task || t.molecule} (~$${payload.estimated_value}).`,
        requires_approval: true,
      });
      queued.push({ approval_id: approvalId, ...payload, priority: t.priority });
    }
  }

  return {
    generated_at: new Date().toISOString(), date: today,
    demand_molecules: topMolecules.length, pending_coa: pendingCoa.length,
    tasks_queued: queued.length, queued,
    note: 'All sourcing tasks were placed in the approval queue for CEO review before assignment.',
  };
}

// ── Function 1 — supplier database seed ───────────────────────────────────────
// 50 real pharmaceutical-raw-material suppliers (20 India, 20 China, 10 US/EU).
// IMPORTANT: contact_email values are PLAUSIBLE FORMATS for each company's public
// business-development inbox, NOT verified RFQ addresses. Verify (and correct) each
// address in the Supplier Database tab before enabling real outbound sends — an RFQ
// to a guessed address may bounce or reach the wrong desk.
const SUPPLIER_SEED = [
  // ── 20 Indian API manufacturers / CDMOs ──
  { name: 'Divi\'s Laboratories', country: 'India', region: 'india', contact_email: 'bd@divislabs.com', website: 'divislabs.com', specialties: ['GMP API', 'custom synthesis', 'nutraceuticals'], reliability_score: 90, gmp_certified: 1 },
  { name: 'Laurus Labs', country: 'India', region: 'india', contact_email: 'business@lauruslabs.com', website: 'lauruslabs.com', specialties: ['GMP API', 'ARV APIs', 'contract manufacturing'], reliability_score: 88, gmp_certified: 1 },
  { name: 'Aurobindo Pharma', country: 'India', region: 'india', contact_email: 'info@aurobindo.com', website: 'aurobindo.com', specialties: ['GMP API', 'generic APIs', 'intermediates'], reliability_score: 85, gmp_certified: 1 },
  { name: 'Hetero Drugs', country: 'India', region: 'india', contact_email: 'apis@heteroworld.com', website: 'heteroworld.com', specialties: ['GMP API', 'ARV APIs', 'oncology APIs'], reliability_score: 84, gmp_certified: 1 },
  { name: 'Dr. Reddy\'s Laboratories', country: 'India', region: 'india', contact_email: 'api@drreddys.com', website: 'drreddys.com', specialties: ['GMP API', 'custom pharma services'], reliability_score: 89, gmp_certified: 1 },
  { name: 'Cadila / Zydus', country: 'India', region: 'india', contact_email: 'api@zyduslife.com', website: 'zyduslife.com', specialties: ['GMP API', 'intermediates'], reliability_score: 83, gmp_certified: 1 },
  { name: 'Granules India', country: 'India', region: 'india', contact_email: 'sales@granulesindia.com', website: 'granulesindia.com', specialties: ['GMP API', 'PFI', 'paracetamol/metformin'], reliability_score: 82, gmp_certified: 1 },
  { name: 'Neuland Laboratories', country: 'India', region: 'india', contact_email: 'marketing@neulandlabs.com', website: 'neulandlabs.com', specialties: ['GMP API', 'peptide building blocks', 'CDMO'], reliability_score: 84, gmp_certified: 1 },
  { name: 'Sequent Scientific', country: 'India', region: 'india', contact_email: 'info@sequent.in', website: 'sequent.in', specialties: ['GMP API', 'veterinary APIs'], reliability_score: 78, gmp_certified: 1 },
  { name: 'Shilpa Medicare', country: 'India', region: 'india', contact_email: 'api@vbshilpa.com', website: 'shilpamedicare.com', specialties: ['GMP API', 'oncology APIs'], reliability_score: 80, gmp_certified: 1 },
  { name: 'MSN Laboratories', country: 'India', region: 'india', contact_email: 'bd@msnlabs.com', website: 'msnlabs.com', specialties: ['GMP API', 'intermediates'], reliability_score: 81, gmp_certified: 1 },
  { name: 'Vasudha Pharma Chem', country: 'India', region: 'india', contact_email: 'sales@vasudhapharma.com', website: 'vasudhapharma.com', specialties: ['intermediates', 'fine chemicals'], reliability_score: 74, gmp_certified: 0 },
  { name: 'Anthem Biosciences', country: 'India', region: 'india', contact_email: 'contact@anthembio.com', website: 'anthembio.com', specialties: ['custom synthesis', 'CRDMO', 'peptide building blocks'], reliability_score: 82, gmp_certified: 1 },
  { name: 'Syngene International', country: 'India', region: 'india', contact_email: 'business.development@syngeneintl.com', website: 'syngeneintl.com', specialties: ['custom synthesis', 'CRDMO', 'research chemicals'], reliability_score: 86, gmp_certified: 1 },
  { name: 'Sai Life Sciences', country: 'India', region: 'india', contact_email: 'bd@sailife.com', website: 'sailife.com', specialties: ['custom synthesis', 'CDMO', 'intermediates'], reliability_score: 83, gmp_certified: 1 },
  { name: 'Suven Pharmaceuticals', country: 'India', region: 'india', contact_email: 'info@suvenpharm.com', website: 'suvenpharm.com', specialties: ['custom synthesis', 'CDMO'], reliability_score: 80, gmp_certified: 1 },
  { name: 'Aarti Pharmalabs', country: 'India', region: 'india', contact_email: 'sales@aartipharmalabs.com', website: 'aartipharmalabs.com', specialties: ['intermediates', 'GMP API', 'xanthine derivatives'], reliability_score: 78, gmp_certified: 1 },
  { name: 'Optimus Drugs', country: 'India', region: 'india', contact_email: 'marketing@optimusdrugs.com', website: 'optimusdrugs.com', specialties: ['GMP API', 'generic APIs'], reliability_score: 72, gmp_certified: 1 },
  { name: 'Metrochem API', country: 'India', region: 'india', contact_email: 'sales@metrochemapi.com', website: 'metrochemapi.com', specialties: ['GMP API', 'intermediates'], reliability_score: 70, gmp_certified: 1 },
  { name: 'Honour Lab', country: 'India', region: 'india', contact_email: 'bd@honourlab.com', website: 'honourlab.com', specialties: ['GMP API', 'CNS APIs'], reliability_score: 71, gmp_certified: 1 },
  // ── 20 Chinese suppliers ──
  { name: 'Zhejiang Hisun Pharmaceutical', country: 'China', region: 'china', contact_email: 'export@hisunpharm.com', website: 'hisunpharm.com', specialties: ['GMP API', 'fermentation APIs'], reliability_score: 80, gmp_certified: 1 },
  { name: 'Zhejiang Huahai Pharmaceutical', country: 'China', region: 'china', contact_email: 'api@huahaipharm.com', website: 'huahaipharm.com', specialties: ['GMP API', 'sartans', 'intermediates'], reliability_score: 79, gmp_certified: 1 },
  { name: 'North China Pharmaceutical (NCPC)', country: 'China', region: 'china', contact_email: 'export@ncpc.com', website: 'ncpc.com', specialties: ['GMP API', 'antibiotics', 'vitamins'], reliability_score: 77, gmp_certified: 1 },
  { name: 'Zhejiang Jiuzhou Pharmaceutical', country: 'China', region: 'china', contact_email: 'sales@jiuzhou.com.cn', website: 'jiuzhoupharm.com', specialties: ['GMP API', 'custom synthesis', 'CDMO'], reliability_score: 78, gmp_certified: 1 },
  { name: 'Porton Pharma Solutions', country: 'China', region: 'china', contact_email: 'bd@porton.cn', website: 'porton.cn', specialties: ['CDMO', 'custom synthesis', 'intermediates'], reliability_score: 82, gmp_certified: 1 },
  { name: 'Asymchem Laboratories (Tianjin)', country: 'China', region: 'china', contact_email: 'marketing@asymchem.com', website: 'asymchem.com', specialties: ['CDMO', 'cross-coupling reagents', 'custom synthesis'], reliability_score: 84, gmp_certified: 1 },
  { name: 'Pharmaron', country: 'China', region: 'china', contact_email: 'bd@pharmaron.com', website: 'pharmaron.com', specialties: ['CRO/CDMO', 'research chemicals', 'building blocks'], reliability_score: 85, gmp_certified: 1 },
  { name: 'WuXi AppTec', country: 'China', region: 'china', contact_email: 'service@wuxiapptec.com', website: 'wuxiapptec.com', specialties: ['CRDMO', 'building blocks', 'custom synthesis'], reliability_score: 88, gmp_certified: 1 },
  { name: 'Shanghai Desano Chemical', country: 'China', region: 'china', contact_email: 'info@desano.com', website: 'desano.com', specialties: ['GMP API', 'ARV APIs', 'intermediates'], reliability_score: 75, gmp_certified: 1 },
  { name: 'Shanghai Aladdin Biochemical', country: 'China', region: 'china', contact_email: 'sales@aladdin-e.com', website: 'aladdin-e.com', specialties: ['research chemicals', 'reagents', 'building blocks'], reliability_score: 72, gmp_certified: 0 },
  { name: 'Bide Pharmatech (Shanghai)', country: 'China', region: 'china', contact_email: 'sales@bidepharm.com', website: 'bidepharm.com', specialties: ['research chemicals', 'building blocks', 'heterocycles'], reliability_score: 70, gmp_certified: 0 },
  { name: 'Wuhan Fortuna Chemical', country: 'China', region: 'china', contact_email: 'sales@whfortuna.com', website: 'whfortuna.com', specialties: ['fine chemicals', 'intermediates', 'fluorinated building blocks'], reliability_score: 66, gmp_certified: 0 },
  { name: 'Wuhan Senwayer Century Chemical', country: 'China', region: 'china', contact_email: 'sales@senwayer.com', website: 'senwayer.com', specialties: ['research chemicals', 'pharma intermediates'], reliability_score: 62, gmp_certified: 0 },
  { name: 'Hangzhou Dayangchem', country: 'China', region: 'china', contact_email: 'sales@dayangchem.com', website: 'dayangchem.com', specialties: ['fine chemicals', 'cross-coupling reagents', 'catalysts'], reliability_score: 65, gmp_certified: 0 },
  { name: 'Hangzhou Hyper Chemicals', country: 'China', region: 'china', contact_email: 'info@hyperchem.com', website: 'hyperchem.com', specialties: ['fluorine chemistry', 'building blocks'], reliability_score: 64, gmp_certified: 0 },
  { name: 'Jiangsu Yongan Pharmaceutical', country: 'China', region: 'china', contact_email: 'export@yonganpharm.com', website: 'yonganpharm.com', specialties: ['GMP API', 'intermediates'], reliability_score: 68, gmp_certified: 1 },
  { name: 'Nanjing Chemlin Chemical', country: 'China', region: 'china', contact_email: 'sales@chemlin.com.cn', website: 'chemlin.com.cn', specialties: ['research chemicals', 'building blocks', 'boronic acids'], reliability_score: 63, gmp_certified: 0 },
  { name: 'Shandong Xinhua Pharmaceutical', country: 'China', region: 'china', contact_email: 'export@xhzy.com', website: 'xinhuapharm.com', specialties: ['GMP API', 'analgesics', 'caffeine'], reliability_score: 74, gmp_certified: 1 },
  { name: 'Chengdu Boc Sciences (partner)', country: 'China', region: 'china', contact_email: 'sales@bocsci.com', website: 'bocsci.com', specialties: ['research chemicals', 'peptide building blocks', 'reagents'], reliability_score: 67, gmp_certified: 0 },
  { name: 'Zhejiang Tianyu Pharmaceutical', country: 'China', region: 'china', contact_email: 'bd@zjtianyu.com', website: 'tianyupharm.com', specialties: ['GMP API', 'sartans', 'intermediates'], reliability_score: 73, gmp_certified: 1 },
  // ── 10 US/EU distributors ──
  { name: 'Sigma-Aldrich (MilliporeSigma)', country: 'US', region: 'us', contact_email: 'techservice@sial.com', website: 'sigmaaldrich.com', specialties: ['research chemicals', 'reagents', 'reference standards'], reliability_score: 95, gmp_certified: 1 },
  { name: 'TCI America', country: 'US', region: 'us', contact_email: 'sales@tciamerica.com', website: 'tcichemicals.com', specialties: ['research chemicals', 'building blocks', 'reagents'], reliability_score: 92, gmp_certified: 0 },
  { name: 'Oakwood Chemical', country: 'US', region: 'us', contact_email: 'sales@oakwoodchemical.com', website: 'oakwoodchemical.com', specialties: ['building blocks', 'fluorinated reagents', 'heterocycles'], reliability_score: 86, gmp_certified: 0 },
  { name: 'Combi-Blocks', country: 'US', region: 'us', contact_email: 'sales@combi-blocks.com', website: 'combi-blocks.com', specialties: ['building blocks', 'boronic acids', 'cross-coupling reagents'], reliability_score: 87, gmp_certified: 0 },
  { name: 'AK Scientific', country: 'US', region: 'us', contact_email: 'sales@aksci.com', website: 'aksci.com', specialties: ['research chemicals', 'building blocks', 'intermediates'], reliability_score: 82, gmp_certified: 0 },
  { name: 'Fisher Scientific (Thermo)', country: 'US', region: 'us', contact_email: 'custserv@fishersci.com', website: 'fishersci.com', specialties: ['research chemicals', 'reagents', 'lab supply'], reliability_score: 90, gmp_certified: 0 },
  { name: 'Alfa Aesar (Thermo)', country: 'US', region: 'us', contact_email: 'info@alfa.com', website: 'alfa.com', specialties: ['research chemicals', 'metals', 'catalysts'], reliability_score: 88, gmp_certified: 0 },
  { name: 'Enamine (US/EU)', country: 'US', region: 'us', contact_email: 'order@enamine.net', website: 'enamine.net', specialties: ['building blocks', 'screening compounds', 'peptide building blocks'], reliability_score: 89, gmp_certified: 0 },
  { name: 'Fluorochem', country: 'Europe', region: 'europe', contact_email: 'sales@fluorochem.co.uk', website: 'fluorochem.co.uk', specialties: ['fluorine chemistry', 'building blocks', 'reagents'], reliability_score: 84, gmp_certified: 0 },
  { name: 'Carbosynth / Biosynth', country: 'Europe', region: 'europe', contact_email: 'enquiries@biosynth.com', website: 'biosynth.com', specialties: ['carbohydrates', 'nucleosides', 'building blocks'], reliability_score: 83, gmp_certified: 0 },
];

async function seedSupplierDatabase() {
  const existing = (await query('SELECT COUNT(*)::int c FROM suppliers')).rows[0].c;
  if (existing > 0) return { seeded: 0, skipped: existing, note: 'suppliers already populated' };
  let seeded = 0;
  for (const s of SUPPLIER_SEED) {
    await query(
      `INSERT INTO suppliers (id, name, country, region, contact_email, website, specialties,
         reliability_score, avg_response_days, gmp_certified, total_orders, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,NOW(),NOW())`,
      [crypto.randomUUID(), s.name, s.country, s.region, s.contact_email, s.website,
       JSON.stringify(s.specialties), s.reliability_score,
       s.region === 'india' || s.region === 'china' ? 4 : 2, s.gmp_certified]
    );
    seeded++;
  }
  await logAgentActivity({ agent_name: AGENT, action_type: 'supplier_db_seeded',
    reasoning: `Seeded ${seeded} suppliers (20 India, 20 China, 10 US/EU).`, source_kpi: 'kpi-sg-procurement',
    output_summary: `seeded=${seeded}` }).catch(() => {});
  return { seeded, skipped: 0 };
}

// Pull molecule + CAS + targets out of an approval payload (structured fields first,
// then regex over the free-text `task` string).
function parseApproval(payload, actionType) {
  let p = {};
  try { p = typeof payload === 'string' ? JSON.parse(payload) : (payload || {}); } catch {}
  const task = String(p.task || '');
  const casM = task.match(/CAS:?\s*([0-9]{2,7}-[0-9]{2}-[0-9])/i);
  const nameM = task.match(/Source\s+(.+?)\s*\(CAS/i);
  const qtyM = task.match(/Target:?\s*([0-9]+\s*kg)/i);
  const purM = task.match(/([0-9]{2,3}(?:\.[0-9]+)?%\+?)\s*purity/i);
  const category = (task.match(/—\s*([^—]+?)\s*—/) || [])[1] || p.category || null;
  return {
    molecule_name: (p.molecule_name || (nameM && nameM[1]) || '').trim() || null,
    cas_number: p.cas_number || (casM && casM[1]) || null,
    target_quantity: p.target_quantity || (qtyM && qtyM[1]) || '25kg',
    target_purity: p.target_purity || (purM && purM[1]) || '99%',
    category: category ? category.trim() : null,
    gmp_required: actionType === 'source_gmp_api' ? 1 : 0,
  };
}

// Match the best N suppliers for a molecule. Score = specialty overlap + GMP fit +
// cost-region preference (India/China first). Deterministic, no LLM.
async function matchSuppliers(mol, n = 3) {
  const suppliers = (await query('SELECT * FROM suppliers')).rows;
  const cat = String(mol.category || '').toLowerCase();
  const wantGmp = mol.gmp_required === 1;
  const scored = suppliers.map(s => {
    let specs = [];
    try { specs = JSON.parse(s.specialties || '[]'); } catch {}
    const specText = specs.join(' ').toLowerCase();
    let score = (Number(s.reliability_score) || 50) * 0.4; // reliability baseline
    // specialty overlap with the molecule category
    if (cat) for (const w of cat.split(/[^a-z]+/).filter(x => x.length > 3)) if (specText.includes(w)) score += 8;
    if (wantGmp) score += s.gmp_certified ? 25 : -30; else if (specText.includes('research') || specText.includes('building block')) score += 8;
    // cost-region preference for non-GMP; GMP tilts less aggressively
    if (s.region === 'india') score += wantGmp ? 12 : 15;
    else if (s.region === 'china') score += wantGmp ? 8 : 12;
    else score += 3;
    return { supplier: s, matchScore: score };
  }).filter(x => !(wantGmp && !x.supplier.gmp_certified) || true) // GMP handled via score penalty
   .sort((a, b) => b.matchScore - a.matchScore);
  return scored.slice(0, n).map(x => x.supplier);
}

// ── Function 2 — RFQs from approved sourcing tasks ────────────────────────────
async function generateRFQsFromApprovals({ weekStart } = {}) {
  const week = weekStart || mondayOf();
  const approvals = (await query(
    `SELECT id, action_type, action_payload, priority, requested_for_user_id FROM approval_queue
     WHERE action_type IN ('source_molecule','source_gmp_api') AND status='approved'
     ORDER BY created_at DESC`
  )).rows;

  const palash = await getPalash();
  const created = [];
  for (const a of approvals) {
    const m = parseApproval(a.action_payload, a.action_type);
    if (!m.molecule_name) continue;
    // Dedup: one RFQ per approval, and unique on (week, molecule).
    const exists = (await query(
      `SELECT id FROM rfq_requests WHERE approval_id=$1 OR (week_start=$2 AND LOWER(molecule_name)=LOWER($3))`,
      [a.id, week, m.molecule_name]
    )).rows[0];
    if (exists) continue;
    const rfqId = crypto.randomUUID();
    await query(
      `INSERT INTO rfq_requests (id, molecule_name, cas_number, target_quantity, target_purity,
         gmp_required, week_start, status, priority, assigned_to_user_id, approval_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10,NOW())
       ON CONFLICT (week_start, molecule_name) DO NOTHING`,
      [rfqId, m.molecule_name, m.cas_number, m.target_quantity, m.target_purity, m.gmp_required,
       week, String(a.priority || 'medium').toLowerCase(), palash.id, a.id]
    );
    const suppliers = await matchSuppliers(m, 3);
    created.push({ rfq_id: rfqId, ...m, suppliers });
  }
  return { week_start: week, rfqs: created };
}

// ── Function 3 — RFQ email copy (Claude) ──────────────────────────────────────
async function generateRFQEmail(mol, supplier, rfqId) {
  const gmpBlock = mol.gmp_required
    ? '- GMP certificate and DMF availability (this is a GMP-grade requirement)\n' : '';
  const prompt = `Write a professional pharmaceutical procurement RFQ email from a US API distributor to a supplier. Return ONLY the email body as plain text with line breaks (no subject line, no markdown, no preamble).

Supplier: ${supplier.name}${supplier.contact_name ? ' (attn: ' + supplier.contact_name + ')' : ''}
Molecule: ${mol.molecule_name}${mol.cas_number ? ' (CAS ' + mol.cas_number + ')' : ''}

Request, professionally worded, asking the supplier to quote:
- Price per kg for ${mol.target_quantity || '25kg'}
- Purity specification (target ${mol.target_purity || '99%'})
${gmpBlock}- COA format / availability
- Lead time
- Minimum order quantity
- Sample availability (5-10 g for evaluation)

Tone: concise, courteous, industry-standard B2B pharma procurement. Open with a brief line about Abiozen sourcing this molecule for its US customers. Do NOT invent prices, volumes beyond those stated, or commitments. Close with the signature block exactly:

Palash Das
Procurement Director
Abiozen LLC
palash@abiozen.com`;
  const { text, error } = await callClaude(prompt, { maxTokens: 900 });
  const subject = `RFQ — ${mol.molecule_name}${mol.cas_number ? ' (' + mol.cas_number + ')' : ''} — Abiozen LLC`;
  return { subject, body: text || null, error };
}

// ── Function 4 — send RFQ emails ──────────────────────────────────────────────
// dryRun=true (default is caller's choice) logs the email without sending. Real
// sends go FROM palash@abiozen.com to the supplier's contact_email. NOTE: these
// reach REAL external companies — verify contact_email accuracy before enabling.
async function sendRFQEmails(rfqIds, dryRun = false) {
  const out = { sent: 0, failed: 0, skipped: 0, dryRun, details: [] };
  const palash = await getPalash();
  const fromLine = `${palash.name || 'Palash Das'} <${palash.email || 'palash@abiozen.com'}>`;

  for (const rfqId of rfqIds) {
    const rfq = (await query('SELECT * FROM rfq_requests WHERE id=$1', [rfqId])).rows[0];
    if (!rfq) { out.skipped++; continue; }
    const mol = { molecule_name: rfq.molecule_name, cas_number: rfq.cas_number, target_quantity: rfq.target_quantity, target_purity: rfq.target_purity, gmp_required: rfq.gmp_required };
    const suppliers = await matchSuppliers({ ...mol, category: null }, 3);
    let anySent = false;
    for (const s of suppliers) {
      // Skip a supplier already contacted for this RFQ (idempotent).
      const already = (await query('SELECT id FROM supplier_outreach_log WHERE rfq_id=$1 AND supplier_id=$2', [rfqId, s.id])).rows[0];
      if (already) { out.skipped++; continue; }
      const { subject, body, error } = await generateRFQEmail(mol, s, rfqId);
      if (!body) { out.failed++; out.details.push(`${rfq.molecule_name}/${s.name}: ${error || 'no body'}`); continue; }
      const html = `<div style="font-family:Arial;font-size:14px;line-height:1.6;color:#222;white-space:pre-wrap">${esc(body)}</div>`;
      let status = 'sent';
      if (!dryRun) {
        const ok = await sendEmail({ to: s.contact_email, subject, html, from: fromLine, replyTo: palash.email });
        if (!ok) { out.failed++; out.details.push(`${rfq.molecule_name}/${s.name}: send failed`); status = 'failed'; }
      }
      if (status !== 'failed') {
        await query(
          `INSERT INTO supplier_outreach_log (id, rfq_id, supplier_id, email_sent_to, email_subject, email_body, sent_at, status)
           VALUES ($1,$2,$3,$4,$5,$6,NOW(),'sent')`,
          [crypto.randomUUID(), rfqId, s.id, s.contact_email, subject, body]
        );
        out.sent++; anySent = true;
      }
    }
    if (anySent) await query(`UPDATE rfq_requests SET status='sent' WHERE id=$1 AND status='pending'`, [rfqId]);
  }
  return out;
}

// ── Function 5 — score + rank supplier responses ──────────────────────────────
async function scoreAndRankSuppliers(rfqId, { notify = true } = {}) {
  const rfq = (await query('SELECT * FROM rfq_requests WHERE id=$1', [rfqId])).rows[0];
  if (!rfq) return { error: 'RFQ not found' };
  const responses = (await query('SELECT * FROM rfq_responses WHERE rfq_id=$1', [rfqId])).rows;
  if (!responses.length) return { error: 'no responses to score', scored: 0 };

  const prices = responses.map(r => Number(r.price_per_kg)).filter(x => x > 0);
  const leads = responses.map(r => Number(r.lead_time_days)).filter(x => x > 0);
  const minPrice = prices.length ? Math.min(...prices) : 0;
  const minLead = leads.length ? Math.min(...leads) : 0;

  for (const r of responses) {
    let score = 0;
    // Price competitiveness — 30 pts (lowest = 30, scaled inversely)
    if (minPrice > 0 && Number(r.price_per_kg) > 0) score += 30 * (minPrice / Number(r.price_per_kg));
    // Lead time — 20 pts (fastest = 20)
    if (minLead > 0 && Number(r.lead_time_days) > 0) score += 20 * (minLead / Number(r.lead_time_days));
    // GMP/COA — 25 pts
    let doc = 0;
    if (r.coa_available) doc += 12;
    if (/available|yes|gmp|dmf/i.test(String(r.gmp_status || ''))) doc += 13;
    score += Math.min(25, doc);
    // Sample — 10 pts
    if (r.sample_available) score += 10;
    // Supplier reliability — 15 pts
    const rel = r.supplier_id ? (await query('SELECT reliability_score FROM suppliers WHERE id=$1', [r.supplier_id])).rows[0] : null;
    score += 15 * ((rel ? Number(rel.reliability_score) : 60) / 100);
    await query('UPDATE rfq_responses SET score=$1, recommended=0 WHERE id=$2', [Math.round(score), r.id]);
  }
  // Mark the winner
  const ranked = (await query('SELECT * FROM rfq_responses WHERE rfq_id=$1 ORDER BY score DESC', [rfqId])).rows;
  if (ranked[0]) await query('UPDATE rfq_responses SET recommended=1 WHERE id=$1', [ranked[0].id]);
  await query(`UPDATE rfq_requests SET status='compared' WHERE id=$1 AND status IN ('sent','responded')`, [rfqId]);

  // The Claude comparison summary + Palash email are only produced when notifying —
  // per-response re-scoring calls this with notify:false to stay fast/cheap.
  let summary = null;
  if (notify) {
    const table = ranked.map((r, i) => `${i + 1}. ${r.supplier_name}: $${r.price_per_kg}/kg, ${r.lead_time_days}d lead, GMP:${r.gmp_status || '?'}, COA:${r.coa_available ? 'Y' : 'N'}, sample:${r.sample_available ? 'Y' : 'N'}, score ${r.score}`).join('\n');
    summary = (await callClaude(
      `You are a pharmaceutical procurement analyst. In 3-4 sentences, summarise this supplier comparison for ${rfq.molecule_name} and justify the recommended supplier (highest score). Be specific about the price/lead-time/quality trade-off. Do not invent data.\n\n${table}`,
      { maxTokens: 400 })).text;
    const palash = await getPalash();
    const rows = ranked.map((r, i) => `<tr style="background:${i === 0 ? '#f0fdf4' : '#fff'}">
      <td style="padding:6px 10px;border:1px solid #e2e8f0">${i === 0 ? '⭐ ' : ''}${esc(r.supplier_name)}</td>
      <td style="padding:6px 10px;border:1px solid #e2e8f0">$${esc(r.price_per_kg)}/kg</td>
      <td style="padding:6px 10px;border:1px solid #e2e8f0">${esc(r.lead_time_days)}d</td>
      <td style="padding:6px 10px;border:1px solid #e2e8f0">${esc(r.gmp_status || '—')}</td>
      <td style="padding:6px 10px;border:1px solid #e2e8f0">${r.coa_available ? 'Yes' : 'No'}</td>
      <td style="padding:6px 10px;border:1px solid #e2e8f0;font-weight:700">${esc(r.score)}</td></tr>`).join('');
    await sendEmail({
      to: palash.email,
      subject: `Supplier comparison ready — ${rfq.molecule_name}`,
      html: `<div style="font-family:Arial;max-width:640px">
        <h2 style="color:#1B3A6B">Supplier comparison — ${esc(rfq.molecule_name)}</h2>
        <p style="font-size:14px;color:#333">${esc(summary || 'Scored ' + ranked.length + ' responses.')}</p>
        <table style="border-collapse:collapse;font-size:13px;width:100%">
          <tr style="background:#1B3A6B;color:#fff"><th style="padding:6px 10px;text-align:left">Supplier</th><th style="padding:6px 10px">Price</th><th style="padding:6px 10px">Lead</th><th style="padding:6px 10px">GMP</th><th style="padding:6px 10px">COA</th><th style="padding:6px 10px">Score</th></tr>
          ${rows}
        </table>
        <p style="margin-top:14px"><a href="${BASE_URL()}/#procurement-agent" style="background:#0D7377;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Review & approve →</a></p>
      </div>`,
    }).catch(e => console.error('[procurement] comparison email failed:', e.message));
  }

  await logAgentActivity({ agent_name: AGENT, action_type: 'suppliers_scored', user_id: rfq.assigned_to_user_id || null,
    reasoning: `Scored ${ranked.length} responses for ${rfq.molecule_name}; recommended ${ranked[0]?.supplier_name}.`,
    source_kpi: 'kpi-sg-procurement', output_summary: `rfq=${rfqId} scored=${ranked.length} winner=${ranked[0]?.supplier_name}` }).catch(() => {});
  return { rfq_id: rfqId, scored: ranked.length, recommended: ranked[0]?.supplier_name, summary, ranked };
}

// ── Function 6 — orchestration ────────────────────────────────────────────────
async function runProcurementAgent({ dryRun = false, weekStart } = {}) {
  const week = weekStart || mondayOf();
  const { rfqs } = await generateRFQsFromApprovals({ weekStart: week });
  const out = { week_start: week, rfqs_created: rfqs.length, emails_sent: 0, suppliers_contacted: 0, molecules_covered: rfqs.length, dryRun, errors: [] };

  if (rfqs.length) {
    const send = await sendRFQEmails(rfqs.map(r => r.rfq_id), dryRun);
    out.emails_sent = send.sent;
    out.suppliers_contacted = send.sent;
    out.errors = send.details;
  }

  const palash = await getPalash();
  const naresh = await getNaresh();
  if (!dryRun && rfqs.length) {
    const molList = rfqs.map(r => `${r.molecule_name}${r.cas_number ? ' (' + r.cas_number + ')' : ''}`).join(', ');
    await sendEmail({ to: palash.email, subject: `${out.emails_sent} RFQ emails dispatched this week`,
      html: `<div style="font-family:Arial;max-width:600px"><h2 style="color:#1B3A6B">Procurement Agent — RFQs sent</h2>
        <p style="font-size:14px">Sent <strong>${out.emails_sent}</strong> RFQ emails to suppliers for <strong>${rfqs.length}</strong> molecules this week.</p>
        <p style="font-size:13px;color:#555">Molecules: ${esc(molList)}</p>
        <p><a href="${BASE_URL()}/#procurement-agent" style="background:#0D7377;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Open Procurement Agent →</a></p></div>` }).catch(() => {});
    if (naresh && naresh.email && naresh.email !== palash.email) {
      await sendEmail({ to: naresh.email, subject: `Procurement Agent: ${rfqs.length} RFQs dispatched this week`,
        html: `<div style="font-family:Arial"><p>Procurement Agent dispatched <strong>${out.emails_sent}</strong> RFQ emails across <strong>${rfqs.length}</strong> molecules this week (${esc(week)}).</p></div>` }).catch(() => {});
    }
  }

  await logAgentActivity({ agent_name: AGENT, action_type: 'procurement_agent_run', user_id: null,
    reasoning: `Created ${out.rfqs_created} RFQs, sent ${out.emails_sent} supplier emails${dryRun ? ' (dryRun)' : ''} for week ${week}.`,
    source_kpi: 'kpi-sg-procurement', confidence_score: out.errors.length ? 60 : 90,
    output_summary: `rfqs=${out.rfqs_created} emails=${out.emails_sent} dryRun=${dryRun}` }).catch(() => {});
  return out;
}

// Thursday follow-up: flag RFQ outreach with no supplier response after 48h.
async function checkNoResponse({ hours = 48 } = {}) {
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
  const stale = await query(
    `UPDATE supplier_outreach_log SET status='no_response'
     WHERE status='sent' AND replied_at IS NULL AND sent_at < $1 RETURNING id, rfq_id`, [cutoff]
  );
  return { flagged_no_response: stale.rowCount };
}

module.exports = {
  runProcurementBriefing, seedSupplierDatabase, generateRFQsFromApprovals, generateRFQEmail,
  sendRFQEmails, scoreAndRankSuppliers, runProcurementAgent, checkNoResponse, matchSuppliers,
};
