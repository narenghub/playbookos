// ── OUTREACH, live and self-cleaning ──────────────────────────────────────────
//
// Against the REAL tables, with real prospect ids, two products and two people — because the properties
// that matter are all about telling things apart: one product's rows from another's, one person's activity
// from another's, and tracked rows from the 1,524 that are implicitly 'new'.
//
// Everything written here is deleted in the finally, with a leak check.
//
// Run:  railway ssh 'node scripts/verify-outreach-live.js'

const { query } = require('../src/lib/db');
const outreach = require('../src/lib/outreach');
const { STATUSES } = require('../src/lib/outreach/registry');

let fail = 0, touched = [];
const check = (l, a, e) => { const ok = JSON.stringify(a) === JSON.stringify(e);
  if (!ok) fail++; console.log(`  ${ok ? '✅' : '❌'} ${l}${ok ? '' : `  → expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`}`); };

(async () => {
  try {
    const STAFF = ['abiozen', 'golfnex', 'favly', 'linkabl', 'aros', 'sitenex', 'internal'];
    const gn = (await query(`SELECT id FROM prospects WHERE product='golfnex' ORDER BY id LIMIT 2`)).rows;
    const sx = (await query(`SELECT id FROM prospects WHERE product='sitenex' ORDER BY id LIMIT 1`)).rows;
    const inst = (await query(`SELECT id FROM research_institutions ORDER BY id LIMIT 1`)).rows;
    if (gn.length < 2 || !sx.length || !inst.length) throw new Error('not enough real rows to test with');
    // REAL user ids: outreach.owner_user_id has a foreign key to users, so invented ids are rejected —
    // which is the schema working, and worth knowing before the first partner account records anything.
    const people = (await query(`SELECT id, email FROM users WHERE is_active=1 ORDER BY email LIMIT 2`)).rows;
    if (people.length < 2) throw new Error('need two real users to tell two people apart');
    const [vin, nar] = people;
    const mark = async (u, type, id, status, note) => {
      const r = await outreach.setStatus({ entityType: type, entityId: id, status, note, user: u, held: STAFF });
      if (r.ok) touched.push([type, String(id)]);
      return r;
    };
    console.log(`fixtures: prospects ${gn.map(r=>r.id).join(',')} (golfnex), ${sx[0].id} (sitenex), institution ${inst[0].id}`);
    console.log(`people:   ${vin.email} and ${nar.email}\n`);

    console.log('1. WRITE — status + event, product read from the row');
    const a = await mark(vin, 'prospect', gn[0].id, 'contacted', 'called, left a message');
    check('a golfnex prospect is recorded', [a.ok, a.from, a.to], [true, 'new', 'contacted']);
    check('and the product came from the row', a.row.product, 'golfnex');
    const b = await mark(vin, 'prospect', gn[1].id, 'contacted');
    const c = await mark(vin, 'prospect', gn[0].id, 'interested', 'wants a quote');
    check('a second change reports the real transition', [c.from, c.to], ['contacted', 'interested']);
    const d = await mark(nar, 'prospect', sx[0].id, 'won');
    check('a sitenex prospect too', d.row.product, 'sitenex');
    const e = await mark(nar, 'institution', inst[0].id, 'contacted');
    check('an institution takes its product from the registry', e.row.product, 'abiozen');

    console.log('\n2. THE EVENT LOG answers the question status cannot');
    const act = await outreach.activity({ held: STAFF, sinceDays: 1 });
    const V = act.people.find(p => p.user_id === vin.id);
    const N = act.people.find(p => p.user_id === nar.id);
    check(`${vin.email}: 3 changes`, V && V.total, 3);
    console.log(`     reported as "${V && V.person}" — activity() uses the display NAME, not the email`);
    check('  broken down by status', V && V.by_status, { contacted: 2, interested: 1 });
    check('the second person: 2 changes', N && N.total, 2);
    check('busiest person first', act.people[0].user_id, vin.id);

    console.log('\n3. THE SUMMARY BAR adds the implicit new');
    const total = (await query(`SELECT COUNT(*)::int n FROM prospects WHERE product='golfnex'`)).rows[0].n;
    const s = await outreach.summary('prospect', { held: STAFF, totalEntities: total, product: 'golfnex' });
    check('golfnex: 1 contacted', s.counts.contacted, 1);
    check('golfnex: 1 interested', s.counts.interested, 1);
    check(`golfnex: the rest of ${total} are new`, s.counts.new, total - 2);
    check('every row is accounted for', Object.values(s.counts).reduce((x, y) => x + y, 0), total);

    console.log('\n4. SCOPING — inherited, not reinvented');
    const gnOnly = await outreach.statusFor('prospect', [gn[0].id, sx[0].id], ['golfnex']);
    check('a golfnex-only holder cannot see the sitenex row', Object.keys(gnOnly), [String(gn[0].id)]);
    const refused = await outreach.setStatus({ entityType: 'prospect', entityId: sx[0].id, status: 'contacted',
      user: vin, held: ['golfnex'] });
    check('and cannot write to it either', refused.code, 'product_not_held');
    const actScoped = await outreach.activity({ held: ['golfnex'], sinceDays: 1 });
    check('activity is scoped too', actScoped.people.reduce((x, p) => x + p.total, 0), 3);

    console.log('\n5. prospects.status UNTOUCHED — it is qualification, not outreach');
    const q = (await query(`SELECT status FROM prospects WHERE id=$1`, [gn[0].id])).rows[0].status;
    check(`prospect ${gn[0].id}.status is still its qualifier verdict`, ['new','qualified','rejected'].includes(q), true);
    console.log(`     (it reads '${q}', while its outreach status is 'interested')`);

    console.log('\n6. the vocabulary is a comment, not a constraint');
    const bad = await outreach.setStatus({ entityType: 'prospect', entityId: gn[0].id, status: 'nurture', user: vin, held: STAFF });
    check("'nurture' refused by the API", bad.code, 'unknown_status');
    const comment = (await query(`SELECT col_description('outreach'::regclass, ordinal_position) d
      FROM information_schema.columns WHERE table_name='outreach' AND column_name='status'`)).rows[0].d;
    check('and documented on the column', /new \| contacted/.test(comment || ''), true);
    check('all 8 named in it', STATUSES.every(x => comment.includes(x)), true);
  } catch (err) { fail++; console.error('ERROR:', err.message); }
  finally {
    for (const [type, id] of touched) {
      await query(`DELETE FROM outreach WHERE entity_type=$1 AND entity_id=$2`, [type, id]).catch(() => {});
    }
    const leftO = (await query(`SELECT COUNT(*)::int n FROM outreach`)).rows[0].n;
    const leftE = (await query(`SELECT COUNT(*)::int n FROM outreach_events`)).rows[0].n;
    console.log(`\ncleanup: outreach ${leftO} rows, outreach_events ${leftE} rows (events cascade with their row)`);
    if (leftO !== 0 || leftE !== 0) fail++;
    console.log(fail === 0 ? '\n✅ ALL CHECKS PASSED — one outreach system, scoped, with a real event log'
                           : `\n❌ ${fail} CHECK(S) FAILED`);
    process.exit(fail === 0 ? 0 : 1);
  }
})();
