#!/usr/bin/env node
// ── IS THE WORKER THERE? ────────────────────────────────────────────────────
//
//   node scripts/check-worker-availability.js            # every live identity
//   node scripts/check-worker-availability.js --worker wkr_<32 hex>
//   node scripts/check-worker-availability.js --max-silence-seconds 120
//   echo $?     # 0 = every live identity is current · 1 = one is silent · 3 = nothing to judge
//
// READ-ONLY. It issues SELECTs and nothing else, and the self-check at the bottom of this file
// fails the run if that ever stops being true.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// On 2026-11-20 the office iMac's worker was dead for eleven minutes and the only reason anyone
// noticed was that a state report happened to print `last seen` as an absolute timestamp next to a
// clock. `workerctl doctor` said `ready: true, problems: []` the whole time, because it checks
// configuration and the Keychain and contacts nothing. Later the same day the worker was alive and
// its credential revoked — 574 refused requests in 50 minutes — and nothing reported that either.
//
// `worker_identities.last_seen_at` is the only honest liveness signal the server has: it advances
// on every authenticated request. The client polls every 5s (`idlePollMs`) with a backoff capping
// at 30s, so silence beyond about two minutes is abnormal by construction rather than by guess.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────
//
// It does not run on a schedule and it sends nothing. Recurring monitoring and external alerts
// need their own authorization; this is the measurement, and it exits with a code so that whatever
// runs it can decide. A monitor that mails somebody is a monitor that can be used to mail somebody.

'use strict';

const DEFAULT_MAX_SILENCE_S = 120;

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};

function refuseIfUnsafe() {
  if (!process.env.DATABASE_URL) {
    console.error('REFUSED: DATABASE_URL is not set.');
    process.exit(2);
  }
}

async function main() {
  refuseIfUnsafe();
  const maxSilenceS = Number(arg('--max-silence-seconds') || DEFAULT_MAX_SILENCE_S);
  if (!Number.isFinite(maxSilenceS) || maxSilenceS <= 0) {
    console.error('REFUSED: --max-silence-seconds must be a positive number');
    process.exit(2);
  }
  const only = arg('--worker');
  if (only && !/^wkr_[0-9a-f]{32}$/.test(only)) {
    console.error('REFUSED: --worker must be wkr_<32 hex>');
    process.exit(2);
  }

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const query = (sql, params) => pool.query(sql, params);

  let silent = 0;
  let current = 0;
  try {
    // Only LIVE identities are judged. A revoked identity that stopped reporting is doing exactly
    // what it should, and counting it as an outage would make this check cry wolf for ever.
    const r = await query(
      `SELECT id, label, last_seen_at, revoked_at,
              EXTRACT(EPOCH FROM (NOW() - last_seen_at))::int AS silent_seconds
         FROM worker_identities
        WHERE revoked_at IS NULL ${only ? 'AND id = $1' : ''}
        ORDER BY label`, only ? [only] : []);

    console.log(`\n── worker availability (silence threshold ${maxSilenceS}s) ──\n`);

    if (!r.rows.length) {
      console.log('  no live worker identity exists.');
      console.log('\nNOT JUDGED — there is no live worker to be available or unavailable.');
      console.log('This is exit 3, not exit 0: an aggregator over nothing must not report all clear.\n');
      return 3;
    }

    for (const w of r.rows) {
      if (w.last_seen_at === null) {
        silent += 1;
        console.log(`  SILENT   ${w.id}  ${w.label || '(no label)'} — enrolled but never seen`);
        continue;
      }
      const s = Number(w.silent_seconds);
      if (s > maxSilenceS) {
        silent += 1;
        console.log(`  SILENT   ${w.id}  ${w.label || ''} — last seen ${s}s ago `
          + `(${new Date(w.last_seen_at).toISOString()})`);
      } else {
        current += 1;
        console.log(`  current  ${w.id}  ${w.label || ''} — last seen ${s}s ago`);
      }
    }

    console.log('');
    if (silent) {
      console.log(`UNAVAILABLE  ${silent} live worker identity(ies) have gone quiet.`);
      console.log('  A live identity that stops reporting means the agent is stopped, crashed, its');
      console.log('  login session ended, or it cannot reach the API. `workerctl doctor` on the');
      console.log('  machine now reports process liveness and authentication health separately.\n');
      return 1;
    }
    console.log(`AVAILABLE  ${current} live worker identity(ies), all reporting within ${maxSilenceS}s.\n`);
    return 0;
  } finally {
    await pool.end().catch(() => {});
  }
}

// ── THE SELF-CHECK ─────────────────────────────────────────────────────────
//
// This file is allowed to run against any environment, including one pointed at a database
// somebody cares about, so "read-only" is enforced rather than promised. Reading its own source is
// cheap and it fails loudly: the same discipline m7-5-state-report.js uses.
{
  const src = require('node:fs').readFileSync(__filename, 'utf8');
  const code = src.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  const writes = ['INSERT ', 'UPDATE ', 'DELETE ', 'DROP ', 'ALTER ', 'TRUNCATE '];
  const found = writes.filter((w) => new RegExp(w, 'i').test(code.replace(/writes = \[[^\]]*\]/s, '')));
  if (found.length) {
    console.error(`REFUSED: this script claims to be read-only but contains ${found.join(', ')}`);
    process.exit(2);
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => { console.error(`\nERROR ${(e && e.stack) || e}\n`); process.exit(2); });
}

module.exports = { DEFAULT_MAX_SILENCE_S };
