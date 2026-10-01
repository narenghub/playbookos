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
const { authMiddleware, requireTier, adminOnly } = require('../lib/core');
const { partnerScopeSql } = require('../lib/products/partner-scope');
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
  d.created_at, d.updated_at,
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
    const columns = DEAL_STATUSES.map(status => ({
      status, deals: rows.filter(r => r.status === status).map(dealShape),
    }));
    res.json({ total: rows.length, statuses: DEAL_STATUSES, columns,
      scope: scope.isStaff ? 'all partners' : (scope.failed ? 'none' : 'own partner only'),
      partner_id: scope.partnerId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/sitenex/deals/:id', authMiddleware, requireTier('sitenex'), async (req, res) => {
  try {
    const deal = await dealFor(req.user, req.params.id);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });
    const contracts = (await query(
      `SELECT id, contract_no, status, template_version, file_name, file_size, created_at, superseded_by
         FROM sitenex_contracts WHERE deal_id = $1 ORDER BY id DESC`, [deal.id])).rows;
    res.json({ deal: dealShape(deal), payments: await paymentsFor(deal.id), contracts,
               // includeSystem:false — the answer is "what does this DEAL still need", and the
               // contract number is the generator's to supply.
               renderable: checkRenderable(await contractInputFor(deal), { includeSystem: false }) });
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
    const sets = [], vals = [];
    for (const c of DEAL_WRITABLE) {
      if (!(c in b)) continue;
      let v = b[c];
      if (/_cents$|^duration_weeks$|^prospect_id$/.test(c)) {
        v = intOrNull(v);
        if (Number.isNaN(v)) return res.status(400).json({ error: `${c} must be a number` });
      }
      if (c === 'starts_at_intake') v = !(v === false || v === 'false');
      vals.push(v); sets.push(`${c} = $${vals.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });

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
    res.json({ ok: true, deal: dealShape(deal), payments: await paymentsFor(existing.id),
               changed: sets.map(s => s.split(' = ')[0]) });
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
async function contractInputFor(deal, contractNo = null) {
  const pkg = deal.package_code
    ? (await query(`SELECT code, name, included, not_included FROM sitenex_packages WHERE code = $1`,
                   [deal.package_code])).rows[0]
    : null;
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
              c.partner_name, u.name AS generated_by_name,
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
            template_version, file_name, file_bytes, file_size, status, generated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,'generated',$26)
         RETURNING id, contract_no, status, file_name, file_size, created_at`,
        [contractNo, deal.id, deal.partner_id, input.client_company, input.client_contact,
         input.client_title, input.client_email, input.client_phone, input.client_address,
         input.partner_name, input.partner_email, input.package_code, input.package_name,
         JSON.stringify(input.included || []), JSON.stringify(input.not_included || []),
         input.value_cents, input.monthly_cents, input.duration_weeks, input.starts_at_intake,
         input.terms_note, JSON.stringify(payments), doc.template_version, doc.file_name,
         doc.buffer, doc.buffer.length, req.user.id])).rows[0];

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

// ── the prospect's call sheet and email, generated ON OPEN ─────────────────────
//
// Not partner-scoped: prospects are ours, and SiteNex Prospects is already admin-only elsewhere. This
// route is requireTier('sitenex') so a partner working a referral can get the script for a row they
// have been given, which is the whole point of the content existing.
router.get('/sitenex/prospects/:id/content', authMiddleware, requireTier('sitenex'), async (req, res) => {
  try {
    const p = (await query(
      `SELECT id, name, website, site_url, site_score, site_findings, recommended_package, subtype,
              region, phone, address
         FROM prospects WHERE id = $1::bigint AND product = 'sitenex'`, [req.params.id])).rows[0];
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

module.exports = router;
module.exports.DEAL_STATUSES = DEAL_STATUSES;
module.exports.PAYMENT_TRIGGERS = PAYMENT_TRIGGERS;
module.exports.PAYMENT_STATUSES = PAYMENT_STATUSES;
module.exports.CONTRACT_STATUSES = CONTRACT_STATUSES;
module.exports.DEAL_WRITABLE = DEAL_WRITABLE;
