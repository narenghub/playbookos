// ── SiteNex Phase 3 routes: the deal WRITE path, payment schedules, contracts ──
//
// A SEPARATE ROUTER FILE, mounted with one line in server.js after the existing app.use('/api',
// routes). src/api/routes.js is past 5,000 lines and everything added to it makes the next change to
// it riskier; a new surface with its own tests has no reason to live in there.
//
// Both existing gates still apply, because this mounts after them in server.js: the permissions
// resolver (src/lib/permissions/enforce.js) and the product boundary. /api/sitenex/* is already
// wildcarded to the 'sitenex' product in route-map.js, so the boundary classifies these correctly with
// no map edit — but a route that the map cannot classify would FAIL CLOSED, so new paths stay under
// /api/sitenex.
//
// ── THE TWO RULES THAT MATTER MORE THAN THE REST ──────────────────────────────
//
// 1. partner_id IS ALWAYS READ FROM users.partner_id, SERVER-SIDE, AND NEVER FROM THE BODY. A partner
//    who could post partner_id could write a deal into another partner's book, or read it back by
//    writing their own id onto someone else's row. The body's partner_id is not validated, it is
//    IGNORED, and a test asserts that passing one changes nothing.
//
// 2. EVERY READ IS SCOPED WITH partnerScopeSql, including the single-row reads. A list that scopes and
//    a GET /:id that does not is the same leak with one more step: Partner B guesses an integer.
//    Scoping lives in the WHERE, never in a filter the client sends.
//
// ── AND WHO MAY WRITE AT ALL (decided 2026-09-30) ─────────────────────────────
//
// EVERY WRITE IS adminOnly. READS are requireTier('sitenex'), which admits a partner, and are then
// row-scoped. requireTier is NOT sufficient for a write, because the 'sitenex' tier is held by
// super_admin, admin AND partner — so gating a write on the tier alone would let an outside account
// create deals and generate contracts under our terms.
//
// Not left to the permissions resolver either: enforce.js is tighten-only and consults a template only
// for roles listed in PERMISSIONS_ENFORCE_ROLES, so a template that grants a partner no write features
// decides nothing until that env var says so. The template and the middleware now agree, and the
// middleware is the one that holds when the env var is empty.

const express = require('express');
const { query, withTransaction } = require('../lib/db');
const { authMiddleware, requireTier, requireTierRead, adminOnly } = require('../lib/core');
const { partnerScopeSql } = require('../lib/products/partner-scope');
const { territoryScopeSql, territoriesFor, matchTerritory, DIMENSIONS, isDimension } =
  require('../lib/products/territory-scope');
const { packageLabel } = require('../lib/agents/prospecting/findings-text');
const { renderContract, checkRenderable } = require('../lib/sitenex/contract-render');
const { callContent, emailContent } = require('../lib/sitenex/outreach-content');
const { contractEmail, contractFrom } = require('../lib/sitenex/contract-email');
// Deliberately NOT destructured at module load. Resolved at call time so a test can replace it — and
// more to the point, so a test CANNOT FAIL TO replace it: a destructured reference is captured when this
// file is required, before any test runs, and would then send a real email to whatever address the fixture
// happened to carry if RESEND_API_KEY is present in the environment.
const mailer = () => require('../lib/mailer');

const router = express.Router();

// Vocabularies, from the column COMMENTs. Validated at the edge because there is no CHECK — the same
// arrangement as outreach.status, and for the same reason.
const DEAL_STATUSES = ['new', 'contacted', 'proposal_sent', 'signed', 'intake', 'building', 'live', 'lost'];
const PAYMENT_TRIGGERS = ['on_signature', 'on_intake_complete', 'on_first_draft', 'on_launch', 'monthly', 'date'];
const PAYMENT_STATUSES = ['due', 'invoiced', 'paid', 'waived'];
const CONTRACT_STATUSES = ['generated', 'sent', 'signed', 'superseded', 'void'];

// Writable deal columns. An allowlist, so a body key that happens to match a column name — partner_id
// above all — cannot reach the UPDATE by being named correctly.
const DEAL_WRITABLE = ['prospect_id', 'package_code', 'status', 'company_name', 'contact_name',
  'contact_title', 'contact_email', 'contact_phone', 'client_address', 'duration_weeks',
  'starts_at_intake', 'terms_note', 'value_cents', 'monthly_cents', 'proposal_url', 'signed_at'];

const intOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : NaN;
};
const money = (c) => (c == null ? null : c / 100);

function dealShape(r) {
  return { ...r, package_label: packageLabel(r.package_code),
           value_usd: money(r.value_cents), monthly_usd: money(r.monthly_cents) };
}

const DEAL_SELECT = `
  d.id, d.status, d.package_code, d.partner_id, d.prospect_id, d.proposal_url, d.signed_at,
  d.value_cents, d.monthly_cents, d.company_name, d.contact_name, d.contact_title, d.contact_email,
  d.contact_phone, d.client_address, d.duration_weeks, d.starts_at_intake, d.terms_note,
  d.created_at, d.updated_at, d.status_changed_at,
  -- Computed in SQL so "days" is measured against the DATABASE's clock, not the container's. Floor of whole
  -- days, so a deal that moved four hours ago reads 0 and not 1.
  CASE WHEN d.status_changed_at IS NULL THEN NULL
       ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - d.status_changed_at)) / 86400))::int END AS days_in_stage,
  pt.name AS partner_name, pt.primary_contact_email AS partner_email,
  p.name AS prospect_name, p.phone AS prospect_phone, p.region AS prospect_region,
  u.name AS owner_name`;
const DEAL_FROM = `
  FROM sitenex_deals d
  LEFT JOIN prospects p ON p.id = d.prospect_id
  LEFT JOIN users u ON u.id = d.owner_user_id
  LEFT JOIN partners pt ON pt.id = d.partner_id`;

// One scoped single-row read, used by every handler that takes a :id. Returns null when the row does
// not exist OR is not the caller's — the two are deliberately indistinguishable to the client, because
// "403 on someone else's deal" and "404" differ only in that the first confirms the row exists.
async function dealFor(user, id) {
  const scope = await partnerScopeSql(user, 'd', 2);
  const rows = (await query(
    `SELECT ${DEAL_SELECT} ${DEAL_FROM} WHERE d.id = $1 AND ${scope.sql}`, [id, ...scope.params])).rows;
  return rows[0] || null;
}

async function paymentsFor(dealId) {
  return (await query(
    `SELECT id, seq, label, amount_cents, due_trigger, due_date, status
       FROM sitenex_deal_payments WHERE deal_id = $1 ORDER BY seq`, [dealId])).rows;
}

// Renderability for MANY deals, in three queries rather than two per deal.
//
// Routed through the SAME contractInputFor + checkRenderable the single-deal page calls, with
// includeSystem:false, so the board's marker and the form's list of missing fields cannot disagree. A
// second, cheaper "is this deal ready" predicate on the board would be a second definition of ready, and
// the first time they drifted the board would be quietly wrong about a contract.
async function renderableFor(deals) {
  if (!deals.length) return new Map();
  const codes = [...new Set(deals.map(d => d.package_code).filter(Boolean))];
  const pkgCache = new Map();
  if (codes.length) {
    const rows = (await query(
      `SELECT code, name, included, not_included FROM sitenex_packages WHERE code = ANY($1)`, [codes])).rows;
    for (const r of rows) pkgCache.set(r.code, r);
  }
  const payRows = (await query(
    `SELECT deal_id, seq, label, amount_cents, due_trigger, due_date, status
       FROM sitenex_deal_payments WHERE deal_id = ANY($1) ORDER BY deal_id, seq`,
    [deals.map(d => d.id)])).rows;
  const pays = new Map();
  for (const r of payRows) {
    if (!pays.has(r.deal_id)) pays.set(r.deal_id, []);
    pays.get(r.deal_id).push(r);
  }
  const out = new Map();
  for (const d of deals) {
    const input = await contractInputFor(d, null, pkgCache);
    out.set(d.id, checkRenderable({ ...input, payments: pays.get(d.id) || [] }, { includeSystem: false }));
  }
  return out;
}

// ── deals ─────────────────────────────────────────────────────────────────────

// GET /sitenex/deals — the board. MOVED here from routes.js rather than duplicated: routes.js mounts
// first, so a second declaration of this path would have been unreachable while the old one kept
// serving a payload with none of the client columns the contract generator needs. The envelope is
// unchanged and the columns are a superset, so the existing board page is unaffected.
router.get('/sitenex/deals', authMiddleware, requireTier('sitenex'), async (req, res) => {
  try {
    const scope = await partnerScopeSql(req.user, 'd', 1);
    const rows = (await query(
      `SELECT ${DEAL_SELECT} ${DEAL_FROM} WHERE ${scope.sql}
        ORDER BY d.updated_at DESC, d.id DESC`, scope.params)).rows;
    const ready = await renderableFor(rows);
    const columns = DEAL_STATUSES.map(status => ({
      status, deals: rows.filter(r => r.status === status).map(r => {
        const rr = ready.get(r.id) || { ok: true };
        return { ...dealShape(r),
          // The SAME answer the deal page gives. `blocked_reason` is the code, so the card can show a
          // marker without restating the server's sentence, and `missing` is there for its tooltip.
          contract_ready: rr.ok === true,
          blocked_reason: rr.ok ? null : rr.code,
          missing: rr.ok ? [] : (rr.missing || []).map(m => m.label) };
      }),
    }));
    res.json({ total: rows.length, statuses: DEAL_STATUSES, columns,
      scope: scope.isStaff ? 'all partners' : (scope.failed ? 'none' : 'own partner only'),
      partner_id: scope.partnerId,
      // THE SERVER SAYS WHO MAY WRITE. The board is visible to super_admin, admin and partner (the
      // 'sitenex' tier) but only the first two may create a deal, and the client must not work that out
      // for itself — a second copy of the rule in the SPA is a copy that can disagree with the gate.
      // Reported so a partner gets no dead button, while the gate stays adminOnly on the route.
      can_create: req.user.role === 'admin' || req.user.role === 'super_admin' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/sitenex/deals/:id', authMiddleware, requireTier('sitenex'), async (req, res) => {
  try {
    const deal = await dealFor(req.user, req.params.id);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });
    const contracts = (await query(
      `SELECT id, contract_no, status, template_version, file_name, file_size, created_at, superseded_by
         FROM sitenex_contracts WHERE deal_id = $1 ORDER BY id DESC`, [deal.id])).rows;
    // Through renderableFor, the same function the board uses, so the two cannot drift. includeSystem:false
    // lives inside it — the answer is "what does this DEAL still need", and the contract number is the
    // generator's to supply, not something to tell a user to fill in.
    const ready = await renderableFor([deal]);
    res.json({ deal: dealShape(deal), payments: await paymentsFor(deal.id), contracts,
               renderable: ready.get(deal.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/sitenex/deals', authMiddleware, adminOnly, requireTier('sitenex'), async (req, res) => {
  try {
    const b = req.body || {};
    if (b.status && !DEAL_STATUSES.includes(b.status)) {
      return res.status(400).json({ error: `Unknown status '${b.status}'. One of: ${DEAL_STATUSES.join(', ')}` });
    }
    // THE RULE. partner_id comes from the acting user's own row, never from the body. A partner cannot
    // write into another partner's book, and staff (partner_id NULL) create a self-sourced deal.
    const scope = await partnerScopeSql(req.user, 'd', 1);
    if (scope.failed) return res.status(403).json({ error: 'Your account is not linked to a partner', code: 'no_partner' });
    const partnerId = scope.partnerId;

    // cols and vals stay STRICTLY PARALLEL, with the NOW() columns appended at the very end. The first
    // version interleaved `created_at`/`updated_at` as NOW() literals in the middle of the list, which is
    // valid SQL and a trap: the column at index i no longer corresponds to params[i], so anything reading
    // the two together — a fake, a log, the next person — silently pairs company_name with an email.
    const cols = ['partner_id', 'owner_user_id', 'status'];
    const vals = [partnerId, req.user.id, b.status || 'new'];
    for (const c of DEAL_WRITABLE) {
      if (c === 'status' || !(c in b)) continue;
      let v = b[c];
      if (/_cents$|^duration_weeks$|^prospect_id$/.test(c)) {
        v = intOrNull(v);
        if (Number.isNaN(v)) return res.status(400).json({ error: `${c} must be a number` });
      }
      if (c === 'starts_at_intake') v = !(v === false || v === 'false');
      cols.push(c); vals.push(v);
    }
    const ph = vals.map((_, i) => `$${i + 1}`);
    const made = (await query(
      `INSERT INTO sitenex_deals (${cols.join(', ')}, created_at, updated_at)
       VALUES (${ph.join(', ')}, NOW(), NOW()) RETURNING id`, vals)).rows[0];
    const deal = await dealFor(req.user, made.id);
    res.status(201).json({ ok: true, deal: dealShape(deal), payments: [] });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.put('/sitenex/deals/:id', authMiddleware, adminOnly, requireTier('sitenex'), async (req, res) => {
  try {
    const existing = await dealFor(req.user, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Deal not found' });
    const b = req.body || {};
    if (b.status && !DEAL_STATUSES.includes(b.status)) {
      return res.status(400).json({ error: `Unknown status '${b.status}'. One of: ${DEAL_STATUSES.join(', ')}` });
    }
    const sets = [], vals = [], changed = [];
    for (const c of DEAL_WRITABLE) {
      if (!(c in b)) continue;
      let v = b[c];
      if (/_cents$|^duration_weeks$|^prospect_id$/.test(c)) {
        v = intOrNull(v);
        if (Number.isNaN(v)) return res.status(400).json({ error: `${c} must be a number` });
      }
      if (c === 'starts_at_intake') v = !(v === false || v === 'false');
      vals.push(v); sets.push(`${c} = $${vals.length}`);
      changed.push(c);
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });

    // THE STAGE CLOCK MOVES ONLY ON A REAL STATUS CHANGE. Not on every update — that is what updated_at
    // already does, and treating the two as the same thing is how "days in current stage" becomes "days
    // since somebody fixed a typo". Re-selecting the same status is not a move either.
    if ('status' in b && b.status !== existing.status) sets.push('status_changed_at = NOW()');

    // CHANGING value_cents CAN UNBALANCE AN EXISTING SCHEDULE. Refused rather than silently leaving a
    // deal whose installments no longer add up — which would then block contract generation with an
    // error about the schedule, pointing at the wrong edit.
    if ('value_cents' in b) {
      const rows = await paymentsFor(existing.id);
      if (rows.length) {
        const sum = rows.reduce((s, r) => s + r.amount_cents, 0);
        const next = intOrNull(b.value_cents);
        if (sum !== next) {
          return res.status(400).json({ code: 'unbalanced_schedule',
            error: `This deal has a ${rows.length}-installment schedule totalling $${(sum / 100).toLocaleString()}. `
                 + `Changing the value to $${((next || 0) / 100).toLocaleString()} would leave them unequal — `
                 + `update the schedule in the same breath, or change it first.` });
        }
      }
    }
    vals.push(existing.id);
    await query(`UPDATE sitenex_deals SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length}`, vals);
    const deal = await dealFor(req.user, existing.id);
    // `changed` is what the CALLER changed, not every column the statement touched. Deriving it from the
    // SET clause meant the UI reported "Saved: status, status_changed_at, terms_note" — naming a bookkeeping
    // column the user neither sent nor set, which reads as the system having done something it was not asked
    // to. updated_at never appeared there either, for the same reason; this keeps the two consistent.
    res.json({ ok: true, deal: dealShape(deal), payments: await paymentsFor(existing.id), changed });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── the payment schedule ──────────────────────────────────────────────────────

// PUT /sitenex/deals/:id/payments — replaces the whole schedule. Replace rather than per-row edits
// because the invariant is about the SET: "update installment 2" has no meaning that preserves the sum,
// so the client sends what the schedule should now be and this accepts it or refuses it whole.
router.put('/sitenex/deals/:id/payments', authMiddleware, adminOnly, requireTier('sitenex'), async (req, res) => {
  try {
    const deal = await dealFor(req.user, req.params.id);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });
    const input = Array.isArray(req.body && req.body.payments) ? req.body.payments : null;
    if (!input) return res.status(400).json({ error: 'payments must be an array' });
    if (input.length > 36) return res.status(400).json({ error: 'at most 36 installments' });

    const rows = [];
    for (let i = 0; i < input.length; i++) {
      const p = input[i] || {};
      const amount = intOrNull(p.amount_cents);
      if (amount == null || Number.isNaN(amount)) return res.status(400).json({ error: `installment ${i + 1}: amount_cents is required` });
      if (amount <= 0) return res.status(400).json({ error: `installment ${i + 1}: amount must be positive` });
      const label = String(p.label || '').trim();
      if (!label) return res.status(400).json({ error: `installment ${i + 1}: label is required` });
      if (p.due_trigger && !PAYMENT_TRIGGERS.includes(p.due_trigger)) {
        return res.status(400).json({ error: `installment ${i + 1}: unknown due_trigger '${p.due_trigger}'. One of: ${PAYMENT_TRIGGERS.join(', ')}` });
      }
      if (p.status && !PAYMENT_STATUSES.includes(p.status)) {
        return res.status(400).json({ error: `installment ${i + 1}: unknown status '${p.status}'. One of: ${PAYMENT_STATUSES.join(', ')}` });
      }
      // A 'date' trigger without a date is the shape that produces a contract saying "on the date
      // shown" beside a blank, so it is refused rather than rendered.
      if (p.due_trigger === 'date' && !p.due_date) {
        return res.status(400).json({ error: `installment ${i + 1}: due_trigger 'date' needs a due_date` });
      }
      rows.push({ seq: i + 1, label, amount_cents: amount,
                  due_trigger: p.due_trigger || null, due_date: p.due_date || null,
                  status: p.status || 'due' });
    }

    // THE SUM RULE, in the handler because it spans rows and a CHECK cannot see siblings. An empty
    // schedule is allowed — it clears the plan — but a non-empty one must balance.
    if (rows.length) {
      if (deal.value_cents == null) {
        return res.status(400).json({ code: 'no_total',
          error: 'This deal has no value yet, so a schedule has nothing to add up to. Set the deal value first.' });
      }
      const sum = rows.reduce((s, r) => s + r.amount_cents, 0);
      if (sum !== deal.value_cents) {
        const diff = sum - deal.value_cents;
        return res.status(400).json({ code: 'unbalanced_schedule', sum, total: deal.value_cents,
          error: `The schedule adds up to $${(sum / 100).toLocaleString()} but the deal is `
               + `$${(deal.value_cents / 100).toLocaleString()} — ${diff > 0 ? 'over' : 'under'} by `
               + `$${(Math.abs(diff) / 100).toLocaleString()}. A contract whose installments do not match `
               + `its total is a document two people read differently.` });
      }
    }

    await withTransaction(async (c) => {
      await c.query(`DELETE FROM sitenex_deal_payments WHERE deal_id = $1`, [deal.id]);
      for (const r of rows) {
        await c.query(
          `INSERT INTO sitenex_deal_payments (deal_id, seq, label, amount_cents, due_trigger, due_date, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [deal.id, r.seq, r.label, r.amount_cents, r.due_trigger, r.due_date, r.status]);
      }
    });
    res.json({ ok: true, deal_id: deal.id, payments: await paymentsFor(deal.id),
               total_cents: rows.reduce((s, r) => s + r.amount_cents, 0) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── contracts ─────────────────────────────────────────────────────────────────

// What the renderer needs, assembled from the deal plus the package catalogue. The package's scope is
// read HERE and snapshot into the contract row, so a later catalogue edit cannot change what an old
// contract says it included.
async function contractInputFor(deal, contractNo = null, pkgCache = null) {
  // pkgCache lets the BOARD compute this for every deal without one package query each. It is the same
  // function either way on purpose: the board's "blocked" marker and the form's "still needed" list have to
  // be the same answer, and the only way to guarantee that is for there to be one implementation.
  const pkg = !deal.package_code ? null
    : (pkgCache ? (pkgCache.get(deal.package_code) || null)
                : (await query(`SELECT code, name, included, not_included FROM sitenex_packages WHERE code = $1`,
                               [deal.package_code])).rows[0]);
  return {
    contract_no: contractNo,
    contract_date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    client_company: deal.company_name,
    client_contact: deal.contact_name,
    client_title: deal.contact_title,
    client_email: deal.contact_email,
    client_phone: deal.contact_phone,
    client_address: deal.client_address,
    partner_name: deal.partner_name,
    partner_email: deal.partner_email,
    // WHERE the client is, for the register's attribution line ("ACBM Partners · Rockford, IL"). Taken from
    // the prospect's region at generation time and snapshot, like every other client detail here: a region can
    // be re-enumerated and the register must keep saying what the contract said.
    region: deal.prospect_region || null,
    package_code: deal.package_code,
    package_name: pkg ? `${pkg.code} · ${pkg.name}` : deal.package_code,
    included: pkg ? pkg.included : null,
    not_included: pkg ? pkg.not_included : null,
    value_cents: deal.value_cents,
    monthly_cents: deal.monthly_cents,
    duration_weeks: deal.duration_weeks,
    starts_at_intake: deal.starts_at_intake,
    terms_note: deal.terms_note,
  };
}

// GET /sitenex/contracts — the register, with the totals.
router.get('/sitenex/contracts', authMiddleware, requireTier('sitenex'), async (req, res) => {
  try {
    const scope = await partnerScopeSql(req.user, 'c', 1);
    const rows = (await query(
      `SELECT c.id, c.contract_no, c.deal_id, c.partner_id, c.client_company, c.client_contact,
              c.package_code, c.package_name, c.value_cents, c.monthly_cents, c.duration_weeks,
              c.status, c.superseded_by, c.template_version, c.file_name, c.file_size, c.created_at,
              c.partner_name, c.region, c.sent_at, u.name AS generated_by_name,
              d.status AS deal_status
         FROM sitenex_contracts c
         LEFT JOIN users u ON u.id = c.generated_by
         LEFT JOIN sitenex_deals d ON d.id = c.deal_id
        WHERE ${scope.sql}
        ORDER BY c.id DESC`, scope.params)).rows;

    // TOTALS. Signed one-time, signed monthly, the annualised view of that monthly, and the pipeline —
    // which is everything NOT signed and NOT dead. A superseded row is excluded from every total: it is
    // the same commercial fact as its replacement, and counting both would double the book.
    const live = rows.filter(r => r.status !== 'superseded' && r.status !== 'void');
    const signed = live.filter(r => r.status === 'signed');
    const pipeline = live.filter(r => r.status === 'generated' || r.status === 'sent');
    const sum = (list, k) => list.reduce((s, r) => s + (r[k] || 0), 0);
    const signedOneTime = sum(signed, 'value_cents');
    const signedMonthly = sum(signed, 'monthly_cents');
    res.json({
      total: rows.length,
      contracts: rows,
      totals: {
        signed_count: signed.length,
        signed_one_time_cents: signedOneTime,
        signed_monthly_cents: signedMonthly,
        // one-time + 12 months of the retainer. Stated as a derived figure, not as revenue booked.
        annualised_cents: signedOneTime + signedMonthly * 12,
        pipeline_count: pipeline.length,
        pipeline_cents: sum(pipeline, 'value_cents'),
        superseded_count: rows.length - live.length,
      },
      scope: scope.isStaff ? 'all partners' : (scope.failed ? 'none' : 'own partner only'),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /sitenex/contracts — generate. Regeneration makes a NEW ROW and supersedes the old one.
router.post('/sitenex/contracts', authMiddleware, adminOnly, requireTier('sitenex'), async (req, res) => {
  try {
    const dealId = intOrNull((req.body || {}).deal_id);
    if (dealId == null || Number.isNaN(dealId)) return res.status(400).json({ error: 'deal_id is required' });
    const deal = await dealFor(req.user, dealId);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const payments = await paymentsFor(deal.id);
    const base = await contractInputFor(deal);
    // Checked BEFORE a number is taken from the sequence, so a refused attempt does not burn
    // SN-2026-0004 and leave a gap in the register that looks like a deleted contract.
    const pre = checkRenderable({ ...base, payments }, { includeSystem: false });
    if (!pre.ok) return res.status(400).json(pre);

    const result = await withTransaction(async (c) => {
      const n = (await c.query(`SELECT nextval('sitenex_contract_no_seq') AS n`)).rows[0].n;
      const contractNo = `SN-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;
      const input = { ...base, contract_no: contractNo, payments };
      const doc = await renderContract(input);
      if (!doc.ok) return { refused: doc };

      // SUPERSEDE, never overwrite. Done in the same transaction as the insert so there is no window
      // in which two contracts for one deal are both current.
      const prior = (await c.query(
        `SELECT id FROM sitenex_contracts WHERE deal_id = $1 AND status <> 'superseded' AND status <> 'void'`,
        [deal.id])).rows;

      const row = (await c.query(
        `INSERT INTO sitenex_contracts
           (contract_no, deal_id, partner_id, client_company, client_contact, client_title,
            client_email, client_phone, client_address, partner_name, partner_email,
            package_code, package_name, included, not_included, value_cents, monthly_cents,
            duration_weeks, starts_at_intake, terms_note, payments,
            template_version, file_name, file_bytes, file_size, status, generated_by, region)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,'generated',$26,$27)
         RETURNING id, contract_no, status, file_name, file_size, created_at`,
        [contractNo, deal.id, deal.partner_id, input.client_company, input.client_contact,
         input.client_title, input.client_email, input.client_phone, input.client_address,
         input.partner_name, input.partner_email, input.package_code, input.package_name,
         JSON.stringify(input.included || []), JSON.stringify(input.not_included || []),
         input.value_cents, input.monthly_cents, input.duration_weeks, input.starts_at_intake,
         input.terms_note, JSON.stringify(payments), doc.template_version, doc.file_name,
         doc.buffer, doc.buffer.length, req.user.id, input.region])).rows[0];

      for (const p of prior) {
        await c.query(`UPDATE sitenex_contracts SET status='superseded', superseded_by=$1 WHERE id=$2`,
                      [row.id, p.id]);
      }
      return { row, superseded: prior.map(p => p.id) };
    });

    if (result.refused) return res.status(400).json(result.refused);
    res.status(201).json({ ok: true, contract: result.row, superseded: result.superseded,
      note: result.superseded.length
        ? `Contract ${result.row.contract_no} generated. ${result.superseded.length} earlier contract(s) marked superseded — nothing was overwritten.`
        : `Contract ${result.row.contract_no} generated.` });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /sitenex/contracts/:id/file — the bytes. Scoped like everything else.
router.get('/sitenex/contracts/:id/file', authMiddleware, requireTier('sitenex'), async (req, res) => {
  try {
    const scope = await partnerScopeSql(req.user, 'c', 2);
    const row = (await query(
      `SELECT contract_no, file_name, file_bytes, file_size FROM sitenex_contracts c
        WHERE c.id = $1 AND ${scope.sql}`, [req.params.id, ...scope.params])).rows[0];
    if (!row) return res.status(404).json({ error: 'Contract not found' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${row.file_name}"`);
    res.setHeader('Content-Length', String(row.file_size));
    res.send(row.file_bytes);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET the send preview ──────────────────────────────────────────────────────
//
// So the button can SHOW THE ADDRESS BEFORE IT IS CLICKED. A contract sent to the wrong address cannot be
// unsent, and an address the user never saw is one they cannot check. The recipient is read from the
// contract's own snapshot, which is also what the send will use — so what is displayed is what will
// happen, not an independent guess that could disagree.
router.get('/sitenex/contracts/:id/send', authMiddleware, adminOnly, requireTier('sitenex'), async (req, res) => {
  try {
    const scope = await partnerScopeSql(req.user, 'c', 2);
    const c = (await query(
      `SELECT c.id, c.contract_no, c.client_company, c.client_contact, c.client_email, c.partner_email,
              c.package_name, c.package_code, c.value_cents, c.monthly_cents, c.status, c.sent_at,
              c.file_name, c.file_size
         FROM sitenex_contracts c WHERE c.id = $1 AND ${scope.sql}`, [req.params.id, ...scope.params])).rows[0];
    if (!c) return res.status(404).json({ error: 'Contract not found' });
    const mail = contractEmail(c);
    const sends = (await query(
      `SELECT to_email, cc_email, status, provider_id, sent_at, error
         FROM sitenex_contract_sends WHERE contract_id = $1 ORDER BY id DESC LIMIT 10`, [c.id])).rows;
    res.json({
      contract_no: c.contract_no,
      to: c.client_email || null,
      cc: c.partner_email || null,
      from: contractFrom(),
      subject: mail.subject,
      price: mail.price,
      file_name: c.file_name,
      file_size: c.file_size,
      status: c.status,
      sent_at: c.sent_at,
      // Refusals the client should learn about BEFORE clicking, not as an error after.
      can_send: !!c.client_email && c.status !== 'superseded' && c.status !== 'void',
      blocked_because: !c.client_email ? 'this contract has no client email address on it'
        : (c.status === 'superseded' ? 'this contract has been superseded by a newer one'
        : (c.status === 'void' ? 'this contract is void' : null)),
      previous_sends: sends,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST the send ─────────────────────────────────────────────────────────────
//
// SEPARATE FROM GENERATE, and never automatic. Generating a document is reversible — regenerate and the
// old one is superseded. Sending one is not: a wrong address or a wrong price has reached a real business
// and cannot be recalled. So the two are different buttons, different routes, and this one requires the
// caller to echo back the address it is about to send to.
//
// ── THE ORDER OF OPERATIONS, which is the whole difficulty ─────────────────────
//
// The email cannot be inside the database transaction: an HTTP call to Resend is not rollback-able, so a
// COMMIT that failed after a successful send would leave a contract in the client's inbox and no record
// of it here. And the reverse order is worse: marking it 'sent' first and then failing to send claims
// something that did not happen.
//
// So: send FIRST, then record, and record EVERY outcome including the failure. If the DB write after a
// successful send fails, the send log insert is attempted on its own and the response says plainly that
// the email went but the status did not move — a visible inconsistency beats a silent one. The status
// move and the sent_at stamp ARE in one transaction with each other, so the register can never hold a
// 'sent' contract with no time or a time with no status.
router.post('/sitenex/contracts/:id/send', authMiddleware, adminOnly, requireTier('sitenex'), async (req, res) => {
  try {
    const scope = await partnerScopeSql(req.user, 'c', 2);
    const c = (await query(
      `SELECT c.id, c.contract_no, c.client_company, c.client_contact, c.client_email, c.partner_email,
              c.package_name, c.package_code, c.value_cents, c.monthly_cents, c.status,
              c.file_name, c.file_size, c.file_bytes
         FROM sitenex_contracts c WHERE c.id = $1 AND ${scope.sql}`, [req.params.id, ...scope.params])).rows[0];
    if (!c) return res.status(404).json({ error: 'Contract not found' });

    if (!c.client_email) {
      return res.status(400).json({ code: 'no_recipient',
        error: 'This contract has no client email address on it. It is snapshot at generation time, so add '
             + 'the address to the deal and regenerate — editing the deal alone will not change this document.' });
    }
    if (c.status === 'superseded' || c.status === 'void') {
      return res.status(400).json({ code: 'not_current',
        error: `This contract is ${c.status}. Send the current one instead — a client receiving a superseded `
             + 'document has no way to know it is not the agreement.' });
    }
    // THE CONFIRMATION, server-side. The UI asks too, but a confirm() dialog is not a safeguard: it lives
    // in the client and is one devtools line away. Requiring the address to be echoed back means a request
    // built by anything other than the screen that displayed it cannot send to an address nobody saw.
    const confirmTo = String((req.body || {}).confirm_to || '').trim().toLowerCase();
    if (confirmTo !== String(c.client_email).trim().toLowerCase()) {
      return res.status(400).json({ code: 'confirm_mismatch', to: c.client_email,
        error: `Confirm the recipient: this would send to ${c.client_email}. Re-send the request with `
             + 'confirm_to set to exactly that address.' });
    }
    if (!c.file_bytes || !c.file_bytes.length) {
      return res.status(500).json({ code: 'no_document', error: 'the stored document is empty — regenerate it' });
    }

    const mail = contractEmail(c);
    const from = contractFrom();
    const to = c.client_email;
    const cc = c.partner_email || null;

    const sent = await mailer().sendEmailDetailed({
      to, cc, from, replyTo: from, subject: mail.subject, html: mail.html,
      attachments: [{ filename: c.file_name || `${c.contract_no}.docx`, content: c.file_bytes }],
    });

    // Logged either way, BEFORE the status move, so a failure is recorded even if nothing else changes.
    //
    // Takes the CLIENT, not a detached query function. `logSend(tx.query, …)` loses `this` and throws
    // "Cannot read properties of undefined (reading 'connectionParameters')" inside the transaction — which
    // in production meant the email went and the status never moved. The sent_but_not_recorded branch below
    // reported that honestly, which is how it was found, but a method is only safe to pass around bound.
    const logSend = async (client, status) => (await client.query(
      `INSERT INTO sitenex_contract_sends
         (contract_id, contract_no, to_email, cc_email, from_email, subject, file_name, file_size,
          status, provider_id, error, sent_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, sent_at`,
      [c.id, c.contract_no, to, cc, from, mail.subject, c.file_name, c.file_size,
       status, sent.id || null, sent.ok ? null : String(sent.error || 'unknown'), req.user.id])).rows[0];

    if (!sent.ok) {
      await logSend({ query }, 'failed').catch(() => {});
      return res.status(502).json({ code: 'send_failed', error: sent.error || 'the provider refused the send',
        to, note: 'Nothing was marked sent. The attempt is in the send log.' });
    }

    let row, logged;
    try {
      await withTransaction(async (tx) => {
        logged = await logSend(tx, 'sent');
        // ONE transaction for the status and the stamp, so 'sent' with no time cannot exist.
        row = (await tx.query(
          `UPDATE sitenex_contracts SET status = 'sent', sent_at = NOW()
            WHERE id = $1 RETURNING id, contract_no, status, sent_at`, [c.id])).rows[0];
      });
    } catch (e) {
      // The email HAS gone. Say so loudly rather than returning an error that reads as "it did not send".
      return res.status(500).json({ code: 'sent_but_not_recorded', sent: true, to, provider_id: sent.id,
        error: `The email WAS sent to ${to} (provider id ${sent.id}), but recording it failed: ${e.message}. `
             + `The contract is still showing as '${c.status}' — set it to 'sent' by hand and tell somebody.` });
    }

    res.json({ ok: true, to, cc, from, subject: mail.subject, provider_id: sent.id,
      contract: row, send_id: logged && logged.id,
      note: `Sent to ${to}${cc ? ` (cc ${cc})` : ''}. Marked sent.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/sitenex/contracts/:id', authMiddleware, adminOnly, requireTier('sitenex'), async (req, res) => {
  try {
    const status = (req.body || {}).status;
    if (!CONTRACT_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Unknown status '${status}'. One of: ${CONTRACT_STATUSES.join(', ')}` });
    }
    // 'superseded' is set by the generator, in the same transaction as the replacement. Allowing it here
    // would let a row be marked superseded with no successor, which reads as a missing document.
    if (status === 'superseded') {
      return res.status(400).json({ code: 'not_settable',
        error: "'superseded' is set by generating a replacement, so the register always shows which contract replaced which." });
    }
    const scope = await partnerScopeSql(req.user, 'c', 2);
    const row = (await query(
      `UPDATE sitenex_contracts c SET status = $3 WHERE c.id = $1 AND ${scope.sql}
       RETURNING id, contract_no, status`, [req.params.id, ...scope.params, status])).rows[0];
    if (!row) return res.status(404).json({ error: 'Contract not found' });
    res.json({ ok: true, contract: row });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── TERRITORIES ───────────────────────────────────────────────────────────────
//
// ONE PRODUCT, MANY PARTNERS. Nothing here is per-partner commercial terms: packages, prices, the contract
// template and the revenue tiers are the same for everyone, and only the patch differs. A product per
// partner would mean a user_products row, a route-map entry and a nav tab each time somebody signs.

const LEAD_REG_STATUSES = ['confirmed', 'pending_approval', 'rejected'];

router.get('/sitenex/territories', authMiddleware, requireTier('sitenex'), async (req, res) => {
  try {
    // A partner sees their OWN grants and nobody else's — who else holds what is commercially sensitive
    // between partners. Staff see all of them, which is the only view in which a gap or an overlap is
    // visible at all.
    const scope = await partnerScopeSql(req.user, 't', 1);
    const rows = (await query(
      `SELECT t.id, t.partner_id, t.dimension, t.value, t.exclusive, t.created_at,
              p.name AS partner_name, u.name AS created_by_name
         FROM partner_territories t
         LEFT JOIN partners p ON p.id = t.partner_id
         LEFT JOIN users u ON u.id = t.created_by
        WHERE ${scope.sql}
        ORDER BY p.name, t.dimension, t.value`, scope.params)).rows;
    res.json({ total: rows.length, territories: rows, dimensions: DIMENSIONS,
      scope: scope.isStaff ? 'all partners' : (scope.failed ? 'none' : 'own partner only'),
      // Said out loud, because an empty list has two very different meanings and only one is a problem.
      note: (!rows.length && !scope.isStaff)
        ? 'You have no territory yet, so no prospects are visible. Ask us to grant one.' : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/sitenex/territories', authMiddleware, adminOnly, requireTier('sitenex'), async (req, res) => {
  try {
    const b = req.body || {};
    const partnerId = intOrNull(b.partner_id);
    if (partnerId == null || Number.isNaN(partnerId)) return res.status(400).json({ error: 'partner_id is required' });
    if (!isDimension(b.dimension)) {
      return res.status(400).json({ error: `Unknown dimension '${b.dimension}'. One of: ${DIMENSIONS.join(', ')}` });
    }
    const value = String(b.value == null ? '' : b.value).trim();
    if (!value) return res.status(400).json({ error: 'value is required' });
    // exclusive defaults TRUE, matching the column. A shared territory has to be asked for.
    const exclusive = !(b.exclusive === false || b.exclusive === 'false');

    const partner = (await query(`SELECT id, name FROM partners WHERE id = $1`, [partnerId])).rows[0];
    if (!partner) return res.status(404).json({ error: 'Partner not found' });

    let row;
    try {
      row = (await query(
        `INSERT INTO partner_territories (partner_id, dimension, value, exclusive, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, partner_id, dimension, value, exclusive, created_at`,
        [partnerId, b.dimension, value, exclusive, req.user.id])).rows[0];
    } catch (e) {
      // 23505 is a unique violation, and WHICH index it was changes the answer entirely. The DATABASE is
      // what refused — this only turns the refusal into a sentence naming who already holds it, because
      // "duplicate key value violates unique constraint" tells the reader nothing actionable.
      if (e.code !== '23505') throw e;
      if (/uq_partner_territories_exclusive/.test(e.constraint || e.message || '')) {
        const holder = (await query(
          `SELECT p.name FROM partner_territories t JOIN partners p ON p.id = t.partner_id
            WHERE t.dimension = $1 AND t.value = $2 AND t.exclusive LIMIT 1`, [b.dimension, value])).rows[0];
        return res.status(409).json({ code: 'territory_taken', held_by: holder && holder.name,
          error: `${b.dimension} '${value}' is already held exclusively by ${(holder && holder.name) || 'another partner'}. `
               + `Two partners holding the same patch is the collision this constraint exists to prevent — `
               + `either revoke theirs first, or add it as non-exclusive if the overlap is deliberate.` });
      }
      return res.status(409).json({ code: 'already_granted',
        error: `${partner.name} already has ${b.dimension} '${value}'.` });
    }
    // A suppressed conflict returns NO ROW. Guarded explicitly so a future ON CONFLICT on this statement
    // fails loudly here instead of reading .id off undefined — a 500 at least says something happened,
    // whereas a silent 201 with an empty territory says a grant was made that was not.
    if (!row) return res.status(500).json({ error: 'the territory was not written — nothing was granted' });
    res.status(201).json({ ok: true, territory: { ...row, partner_name: partner.name },
      note: `${partner.name} now sees prospects matching ${b.dimension} '${value}'`
          + (exclusive ? ' exclusively.' : ' (shared — other partners may also hold it).') });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/sitenex/territories/:id', authMiddleware, adminOnly, requireTier('sitenex'), async (req, res) => {
  try {
    const row = (await query(
      `DELETE FROM partner_territories WHERE id = $1 RETURNING id, partner_id, dimension, value`,
      [req.params.id])).rows[0];
    if (!row) return res.status(404).json({ error: 'Territory not found' });
    // How many they have LEFT, because revoking the last one makes a partner see nothing — which is correct
    // and fail-closed, and also the kind of thing somebody should be told they have just done.
    const left = (await query(
      `SELECT COUNT(*)::int n FROM partner_territories WHERE partner_id = $1`, [row.partner_id])).rows[0].n;
    res.json({ ok: true, removed: row, remaining: left,
      note: left ? `${left} territory remaining.`
        : 'That was their LAST territory — this partner now sees no prospects at all.' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── LEAD REGISTRATION ─────────────────────────────────────────────────────────
//
// A PARTNER WRITE, and the only one. In territory it confirms immediately; out of territory it lands
// pending_approval and a human decides before any work is done. See the note in permissions/templates.js on
// why this one key is allowed through a guard that otherwise refuses every partner write.
// requireTierRead, not requireTier: the partner role holds sitenex:'r' on purpose, so the tier layer refuses
// every partner write — which is right for all of them except this one, where the "write" creates a REQUEST
// that only staff can act on. Widening the tier to 'rw' to let this through would have stopped it refusing
// the others and left adminOnly as the only gate on the deal board.
router.post('/sitenex/lead-registrations', authMiddleware, requireTierRead('sitenex'), async (req, res) => {
  try {
    const b = req.body || {};
    const scope = await partnerScopeSql(req.user, 'x', 1);
    // Staff may register ON BEHALF of a partner, by naming one. A partner cannot name anybody: their
    // partner_id comes from their own row, the same rule as everywhere else.
    const partnerId = scope.isStaff ? intOrNull(b.partner_id) : scope.partnerId;
    if (scope.failed) return res.status(403).json({ error: 'Your account is not linked to a partner', code: 'no_partner' });
    if (partnerId == null || Number.isNaN(partnerId)) {
      return res.status(400).json({ error: 'partner_id is required when registering on a partner\'s behalf' });
    }
    const partner = (await query(`SELECT id, name FROM partners WHERE id = $1`, [partnerId])).rows[0];
    if (!partner) return res.status(404).json({ error: 'Partner not found' });

    // The business, either by prospect_id or described. A prospect_id is preferred because it means we have
    // already scored the site; a partner may also know a business that is not in our list at all.
    const prospectId = intOrNull(b.prospect_id);
    let biz = { business_name: String(b.business_name || '').trim() || null,
                address: b.address || null, region: b.region || null,
                state: b.state || null, subtype: b.subtype || null };
    if (prospectId != null && !Number.isNaN(prospectId)) {
      const p = (await query(
        `SELECT id, name, address, region, state, subtype FROM prospects
          WHERE id = $1::bigint AND product = 'sitenex'`, [prospectId])).rows[0];
      if (!p) return res.status(404).json({ error: 'Prospect not found' });
      // READ FROM THE ROW, never from the request. A partner supplying their own region for a prospect we
      // already hold would be choosing the answer to the territory question.
      biz = { business_name: p.name, address: p.address, region: p.region, state: p.state, subtype: p.subtype };
    }
    if (!biz.business_name) return res.status(400).json({ error: 'business_name is required (or a prospect_id)' });

    const m = await matchTerritory(partnerId, biz);
    // A lookup failure is NOT treated as out of territory and waved through to a human — it is an error,
    // because "we could not check" and "we checked and it is outside" are different facts and only the
    // second should ever reach the approval queue.
    if (m.failed) return res.status(500).json({ error: 'could not check the territory' });
    const status = m.in ? 'confirmed' : 'pending_approval';

    let row;
    try {
      row = (await query(
        `INSERT INTO sitenex_lead_registrations
           (partner_id, prospect_id, business_name, address, region, state, subtype,
            status, in_territory, matched_on, registered_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id, status, in_territory, matched_on, business_name, created_at`,
        [partnerId, (prospectId != null && !Number.isNaN(prospectId)) ? prospectId : null,
         biz.business_name, biz.address, biz.region, biz.state, biz.subtype,
         status, m.in, m.matched, req.user.id])).rows[0];
    } catch (e) {
      if (e.code === '23505' && /uq_sitenex_leadreg_claim/.test(e.constraint || e.message || '')) {
        const held = (await query(
          `SELECT p.name FROM sitenex_lead_registrations r JOIN partners p ON p.id = r.partner_id
            WHERE r.prospect_id = $1 AND r.status = 'confirmed' LIMIT 1`, [prospectId])).rows[0];
        return res.status(409).json({ code: 'already_claimed', held_by: held && held.name,
          error: `This business is already registered to ${(held && held.name) || 'another partner'}.` });
      }
      throw e;
    }
    res.status(201).json({ ok: true, registration: row, partner_name: partner.name,
      note: m.in
        ? `Confirmed — ${biz.business_name} is in your territory (${m.matched}).`
        : `${biz.business_name} is OUTSIDE your territory, so this is waiting for approval. Nobody should `
          + `start work on it until we have confirmed it.` });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/sitenex/lead-registrations', authMiddleware, requireTier('sitenex'), async (req, res) => {
  try {
    const scope = await partnerScopeSql(req.user, 'r', 1);
    const params = [...scope.params];
    let extra = '';
    if (req.query.status && LEAD_REG_STATUSES.includes(req.query.status)) {
      params.push(req.query.status); extra = ` AND r.status = $${params.length}`;
    }
    const rows = (await query(
      `SELECT r.id, r.partner_id, r.prospect_id, r.business_name, r.address, r.region, r.state, r.subtype,
              r.status, r.in_territory, r.matched_on, r.decision_reason, r.decided_at, r.created_at,
              p.name AS partner_name, d.name AS decided_by_name, rb.name AS registered_by_name
         FROM sitenex_lead_registrations r
         LEFT JOIN partners p ON p.id = r.partner_id
         LEFT JOIN users d ON d.id = r.decided_by
         LEFT JOIN users rb ON rb.id = r.registered_by
        WHERE ${scope.sql}${extra}
        ORDER BY (r.status = 'pending_approval') DESC, r.id DESC`, params)).rows;
    res.json({ total: rows.length, registrations: rows, statuses: LEAD_REG_STATUSES,
      pending: rows.filter(r => r.status === 'pending_approval').length,
      scope: scope.isStaff ? 'all partners' : (scope.failed ? 'none' : 'own partner only') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Approve or reject. STAFF ONLY — the whole point of the pending state is that somebody here decides.
router.put('/sitenex/lead-registrations/:id', authMiddleware, adminOnly, requireTier('sitenex'), async (req, res) => {
  try {
    const b = req.body || {};
    const status = b.status;
    if (status !== 'confirmed' && status !== 'rejected') {
      return res.status(400).json({ error: "status must be 'confirmed' or 'rejected'" });
    }
    const reason = String(b.decision_reason || '').trim();
    // A REASON IS REQUIRED ON A REJECTION. "Rejected" with nothing after it is the start of an argument, and
    // the partner is owed the sentence. Not required on an approval, where the territory match or the
    // staff decision is self-explanatory.
    if (status === 'rejected' && reason.length < 3) {
      return res.status(400).json({ code: 'reason_required',
        error: 'Say why. A rejection with no reason is the start of an argument, and the partner is owed the sentence.' });
    }
    const existing = (await query(
      `SELECT id, status, business_name, partner_id, prospect_id FROM sitenex_lead_registrations WHERE id = $1`,
      [req.params.id])).rows[0];
    if (!existing) return res.status(404).json({ error: 'Registration not found' });
    if (existing.status !== 'pending_approval') {
      return res.status(400).json({ code: 'already_decided',
        error: `This registration is already '${existing.status}'. Decided claims are not re-decided — `
             + `the record of what was agreed has to stay what was agreed.` });
    }
    let row;
    try {
      row = (await query(
        `UPDATE sitenex_lead_registrations
            SET status = $2, decision_reason = $3, decided_by = $4, decided_at = NOW()
          WHERE id = $1 RETURNING id, status, business_name, decision_reason, decided_at`,
        [existing.id, status, reason || null, req.user.id])).rows[0];
    } catch (e) {
      if (e.code === '23505' && /uq_sitenex_leadreg_claim/.test(e.constraint || e.message || '')) {
        return res.status(409).json({ code: 'already_claimed',
          error: 'Another partner has confirmed this business since the request was made. Reject this one '
               + 'and say so, rather than having two partners holding the same claim.' });
      }
      throw e;
    }
    res.json({ ok: true, registration: row,
      note: status === 'confirmed'
        ? `Approved — ${row.business_name} is now registered to this partner.`
        : `Rejected: ${reason}` });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── the prospect's call sheet and email, generated ON OPEN ─────────────────────
//
// NOW TERRITORY-SCOPED, and this was a real gap. The comment here used to read "not partner-scoped:
// prospects are ours, and SiteNex Prospects is already admin-only elsewhere" — the second half was the load
// bearing part, and it stopped being true on 2026-10-01. With the list open to partners, a route that takes
// a prospect id and applies no row check lets a partner read the script for ANY prospect by incrementing an
// integer, which would make the territory scoping on the list cosmetic.
//
// Same helper as the list, so the two cannot disagree about what a partner may see.
router.get('/sitenex/prospects/:id/content', authMiddleware, requireTier('sitenex'), async (req, res) => {
  try {
    const terr = await territoryScopeSql(req.user, '', 2);
    const p = (await query(
      `SELECT id, name, website, site_url, site_score, site_findings, recommended_package, subtype,
              region, phone, address
         FROM prospects WHERE id = $1::bigint AND product = 'sitenex' AND ${terr.sql}`,
      [req.params.id, ...terr.params])).rows[0];
    // 404 and "outside your territory" are deliberately the same answer: a 403 on a row they may not see
    // would confirm it exists, which is how a list that cannot be read is enumerated anyway.
    if (!p) return res.status(404).json({ error: 'Prospect not found' });
    const code = req.query.package || p.recommended_package || 'P2';
    const pkg = (await query(
      `SELECT code, name, summary, included, not_included, setup_fee_cents, monthly_cents, typical_weeks
         FROM sitenex_packages WHERE code = $1`, [code])).rows[0] || { code };
    res.json({ prospect: { id: p.id, name: p.name, phone: p.phone, region: p.region,
                           website: p.website, site_score: p.site_score },
               package_code: pkg.code,
               call: callContent(p, pkg), email: emailContent(p, pkg) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ═══ (6) TOKENISED CLIENT INTAKE — the STAFF side ══════════════════════════════
//
// The client's side is src/api/sitenex-intake.routes.js, mounted above the gates with no authentication
// at all. This is the other half: issuing a link, revoking one, reading what came back, and naming the
// developer.
//
// ── WHO MAY ISSUE AND REVOKE: adminOnly ──────────────────────────────────────
//
// Issuing a link MINTS A CREDENTIAL that writes to our database without an account, so it is held to the
// same bar as every other SiteNex write and NOT extended to partners. PARTNER_WRITABLE stays at exactly
// one entry.
//
// Chosen rather than merely inherited. The alternative — the deal owner, who can be a partner — is
// defensible, and if a partner is running their own client's intake they will need it. But it would take
// the partner write allowlist from one route to two, and the second route would be the one that creates
// bearer tokens: the worst possible candidate for a permission granted on the assumption that it can be
// tightened later. Granting it afterwards is one line and an allowlist entry; discovering that partners
// have been minting upload credentials for three months is not recoverable.
const { newToken, expiryFrom, LIFETIME_DAYS, MAX_FILE_BYTES, MAX_DEAL_BYTES } =
  require('../lib/sitenex/intake-token');
const { completeIntake } = require('../lib/sitenex/intake-complete');
const { generateBrief } = require('../lib/sitenex/intake-brief');

const INTAKE_BASE = () => process.env.BASE_URL || 'https://playbook.abiozen.com';
// The fragment is the point: a token after '#' is never sent to a server, so it is absent from access
// logs and from Referer. public/intake.html reads it and sends it as X-Intake-Token.
const intakeUrl = (token) => `${INTAKE_BASE()}/intake#${token}`;

// The link WITHOUT the credential. Everything a register needs and nothing that grants access.
const linkShape = (r) => r && ({
  id: r.id, deal_id: r.deal_id, token_tail: r.token_tail,
  expires_at: r.expires_at, revoked_at: r.revoked_at, created_at: r.created_at,
  last_used_at: r.last_used_at, issued_by: r.issued_by, issued_by_name: r.issued_by_name || null,
  request_count: r.request_count, bytes_uploaded: Number(r.bytes_uploaded || 0),
  live: !r.revoked_at && new Date(r.expires_at).getTime() > Date.now(),
});

// ── POST /sitenex/deals/:id/intake-link — issue (and invalidate the previous) ──
router.post('/sitenex/deals/:id/intake-link', authMiddleware, adminOnly, requireTier('sitenex'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'bad deal id' });
    // Partner-scoped even though this is adminOnly, because adminOnly admits an admin and the row scope
    // is a separate question from the role.
    const deal = await dealFor(req.user, id);
    if (!deal) return res.status(404).json({ error: 'deal not found' });

    const { token, hash, tail } = newToken();
    const expires = expiryFrom(new Date(), LIFETIME_DAYS);

    const link = await withTransaction(async (client) => {
      // RE-ISSUING INVALIDATES THE PREVIOUS TOKEN, and in the same transaction as the insert — which is
      // what makes the partial unique index (deal_id) WHERE revoked_at IS NULL satisfiable. If this
      // UPDATE were a separate request the index would reject the insert, which is the correct failure
      // and not one we want to rely on.
      await client.query(
        `UPDATE sitenex_intake_links SET revoked_at = NOW(), revoked_by = $2
          WHERE deal_id = $1 AND revoked_at IS NULL`, [id, req.user.id]);
      return (await client.query(
        `INSERT INTO sitenex_intake_links (deal_id, token_hash, token_tail, expires_at, issued_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, deal_id, token_tail, expires_at, revoked_at, created_at, last_used_at,
                   issued_by, request_count, bytes_uploaded`,
        [id, hash, tail, expires, req.user.id])).rows[0];
    });

    // THE ONLY TIME THE TOKEN EXISTS OUTSIDE THE CLIENT'S EMAIL. It is not stored and cannot be read
    // back — a second GET returns token_tail and nothing more. Said in the payload so the UI can say it
    // too, because "copy this now" is only credible if the page explains why.
    res.json({
      link: linkShape(link),
      url: intakeUrl(token),
      token_shown_once: true,
      note: `This link works for ${LIFETIME_DAYS} days and can be used as often as the client needs. ` +
            `We do not store it, so it cannot be shown again — issue a new one if it is lost, which ` +
            `switches the old one off.`,
      limits: { per_file_mb: Math.round(MAX_FILE_BYTES / 1048576),
                per_deal_mb: Math.round(MAX_DEAL_BYTES / 1048576), video: 'refused' },
    });
  } catch (e) {
    // The partial unique index is the one failure worth naming, because its message would otherwise be
    // an opaque constraint violation.
    if (/uniq_sitenex_intake_link_live/.test(e.message || '')) {
      return res.status(409).json({ error: 'a live link already exists for this deal and was not revoked — this is a bug, not a state you can fix from here' });
    }
    console.error('issue intake link:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /sitenex/deals/:id/intake-link — revoke, immediately ───────────────
router.delete('/sitenex/deals/:id/intake-link', authMiddleware, adminOnly, requireTier('sitenex'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'bad deal id' });
    const deal = await dealFor(req.user, id);
    if (!deal) return res.status(404).json({ error: 'deal not found' });
    // Revoked, never deleted: who issued a link and when is part of the record even after it is dead.
    const r = await query(
      `UPDATE sitenex_intake_links SET revoked_at = NOW(), revoked_by = $2
        WHERE deal_id = $1 AND revoked_at IS NULL`, [id, req.user.id]);
    res.json({ revoked: r.rowCount, message: r.rowCount ? 'The link no longer works.' : 'There was no live link.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /sitenex/deals/:id/intake — the staff view ────────────────────────────
//
// requireTier, so a partner can see their own client's intake — and partner-scoped through dealFor, so
// only their own. No token is returned from here by any path.
router.get('/sitenex/deals/:id/intake', authMiddleware, requireTier('sitenex'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'bad deal id' });
    const deal = await dealFor(req.user, id);
    if (!deal) return res.status(404).json({ error: 'deal not found' });

    const links = (await query(
      `SELECT l.id, l.deal_id, l.token_tail, l.expires_at, l.revoked_at, l.created_at, l.last_used_at,
              l.issued_by, u.name AS issued_by_name, l.request_count, l.bytes_uploaded
         FROM sitenex_intake_links l LEFT JOIN users u ON u.id = l.issued_by
        WHERE l.deal_id = $1 ORDER BY l.created_at DESC`, [id])).rows.map(linkShape);
    const intake = (await query(
      `SELECT fields, required, completed_at, nudge_count, last_nudge_at
         FROM sitenex_intake WHERE deal_id = $1`, [id])).rows[0] || null;
    const files = (await query(
      `SELECT id, field, file_name, content_type, file_size, uploaded_at
         FROM sitenex_intake_files WHERE deal_id = $1 ORDER BY uploaded_at`, [id])).rows;
    const project = (await query(
      `SELECT p.id, p.status, p.assigned_to, u.name AS assigned_to_name, p.target_launch, p.launched_at,
              p.notes, p.brief, p.brief_model, p.brief_generated_at, p.brief_error
         FROM sitenex_projects p LEFT JOIN users u ON u.id = p.assigned_to
        WHERE p.deal_id = $1`, [id])).rows[0] || null;

    const fields = (intake && intake.fields && typeof intake.fields === 'object') ? intake.fields : {};
    const required = Array.isArray(intake && intake.required) ? intake.required : [];
    const used = files.reduce((n, f) => n + Number(f.file_size || 0), 0);

    // WHAT THIS CALLER MAY DO, decided server-side.
    //
    // The UI cannot work this out for itself: `currentUser` is script-scoped inside index.html's inline
    // script and is NOT on window, so an external file reading window.currentUser gets undefined and
    // every user falls into the same branch. Sending the capability is also the correct shape — the
    // server already knows, and a client-side role check is a second copy of the rule that can drift
    // from the middleware without anything failing.
    const canManage = req.user.role === 'admin' || req.user.role === 'super_admin';

    // Candidate developers, for the HUMAN assignment decision. Internal and active only — the same
    // condition PUT /sitenex/projects/:id enforces, because an external account in daily_tasks is the
    // thing item 4 exists to prevent. Only sent to somebody who can act on it.
    const developers = canManage ? (await query(
      `SELECT id, name, email, role FROM users WHERE is_active = 1 ORDER BY name`)).rows
      .filter(u => !require('../lib/roles').isExternalRole(u.role))
      .map(u => ({ id: u.id, name: u.name, role: u.role })) : [];

    res.json({
      can_manage: canManage,
      developers,
      deal: { id: deal.id, company_name: deal.company_name, status: deal.status },
      live_link: links.find(l => l.live) || null,
      links,
      intake: intake ? { ...intake,
        missing: require('../lib/sitenex/intake-required').missingItems(required, fields, files) } : null,
      files: files.map(f => ({ ...f, file_size: Number(f.file_size) })),
      quota: { used_bytes: used, limit_bytes: MAX_DEAL_BYTES,
               remaining_bytes: Math.max(0, MAX_DEAL_BYTES - used) },
      project,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /sitenex/intake-files/:id — download one upload ───────────────────────
//
// Scoped through the DEAL, not by the file id: the join to the partner scope is what stops one partner
// reading another's client's logo by guessing an integer.
router.get('/sitenex/intake-files/:id', authMiddleware, requireTier('sitenex'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'bad id' });
    const scope = await partnerScopeSql(req.user, 'd', 2);
    const f = (await query(
      `SELECT f.file_name, f.content_type, f.file_bytes, f.storage_key
         FROM sitenex_intake_files f JOIN sitenex_deals d ON d.id = f.deal_id
        WHERE f.id = $1 AND ${scope.sql}`, [id, ...scope.params])).rows[0];
    if (!f) return res.status(404).json({ error: 'file not found' });
    if (!f.file_bytes) return res.status(409).json({ error: 'this file is in object storage and the bucket is not wired up yet', storage_key: f.storage_key });
    // ALWAYS an attachment and ALWAYS nosniff: these bytes came from an unauthenticated endpoint, and
    // serving client-supplied content inline on our own origin is how a stored XSS gets its origin.
    res.set('Content-Type', 'application/octet-stream');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', `attachment; filename="${String(f.file_name).replace(/[^\w.\- ]/g, '_')}"`);
    res.send(f.file_bytes);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /sitenex/deals/:id/intake/complete — staff marks it done ─────────────
router.post('/sitenex/deals/:id/intake/complete', authMiddleware, adminOnly, requireTier('sitenex'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'bad deal id' });
    const deal = await dealFor(req.user, id);
    if (!deal) return res.status(404).json({ error: 'deal not found' });
    const r = await withTransaction(async (client) =>
      completeIntake((sql, params) => client.query(sql, params), { dealId: id, by: req.user.id }));
    if (!r.ok) return res.status(400).json({ error: r.message });
    if (!r.already) require('../lib/sitenex/intake-brief').fireBrief({ dealId: id, taskId: r.task_id });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /sitenex/projects/:id — name the developer ────────────────────────────
//
// THE HUMAN DECISION, and the only way assigned_to is ever set. There is deliberately no algorithm
// anywhere in this feature: capacity is the constraint, nothing in the database knows it, and a
// round-robin would produce a confident wrong answer that somebody then has to undo.
router.put('/sitenex/projects/:id', authMiddleware, adminOnly, requireTier('sitenex'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'bad project id' });
    const scope = await partnerScopeSql(req.user, 'd', 2);
    const proj = (await query(
      `SELECT p.id, p.deal_id FROM sitenex_projects p JOIN sitenex_deals d ON d.id = p.deal_id
        WHERE p.id = $1 AND ${scope.sql}`, [id, ...scope.params])).rows[0];
    if (!proj) return res.status(404).json({ error: 'project not found' });

    const sets = [], params = [];
    if ('assigned_to' in req.body) {
      const to = req.body.assigned_to || null;
      if (to) {
        // An EXTERNAL account cannot be the developer. Not a formality: the task lands in daily_tasks,
        // which the 8am agent scores and the coaching emails are written from, and item 4 exists
        // precisely so that an external role is never in there.
        const u = (await query(`SELECT id, role, is_active FROM users WHERE id = $1`, [to])).rows[0];
        if (!u || !u.is_active) return res.status(400).json({ error: 'no such active user' });
        if (require('../lib/roles').isExternalRole(u.role)) {
          return res.status(400).json({ error: 'a developer must be an internal account — an external role would be put into the scored task list' });
        }
      }
      params.push(to); sets.push(`assigned_to = $${params.length + 1}`);
    }
    for (const col of ['status', 'target_launch', 'notes']) {
      if (col in req.body) { params.push(req.body[col] || null); sets.push(`${col} = $${params.length + 1}`); }
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    const row = (await query(
      `UPDATE sitenex_projects SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, [id, ...params])).rows[0];
    res.json({ project: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /sitenex/deals/:id/brief — regenerate, ON EXPLICIT REQUEST ONLY ──────
//
// The spend control for item 7 is this route's existence: one call happens automatically at completion,
// and every further call is somebody pressing a button. Awaited here, unlike the automatic path, because
// the person pressing it is waiting for the result and can be shown the error.
router.post('/sitenex/deals/:id/brief', authMiddleware, adminOnly, requireTier('sitenex'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'bad deal id' });
    const deal = await dealFor(req.user, id);
    if (!deal) return res.status(404).json({ error: 'deal not found' });
    const r = await generateBrief({ dealId: id, force: true });
    if (!r.ok) return res.status(502).json({ error: r.error });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.DEAL_STATUSES = DEAL_STATUSES;
module.exports.PAYMENT_TRIGGERS = PAYMENT_TRIGGERS;
module.exports.PAYMENT_STATUSES = PAYMENT_STATUSES;
module.exports.CONTRACT_STATUSES = CONTRACT_STATUSES;
module.exports.DEAL_WRITABLE = DEAL_WRITABLE;
module.exports.LEAD_REG_STATUSES = LEAD_REG_STATUSES;
