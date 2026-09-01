// notify — write one row to the notifications feed. NEVER THROWS and never rejects: a failed
// notification insert must not affect the thing that triggered it (a completed agent run, a
// persisted draft, a tripped cost fuse). Callers may `await notify(...)` safely, or fire-and-
// forget; either way it resolves to the new id or null, and swallows every error.
//
//   notify({ product?, kind, severity?, title, body?, link_page? }) -> Promise<number|null>
//
// kind: approval_pending | agent_failed | budget | connection_expired | run_complete
// severity: info | warning | error (defaults to 'info')

const db = require('./db');

async function notify({ product = null, kind, severity = 'info', title, body = null, link_page = null } = {}, deps = {}) {
  try {
    if (!kind || !title) return null; // a notification with no kind/title is a programming error, not a crash
    const q = deps.query || db.query;
    const r = await q(
      `INSERT INTO notifications (product, kind, severity, title, body, link_page, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW()) RETURNING id`,
      [product, kind, severity, title, body, link_page]
    );
    return (r && r.rows && r.rows[0]) ? r.rows[0].id : null;
  } catch (_) {
    return null; // swallow — the trigger must be unaffected
  }
}

module.exports = { notify };
