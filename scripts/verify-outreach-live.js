// ── OUTREACH, live and self-cleaning ──────────────────────────────────────────
//
// Against the REAL tables, with real prospect ids, two products and two people — because the properties
// that matter are all about telling things apart: one product's rows from another's, one person's activity
// from another's, and tracked rows from the 1,524 that are implicitly 'not_contacted'.
//
// Everything written here is deleted in the finally, with a leak check.
//
// Run:  railway ssh 'node scripts/verify-outreach-live.js'

const { query } = require('../src/lib/db');
const outreach = require('../src/lib/outreach');
const { STATUSES, CHANNELS } = require('../src/lib/outreach/registry');
// WHOSE VIEW THIS IS. The module THROWS without it rather than defaulting, which is how it caught this
// script: every read here is staff's, and saying so is one word per call against a partner seeing
// another partner's notes.
const OURS = { isStaff: true };

let fail = 0, touched = [], dealIds = [];
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
    const mark = async (u, type, id, status, note, channel = null) => {
      const r = await outreach.setStatus({ entityType: type, entityId: id, status, note, channel, user: u, held: STAFF });
      if (r.ok) touched.push([type, String(id)]);
      // A silently refused write is how this script previously reported nine stale failures and no cause:
      // it wrote 'interested', the new validation refused it, and every later assertion measured the absence.
      if (!r.ok) throw new Error(`write refused: ${r.code} — ${r.error}`);
      return r;
    };
    console.log(`fixtures: prospects ${gn.map(r=>r.id).join(',')} (golfnex), ${sx[0].id} (sitenex), institution ${inst[0].id}`);
    console.log(`people:   ${vin.email} and ${nar.email}\n`);

    console.log('0. THE REGISTRY AGREES WITH THE DATABASE');
    // Every idCast against the real column type. This is the check that cannot be a unit test: a fake with
    // numeric ids satisfies 'bigint' and 'text' alike, so the mismatch only shows against Postgres — where
    // casting a uuid to bigint throws and every write for that entity type returns 400.
    const { ENTITIES } = require('../src/lib/outreach/registry');
    for (const [type, def] of Object.entries(ENTITIES)) {
      const col = (await query(
        `SELECT data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = 'id'`,
        [def.table])).rows[0];
      check(`${type}: ${def.table}.id is ${def.idCast}`, col && col.data_type, def.idCast);
    }

    console.log('\n1. WRITE — status + event, product read from the row');
    const a = await mark(vin, 'prospect', gn[0].id, 'contacted', 'called, left a message');
    check('a golfnex prospect is recorded', [a.ok, a.from, a.to], [true, 'not_contacted', 'contacted']);
    check('and the product came from the row', a.row.product, 'golfnex');
    const b = await mark(vin, 'prospect', gn[1].id, 'contacted');
    const c = await mark(vin, 'prospect', gn[0].id, 'quote_sent', 'wants a quote', 'email');
    check('a second change reports the real transition', [c.from, c.to], ['contacted', 'quote_sent']);
    check('  and carries the CHANNEL, on the row and the event', c.channel, 'email');
    const d = await mark(nar, 'prospect', sx[0].id, 'won');
    check('a sitenex prospect too', d.row.product, 'sitenex');
    // 'won' on a sitenex prospect CREATES A DEAL, and this script used to walk away from it: every run
    // left a fabricated row on the deals board. Recorded so the finally can remove it by id.
    if (d.deal && d.deal.id) dealIds.push(d.deal.id);
    const e = await mark(nar, 'institution', inst[0].id, 'contacted');
    check('an institution takes its product from the registry', e.row.product, 'abiozen');

    console.log('\n2. THE EVENT LOG answers the question status cannot');
    const act = await outreach.activity({ held: STAFF, partner: OURS, sinceDays: 1 });
    const V = act.people.find(p => p.user_id === vin.id);
    const N = act.people.find(p => p.user_id === nar.id);
    check(`${vin.email}: 3 changes`, V && V.total, 3);
    console.log(`     reported as "${V && V.person}" — activity() uses the display NAME, not the email`);
    check('  broken down by status', V && V.by_status, { contacted: 2, quote_sent: 1 });
    // channel is a second axis: two of these touches had none recorded, and that is a fact, not a gap.
    check('  and by CHANNEL, counting the unrecorded', V && V.by_channel, { '(not recorded)': 2, email: 1 });
    check('the second person: 2 changes', N && N.total, 2);
    // ORDERED, not FIRST. "Busiest overall" is a claim about everybody's activity, and the table is live now —
    // a real user wrote 10 events today, which legitimately outranks three fixture touches. The property under
    // test is that the list is sorted by volume; asserting who tops it was asserting that nobody else works here.
    const mine = act.people.filter(x => x.user_id === vin.id || x.user_id === nar.id);
    check('both fixture people appear', mine.length, 2);
    check('  and the busier of the two is listed first',
          act.people.findIndex(x => x.user_id === vin.id) < act.people.findIndex(x => x.user_id === nar.id), true);
    const totals = act.people.map(x => x.total);
    check('  the whole list is sorted by volume',
          totals.every((n, i) => i === 0 || totals[i - 1] >= n), true);

    console.log('\n3. THE SUMMARY BAR adds the implicit new');
    const total = (await query(`SELECT COUNT(*)::int n FROM prospects WHERE product='golfnex'`)).rows[0].n;
    const s = await outreach.summary('prospect', { held: STAFF, partner: OURS, totalEntities: total, product: 'golfnex' });
    check('golfnex: 1 contacted', s.counts.contacted, 1);
    check('golfnex: 1 quote_sent', s.counts.quote_sent, 1);
    // The bar has to read as a funnel, so the ORDER is part of the contract, not a presentation detail.
    check('the bar comes back in funnel order', Object.keys(s.counts).slice(0, 3),
          ['not_contacted', 'contacted', 'following_up']);
    check(`golfnex: the rest of ${total} are not_contacted`, s.counts.not_contacted, total - 2);
    check('every row is accounted for', Object.values(s.counts).reduce((x, y) => x + y, 0), total);

    console.log('\n4. SCOPING — inherited, not reinvented');
    const gnOnly = await outreach.statusFor('prospect', [gn[0].id, sx[0].id], ['golfnex'], OURS);
    check('a golfnex-only holder cannot see the sitenex row', Object.keys(gnOnly), [String(gn[0].id)]);
    const refused = await outreach.setStatus({ entityType: 'prospect', entityId: sx[0].id, status: 'contacted',
      user: vin, held: ['golfnex'] });
    check('and cannot write to it either', refused.code, 'product_not_held');
    const actScoped = await outreach.activity({ held: ['golfnex'], partner: OURS, sinceDays: 1 });
    check('activity is scoped too', actScoped.people.reduce((x, p) => x + p.total, 0), 3);

    console.log('\n5. prospects.status UNTOUCHED — it is qualification, not outreach');
    const q = (await query(`SELECT status FROM prospects WHERE id=$1`, [gn[0].id])).rows[0].status;
    check(`prospect ${gn[0].id}.status is still its qualifier verdict`, ['new','qualified','rejected'].includes(q), true);
    console.log(`     (it reads '${q}', while its outreach status is 'quote_sent')`);

    console.log('\n6. the vocabulary is a comment, not a constraint');
    const bad = await outreach.setStatus({ entityType: 'prospect', entityId: gn[0].id, status: 'nurture', user: vin, held: STAFF });
    check("'nurture' refused by the API", bad.code, 'unknown_status');
    const comment = (await query(`SELECT col_description('outreach'::regclass, ordinal_position) d
      FROM information_schema.columns WHERE table_name='outreach' AND column_name='status'`)).rows[0].d;
    // Asserted as the FUNNEL, not as a list: the comment documents each status beside its sort_order, so
    // the next reader of the column learns the order and not just the vocabulary. A pipe-separated list
    // (what this used to look for) would satisfy "all 10 are named" while losing the only part that is
    // hard to rediscover.
    const { STATUS_DEFS } = require('../src/lib/outreach/registry');
    const undocumented = STATUS_DEFS.filter(d => !new RegExp(`${d.order}\\s+${d.key}\\b`).test(comment || ''));
    check('and documented on the column, each status beside its sort_order',
          undocumented.map(d => d.key), []);
    check('all 10 named in it', STATUSES.every(x => comment.includes(x)), true);
    const chanComment = (await query(`SELECT col_description('outreach'::regclass, a.attnum) d
      FROM pg_attribute a WHERE a.attrelid='outreach'::regclass AND a.attname='channel'`)).rows[0].d;
    check('channel is documented separately, as its own axis',
          CHANNELS.every(x => (chanComment || '').includes(x)), true);
  } catch (err) { fail++; console.error('ERROR:', err.message); }
  finally {
    for (const [type, id] of touched) {
      await query(`DELETE FROM outreach WHERE entity_type=$1 AND entity_id=$2`, [type, id]).catch(() => {});
    }
    // BY ID, never by a time window. A `created_at > NOW() - INTERVAL '10 minutes'` sweep would delete a
    // deal a person had just closed, and this runs against production.
    for (const id of dealIds) {
      await query(`DELETE FROM sitenex_deals WHERE id = $1`, [id]).catch(() => {});
    }
    // Checked as "my own rows are gone", not as "the tables are empty". Emptiness is true today and will
    // stop being true the first time somebody records real outreach, at which point a script that demands
    // it fails forever and gets fixed by widening the DELETE — which is how a verification starts deleting
    // real data.
    let mine = 0;
    for (const [type, id] of touched) {
      mine += (await query(
        `SELECT COUNT(*)::int n FROM outreach WHERE entity_type=$1 AND entity_id=$2`, [type, id])).rows[0].n;
    }
    const leftD = dealIds.length
      ? (await query(`SELECT COUNT(*)::int n FROM sitenex_deals WHERE id = ANY($1)`, [dealIds])).rows[0].n : 0;
    const leftO = (await query(`SELECT COUNT(*)::int n FROM outreach`)).rows[0].n;
    const leftE = (await query(`SELECT COUNT(*)::int n FROM outreach_events`)).rows[0].n;
    console.log(`\ncleanup: ${touched.length} row(s) and ${dealIds.length} deal(s) removed; ` +
                `${mine} + ${leftD} of mine remain. Table now holds ${leftO} outreach / ${leftE} events.`);
    if (mine !== 0 || leftD !== 0) fail++;
    console.log(fail === 0 ? '\n✅ ALL CHECKS PASSED — one outreach system, scoped, with a real event log'
                           : `\n❌ ${fail} CHECK(S) FAILED`);
    process.exit(fail === 0 ? 0 : 1);
  }
})();
