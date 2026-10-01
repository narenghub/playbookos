// ── PARTNER-SCOPED OUTREACH: partner A must never see partner B's status or notes ──
//
// Until now outreach was INTERNAL and gated with staffOnly, on the stated grounds that "outreach rows have no
// partner_id, and giving them one would assert that an outreach note belongs to a partner rather than to us,
// which is the opposite of true."
//
// THAT WAS TRUE WHILE PARTNERS COULD NOT WORK A PROSPECT. From 2026-10-01 they can: a partner holds a
// territory and sees the prospects in it. A partner who rings a business and cannot record the call has to
// keep that record somewhere else, which means it is lost to us and to them. So an outreach row CAN belong to
// a partner — their call, their note — and the question becomes keeping A's out of B's sight.
//
// ── ONE ROW PER (ENTITY, PARTNER), NOT ONE PER ENTITY ─────────────────────────
//
// The old key was UNIQUE (entity_type, entity_id): one outreach record per prospect, full stop. That cannot
// survive two partners, and not only in the overlap case — with one shared record, A's write would be B's
// read. Territory exclusivity makes overlap rare but non-exclusive territories are explicitly allowed, and
// "rare" is not "never".
//
// So the key becomes (entity_type, entity_id, partner_id), with NULL meaning OURS.
//
// AND IT HAS TO BE AN EXPRESSION INDEX. A plain UNIQUE (entity_type, entity_id, partner_id) would NOT hold
// the staff invariant, because Postgres treats NULLs as DISTINCT in a unique index — two staff rows for the
// same prospect would both be accepted, and summary() plus every ON CONFLICT depends on there being one.
// COALESCE(partner_id, 0) makes NULL a value. 0 is never a real partners.id (SERIAL starts at 1).
//
// BACKFILL: every one of the 5 existing rows is a staff-written Abiozen study with no partner anywhere near
// it, so partner_id NULL is the correct value and a fact rather than a guess. The column is added nullable
// with no default, so nothing is invented for them.
//
// IDEMPOTENT. Safe to re-run.
//
// Manual rollback (loses the per-partner distinction, so only if the feature is abandoned):
//   DROP INDEX IF EXISTS uq_outreach_entity_partner;
//   ALTER TABLE outreach ADD CONSTRAINT outreach_entity_type_entity_id_key UNIQUE (entity_type, entity_id);
//   ALTER TABLE outreach DROP COLUMN IF EXISTS partner_id;
//
// Run:  railway ssh 'node scripts/migrate-outreach-partner-scope.js'

const { query, withTransaction } = require('../src/lib/db');

(async () => {
  try {
    await query(`ALTER TABLE outreach ADD COLUMN IF NOT EXISTS partner_id INTEGER REFERENCES partners(id)`);
    await query(`COMMENT ON COLUMN outreach.partner_id IS $c$Whose outreach record this is. NULL = OURS (staff). Set from the ACTING USER's users.partner_id, never from a request. A partner sees only rows where this matches theirs; staff see all of them. Added 2026-10-01 when partners began working prospects in their own territory — before that an outreach note could only be ours, which is why the routes were staffOnly instead.$c$`);
    console.log('✅ outreach.partner_id');

    // THE KEY CHANGE. Done in one transaction: between dropping the old constraint and creating the new index
    // there is no uniqueness at all, and a concurrent write in that window would leave a duplicate that the
    // CREATE UNIQUE INDEX then refuses — failing the migration with a confusing error about existing data.
    const hasOld = (await query(
      `SELECT COUNT(*)::int n FROM pg_constraint WHERE conname = 'outreach_entity_type_entity_id_key'`)).rows[0].n > 0;
    const hasNew = (await query(
      `SELECT COUNT(*)::int n FROM pg_indexes WHERE indexname = 'uq_outreach_entity_partner'`)).rows[0].n > 0;

    if (hasNew && !hasOld) {
      console.log('↷  the per-partner key is already in place');
    } else {
      await withTransaction(async (c) => {
        if (hasOld) {
          await c.query(`ALTER TABLE outreach DROP CONSTRAINT outreach_entity_type_entity_id_key`);
          console.log('✅ dropped UNIQUE (entity_type, entity_id)');
        }
        await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_outreach_entity_partner
                       ON outreach (entity_type, entity_id, COALESCE(partner_id, 0))`);
        console.log('✅ created UNIQUE (entity_type, entity_id, COALESCE(partner_id, 0))');
      });
    }

    await query(`CREATE INDEX IF NOT EXISTS idx_outreach_partner ON outreach (partner_id) WHERE partner_id IS NOT NULL`);

    // ── verification ──────────────────────────────────────────────────────────
    console.log('\nverification:');
    const col = (await query(`SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_name='outreach' AND column_name='partner_id'`)).rows[0];
    console.log(`  outreach.partner_id: ${col.data_type}, nullable=${col.is_nullable}, default=${col.column_default}`);
    if (col.is_nullable !== 'YES') throw new Error('partner_id must be NULLABLE — NULL is how "ours" is expressed');
    if (col.column_default) throw new Error('no default: a row must say whose it is, not inherit one');

    const idx = (await query(`SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename='outreach' AND indexdef ILIKE '%UNIQUE%' ORDER BY indexname`)).rows;
    idx.forEach(i => console.log(`  ${i.indexdef.replace(' USING btree', '')}`));
    const uq = idx.find(i => i.indexname === 'uq_outreach_entity_partner');
    if (!uq) throw new Error('the per-partner unique index is missing');
    if (!/COALESCE/i.test(uq.indexdef)) {
      throw new Error('the index must use COALESCE(partner_id, 0) — a plain 3-column UNIQUE lets two staff rows coexist');
    }
    if (idx.some(i => i.indexname === 'outreach_entity_type_entity_id_key')) {
      throw new Error('the old entity-only UNIQUE still exists, so one prospect still means one record');
    }

    const rows = (await query(
      `SELECT COUNT(*)::int total, COUNT(partner_id)::int with_partner FROM outreach`)).rows[0];
    console.log(`  rows: ${rows.total} total, ${rows.with_partner} with a partner (the rest are ours)`);

    // PROVE BOTH HALVES OF THE KEY, in a rolled-back transaction so nothing is written.
    //   • two STAFF rows for one entity are still refused (the old invariant, which COALESCE preserves)
    //   • two DIFFERENT partners for one entity are ALLOWED (the new capability)
    const probe = await (async () => {
      const out = {};
      try {
        await withTransaction(async (c) => {
          const mk = async (partnerId) => c.query(
            `INSERT INTO outreach (entity_type, entity_id, product, status, partner_id, created_at, updated_at)
             VALUES ('prospect','__probe__','sitenex','contacted',$1,NOW(),NOW())`, [partnerId]);
          await mk(null);
          try { await mk(null); out.twoStaff = 'REFUSED'; } catch (e) { out.twoStaff = 'REFUSED'; throw { probe: out, inner: e }; }
        });
      } catch (e) {
        if (e && e.probe) out.twoStaff = 'REFUSED';
        else out.twoStaff = 'ALLOWED(!)';
      }
      try {
        await withTransaction(async (c) => {
          const a = (await c.query(`INSERT INTO partners (name) VALUES ('__probe P1__')
                                    ON CONFLICT (name) DO UPDATE SET status='active' RETURNING id`)).rows[0].id;
          const b = (await c.query(`INSERT INTO partners (name) VALUES ('__probe P2__')
                                    ON CONFLICT (name) DO UPDATE SET status='active' RETURNING id`)).rows[0].id;
          for (const p of [a, b]) {
            await c.query(
              `INSERT INTO outreach (entity_type, entity_id, product, status, partner_id, created_at, updated_at)
               VALUES ('prospect','__probe2__','sitenex','contacted',$1,NOW(),NOW())`, [p]);
          }
          out.twoPartners = 'ALLOWED';
          throw new Error('__rollback__');
        });
      } catch (e) {
        if (!/__rollback__/.test(e.message || '')) out.twoPartners = 'REFUSED(!) — ' + e.message.slice(0, 70);
      }
      return out;
    })();
    console.log(`  two STAFF rows for one entity: ${probe.twoStaff} (must be REFUSED)`);
    console.log(`  two PARTNERS for one entity:   ${probe.twoPartners} (must be ALLOWED)`);
    if (probe.twoStaff !== 'REFUSED') throw new Error('two staff rows for one entity were accepted');
    if (probe.twoPartners !== 'ALLOWED') throw new Error('two partners could not both hold a record: ' + probe.twoPartners);

    const leftover = (await query(
      `SELECT COUNT(*)::int n FROM outreach WHERE entity_id LIKE '__probe%'`)).rows[0].n
      + (await query(`SELECT COUNT(*)::int n FROM partners WHERE name LIKE '__probe %__'`)).rows[0].n;
    console.log(`  probe rows left behind: ${leftover} (must be 0 — the probes roll back)`);
    if (leftover) throw new Error('a probe leaked rows');

    console.log('\n✅ DONE');
    process.exit(0);
  } catch (e) { console.error('❌', e.message); process.exit(1); }
})();
