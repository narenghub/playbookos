// ── THE SEAM REFUSES PRODUCTION, AND REFUSES THE TWO ABUSES BY NAME ─────────
//
//   node --test src/lib/office/business-day-override.test.js
//
// B3.20, owner's Priority 5 of 2026-11-25. The flag is useful for acceptance testing and must not
// let a production caller bypass objective scheduling, replay a historical business day, or create
// a future-dated unauthorized run. Each of those is asserted here as its own refusal, because a
// single "it refused" assertion cannot tell which condition did the work — and a condition that is
// never the deciding one is decoration.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const OVERRIDE = require('./business-day-override');
const DI = require('../../../scripts/lib/db-identity');

const DEV = async () => ({ verdict: DI.VERDICT.DEVELOPMENT, findings: [], tables: [] });
const PROD = async () => ({
  verdict: DI.VERDICT.PRODUCTION_FINGERPRINT,
  findings: ['orders exists and contains data'], tables: [],
});
const UNKNOWN = async () => ({
  verdict: DI.VERDICT.CANNOT_TELL, findings: [], tables: [],
  detail: 'the table list could not be read',
});

// A fixed clock, so "today" is a fact in this file rather than whatever day it is run on.
const NOW = new Date('2026-11-25T18:00:00Z');          // 12:00 Chicago on 2026-11-25
const TODAY = '2026-11-25';
const TOMORROW = '2026-11-26';

// The default query answers `SHOW data_directory` as a NON-disposable server, so each test below
// says which signal it is exercising rather than inheriting a permissive default.
const notDisposable = async () => ({ rows: [{ data_directory: '/var/lib/postgresql/18/main' }] });
const ask = (day, over = {}) => OVERRIDE.authorizeBusinessDayOverride(day, {
  env: {}, now: NOW, identify: DEV, query: notDisposable, ...over,
});

// ═══ 1. THE PERMITTED CASE, SO THE REFUSALS BELOW MEAN SOMETHING ═══════════

test('1. today is permitted in a development environment on a development database', async () => {
  const r = await ask(TODAY);
  assert.strictEqual(r.allowed, true, r.detail);
  assert.strictEqual(r.day, TODAY);
});

test('1a. and tomorrow is too — which is the whole reason the flag exists', async () => {
  // Two consecutive business days cannot be demonstrated by waiting, and a run's intent key is
  // immutable, so the acceptance check needs exactly this one step forward and nothing more.
  const r = await ask(TOMORROW);
  assert.strictEqual(r.allowed, true, r.detail);
  assert.deepStrictEqual(r.window, [TODAY, TOMORROW]);
});

// ═══ 2. PRODUCTION REFUSAL — VERIFIED, NOT DESCRIBED ══════════════════════

test('2. DECISIVE: NODE_ENV=production refuses, before any database work', async () => {
  const r = await OVERRIDE.authorizeBusinessDayOverride(TODAY, {
    env: { NODE_ENV: 'production' },
    now: NOW,
    // A thrower: if this is consulted the environment check did not come first, and the order
    // matters — an obviously-production process must stop before it touches anything.
    identify: async () => { throw new Error('the database was inspected after NODE_ENV=production'); },
  });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, OVERRIDE.REFUSAL.PRODUCTION_ENV);
});

test('2a. DECISIVE: a production-fingerprinted database refuses even outside production', async () => {
  // The condition that an environment variable cannot be wrong about. `NODE_ENV` unset and the
  // database carrying production's fingerprint is exactly the shape of a developer pointed at the
  // wrong DATABASE_URL.
  const r = await ask(TODAY, { identify: PROD });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, OVERRIDE.REFUSAL.NOT_DEVELOPMENT_DB);
  assert.match(r.detail, /orders exists and contains data/);
});

test('2b. an UNKNOWABLE database is a refusal, never permission', async () => {
  const r = await ask(TODAY, { identify: UNKNOWN });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, OVERRIDE.REFUSAL.DB_UNKNOWABLE);
});

test('2c. and an inspection that THROWS is a refusal too', async () => {
  const r = await ask(TODAY, { identify: async () => { throw new Error('connection refused'); } });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, OVERRIDE.REFUSAL.DB_UNKNOWABLE);
  assert.match(r.detail, /an outage is not a development environment/);
});

// ═══ 2d. THE SECOND POSITIVE SIGNAL, AND ITS LIMITS ══════════════════════

const UNIDENTIFIED = async () => ({
  verdict: DI.VERDICT.UNIDENTIFIED, findings: [], tables: ['objectives', 'office_plans'],
  detail: '2 table(s) that are neither empty nor part of M7',
});

test('2d. an `unidentified` database is permitted ONLY if it is a disposable test cluster', async () => {
  // Why this exists: db-identity's POSITIVE identification is tailored to the M7 worker subsystem,
  // so a cluster holding the office kernel's own tables reads `unidentified`. That is correct for
  // that check, and widening it is what its own refusal text warns against. The second signal is
  // the server's OWN data_directory sitting under the prefix pg-disposable creates clusters with —
  // throwaway by construction, and independent of what rows exist.
  const { PREFIX } = require('../../../scripts/lib/pg-disposable');
  const disposable = async (sql) => {
    assert.strictEqual(sql, 'SHOW data_directory');
    return { rows: [{ data_directory: `/tmp/${PREFIX}unatt-AbC123/data` }] };
  };
  const r = await ask(TODAY, { identify: UNIDENTIFIED, query: disposable });
  assert.strictEqual(r.allowed, true, r.detail);
});

test('2e. DECISIVE: `unidentified` on a NON-disposable cluster refuses', async () => {
  const elsewhere = async () => ({ rows: [{ data_directory: '/var/lib/postgresql/18/main' }] });
  const r = await ask(TODAY, { identify: UNIDENTIFIED, query: elsewhere });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, OVERRIDE.REFUSAL.NOT_DEVELOPMENT_DB);
  assert.match(r.detail, /\/var\/lib\/postgresql/);
});

test('2f. and an unreadable data_directory is a NO, not a yes', async () => {
  // `SHOW data_directory` needs superuser or pg_read_all_settings. The production runtime role is
  // NOSUPERUSER by design (ENG-003), so there this query errors — and an error must never be
  // read as permission.
  const refused = async () => { throw new Error('permission denied for SHOW data_directory'); };
  const r = await ask(TODAY, { identify: UNIDENTIFIED, query: refused });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, OVERRIDE.REFUSAL.NOT_DEVELOPMENT_DB);
  assert.match(r.detail, /unreadable/);
});

test('2g. a DISPOSABLE cluster is permitted whatever rows it holds — and this reverses my first answer', async () => {
  // I first asserted the opposite: that a production fingerprint refuses even inside a throwaway
  // cluster. Running it showed why that is the wrong rule FOR THIS SEAM. The acceptance clusters
  // seed an admin user at bootstrap, `users` is one of db-identity's production tables, and so a
  // cluster created seconds earlier reported `production_fingerprint` — the seam refused its own
  // tests. db-identity asks "am I about to act on somebody's real data", which is the right
  // question for the development worker API and the wrong FIRST question here, where the question
  // is "could this possibly be production". A cluster made by pg-disposable answers that by
  // construction: it exists for one run and is destroyed at the end of it. The fingerprint rule is
  // untouched and still decisive for every database that is not one.
  const { PREFIX } = require('../../../scripts/lib/pg-disposable');
  const disposable = async () => ({ rows: [{ data_directory: `/tmp/${PREFIX}x/data` }] });
  const r = await ask(TODAY, { identify: PROD, query: disposable });
  assert.strictEqual(r.allowed, true, r.detail);
});

// ═══ 3. THE TWO ABUSES THE OWNER NAMED, EACH BY NAME ══════════════════════

test('3. DECISIVE: a HISTORICAL business day is refused — no replay', async () => {
  for (const day of ['2026-11-24', '2026-11-01', '2025-11-25']) {
    const r = await ask(day);
    assert.strictEqual(r.allowed, false, `${day} was accepted`);
    assert.strictEqual(r.reason, OVERRIDE.REFUSAL.OUT_OF_WINDOW);
  }
});

test('3a. DECISIVE: a FUTURE-DATED business day beyond tomorrow is refused', async () => {
  for (const day of ['2026-11-27', '2026-12-25', '2027-01-01']) {
    const r = await ask(day);
    assert.strictEqual(r.allowed, false, `${day} was accepted`);
    assert.strictEqual(r.reason, OVERRIDE.REFUSAL.OUT_OF_WINDOW);
  }
});

test('3b. the window is CHICAGO days, not UTC days', async () => {
  // 2026-11-26T04:00:00Z is 22:00 Chicago on the 25th. A UTC reading would call it the 26th and
  // would then permit the 27th as "tomorrow" — a day the Chicago scheduler has not reached. The
  // crons fire in Chicago (B7.23), so the window has to be measured there.
  const lateEvening = new Date('2026-11-26T04:00:00Z');
  assert.strictEqual(OVERRIDE.chicagoDay(lateEvening), '2026-11-25');
  const r = await ask('2026-11-27', { now: lateEvening });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, OVERRIDE.REFUSAL.OUT_OF_WINDOW);
});

test('3c. a malformed day is refused before anything else is consulted', async () => {
  // `2026-13-45` belongs in this list and did NOT start here: it matches four-two-two digits, so
  // the first version of the module let it through the format check and the WINDOW refused it —
  // safe, but for the wrong reason and with a message that would have sent an operator looking at
  // the wrong thing. The module now round-trips the date through Date.UTC, because that call
  // normalises month 13 into January silently.
  for (const day of [undefined, '', 'tomorrow', '2026-13-45', '2026-02-30', '26-11-25',
    '2026-11-25T00:00:00Z']) {
    const r = await OVERRIDE.authorizeBusinessDayOverride(day, {
      env: { NODE_ENV: 'production' }, now: NOW,
      identify: async () => { throw new Error('nothing should be inspected'); },
    });
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.reason, OVERRIDE.REFUSAL.MALFORMED);
  }
});

// ═══ 4. THE ARITHMETIC, BECAUSE A MONTH BOUNDARY IS WHERE THIS BREAKS ══════

test('4. dayAfter crosses months, years and a leap day without timezone drift', () => {
  assert.strictEqual(OVERRIDE.dayAfter('2026-11-30'), '2026-12-01');
  assert.strictEqual(OVERRIDE.dayAfter('2026-12-31'), '2027-01-01');
  assert.strictEqual(OVERRIDE.dayAfter('2028-02-28'), '2028-02-29');   // 2028 is a leap year
  assert.strictEqual(OVERRIDE.dayAfter('2026-02-28'), '2026-03-01');   // 2026 is not
  // And across a DST transition: 2026-11-01 is when Chicago leaves daylight time. A local-midnight
  // + 24h implementation lands on the same calendar day and the window silently loses tomorrow.
  assert.strictEqual(OVERRIDE.dayAfter('2026-10-31'), '2026-11-01');
  assert.strictEqual(OVERRIDE.dayAfter('2026-11-01'), '2026-11-02');
});

// ═══ 5. THE SEAM IS A FLAG, NOT AN ENVIRONMENT VARIABLE ═══════════════════

test('5. nothing in this module reads a business day out of the environment', () => {
  // The fourth condition, asserted on the source with comments blanked: a deployment platform sets
  // environment variables for a whole service and nobody re-reads them, whereas a flag has to be
  // typed into an invocation. If a future edit adds an env fallback, this goes red.
  const src = require('node:fs').readFileSync(__filename.replace(/\.test\.js$/, '.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p) => p);
  assert.doesNotMatch(src, /env\.[A-Z_]*BUSINESS/,
    'the module reads a business day from the environment, which is the seam it exists to narrow');
  // NODE_ENV is the one environment value it may read, and only to REFUSE.
  const envReads = src.match(/env\.[A-Za-z_]+/g) || [];
  assert.deepStrictEqual([...new Set(envReads)], ['env.NODE_ENV'], JSON.stringify(envReads));
});
