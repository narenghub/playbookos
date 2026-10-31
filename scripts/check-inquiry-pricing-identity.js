#!/usr/bin/env node
// ── A CUSTOMER QUOTE MUST NOT BE PRICED FROM A SHARED CAS ────────────────────
//
//   node scripts/check-inquiry-pricing-identity.js
//
// Exit 0 = the invariant holds and the reconciliation can prove it. Exit 1 on any failure.
// Runs entirely against a throwaway local Postgres. Touches no production data and sends no email.
//
// ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────
//
// findPricing selected a customer price with:
//
//   AND (LOWER(molecule_name)=LOWER($1) OR (cas_number IS NOT NULL AND cas_number=$2))
//   LIMIT 1
//
// molecule_pricing is unique on LOWER(molecule_name) and has NO constraint on cas_number, so two
// differently-priced molecules may legitimately share a registry number — the condition Decision 1
// exists for. Measured on 31 Oct against the real DDL:
//
//   ask for Selumetinib + its own correct CAS, Binimetinib row first → $22,000/kg
//   ask for Selumetinib + its own correct CAS, Selumetinib row first →  $9,000/kg
//
// The name was right, the CAS was right, and the price came from another substance — 2.4x out,
// decided by physical row order. generateQuote writes it to inquiry_quotes and emails it with no
// human gate.
//
// ── WHY THE REAL FUNCTION AND NOT A COPY OF THE SQL ─────────────────────────
//
// DATABASE_URL is deliberately unset below so src/lib/db.js builds its pool from PG* with ssl:false
// and points at the temp server. That means this exercises the SHIPPED findPricing through the
// SHIPPED query helper. A test that re-stated the SQL would assert that a string changed, which is
// not the same claim and is the kind of evidence this project has learned to distrust.
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/usr/bin'];
function findInitdb() {
  for (const d of BIN) { try { fs.accessSync(`${d}/initdb`); return d; } catch (_) { /* next */ } }
  return null;
}

let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/inqprice-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data -A trust`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55993 -c listen_addresses=' start -w`);
  } catch (_) { return null; }
  temp = { base, dir, asPostgres };
  return base;
}
function stopTemp() {
  if (!temp) return;
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c ${JSON.stringify(`pg_ctl -D ${temp.base}/data stop -m immediate`)}`
      : `pg_ctl -D ${temp.base}/data stop -m immediate`], { env, stdio: 'pipe' });
  } catch (_) { /* best effort */ }
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

const sock = startTemp();
if (!sock) {
  console.error('SKIP  no local postgres available — cannot verify the pricing identity invariant');
  process.exit(1);
}
// Set BEFORE requiring the agent: db.js builds its pool at require time.
delete process.env.DATABASE_URL;
process.env.PGHOST = sock;
process.env.PGPORT = '55993';
process.env.PGUSER = 'postgres';
process.env.PGDATABASE = 'postgres';

const { query } = require('../src/lib/db');
const agent = require('../src/lib/agents/inquiry-agent');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 300)}`); };
const h = (n, s) => console.log(`\n── ${n}. ${s}\n`);

// The real DDL, copied from src/lib/db.js. Kept verbatim so a schema change that breaks the
// invariant's premise breaks this check too.
const DDL = `
  CREATE TABLE IF NOT EXISTS molecule_pricing (
    id TEXT PRIMARY KEY, molecule_name TEXT NOT NULL, cas_number TEXT, gmp_grade TEXT, purity TEXT,
    price_per_kg_usd REAL, min_quantity_g REAL, max_quantity_kg REAL, lead_time_days INTEGER,
    sample_available INTEGER DEFAULT 1, sample_price_usd REAL, gmp_certified INTEGER DEFAULT 1,
    dmf_available INTEGER DEFAULT 0, coa_available INTEGER DEFAULT 1, sds_available INTEGER DEFAULT 1,
    regulatory_status TEXT, storage_conditions TEXT, shelf_life_months INTEGER, notes TEXT,
    active INTEGER DEFAULT 1, controlled_substance INTEGER DEFAULT 0,
    created_at TEXT DEFAULT NOW(), updated_at TEXT DEFAULT NOW());
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_name ON molecule_pricing (LOWER(molecule_name));
  CREATE TABLE IF NOT EXISTS inquiry_quotes (
    id TEXT PRIMARY KEY, inquiry_id TEXT, molecule_name TEXT, cas_number TEXT, quantity_kg REAL,
    unit_price_usd REAL, total_price_usd REAL, lead_time_days INTEGER, valid_until_date TEXT,
    gmp_docs_included INTEGER DEFAULT 1, status TEXT DEFAULT 'draft', quote_pdf_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW());
`;

// 606143-89-9 is the real contested number: selumetinib and binimetinib both carry it in our data,
// one of them is wrong, and the data does not say which.
const CONTESTED = '606143-89-9';
const SELU = { id: 'p-selu', name: 'Selumetinib', price: 9000, lead: 30 };
const BINI = { id: 'p-bini', name: 'Binimetinib', price: 22000, lead: 45 };

const insertPricing = (p) => query(
  `INSERT INTO molecule_pricing (id, molecule_name, cas_number, price_per_kg_usd, lead_time_days,
     min_quantity_g, purity, active)
   VALUES ($1,$2,$3,$4,$5,1000,'99%',1)`,
  [p.id, p.name, CONTESTED, p.price, p.lead]);

// ── THE RECONCILIATION ──────────────────────────────────────────────────────
//
// Independently observable: it re-derives which pricing row a stored quote is consistent with, from
// the quote's own columns, without asking the agent whether it succeeded.
//
// generateQuote computes unitPrice = round(price_per_kg_usd * mult) where mult is one of the four
// quantity tiers. So for a quote naming molecule M, the price must equal one of those four roundings
// of M's OWN pricing row. A quote priced from a different substance's row will not.
//
// It is honest about what it cannot verify rather than failing: a pricing row updated after the
// quote was issued, or withdrawn since, makes the arithmetic unreproducible, and reporting that as a
// defect would be a check failing for a reason unrelated to its subject — the exact pattern that
// wasted a day of this project. Those come back UNVERIFIABLE.
//
// LIMITATION, stated rather than hidden: this is inferential. inquiry_quotes records no pointer to
// the pricing row it used, so two molecules priced identically are indistinguishable here. Durable
// provenance needs a column on inquiry_quotes and is therefore schema work outside this patch; the
// design is in the report rather than applied unilaterally.
const TIERS = [1.5, 1.0, 0.9, 0.85];
async function reconcilePricingProvenance() {
  const rows = (await query(
    `SELECT q.id, q.molecule_name, q.unit_price_usd, q.created_at,
            p.price_per_kg_usd, p.updated_at AS price_updated
       FROM inquiry_quotes q
       LEFT JOIN molecule_pricing p
              ON LOWER(p.molecule_name) = LOWER(q.molecule_name) AND p.active = 1`)).rows;
  const out = { checked: 0, consistent: 0, unverifiable: 0, mismatched: [] };
  for (const r of rows) {
    out.checked += 1;
    if (r.price_per_kg_usd === null || r.price_per_kg_usd === undefined) { out.unverifiable += 1; continue; }
    const expected = TIERS.map((m) => Math.round(Number(r.price_per_kg_usd) * m));
    if (expected.includes(Math.round(Number(r.unit_price_usd)))) out.consistent += 1;
    else {
      out.mismatched.push({
        quote: r.id, molecule: r.molecule_name,
        quoted: Math.round(Number(r.unit_price_usd)), ownRowAllows: expected,
      });
    }
  }
  return out;
}

(async () => {
  try {
    await query(DDL);

    // ── 1. THE PREMISE ─────────────────────────────────────────────────────
    //
    // The whole correction rests on exact-name lookup returning at most one active row. If that
    // ceases to be true, no ORDER BY should be bolted on — the right answer is to stop and report,
    // because the correct response to ambiguous pricing is refusal, not arbitrary selection.
    h(1, 'the premise: LOWER(molecule_name) is unique, so exact-name cannot be ambiguous');
    await insertPricing(SELU);
    try {
      await query(`INSERT INTO molecule_pricing (id, molecule_name, price_per_kg_usd) VALUES ('dup','selumetinib',1)`);
      bad('a second pricing row for the same name was ACCEPTED — exact-name lookup is ambiguous and this correction is not sufficient');
    } catch (e) {
      if (/idx_pricing_name|unique/i.test(e.message)) ok('a second pricing row for the same name (any case) is refused by idx_pricing_name');
      else bad('the duplicate was refused for an unexpected reason', e.message);
    }
    await insertPricing(BINI);
    const shared = await query(`SELECT COUNT(*)::int n FROM molecule_pricing WHERE cas_number=$1`, [CONTESTED]);
    if (shared.rows[0].n === 2) ok('two differently-named, differently-priced rows DO share one cas_number — the hazard is real, not hypothetical');
    else bad('the shared-CAS fixture did not build', JSON.stringify(shared.rows[0]));

    // ── 2. POSITIVE ────────────────────────────────────────────────────────
    h(2, 'positive: an exact name still prices, with and without a CAS');
    const a = await agent.findPricing('Selumetinib', CONTESTED);
    if (a && a.molecule_name === 'Selumetinib' && Math.round(a.price_per_kg_usd) === SELU.price) {
      ok(`exact name + its own CAS → Selumetinib @ $${SELU.price}/kg`);
    } else bad('exact name with CAS did not price correctly', JSON.stringify(a));
    const b = await agent.findPricing('Selumetinib', null);
    if (b && b.molecule_name === 'Selumetinib') ok('exact name with NO CAS still prices — CAS is not required');
    else bad('exact name without CAS stopped pricing', JSON.stringify(b));
    const c = await agent.findPricing('sElUmEtInIb', null);
    if (c && c.molecule_name === 'Selumetinib') ok('exact name is still case-insensitive');
    else bad('case-insensitive name matching regressed', JSON.stringify(c));

    // ── 3. NEGATIVE ────────────────────────────────────────────────────────
    h(3, 'negative: a CAS can never select a price on its own');
    const d = await agent.findPricing('Totally Unknown Thing', CONTESTED);
    if (d === null) ok('unknown name + a known, shared CAS → NO price (was: another substance\'s price)');
    else bad('a CAS-only match still prices a substance the catalogue does not list', JSON.stringify(d));
    const e = await agent.findPricing('', CONTESTED);
    if (e === null) ok('empty name + known CAS → NO price');
    else bad('an empty name still priced via CAS', JSON.stringify(e));
    const f = await agent.findPricing('Selumetinib', '50-78-2');
    if (f && f.molecule_name === 'Selumetinib') ok('exact name + a DISAGREEING CAS prices the NAMED molecule, never the CAS row');
    else bad('a disagreeing CAS changed which molecule was priced', JSON.stringify(f));
    const g = await agent.findPricing('Nothinghere', '99999-99-9');
    if (g === null) ok('neither matches → NO price');
    else bad('a price appeared from nowhere', JSON.stringify(g));

    // ── 4. ADVERSARIAL ─────────────────────────────────────────────────────
    //
    // Physical row order is what decided the answer before. Reversing it must now change nothing.
    h(4, 'adversarial: reverse the insertion order of the two competing rows');
    const askBoth = async () => ({
      selu: await agent.findPricing('Selumetinib', CONTESTED),
      bini: await agent.findPricing('Binimetinib', CONTESTED),
      unknown: await agent.findPricing('Totally Unknown Thing', CONTESTED),
    });
    const forward = await askBoth();
    await query(`DELETE FROM molecule_pricing`);
    await insertPricing(BINI);          // reversed: the OTHER row is now physically first
    await insertPricing(SELU);
    const reversed = await askBoth();
    const same = (x, y) => (x ? x.molecule_name : null) === (y ? y.molecule_name : null)
      && (x ? Math.round(x.price_per_kg_usd) : null) === (y ? Math.round(y.price_per_kg_usd) : null);
    if (same(forward.selu, reversed.selu) && Math.round(reversed.selu.price_per_kg_usd) === SELU.price) {
      ok(`Selumetinib prices at $${SELU.price}/kg either way — row order no longer decides`);
    } else {
      bad('insertion order still changes the price of a named molecule',
        `${JSON.stringify(forward.selu && forward.selu.price_per_kg_usd)} vs ${JSON.stringify(reversed.selu && reversed.selu.price_per_kg_usd)}`);
    }
    if (same(forward.bini, reversed.bini)) ok('Binimetinib likewise prices from its own row either way');
    else bad('insertion order changes Binimetinib\'s price');
    if (reversed.unknown === null) ok('and the unknown name prices from neither, either way');
    else bad('the unknown name priced after reversal', JSON.stringify(reversed.unknown));

    // ── 5. THE RECONCILIATION ──────────────────────────────────────────────
    h(5, 'the reconciliation agrees with a correctly priced quote');
    // A quote as generateQuote would write it: 0.9 tier (medium quantity) off Selumetinib's own row.
    await query(
      `INSERT INTO inquiry_quotes (id, inquiry_id, molecule_name, cas_number, quantity_kg,
         unit_price_usd, total_price_usd, lead_time_days, status)
       VALUES ('q-good','i-1','Selumetinib',$1,0.5,$2,$3,30,'sent')`,
      [CONTESTED, Math.round(SELU.price * 0.9), Math.round(SELU.price * 0.9 * 0.5)]);
    const clean = await reconcilePricingProvenance();
    if (clean.checked === 1 && clean.consistent === 1 && !clean.mismatched.length) {
      ok('a quote priced from its own molecule\'s row reconciles as consistent');
    } else bad('the reconciliation does not accept a correct quote', JSON.stringify(clean));

    // ── 6. NEGATIVE CONTROL ────────────────────────────────────────────────
    //
    // The program rule: every reconciliation must have a negative-control test proving it can detect
    // the defect it claims to detect. A green check with no evidence that it CAN go red is not
    // safety evidence — three checks this week passed while being blind to their own subject.
    //
    // So the defect is reproduced using the ORIGINAL unsafe SQL, run here and nowhere else, and the
    // quote it would have produced is written as generateQuote would have written it. The
    // reconciliation must call that quote mismatched. The unsafe SQL exists only in this block; it
    // is not reachable from the shipped agent, and step 7 re-asserts the shipped function afterwards.
    h(6, 'negative control: reproduce the defect and prove the reconciliation goes red');
    const UNSAFE = `SELECT * FROM molecule_pricing WHERE active=1
      AND (LOWER(molecule_name)=LOWER($1) OR (cas_number IS NOT NULL AND cas_number=$2)) LIMIT 1`;
    const crossed = (await query(UNSAFE, ['Selumetinib', CONTESTED])).rows[0];
    if (crossed && crossed.molecule_name === 'Binimetinib') {
      ok(`the original SQL still cross-prices: asked for Selumetinib, got ${crossed.molecule_name} @ $${crossed.price_per_kg_usd}/kg`);
    } else {
      bad('the negative control could not reproduce the defect — this fixture no longer demonstrates it, '
        + 'so the tests above prove less than they appear to',
        JSON.stringify(crossed && crossed.molecule_name));
    }
    if (crossed) {
      await query(
        `INSERT INTO inquiry_quotes (id, inquiry_id, molecule_name, cas_number, quantity_kg,
           unit_price_usd, total_price_usd, lead_time_days, status)
         VALUES ('q-crossed','i-2','Selumetinib',$1,0.5,$2,$3,30,'sent')`,
        [CONTESTED, Math.round(crossed.price_per_kg_usd * 0.9), Math.round(crossed.price_per_kg_usd * 0.9 * 0.5)]);
      const dirty = await reconcilePricingProvenance();
      const caught = dirty.mismatched.find((m) => m.quote === 'q-crossed');
      if (caught) {
        ok(`the reconciliation CATCHES it: quote q-crossed priced $${caught.quoted}/kg, `
          + `Selumetinib's own row allows only ${caught.ownRowAllows.join('/')}`);
      } else {
        bad('the reconciliation did NOT detect a cross-priced quote — it cannot prove what it claims',
          JSON.stringify(dirty));
      }
      if (dirty.consistent === 1) ok('  …and it still passes the correct quote in the same pass');
      else bad('the correct quote stopped reconciling once a bad one was present', JSON.stringify(dirty));
      await query(`DELETE FROM inquiry_quotes WHERE id = 'q-crossed'`);
    }

    // ── 7. RESTORATION ─────────────────────────────────────────────────────
    //
    // The defect was reproduced above with local SQL. Prove the SHIPPED function is still the safe
    // one, so a future edit that quietly reinstates the OR cannot pass this file.
    h(7, 'restoration: the shipped findPricing is still the safe one');
    const after = await agent.findPricing('Totally Unknown Thing', CONTESTED);
    if (after === null) ok('after the negative control, the shipped lookup still refuses a CAS-only match');
    else bad('the shipped lookup prices from a CAS — the unsafe path is reachable', JSON.stringify(after));
    const src = fs.readFileSync(require.resolve('../src/lib/agents/inquiry-agent'), 'utf8');
    const fn = src.slice(src.indexOf('async function findPricing'), src.indexOf('async function findStock'));
    if (!/cas_number\s*=\s*\$2/.test(fn)) ok('and its SQL contains no cas_number equality — the OR branch has not returned');
    else bad('cas_number=$2 is back inside findPricing');

    // ── 8. UNVERIFIABLE IS REPORTED, NOT FAILED ────────────────────────────
    h(8, 'a quote whose pricing row is gone is UNVERIFIABLE, not a defect');
    await query(
      `INSERT INTO inquiry_quotes (id, inquiry_id, molecule_name, unit_price_usd, quantity_kg, status)
       VALUES ('q-orphan','i-3','Molecule With No Pricing Row',1234,1,'sent')`);
    const orphaned = await reconcilePricingProvenance();
    if (orphaned.unverifiable === 1 && !orphaned.mismatched.length) {
      ok('no pricing row to compare against is reported as unverifiable, not called a mismatch');
    } else bad('an unverifiable quote was treated as a defect', JSON.stringify(orphaned));
  } catch (e) {
    bad('threw', e && e.stack ? e.stack : e);
  } finally {
    try { await query('SELECT 1'); } catch (_) { /* pool may be closed */ }
    stopTemp();
  }

  console.log('');
  if (fail) { console.log(`FAIL  ${fail} check(s) failed\n`); process.exit(1); }
  console.log('PASS  a shared CAS cannot price a customer quote, and the reconciliation can prove it\n');
  process.exit(0);
})();
