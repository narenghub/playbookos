// Run:  railway ssh 'node scripts/verify-notification-scope.js'
// Self-cleaning prod check of the notification product scope against the REAL table.
// The table was empty when this was written, so nothing could be observed from live data: insert one
// row per product, prove the scope narrows correctly against the REAL column type and collation, then
// delete. Rows are tagged in the title so a leak is obvious, and deleted in a finally.
const { query } = require('../src/lib/db');
const { productScopeSql } = require('../src/lib/products/held');
const TAG = 'VERIFY-NOTIF-SCOPE-' + Date.now();
let ids = [], fail = 0;
const check = (label, a, e) => { const ok = JSON.stringify(a) === JSON.stringify(e);
  if (!ok) fail++; console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? '' : `\n      expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`}`); };
const seen = async (held) => {
  const s = productScopeSql(held, '', 2);
  return (await query(`SELECT COALESCE(product,'(null)') p FROM notifications WHERE title LIKE $1 AND ${s.sql} `,
    [TAG + '%', ...s.params])).rows.map(r => r.p).sort();
};
(async () => {
  try {
    for (const p of ['golfnex', 'sitenex', null]) {
      const r = await query(`INSERT INTO notifications (product, kind, severity, title, read_at, created_at)
        VALUES ($1,'agent_failed','error',$2,NULL,NOW()) RETURNING id`, [p, `${TAG} ${p || 'platform'}`]);
      ids.push(r.rows[0].id);
    }
    check('staff (holds everything incl. internal) sees all three',
      await seen(['abiozen','golfnex','favly','linkabl','aros','sitenex','internal']),
      ['(null)','sitenex','golfnex'].sort());
    check('an sitenex-only partner sees ONLY sitenex — no golfnex, no platform-wide',
      await seen(['sitenex']), ['sitenex']);
    check('holding nothing sees nothing', await seen([]), []);
    check("'internal' alone sees only the platform-wide row", await seen(['internal']), ['(null)']);

    // read-all, scoped: a partner clicking the bell must not clear the other two.
    const s = productScopeSql(['sitenex'], '', 2);
    const upd = await query(`UPDATE notifications SET read_at = NOW() WHERE title LIKE $1 AND read_at IS NULL AND ${s.sql}`,
      [TAG + '%', ...s.params]);
    check('read-all as an sitenex-only user marks exactly 1 row', upd.rowCount, 1);
    const stillUnread = (await query(`SELECT COUNT(*)::int n FROM notifications WHERE title LIKE $1 AND read_at IS NULL`, [TAG + '%'])).rows[0].n;
    check("the other two stay unread — one click does not clear the org", stillUnread, 2);
  } catch (e) { fail++; console.error('ERROR:', e.message); }
  finally {
    // BY ID — `ids` was already being collected, the cleanup simply was not using it. A title LIKE is a
    // pattern doing the selecting, and a real notification sharing the prefix would be deleted with ours.
    for (const id of ids) await query(`DELETE FROM notifications WHERE id = $1`, [id]).catch(() => {});
    const leaked = ids.length
      ? (await query(`SELECT COUNT(*)::int n FROM notifications WHERE id = ANY($1)`, [ids])).rows[0].n : 0;
    console.log(`\ncleanup: ${ids.length} fixture row(s) deleted, ${leaked} leaked`);
    if (leaked) fail++;
    console.log(fail === 0 ? '\n✅ ALL CHECKS PASSED against the real notifications table' : `\n❌ ${fail} CHECK(S) FAILED`);
    process.exit(fail === 0 ? 0 : 1);
  }
})();
