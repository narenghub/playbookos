// OUTREACH — the one implementation. Read, write, summarise, and who-did-what.
//
// SCOPING IS INHERITED, NOT REINVENTED. Every read is narrowed with productScopeSql from
// products/held.js — the same fragment the notifications feed uses — so a caller sees outreach on the
// products they hold and nothing else. There are no new access rules here, which was the instruction and
// is also the only way this stays correct: a second copy of the rules is a second thing to get wrong.
//
// 'new' NEEDS NO ROW. That single decision shapes everything below: a list of 1,524 untouched prospects
// writes nothing, and every count has to ADD the implicit remainder rather than reading it from the table.
// summary() does that explicitly; forgetting it is the bug that would make the status bar say
// "0 new" over a list of 1,524 untouched rows.

const { productScopeSql } = require('../products/held');
const { STATUS_DEFS, STATUSES, DEFAULT_STATUS, CONTACT_STATUSES, CHANNELS, ENTITIES,
        entity, isEntityType, isStatus, isChannel, statusOrder } = require('./registry');

const q = (deps) => deps.query || require('../db').query;

// ── read ──────────────────────────────────────────────────────────────────────

// Status for a set of entity ids, as a map { id: row }. Ids missing from the map are 'new'.
// The caller passes the ids it is already showing, so this never scans the whole table.
async function statusFor(entityType, ids, held, deps = {}) {
  if (!isEntityType(entityType) || !ids || !ids.length) return {};
  const scope = productScopeSql(held, 'o', 3);
  const r = await q(deps)(
    `SELECT o.entity_id, o.status, o.channel, o.owner_user_id, o.last_contacted_at, o.next_action_at, o.note,
            o.updated_at, u.name AS owner_name
       FROM outreach o LEFT JOIN users u ON u.id = o.owner_user_id
      WHERE o.entity_type = $1 AND o.entity_id = ANY($2) AND ${scope.sql}`,
    [entityType, ids.map(String), ...scope.params]);
  const out = {};
  for (const row of r.rows) out[row.entity_id] = row;
  return out;
}

// ── write ─────────────────────────────────────────────────────────────────────

// Set a status. Upsert plus an event, in ONE transaction: a status change with no event is the exact gap
// the events table exists to close, so it must not be reachable.
//
// The product is NOT taken from the caller. For an entity whose table carries a product it is read from
// the row; otherwise it is the registry's fixed value. A client-supplied product would let somebody file
// outreach under a product they hold against a row belonging to one they do not.
async function setStatus({ entityType, entityId, status, channel, note, nextActionAt, ownerUserId, user, held }, deps = {}) {
  if (!isEntityType(entityType)) return { ok: false, code: 'unknown_entity_type', error: `Unknown entity_type '${entityType}'` };
  if (!isStatus(status)) {
    return { ok: false, code: 'unknown_status', error: `Unknown status '${status}'. One of: ${STATUSES.join(', ')}` };
  }
  // Channel is OPTIONAL — a status change is not always a touch (disqualifying a chain from the desk) — but
  // a value that IS supplied has to be one we know, or the field stops being groupable.
  if (channel != null && channel !== '' && !isChannel(channel)) {
    return { ok: false, code: 'unknown_channel', error: `Unknown channel '${channel}'. One of: ${CHANNELS.join(', ')}` };
  }
  const chan = channel || null;
  const def = entity(entityType);
  const query = q(deps);
  const id = String(entityId);

  // 1. Does the entity exist, and which product is it? Read from the row, never from the request.
  let product = def.product;
  const idExpr = def.idCast === 'bigint' ? `id = $1::bigint` : `id = $1`;
  let exists;
  try {
    const cols = def.product === 'row' ? 'id, product' : 'id';
    exists = (await query(`SELECT ${cols} FROM ${def.table} WHERE ${idExpr}`, [id])).rows[0];
  } catch (e) {
    // A non-numeric id against a bigint column throws rather than returning nothing.
    return { ok: false, code: 'bad_entity_id', error: `Not a valid ${def.label} id: ${id}` };
  }
  if (!exists) return { ok: false, code: 'entity_not_found', error: `${def.label} ${id} not found` };
  if (def.product === 'row') {
    product = exists.product;
    if (!product) return { ok: false, code: 'entity_has_no_product', error: `${def.label} ${id} has no product` };
  }

  // 2. The caller must hold that product. This is the same check the boundary makes for the ROUTE, applied
  //    to the ROW — the route is one product's, the row might not be.
  if (!(held || []).includes(product)) {
    return { ok: false, code: 'product_not_held', error: `Forbidden: this ${def.label} belongs to '${product}'` };
  }

  // 3. Upsert + event, together.
  const txn = deps.withTransaction || require('../db').withTransaction;
  let result;
  await txn(async (c) => {
    const before = (await c.query(
      `SELECT id, status FROM outreach WHERE entity_type = $1 AND entity_id = $2`, [entityType, id])).rows[0];
    const from = before ? before.status : DEFAULT_STATUS;    // no row = 'new'
    // last_contacted_at only moves when the change MEANS contact happened. Marking something
    // disqualified is not contact, and stamping it would make "last contacted" a lie.
    // CONTACT_STATUSES lives in the registry beside the vocabulary, so adding a stage forces a decision
    // about whether reaching it means we touched them.
    const touched = CONTACT_STATUSES.includes(status);
    const up = await c.query(
      `INSERT INTO outreach (entity_type, entity_id, product, status, channel, owner_user_id, note,
                             next_action_at, last_contacted_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$9,$5,$6,$7, CASE WHEN $8 THEN NOW() ELSE NULL END, NOW(), NOW())
       ON CONFLICT (entity_type, entity_id) DO UPDATE SET
         status = EXCLUDED.status,
         product = EXCLUDED.product,
         -- channel is "how we LAST touched them", so it only moves when one is supplied; a status change
         -- with no channel must not erase the last known one.
         channel = COALESCE(EXCLUDED.channel, outreach.channel),
         owner_user_id = COALESCE(EXCLUDED.owner_user_id, outreach.owner_user_id),
         note = COALESCE(EXCLUDED.note, outreach.note),
         next_action_at = EXCLUDED.next_action_at,
         last_contacted_at = CASE WHEN $8 THEN NOW() ELSE outreach.last_contacted_at END,
         updated_at = NOW()
       RETURNING *`,
      [entityType, id, product, status, ownerUserId || (user && user.id) || null,
       note || null, nextActionAt || null, touched, chan]);
    const row = up.rows[0];
    await c.query(
      `INSERT INTO outreach_events (outreach_id, from_status, to_status, channel, by_user_id, by_email, note)
       VALUES ($1,$2,$3,$7,$4,$5,$6)`,
      [row.id, from, status, (user && user.id) || null, (user && user.email) || null, note || null, chan]);
    result = { ok: true, row, from, to: status, channel: chan, changed: from !== status };

    // ── won → a SiteNex deal ──────────────────────────────────────────────────
    // A SiteNex prospect reaching 'won' becomes a deal rather than a fact recorded in two places. Linked
    // by sitenex_deals.prospect_id, which is the natural key — so no new column, and re-marking 'won'
    // finds the existing deal instead of making a second one.
    if (entityType === 'prospect' && product === 'sitenex' && status === 'won') {
      const existing = (await c.query(
        `SELECT id, status FROM sitenex_deals WHERE prospect_id = $1::bigint ORDER BY id LIMIT 1`, [id])).rows[0];
      if (existing) {
        result.deal = { id: existing.id, created: false, status: existing.status };
      } else {
        // 'signed' because that is what won MEANS in this vocabulary ("signed / now a customer"). The deal
        // board's own lifecycle takes over from here.
        const made = (await c.query(
          `INSERT INTO sitenex_deals (prospect_id, status, owner_user_id, created_at, updated_at)
           VALUES ($1::bigint, 'signed', $2, NOW(), NOW()) RETURNING id, status`,
          [id, (user && user.id) || null])).rows[0];
        result.deal = { id: made.id, created: true, status: made.status };
      }
    }
  });
  return result;
}

// ── the summary bar ───────────────────────────────────────────────────────────

// Counts per status for one list, INCLUDING the implicit 'new'.
//
// `totalEntities` is how many rows the list has in total (the caller knows it — it is the number already
// shown). Anything without an outreach row is 'new', so new = total − (rows that have one). Reading 'new'
// out of the table would report 0 over a list of 1,524 untouched prospects.
async function summary(entityType, { held, totalEntities = null, product = null } = {}, deps = {}) {
  if (!isEntityType(entityType)) return null;
  const scope = productScopeSql(held, 'o', 2);
  const params = [entityType, ...scope.params];
  let extra = '';
  if (product) { extra = ` AND o.product = $${params.length + 1}`; params.push(product); }
  const rows = (await q(deps)(
    `SELECT o.status, COUNT(*)::int n FROM outreach o
      WHERE o.entity_type = $1 AND ${scope.sql}${extra} GROUP BY 1`, params)).rows;

  // Seeded in FUNNEL order, from sort_order — not from STATUSES' array position. Object key order is what
  // the bar renders, so if it came from the array then reordering the array would silently reorder the
  // funnel and sort_order would be decorative. It is the authority; the array is just a list.
  const funnel = STATUS_DEFS.slice().sort((a, b) => a.order - b.order);
  const counts = {};
  for (const d of funnel) counts[d.key] = 0;
  let tracked = 0;
  for (const r of rows) {
    // A status not in the vocabulary is still counted, under its own name — the column has no CHECK, so
    // dropping an unknown value would silently lose rows.
    counts[r.status] = (counts[r.status] || 0) + r.n;
    tracked += r.n;
  }
  if (totalEntities != null) {
    counts[DEFAULT_STATUS] = Math.max(0, totalEntities - tracked);
  }
  // `order` is the FUNNEL — the bar's whole value is that adjacent columns are adjacent stages, so the
  // drop-off between two of them means something.
  return { entity_type: entityType, counts, tracked, total: totalEntities,
           order: funnel.map(s => s.key), funnel };
}

// ── who did what ──────────────────────────────────────────────────────────────

// The question current status cannot answer: how many did Vinitha contact last week.
// Grouped per person per status, over a window, scoped by product like everything else.
async function activity({ held, sinceDays = 7, entityType = null, userId = null } = {}, deps = {}) {
  const scope = productScopeSql(held, 'o', 2);
  const params = [Math.max(1, Math.min(365, Number(sinceDays) || 7)), ...scope.params];
  let extra = '';
  if (entityType) { extra += ` AND o.entity_type = $${params.length + 1}`; params.push(entityType); }
  if (userId) { extra += ` AND e.by_user_id = $${params.length + 1}`; params.push(userId); }
  const rows = (await q(deps)(
    `SELECT COALESCE(u.name, e.by_email, '(unknown)') AS person, e.by_user_id, e.by_email,
            e.to_status, e.channel, o.entity_type, COUNT(*)::int n, MAX(e.created_at) AS last_at
       FROM outreach_events e
       JOIN outreach o ON o.id = e.outreach_id
       LEFT JOIN users u ON u.id = e.by_user_id
      WHERE e.created_at > NOW() - ($1 || ' days')::interval AND ${scope.sql}${extra}
      GROUP BY 1,2,3,4,5,6
      ORDER BY 7 DESC`, params)).rows;

  // Rolled up per person so the view reads as "Vinitha: 50 contacted, 3 interested".
  const byPerson = new Map();
  for (const r of rows) {
    const key = r.by_user_id || r.by_email || r.person;
    if (!byPerson.has(key)) byPerson.set(key, { person: r.person, user_id: r.by_user_id, total: 0,
                                                by_status: {}, by_channel: {}, last_at: r.last_at });
    const p = byPerson.get(key);
    p.total += r.n;
    p.by_status[r.to_status] = (p.by_status[r.to_status] || 0) + r.n;
    // Channel is nullable — a status change is not always a touch — so an unrecorded one is counted as such
    // rather than being dropped or invented.
    const ch = r.channel || '(not recorded)';
    p.by_channel[ch] = (p.by_channel[ch] || 0) + r.n;
    if (r.last_at > p.last_at) p.last_at = r.last_at;
  }
  return { since_days: params[0], people: [...byPerson.values()].sort((a, b) => b.total - a.total), rows };
}

// ── THE CROSS-LIST VIEW ───────────────────────────────────────────────────────
//
// "Who is reaching out and who is not" spans every list, so a per-list summary cannot answer it — that one
// tells you how far through SiteNex you are, which is a different question.
//
// Four views from one call, because they are one glance: by person, by list, by status moved to, and THE
// SILENCE — lists with no events at all in the window. The silence is the part that has to arrive without
// anyone going looking for it, so it is computed from the full set of lists the viewer can see MINUS the
// ones with events, rather than from the events alone (which by definition cannot mention a silent list).
async function overview({ held, sinceDays = 7 } = {}, deps = {}) {
  const days = Math.max(1, Math.min(365, Number(sinceDays) || 7));
  const act = await activity({ held, sinceDays: days }, deps);

  const byList = {}, byStatus = {}, byChannel = {};
  for (const r of act.rows) {
    byList[r.entity_type] = (byList[r.entity_type] || 0) + r.n;
    byStatus[r.to_status] = (byStatus[r.to_status] || 0) + r.n;
    byChannel[r.channel || '(not recorded)'] = (byChannel[r.channel || '(not recorded)'] || 0) + r.n;
  }

  // Which lists can this viewer see at all? A fixed-product list needs that product; a 'row' list
  // (prospects, whose rows span four products) needs any product at all.
  const heldSet = new Set(held || []);
  const visible = Object.entries(ENTITIES).filter(([, def]) =>
    def.product === 'row' ? heldSet.size > 0 : heldSet.has(def.product));

  const lists = visible.map(([type, def]) => ({
    entity_type: type, label: def.label, pages: def.pages,
    events: byList[type] || 0,
  })).sort((a, b) => b.events - a.events);

  return {
    since_days: days,
    people: act.people,
    by_list: lists,
    by_status: byStatus,
    by_channel: byChannel,
    // Named separately as well as being derivable, so a client cannot render the page and quietly omit it.
    silent: lists.filter(l => l.events === 0).map(l => ({ entity_type: l.entity_type, label: l.label, pages: l.pages })),
    total_events: act.rows.reduce((a, r) => a + r.n, 0),
  };
}

// The full history for one entity, for the inline control's tooltip / detail.
async function history(entityType, entityId, held, deps = {}) {
  const scope = productScopeSql(held, 'o', 3);
  return (await q(deps)(
    `SELECT e.created_at, e.from_status, e.to_status, e.channel, e.note,
            COALESCE(u.name, e.by_email) AS by_person
       FROM outreach_events e JOIN outreach o ON o.id = e.outreach_id
       LEFT JOIN users u ON u.id = e.by_user_id
      WHERE o.entity_type = $1 AND o.entity_id = $2 AND ${scope.sql}
      ORDER BY e.created_at DESC, e.id DESC LIMIT 50`,
    [entityType, String(entityId), ...scope.params])).rows;
}

module.exports = { statusFor, setStatus, summary, activity, overview, history };
