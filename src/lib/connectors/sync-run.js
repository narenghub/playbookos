'use strict';
// ── CONNECTOR SYNC LIFECYCLE ─────────────────────────────────────────────────
//
// The only place that writes source_sync_runs and federal_awards. The adapters stay pure; this
// file owns persistence, the call ceiling, and the two refusals.
//
// Every write takes the frozen company context from src/lib/office/context.js and scopes by
// ctx.companyId, for the reason that file documents: a predicate the caller supplies is the thing
// company context exists to refuse.
//
// ── THE TWO REFUSALS, AND WHY THEY ARE HERE RATHER THAN IN A COMMENT ─────────
//
// R1  access_mode = 'manual_assisted' can never be synced.
//     FedConnect and SBCX are authenticated portals with no published API. The brief forbids
//     scraping authenticated portals and bypassing access controls. "We decided not to automate
//     that" is a decision; a function that refuses to is a control. The refusal writes a
//     source_sync_runs row with status 'refused' so the attempt is auditable — a refusal that
//     leaves no trace is indistinguishable from never having tried.
//
// R2  activated = false can never be synced.
//     Ruling 5: SAM.gov is prepared, not activated, until API access and quotas are verified.
//     The flag lives in the database precisely so that honouring it does not depend on anybody
//     reading this file.
//
// ── WHY THE WATERMARK ONLY MOVES ON SUCCESS ──────────────────────────────────
//
// completeSync is the only function that writes high_water_mark. A partially-synced page that
// advanced the watermark would permanently skip every record between the failure point and the
// next run's start — no error, no gap in the row count anybody would notice, just records that
// were never fetched. That is the quiet failure mode, and it is worse than a loud one because
// nothing ever reports it.

const { assertContext } = require('../office/context');

function lazyQuery() { return require('../db').query; }
function q(deps) { return (deps && deps.query) || lazyQuery(); }

class SyncRefused extends Error {
  constructor(msg, code) { super(msg); this.name = 'SyncRefused'; this.code = code; }
}

const newId = () => (require('crypto').randomUUID());

/**
 * Look up a connector. Global read — source_connectors holds facts about public APIs and carries
 * no company_id, as schema.js documents.
 */
async function getConnector(sourceKey, deps = {}) {
  const { rows } = await q(deps)(
    `SELECT source_key, display_name, kind, auth_mode, access_mode, daily_call_ceiling, activated, notes
       FROM source_connectors WHERE source_key = $1`, [sourceKey]);
  return rows[0] || null;
}

/**
 * Open a sync. Enforces R1 and R2 before any network call is possible, and records a 'refused'
 * row when it declines so the attempt leaves evidence.
 *
 * runId is REQUIRED, not optional. source_sync_runs.company_id is NOT NULL, so under the
 * MATCH FULL composite FK the (run_id, company_id) pair can never be half-present — a NULL run_id
 * is rejected by the engine. That is deliberate: the agent_run is what carries the kill switch,
 * the cost ledger and the audit trail, so a sync outside a run would be a sync nobody can stop.
 */
async function beginSync(ctx, { sourceKey, runId, windowFrom = null, windowTo = null }, deps = {}) {
  assertContext(ctx);
  if (!sourceKey) throw new Error('beginSync: sourceKey is required');
  if (!runId) throw new Error('beginSync: runId is required — a sync must happen inside an agent_run');

  const conn = await getConnector(sourceKey, deps);
  if (!conn) throw new Error(`beginSync: unknown source_key "${sourceKey}" — seed it in schema.js first`);

  const refuse = async (code, reason) => {
    const id = newId();
    await q(deps)(
      `INSERT INTO source_sync_runs
         (id, company_id, source_key, run_id, window_from, window_to, call_ceiling, status, error_text, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'refused',$8,NOW())`,
      [id, ctx.companyId, sourceKey, runId, windowFrom, windowTo, conn.daily_call_ceiling, reason]);
    throw new SyncRefused(reason, code);
  };

  // R1 — portals are not data endpoints.
  if (conn.access_mode === 'manual_assisted') {
    await refuse('MANUAL_ASSISTED',
      `${sourceKey} is access_mode=manual_assisted: an authenticated portal with no published API. `
      + 'Automated access is not permitted; this source is handled as a scheduled human task.');
  }
  // R2 — prepared is not activated.
  if (conn.activated !== true) {
    await refuse('NOT_ACTIVATED',
      `${sourceKey} is not activated. Activation requires verified API access and quotas `
      + '(ruling 5). Flip source_connectors.activated once that is confirmed.');
  }

  const id = newId();
  await q(deps)(
    `INSERT INTO source_sync_runs
       (id, company_id, source_key, run_id, window_from, window_to, call_ceiling, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'running')`,
    [id, ctx.companyId, sourceKey, runId, windowFrom, windowTo, conn.daily_call_ceiling]);

  return { syncId: id, connector: conn, ceiling: conn.daily_call_ceiling };
}

/**
 * Charge n calls against the ceiling BEFORE making them.
 *
 * Charging first is the whole point. Counting after the fact discovers the overrun by receiving an
 * HTTP 429, which arrives mid-page and leaves the run in exactly the half-finished state the
 * watermark rule exists to protect against. The CHECK constraint on source_sync_runs refuses the
 * UPDATE that would exceed the ceiling, so this is enforced by the engine and not only here.
 *
 * Returns { allowed, remaining }. On refusal the caller must stop and close the run as
 * 'ceiling_reached' — not retry, not fall back to a smaller page.
 */
async function chargeCalls(ctx, syncId, n = 1, deps = {}) {
  assertContext(ctx);
  if (!Number.isInteger(n) || n < 1) throw new Error('chargeCalls: n must be a positive integer');
  const { rows } = await q(deps)(
    `UPDATE source_sync_runs
        SET calls_made = calls_made + $3
      WHERE id = $1 AND company_id = $2 AND status = 'running'
        AND (call_ceiling IS NULL OR calls_made + $3 <= call_ceiling)
      RETURNING calls_made, call_ceiling`,
    [syncId, ctx.companyId, n]);

  if (!rows.length) {
    const cur = await q(deps)(
      `SELECT calls_made, call_ceiling, status FROM source_sync_runs WHERE id = $1 AND company_id = $2`,
      [syncId, ctx.companyId]);
    const r = cur.rows[0];
    if (!r) throw new Error(`chargeCalls: no sync ${syncId} for this company`);
    if (r.status !== 'running') throw new Error(`chargeCalls: sync ${syncId} is ${r.status}, not running`);
    return { allowed: false, remaining: Math.max(0, (r.call_ceiling ?? 0) - r.calls_made), ceiling: r.call_ceiling };
  }
  const r = rows[0];
  return {
    allowed: true,
    remaining: r.call_ceiling == null ? null : r.call_ceiling - r.calls_made,
    ceiling: r.call_ceiling,
  };
}

/**
 * Upsert normalised awards. Idempotent by the unique index on
 * (company_id, source_key, award_key) — enforced by the database, not by a read-then-write that
 * races itself under concurrency (§15: no duplicates after repeated synchronisation).
 *
 * On conflict, first_seen_sync_id is PRESERVED and last_seen_* is advanced. Overwriting
 * first_seen would erase when we first saw an award, which is the only thing that distinguishes
 * a new award from one we have watched for a year.
 */
async function upsertAwards(ctx, syncId, normalized, deps = {}) {
  assertContext(ctx);
  const rows = (normalized || []).filter((n) => n && !n.skip);
  const skipped = (normalized || []).filter((n) => n && n.skip);
  let inserted = 0;
  let updated = 0;

  for (const a of rows) {
    if (a.companyId !== ctx.companyId) {
      // A normalised row carrying another tenant's id is a programming error, and the composite FK
      // would catch it on write. Failing here names it instead of surfacing a constraint violation.
      throw new Error(`upsertAwards: row companyId ${a.companyId} does not match context ${ctx.companyId}`);
    }
    const { rows: out } = await q(deps)(
      `INSERT INTO federal_awards
         (id, company_id, source_key, award_key, piid, parent_piid, awarding_agency_code,
          awarding_agency, awarding_sub_agency, recipient_name, recipient_profile_id,
          naics_code, naics_description, psc_code, psc_description, obligated_amount,
          pop_start_date, pop_end_date, source_url, raw_json, first_seen_sync_id, last_seen_sync_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21)
       ON CONFLICT (company_id, source_key, award_key) DO UPDATE SET
         piid                 = EXCLUDED.piid,
         parent_piid          = EXCLUDED.parent_piid,
         awarding_agency_code = EXCLUDED.awarding_agency_code,
         awarding_agency      = EXCLUDED.awarding_agency,
         awarding_sub_agency  = EXCLUDED.awarding_sub_agency,
         recipient_name       = EXCLUDED.recipient_name,
         recipient_profile_id = EXCLUDED.recipient_profile_id,
         naics_code           = EXCLUDED.naics_code,
         naics_description    = EXCLUDED.naics_description,
         psc_code             = EXCLUDED.psc_code,
         psc_description      = EXCLUDED.psc_description,
         obligated_amount     = EXCLUDED.obligated_amount,
         pop_start_date       = EXCLUDED.pop_start_date,
         pop_end_date         = EXCLUDED.pop_end_date,
         source_url           = EXCLUDED.source_url,
         raw_json             = EXCLUDED.raw_json,
         last_seen_at         = NOW(),
         last_seen_sync_id    = EXCLUDED.last_seen_sync_id
       RETURNING (ingested_at = last_seen_at) AS is_new`,
      [newId(), a.companyId, a.sourceKey, a.awardKey, a.piid, a.parentPiid, a.awardingAgencyCode,
        a.awardingAgency, a.awardingSubAgency, a.recipientName, a.recipientProfileId,
        a.naicsCode, a.naicsDescription, a.pscCode, a.pscDescription, a.obligatedAmount,
        a.popStartDate, a.popEndDate, a.sourceUrl, JSON.stringify(a.rawJson), syncId]);
    if (out[0] && out[0].is_new) inserted += 1; else updated += 1;
  }

  await q(deps)(
    `UPDATE source_sync_runs
        SET records_seen = records_seen + $3, records_upserted = records_upserted + $4
      WHERE id = $1 AND company_id = $2`,
    [syncId, ctx.companyId, (normalized || []).length, rows.length]);

  return { inserted, updated, skipped: skipped.length, skippedReasons: skipped.map((s) => s.reason) };
}

/**
 * Upsert Grants.gov funding opportunities and their revision chain.
 *
 * Separate from upsertAwards by ruling: grant opportunities are preserved apart from procurement
 * contracts and revenue, and there is no column here that could feed a procurement total.
 *
 * `biddable` is NEVER passed. It is a generated column, so the database computes it from
 * opp_status, doc_type and close_date; attempting to write it is an error rather than a silent
 * override. That is the point — a forecast cannot be made to look live by a caller that misread a
 * field.
 */
async function upsertFundingOpportunities(ctx, syncId, normalized, deps = {}) {
  assertContext(ctx);
  const rows = (normalized || []).filter((n) => n && !n.skip);
  const skipped = (normalized || []).filter((n) => n && n.skip);
  let inserted = 0;
  let updated = 0;
  let versionRows = 0;

  for (const o of rows) {
    if (o.companyId !== ctx.companyId) {
      throw new Error(`upsertFundingOpportunities: row companyId ${o.companyId} does not match context ${ctx.companyId}`);
    }
    const rowId = newId();
    const { rows: out } = await q(deps)(
      `INSERT INTO funding_opportunities
         (id, company_id, source_key, opportunity_id, opportunity_number, title, agency_code,
          agency_name, doc_type, opp_status, standing, open_date, close_date, archive_date,
          estimated_funding, award_ceiling, award_floor, cost_sharing, cfda_list, current_revision,
          source_url, raw_json, first_seen_sync_id, last_seen_sync_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$23)
       ON CONFLICT (company_id, source_key, opportunity_id) DO UPDATE SET
         opportunity_number = EXCLUDED.opportunity_number,
         title              = EXCLUDED.title,
         agency_code        = EXCLUDED.agency_code,
         agency_name        = EXCLUDED.agency_name,
         doc_type           = EXCLUDED.doc_type,
         opp_status         = EXCLUDED.opp_status,
         standing           = EXCLUDED.standing,
         open_date          = EXCLUDED.open_date,
         close_date         = EXCLUDED.close_date,
         archive_date       = EXCLUDED.archive_date,
         estimated_funding  = EXCLUDED.estimated_funding,
         award_ceiling      = EXCLUDED.award_ceiling,
         award_floor        = EXCLUDED.award_floor,
         cost_sharing       = EXCLUDED.cost_sharing,
         cfda_list          = EXCLUDED.cfda_list,
         current_revision   = EXCLUDED.current_revision,
         source_url         = EXCLUDED.source_url,
         raw_json           = EXCLUDED.raw_json,
         last_seen_at       = NOW(),
         last_seen_sync_id  = EXCLUDED.last_seen_sync_id
       RETURNING id, (ingested_at = last_seen_at) AS is_new`,
      [rowId, o.companyId, o.sourceKey, o.opportunityId, o.opportunityNumber, o.title, o.agencyCode,
        o.agencyName, o.docType, o.oppStatus, o.standing, o.openDate, o.closeDate, o.archiveDate,
        o.estimatedFunding ?? null, o.awardCeiling ?? null, o.awardFloor ?? null,
        o.costSharing ?? null, o.cfdaList || [], o.currentRevision ?? null,
        o.sourceUrl, JSON.stringify(o.rawJson), syncId]);
    if (out[0] && out[0].is_new) inserted += 1; else updated += 1;

    // The revision chain, when the detail call supplied one.
    for (const v of o.versions || []) {
      // is_current is cleared across the whole opportunity BEFORE the new current is written.
      // Without that, the partial unique index refuses the write — correctly — because two rows
      // would claim to be current, and the right resolution is to retire the old claim rather than
      // to widen the index.
      if (v.isCurrent) {
        await q(deps)(
          `UPDATE funding_opportunity_versions SET is_current = FALSE
            WHERE company_id = $1 AND source_key = $2 AND opportunity_id = $3
              AND is_current AND revision <> $4`,
          [ctx.companyId, o.sourceKey, o.opportunityId, v.revision]);
      }
      await q(deps)(
        `INSERT INTO funding_opportunity_versions
           (id, company_id, source_key, opportunity_id, opportunity_row_id, revision, is_current,
            title, opportunity_number, modified_fields, close_date, raw_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (company_id, source_key, opportunity_id, revision) DO UPDATE SET
           is_current       = EXCLUDED.is_current,
           title            = EXCLUDED.title,
           modified_fields  = EXCLUDED.modified_fields,
           close_date       = EXCLUDED.close_date,
           raw_json         = EXCLUDED.raw_json`,
        [newId(), ctx.companyId, o.sourceKey, o.opportunityId, out[0] ? out[0].id : rowId,
          v.revision, !!v.isCurrent, v.title, v.opportunityNumber,
          v.modifiedFields || [], v.closeDate, JSON.stringify(v.rawJson)]);
      versionRows += 1;
    }
  }

  await q(deps)(
    `UPDATE source_sync_runs
        SET records_seen = records_seen + $3, records_upserted = records_upserted + $4
      WHERE id = $1 AND company_id = $2`,
    [syncId, ctx.companyId, (normalized || []).length, rows.length]);

  return { inserted, updated, versions: versionRows, skipped: skipped.length, skippedReasons: skipped.map((s) => s.reason) };
}

/**
 * Close a sync successfully. THE ONLY place high_water_mark is written.
 */
async function completeSync(ctx, syncId, { highWaterMark = null } = {}, deps = {}) {
  assertContext(ctx);
  const { rows } = await q(deps)(
    `UPDATE source_sync_runs
        SET status = 'completed', finished_at = NOW(), high_water_mark = $3
      WHERE id = $1 AND company_id = $2 AND status = 'running'
      RETURNING id, calls_made, records_seen, records_upserted, high_water_mark`,
    [syncId, ctx.companyId, highWaterMark]);
  if (!rows.length) throw new Error(`completeSync: sync ${syncId} is not running for this company`);
  return rows[0];
}

/**
 * Close a sync as failed or ceiling-reached. Deliberately takes no watermark argument — there is
 * no signature by which a caller could advance it on a failure path.
 */
async function endSyncUnsuccessfully(ctx, syncId, { status, error }, deps = {}) {
  assertContext(ctx);
  if (!['failed', 'ceiling_reached'].includes(status)) {
    throw new Error(`endSyncUnsuccessfully: status must be failed or ceiling_reached; got ${status}`);
  }
  const { rows } = await q(deps)(
    `UPDATE source_sync_runs
        SET status = $3, finished_at = NOW(), error_text = $4
      WHERE id = $1 AND company_id = $2 AND status = 'running'
      RETURNING id, status, calls_made, records_upserted, high_water_mark`,
    [syncId, ctx.companyId, status, error == null ? null : String(error).slice(0, 2000)]);
  if (!rows.length) throw new Error(`endSyncUnsuccessfully: sync ${syncId} is not running for this company`);
  return rows[0];
}

/**
 * The watermark to resume from: the most recent COMPLETED sync for this company and source.
 * A failed or refused run never contributes one.
 */
async function lastWatermark(ctx, sourceKey, deps = {}) {
  assertContext(ctx);
  const { rows } = await q(deps)(
    `SELECT high_water_mark, finished_at
       FROM source_sync_runs
      WHERE company_id = $1 AND source_key = $2 AND status = 'completed'
        AND high_water_mark IS NOT NULL
      ORDER BY finished_at DESC
      LIMIT 1`, [ctx.companyId, sourceKey]);
  return rows[0] ? rows[0].high_water_mark : null;
}

module.exports = {
  SyncRefused,
  getConnector,
  beginSync,
  chargeCalls,
  upsertAwards,
  upsertFundingOpportunities,
  completeSync,
  endSyncUnsuccessfully,
  lastWatermark,
};
