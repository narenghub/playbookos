// ── WHAT THE GRANTS.GOV HARVEST MUST AND MUST NOT DO ─────────────────────────
//
//   node --test src/lib/connectors/grants-gov-job.test.js
//
// No database, no network. The collaborators are injected, so what is under test is the handful
// of decisions this job actually makes — and each of them is a decision that, got wrong, produces
// a calm and plausible wrong answer rather than an error anyone would notice.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const JOB = require('./grants-gov-job');

const CTX = Object.freeze({ companyId: 'co-1', objectiveId: JOB.OBJECTIVE_ID, runId: 'run-1' });

// A fake sync lifecycle that records what it was asked to do.
function fakeSync(over = {}) {
  const calls = { begun: 0, charged: 0, completed: 0, ended: [], upserted: null };
  return {
    calls,
    beginSync: async () => { calls.begun += 1; return { syncId: 'sync-1' }; },
    chargeCalls: async () => { calls.charged += 1; return { allowed: true, remaining: null, ceiling: null }; },
    upsertFundingOpportunities: async (ctx, id, rows) => {
      calls.upserted = rows; return { inserted: rows.filter((r) => !r.skip).length, updated: 0 };
    },
    completeSync: async () => { calls.completed += 1; return {}; },
    endSyncUnsuccessfully: async (ctx, id, { status, error }) => { calls.ended.push({ status, error }); return {}; },
    ...over,
  };
}

const fakeRun = async () => ({ duplicate: false, runId: 'run-1', rootRunId: 'run-1', context: CTX });

const hit = (over = {}) => ({
  id: '111', number: 'ABC-1', title: 'Pharmaceutical research', agency: 'NIH',
  closeDate: '12/01/2026', oppStatus: 'posted', docType: 'synopsis', ...over,
});

test('the search asks for posted opportunities only, never the API default', async () => {
  // The API's own default is "forecasted|posted". Taking it would fill the board with
  // announcements nobody can apply to, each showing a blank deadline that reads as "no deadline".
  const sent = [];
  await JOB.runGrantsHarvest({
    keywords: ['pharmaceutical'],
    deps: {
      beginObjectiveRun: fakeRun,
      sync: fakeSync(),
      search: async (body) => { sent.push(body); return { hits: [hit()], hitCount: 1 }; },
    },
  });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].oppStatuses, 'posted', JSON.stringify(sent[0]));
});

test('a forecast is excluded even if the API returns one', async () => {
  const s = fakeSync();
  const r = await JOB.runGrantsHarvest({
    keywords: ['pharmaceutical'],
    deps: {
      beginObjectiveRun: fakeRun,
      sync: s,
      search: async () => ({
        hits: [hit(), hit({ id: '222', docType: 'forecast' }), hit({ id: '333', oppStatus: 'forecasted' })],
        hitCount: 3,
      }),
    },
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.stats.forecastsExcluded, 2);
  assert.strictEqual(s.calls.upserted.length, 1, 'a forecast reached the upsert');
});

test('zero records across every keyword is a FAILURE, not an empty day', async () => {
  // The failure this prevents: a changed request shape reported as success, indistinguishable
  // from "nothing was posted today" — calm, plausible, and completely wrong.
  const s = fakeSync();
  const r = await JOB.runGrantsHarvest({
    keywords: ['pharmaceutical', 'analytical laboratory'],
    deps: { beginObjectiveRun: fakeRun, sync: s, search: async () => ({ hits: [], hitCount: 0 }) },
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /zero records/);
  assert.strictEqual(s.calls.completed, 0, 'a zero harvest completed the sync');
  assert.deepStrictEqual(s.calls.ended.map((e) => e.status), ['failed']);
});

test('the watermark is never advanced on a failure', async () => {
  const s = fakeSync();
  await JOB.runGrantsHarvest({
    keywords: ['pharmaceutical'],
    deps: { beginObjectiveRun: fakeRun, sync: s, search: async () => ({ hits: [], hitCount: 0 }) },
  });
  assert.strictEqual(s.calls.completed, 0, 'completeSync is the only path that writes a watermark');
});

test('a call ceiling STOPS the harvest — it does not retry or shrink the page', async () => {
  const s = fakeSync({
    chargeCalls: async () => ({ allowed: false, remaining: 0, ceiling: 10 }),
  });
  let searched = 0;
  const r = await JOB.runGrantsHarvest({
    keywords: ['a', 'b', 'c'],
    deps: {
      beginObjectiveRun: fakeRun,
      sync: s,
      search: async () => { searched += 1; return { hits: [hit()], hitCount: 1 }; },
    },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(searched, 0, 'a call was made after the ceiling refused it');
  assert.deepStrictEqual(s.calls.ended.map((e) => e.status), ['ceiling_reached']);
});

test('calls are charged BEFORE the request, not after', async () => {
  const order = [];
  const s = fakeSync({
    chargeCalls: async () => { order.push('charge'); return { allowed: true, ceiling: null }; },
  });
  await JOB.runGrantsHarvest({
    keywords: ['pharmaceutical'],
    deps: {
      beginObjectiveRun: fakeRun,
      sync: s,
      search: async () => { order.push('search'); return { hits: [hit()], hitCount: 1 }; },
    },
  });
  assert.deepStrictEqual(order, ['charge', 'search']);
});

test('one failing keyword does not abort the others', async () => {
  const s = fakeSync();
  const r = await JOB.runGrantsHarvest({
    keywords: ['boom', 'pharmaceutical'],
    deps: {
      beginObjectiveRun: fakeRun,
      sync: s,
      search: async (body) => {
        if (body.keyword === 'boom') throw new Error('upstream 503');
        return { hits: [hit()], hitCount: 1 };
      },
    },
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.stats.searched, 1);
  assert.ok(r.stats.errors.some((e) => /upstream 503/.test(e)), JSON.stringify(r.stats.errors));
});

test('a duplicate intent is declined, not failed, and opens no sync', async () => {
  const s = fakeSync();
  const r = await JOB.runGrantsHarvest({
    keywords: ['pharmaceutical'],
    deps: {
      beginObjectiveRun: async () => ({ duplicate: true, runId: null, context: null }),
      sync: s,
      search: async () => ({ hits: [hit()], hitCount: 1 }),
    },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.declined, true);
  assert.strictEqual(s.calls.begun, 0, 'a declined run opened a sync anyway');
});

test('a dry run writes nothing and does not complete the sync', async () => {
  const s = fakeSync();
  const r = await JOB.runGrantsHarvest({
    keywords: ['pharmaceutical'],
    dryRun: true,
    deps: { beginObjectiveRun: fakeRun, sync: s, search: async () => ({ hits: [hit()], hitCount: 1 }) },
  });
  assert.strictEqual(r.dryRun, true);
  assert.strictEqual(s.calls.upserted, null, 'a dry run upserted rows');
  assert.strictEqual(s.calls.completed, 0);
});

test('a thrown error closes the sync rather than leaving it running forever', async () => {
  // A sync left 'running' means the next firing reads a watermark that was never earned.
  const s = fakeSync({
    upsertFundingOpportunities: async () => { throw new Error('constraint violation'); },
  });
  const r = await JOB.runGrantsHarvest({
    keywords: ['pharmaceutical'],
    deps: { beginObjectiveRun: fakeRun, sync: s, search: async () => ({ hits: [hit()], hitCount: 1 }) },
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /constraint violation/);
  assert.deepStrictEqual(s.calls.ended.map((e) => e.status), ['failed']);
});

test('the harvest runs against the federal objective, not the supplier-RFQ one', async () => {
  let asked = null;
  await JOB.runGrantsHarvest({
    keywords: ['pharmaceutical'],
    deps: {
      beginObjectiveRun: async (spec) => { asked = spec; return fakeRun(); },
      sync: fakeSync(),
      search: async () => ({ hits: [hit()], hitCount: 1 }),
    },
  });
  assert.strictEqual(asked.objectiveId, 'obj-abiozen-federal-contracts');
  assert.notStrictEqual(asked.objectiveId, 'obj-abiozen-first-governed-rfq');
});

test('the intent key carries a minute slot, so repeated firings are not declined as duplicates', async () => {
  // beginObjectiveRun defaults to a DAY slot. On a job that fires several times a day that would
  // silently decline every firing after the first, and the board would look stale for no reason.
  const keys = [];
  for (const t of ['2026-11-09T06:20:00Z', '2026-11-09T12:20:00Z']) {
    await JOB.runGrantsHarvest({
      keywords: ['pharmaceutical'],
      now: new Date(t),
      deps: {
        beginObjectiveRun: async (spec) => { keys.push(spec.intentKey); return fakeRun(); },
        sync: fakeSync(),
        search: async () => ({ hits: [hit()], hitCount: 1 }),
      },
    });
  }
  assert.strictEqual(keys.length, 2);
  assert.notStrictEqual(keys[0], keys[1], `both firings shared one intent key: ${keys[0]}`);
});
